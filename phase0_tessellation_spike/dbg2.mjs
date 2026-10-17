import fs from 'node:fs';
import { createRequire } from 'node:module';
import { indexP21, closure, typeOf, hasType, attrText } from './p21.mjs';
const require = createRequire(import.meta.url);
const [orig, sub, root, scale] = process.argv.slice(2);
const idx = indexP21(fs.readFileSync(orig));
const occt = await require('occt-import-js')();
const r = occt.ReadStepFile(fs.readFileSync(sub), { linearDeflectionType: 'absolute_value', linearDeflection: 0.05 });
const faces = [];
const walk = (id) => { const x = idx.ents.get(id); const t = typeOf(x); if (/FACE_SURFACE|ADVANCED_FACE/.test(t)) return faces.push(id); if (/SHELL|BREP|SURFACE_MODEL|SHAPE_REPRESENTATION/.test(t)) x.refs.forEach(walk); };
walk(+root);
const pt = (id) => { const m = /\(([^()]*)\)\s*$/.exec(attrText(idx, idx.ents.get(id))); return m[1].split(',').map(Number); };
const m = r.meshes[0], p = m.attributes.position.array, ix = m.index.array;
console.log('faces', faces.length, 'types', [...new Set(faces.map((f) => typeOf(idx.ents.get(f))))]);
for (let i = 0; i < 6; i++) {
  const f = idx.ents.get(faces[i]); const bf = m.brep_faces[i];
  const vps = [...closure(idx, f.refs.slice(0, -1))].map((id) => idx.ents.get(id)).filter((e) => hasType(e, 'VERTEX_POINT')).map((e) => pt(e.refs[0]).map((x) => x * scale));
  const vs = new Set(); for (let t = bf.first; t <= bf.last; t++) for (let v = 0; v < 3; v++) vs.add(ix[3 * t + v]);
  const dists = vps.map((q) => Math.min(...[...vs].map((v) => Math.hypot(p[3 * v] - q[0], p[3 * v + 1] - q[1], p[3 * v + 2] - q[2]))));
  // which occt face is closest to vertex 0?
  console.log(i, '#' + faces[i], typeOf(idx.ents.get(f.refs.at(-1))), 'min dists', dists.map((d) => d.toExponential(1)).join(' '));
}
// full permutation search
const occF = m.brep_faces.map((bf) => { const vs = new Set(); for (let t = bf.first; t <= bf.last; t++) for (let v = 0; v < 3; v++) vs.add(ix[3 * t + v]); return [...vs]; });
const map = faces.map((fid) => {
  const f = idx.ents.get(fid);
  const vps = [...closure(idx, f.refs.slice(0, -1))].map((id) => idx.ents.get(id)).filter((e) => hasType(e, 'VERTEX_POINT')).map((e) => pt(e.refs[0]).map((x) => x * scale));
  let best = -1, bd = Infinity;
  occF.forEach((vs, j) => { const d = Math.max(...vps.map((q) => Math.min(...vs.map((v) => Math.hypot(p[3 * v] - q[0], p[3 * v + 1] - q[1], p[3 * v + 2] - q[2]))))); if (d < bd) { bd = d; best = j; } });
  return `${best}(${bd.toExponential(0)})`;
});
console.log('step face i -> occt face:', map.join(' '));
