// The builder's baking of transforms (docs/brep-reference.md) against OCCT, over the corpus: each part's model baked at
// three similarities (a mirror; a turn, a scale of 2.5 and a move; a mirror, a turn and a scale of 0.3), each meshed by
// our OCCT backend (the native route) and compared, face by face, with OCCT's mesh of the model as it is, mapped by the
// transform: OCCT's measured area times s^2 (within 1e-6, its own precision), validity, the mesh's area-weighted mean
// normal times Q and centroid through T, whether both meshed it. Faces of loose geometry are counted apart: OCCT
// ignores a loose face's sense, and a loose surface has none, so a mirror may show them the other way round. OCCT isn't
// scale-invariant, so the scaled transforms' meshes differ a little on some faces (counted). Under the mirror, OCCT's
// own meshing differs on two models, not the bake (whose normals there are Q times the original's at every face): the
// s1 head back (all its exports), where OCCT meshes a sphere face of the model as it is over three times its area and
// turns its shell over, while the mirrored copy meshes as its geometry says; and Checking_Fixture_Clamping.STEP #5594,
// where OCCT meshes two faces short of its own measured area, less short mirrored, and judges two faces' validity by
// handedness. Planted bugs, in about every 10th part's mirror: PLANT=move bakes it 1% of its size off, PLANT=scale at a
// scale 0.1% off; each must be seen. (A face turned over in a shell isn't: OCCT's healing orients closed shells.)
// Usage: node --max-old-space-size=8192 corpus_checks/bake_occt.ts [file-list.txt] [max MB, default 3]
import fs from 'node:fs';
import { BrepBuilder, type BrepData, decode, ITEM_KIND, rowCount } from '../packages/cad-brep/src/index.ts';
import type { TessellationResult } from '../packages/cad-scene/src/index.ts';
import { importStep } from '../packages/step-import/src/index.ts';
import { OcctTessellator } from '../packages/tess-occt/src/index.ts';
import { corpusFiles, plantedPart, shortName } from './corpus.ts';
import { hostLine } from '../scripts/host.ts';

console.log(await hostLine());

const maxMB = Number(process.argv[3] ?? 3);
const plant = process.env.PLANT;
const EXAMPLES = 4;
const tally = new Map<string, { n: number; ex: string[] }>();
const note = (k: string, ex: string) => {
  const t = tally.get(k) ?? { n: 0, ex: [] };
  t.n++;
  if (t.ex.length < EXAMPLES) t.ex.push(ex);
  tally.set(k, t);
};

const rot = (a: number, ax: 'x' | 'z') => {
  const c = Math.cos(a), s = Math.sin(a);
  return ax === 'z' ? [c, s, 0, -s, c, 0, 0, 0, 1] : [1, 0, 0, 0, c, s, 0, -s, c];
};
const mul = (a: number[], b: number[]) => Array.from({ length: 9 }, (_, k) => {
  const i = k % 3, j = (k - i) / 3;
  return a[i]! * b[3 * j]! + a[3 + i]! * b[3 * j + 1]! + a[6 + i]! * b[3 * j + 2]!;
});
const MIRROR = [-1, 0, 0, 0, 1, 0, 0, 0, 1];
const TRANSFORMS: [string, number[]][] = [
  ['mirror', [...MIRROR, 0, 0, 0]],
  ['turn, scale 2.5, move', [...mul(rot(0.7, 'z'), rot(-0.4, 'x')).map((x) => x * 2.5), 30, -12, 7]],
  ['mirror, turn, scale 0.3', [...mul(rot(1.1, 'x'), mul(MIRROR, rot(0.3, 'z'))).map((x) => x * 0.3), -5, 4, 100]],
];

