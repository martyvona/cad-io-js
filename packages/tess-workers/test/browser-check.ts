// The Web Worker adapter in a real browser, which `npm test` can't reach: serves the repo's TypeScript with its types
// stripped, runs the pool scenarios on the fake backend in headless Chrome, and prints what the page reports.
// Run by hand: node packages/tess-workers/test/browser-check.ts [path to Chrome]

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { stripTypeScriptTypes } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../../..');
const chrome = process.argv[2] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const page = `<!doctype html><meta charset="utf-8"><script type="module">
import { WorkerTessellator } from '/packages/tess-workers/src/browser.ts';
const backend = { module: new URL('/packages/tess-workers/test/fake-backend.ts', location.href).href, export: 'FakeTessellator' };
const req = (...data) => ({ format: 'step', data: new Uint8Array(data), rootId: 7, origin: [1, 2, 3], linearDeflection: 0.1, angularDeflection: 0.5 });
const inst = (r) => r.diagnostics[0].message;
const results = [];
const check = async (name, f) => { try { results.push([name, (await f()) ?? 'ok']); } catch (e) { results.push([name, 'FAIL ' + e.message]); } };
const expect = (c, m) => { if (!c) throw new Error(m); };
const rejects = async (p, re) => { try { await p; } catch (e) { expect(re.test(e.message), 'wrong error: ' + e.message); return e; } throw new Error('did not reject'); };
const partFailure = (e) => e.name === 'TessellationError';
await check('parallel results', async () => {
  const t = new WorkerTessellator({ backend, workers: 2 }); await t.init();
  const rs = await Promise.all([1, 2, 3, 4].map(() => t.tessellate(req(4, 20))));
  t.dispose();
  expect(rs.every((r) => r.positions instanceof Float32Array && r.indices.length === 3 && r.origin[2] === 3), 'bad result');
  expect(new Set(rs.map(inst)).size === 2, 'not two workers');
});
await check('timeout', async () => {
  const t = new WorkerTessellator({ backend, workers: 1, timeoutMs: 300 }); await t.init();
  const a = inst(await t.tessellate(req(0)));
  const e = await rejects(t.tessellate(req(1)), /timed out after 300 ms/);
  expect(partFailure(e) && e.timeoutMs === 300, 'not a TessellationError with its limit');
  const b = inst(await t.tessellate(req(0)));
  t.dispose(); expect(a !== b, 'same worker after timeout');
});
await check('trap', async () => {
  const t = new WorkerTessellator({ backend, workers: 1 }); await t.init();
  const a = inst(await t.tessellate(req(0)));
  expect(partFailure(await rejects(t.tessellate(req(2)), /RuntimeError: unreachable/)), 'not a TessellationError');
  const b = inst(await t.tessellate(req(0)));
  t.dispose(); expect(a !== b, 'same worker after trap');
});
await check("only the part's failures are TessellationErrors", async () => {
  const t = new WorkerTessellator({ backend, workers: 1 }); await t.init();
  expect(!partFailure(await rejects(t.tessellate(req(6)), /Error: ordinary/)), 'an ordinary error became a TessellationError');
  const e = await rejects(t.tessellate(req(7)), /own limit/);
  t.dispose(); expect(partFailure(e) && e.timeoutMs === 50, 'limit lost across the worker');
});
await check('recycle', async () => {
  const t = new WorkerTessellator({ backend, workers: 1, maxPartsPerWorker: 2 }); await t.init();
  const ids = []; for (let i = 0; i < 3; i++) ids.push(inst(await t.tessellate(req(0))));
  t.dispose(); expect(ids[0] === ids[1] && ids[1] !== ids[2], 'recycling: ' + ids);
});
await check('init failure', async () => {
  await rejects(new WorkerTessellator({ backend: { ...backend, options: { fail: true } } }).init(), /init refused/);
});
await check('worker script error', async () => {
  await rejects(new WorkerTessellator({ backend: { module: '/no/such/module.ts', export: 'X' } }).init(), /backend init failed/);
});
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

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tess-workers-chrome-'));
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
