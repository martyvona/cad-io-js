import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const occt = await require('occt-import-js')();
const SKIP = /trj2_as1-id-203\.stp\.absr\.891/;
const tmp = '/tmp/claude-501/-Users-vona-src-mine-step-js/620b3b72-2774-449e-bba9-07ee4df84f1e/scratchpad';
const triArea = (P, a, b, c) => { const u = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], v = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]]; return 0.5 * Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]); };
const ratios = [];
for (const dir of process.argv.slice(2)) for (const f of fs.readdirSync(dir).filter((f) => f.includes('.absr+wrap.')).sort()) {
  const bare = f.replace('.absr+wrap.', '.absr.');
  if (SKIP.test(bare)) continue;
  const r = occt.ReadStepFile(fs.readFileSync(path.join(dir, f)), { linearDeflectionType: 'absolute_value', linearDeflection: 0.05, angularDeflection: 0.5 });
  if (!r.success) continue;
  let ao = 0; for (const m of r.meshes) { const P = m.attributes.position.array, I = m.index.array; for (let t = 0; t < I.length; t += 3) ao += triArea(P, 3 * I[t], 3 * I[t + 1], 3 * I[t + 2]); }
  const sp = spawnSync(process.env.BIN ?? 'truck_spike/target/release/truck_spike', ['0.05', '1', tmp, path.join(dir, f)], { timeout: 30000, encoding: 'utf8' });
  if (!sp.stdout.includes('\tok\t')) continue;
  const j = JSON.parse(fs.readFileSync(path.join(tmp, f + '.truck.json'), 'utf8'));
  let at = 0; for (const sh of j.shells) for (const fc of sh.faces) { const P = fc.positions; for (let i = 0; i < P.length; i += 9) at += triArea(P, i, i + 3, i + 6); }
  // truck is in file units, OCCT in mm: normalise inch (645.16) / cm (100) / m files
  let ratio = at / ao; for (const s of [645.16, 100, 1e6]) if (Math.abs(Math.log(ratio * s)) < Math.abs(Math.log(ratio))) ratio *= s;
  ratios.push({ f, ratio });
}
if (process.env.OUT) fs.writeFileSync(process.env.OUT, JSON.stringify(Object.fromEntries(ratios.map((x) => [x.f, x.ratio]))));
ratios.sort((a, b) => Math.abs(Math.log(b.ratio)) - Math.abs(Math.log(a.ratio)));
const within = (e) => ratios.filter((x) => Math.abs(x.ratio - 1) < e).length;
console.log(`parts ${ratios.length}: |truck/occt area - 1| < 0.1%: ${within(0.001)}, < 1%: ${within(0.01)}, < 5%: ${within(0.05)}`);
console.log('worst:', ratios.slice(0, 8).map((x) => `${x.f.replace('.absr+wrap', '')} ${x.ratio.toFixed(3)}`).join('\n       '));
