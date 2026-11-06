import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type ActivityEnv, onReactivated, serverVersion, UpdateCheck, updateText } from '../src/update-check.ts';

/** A page whose activity the test sets. */
function fakeEnv(active: boolean) {
  const listeners: (() => void)[] = [];
  const env: ActivityEnv = { active: () => active, onChange: (f) => listeners.push(f) };
  return {
    env,
    set(a: boolean) {
      active = a;
      for (const f of listeners) f();
    },
    /** A change event with no change (focus and visibility together). */
    nudge: () => { for (const f of listeners) f(); },
  };
}

test('checks only when the page becomes active again: not at first, not while it stays so', () => {
  for (const first of [true, false]) {
    const p = fakeEnv(first);
    let calls = 0;
    onReactivated(p.env, () => calls++);
    assert.equal(calls, 0, 'not at first');
    p.nudge();
    assert.equal(calls, 0, 'an event with no change');
    p.set(false);
    p.set(false);
    assert.equal(calls, 0, 'not on becoming inactive');
    p.set(true);
    assert.equal(calls, 1, 'on becoming active');
    p.nudge();
    p.set(true);
    assert.equal(calls, 1, 'not again while it stays active');
    p.set(false);
    p.set(true);
    assert.equal(calls, 2, 'again after being away');
  }
});

test("the server's version: none while it's the same; ready once the worker has updated", async () => {
  let server: string | undefined = '1.0.0-a';
  let release = () => {};
  let updates = 0;
  const seen: string[] = [];
  const u = new UpdateCheck(async () => {
    if (server === undefined) throw new Error('offline');
    return server;
  }, () => {
    updates++;
    return new Promise<void>((r) => { release = r; });
  }, '1.0.0-a');
  u.listeners.add((s) => seen.push(`${s.latest}/${s.ready}`));
  assert.equal(await u.check(true), 'same');
  assert.deepEqual(u.state, { ready: false });
  assert.equal(updates, 0, 'no update asked for while the same');
  server = '1.0.0-b';
  const checking = u.check(true);
  await Promise.resolve();
  assert.deepEqual(u.state, { latest: '1.0.0-b', ready: false }, 'seen before the worker has it');
  // (Seen again while the worker updates: nothing more asked; that check waits for the same download.)
  const joined = u.check(true);
  await Promise.resolve();
  assert.equal(updates, 1);
  release();
  assert.equal(await checking, 'other');
  assert.equal(await joined, 'other');
  assert.deepEqual(u.state, { latest: '1.0.0-b', ready: true });
  // The server not reached: said, the state as it was.
  server = undefined;
  assert.deepEqual(await u.check(true), { error: 'The server could not be reached: offline.' });
  assert.deepEqual(u.state, { latest: '1.0.0-b', ready: true });
  // An older one counts too; and back to the same, none.
  server = '0.9.0';
  const older = u.check(true);
  await Promise.resolve();
  assert.deepEqual(u.state, { latest: '0.9.0', ready: false });
  release();
  await older;
  assert.deepEqual(u.state, { latest: '0.9.0', ready: true });
  server = '1.0.0-a';
  await u.check(true);
  assert.deepEqual(u.state, { ready: false });
  assert.deepEqual(seen, ['1.0.0-b/false', '1.0.0-b/true', '0.9.0/false', '0.9.0/true', 'undefined/false']);
});

test('a worker update overtaken by another version leaves that one not ready', async () => {
  let server = 'b';
  const releases: (() => void)[] = [];
  const u = new UpdateCheck(async () => server, () => new Promise<void>((r) => releases.push(r)), 'a');
  const first = u.check(true);
  await Promise.resolve();
  server = 'c';
  const second = u.check(true);
  await Promise.resolve();
  releases[0]!();
  await first;
  assert.deepEqual(u.state, { latest: 'c', ready: false });
  releases[1]!();
  await second;
  assert.deepEqual(u.state, { latest: 'c', ready: true });
});

