// tess-cadio's C++ tests (native/test/*_test.cpp, cad-geom's harness check.h) as Node subtests, one per C++ case,
// natively with the sanitizers and as WebAssembly, each binary as `./build.sh test` built it; skipped where it isn't
// built. The harness's output format, and its parser's own checks, are cad-geom's (its test/native.test.ts).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const pkg = path.join(import.meta.dirname, '..');
const sources = fs.readdirSync(path.join(pkg, 'native/test')).filter((f) => f.endsWith('_test.cpp')).sort()
  .map((f) => f.slice(0, -'.cpp'.length));
const notBuilt = 'tess-cadio\'s tests not built (run packages/tess-cadio/build.sh test)';

/** check.h's output: each case's pass and failure lines, the DONE counts. */
function parse(stdout: string) {
  const cases = new Map<string, { passed: boolean; failures: string[] }>();
  let open: { name: string; failures: string[] } | undefined, done: number[] | undefined;
  for (const line of stdout.split('\n')) {
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^CASE (.+)$/))) open = { name: m[1]!, failures: [] };
    else if ((m = line.match(/^(PASS|FAIL) (.+)$/)) && open && open.name === m[2]) {
      const o = open;
      cases.set(o.name, { passed: m[1] === 'PASS' && o.failures.length === 0, failures: o.failures });
      open = undefined;
    } else if (line.startsWith('  ') && open) open.failures.push(line.trim());
    else if ((m = line.match(/^DONE (\d+) (\d+)$/))) done = [+m[1]!, +m[2]!];
  }
  return { cases, done };
}

const kinds = [
  { kind: 'native', file: (n: string) => path.join(pkg, 'build/test/native', n), cmd: (f: string) => [f] },
  { kind: 'wasm', file: (n: string) => path.join(pkg, 'build/test/wasm', `${n}.js`),
    cmd: (f: string) => [process.execPath, f] },
];

for (const { kind, file, cmd } of kinds) {
  const built = sources.filter((n) => fs.existsSync(file(n)));
  test(`${kind}: every native/test/*_test.cpp is built`, { skip: built.length ? false : notBuilt }, () => {
    assert.deepEqual(built, sources);
  });
  for (const name of built) {
    test(`${kind} ${name}`, async (t) => {
      const c = cmd(file(name));
      const list = spawnSync(c[0]!, [...c.slice(1), '--list'], { encoding: 'utf8' });
      const listed = list.stdout.split('\n').filter((l) => l).map((l) => l.replace(/^CASE /, ''));
      const r = spawnSync(c[0]!, c.slice(1), { encoding: 'utf8', timeout: 600_000 });
      const report = parse(r.stdout ?? '');
      for (const cas of listed) {
        await t.test(cas, () => {
          const got = report.cases.get(cas);
          assert.ok(got, `didn't run to its end\n${r.stderr}`);
          assert.ok(got.passed, got.failures.join('\n') || 'failed');
        });
      }
      await t.test('the run as a whole', () => {
        assert.equal(r.status, 0, r.stderr);
        assert.deepEqual(report.done, [listed.length, 0]);
      });
    });
  }
}
