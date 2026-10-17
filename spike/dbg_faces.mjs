import fs from 'node:fs';
import { createRequire } from 'node:module';
import { indexP21, typeOf, attrText } from './p21.mjs';
const require = createRequire(import.meta.url);
const [orig, sub, root] = process.argv.slice(2);
const idx = indexP21(fs.readFileSync(orig));
const occt = await require('occt-import-js')();
const r = occt.ReadStepFile(fs.readFileSync(sub), null);
const e = (id) => idx.ents.get(id);
// walk root -> solid -> shell -> faces
const faces = [];
const walk = (id, d = 0) => { const x = e(id); const t = typeOf(x); if (t === 'ADVANCED_FACE' || t === 'FACE_SURFACE') { faces.push(id); return; } if (/SHELL|BREP|SURFACE_MODEL|SHAPE_REPRESENTATION/.test(t)) { console.log(' '.repeat(d) + '#' + id + ' ' + t + ' ' + x.refs.length + ' refs'); x.refs.forEach((q) => walk(q, d + 1)); } };
walk(+root);
const m = r.meshes[0];
const p = m.attributes.position.array, ix = m.index.array;
faces.forEach((fid, i) => {
  const f = e(fid); const s = e(f.refs.at(-1));
  const bf = m.brep_faces[i];
  // centroid of occt face i
  let c = [0, 0, 0], k = 0; for (let t = bf.first; t <= bf.last; t++) for (let v = 0; v < 3; v++) { const q = ix[3 * t + v] * 3; c[0] += p[q]; c[1] += p[q + 1]; c[2] += p[q + 2]; k++; }
  console.log(i, '#' + fid, typeOf(s), attrText(idx, f).slice(-4), 'occt tris', bf.last - bf.first + 1, 'centroid', c.map((x) => (x / k).toFixed(1)).join(','));
});
