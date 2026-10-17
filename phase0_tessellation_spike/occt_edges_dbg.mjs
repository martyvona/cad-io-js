import fs from 'node:fs';
import path from 'node:path';
const occtTess = (await import('./occt_tess/final_Os.mjs')).default;
const M = await occtTess();
const KINDS = ['shared', 'seam', 'free', 'degenerate'];
const [dir] = process.argv.slice(2);
const unmappedByKind = [0, 0, 0, 0], perFile = [];
for (const f of fs.readdirSync(dir).filter((f) => /\.absr\.\d+\.stp$/.test(f)).sort()) {
  const buf = fs.readFileSync(path.join(dir, f)); const root = +f.match(/\.absr\.(\d+)\.stp$/)[1];
  const p = M._malloc(buf.length); M.HEAPU8.set(buf, p);
  if (M._occt_tessellate(p, buf.length, root, 0.05, 0.5, 0)) { M._free(p); continue; }
  M._free(p);
  const ne = M._occt_num_edges(); const E = M.HEAP32.slice(M._occt_edges() / 4, M._occt_edges() / 4 + 4 * ne);
  const diag = JSON.parse(M.UTF8ToString(M._occt_diag()));
  let free = 0, split = new Map(), splitKinds = [0, 0, 0, 0];
  for (let k = 0; k < ne; k++) { const id = E[4 * k], kind = E[4 * k + 3]; if (id < 0) unmappedByKind[kind]++; if (kind === 2) free++; if (id >= 0) split.set(id, [...(split.get(id) ?? []), kind]); }
  const splits = [...split.values()].filter((v) => v.length > 1);
  for (const v of splits) for (const k of v) splitKinds[k]++;
  perFile.push({ f: f.replace('.absr', ''), free, splits: splits.length, splitKinds: splitKinds.join('/'), noTri: diag.noTriangulation, faces: diag.faces });
  M._occt_free();
}
console.log('unmapped by kind:', Object.fromEntries(KINDS.map((k, i) => [k, unmappedByKind[i]])));
console.log('files with free edges or split ids (splitKinds = shared/seam/free/degenerate):');
for (const r of perFile.filter((r) => r.free || r.splits)) console.log(` ${r.f}: free=${r.free} splitIds=${r.splits} splitKinds=${r.splitKinds} faces=${r.faces} noTri=${r.noTri}`);
