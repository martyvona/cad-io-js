// cad-geom's C++ tests (native/test/*_test.cpp, harness native/test/check.h) as Node subtests, one per C++ case:
// natively with the sanitizers and as WebAssembly, each binary as `./build.sh test` built it, skipped where it isn't
// built. Then the runner's own parsing, and build.sh's Eigen guard on dependency files written here.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { generate } from '../native/test/fixtures.ts';

const pkg = path.join(import.meta.dirname, '..');
const sources = fs.readdirSync(path.join(pkg, 'native/test')).filter(f => f.endsWith('_test.cpp')).sort()
  .map(f => f.slice(0, -'.cpp'.length));
const notBuilt = 'cad-geom\'s tests not built (run packages/cad-geom/build.sh test)';

/** What one run of a test binary reported (check.h's output). */
export interface Report {
  /** Each case that ended, in order: passed, and its failure lines. */
  cases: Map<string, { passed: boolean; failures: string[] }>;
  /** The DONE line's counts, absent if the binary didn't get there. */
  done?: { passed: number; failed: number };
  /** What doesn't fit the format: a case started and not ended, a line out of place. */
  problems: string[];
}

export function parse(stdout: string): Report {
  const r: Report = { cases: new Map(), problems: [] };
  let open: { name: string; failures: string[] } | undefined;
  for (const line of stdout.split('\n')) {
    if (line === '') continue;
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^CASE (.+)$/))) {
      if (open) r.problems.push(`case "${open.name}" never ended`);
      open = { name: m[1]!, failures: [] };
    } else if ((m = line.match(/^(PASS|FAIL) (.+)$/))) {
      if (!open || open.name !== m[2]) r.problems.push(`"${line}" outside its case`);
      else if (r.cases.has(open.name)) r.problems.push(`case "${open.name}" ran twice`);
      else r.cases.set(open.name, { passed: m[1] === 'PASS' && open.failures.length === 0, failures: open.failures });
      open = undefined;
    } else if (line.startsWith('  ') && open) open.failures.push(line.trim());
    else if ((m = line.match(/^DONE (\d+) (\d+)$/)) && !open && !r.done) r.done = { passed: +m[1]!, failed: +m[2]! };
    else r.problems.push(`unexpected line "${line}"`);
  }
  if (open) r.problems.push(`case "${open.name}" never ended`);
  return r;
}

/** The names --list gives, or a problem. */
export function parseList(stdout: string): string[] {
  const names = stdout.split('\n').filter(l => l !== '').map(l => {
    const m = l.match(/^CASE (.+)$/);
    if (!m) throw new Error(`unexpected line in --list "${l}"`);
    return m[1]!;
  });
  if (new Set(names).size !== names.length) throw new Error('--list names a case twice');
  return names;
}

/** Why a listed case counts as failed (it failed, or never ended: a crash), or undefined if it passed. */
export function caseProblem(r: Report, name: string): string | undefined {
  const got = r.cases.get(name);
  if (!got) return 'didn\'t run to its end';
  return got.passed ? undefined : got.failures.join('\n') || 'failed';
}

/** Problems with a whole run against the cases --list gave: everything else the subtests say case by case. */
export function runProblems(r: Report, listed: string[], status: number | null, signal: string | null): string[] {
  const out = [...r.problems];
  const failed = [...r.cases.values()].filter(c => !c.passed).length;
  if (signal !== null) out.push(`killed by ${signal}`);
  else if (status !== (failed > 0 ? 1 : 0)) out.push(`exit ${status} with ${failed} failed`);
  if (!r.done) out.push('no DONE line');
  else if (r.done.passed !== r.cases.size - failed || r.done.failed !== failed)
    out.push(`DONE ${r.done.passed} ${r.done.failed} but ${r.cases.size - failed} passed, ${failed} failed`);
  for (const name of r.cases.keys()) if (!listed.includes(name)) out.push(`case "${name}" ran but isn't listed`);
  return out;
}

const run = (cmd: string[], args: string[]) => {
  const r = spawnSync(cmd[0]!, [...cmd.slice(1), ...args], { encoding: 'utf8', timeout: 300_000 });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status, signal: r.signal };
};

const kinds = [
  { kind: 'native', file: (n: string) => path.join(pkg, 'build/test/native', n), cmd: (f: string) => [f] },
  { kind: 'wasm', file: (n: string) => path.join(pkg, 'build/test/wasm', `${n}.js`),
    cmd: (f: string) => [process.execPath, f] },
];

