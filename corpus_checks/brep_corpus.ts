// The B-rep model from STEP (step-import's brep.ts) over the corpus: every file imported; each B-rep part's model
// checked by validateBrep, its face, edge and vertex ids against the STEP instances of those kinds in the part's
// closure (none lost but what a diagnostic says, none made up), a JSON round trip to the same bytes; the rows tallied
// by kind (to compare with step_geometry.log), the import's B-rep diagnostics by kind; the import's time, and the
// models' size against the STEP subsets' they replace. PLANT=face drops one face from every 10th part's
// model (each must show as a lost face), PLANT=edge points one edge of every 10th part at another vertex (each must
// fail validation).
// Usage: node --max-old-space-size=12000 corpus_checks/brep_corpus.ts [file-list.txt] [max MB]
import fs from 'node:fs';
import { type BrepData, brepFromJson, brepToJson, COLUMNS, CURVE_KIND, decode, ITEM_KIND, LOOP_KIND, openBrep, rowCount,
  SHELL_KIND, SURFACE_KIND, BODY_KIND, validateBrep } from '../packages/cad-brep/src/index.ts';
import { buildSubset, closure, readStep } from '../packages/step-parser/src/index.ts';
import { importStep } from '../packages/step-import/src/index.ts';
import { corpusFiles, shortName } from './corpus.ts';

