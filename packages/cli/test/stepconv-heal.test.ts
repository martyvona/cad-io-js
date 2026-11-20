// Healing in stepconv: --heal, --no-heal, --heal-on and --heal-off, in workers and on the main thread. The meshed
// output needs the built OCCT backend (packages/tess-occt/build.sh); skipped without it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { HEAL_BY_DEFAULT } from 'cad-heal';
import { importStep } from 'step-import';
import { healTestScene, stepOf } from '../../cad-heal/test/scene.ts';
import { occtBuilt, run, tmp } from './stepconv-helpers.ts';

const input = path.join(tmp, 'heal.stp');
fs.writeFileSync(input, stepOf(healTestScene()));
const out = path.join(tmp, 'healed.stp');
/** The stray part's farthest pole in the STEP written, as imported again without healing. */
async function farthest(file: string) {
  const { scene } = await importStep(fs.readFileSync(file), { heal: { heal: false } });
  const m = scene.parts.find((p) => p.name === 'stray')!.brep!.model;
  return Math.max(...m.pool.curveReal.map(Math.abs));
}
const said = (stderr: string) => [...stderr.matchAll(/^ {2}(?:warning|error): #\d+: ([A-Za-z ]+):/gm)].map((m) => m[1]);

test('stepconv --heal heals before writing (STEP: the stray pole moved), in workers and on the main thread, the same '
  + 'bytes either way, with healing timed in the summary', async () => {
  const bytes: string[] = [];
  for (const workers of ['3', '0']) {
    const r = await run([input, '-o', out, '--heal', '-j', workers]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /\nimport [\d.]+ s, healing [\d.]+ s, export [\d.]+ s\n/);
    assert.ok(said(r.stderr).includes('strayPole'), r.stderr);
    assert.ok(await farthest(out) < 10);
    bytes.push(fs.readFileSync(out, 'latin1'));
  }
  assert.equal(bytes[0], bytes[1]);
});

test('stepconv --no-heal, and the default (HEAL_BY_DEFAULT): the models as imported, no healing in the summary',
  async () => {
  const r = await run([input, '-o', out, '--no-heal']);
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /healing/);
  assert.deepEqual(said(r.stderr), []);
  assert.ok(await farthest(out) > 1e6);
  const d = await run([input, '-o', out]);
  assert.equal(/healing/.test(d.stderr), HEAL_BY_DEFAULT);
  assert.equal(await farthest(out) < 10, HEAL_BY_DEFAULT);
});

test('stepconv --heal-off and --heal-on: those fixes off or on, healing on', async () => {
  const off = await run([input, '-o', out, '--heal-off', 'strayPole,pcurveReplace']);
  assert.equal(off.code, 0, off.stderr);
  assert.match(off.stderr, /healing [\d.]+ s/);
  assert.ok(!said(off.stderr).includes('strayPole') && !said(off.stderr).includes('pcurveReplace')
    && said(off.stderr).includes('tolerances grown'), off.stderr);
  assert.ok(await farthest(out) > 1e6);
  const on = await run([input, '-o', out, '--heal-on', 'pcurveMissing']);
  assert.ok(said(on.stderr).includes('pcurveMissing') && said(on.stderr).includes('strayPole'), on.stderr);
  assert.ok(!said((await run([input, '-o', out, '--heal'])).stderr).includes('pcurveMissing'));
});

test('stepconv healing usage errors', async () => {
  for (const [args, message] of [
    [['--heal', '--no-heal'], '--heal and --no-heal together'],
    [['--no-heal', '--heal-on', 'strayPole'], '--no-heal and --heal-on together'],
    [['--no-heal', '--heal-off', 'strayPole'], '--no-heal and --heal-off together'],
    [['--heal-off', 'strayPole,nope'], "--heal-off takes fixes from strayPole, pcurveMissing, pcurveReparam, "
      + "pcurveReplace, pcurveEnds, edgeTolerance, vertexTolerance, not 'nope'"],
    [['--heal-on', ','], "--heal-on takes fixes from"],
    [['--heal-on', 'strayPole', '--heal-off', 'strayPole'], 'strayPole both in --heal-on and --heal-off'],
  ] as [string[], string][]) {
    const r = await run([input, '-o', out, ...args]);
    assert.equal(r.code, 1, args.join(' '));
    assert.ok(r.stderr.startsWith(`stepconv: ${message}`), r.stderr.split('\n')[0]);
  }
});

test('stepconv --heal with meshing: healed in the backend\'s pool, then meshed', { skip: !occtBuilt && 'tess-occt not '
  + 'built' }, async () => {
  const glb = path.join(tmp, 'healed.glb');
  for (const workers of ['2', '0']) {
    const r = await run([input, '-o', glb, '--heal', '-j', workers]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /\nimport [\d.]+ s, healing [\d.]+ s, tessellation [\d.]+ s/);
    assert.match(r.stderr, /^4 parts \(4 of 4 brep parts tessellated\)/);
    assert.ok(said(r.stderr).includes('strayPole'), r.stderr);
  }
});

test('stepconv --help names every fix, and the default as HEAL_BY_DEFAULT has it', async () => {
  const { HEAL_FIXES, FIXES_OFF_BY_DEFAULT } = await import('cad-heal');
  const help = (await run(['-h'])).stdout.replace(/\s+/g, ' ');
  for (const f of HEAL_FIXES) assert.ok(help.includes(f), f);
  assert.deepEqual(FIXES_OFF_BY_DEFAULT, ['pcurveMissing']);
  assert.ok(help.includes(`(default: ${HEAL_BY_DEFAULT ? 'healed' : 'as imported'})`));
});