for (const { kind, file, cmd } of kinds) {
  const built = sources.filter(n => fs.existsSync(file(n)));
  test(`${kind}: every native/test/*_test.cpp is built`, { skip: built.length ? false : notBuilt }, () => {
    assert.deepEqual(built, sources, `not built: ${sources.filter(n => !built.includes(n)).join(', ')}`);
  });
  for (const name of built) {
    test(`${kind} ${name}`, async t => {
      const c = cmd(file(name));
      const l = run(c, ['--list']);
      assert.equal(l.status, 0, `--list exits ${l.status}: ${l.stdout}${l.stderr}`);
      const listed = parseList(l.stdout);
      assert.ok(listed.length > 0);
      const r = run(c, []);
      const report = parse(r.stdout);
      for (const cas of listed) {
        await t.test(cas, () => {
          const problem = caseProblem(report, cas);
          assert.equal(problem, undefined, `${problem}\n${r.stderr}`);
        });
      }
      await t.test('the run as a whole', () => {
        assert.deepEqual(runProblems(report, listed, r.status, r.signal), [], r.stderr);
      });
    });
  }
  test(`${kind}: a failing case fails the binary, with its file, line and values`,
    { skip: built.includes('smoke_test') ? false : notBuilt }, () => {
      const name = '[hidden] planted failures', next = '[hidden] passes after a failure';
      const r = run(cmd(file('smoke_test')), [name, next]);
      const report = parse(r.stdout);
      assert.equal(r.status, 1);
      assert.deepEqual(report.problems, []);
      assert.deepEqual(report.done, { passed: 1, failed: 1 });
      assert.equal(caseProblem(report, next), undefined);
      assert.match(r.stdout, /^FAIL \[hidden\] planted failures$/m);
      assert.match(r.stdout, /^PASS \[hidden\] passes after a failure$/m);
      const got = report.cases.get(name);
      assert.ok(got && !got.passed);
      assert.equal(got.failures.length, 3);
      assert.match(got.failures[0]!,
        /^native\/test\/smoke_test\.cpp:\d+: CHECK_NEAR\(1\.0, 1\.1, 1e-9, 0\) failed: 1 vs 1\.1/);
      assert.match(got.failures[1]!, /^native\/test\/smoke_test\.cpp:\d+: CHECK_EQ\(2, 3\) failed: 2 != 3$/);
      assert.match(got.failures[2]!, /^native\/test\/smoke_test\.cpp:\d+: unexpected exception: planted$/);
      // Hidden: not run or listed without its name; a filter selects by substring; a usage error and no match exit 2.
      assert.ok(!parseList(run(cmd(file('smoke_test')), ['--list']).stdout).includes(name));
      const some = parseList(run(cmd(file('smoke_test')), ['--list', 'Eigen']).stdout);
      assert.ok(some.length > 0 && some.every(n => n.includes('Eigen')));
      const usage = run(cmd(file('smoke_test')), ['--no-such-option']);
      assert.equal(usage.status, 2);
      assert.match(usage.stdout, /^usage: /);
      const sub = run(cmd(file('smoke_test')), ['planted']);
      assert.equal(sub.status, 2, 'a hidden case is selected by its whole name only');
      assert.doesNotMatch(sub.stdout, /^CASE /m);
      // A crash: the case never ends, the run fails, and the failure before it was flushed.
      const crash = run(cmd(file('smoke_test')), ['[hidden] crashes after a failure']);
      const crashed = parse(crash.stdout);
      assert.deepEqual(crashed.problems, ['case "[hidden] crashes after a failure" never ended']);
      assert.match(crash.stdout, /^ {2}native\/test\/smoke_test\.cpp:\d+: CHECK\(1 \+ 1 == 3\) failed$/m);
      assert.notDeepEqual(runProblems(crashed, ['[hidden] crashes after a failure'], crash.status, crash.signal), []);
      assert.ok(crash.status !== 0);
      assert.equal(run(cmd(file('smoke_test')), ['no case has this in its name']).status, 2);
    });
}

