// corpus_checks/coverage_corpus.ts: a run in which no file was checked fails, saying so, rather than printing an
// empty report and exiting 0 (a backend that won't start fails it too: runner.ts, test/runner.test.ts); HEAL=1 heals
// the parts before the backends mesh them.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { healTestScene, stepOf } from '../packages/cad-heal/test/scene.ts';
import { beyondRepair } from '../corpus_checks/cadio_causes.ts';

const SCRIPT = new URL('../corpus_checks/coverage_corpus.ts', import.meta.url).pathname;

test('coverage_corpus: no file to check is an error, a nonzero exit naming the lists', { timeout: 60_000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-empty-'));
  try {
    const list = path.join(dir, 'none.txt');
    fs.writeFileSync(list, '');
    const r = spawnSync(process.execPath, [SCRIPT, list], { encoding: 'utf8',
      env: { ...process.env, CHILDREN: '1' } });
    assert.notEqual(r.status, 0);
    assert.ok(r.stderr.includes(`Error: coverage: no file ran: 0 listed (${list}), 0 over 1000 MB, 0 failed`),
      r.stderr);
    assert.doesNotMatch(r.stdout, /^## /m, 'no report');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const MODULES = ['tess-cadio/dist/tess_cadio.wasm', 'tess-occt/dist/occt_tess.wasm', 'tess-smlib/dist/smlib_tess.wasm']
  .filter((m) => !fs.existsSync(new URL(`../packages/${m}`, import.meta.url)));
const THIRD_PARTY = new URL('../test_corpus/third_party/', import.meta.url).pathname;

test('coverage_corpus: HEAL=1 heals the parts before meshing; without it they are meshed as imported',
  { timeout: 300_000, skip: MODULES.length ? `modules not built: ${MODULES.join(', ')}` : false }, () => {
  // cad-heal's test scene: its part "stray" has a B-spline edge with a pole thrown far out, so ours fails its face as
  // imported (its use placed on the projection's feet, which pass through a point of its boundary twice), and meshes
  // it once strayPole has moved the pole.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-heal-'));
  try {
    fs.writeFileSync(path.join(dir, 'heal.step'), stepOf(healTestScene()));
    const list = path.join(dir, 'list.txt');
    fs.writeFileSync(list, `${path.relative(THIRD_PARTY, path.join(dir, 'heal.step'))}\n`);
    const run = (heal: string) => {
      const r = spawnSync(process.execPath, [SCRIPT, list], { encoding: 'utf8',
        env: { ...process.env, CHILDREN: '1', HEAL: heal } });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout;
    };
    const off = run('0'), on = run('1');
    assert.match(off, /; healing off; /);
    assert.match(on, /; healing on \(cad-heal's default fixes\); /);
    assert.match(off, /faces without triangles failed 1 of 9 /);
    assert.match(off, /heal\.step #\d+ face #\d+ \(plane\): invalidModel: its boundary in \(u, v\) through its own /);
    assert.match(on, /ours parts: ok 4, partial 0, no triangles 0, /);
    assert.match(on, /ours: faces beyond repair \(input, apart from our failures\): 0 of 9 /);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('beyondRepair: the far-off cause, and healing\'s past-repair one for an edge or a vertex whatever its id and '
  + 'sizes; nothing else', () => {
  for (const c of ["invalidModel: a use of an edge whose curve is far off its face's surface",
    'invalidModel: an edge (#307458) whose tolerance healing grew from 1e-05 to 289 mm, past repair',
    'invalidModel: a vertex (#74) whose tolerance healing grew from 1e-05 to 3.32 mm, past repair',
    'invalidModel: an edge (#1) whose tolerance healing grew from 0.000102 to 1.2e+03 mm, past repair']) {
    assert.ok(beyondRepair(c), c);
  }
  for (const c of ['invalidModel: its boundary in (u, v) crossing itself (an edge and an edge)',
    'noConvergence: an edge (#307458) whose tolerance healing grew from 1e-05 to 289 mm, past repair',
    'invalidModel: an edge (#307458) whose tolerance healing grew from 1e-05 to 289 mm',
    'invalidModel: a face (#3) whose tolerance healing grew from 1e-05 to 289 mm, past repair',
    'invalidModel: an edge (#x) whose tolerance healing grew from 1e-05 to 289 mm, past repair',
    'invalidModel: an edge (#307458) whose tolerance healing grew from 1e-05 to 289 mm, past repair, and more',
    "invalidModel: a use of an edge whose curve is far off its face's surface (planted)", 'part over 120 s CPU',
    'planted: invalidModel: an edge (#307458) whose tolerance healing grew from 1e-05 to 289 mm, past repair']) {
    assert.ok(!beyondRepair(c), c);
  }
});

const B25415 = 'gkv311-opencascade-dataset/step/bug25415_part_of_hdrv8w64p254_4x2_1016x502h838p.stp';
test('coverage_corpus: HEAL=1 passes each healed part\'s analysis: faces through edges healing grew past repair are '
  + 'meshed, kept with their distance off their surfaces', { timeout: 300_000,
  skip: MODULES.length ? `modules not built: ${MODULES.join(', ')}`
    : !fs.existsSync(path.join(THIRD_PARTY, B25415)) ? 'corpus not pulled' : false }, () => {
  // bug25415 #418: two line edges 2.39 and 0.44 mm off their plane faces on a part of uncertainty 1e-5. As imported,
  // 1 face kept far off and 6 failed; healed, tolerances grown up to 3.32 mm, 13 faces kept far off.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-past-'));
  try {
    const list = path.join(dir, 'list.txt');
    fs.writeFileSync(list, `${B25415}\n`);
    const run = (heal: string) => {
      const r = spawnSync(process.execPath, [SCRIPT, list], { encoding: 'utf8',
        env: { ...process.env, CHILDREN: '1', HEAL: heal } });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout;
    };
    const off = run('0'), on = run('1');
    assert.match(off, /ours: faces beyond repair \(input, apart from our failures\): 0 of 14 /);
    assert.match(off, /ours: faces kept with defects \(meshed, counted as meshed\): 1 of 14 /);
    assert.match(off, /faces without triangles failed 6 of 14 /);
    assert.match(on, /ours: faces beyond repair \(input, apart from our failures\): 0 of 14 /);
    assert.match(on, /ours: faces kept with defects \(meshed, counted as meshed\): 13 of 14 /);
    assert.match(on, /faces without triangles failed 0 of 14 /);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('coverage_corpus: ROUNDS= tallies our split rounds per part and lists those from 16 up, a TSV line each',
  { timeout: 300_000, skip: MODULES.length ? `modules not built: ${MODULES.join(', ')}`
    : !fs.existsSync(path.join(THIRD_PARTY, B25415)) ? 'corpus not pulled' : false }, () => {
  // bug25415 #418, as imported: its refinement takes 25 rounds, from 16 up, short of the cap, in a moment.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-rounds-'));
  try {
    const list = path.join(dir, 'list.txt');
    fs.writeFileSync(list, `${B25415}\n`);
    const r = spawnSync(process.execPath, [SCRIPT, list], { encoding: 'utf8',
      env: { ...process.env, CHILDREN: '1', ROUNDS: path.join(dir, 'rounds') } });
    // (Each failure with the run's output and its errors.)
    const said = (x: typeof r) => `stdout:\n${x.stdout}\nstderr:\n${x.stderr}`;
    assert.equal(r.status, 0, said(r));
    assert.match(r.stdout, /our split rounds per part: at the cap of 48 0, 16 to 47 1, under 16 0, over 120 s CPU /,
      said(r));
    assert.match(r.stdout, /### Parts ours split in 16 or more rounds \(1\)/, said(r));
    assert.match(r.stdout, /bug25415\S* #418 \(14 faces\): 25 rounds, \d+ faces unsplit, 6 failed, /, said(r));
    const tsv = fs.readdirSync(dir).filter((f) => /^rounds\.\d+\.tsv$/.test(f));
    assert.equal(tsv.length, 1, said(r));
    const [where, rounds, , failed, cpu, triangles, status] = fs.readFileSync(path.join(dir, tsv[0]!), 'utf8').trim()
      .split('\t');
    assert.match(where!, /bug25415.* #418$/);
    assert.deepEqual([rounds, failed, status], ['25', '6', 'partial'], said(r));
    assert.ok(Number(cpu) >= 0 && Number(triangles) > 0);
    // Over a CPU cap of 1 ms: by the last round its progress named (none past the first pass), at least.
    fs.rmSync(path.join(dir, tsv[0]!));
    const o = spawnSync(process.execPath, [SCRIPT, list], { encoding: 'utf8',
      env: { ...process.env, CHILDREN: '1', ROUNDS: path.join(dir, 'rounds'), CPU_MS: '1' } });
    assert.equal(o.status, 0, said(o));
    assert.match(o.stdout,
      /at the cap of 48 0, 16 to 47 0, under 16 0, over 0\.001 s CPU \(by the last round seen\) 1,/, said(o));
    const over = fs.readdirSync(dir).filter((f) => /^rounds\.\d+\.tsv$/.test(f));
    assert.equal(over.length, 1, said(o));
    // (Its 14 faces failed: none meshed. As imported 8 meshed and 6 failed.)
    const line = fs.readFileSync(path.join(dir, over[0]!), 'utf8').trim().split('\t');
    assert.deepEqual([line[1], line[3]], ['>=0', '14'], said(o));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