/** The model given to a builder again, its items at `transform` (baked), or as it is. */
function rebuild(d: BrepData, transform?: number[]): { data: BrepData; said: string[] } {
  const b = new BrepBuilder(decode.part(d));
  for (let k = 0; k < rowCount(d, 'curve'); k++) b.addCurve(decode.curve(d, k));
  for (let k = 0; k < rowCount(d, 'surface'); k++) b.addSurface(decode.surface(d, k));
  for (let k = 0; k < rowCount(d, 'vertex'); k++) b.addVertex(decode.vertex(d, k));
  for (let k = 0; k < rowCount(d, 'edge'); k++) b.addEdge(decode.edge(d, k));
  for (let k = 0; k < rowCount(d, 'face'); k++) b.addFace(decode.face(d, k));
  for (let k = 0; k < rowCount(d, 'shell'); k++) b.addShell(decode.shell(d, k));
  for (let k = 0; k < rowCount(d, 'body'); k++) b.addBody(decode.body(d, k));
  for (let k = 0; k < rowCount(d, 'item'); k++) {
    b.addItem({ ...decode.item(d, k), ...(transform ? { transform } : {}) });
  }
  const data = b.finish();
  return { data, said: b.diagnostics.map((x) => `${x.severity}: ${x.message.replace(/#\d+/g, '#')}`) };
}

/** Each meshed face's area, area-weighted mean normal (unnormalized) and centroid (times area). */
function faceStats(r: TessellationResult) {
  const m = new Map<number, { area: number; n: number[]; c: number[] }>();
  const P = (i: number) => [0, 1, 2].map((a) => r.positions[3 * i + a]! + r.origin[a]!);
  for (const f of r.faces) {
    if (f.entityId === null) continue;
    const s = m.get(f.entityId) ?? { area: 0, n: [0, 0, 0], c: [0, 0, 0] };
    for (let t = f.start; t < f.start + f.count; t += 3) {
      const a = P(r.indices[t]!), b = P(r.indices[t + 1]!), c = P(r.indices[t + 2]!);
      const u = [0, 1, 2].map((i) => b[i]! - a[i]!), v = [0, 1, 2].map((i) => c[i]! - a[i]!);
      const n = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
      const ar = Math.hypot(...n) / 2;
      s.area += ar;
      for (let i = 0; i < 3; i++) { s.n[i]! += n[i]! / 2; s.c[i]! += ar * (a[i]! + b[i]! + c[i]!) / 3; }
    }
    m.set(f.entityId, s);
  }
  return m;
}

/** The ids of the model's loose faces: face items', and surface items' (whose faces OCCT gives the surface's id). */
function looseIds(d: BrepData): Set<number> {
  const out = new Set<number>();
  for (let k = 0; k < rowCount(d, 'item'); k++) {
    const kind = d.item.kind[k], ref = d.item.ref[k]!;
    if (kind === ITEM_KIND.face && d.face.id[ref]) out.add(d.face.id[ref]!);
    if (kind === ITEM_KIND.surface && d.surface.id[ref]) out.add(d.surface.id[ref]!);
    if (kind === ITEM_KIND.surface && d.item.id[k]) out.add(d.item.id[k]!);
  }
  return out;
}

