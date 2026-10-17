// Run native truck_spike on each subset file (one process each, with timeout) and validate reported face ids:
// every VERTEX_POINT of STEP face `id` must be a vertex of that face's triangles (truck keeps file units).
// usage: node truck_test.mjs <origStepFile> <subsetGlobDir> <prefix>   (subset names: <base>.<variant>.<root>.stp)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { indexP21, closure, hasType, attrText } from './p21.mjs';

const TOL = process.env.TOL ?? '0.05';
const TIMEOUT = +(process.env.TIMEOUT ?? 60000);
const BIN = path.resolve(process.env.BIN ?? 'truck_spike/target/release/truck_spike');
const [dir, filter = ''] = process.argv.slice(2);
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.stp') && f.includes(filter)).sort();
const origCache = new Map();
const ORIG_DIRS = [import.meta.dirname + '/../test_corpus/third_party/nist-pmi-models/NIST-PMI-STEP-Files/NIST-PMI-STEP-Files', import.meta.dirname + '/../test_corpus/third_party/gkv311-opencascade-dataset/step'];
function orig(base) {
  if (!origCache.has(base)) {
    const p = ORIG_DIRS.map((d) => path.join(d, base)).find((p) => fs.existsSync(p));
    origCache.set(base, indexP21(fs.readFileSync(p)));
  }
  return origCache.get(base);
}
const pointOf = (idx, id) => { const m = /\(([^()]*)\)\s*$/.exec(attrText(idx, idx.ents.get(id))); return m[1].split(',').map(Number); };

const tout = fs.mkdtempSync(path.join(os.tmpdir(), 'tout-'));
const summary = { files: 0, ok: 0, panic: 0, timeout: 0, err: 0, faces: 0, facesWithId: 0, facesAgree: 0, facesEmpty: 0, ms: 0, tris: 0 };
const rows = [];
for (const f of files) {
  const base = f.replace(/\.(absr|absr\+wrap|solid|bare)\.\d+\.stp$/, '');
  summary.files++;
  const r = spawnSync(BIN, [TOL, '1', tout, path.join(dir, f)], { timeout: TIMEOUT, encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.error?.code === 'ETIMEDOUT' || r.signal) { summary.timeout++; console.log(`${f}\tTIMEOUT`); rows.push({ f, status: 'timeout' }); continue; }
  const line = r.stdout.trim();
  const status = line.split('\t')[1];
  if (status !== 'ok') { summary[status === 'panic' ? 'panic' : 'err']++; const why = (r.stderr.match(/panicked at [^\n]*\n[^\n]*/) || [''])[0].replace(/\n/, ' '); console.log(`${line}\t${why}`); rows.push({ f, status, why }); continue; }
  summary.ok++;
  const ms = +line.split('\t')[2].replace('ms', ''); summary.ms += ms;
  const res = JSON.parse(fs.readFileSync(path.join(tout, f + '.truck.json'), 'utf8'));
  fs.rmSync(path.join(tout, f + '.truck.json'));
  const idx = orig(base);
  let n = 0, withId = 0, agree = 0, empty = 0, tris = 0, idBest = 0;
  const allFaces = res.shells.flatMap((sh) => sh.faces).filter((g) => g.positions.length);
  const dist = (P, q) => { let b = Infinity; for (let i = 0; i < P.length; i += 3) b = Math.min(b, Math.hypot(P[i] - q[0], P[i + 1] - q[1], P[i + 2] - q[2])); return b; };
  for (const sh of res.shells) for (const face of sh.faces) {
    n++; tris += face.tris;
    if (face.id == null) continue;
    withId++;
    if (!face.positions.length) { empty++; continue; }
    const fe = idx.ents.get(face.id);
    const vps = [...closure(idx, fe.refs.slice(0, -1))].map((id) => idx.ents.get(id)).filter((e) => hasType(e, 'VERTEX_POINT')).map((e) => pointOf(idx, e.refs[0]));
    const P = face.positions;
    let ext = 0; for (let k = 0; k < 3; k++) { let lo = Infinity, hi = -Infinity; for (let i = k; i < P.length; i += 3) { lo = Math.min(lo, P[i]); hi = Math.max(hi, P[i]); } ext = Math.max(ext, hi - lo); }
    const tol = 1e-4 * ext + 1e-7;
    const ok = vps.every((q) => { for (let i = 0; i < P.length; i += 3) if (Math.hypot(P[i] - q[0], P[i + 1] - q[1], P[i + 2] - q[2]) <= tol) return true; return false; });
    if (ok) { agree++; idBest++; continue; }
    // inexact mesh: is the reported face still the nearest one to its STEP vertices (i.e. is the id right)?
    const own = Math.max(...vps.map((q) => dist(P, q)));
    if (allFaces.every((g) => g === face || Math.max(...vps.map((q) => dist(g.positions, q))) >= own * 0.999)) idBest++;
  }
  Object.assign(summary, { faces: summary.faces + n, facesWithId: summary.facesWithId + withId, facesAgree: summary.facesAgree + agree, facesIdBest: (summary.facesIdBest ?? 0) + idBest, facesEmpty: summary.facesEmpty + empty, tris: summary.tris + tris });
  console.log(`${line}\tidFaces=${withId}/${n}\tagree=${agree}/${withId - empty}\tidNearest=${idBest}\temptyFaces=${empty}`);
  rows.push({ f, status, ms, faces: n, withId, agree, idBest, empty, tris });
}
console.log(JSON.stringify(summary));
fs.writeFileSync(`${process.env.TAG ?? 'truck'}_results_${filter || 'all'}.json`, JSON.stringify({ summary, rows }, null, 1));
