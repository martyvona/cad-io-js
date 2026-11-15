// CadioTessellator on cad-brep's test models through the WebAssembly module (build.sh module; skipped where it isn't
// built): the result's shape as cad-scene's other backends give it, closed where the model is (cad-scene's
// openEdges), faces cad-geom can't mesh reported, positions minus the origin, normals finite and unit, the same bytes
// twice in one instance and in fresh ones.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { openEdges, type TessellationResult } from 'cad-scene';
import { MODELS } from '../../cad-brep/test/models.ts';
import { CadioTessellator, VERSION } from '../src/index.ts';

const dist = path.join(import.meta.dirname, '..', 'dist', 'tess_cadio.wasm');
const skip = fs.existsSync(dist) ? false : 'tess-cadio\'s module not built (run packages/tess-cadio/build.sh module)';
const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8')) as
  { version: string; license: string };

async function tessellator(): Promise<CadioTessellator> {
  const t = new CadioTessellator();
  await t.init();
  return t;
}
const req = (name: keyof typeof MODELS, extra: object = {}) => ({ format: 'cad-brep' as const,
  data: new Uint8Array(MODELS[name]().finish().buffer), linearDeflection: 0.01, angularDeflection: 0.26,
  edges: true, ...extra });
const bytes = (r: TessellationResult) => JSON.stringify([Array.from(r.positions), Array.from(r.normals ?? []),
  Array.from(r.indices), r.faces, r.edges, Array.from(r.edgePositions ?? []), r.diagnostics]);

test('info: the workspace version and the module\'s hash, AGPL-3.0-only, cad-brep only', { skip }, async () => {
  assert.equal(VERSION, pkg.version);
  const t = await tessellator();
  assert.match(t.info.version, new RegExp(`^${pkg.version.replace(/\./g, '\\.')}, wasm [0-9a-f]{12}$`));
  assert.equal(t.info.license, 'AGPL-3.0-only');
  assert.equal(t.info.license, pkg.license);
  assert.deepEqual(t.info.formats, ['cad-brep']);
  await assert.rejects(t.tessellate({ ...req('cube'), format: 'step' }), /isn't taken/);
});

test('closed models: every face meshed, no open edge, every edge shared at its dihedral', { skip }, async () => {
  const t = await tessellator();
  for (const name of ['cube', 'withVoid'] as const) {
    const d = MODELS[name]().finish();
    const r = await t.tessellate(req(name));
    assert.deepEqual(r.diagnostics, [], name);
    assert.ok(r.faces.length > 0 && r.faces.every((f) => f.count > 0), name);
    assert.equal(r.faces.reduce((n, f) => n + f.count, 0), r.indices.length);
    const { open, unjudged } = openEdges(d, r);
    assert.deepEqual(open, [], name);
    assert.deepEqual(unjudged, [], name);
    assert.ok(r.edges!.length > 0 && r.edges!.every((e) => e.kind === 'shared'), name);
    for (const e of r.edges!) assert.ok(Math.abs(e.dihedral! - Math.PI / 2) < 1e-6, `${name}: ${e.dihedral}`);
  }
});

test('the seam cylinder: its seam a seam; a sphere\'s faces: the whole one failed, the hemisphere meshed', { skip },
  async () => {
    const t = await tessellator();
    const c = await t.tessellate(req('seamCylinder'));
    assert.deepEqual(c.diagnostics, []);
    const kinds = c.edges!.map((e) => e.kind).sort();
    assert.deepEqual(kinds, ['free', 'free', 'seam']);
    const s = await t.tessellate(req('spheres'));
    assert.equal(s.faces.length, 2);
    assert.equal(s.faces[0]!.count, 0);
    assert.ok(s.faces[1]!.count > 0);
    assert.ok(s.diagnostics.some((x) => x.severity === 'error' && /^1 faces failed to mesh/.test(x.message)),
      JSON.stringify(s.diagnostics));
    for (const r of [c, s]) {
      for (let i = 0; i < r.normals!.length; i += 3) {
        const n = Math.hypot(r.normals![i]!, r.normals![i + 1]!, r.normals![i + 2]!);
        assert.ok(Math.abs(n - 1) < 1e-6, `normal ${i / 3}: ${n}`);
      }
    }
  });

test('the origin subtracted in double precision; without edges, none', { skip }, async () => {
  const t = await tessellator();
  const a = await t.tessellate(req('cube'));
  const b = await t.tessellate(req('cube', { origin: [0.5, -1, 2], edges: false }));
  assert.equal(b.edges, undefined);
  assert.deepEqual(b.origin, [0.5, -1, 2]);
  assert.equal(a.positions.length, b.positions.length);
  const o = [0.5, -1, 2];
  for (let i = 0; i < a.positions.length; i++) {
    assert.ok(Math.abs(b.positions[i]! - (a.positions[i]! - o[i % 3]!)) <= 1e-6, `coordinate ${i}`);
  }
});

test('the same part gives the same bytes: twice in one instance, and in a fresh one', { skip }, async () => {
  const t = await tessellator(), u = await tessellator();
  for (const name of ['cube', 'seamCylinder', 'spheres'] as const) {
    const a = bytes(await t.tessellate(req(name))), b = bytes(await t.tessellate(req(name)));
    const c = bytes(await u.tessellate(req(name)));
    assert.equal(a, b, name);
    assert.equal(a, c, name);
  }
});

test('bytes that aren\'t a model: an error, no triangles', { skip }, async () => {
  const t = await tessellator();
  const r = await t.tessellate({ ...req('cube'), data: new Uint8Array(64) });
  assert.equal(r.indices.length, 0);
  assert.match(r.diagnostics[0]!.message, /not a cad-brep model/);
});
