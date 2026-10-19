// The IndexedDB store in a real browser, which `npm test` can't reach: serves the repo's TypeScript with its types
// stripped, runs the store's scenarios in headless Chrome, and prints what the page reports.
// Run by hand: node packages/tess-cache/test/browser-check.ts [path to Chrome]

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { stripTypeScriptTypes } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../../..');
const chrome = process.argv[2] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const page = `<!doctype html><meta charset="utf-8"><script type="module">
import { CachedTessellator, IndexedDbStore } from '/packages/tess-cache/src/browser.ts';
const results = [];
const check = async (name, f) => { try { results.push([name, (await f()) ?? 'ok']); } catch (e) { results.push([name, 'FAIL ' + e.message]); } };
const expect = (c, m) => { if (!c) throw new Error(m); };
const bytes = (n, fill = 0) => new Uint8Array(n).fill(fill);
const same = (a, b) => a && b && a.length === b.length && a.every((x, i) => x === b[i]);
const tick = () => new Promise((r) => setTimeout(r, 5));
let n = 0;
const fresh = () => 'check-' + n++;
const names = async () => (await indexedDB.databases()).map((d) => d.name);
await check('round trip, and the bytes held', async () => {
  const s = new IndexedDbStore({ name: fresh() });
  await s.set('a', bytes(5, 7));
  expect(same(await s.get('a'), bytes(5, 7)), 'bad bytes');
  expect((await s.get('a')) instanceof Uint8Array, 'not a Uint8Array');
  expect((await s.get('b')) === undefined, 'phantom entry');
  expect((await s.size()) === 5, 'size');
  await s.set('a', bytes(2));
  expect((await s.size()) === 2, 'size after replace');
  await s.delete('a');
  expect((await s.get('a')) === undefined && (await s.size()) === 0, 'delete');
  s.close();
});
await check('least recently used evicted, values larger than the maximum skipped', async () => {
  const s = new IndexedDbStore({ name: fresh(), maxBytes: 10 });
  await s.set('a', bytes(4)); await s.set('b', bytes(4));
  await s.get('a');
  await s.set('c', bytes(4));
  expect((await s.get('b')) === undefined, 'b kept');
  expect((await s.get('a')) && (await s.get('c')), 'a or c lost');
  await s.set('big', bytes(11));
  expect((await s.get('big')) === undefined && (await s.size()) === 8, 'big stored');
  s.close();
});
await check('entries and their recency persist; a lower maximum evicts the oldest on opening', async () => {
  const name = fresh();
  const a = new IndexedDbStore({ name });
  for (const k of ['a', 'b', 'c']) { await a.set(k, bytes(4)); await tick(); }
  await a.get('a');
  a.close();
  const b = new IndexedDbStore({ name, maxBytes: 8 });
  expect((await b.size()) === 8, 'size ' + (await b.size()));
  expect((await b.get('b')) === undefined, 'b kept');
  expect((await b.get('a')) && (await b.get('c')), 'a or c lost');
  b.close();
  const c = new IndexedDbStore({ name, maxBytes: 3 });
  expect((await c.size()) === 0, 'oversize entries kept');
  c.close();
  const d = new IndexedDbStore({ name });
  expect((await d.size()) === 0 && (await d.get('a')) === undefined, 'oversize entries not deleted');
  d.close();
});
await check("an entry another page wrote is read and counted", async () => {
  const name = fresh();
  const a = new IndexedDbStore({ name }), b = new IndexedDbStore({ name });
  await a.set('a', bytes(4));
  await b.set('b', bytes(3));
  expect((await a.size()) === 4, 'size before');
  expect(same(await a.get('b'), bytes(3)), 'b not read');
  expect((await a.size()) === 7, 'size after');
  await b.delete('a');
  expect((await a.get('a')) === undefined && (await a.size()) === 3, 'deleted entry still counted');
  a.close(); b.close();
});
await check('clear', async () => {
  const name = fresh();
  const s = new IndexedDbStore({ name });
  await s.set('a', bytes(4)); await s.set('b', bytes(4));
  await s.clear();
  expect((await s.size()) === 0 && (await s.get('a')) === undefined, 'not cleared');
  s.close();
  expect((await new IndexedDbStore({ name }).size()) === 0, 'not cleared on disk');
});
await check("deleteWhere deletes matching entries, another page's included", async () => {
  const name = fresh();
  const a = new IndexedDbStore({ name }), b = new IndexedDbStore({ name });
  await a.set('x_1_a', bytes(4)); await a.set('y_1_b', bytes(3));
  await a.size();
  await b.set('x_2_c', bytes(2));
  await a.deleteWhere((k) => k.startsWith('x_'));
  expect((await a.size()) === 3, 'size ' + (await a.size()));
  expect((await b.get('x_2_c')) === undefined && (await b.get('x_1_a')) === undefined, 'not deleted');
  expect(same(await b.get('y_1_b'), bytes(3)), 'other entry lost');
  a.close(); b.close();
});
await check("maxBytes 0 doesn't open the database", async () => {
  const name = fresh();
  const s = new IndexedDbStore({ name, maxBytes: 0 });
  await s.set('a', bytes(1));
  expect((await s.get('a')) === undefined && (await s.size()) === 0, 'stored');
  await s.delete('a'); await s.deleteWhere(() => true); await s.clear();
  expect(!(await names()).includes(name), 'database created');
});
await check('a database that fails to open is retried on the next call', async () => {
  const name = fresh();
  await new Promise((res, rej) => { const r = indexedDB.open(name, 2); r.onsuccess = () => { r.result.close(); res(); }; r.onerror = () => rej(r.error); });
  const s = new IndexedDbStore({ name });
  let failed = false;
  try { await s.get('a'); } catch (e) { failed = e.name === 'VersionError'; }
  expect(failed, 'no VersionError');
  await new Promise((res) => { const r = indexedDB.deleteDatabase(name); r.onsuccess = r.onerror = res; });
  await s.set('a', bytes(2));
  expect(same(await s.get('a'), bytes(2)), 'not retried');
  s.close();
});
await check('the caching tessellator over IndexedDB', async () => {
  const name = fresh();
  let calls = 0;
  const fake = {
    info: { name: 'fake', version: '1', license: 'MIT', formats: ['step'], supportsFaceIds: true, supportsEdges: false },
    init: async () => {}, dispose: () => {},
    tessellate: async (req) => ({ origin: req.origin, positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]), faces: [{ entityId: 3, start: 0, count: 3 }], diagnostics: [{ severity: 'info', message: 'call ' + ++calls }] }),
  };
  const req = { format: 'step', data: new Uint8Array([1, 2, 3]), rootId: 3, origin: [1, 2, 3], linearDeflection: 0.1, angularDeflection: 0.5 };
  const a = await new CachedTessellator(fake, new IndexedDbStore({ name })).tessellate(req);
  const t = new CachedTessellator(fake, new IndexedDbStore({ name }));
  const b = await t.tessellate(req);
  expect(calls === 1, 'calls ' + calls);
  expect(b.diagnostics[0].message === 'call 1' && same(b.positions, a.positions) && b.positions instanceof Float32Array && b.origin[2] === 3, 'bad result');
  expect(t.stats().hits === 1, 'no hit');
  // A cached failure, and the old version's entries deleted on a new version.
  const failing = { ...fake, tessellate: async () => { calls++; throw new WebAssembly.RuntimeError('unreachable'); } };
  const bad = { ...req, data: new Uint8Array([9]) };
  for (let i = 0; i < 2; i++) {
    try { await new CachedTessellator(failing, new IndexedDbStore({ name })).tessellate(bad); throw new Error('resolved'); } catch (e) { expect(/unreachable/.test(e.message), e.message); }
  }
  expect(calls === 2, 'failure not cached, calls ' + calls);
  const s = new IndexedDbStore({ name });
  expect((await s.size()) > 0, 'empty');
  const v2 = { ...fake, info: { ...fake.info, version: '2' } };
  await new CachedTessellator(v2, s).tessellate(req);
  const keys = await new Promise((res) => { const r = indexedDB.open(name); r.onsuccess = () => { const q = r.result.transaction('meta').objectStore('meta').getAllKeys(); q.onsuccess = () => { r.result.close(); res(q.result); }; }; });
  expect(keys.length === 1 && calls === 3, 'old version kept: ' + keys.length);
  s.close();
});
for (const name of await names()) if (name.startsWith('check-')) indexedDB.deleteDatabase(name);
await fetch('/done', { method: 'POST', body: JSON.stringify({ userAgent: navigator.userAgent, results }) });
</script>`;

