// CadioTessellator on cad-brep's test models through the WebAssembly module (build.sh module; skipped where it isn't
// built): the result's shape as cad-scene's other backends give it, closed where the model is (cad-scene's
// openEdges), faces cad-geom can't mesh reported, positions minus the origin, normals finite and unit, the same bytes
// twice in one instance and in fresh ones.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { openEdges, oracleMeasures, type TessellationResult } from 'cad-scene';
import { MODELS } from '../../cad-brep/test/models.ts';
import { CadioTessellator, VERSION } from '../src/index.ts';
import { bsplineDome, fold, halfCap, pcurveOnly } from '../native/test/models.ts';

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
/** Each face range's triangles' area, by its id. */
function areas(r: TessellationResult): Map<number | null, number> {
  const out = new Map<number | null, number>(), p = r.positions;
  for (const f of r.faces) {
    let a = 0;
    for (let t = f.start; t < f.start + f.count; t += 3) {
      const [i, j, k] = [r.indices[t]! * 3, r.indices[t + 1]! * 3, r.indices[t + 2]! * 3];
      const u = [p[j]! - p[i]!, p[j + 1]! - p[i + 1]!, p[j + 2]! - p[i + 2]!];
      const v = [p[k]! - p[i]!, p[k + 1]! - p[i + 1]!, p[k + 2]! - p[i + 2]!];
      a += 0.5 * Math.hypot(u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!,
        u[0]! * v[1]! - u[1]! * v[0]!);
    }
    out.set(f.entityId, (out.get(f.entityId) ?? 0) + a);
  }
  return out;
}
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

test('closed models: every face meshed to its area, no open edge, every edge shared at its dihedral', { skip },
  async () => {
  const t = await tessellator();
  // (reversedUses: faces built inside out and used reversed, their sense false.)
  for (const name of ['cube', 'withVoid', 'reversedUses'] as const) {
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
    // Each face's triangles' area its own, by cad-scene's area oracle (planes: exact).
    const got = areas(r);
    for (const o of oracleMeasures(d)) assert.ok(Math.abs(got.get(o.entityId)! - o.area) < 1e-6 * o.area, name);
  }
});

test('a fold of two planes, one built facing down with its sense false: both up, the dihedral 45 degrees', { skip },
  async () => {
    const t = await tessellator();
    const r = await t.tessellate({ ...req('cube'), data: new Uint8Array(fold().finish().buffer) });
    assert.deepEqual(r.diagnostics, []);
    const shared = r.edges!.filter((e) => e.kind === 'shared');
    assert.equal(shared.length, 1);
    assert.ok(Math.abs(shared[0]!.dihedral! - Math.PI / 4) < 1e-6, String(shared[0]!.dihedral));
    // Both faces' normals up (+z component), as their senses say.
    for (let i = 2; i < r.normals!.length; i += 3) assert.ok(r.normals![i]! > 0.5);
  });

test('a model without ids: faces and edges with null entityIds, still meshed', { skip }, async () => {
  const t = await tessellator();
  const r = await t.tessellate(req('withoutIds'));
  assert.ok(r.faces.some((f) => f.entityId === null && f.count > 0));
  assert.ok(r.faces.some((f) => f.entityId !== null && f.count > 0));
  assert.ok(r.edges!.some((e) => e.entityId === null));
  assert.ok(!r.faces.some((f) => f.entityId === 0) && !r.edges!.some((e) => e.entityId === 0));
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

test('triangles still refused counted, those in a pole\'s fan apart: half a cap through its pole, a cylinder\'s',
  { skip }, async () => {
    const t = await tessellator();
    const re = /^(\d+) faces meshed with triangles their criteria still refuse: (\d+) triangles, (\d+) of them slivers/;
    const refused = async (model: { finish(): { buffer: ArrayBuffer } }, l: number, a: number) => {
      const r = await t.tessellate({ ...req('cube'), data: new Uint8Array(model.finish().buffer),
        linearDeflection: l, angularDeflection: a });
      return r.diagnostics.map((x) => re.exec(x.message)).find((m) => m);
    };
    // halfCap at 0.01 mm and 0.05 rad: its refused triangles partly at its pole; pcurveOnly's (a cylinder's) at
    // 0.001 mm and 0.1 rad, none at one.
    const c = await refused(halfCap(), 0.01, 0.05);
    assert.ok(c);
    assert.equal(c[1], '1');
    assert.ok(Number(c[3]) >= 1 && Number(c[3]) < Number(c[2]), `${c[2]} refused, ${c[3]} at a pole`);
    const o = await refused(pcurveOnly(), 0.001, 0.1);
    assert.ok(o);
    assert.ok(Number(o[2]) >= 1);
    assert.equal(o[3], '0');
  });

test('faces whose deviation accept() sampled, not bounded, said: a B-spline\'s; a cylinder\'s and a sphere\'s bounded',
  { skip }, async () => {
    const t = await tessellator();
    const re = /^(\d+) faces meshed with their deviation from the surface sampled, not bounded/;
    const sampled = async (data: Uint8Array) => {
      const r = await t.tessellate({ ...req('cube'), data });
      return r.diagnostics.map((x) => re.exec(x.message)).find((m) => m)?.[1];
    };
    assert.equal(await sampled(new Uint8Array(bsplineDome().finish().buffer)), '1');
    assert.equal(await sampled(new Uint8Array(MODELS.seamCylinder().finish().buffer)), undefined);
    assert.equal(await sampled(new Uint8Array(MODELS.spheres().finish().buffer)), undefined);
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
