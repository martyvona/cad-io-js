// Triangles per face against its area, from coverage_corpus.ts's DENSITY lines: for each backend, over the faces it
// meshes within the deflection d (its sampled worst deviation at most d), its triangles per (area / d^2) and per
// (area / (8 r d)), r the face's smallest radius of curvature (8 r d is a chord's square whose sagitta is d on a
// circle of radius r, so the second is about how many triangles of the largest edge that curvature allows; planes,
// r infinite, have only the first); quantiles per backend and per surface kind; the faces with the most triangles,
// with their area and extent and what the other backends give them. Areas are the mesh's, in mm^2.
// Usage: node corpus_checks/face_density.ts <file.tsv>... [TOP=<n>, default 20]
import fs from 'node:fs';

export const BACKENDS = ['ours', 'OCCT', 'SMLib'] as const;
export const QUANTILES = [0.5, 0.9, 0.99, 0.999, 1];

export interface Mesh { triangles: number; area: number; extent: number; deviation: number }
export interface Face { where: string; id: number; kind: string; d: number; radius: number; mesh: Mesh[] }

/** One DENSITY line (coverage_corpus.ts's columns); undefined where it doesn't have them. */
export function parseLine(line: string): Face | undefined {
  const c = line.split('\t');
  if (c.length !== 5 + 4 * BACKENDS.length) return undefined;
  const n = (s: string) => (s === 'Infinity' ? Infinity : Number(s));
  return { where: c[0]!, id: Number(c[1]), kind: c[2]!, d: n(c[3]!), radius: n(c[4]!),
    mesh: BACKENDS.map((_, i) => ({ triangles: n(c[5 + 4 * i]!), area: n(c[6 + 4 * i]!), extent: n(c[7 + 4 * i]!),
      deviation: n(c[8 + 4 * i]!) })) };
}

/** Within the deflection: a sampled deviation at most d (NaN, nothing sampled, isn't). */
export const within = (f: Face, b: number) => f.mesh[b]!.deviation <= f.d;
/** Triangles per (area / d^2); NaN for a face of no area. */
export const perArea = (f: Face, b: number) => {
  const m = f.mesh[b]!;
  return m.area > 0 ? m.triangles / (m.area / (f.d * f.d)) : NaN;
};
/** Triangles per (area / (8 r d)); NaN where r is infinite or not had, or there's no area. */
export const perCurvature = (f: Face, b: number) => {
  const m = f.mesh[b]!;
  return m.area > 0 && f.radius > 0 && Number.isFinite(f.radius) ? m.triangles / (m.area / (8 * f.radius * f.d))
    : NaN;
};

/** The QUANTILES of the finite values, nearest rank (the max the last); empty where none is. */
export function quantiles(xs: readonly number[]): number[] {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return [];
  return QUANTILES.map((q) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]!);
}

const fmt = (x: number) => (Math.abs(x) >= 1e4 || (Math.abs(x) < 1e-2 && x !== 0) ? x.toExponential(2)
  : x.toPrecision(3));
const qline = (xs: readonly number[]) => {
  const q = quantiles(xs);
  return q.length ? QUANTILES.map((p, k) => `${p === 1 ? 'max' : `${100 * p}%`} ${fmt(q[k]!)}`).join(', ') : 'none';
};

export function report(faces: readonly Face[], top: number): string[] {
  const out: string[] = [];
  const ds = [...new Set(faces.map((f) => f.d))];
  out.push(`face density: ${faces.length} faces all three mesh, deflection ${ds.join(', ')} mm`);
  const kinds = [...new Set(faces.map((f) => f.kind))].sort();
  BACKENDS.forEach((name, b) => {
    const ok = faces.filter((f) => within(f, b));
    out.push(`  ${name}: ${ok.length} faces within the deflection`);
    out.push(`    triangles per face: ${qline(ok.map((f) => f.mesh[b]!.triangles))}`);
    out.push(`    per (area / d^2): ${qline(ok.map((f) => perArea(f, b)))}`);
    out.push(`    per (area / (8 r d)), curved faces: ${qline(ok.map((f) => perCurvature(f, b)))}`);
    for (const k of kinds) {
      const of = ok.filter((f) => f.kind === k);
      if (!of.length) continue;
      out.push(`    ${k} (${of.length}): triangles ${qline(of.map((f) => f.mesh[b]!.triangles))}; per (area / d^2) `
        + `${qline(of.map((f) => perArea(f, b)))}; per (area / (8 r d)) ${qline(of.map((f) => perCurvature(f, b)))}`);
    }
  });
  BACKENDS.forEach((name, b) => {
    const ok = faces.filter((f) => within(f, b)).sort((x, y) => y.mesh[b]!.triangles - x.mesh[b]!.triangles
      || (x.where < y.where ? -1 : x.where > y.where ? 1 : x.id - y.id));
    out.push('', `### ${name}'s ${Math.min(top, ok.length)} faces with the most triangles, within the deflection: its `
      + 'triangles, mesh area (mm^2), extent (mm), smallest radius (mm); each backend\'s triangles and deviation '
      + 'over d');
    for (const f of ok.slice(0, top)) {
      const m = f.mesh[b]!;
      out.push(`  ${f.where} face #${f.id} (${f.kind}): ${m.triangles} triangles, area ${fmt(m.area)}, extent `
        + `${fmt(m.extent)}, r ${Number.isFinite(f.radius) ? fmt(f.radius) : 'flat'}; ${BACKENDS.map((x, i) =>
          `${x} ${f.mesh[i]!.triangles} (${Number.isNaN(f.mesh[i]!.deviation) ? 'not sampled'
            : `${(f.mesh[i]!.deviation / f.d).toFixed(2)} x`})`).join(', ')}`);
    }
  });
  return out;
}

if (import.meta.main) {
  const files = process.argv.slice(2);
  if (!files.length) throw new Error('usage: node corpus_checks/face_density.ts <file.tsv>...');
  const faces: Face[] = [];
  let bad = 0;
  for (const f of files) {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line) continue;
      const x = parseLine(line);
      if (x) faces.push(x);
      else bad++;
    }
  }
  for (const l of report(faces, Number(process.env.TOP ?? 20))) console.log(l);
  if (bad) console.log(`(${bad} lines not read)`);
}