test('parse: cases, failures, DONE, and what breaks the format', () => {
  const r = parse('CASE a\nPASS a\nCASE b c\n  f.cpp:3: CHECK(x) failed\nFAIL b c\nDONE 1 1\n');
  assert.deepEqual([...r.cases], [['a', { passed: true, failures: [] }],
    ['b c', { passed: false, failures: ['f.cpp:3: CHECK(x) failed'] }]]);
  assert.deepEqual(r.done, { passed: 1, failed: 1 });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(runProblems(r, ['a', 'b c'], 1, null), []);
  assert.equal(caseProblem(r, 'a'), undefined);
  assert.equal(caseProblem(r, 'b c'), 'f.cpp:3: CHECK(x) failed');
  assert.equal(caseProblem(parse('CASE a\nFAIL a\n'), 'a'), 'failed');
  assert.equal(caseProblem(parse('CASE a\n'), 'a'), 'didn\'t run to its end');
  // A PASS with failure lines is a failure.
  assert.equal(parse('CASE a\n  f.cpp:1: x\nPASS a\n').cases.get('a')!.passed, false);
  // A crash in a case: never ended, no DONE, and the exit code.
  const crash = parse('CASE a\nPASS a\nCASE b\n');
  assert.deepEqual(crash.problems, ['case "b" never ended']);
  assert.deepEqual(runProblems(crash, ['a', 'b'], null, 'SIGSEGV'), ['case "b" never ended', 'killed by SIGSEGV',
    'no DONE line']);
  assert.deepEqual(parse('CASE a\nCASE b\nPASS b\n').problems, ['case "a" never ended']);
  assert.deepEqual(parse('PASS a\n').problems, ['"PASS a" outside its case']);
  assert.deepEqual(parse('CASE a\nPASS b\n').problems, ['"PASS b" outside its case']);
  assert.deepEqual(parse('CASE a\nPASS a\nCASE a\nPASS a\n').problems, ['case "a" ran twice']);
  assert.deepEqual(parse('stray\n').problems, ['unexpected line "stray"']);
  assert.deepEqual(parse('  f.cpp:1: outside\n').problems, ['unexpected line "  f.cpp:1: outside"']);
  assert.deepEqual(parse('CASE a\nDONE 0 0\nPASS a\n').problems, ['unexpected line "DONE 0 0"']);
  assert.deepEqual(parse('DONE 1 0\nDONE 1 0\n').problems, ['unexpected line "DONE 1 0"']);
  // Exit codes and counts that disagree with the cases.
  const ok = parse('CASE a\nPASS a\nDONE 1 0\n');
  assert.deepEqual(runProblems(ok, ['a'], 0, null), []);
  assert.deepEqual(runProblems(ok, ['a'], 1, null), ['exit 1 with 0 failed']);
  assert.deepEqual(runProblems(ok, ['a'], 2, null), ['exit 2 with 0 failed']);
  assert.deepEqual(runProblems(parse('CASE a\nFAIL a\nDONE 0 1\n'), ['a'], 0, null), ['exit 0 with 1 failed']);
  assert.deepEqual(runProblems(parse('CASE a\nPASS a\nDONE 2 0\n'), ['a'], 0, null),
    ['DONE 2 0 but 1 passed, 0 failed']);
  assert.deepEqual(runProblems(parse('CASE a\nPASS a\nDONE 1 1\n'), ['a'], 0, null),
    ['DONE 1 1 but 1 passed, 0 failed']);
  assert.deepEqual(runProblems(ok, [], 0, null), ['case "a" ran but isn\'t listed']);
  assert.deepEqual(runProblems(parse('CASE a\nPASS a\n'), ['a'], 0, null), ['no DONE line']);
  assert.deepEqual(parseList('CASE a\nCASE b c\n'), ['a', 'b c']);
  assert.throws(() => parseList('CASE a\nPASS a\n'), /unexpected line/);
  assert.throws(() => parseList('CASE a\nCASE a\n'), /twice/);
});