test('a version gone and back while the first update is pending: ready only with the later update', async () => {
  let server = 'b';
  const releases: (() => void)[] = [];
  const u = new UpdateCheck(async () => server, () => new Promise<void>((r) => releases.push(r)), 'a');
  const first = u.check(true);
  await Promise.resolve();
  server = 'a';
  await u.check(true);
  server = 'b';
  const again = u.check(true);
  await Promise.resolve();
  releases[0]!();
  await first;
  assert.deepEqual(u.state, { latest: 'b', ready: false });
  releases[1]!();
  await again;
  assert.deepEqual(u.state, { latest: 'b', ready: true });
});

test('a download that fails drops the version seen, with the error for each check waiting for it', async () => {
  let fail = (_: Error) => {};
  const seen: string[] = [];
  const u = new UpdateCheck(async () => 'b', () => new Promise<void>((_, reject) => { fail = reject; }), 'a');
  u.listeners.add((s) => seen.push(`${s.latest}/${s.ready}`));
  const started = u.check(true);
  await Promise.resolve();
  const joined = u.check(true);
  await Promise.resolve();
  fail(new Error('offline'));
  const error = { error: 'Version b could not be downloaded: offline.' };
  assert.deepEqual(await started, error);
  assert.deepEqual(await joined, error);
  assert.deepEqual(u.state, { ready: false });
  assert.deepEqual(seen, ['b/false', 'undefined/false']);
});

test("a failed download overtaken by another version's leaves that one", async () => {
  let server = 'b';
  const settle: [() => void, (e: Error) => void][] = [];
  const u = new UpdateCheck(async () => server, () => new Promise<void>((r, j) => settle.push([r, j])), 'a');
  const first = u.check(true);
  await Promise.resolve();
  server = 'c';
  const second = u.check(true);
  await Promise.resolve();
  settle[0]![1](new Error('offline'));
  assert.deepEqual(await first, { error: 'Version b could not be downloaded: offline.' });
  assert.deepEqual(u.state, { latest: 'c', ready: false });
  settle[1]![0]();
  assert.equal(await second, 'other');
  assert.deepEqual(u.state, { latest: 'c', ready: true });
});

test("version.json: past caches; why not, when it can't be had (no answer in time, a status, not JSON)", async () => {
  const g = globalThis as { document?: unknown; fetch: typeof fetch };
  const realFetch = g.fetch;
  g.document = { baseURI: 'https://example.org/app/' };
  let answer: (url: URL, init: RequestInit) => Promise<Response> = async () => new Response('{"version":"v1"}');
  const urls: string[] = [];
  g.fetch = ((url: URL, init: RequestInit) => {
    urls.push(String(url));
    assert.equal(init.cache, 'no-store');
    return answer(url, init);
  }) as typeof fetch;
  try {
    assert.equal(await serverVersion(), 'v1');
    assert.match(urls[0]!, /^https:\/\/example\.org\/app\/version\.json\?t=\d+$/);
    // A server that never answers: aborted.
    answer = (_, init) => new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(
      new DOMException('aborted', 'AbortError'))));
    await assert.rejects(serverVersion(50), { message: 'no answer within 0.05 s' });
    answer = async () => { throw new TypeError('Failed to fetch'); };
    await assert.rejects(serverVersion(), { message: 'no connection' });
    answer = async () => new Response('', { status: 404 });
    await assert.rejects(serverVersion(), { message: 'the server answered 404' });
    answer = async () => new Response('<!doctype html>');
    await assert.rejects(serverVersion(), { message: 'the server gave no version' });
    answer = async () => new Response('{"version":3}');
    await assert.rejects(serverVersion(), { message: 'the server gave no version' });
  } finally {
    g.fetch = realFetch;
    delete g.document;
  }
});

test('checks close together: the second skipped unless forced', async () => {
  let fetches = 0;
  const u = new UpdateCheck(async () => (fetches++, 'a'), async () => {}, 'a');
  await u.check();
  assert.equal(await u.check(), 'skipped');
  assert.equal(fetches, 1);
  await u.check(true);
  assert.equal(fetches, 2);
});

test('the text: which version, and whether a reload shows it', () => {
  assert.equal(updateText({ ready: false }), undefined);
  assert.match(updateText({ latest: '0.3.0-abc', ready: true })!, /^Version 0\.3\.0-abc is available: reload/);
  assert.match(updateText({ latest: '0.3.0-abc', ready: false })!, /downloading/);
});