const occt = new OcctTessellator();
await occt.init();
let files = 0, parts = 0, faces = 0, planted = 0, plantedSeen = 0;
const LINEAR = 0.05, ANGULAR = 0.3;
for (const f of corpusFiles(process.argv[2])) {
  if (fs.statSync(f).size > maxMB * 1e6) continue;
  const name = shortName(f);
  process.stderr.write(`${++files} ${name}\n`);
  const { scene } = await importStep(new Uint8Array(fs.readFileSync(f)));
  for (const part of scene.parts) {
    const d = part.brep?.model;
    if (!d || !rowCount(d, 'item') || !rowCount(d, 'face')) continue;
    const where = `${name} #${part.sources[0]?.id}`;
    const req = { format: 'cad-brep' as const, angularDeflection: ANGULAR, measures: true };
    let ref: TessellationResult;
    try {
      ref = await occt.tessellate({ ...req, linearDeflection: LINEAR, data: new Uint8Array(rebuild(d).data.buffer) });
    } catch (e) {
      note('the model as it is: OCCT threw (left out)', `${where}: ${(e as Error).message.split('\n')[0]}`);
      continue;
    }
    parts++;
    const loose = looseIds(d);
    const mr = new Map((ref.measures ?? []).map((x) => [x.entityId, x])), sr = faceStats(ref);
    let size = 1;
    for (const s of sr.values()) if (s.area) size = Math.max(size, ...s.c.map((x) => Math.abs(x / s.area)));
    for (const [tn, tr] of TRANSFORMS) {
      const at = `${where} (${tn})`, s = Math.hypot(tr[0]!, tr[1]!, tr[2]!);
      const T = (p: number[]) => [0, 1, 2].map((i) => tr[i]! * p[0]! + tr[3 + i]! * p[1]! + tr[6 + i]! * p[2]!
        + tr[9 + i]!);
      const Q = (p: number[]) => [0, 1, 2].map((i) => (tr[i]! * p[0]! + tr[3 + i]! * p[1]! + tr[6 + i]! * p[2]!) / s);
      const isPlanted = (plant === 'move' || plant === 'scale') && tn === 'mirror' && plantedPart(where);
      const bakeAt = !isPlanted ? tr : plant === 'move' ? tr.map((x, i) => i === 9 ? x + 0.01 * size : x)
        : tr.map((x, i) => i < 9 ? x * 1.001 : x);
      // (In a planted part, anything apart is the plant seen, not noted.)
      let hit = false;
      const say = (k: string, e: string) => { if (isPlanted) hit = true; else note(k, e); };
      const baked = rebuild(d, bakeAt);
      for (const x of baked.said) note(`baking said ${x}`, at);
      const data = baked.data;
      let b: TessellationResult;
      try {
        b = await occt.tessellate({ ...req, linearDeflection: LINEAR * s, data: new Uint8Array(data.buffer) });
      } catch (e) {
        note('baked: OCCT threw', `${at}: ${(e as Error).message.split('\n')[0]}`);
        continue;
      }
      const mb = new Map((b.measures ?? []).map((x) => [x.entityId, x])), sb = faceStats(b);
      for (const [id, x] of mr) {
        faces++;
        const lo = loose.has(id) ? ' (loose geometry)' : '';
        const y = mb.get(id);
        if (!y) { say(`measured on the model as it is only${lo}`, `${at} face #${id}`); continue; }
        if (Math.abs(x.area * s * s - y.area) > 1e-6 * Math.max(y.area, 1e-12) + 1e-12) {
          say(`OCCT's measured area not s^2 times${lo}`, `${at} face #${id}: ${x.area * s * s}, ${y.area}`);
        }
        if (x.valid !== y.valid) say(`validity: ${x.valid}, baked ${y.valid}${lo}`, `${at} face #${id}`);
        const p = sr.get(id), q = sb.get(id);
        if (!p?.area || !q?.area) {
          if (!!p?.area !== !!q?.area) say(`meshed ${p?.area ? 'as it is' : 'baked'} only${lo}`, `${at} face #${id}`);
          continue;
        }
        const want = Q(p.n), dot = (want[0]! * q.n[0]! + want[1]! * q.n[1]! + want[2]! * q.n[2]!)
          / (Math.hypot(...want) * Math.hypot(...q.n) || 1);
        if (Math.hypot(...p.n) > 1e-6 * p.area && dot < 0.99) {
          say(`${dot < -0.9 ? 'facing the other way' : 'mean normals apart'}${lo}`, `${at} face #${id}: ${
            dot.toFixed(4)}`);
        }
        const dc = Math.hypot(...[0, 1, 2].map((i) => T(p.c.map((v) => v / p.area))[i]! - q.c[i]! / q.area));
        if (dc > 1e-3 * s * size) say(`centroids apart${lo}`, `${at} face #${id}: ${dc.toExponential(2)}`);
        if (Math.abs(p.area * s * s - q.area) > 2e-2 * q.area) {
          say(`mesh areas over 2% apart${lo}`, `${at} face #${id}: ${p.area * s * s}, ${q.area}`);
        }
      }
      for (const id of mb.keys()) if (!mr.has(id)) say('measured baked only', `${at} face #${id}`);
      if (isPlanted) { planted++; if (hit) plantedSeen++; else note('a planted part not seen', at); }
    }
  }
}
console.log(`${files} files (up to ${maxMB} MB), ${parts} parts x ${TRANSFORMS.length} transforms, ${faces} faces `
  + 'compared');
if (plant) console.log(`PLANT=${plant}: ${planted} planted, ${plantedSeen} seen`);
for (const [k, v] of [...tally].sort((x, y) => y[1].n - x[1].n)) {
  console.log(`${String(v.n).padStart(7)}  ${k}`);
  for (const ex of v.ex) console.log(`           ${ex}`);
}
process.exit(0);