test('build.sh guard: Eigen headers outside the allowed modules fail, naming the first of each module', () => {
  const e = path.resolve(pkg, '../../third_party/eigen');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-geom-guard-'));
  try {
    const depFile = (name: string, deps: string[]) => {
      const f = path.join(dir, name);
      fs.writeFileSync(f, `x.o: x.cpp \\\n ${deps.join(' \\\n ')}\n`);
      return f;
    };
    const guardFiles = (...files: string[]) =>
      spawnSync('bash', [path.join(pkg, 'build.sh'), 'guard', ...files], { encoding: 'utf8' });
    const guard = (...deps: string[]) => guardFiles(depFile('x.d', deps));
    const allowed = guard(`${e}/Eigen/Dense`, `${e}/Eigen/src/Core/Matrix.h`, `${e}/Eigen/src/Core/../plugins/X.inc`,
      `${e}/Eigen/src/misc/Image.h`, `${e}/Eigen/Version`, `${e}/Eigen/src/Jacobi/Jacobi.h`, '/usr/include/vector',
      'native/include/cad_geom/x.h');
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.equal(allowed.stderr, '');
    for (const bad of [`${e}/unsupported/Eigen/AutoDiff`, `${e}/Eigen/MetisSupport`, `${e}/Eigen/Sparse`,
      `${e}/Eigen/src/SparseCore/SparseMatrix.h`, `${e}/Eigen/src/Core/../SparseCore/SparseMatrix.h`,
      path.relative(pkg, `${e}/unsupported/Eigen/FFT`)]) {
      const r = guard(`${e}/Eigen/Core`, bad);
      assert.equal(r.status, 1, bad);
      const shown = path.normalize(path.resolve(pkg, bad)).slice(e.length + 1);
      assert.equal(r.stderr, `Eigen guard: ${path.join(dir, 'x.d')} includes ${shown}, outside the allowed modules ` +
        '(Eigen/ Core Dense LU Cholesky QR SVD Eigenvalues Geometry Householder Jacobi)\n');
    }
    const two = guard(`${e}/Eigen/SparseCore`, `${e}/Eigen/src/SparseCore/A.h`, `${e}/unsupported/Eigen/FFT`);
    assert.deepEqual(two.stderr.trim().split('\n').map(l => l.split(' includes ')[1]!.split(',')[0]),
      ['Eigen/SparseCore', 'unsupported/Eigen/FFT']);
    // Each file says its own: the same module in two files is named twice.
    const both = guardFiles(depFile('a.d', [`${e}/Eigen/Sparse`]), depFile('b.d', [`${e}/Eigen/Sparse`]));
    assert.equal(both.status, 1);
    assert.deepEqual(both.stderr.trim().split('\n').map(l => path.basename(l.split(' ')[2]!)), ['a.d', 'b.d']);
    assert.equal(spawnSync('bash', [path.join(pkg, 'build.sh'), 'guard']).status, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** A reference fixture pair of every kind, as the reference lane writes them (format 2). */
function referenceJson(): Record<string, any> {
  const tol = { tol: 1e-12, abs: 1e-9 };
  return { format: 2, name: 'cylinder', variant: 's1e-3', file: 'cylinder-s1e-3',
    similarity: { scale: 0.001, rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], translation: [0, 0, 5] }, uncertainty: 1e-10,
    facts: [
      { kind: 'curvePoint', curve: 1, id: 4294967295, t: 0.1, p: [1, 2, 3], d1: [0.5, -0.25], d2: [-1, 1e-300, 7e21],
        ...tol },
      { kind: 'curvePoint', curve: 2, id: 8, t: 2, p: [3, 2, 1], d1: [0, 0, 0], d2: [0, 0, 0], ...tol },
      { kind: 'curveLength', curve: 1, id: 7, t0: 0, t1: 6.283185307179586, length: 12.566370614359172, ...tol },
      { kind: 'surfacePoint', surface: 0, id: 3, u: 0.5, v: 1, p: [1, 0, 0], du: [0, 1, 0], dv: [0, 0, 1],
        duu: [-1, 0, 0], duv: [0, 0, 0], dvv: [0, 0, 0], n: [1, 0, 0], ...tol },
      { kind: 'surfacePoint', surface: 0, id: 3, u: 0, v: 0, p: [0, 0, 0], du: [0, 0, 0], dv: [0, 0, 1],
        duu: [0, 0, 0], duv: [0, 0, 0], dvv: [0, 0, 0], n: null, ...tol },
      { kind: 'curveInverse', curve: 1, id: 7, p: [2, 0, 0], t: 0, distance: 0, certainty: 'ambiguous',
        alternatives: [6.283185307179586], onSeam: false, ptol: 1e-9, ...tol },
      { kind: 'curveInverse', curve: 1, id: 7, p: [0, 2, 0], t: 1.5707963267948966, distance: 0, certainty: 'unique',
        alternatives: [], onSeam: true, ptol: 1e-9, ...tol },
      { kind: 'surfaceInverse', surface: 0, id: 3, p: [2, 0, 1], uv: [0, 1], distance: 0, certainty: 'ambiguous',
        alternatives: [[6.283185307179586, 1]], onSeamU: true, onSeamV: false, atSingularity: false, ptol: 1e-9,
        ...tol },
      { kind: 'faceArea', face: 0, id: 9, area: 62.83185307179586, ...tol },
      { kind: 'volume', body: 0, id: 1, volume: -1e20, ...tol },
    ],
    cases: [] };
}

test('fixtures.ts: reference facts as C++ data, every field as the JSON has it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-geom-fixtures-'));
  try {
    const cbr = Uint8Array.from({ length: 24 }, (_, i) => i * 7);
    fs.writeFileSync(path.join(dir, 'cylinder-s1e-3.cbr'), cbr);
    fs.writeFileSync(path.join(dir, 'cylinder-s1e-3.json'), JSON.stringify(referenceJson()));
    const header = generate(dir);
    assert.equal(generate(dir), header, 'deterministic');
    assert.ok(header.includes(`ref_cylinder_s1e_3_cbr[24] = {\n  ${Array.from(cbr, b => `${b},`).join('')}\n};`));
    const cxx = spawnSync('c++', ['--version']).status === 0;
    if (!cxx) return;  // the text checks above still ran
    fs.writeFileSync(path.join(dir, 'brep_models.h'), header);
    fs.writeFileSync(path.join(dir, 'p.cpp'), String.raw`#include <cstdio>
#include "brep_models.h"
using namespace fixtures;
static void v(const char* n, Vec a) { std::printf(" %s=%.17g,%.17g,%.17g", n, a.x, a.y, a.z); }
int main() {
  std::printf("n=%d models=%d\n", nReferences, (int)(sizeof models / sizeof models[0]));
  const Reference* r = reference("cylinder", "s1e-3");
  if (!r || reference("cylinder", "s1") || reference("box", "s1e-3")) return 1;
  std::printf("%s %s %s %zu %d %.17g", r->name, r->variant, r->file, r->size, (int)r->data[23], r->scale);
  for (double x : r->rotation) std::printf(" %g", x);
  for (double x : r->translation) std::printf(" %g", x);
  std::printf(" %.17g\n", r->uncertainty);
  std::printf("counts %d %d %d %d %d %d %d\n", r->nCurvePoints, r->nCurveLengths, r->nSurfacePoints,
    r->nCurveInverses, r->nSurfaceInverses, r->nFaceAreas, r->nVolumes);
  for (int i = 0; i < r->nCurvePoints; i++) {
    const CurvePoint& f = r->curvePoints[i];
    std::printf("cp %d %u %.17g", f.curve, f.id, f.t); v("p", f.p); v("d1", f.d1); v("d2", f.d2);
    std::printf(" %g %g\n", f.tol, f.abs);
  }
  const CurveLength& l = r->curveLengths[0];
  std::printf("cl %d %u %.17g %.17g %.17g\n", l.curve, l.id, l.t0, l.t1, l.length);
  for (int i = 0; i < r->nSurfacePoints; i++) {
    const SurfacePoint& f = r->surfacePoints[i];
    std::printf("sp %d %u %g %g", f.surface, f.id, f.u, f.v); v("p", f.p); v("du", f.du); v("dv", f.dv);
    v("duu", f.duu); v("duv", f.duv); v("dvv", f.dvv); v("n", f.n); std::printf(" %d\n", f.hasN);
  }
  for (int i = 0; i < r->nCurveInverses; i++) {
    const CurveInverse& f = r->curveInverses[i];
    std::printf("ci %d %u", f.curve, f.id); v("p", f.p);
    std::printf(" %.17g %g %d %d", f.t, f.distance, (int)f.certainty, f.nAlternatives);
    for (int k = 0; k < f.nAlternatives; k++) std::printf(" %.17g", f.alternatives[k]);
    std::printf(" %d %g %d\n", f.onSeam, f.ptol, f.alternatives == nullptr);
  }
  const SurfaceInverse& s = r->surfaceInverses[0];
  std::printf("si %d %u", s.surface, s.id); v("p", s.p);
  std::printf(" %g %g %g %d %d %.17g %g %d %d %d %g\n", s.u, s.v, s.distance, (int)s.certainty, s.nAlternatives,
    s.alternatives[0], s.alternatives[1], s.onSeamU, s.onSeamV, s.atSingularity, s.ptol);
  std::printf("fa %d %u %.17g\nvo %d %u %g\n", r->faceAreas[0].face, r->faceAreas[0].id, r->faceAreas[0].area,
    r->volumes[0].body, r->volumes[0].id, r->volumes[0].volume);
  std::printf("tol %g %g\n", r->volumes[0].tol, r->volumes[0].abs);
}
`);
    const b = spawnSync('c++', ['-std=c++20', '-Wall', '-Wextra', '-Werror', `-I${path.join(pkg, 'native/include')}`,
      path.join(dir, 'p.cpp'), '-o', path.join(dir, 'p')], { encoding: 'utf8' });
    assert.equal(b.status, 0, b.stderr);
    const out = spawnSync(path.join(dir, 'p'), { encoding: 'utf8' });
    assert.equal(out.status, 0);
    const pi2 = '6.2831853071795862';
    assert.equal(out.stdout, `n=1 models=9
cylinder s1e-3 cylinder-s1e-3 24 161 0.001 1 0 0 0 1 0 0 0 1 0 0 5 1e-10
counts 2 1 2 2 1 1 1
cp 1 4294967295 0.10000000000000001 p=1,2,3 d1=0.5,-0.25,0 d2=-1,1e-300,7e+21 1e-12 1e-09
cp 2 8 2 p=3,2,1 d1=0,0,0 d2=0,0,0 1e-12 1e-09
cl 1 7 0 ${pi2} 12.566370614359172
sp 0 3 0.5 1 p=1,0,0 du=0,1,0 dv=0,0,1 duu=-1,0,0 duv=0,0,0 dvv=0,0,0 n=1,0,0 1
sp 0 3 0 0 p=0,0,0 du=0,0,0 dv=0,0,1 duu=0,0,0 duv=0,0,0 dvv=0,0,0 n=0,0,0 0
ci 1 7 p=2,0,0 0 0 1 1 ${pi2} 0 1e-09 0
ci 1 7 p=0,2,0 1.5707963267948966 0 0 0 1 1e-09 1
si 0 3 p=2,0,1 0 1 0 1 1 ${pi2} 1 1 0 0 1e-09
fa 0 9 62.831853071795862
vo 0 1 -1e+20
tol 1e-12 1e-09
`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fixtures.ts: what it doesn\'t know fails the run, naming the file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-geom-fixtures-'));
  try {
    const fails = (change: (j: Record<string, any>) => void, message: RegExp, cbr = true) => {
      for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f));
      const j = referenceJson();
      change(j);
      fs.writeFileSync(path.join(dir, 'cylinder-s1e-3.json'), JSON.stringify(j));
      if (cbr) fs.writeFileSync(path.join(dir, 'cylinder-s1e-3.cbr'), new Uint8Array(8));
      assert.throws(() => generate(dir), message);
    };
    fails(j => { j.facts[0].kind = 'curveCurvature'; },
      /cylinder-s1e-3\.json facts\[0\]: unknown kind "curveCurvature"/);
    fails(j => { j.facts[2].speed = 1; }, /facts\[2\] \(curveLength\): unknown field "speed"/);
    fails(j => { delete j.facts[3].n; }, /facts\[3\] \(surfacePoint\)\.n: missing/);
    fails(j => { delete j.facts[0].abs; }, /facts\[0\] \(curvePoint\)\.abs: missing/);
    fails(j => { j.facts[5].certainty = 'probable'; }, /unknown certainty probable/);
    fails(j => { j.facts[0].p = [1, 2, 3, 4]; }, /facts\[0\] \(curvePoint\)\.p: not 2 or 3 numbers/);
    fails(j => { j.facts[0].t = null; }, /\.t: not a finite number/);
    fails(j => { j.facts[0].curve = -1; }, /\.curve: not an index/);
    fails(j => { j.facts[0].curve = 1.5; }, /\.curve: not an index/);
    fails(j => { j.facts[0].id = 2 ** 32; }, /\.id: not an index/);
    fails(j => { j.facts[7].onSeamU = 1; }, /\.onSeamU: not a boolean/);
    fails(j => { j.facts[7].alternatives = [[1, 2, 3]]; }, /\.alternatives\[0\]: not 2 numbers/);
    fails(j => { j.facts[7].uv = [1]; }, /\.uv: not 2 numbers/);
    fails(j => { j.format = 1; }, /format 1, this reads 2/);
    fails(j => { delete j.facts[5].onSeam; }, /facts\[5\] \(curveInverse\)\.onSeam: missing/);
    fails(j => { j.extra = 1; }, /unknown key "extra"/);
    fails(j => { delete j.cases; }, /missing "cases"/);
    fails(j => { j.variant = 's1'; }, /don't match/);
    fails(j => { j.similarity.rotation = [1]; }, /similarity needs/);
    fails(() => {}, /cylinder-s1e-3: needs both \.cbr and \.json/, false);
    // A missing directory is no references, not an error (the reference lane's files may not be fetched yet).
    assert.match(generate(path.join(dir, 'none')), /nReferences = 0;/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