const server = http.createServer((q, s) => {
  const url = new URL(q.url!, 'http://x');
  if (url.pathname === '/') return void s.writeHead(200, { 'content-type': 'text/html' }).end(page);
  if (url.pathname === '/done') {
    let body = '';
    q.on('data', (c) => (body += c)).on('end', () => {
      s.end();
      const { userAgent, results } = JSON.parse(body) as { userAgent: string; results: [string, string][] };
      console.log(userAgent);
      for (const [name, r] of results) console.log(`${r === 'ok' ? 'ok  ' : 'FAIL'} ${name}${r === 'ok' ? '' : `: ${r}`}`);
      finish(results.every(([, r]) => r === 'ok') ? 0 : 1);
    });
    return;
  }
  const file = path.join(root, url.pathname);
  if (!file.startsWith(root + path.sep) || !file.endsWith('.ts') || !fs.existsSync(file)) return void s.writeHead(404).end();
  // The one bare specifier the sources import as a value; a bundler resolves it in an application.
  const js = stripTypeScriptTypes(fs.readFileSync(file, 'utf8')).replace(/from 'cad-scene'/g, "from '/packages/cad-scene/src/index.ts'");
  s.writeHead(200, { 'content-type': 'text/javascript' }).end(js);
});

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tess-cache-chrome-'));
let browser: ReturnType<typeof spawn> | undefined;
function finish(code: number) {
  browser?.kill();
  server.close();
  setTimeout(() => { fs.rmSync(profile, { recursive: true, force: true }); process.exit(code); }, 500);
}
server.listen(0, '127.0.0.1', () => {
  const { port } = server.address() as { port: number };
  browser = spawn(chrome, ['--headless=new', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', `http://127.0.0.1:${port}/`], { stdio: 'ignore' });
  browser.on('error', (e) => { console.error(`can't start ${chrome}: ${e.message}`); finish(2); });
});
setTimeout(() => { console.error('no report from the page within 60 s'); finish(1); }, 60_000).unref();
