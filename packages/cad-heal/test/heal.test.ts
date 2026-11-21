import assert from 'node:assert/strict';
import test from 'node:test';
import { BrepBuilder } from '../../cad-brep/src/index.ts';
import { box } from '../../cad-brep/test/models.ts';
import { fixesOn, HEAL_FIXES, healPart, healScene } from '../src/index.ts';

test('fixesOn: every fix but the pcurveMissing ones by default, none with heal false, each one off by name, unknown '
  + 'names refused', () => {
  const byDefault = HEAL_FIXES.filter((f) => !f.startsWith('pcurveMissing'));
  assert.deepEqual(fixesOn(), byDefault);
  assert.deepEqual(fixesOn({ heal: true }), byDefault);
  assert.deepEqual(fixesOn({ heal: false }), []);
  assert.deepEqual(fixesOn({ heal: false, fixes: { pcurveMissingOnFreeForm: true } }), []);
  for (const f of HEAL_FIXES) {
    const all = { pcurveMissingOnPlane: true, pcurveMissingOnElementary: true, pcurveMissingOnFreeForm: true };
    assert.deepEqual(fixesOn({ fixes: { ...all, [f]: false } }),
      HEAL_FIXES.filter((g) => g !== f), f);
  }
  assert.deepEqual(fixesOn({ fixes: { edgeTolerance: true } }), byDefault);
  assert.throws(() => fixesOn({ fixes: { noSuchFix: false } as never }), /no fix named noSuchFix/);
});

test('healPart with heal false gives the model as it is', async () => {
  const b = new BrepBuilder();
  box(b);
  const d = b.finish();
  const r = await healPart(d, { heal: false });
  assert.equal(r.model, d);
  assert.equal(r.changed, false);
  assert.deepEqual(r.diagnostics, []);
});

test('progress: each part, each step, and every PROGRESS_EVERY coedges through the curves', async () => {
  const { PROGRESS_EVERY } = await import('../src/curves.ts');
  const { cylinderSide } = await import('./models.ts');
  const said: string[] = [];
  const scene = { parts: [{ brep: { model: cylinderSide().finish(), format: 'step' }, sources: [] }],
    diagnostics: [] } as unknown as import('cad-scene').Scene;
  await healScene(scene, { progress: (w) => said.push(w) }, await (await import('cad-geom')).init());
  assert.deepEqual(said, ['part 0 of 1', 'part 0 of 1: strayPole', 'part 0 of 1: ranges and vertexTolerance',
    'part 0 of 1: the healed model and its analysis'],
    `fewer than ${PROGRESS_EVERY} coedges: no coedge line`);
});

test('progress through a part of more than PROGRESS_EVERY coedges: a line every PROGRESS_EVERY, naming where', async () => {
  const { PROGRESS_EVERY } = await import('../src/curves.ts');
  const b = new BrepBuilder({ uncertainty: 1e-6 });
  // Enough boxes for a few hundred coedges (24 each).
  for (let k = 0; k < Math.ceil(2.5 * PROGRESS_EVERY / 24); k++) box(b, [1, 2, 3], [3 * k, 0, 0], 100 * k);
  const said: string[] = [], d = b.finish();
  await healPart(d, { progress: (w) => said.push(w) }, await (await import('cad-geom')).init());
  const lines = said.filter((w) => w.startsWith('curves: coedge'));
  assert.equal(lines.length, Math.floor(d.coedge.edge.length / PROGRESS_EVERY));
  assert.match(lines[0]!, new RegExp(`^curves: coedge ${PROGRESS_EVERY} of ${d.coedge.edge.length} \\(face \\d+, `
    + `coedge #\\d+ \\(edge #\\d+\\)\\)$`));
});

test("healScene: a changed part's outline drawn from its healed model, an unchanged part's kept", async () => {
  const { healTestScene } = await import('./scene.ts');
  const { faceOutlines } = await import('../../cad-brep/src/index.ts');
  const scene = healTestScene(), kept = () => ({ faces: [], positions: new Float32Array(), outlines: [] });
  for (const p of scene.parts) [p.brep!.outline, p.origin] = [kept, [1, 2, 3]];
  await healScene(scene);
  const [stray, , , solid] = scene.parts;
  assert.equal(solid!.brep!.outline, kept);
  assert.notEqual(stray!.brep!.outline, kept);
  const o = { linearDeflection: 0.1, angularDeflection: 0.5 };
  assert.deepEqual(stray!.brep!.outline!(o), faceOutlines(stray!.brep!.model, stray!.origin, o));
  assert.deepEqual(stray!.brep!.outline!({ ...o, faces: new Set([8]) }),
    faceOutlines(stray!.brep!.model, stray!.origin, o, new Set([8])));
});

test('healScene with parts healing at once: diagnostics in the parts\' order however they finish, each part its own '
  + 'result, at most `concurrency` at a time', async () => {
  const { healTestScene } = await import('./scene.ts');
  const serial = healTestScene(), parallel = healTestScene();
  await healScene(serial);
  let running = 0, most = 0;
  await healScene(parallel, { concurrency: 3, healer: async (req, progress) => {
    most = Math.max(most, ++running);
    // The first part last.
    await new Promise((r) => setTimeout(r, req.source!.id === 100 ? 60 : 10));
    const r = await healPart(req.model, { ...req.options, progress }, undefined, req.source);
    running--;
    return r;
  } });
  assert.equal(most, 3);
  assert.deepEqual(parallel.diagnostics, serial.diagnostics);
  assert.ok(serial.diagnostics.length >= 3);
  for (const [i, p] of parallel.parts.entries()) {
    assert.deepEqual(new Uint8Array(p.brep!.model.buffer), new Uint8Array(serial.parts[i]!.brep!.model.buffer));
  }
});

test('healScene: a throw healing here propagates (a caller bug or a trap), unlike a healer elsewhere', async () => {
  const { healTestScene } = await import('./scene.ts');
  const scene = healTestScene();
  scene.parts[1]!.brep!.model = { ...scene.parts[1]!.brep!.model, buffer: new ArrayBuffer(3) };
  await assert.rejects(healScene(scene));
});

test('poolHealer: healJob in the pool by the module given, its progress passed, within HEAL_CPU_TIMEOUT_MS of CPU '
  + 'and HEAL_TIMEOUT_MS of wall time', async () => {
  const { HEAL_CPU_TIMEOUT_MS, HEAL_TIMEOUT_MS, poolHealer } = await import('../src/index.ts');
  const calls: unknown[][] = [];
  const said: string[] = [];
  const pool = { run: async <T>(...a: unknown[]) => {
    calls.push(a);
    (a[2] as { onProgress: (m: string) => void }).onProgress('half way');
    return 'healed' as T;
  } };
  const req = { model: {} as never, options: {} };
  assert.equal(await poolHealer(pool, 'the-module')(req, (m) => said.push(m)), 'healed');
  assert.deepEqual(calls[0]!.slice(0, 2), [{ module: 'the-module', export: 'healJob' }, req]);
  const opts = calls[0]![2] as { timeoutMs: number; cpuTimeoutMs: number };
  assert.deepEqual([opts.timeoutMs, opts.cpuTimeoutMs], [HEAL_TIMEOUT_MS, HEAL_CPU_TIMEOUT_MS]);
  assert.ok(HEAL_TIMEOUT_MS > HEAL_CPU_TIMEOUT_MS);
  assert.deepEqual(said, ['half way']);
});
