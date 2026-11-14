// Lengths in millimetres over the corpus: every file imported as it is and again with its length unit changed in its
// text (millimetres to centimetres, else centimetres to millimetres, else metres to kilometres: the same numbers, every
// length then k = 10, 0.1 or 1000 times as long), and the two scenes compared against an oracle of their own
// (packages/step-import/test/unit-oracle.ts, written from docs/brep-reference.md's list of what's a length, not from
// step-import): in every B-rep model each real times k where it's a length, the same where it isn't (directions,
// angles, knots, weights, parameters), a p-curve's coordinates times its surface's factors (k on a length parameter: a
// plane's u and v, a cylinder's and cone's v; a 2D line by its direction times its magnitude); ints and ids the same (a
// length within 1e-12 of the model's size, though not its own last bits, counted apart: rounding in values the builder
// computes). And the scene: parts' origins and vertex boxes times k, placements' translations times k and their linear
// parts the same, tessellated meshes' positions times k (to float32), the source unit times k. A model whose rows
// differ in number is said (a 2D curve used on surfaces that scale apart is a row per scale). PLANT=pcurve undoes the
// scaling of one plane p-curve's coordinates in about every 10th part's scaled model, PLANT=translation one placement's
// translation, PLANT=knots scales one B-spline's knots; each must be seen.
// Usage: node --max-old-space-size=12000 corpus_checks/unit_scale.ts [file-list.txt] [max MB]
import fs from 'node:fs';
import { type BrepData, CURVE_KIND, LOOP_KIND, openBrep, rowCount, SURFACE_KIND }
  from '../packages/cad-brep/src/index.ts';
import { partInstances, type Scene } from '../packages/cad-scene/src/index.ts';
import { compareScaled } from '../packages/step-import/test/unit-oracle.ts';
import { importStep } from '../packages/step-import/src/index.ts';
import { corpusFiles, plantedPart, shortName } from './corpus.ts';
import { hostLine } from '../scripts/host.ts';

console.log(await hostLine());

const maxMB = Number(process.argv[3] ?? 1000);
const plant = process.env.PLANT;
const EXAMPLES = 4;
const tally = new Map<string, { n: number; ex: string[] }>();
const note = (k: string, ex: string, n = 1) => {
  const t = tally.get(k) ?? { n: 0, ex: [] };
  t.n += n;
  if (t.ex.length < EXAMPLES) t.ex.push(ex);
  tally.set(k, t);
};
let files = 0, changed = 0, parts = 0, partsSame = 0, realsChecked = 0, planted = 0, plantedSeen = 0;
const factors = new Map<number, number>();

/** The file's text with its length unit changed, and the factor every length takes; undefined if none found. */
function rescaled(text: string): { text: string; k: number } | undefined {
  const si = (prefix: string) => new RegExp(`SI_UNIT\\s*\\(\\s*${prefix}\\s*,\\s*\\.METRE\\.\\s*\\)`, 'g');
  for (const [from, to, k] of [['\\.MILLI\\.', '.CENTI.', 10], ['\\.CENTI\\.', '.MILLI.', 0.1],
    ['\\$', '.KILO.', 1000]] as const) {
    if (si(from).test(text)) return { text: text.replace(si(from), `SI_UNIT(${to},.METRE.)`), k };
  }
  return undefined;
}

