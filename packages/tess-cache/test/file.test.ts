import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FileStore } from 'tess-cache';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tess-cache-'));
const bytes = (n: number, fill = 0) => new Uint8Array(n).fill(fill);
/** Files under `dir`, relative, sorted. */
const files = (dir: string) => (fs.readdirSync(dir, { recursive: true }) as string[]).filter(
  (f) => fs.statSync(path.join(dir, f)).isFile()).sort();
/** Sets a file's times to `s` seconds after the epoch. */
const age = (dir: string, key: string, s: number) => fs.utimesSync(path.join(dir, key.slice(-2), key), s, s);

test('entries persist in the directory, one file per entry, and survive a new store', async (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const a = new FileStore({ dir });
  await a.set('abc1', bytes(5, 7));
  await a.set('xyz2', bytes(3, 8));
  assert.deepEqual(files(dir), ['c1/abc1', 'z2/xyz2']);
  assert.equal(await a.size(), 8);
  const b = new FileStore({ dir });
  assert.equal(await b.size(), 8);
  assert.deepEqual(await b.get('abc1'), bytes(5, 7));
  assert.equal(await b.get('abc9'), undefined);
  await b.set('abc1', bytes(2, 9));
  assert.deepEqual(await a.get('abc1'), bytes(2, 9));
  await b.delete('xyz2');
  assert.deepEqual(files(dir), ['c1/abc1']);
  assert.equal(await b.size(), 2);
  assert.equal(new FileStore({ dir }).maxBytes, 2 ** 30);
  assert.throws(() => (b as unknown as { file(k: string): string }).file('../x'), /bad key/);
});

test('recency is the files\' times, which reads update: a new store evicts the least recently used first',
  async (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const a = new FileStore({ dir, maxBytes: 100 });
  for (const k of ['aaa', 'bbb', 'ccc']) await a.set(k, bytes(4));
  age(dir, 'aaa', 1000);
  age(dir, 'bbb', 2000);
  age(dir, 'ccc', 3000);
  await new FileStore({ dir }).get('aaa');
  assert.ok(fs.statSync(path.join(dir, 'aa/aaa')).mtimeMs > 3_000_000);
  // Lowered to 8 bytes: bbb, now the oldest, goes.
  const b = new FileStore({ dir, maxBytes: 8 });
  assert.equal(await b.size(), 8);
  assert.deepEqual(files(dir), ['aa/aaa', 'cc/ccc']);
  await b.get('ccc');
  await b.set('ddd', bytes(4));
  assert.deepEqual(files(dir), ['cc/ccc', 'dd/ddd']);
  // An entry larger than the new maximum goes too.
  await new FileStore({ dir, maxBytes: 100 }).set('eee', bytes(10));
  const c = new FileStore({ dir, maxBytes: 9 });
  assert.equal(await c.size(), 8);
  assert.deepEqual(files(dir), ['cc/ccc', 'dd/ddd']);
  await c.set('fff', bytes(10));
  assert.deepEqual(files(dir), ['cc/ccc', 'dd/ddd']);
});

test("an entry another process wrote is read and counted; clear removes only entries' files", async (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const a = new FileStore({ dir, maxBytes: 10 });
  await a.set('aaa', bytes(4));
  const b = new FileStore({ dir, maxBytes: 10 });
  await b.set('bbb', bytes(4));
  assert.equal(await a.size(), 4);
  assert.deepEqual(await a.get('bbb'), bytes(4));
  assert.equal(await a.size(), 8);
  // b deleted aaa's file: a's read misses and stops counting it.
  await b.delete('aaa');
  assert.equal(await a.get('aaa'), undefined);
  assert.equal(await a.size(), 4);
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'mine');
  fs.writeFileSync(path.join(dir, 'bb', 'b.x'), 'mine');
  fs.mkdirSync(path.join(dir, 'other'));
  fs.writeFileSync(path.join(dir, 'other', 'other1'), 'mine');
  await a.clear();
  assert.equal(await a.size(), 0);
  assert.deepEqual(files(dir), ['bb/b.x', 'notes.txt', 'other/other1']);
});

test("deleteWhere deletes matching entries, other processes' included, and leaves other files alone", async (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const a = new FileStore({ dir });
  await a.set('x_1_aa', bytes(4));
  await a.set('y_1_bb', bytes(4));
  await new FileStore({ dir }).set('x_2_cc', bytes(4));
  fs.writeFileSync(path.join(dir, 'aa', 'x_9.tmp'), 'partial');
  await a.deleteWhere((k) => k.startsWith('x_'));
  assert.deepEqual(files(dir), ['aa/x_9.tmp', 'bb/y_1_bb']);
  assert.equal(await a.size(), 4);
  await new FileStore({ dir, maxBytes: 0 }).deleteWhere(() => true);
  assert.deepEqual(files(dir), ['aa/x_9.tmp', 'bb/y_1_bb']);
});

test('temporary files are left alone while recent, and removed when an hour old', async (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'aa'));
  for (const f of ['aaa.1-x.tmp', 'baa.2-y.tmp']) fs.writeFileSync(path.join(dir, 'aa', f), 'partial');
  const old = (Date.now() - 2 * 3600_000) / 1000;
  fs.utimesSync(path.join(dir, 'aa', 'baa.2-y.tmp'), old, old);
  const s = new FileStore({ dir });
  assert.equal(await s.size(), 0);
  assert.deepEqual(files(dir), ['aa/aaa.1-x.tmp']);
  await s.set('aac', bytes(3));
  assert.deepEqual(files(dir), ['aa/aaa.1-x.tmp', 'ac/aac']);
});

test('a store with maxBytes 0 leaves its directory alone', async (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await new FileStore({ dir }).set('aaa', bytes(4));
  const s = new FileStore({ dir, maxBytes: 0 });
  assert.equal(await s.get('aaa'), undefined);
  await s.set('bbb', bytes(1));
  await s.delete('zzz');
  assert.equal(await s.size(), 0);
  assert.deepEqual(files(dir), ['aa/aaa']);
  const missing = path.join(dir, 'missing');
  await new FileStore({ dir: missing, maxBytes: 0 }).set('ccc', bytes(1));
  assert.ok(!fs.existsSync(missing));
  await new FileStore({ dir: missing }).clear();
});

test("a failed write leaves no temporary file and isn't counted", async (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = new FileStore({ dir });
  await s.set('aaa', bytes(4));
  // A directory where the entry's file would go: the rename fails.
  fs.mkdirSync(path.join(dir, 'bb', 'bbb'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'bb', 'bbb', 'x'), '');
  await assert.rejects(s.set('bbb', bytes(4)));
  assert.equal(await s.size(), 4);
  assert.deepEqual(files(dir), ['aa/aaa', 'bb/bbb/x']);
});
