import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { indexP21, closure, hasType, typeOf, attrText } from './p21.mjs';
const [origF, sub] = process.argv.slice(2);
const idx = indexP21(fs.readFileSync(origF));
const d = os.tmpdir();
spawnSync('truck_spike/target/release/truck_spike', ['0.05', '1', d, sub]);
const res = JSON.parse(fs.readFileSync(`${d}/${sub.split('/').pop()}.truck.json`, 'utf8'));
const pt = (id) => { const m = /\(([^()]*)\)\s*$/.exec(attrText(idx, idx.ents.get(id))); return m[1].split(',').map(Number); };
const faces = res.shells.flatMap((s) => s.faces);
const dist = (P, q) => { let b = Infinity; for (let i = 0; i < P.length; i += 3) b = Math.min(b, Math.hypot(P[i] - q[0], P[i + 1] - q[1], P[i + 2] - q[2])); return b; };
let shown = 0;
for (const f of faces) {
  if (f.id == null || !f.positions.length) continue;
  const fe = idx.ents.get(f.id);
  const vps = [...closure(idx, fe.refs.slice(0, -1))].map((id) => idx.ents.get(id)).filter((e) => hasType(e, 'VERTEX_POINT')).map((e) => pt(e.refs[0]));
  const own = Math.max(...vps.map((q) => dist(f.positions, q)));
  if (own < 1e-3) continue;
  let best = Infinity, bid = null; for (const g of faces) { if (g === f || !g.positions.length) continue; const x = Math.max(...vps.map((q) => dist(g.positions, q))); if (x < best) { best = x; bid = g.id; } }
  if (shown++ < 8) console.log('#' + f.id, typeOf(idx.ents.get(fe.refs.at(-1))), 'nVerts', vps.length, 'tris', f.tris, 'ownMaxDist', own.toExponential(2), 'bestOther', best.toExponential(2), '#' + bid);
}