/** The scenes: the same parts, origins, boxes and meshes times k, placements' translations times k. */
function compareScenes(a: Scene, b: Scene, k: number, name: string, plantHere: (i: number) => boolean,
  partK: (i: number) => number, mixed: boolean) {
  const near = (x: number, y: number, eps = 1e-12) => Math.abs(x - y) <= eps * Math.max(Math.abs(x), Math.abs(y),
    1e-300);
  const kFile = k;
  if (a.parts.length !== b.parts.length) { note('parts differ in number', name); return; }
  // (A file of several length units, some not changed: its placements join representations scaled apart, and its
  // source unit may be one not changed; both left out. A file without parts whose top has no unit: millimetres.)
  const mmBoth = !a.parts.length && (a.sourceUnit ?? 1) === 1 && (b.sourceUnit ?? 1) === 1;
  if (mixed) note('files of several length units, some not changed: placements and the source unit not checked', name);
  else if (!mmBoth && !near((a.sourceUnit ?? 1) * k, b.sourceUnit ?? 1)) note('source unit not times k', name);
  a.parts.forEach((p, i) => {
    const q = b.parts[i]!, where = `${name} #${p.sources[0]?.id}`;
    // Its own representation's factor (one without a length unit, read as millimetres, isn't changed).
    const k = partK(i);
    if (Math.abs(k - kFile) > 1e-9 * kFile) {
      note(`parts whose factor isn't the file's (a representation's unit not the one changed)`, where);
    }
    parts++;
    // Origins and boxes to 1e-12 of the part's size (a centre near 0 is a difference of large numbers).
    const box = p.brep?.vertexBox, qbox = q.brep?.vertexBox;
    const size = Math.max(1e-300, ...(box ? [...box.min, ...box.max].map(Math.abs) : []), ...p.origin.map(Math.abs));
    const close = (x: number, y: number) => Math.abs(x * k - y) <= 1e-12 * size * k;
    if (!p.origin.every((x, j) => close(x, q.origin[j]!))) note('origin not times k', where);
    if (box && qbox && ![...box.min, ...box.max].every((x, j) => close(x, [...qbox.min, ...qbox.max][j]!))) {
      note('vertex box not times k', where);
    }
    for (const [l, lod] of p.lods.entries()) {
      const m = lod.mesh, n = q.lods[l]?.mesh;
      if (!n || n.positions.length !== m.positions.length) { note('a level differs', where); continue; }
      // Positions are float32 of (point - origin): to float32's precision of the larger.
      const tol = 2 ** -22;
      if (!m.positions.every((x, j) => Math.abs(x * k - n.positions[j]!) <= tol * Math.max(Math.abs(x * k), 1e-3 * k,
        Math.hypot(...m.origin) * k * 1e-7))) note('a source mesh\'s positions not times k', where);
    }
    const ma = p.brep?.model, mb = q.brep?.model;
    if (!ma || !mb) return;
    let b2 = mb;
    const isPlanted = plant !== undefined && plantHere(i);
    if (isPlanted) {
      const c = openBrep(mb.buffer.slice(0));
      if (plantIn(c, k)) { b2 = c; planted++; }
    }
    const { ok: same, checked } = compareScaled(ma, b2, k, where, note);
    realsChecked += checked;
    if (same) partsSame++;
    if (b2 !== mb && !same) plantedSeen++;
  });
  // Placements: by instance, in order.
  if (mixed) return;
  const ia = [...partInstances(a)], ib = [...partInstances(b)];
  if (ia.length !== ib.length) { note('placements differ in number', name); return; }
  let plantedPlacement = plant === 'translation' && ia.length > 0 && plantedPart(name);
  // Translations to 1e-12 of the largest (one that should be 0 is rounding of composed placements), the rest to 1e-9.
  const size = Math.max(1e-300, ...ia.flatMap((x) => [12, 13, 14].map((c) => Math.abs(x.transform[c]!))));
  ia.forEach((x, j) => {
    const t = ib[j]!.transform.slice();
    if (plantedPlacement) { t[12] = t[12]! + 1; plantedPlacement = false; planted++; }
    const ok = [...Array(16).keys()].every((c) => c >= 12 && c < 15
      ? Math.abs(x.transform[c]! * k - t[c]!) <= 1e-12 * size * k
      : near(x.transform[c]!, t[c]!, 1e-9) || (Math.abs(x.transform[c]!) < 1e-12 && Math.abs(t[c]!) < 1e-12));
    if (!ok) {
      if (t !== ib[j]!.transform && t[12] !== ib[j]!.transform[12]) plantedSeen++;
      else note('a placement not as the oracle says (translation times k, the rest the same)', `${name} ${j}`);
    }
  });
}