const maxMB = Number(process.argv[3] ?? 1000);
const plant = process.env.PLANT;
const tally = new Map<string, number>();
const add = (k: string, n = 1) => tally.set(k, (tally.get(k) ?? 0) + n);
const problems = new Map<string, { n: number; ex: string[] }>();
const note = (k: string, ex: string, n = 1) => {
  const p = problems.get(k) ?? { n: 0, ex: [] };
  p.n += n;
  if (p.ex.length < 3) p.ex.push(ex);
  problems.set(k, p);
};
/** A diagnostic as a kind of problem: without its count, its list of ids, its numbers. */
const general = (m: string) => m.replace(/^\d+ x /, '').replace(/ \(#[\d, #.]+\)$/, '').replace(/#\d+/g, '#N')
  .replace(/\b\d+(\.\d+)?(e-?\d+)?\b/g, 'N');
const nameOf = (table: Record<string, number>, n: number) => Object.keys(table).find((k) => table[k] === n) ?? `${n}`;

let files = 0, parts = 0, skipped = 0, plantedParts = 0, plantedCaught = 0;
let importTime = 0, subsetTime = 0, subsetBytes = 0, modelBytes = 0;

/** A copy of a model with a defect planted (PLANT), and whether it was planted. */
function planted(d: BrepData, k: number): BrepData | undefined {
  if (!plant || k % 10) return undefined;
  if (plant === 'face' && rowCount(d, 'face') > 0) {
    const j = brepToJson(d);
    const victim = j.faces.length - 1;
    j.faces.pop();
    for (const s of j.shells) s.faces = s.faces.filter((u) => u.face !== victim);
    j.items = j.items.filter((it) => !(it.kind === 'face' && it.ref === victim));
    return brepFromJson(j);
  }
  if (plant === 'edge' && rowCount(d, 'coedge') > 1 && rowCount(d, 'vertex') > 1) {
    const c = openBrep(d.buffer.slice(0));
    // An edge used in an edge loop of two or more coedges, its start moved to another vertex.
    for (let l = 0; l < rowCount(c, 'loop'); l++) {
      if (c.loop.kind[l] !== LOOP_KIND.edge || c.loop.count[l]! < 2) continue;
      const e = c.coedge.edge[c.loop.first[l]!]!;
      if (c.edge.start[e]! < 0) continue;
      c.edge.start[e] = (c.edge.start[e]! + 1) % rowCount(c, 'vertex');
      if (c.edge.start[e] === c.edge.end[e]) continue;
      return c;
    }
  }
  return undefined;
}

for (const path of corpusFiles(process.argv[2])) {
  if (fs.statSync(path).size > maxMB * 1e6) { skipped++; continue; }
  files++;
  const name = shortName(path);
  process.stderr.write(`${files} ${name}\n`);
  const bytes = new Uint8Array(fs.readFileSync(path));
  const file = await readStep(bytes);
  let t = performance.now();
  const { scene, model } = await importStep(file);
  importTime += performance.now() - t;
  for (const d of scene.diagnostics) {
    if (d.message.startsWith('B-rep model: ')) note(`import ${d.severity}: ${general(d.message.slice(13))}`,
      `${name} #${d.source?.id}`);
  }

  for (const part of scene.parts) {
    const brep = part.brep;
    if (!brep) continue;
    const d = brep.model;
    const repId = part.sources[0]!.id;
    parts++;
    const where = `${name} #${repId}`;
    modelBytes += d.buffer.byteLength;

    const check = planted(d, parts) ?? d;
    const isPlanted = check !== d;
    if (isPlanted) plantedParts++;
    let caught = false;

    for (const x of validateBrep(check)) {
      note(`validate ${x.severity}: ${general(x.message)}`, where);
      if (x.severity === 'error') caught = true;
    }
    // Through JSON objects, the same bytes; through JSON text, the same values (text loses the sign of zero).
    const j = brepToJson(check);
    if (Buffer.compare(Buffer.from(brepFromJson(j).buffer), Buffer.from(check.buffer))) {
      note('JSON round trip changed the bytes', where);
    }
    const text = brepFromJson(JSON.parse(JSON.stringify(j)));
    for (const c of COLUMNS) {
      const a = (check[c.table] as Record<string, ArrayLike<number>>)[c.column]!;
      const b = (text[c.table] as Record<string, ArrayLike<number>>)[c.column]!;
      let same = a.length === b.length;
      for (let i = 0; same && i < a.length; i++) same = a[i] === b[i] || (Number.isNaN(a[i]!) && Number.isNaN(b[i]!));
      if (!same) note('JSON text round trip changed a value', `${where}: ${c.table}.${c.column}`);
    }

    // Ids against the closure's instances of each kind: faces (curve-bounded surfaces too), edge curves (curve-bounded
    // surfaces' edges are their boundaries' segments, counted apart), vertices.
    const root = model.resolve(repId);
    // The importer's closure: the representation's own mapped items left out (what they map is placed apart).
    const exclude = new Set<number>();
    for (const q of closure(model.file, [root])) if (model.isInstanceOf(q, 'MAPPED_ITEM')) exclude.add(q);
    const inClosure = closure(model.file, [root], exclude);
    // The subset this model replaces, for its size.
    t = performance.now();
    subsetBytes += buildSubset(model.file, [root], { exclude }).bytes.length;
    subsetTime += performance.now() - t;
    const want = { face: new Set<number>(), edge: new Set<number>(), vertex: new Set<number>() };
    for (const q of inClosure) {
      const id = model.file.index.ids[q]!;
      if (model.isInstanceOf(q, 'FACE_SURFACE') || model.isInstanceOf(q, 'CURVE_BOUNDED_SURFACE')) want.face.add(id);
      else if (model.isInstanceOf(q, 'EDGE_CURVE')) want.edge.add(id);
      else if (model.isInstanceOf(q, 'VERTEX_POINT')) want.vertex.add(id);
    }
    for (const kind of ['face', 'edge', 'vertex'] as const) {
      const ids = check[kind].id;
      const got = new Set<number>();
      for (let k = 0; k < ids.length; k++) {
        const id = ids[k]!;
        if (!id) { note(`a ${kind} without an id`, where); continue; }
        if (want[kind].has(id)) got.add(id);
        else {
          const q = model.resolve(id);
          if (kind === 'edge' && q >= 0 && model.isInstanceOf(q, 'COMPOSITE_CURVE_SEGMENT')) {
            add('edges from curve-bounded surfaces');
          }
          else note(`a ${kind} whose id isn't a ${kind} of the part's closure`, `${where} -> #${id}`);
        }
      }
      const lost = [...want[kind]].filter((id) => !got.has(id));
      const plural = kind === 'vertex' ? 'vertices' : `${kind}s`;
      if (lost.length) {
        note(`${plural} in the closure not in the model`, `${where} -> #${lost.slice(0, 3).join(', #')}`, lost.length);
        if (kind === 'face') caught = true;
      }
      add(plural, ids.length);
    }
    if (isPlanted && caught) plantedCaught++;

    // Tallies by kind.
    for (let k = 0; k < rowCount(d, 'curve'); k++) {
      add(`curve ${d.curve.dim[k]}D ${nameOf(CURVE_KIND, d.curve.kind[k]!)}`);
      if (d.curve.kind[k] === CURVE_KIND.bspline) {
        const c = decode.curve(d, k);
        if (c.kind === 'bspline' && c.weights) add(`curve ${d.curve.dim[k]}D bspline rational`);
      }
    }
    for (let k = 0; k < rowCount(d, 'surface'); k++) add(`surface ${nameOf(SURFACE_KIND, d.surface.kind[k]!)}`);
    for (let k = 0; k < rowCount(d, 'loop'); k++) add(`loop ${nameOf(LOOP_KIND, d.loop.kind[k]!)}`);
    for (let k = 0; k < rowCount(d, 'shell'); k++) add(`shell ${nameOf(SHELL_KIND, d.shell.kind[k]!)}`);
    for (let k = 0; k < rowCount(d, 'body'); k++) add(`body ${nameOf(BODY_KIND, d.body.kind[k]!)}`);
    for (let k = 0; k < rowCount(d, 'item'); k++) add(`item ${nameOf(ITEM_KIND, d.item.kind[k]!)}`);
    let pc = 0;
    for (let k = 0; k < rowCount(d, 'coedge'); k++) if (d.coedge.pcurve[k]! >= 0) pc++;
    add('coedges', rowCount(d, 'coedge'));
    add('coedges with a p-curve', pc);
    for (let k = 0; k < rowCount(d, 'edge'); k++) if (d.edge.curve[k]! < 0) add('edges without a 3D curve');
  }
}

console.log(`${files} files (${skipped} over ${maxMB} MB skipped), ${parts} B-rep parts`);
console.log(`import ${(importTime / 1000).toFixed(1)} s (the models built); the subsets they replace `
  + `${(subsetTime / 1000).toFixed(1)} s to build`);
console.log(`models ${(modelBytes / 1e6).toFixed(1)} MB, subsets ${(subsetBytes / 1e6).toFixed(1)} MB`);
if (plant) console.log(`PLANT=${plant}: ${plantedParts} parts planted, ${plantedCaught} caught`);
console.log('\n## rows by kind');
for (const [k, n] of [...tally].sort()) console.log(String(n).padStart(9), k);
console.log('\n## problems');
for (const [k, v] of [...problems].sort((a, b) => b[1].n - a[1].n)) {
  console.log(String(v.n).padStart(9), k, ' e.g.', v.ex.join('; '));
}
