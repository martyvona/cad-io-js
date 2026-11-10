// The area oracle on the B-rep model against the area oracle on the file (both corpus_checks/area_oracle.ts), face by
// face over the corpus: every file's faces measured from the file, and from each part's model (step-import's
// `models`). Where both are trusted they must agree (within 1e-7 of the area plus both error bounds): a difference is
// the conversion's (angle units, placements, orientations, p-curves aren't used) or cad-brep's evaluators'. Faces
// trusted by one and not the other are tallied by why. Planted bugs, in about one part in 10 (corpus.ts's
// plantedPart): PLANT=angle converts the part's cones' semi-angles twice (each such cone face must differ),
// PLANT=sense turns over its first face (it must differ). Several files at once (runner.ts: CHILDREN).
// Usage: node --max-old-space-size=12000 corpus_checks/area_model.ts [file-list.txt] [max MB]
import fs from 'node:fs';
import { type BrepData, type CurveEvaluator, openBrep, rowCount, SURFACE_KIND } from
  '../packages/cad-brep/src/index.ts';
import { parseStep } from '../packages/step-parser/src/index.ts';
import { importStep } from '../packages/step-import/src/index.ts';
import { AreaOracle, modelFaceArea, trusted } from './area_oracle.ts';
import { corpusFiles, plantedPart, shortName } from './corpus.ts';
import { runFiles, type FileCheck } from './runner.ts';

// The process's own size limit (from its command line).
let maxMB = 1000;
const plant = process.env.PLANT;
/** Examples kept per tally. */
const EXAMPLES = 4;
/** A file's results, or the run's (merge). */
const fresh = () => ({ files: 0, faces: 0, both: 0, agree: 0, plantedFaces: 0, plantedCaught: 0, worst: 0,
  worstAt: '', tally: new Map<string, { n: number; ex: string[] }>() });
type Result = ReturnType<typeof fresh>;

/** A file's results into the run's: counts summed, the largest difference (the first if equal), the first examples. */
function merge(all: Result, r: Result): void {
  for (const k of ['files', 'faces', 'both', 'agree', 'plantedFaces', 'plantedCaught'] as const) all[k] += r[k];
  if (r.worst > all.worst) { all.worst = r.worst; all.worstAt = r.worstAt; }
  for (const [k, t] of r.tally) {
    const a = all.tally.get(k) ?? { n: 0, ex: [] };
    a.n += t.n;
    a.ex.push(...t.ex.slice(0, EXAMPLES - a.ex.length));
    all.tally.set(k, a);
  }
}

/** A copy with a defect planted (PLANT), and the face rows it should show in. */
function planted(d: BrepData, pick: boolean): { d: BrepData; rows: Set<number> } {
  const rows = new Set<number>();
  if (!plant || !pick) return { d, rows };
  const c = openBrep(d.buffer.slice(0));
  if (plant === 'angle') {
    for (let s = 0; s < rowCount(c, 'surface'); s++) {
      if (c.surface.kind[s] !== SURFACE_KIND.cone) continue;
      c.pool.surfaceReal[c.surface.real[s]! + 10]! *= Math.PI / 180;
      for (let f = 0; f < rowCount(c, 'face'); f++) if (c.face.surface[f] === s) rows.add(f);
    }
  } else if (plant === 'sense' && rowCount(c, 'face')) {
    c.face.sameSense[0] = 1 - c.face.sameSense[0]!;
    rows.add(0);
  }
  return { d: rows.size ? c : d, rows };
}

export const check: FileCheck<undefined, Result> = {
  async setup({ args }) {
    maxMB = Number(args[1] ?? 1000);
  },
  async file(path) {
    const R = fresh();
    const note = (k: string, ex: string) => {
      const t = R.tally.get(k) ?? { n: 0, ex: [] };
      t.n++;
      if (t.ex.length < EXAMPLES) t.ex.push(ex);
      R.tally.set(k, t);
    };
    if (fs.statSync(path).size > maxMB * 1e6) return R;
    R.files++;
    const name = shortName(path);
    const bytes = new Uint8Array(fs.readFileSync(path));
    const oracle = new AreaOracle(parseStep(bytes));
    const { scene } = await importStep(bytes);
    for (const part of scene.parts) {
      const m0 = part.brep?.model;
      if (!m0) continue;
      const { d, rows } = planted(m0, plantedPart(`${name} #${part.sources[0]!.id}`));
      const curves = new Map<number, CurveEvaluator | undefined>();
      for (let f = 0; f < rowCount(d, 'face'); f++) {
        const id = d.face.id[f]!;
        if (Number.isNaN(id)) continue;
        R.faces++;
        const where = `${name} #${id}`;
        const a = oracle.faceArea(id), b = modelFaceArea(d, f, curves);
        const ta = trusted(a), tb = trusted(b);
        if (rows.has(f) && ta) R.plantedFaces++;
        if (ta && tb) {
          R.both++;
          const diff = Math.abs(a.area - b.area), tol = 1e-7 * a.area + a.error + b.error;
          const rel = diff / Math.max(a.area, 1e-300);
          if (diff <= tol) R.agree++;
          else {
            if (rows.has(f)) R.plantedCaught++;
            else note('both trusted, areas differ', `${where}: file ${a.area}, model ${b.area}`);
          }
          if (!rows.has(f) && rel > R.worst) { R.worst = rel; R.worstAt = where; }
          if (!rows.has(f) && Math.abs(a.perimeter - b.perimeter) > 1e-7 * a.perimeter + 1e-9) {
            note('both trusted, perimeters differ', `${where}: file ${a.perimeter}, model ${b.perimeter}`);
          }
        } else if (ta) {
          if (rows.has(f)) R.plantedCaught++;
          else {
            const why = b.ok ? `untrusted (${b.flags.join(', ') || 'error'})` : `unsupported: ${b.reason}`;
            note(`file trusted, model ${why}`, where);
          }
        } else if (tb) note(`model trusted, file ${a.ok ? `untrusted (${a.flags.join(', ') || 'error'})`
          : `unsupported: ${a.reason.replace(/#\d+/g, '#N')}`}`, where);
      }
    }
    return R;
  },
};

if (import.meta.main) {
  maxMB = Number(process.argv[3] ?? 1000);
  const all = fresh();
  await runFiles(import.meta.url, check, corpusFiles(process.argv[2]).map((f) => ({ path: f, job: undefined })),
    process.argv.slice(2), (f, out) => {
      if ('error' in out) process.stderr.write(`${shortName(f)}: failed: ${out.error}\n`);
      else merge(all, out.result);
    });
  const { files, faces, both, agree, plantedFaces, plantedCaught, worst, worstAt, tally } = all;
  console.log(`${files} files, ${faces} model faces; ${both} trusted by both oracles, ${agree} agreeing`);
  console.log(`largest relative difference where both are trusted: ${worst.toExponential(2)} (${worstAt})`);
  if (plant) {
    console.log(`PLANT=${plant}: ${plantedFaces} faces planted (trusted by the file), ${plantedCaught} differ`);
  }
  for (const [k, v] of [...tally].sort((x, y) => y[1].n - x[1].n)) {
    console.log(String(v.n).padStart(8), k, ' e.g.', v.ex.join('; '));
  }
}