/** PLANT: one defect in a copy of a scaled model; whether it found something to plant. */
function plantIn(d: BrepData, k: number): boolean {
  if (plant === 'pcurve') {
    for (let fc = 0; fc < rowCount(d, 'face'); fc++) {
      if (d.surface.kind[d.face.surface[fc]!] !== SURFACE_KIND.plane) continue;
      for (let l = d.face.firstLoop[fc]!; l < d.face.firstLoop[fc]! + d.face.loopCount[fc]!; l++) {
        if (d.loop.kind[l] !== LOOP_KIND.edge) continue;
        for (let c = d.loop.first[l]!; c < d.loop.first[l]! + d.loop.count[l]!; c++) {
          // (A coordinate that isn't 0: scaling 0 changes nothing.)
          const p = d.coedge.pcurve[c]!, at = p < 0 ? -1 : d.curve.real[p]!;
          if (p < 0 || d.curve.kind[p] !== CURVE_KIND.line) continue;
          const j = [at, at + 1].find((x) => d.pool.curveReal[x] !== 0);
          if (j === undefined) continue;
          d.pool.curveReal[j]! /= k;
          return true;
        }
      }
    }
  }
  if (plant === 'knots') {
    for (let c = 0; c < rowCount(d, 'curve'); c++) {
      if (d.curve.kind[c] !== CURVE_KIND.bspline) continue;
      const at = d.curve.real[c]!, n = d.pool.curveInt[d.curve.int[c]! + 2]!;
      const j = [...Array(n).keys()].map((x) => at + x).find((x) => d.pool.curveReal[x] !== 0);
      if (j === undefined) continue;
      d.pool.curveReal[j]! *= k;
      return true;
    }
  }
  return false;
}

for (const f of corpusFiles(process.argv[2])) {
  if (fs.statSync(f).size > maxMB * 1e6) continue;
  const name = shortName(f);
  process.stderr.write(`${files + 1} ${name}\n`);
  files++;
  const bytes = fs.readFileSync(f);
  const r = rescaled(bytes.toString('latin1'));
  if (!r) { note('no SI length unit found to change (file left out)', name); continue; }
  changed++;
  factors.set(r.k, (factors.get(r.k) ?? 0) + 1);
  try {
    const ia = await importStep(new Uint8Array(bytes));
    const ib = await importStep(new Uint8Array(Buffer.from(r.text, 'latin1')));
    const a = ia.scene, b = ib.scene;
    // Each part's factor: its representation's length unit after over before (1 where it has none).
    const unitOf = (x: typeof ia, id: number) => x.semantics.structure.representations.get(id)?.context?.lengthUnit
      ?.factor ?? 1e-3;
    const partK = (i: number) => { const id = a.parts[i]!.sources[0]!.id; return unitOf(ib, id) / unitOf(ia, id); };
    const mixed = [...ia.semantics.structure.representations.keys()].some((id) =>
      ia.semantics.structure.representations.get(id)?.context?.lengthUnit !== undefined
      && Math.abs(unitOf(ib, id) / unitOf(ia, id) - r.k) > 1e-9 * r.k);
    compareScenes(a, b, r.k, name, (i) => plantedPart(`${name} #${a.parts[i]!.sources[0]?.id}`), partK, mixed);
  } catch (e) {
    note('failed', `${name}: ${(e as Error).message.split('\n')[0]}`);
  }
}

console.log(`${files} files, ${changed} with a length unit changed (${[...factors].map(([k, n]) => `x ${k}: ${n}`)
  .join(', ')}); ${parts} parts, ${partsSame} B-rep models as the oracle says; ${realsChecked} reals checked`);
if (plant) console.log(`PLANT=${plant}: ${planted} planted, ${plantedSeen} seen`);
for (const [k, v] of [...tally].sort((x, y) => y[1].n - x[1].n)) {
  console.log(`${String(v.n).padStart(7)}  ${k}`);
  for (const ex of v.ex) console.log(`           ${ex}`);
}
