// write bare + wrapped subsets for every solid-bearing shape representation of a file
import fs from 'node:fs';
import path from 'node:path';
import { indexP21, closure, emitSubset, hasType } from './p21.mjs';
const [f, outDir] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const idx = indexP21(fs.readFileSync(f));
const SOLIDISH = ['MANIFOLD_SOLID_BREP', 'BREP_WITH_VOIDS', 'SHELL_BASED_SURFACE_MODEL', 'FACETED_BREP'];
const reps = idx.order.map((id) => idx.ents.get(id)).filter((e) => e.types.some((t) => /SHAPE_REPRESENTATION$/.test(t)) && e.refs.some((r) => idx.ents.get(r) && SOLIDISH.some((t) => hasType(idx.ents.get(r), t))));
let maxId = idx.order.reduce((a, x) => Math.max(a, x), 0);
for (const rep of reps) {
  const ids = closure(idx, [rep.id]);
  let b = maxId + 1; const id = () => '#' + b++;
  const [ac, pc, p, pdf, pdc, pd, pds, sdr] = Array.from({ length: 8 }, id);
  const wrap = [`${ac}=APPLICATION_CONTEXT('');`, `${pc}=PRODUCT_CONTEXT('',${ac},'mechanical');`, `${p}=PRODUCT('part','part','',(${pc}));`, `${pdf}=PRODUCT_DEFINITION_FORMATION('','',${p});`, `${pdc}=PRODUCT_DEFINITION_CONTEXT('part definition',${ac},'design');`, `${pd}=PRODUCT_DEFINITION('design','',${pdf},${pdc});`, `${pds}=PRODUCT_DEFINITION_SHAPE('','',${pd});`, `${sdr}=SHAPE_DEFINITION_REPRESENTATION(${pds},#${rep.id});`];
  const base = path.basename(f);
  fs.writeFileSync(path.join(outDir, `${base}.absr.${rep.id}.stp`), emitSubset(idx, ids));
  fs.writeFileSync(path.join(outDir, `${base}.absr+wrap.${rep.id}.stp`), emitSubset(idx, ids, wrap));
}
console.log(reps.length, 'reps');
