// Per-part area: custom OCCT 8.1 build (reference) vs truck vs monstertruck, all in file units, bare subsets.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import occtTess from './occt_tess/final_Os.mjs';
const M = await occtTess();
const tmp = os.tmpdir();
const triArea = (P, a, b, c) => { const u = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], v = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]]; return 0.5 * Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]); };
function occtArea(buf, root) {
  const p = M._malloc(buf.length); M.HEAPU8.set(buf, p);
  const rc = M._occt_tessellate(p, buf.length, root, 0.05, 0.5, 0); M._free(p);
  if (rc) return null;
  const P = M.HEAPF32.subarray(M._occt_positions() / 4), I = M.HEAPU32.subarray(M._occt_indices() / 4, M._occt_indices() / 4 + M._occt_num_indices());
  let a = 0; for (let k = 0; k < I.length; k += 3) a += triArea(P, 3 * I[k], 3 * I[k + 1], 3 * I[k + 2]);
  M._occt_free(); return a;
}
function rustArea(bin, file) {
  const r = spawnSync(bin, ['0.05', '1', tmp, file], { timeout: 30000, encoding: 'utf8' });
  if (!r.stdout?.includes('\tok\t')) return null;
  const jf = path.join(tmp, path.basename(file) + '.truck.json');
  const j = JSON.parse(fs.readFileSync(jf, 'utf8')); fs.rmSync(jf);
  let a = 0; for (const sh of j.shells) for (const fc of sh.faces) { const P = fc.positions; for (let i = 0; i < P.length; i += 9) a += triArea(P, i, i + 3, i + 6); }
  return a;
}
const rows = [];
for (const dir of process.argv.slice(2)) for (const f of fs.readdirSync(dir).filter((f) => /\.absr\.\d+\.stp$/.test(f)).sort()) {
  const file = path.join(dir, f), root = +f.match(/\.absr\.(\d+)\.stp$/)[1];
  const ref = occtArea(fs.readFileSync(file), root);
  const t = /trj2_as1-id-203\.stp\.absr\.891\./.test(f) ? null : rustArea('truck_spike/target/release/truck_spike', file);
  const m = /bicycle\.stp\.absr\.2016\./.test(f) ? null : rustArea('mtruck_spike/target/release/mtruck_spike', file);
  rows.push({ f, ref, truck: t && ref ? t / ref : null, mtruck: m && ref ? m / ref : null });
}
fs.writeFileSync('area3.json', JSON.stringify(rows, null, 1));
for (const k of ['truck', 'mtruck']) {
  const r = rows.map((x) => x[k]);
  const w = (e) => r.filter((x) => x != null && Math.abs(x - 1) < e).length;
  console.log(`${k}: parts ${rows.length}, failed ${r.filter((x) => x == null).length}, within 0.1% ${w(0.001)}, 1% ${w(0.01)}, 5% ${w(0.05)}`);
}
const bad = (x) => x == null || Math.abs(x - 1) >= 0.01;
console.log('mtruck fixes', rows.filter((x) => bad(x.truck) && !bad(x.mtruck)).length, 'mtruck regresses', rows.filter((x) => !bad(x.truck) && bad(x.mtruck)).length, 'bad in both', rows.filter((x) => bad(x.truck) && bad(x.mtruck)).length);
console.log('worst truck:', rows.filter((x) => bad(x.truck)).sort((a, b) => Math.abs(Math.log(b.truck ?? 1e9)) - Math.abs(Math.log(a.truck ?? 1e9))).slice(0, 6).map((x) => `${x.f.replace('.absr', '')} ${x.truck?.toFixed(3)}`).join(', '));
console.log('worst mtruck:', rows.filter((x) => bad(x.mtruck)).sort((a, b) => Math.abs(Math.log(b.mtruck ?? 1e9)) - Math.abs(Math.log(a.mtruck ?? 1e9))).slice(0, 6).map((x) => `${x.f.replace('.absr', '')} ${x.mtruck?.toFixed(3)}`).join(', '));
