// Coverage: every face of every B-rep part through our own tessellator (tess-cadio), with OCCT (its native route) and
// SMLib run beside it as references, each in a tess-workers pool at the medium profile (PROFILE). Nothing is skipped
// for a reference failing: the parts and faces where OCCT or SMLib fail are where ours must succeed without one.
//   - each backend's status per part: ok, partial (some faces without triangles), no triangles, error (thrown),
//     timeout, crash;
//   - every face of every model accounted for once: meshed by ours, or failed by ours with its cause (our part's
//     status, else our "faces failed to mesh, by cause" diagnostic, else "not in our diagnostics") and its surface
//     kind; crossed with whether OCCT and SMLib give it triangles (the matrix);
//   - each face without our triangles in a class: beyond repair (input the user has decided is past repair, by its
//     cause: BEYOND_REPAIR), counted apart from our failures and out of their percentage, else a failure;
//   - every part and face ours doesn't mesh listed in full at the end, per list (the coverage's record).
// The references are the raw backends, as smlib_occt.ts runs them: no fallback, join or fill.
// Usage: node corpus_checks/coverage_corpus.ts [list[,list...]] [max MB, default 1000]   (progress on standard error)
//   lists: comma-separated, each judged and reported apart, then together (default test_corpus/files.txt and
//          test_corpus/models.txt, the user's models)
//   WORKERS=<n> workers per backend in each process (default: a third of the process's share, runner.ts)
//   PLANT=<bug>  a bug planted in about one part in 10 before it's judged, to prove the check sees it (each planted
//                case is checked for the verdict it must get, the missed ones listed): fail (our first meshed face
//                emptied: must be ours failed, "not in our diagnostics", or "part no triangles" where it was the part's
//                only meshed face), part (our result replaced by a crash: every face ours failed, "part crash"; parts
//                without faces not planted), occt and smlib (that reference's first meshed face emptied: must be
//                counted as failed by it), cause (our first meshed face emptied and named in a by-cause diagnostic of
//                two entries: must be ours failed with the planted cause), beyond (our first meshed face emptied and
//                named with a cause beyond repair: must be counted beyond repair, not failed)
//   SURVEY=1     the mesh survey too (shape_survey.ts), over the faces all three backends mesh: each backend's
//                triangles by smallest angle and aspect in 3D (quantiles, and faces by their worst), its triangles per
//                face against SMLib's, each face's worst deviation from its surface sampled at its largest triangles'
//                centroids and sides' middles (by cad-geom's inversion), the faces some backend leaves past 1.1 x the
//                deflection listed; the normals' check: each triangle against the profile's angle, from the
//                surface's normals at its corners' feet (their spread, and the facet's turn from each), per backend
//                over those faces and ours over every face it meshes (faces, triangles and mesh area past the angle,
//                faces by their worst excess and by their area's share past it, those within the deflection that
//                miss it; triangles with a corner at a pole or apex left out and counted apart), the faces where one
//                misses listed; with PLANT=survey, ours given a needle, a copy of its largest triangle lifted 3 x the
//                deflection off it, and that triangle with its third corner raised to tilt it 75 degrees, on the
//                planted face, which must show as its worst angle under 0.1 degrees, deviation past 1.5 x (3 x less
//                what the face itself strays) and the tilted triangle judged past 30 degrees
//   DENSITY=<prefix> with SURVEY, a line per face all three mesh into <prefix>.<pid>.tsv (one file per process, for
//                face_density.ts): the part, face id, surface kind, the deflection, its smallest radius of curvature
//                at ours's vertices' feet (shape_survey.ts's minRadius; Infinity if flat), and per backend (ours, OCCT,
//                SMLib) its triangles, mesh area, mesh extent (box diagonal) and worst sampled deviation
//   PROFILE=<name> the meshing profile (default medium; the angle check's limit is its angle)
//   INSERTIONS=1 ours counts its mesher's insertions by what queued them (tess-cadio's countInsertions), tallied over
//                the parts it meshes: the same meshes, but up to 2 x its CPU time, so its times and the parts over
//                CPU_MS aren't comparable with a run without it; with PLANT=insertions, ours's count by size said a
//                million more on the planted part, which must show in the tally
//   CPU_MS=<ms>     ours's limit per part in its worker thread's CPU time (tess-workers' cpuTimeoutMs, default
//                120000: a part slower than that fails for development's purposes either way), 4 x it in wall time
//                the backstop; a part stopped at it is its own status, "over N s CPU", listed with its last
//                progress (a performance worklist), and run again alone at the end, the host otherwise as it is,
//                both verdicts reported (on this host's efficiency cores a thread's CPU time runs about 2 x, so a
//                part can pass the limit under load only)
//   TIMEOUT_MS=<ms> OCCT's and SMLib's limit per part, in wall time (default 600000)
//   SLOW_MS=<ms>    ours slower than this in CPU time on a part it meshes is listed as slow (default 120000)
//   IDLE_MS=<ms>    runner.ts's watchdog on a child silent on one file (default here 0, none: every request has
//                   TIMEOUT_MS, but a file of many slow parts at a worker per backend passes any fixed watchdog, 1 h
//                   included, and its faces would go uncounted)
// Several files at once (runner.ts: CHILDREN, MESH_WORKERS).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import type { TessellationRequest, TessellationResult } from '../packages/cad-scene/src/index.ts';
import { MESH_PROFILES } from '../packages/cad-scene/src/index.ts';
import { type BrepData, decode } from '../packages/cad-brep/src/index.ts';
import { importStep } from '../packages/step-import/src/index.ts';
import { WorkerTessellator } from '../packages/tess-workers/src/node.ts';
import { CAUSES_HEAD, failedCauses } from './cadio_causes.ts';
import { INSERTED_HEAD, INSERTED_KINDS } from '../packages/tess-cadio/src/index.ts';
import { corpusFiles, plantedPart, repoDir, shortName } from './corpus.ts';
import { addInto, division, runFiles, type FileCheck } from './runner.ts';
import { hostLine } from '../scripts/host.ts';
import { Geometry } from '../packages/cad-geom/src/index.ts';
import {
  AREA_BOUNDS, ASPECT_PER_DECADE, DEVIATION_BOUNDS, EXCESS_BOUNDS, RATIO_BINS, addShapes, angleEdge, areaBin,
  addAngles, aspectEdge, deviationBin, faceAngles, faceDeviation, faceTriangles, freshAngles, freshShapes, meshExtent,
  minRadius, quantile, ratioBin, triangleShape, type Angles, type FaceAngles,
} from './shape_survey.ts';

const EXAMPLES = 4;
const PROFILE = (process.env.PROFILE ?? 'medium') as keyof typeof MESH_PROFILES;
if (!MESH_PROFILES[PROFILE]) throw new Error(`PROFILE=${PROFILE}: one of ${Object.keys(MESH_PROFILES).join(', ')}`);
const { linearDeflection: LIN, angularDeflection: ANG } = MESH_PROFILES[PROFILE];
const DENSITY = process.env.DENSITY ?? '';
/** The profile's angle in degrees, the normals' check's limit. */
const ANG_DEG = (ANG * 180) / Math.PI;
const PLANT = process.env.PLANT ?? '';
const PLANTS = ['fail', 'part', 'occt', 'smlib', 'cause', 'beyond', 'survey', 'insertions'];
const SURVEY = process.env.SURVEY === '1';
const INSERTIONS = process.env.INSERTIONS === '1';
/** Ours's limit (ms of CPU time), the references' (ms of wall time), and the CPU time over which ours is slow. */
const CPU_MS = Number(process.env.CPU_MS ?? 120_000);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 600_000);
/** Ours's status at CPU_MS. */
const OVER = `over ${CPU_MS / 1000} s CPU`;
const SLOW_MS = Number(process.env.SLOW_MS ?? 120_000);
/** Our time per part meshed (from its first progress), by upper bound in seconds. */
const TIMES = [1, 10, 60, 120, Infinity];
const timeBin = (ms: number) => TIMES.findIndex((t) => ms / 1000 <= t);
if (PLANT && !PLANTS.includes(PLANT)) throw new Error(`PLANT=${PLANT}: one of ${PLANTS.join(', ')}`);
if (PLANT === 'survey' && !SURVEY) throw new Error('PLANT=survey needs SURVEY=1');
if (DENSITY && !SURVEY) throw new Error('DENSITY needs SURVEY=1');
if (PLANT === 'insertions' && !INSERTIONS) throw new Error('PLANT=insertions needs INSERTIONS=1');
const DEFAULT_LISTS = ['test_corpus/files.txt', 'test_corpus/models.txt'];
/**
 * Our causes for faces whose input is beyond repair (own-tessellator.md, the coverage goal): counted apart from our
 * failures. As failedCauses gives them, "status: cause".
 */
const BEYOND_REPAIR = new Set(["invalidModel: a use of an edge whose curve is far off its face's surface"]);
const BEYOND = 'beyond repair', FAILURE = 'failure';

const BACKENDS = ['cadio', 'occt', 'smlib'] as const;
type Backend = typeof BACKENDS[number];
const LABEL: Record<Backend, string> = { cadio: 'ours', occt: 'OCCT', smlib: 'SMLib' };
type PartStatus = string;
const STATUSES: PartStatus[] = ['ok', 'partial', 'no triangles', 'error', OVER, 'timeout', 'crash', 'no faces'];
/** A part's statuses that are no failure: every face meshed, or no face to mesh (a part of curves or points). */
const fine = (s: PartStatus) => s === 'ok' || s === 'no faces';

let maxBytes = 1000e6;
let pools: Record<Backend, WorkerTessellator>;

/** A thrown error's status: ours's CPU limit, the pool's wall-time limit, a worker that died, or anything else. */
const thrown = (m: string): PartStatus => /timed out after \d+ ms of CPU time/.test(m) ? OVER
  : /timed out/.test(m) ? 'timeout'
  : /exit|crash|terminated|memory|unreachable|RuntimeError/.test(m) ? 'crash' : 'error';
/** A message with its numbers and ids made generic, for tallies. */
const generic = (m: string) => m.replace(/#\d+/g, '#N').replace(/\d+(\.\d+)?/g, 'N').slice(0, 160);

/** The face ids a result gives triangles. */
function meshedIds(r: TessellationResult): Set<number> {
  const s = new Set<number>();
  for (const f of r.faces) if (f.entityId !== null && f.count > 0) s.add(f.entityId);
  return s;
}

/** A backend's outcome for one part: its status, the faces it meshed, and why a whole part failed. */
interface Outcome { status: PartStatus; meshed: Set<number>; why: string; result?: TessellationResult }

function outcome(r: TessellationResult | Error, faceIds: readonly number[]): Outcome {
  // (A part with no faces that throws is still a failure, in the statuses; it has no face to account for.)
  if (!faceIds.length && !(r instanceof Error)) return { status: 'no faces', meshed: new Set(), why: '', result: r };
  if (r instanceof Error) {
    return { status: thrown(r.message), meshed: new Set(), why: r.message.split('\n')[0]!.slice(0, 200) };
  }
  const meshed = meshedIds(r);
  if (!r.indices.length || meshed.size === 0) {
    const errs = r.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message);
    return { status: 'no triangles', meshed, why: (errs.join('; ') || 'no error said').slice(0, 300), result: r };
  }
  const all = faceIds.every((id) => meshed.has(id));
  return { status: all ? 'ok' : 'partial', meshed, why: '', result: r };
}

/** Whether OCCT and SMLib give a face triangles: the matrix's columns. */
function references(occt: boolean, smlib: boolean): string {
  return occt && smlib ? 'both mesh' : occt ? 'SMLib fails' : smlib ? 'OCCT fails' : 'both fail';
}
const COLUMNS = ['both mesh', 'OCCT fails', 'SMLib fails', 'both fail'];

/** Whether a planted reference failure (`expect` "OCCT fails" or "SMLib fails") shows on its face. */
const refFailed = (expect: string, occtOk: boolean, smlibOk: boolean) =>
  (expect === 'OCCT fails' && !occtOk) || (expect === 'SMLib fails' && !smlibOk);

/** PLANT's bug on one part, in place on copies; returns what the planted case must be judged as. */
function plant(o: Record<Backend, TessellationResult | Error>, faces: number):
  { expect: string; face?: number; tilted?: number } | undefined {
  // (A part without faces has no face to judge a plant by.)
  if (!faces) return undefined;
  const emptyFirst = (b: Backend) => {
    const r = o[b];
    if (r instanceof Error) return undefined;
    const faces = r.faces.map((f) => ({ ...f }));
    const f = faces.find((y) => y.entityId !== null && y.count > 0);
    if (!f) return undefined;
    // (Every range of that face emptied: a face may have several.)
    for (const y of faces) if (y.entityId === f.entityId) y.count = 0;
    o[b] = { ...r, faces };
    return f.entityId!;
  };
  if (PLANT === 'fail') {
    const id = emptyFirst('cadio');
    return id === undefined ? undefined : { expect: 'not in our diagnostics', face: id };
  }
  if (PLANT === 'occt' || PLANT === 'smlib') {
    const id = emptyFirst(PLANT);
    return id === undefined ? undefined : { expect: `${LABEL[PLANT]} fails`, face: id };
  }
  if (PLANT === 'part') {
    o.cadio = new Error('planted: worker exited with code 1');
    return { expect: 'part crash' };
  }
  if (PLANT === 'cause') {
    const id = emptyFirst('cadio');
    if (id === undefined) return undefined;
    const r = o.cadio as TessellationResult;
    // (Two entries, the planted one second, as tess-cadio joins them, with a cause holding a colon and digits.)
    o.cadio = { ...r, diagnostics: [...r.diagnostics, { severity: 'info', message: `${CAUSES_HEAD}unknown: other 2 `
      + `(#999999999, #999999998); planted: cause 3 1 (#${id})` }] };
    return { expect: 'planted: cause 3', face: id };
  }
  if (PLANT === 'beyond') {
    const id = emptyFirst('cadio');
    if (id === undefined) return undefined;
    const r = o.cadio as TessellationResult;
    const [status, cause] = [...BEYOND_REPAIR][0]!.split(': ');
    o.cadio = { ...r, diagnostics: [...r.diagnostics, { severity: 'info', message: `${CAUSES_HEAD}${status}: `
      + `${cause} 1 (#${id})` }] };
    return { expect: BEYOND, face: id };
  }
  if (PLANT === 'survey') return plantSurvey(o);
  if (PLANT === 'insertions') {
    // Ours's insertions said with a million more by size, the last kind's count moved to the front.
    const r = o.cadio;
    if (r instanceof Error) return undefined;
    const k = r.diagnostics.findIndex((x) => x.message.startsWith(INSERTED_HEAD));
    if (k < 0) return undefined;
    const n = r.diagnostics[k]!.message.slice(INSERTED_HEAD.length).split(', ')
      .map((x) => Number(x.slice(x.lastIndexOf(' ') + 1)));
    n[0]! += 1e6;
    const diagnostics = [...r.diagnostics];
    diagnostics[k] = { ...diagnostics[k]!, message: INSERTED_HEAD + INSERTED_KINDS.map((x, i) => `${x} ${n[i]}`)
      .join(', ') };
    o.cadio = { ...r, diagnostics };
    return { expect: 'insertions: a million more by size' };
  }
  return undefined;
}

/**
 * PLANT=survey: on the first face all three mesh, ours's result given three triangles more in a range of their own
 * (a copy of the face's largest lifted 3 x the deflection along its normal, a needle along one of its sides, and it
 * with its third corner raised to tilt it 75 degrees about that side); `tilted` the last one's start in the indices.
 */
function plantSurvey(o: Record<Backend, TessellationResult | Error>):
  { expect: string; face?: number; tilted?: number } | undefined {
  if (BACKENDS.some((b) => o[b] instanceof Error)) return undefined;
  const rs = BACKENDS.map((b) => o[b] as TessellationResult);
  const tris = rs.map(faceTriangles);
  const id = [...tris[0]!.keys()].find((k) => tris[1]!.has(k) && tris[2]!.has(k));
  if (id === undefined) return undefined;
  const r = rs[0]!, p = r.positions, ix = r.indices;
  const corner = (k: number, c: number) => [0, 1, 2].map((a) => p[3 * ix[k + c]! + a]!);
  const area = (k: number) => {
    const [a, b, c] = [0, 1, 2].map((q) => corner(k, q));
    const u = [0, 1, 2].map((q) => b![q]! - a![q]!), v = [0, 1, 2].map((q) => c![q]! - a![q]!);
    return Math.hypot(u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!);
  };
  const k = tris[0]!.get(id)!.reduce((x, y) => (area(y) > area(x) ? y : x));
  const [a, b, c] = [0, 1, 2].map((q) => corner(k, q)) as [number[], number[], number[]];
  const u = [0, 1, 2].map((q) => b[q]! - a[q]!), v = [0, 1, 2].map((q) => c[q]! - a[q]!);
  const n = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
  const len = Math.hypot(...n);
  if (!(len > 0)) return undefined;
  const lift = n.map((x) => (3 * LIN * x) / len);
  const up = [a, b, c].map((x) => x.map((y, q) => y + lift[q]!));
  // The tilted: c raised along the normal by its height over ab times tan 75 degrees.
  const h = len / Math.hypot(...u);
  const tilt = c.map((y, q) => y + (h * Math.tan((75 * Math.PI) / 180) * n[q]!) / len);
  // The needle: a, b and a point 1e-4 of the way from ab's middle to c (about 0.01 degrees where the triangle is
  // about equilateral, less where flatter).
  const m = [0, 1, 2].map((q) => (a[q]! + b[q]!) / 2 + 1e-4 * (c[q]! - (a[q]! + b[q]!) / 2));
  const base = p.length / 3, positions = new Float32Array(p.length + 27);
  positions.set(p);
  positions.set([...up.flat(), ...a, ...b, ...m, ...a, ...b, ...tilt], p.length);
  const indices = new Uint32Array(ix.length + 9);
  indices.set(ix);
  indices.set(Array.from({ length: 9 }, (_, q) => base + q), ix.length);
  o.cadio = { ...r, positions, indices, faces: [...r.faces, { entityId: id, start: ix.length, count: 9 }] };
  return { expect: 'survey: worst angle under 0.1 degrees, deviation past 1.5 x, the tilted triangle past 30 '
    + 'degrees', face: id, tilted: ix.length + 6 };
}

const statuses = () => Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<PartStatus, number>;
const fresh = () => ({
  files: 0, skippedBig: 0, failedFiles: 0, parts: 0, faces: 0,
  status: { cadio: statuses(), occt: statuses(), smlib: statuses() },
  // Faces each backend gives no triangles (whole parts' failures included); ours's beyond repair not among them.
  facesFailed: { cadio: 0, occt: 0, smlib: 0 },
  // Faces ours gives no triangles whose input is beyond repair (BEYOND_REPAIR), and by cause with its surface kind.
  beyondRepair: 0,
  beyondCauses: new Map<string, number>(),
  // Key: our verdict ("ours meshes" or our cause), a tab, the references' column.
  matrix: new Map<string, number>(),
  // The faces ours gives no triangles by class (BEYOND, FAILURE); our failures by cause with its surface kind.
  classes: new Map<string, number>(),
  causes: new Map<string, number>(),
  // Faces in our result that the model doesn't have (ids), and per-part accounting that didn't add up.
  foreign: 0,
  mismatches: [] as string[],
  // Ours meshes where both references fail: what this tessellator exists for.
  oursAlone: 0,
  warnings: new Map<string, number>(),
  tally: new Map<string, { n: number; ex: string[] }>(),
  planted: { cases: 0, seen: 0, missed: [] as string[] },
  unmeshedParts: [] as string[],
  unmeshed: [] as string[],
  // Ours's CPU time on the parts it meshes (its worker thread's), by TIMES, and its wall time alike (a loaded host
  // makes that longer); those over SLOW_MS in CPU time, listed for the performance work.
  times: TIMES.map(() => 0),
  wallTimes: TIMES.map(() => 0),
  // (Meshed with no CPU time given, so not timed.)
  untimed: 0,
  slow: [] as string[],
  // Ours's parts stopped at CPU_MS: file, part id, where, the last progress (run again alone at the end).
  capped: [] as string[],
  // SURVEY's tallies (shape_survey.ts), over the faces all three mesh: shapes, triangles per face against SMLib's
  // (ours, OCCT), faces by worst sampled deviation over the deflection and those with no point inverted, the faces
  // some backend leaves past 1.1 x, and the time inverting took.
  survey: {
    faces: 0,
    shapes: { cadio: freshShapes(), occt: freshShapes(), smlib: freshShapes() },
    ratio: { cadio: Array(RATIO_BINS).fill(0) as number[], occt: Array(RATIO_BINS).fill(0) as number[] },
    deviation: { cadio: DEVIATION_BOUNDS.map(() => 0), occt: DEVIATION_BOUNDS.map(() => 0),
      smlib: DEVIATION_BOUNDS.map(() => 0) },
    uninverted: { cadio: 0, occt: 0, smlib: 0 },
    over: [] as string[],
    deviationMs: 0,
    // The normals' check over the faces all three mesh, ours's over every face it meshes, the faces where one misses
    // (listed), and the time it took.
    angles: { cadio: freshAngles(), occt: freshAngles(), smlib: freshAngles() },
    oursAngles: freshAngles(),
    angleFaces: [] as string[],
    anglesMs: 0,
  },
  // INSERTIONS: ours's points inserted over the parts it meshes, by INSERTED_KINDS, and the parts that said none.
  inserted: INSERTED_KINDS.map(() => 0),
  insertedUnsaid: 0,
});
type Tallies = ReturnType<typeof fresh>;
const bump = (m: Map<string, number>, k: string, n = 1) => m.set(k, (m.get(k) ?? 0) + n);

/**
 * SURVEY on one part (results as planted): the faces all three mesh into T.survey; the normals' check on those and on
 * the rest ours meshes; ours's worst angle, deviation and (with `tilted`, a triangle's start in ours's indices) that
 * triangle's normals' angle on each face all three mesh, for PLANT=survey.
 */
async function surveyPart(T: Tallies, where: string, d: BrepData, buffer: ArrayBuffer | ArrayBufferView,
  r: Record<Backend, TessellationResult | Error>, ids: readonly number[], tilted?: number):
  Promise<Map<number, { angle: number; deviation: number; tilted: number }>> {
  const out = new Map<number, { angle: number; deviation: number; tilted: number }>();
  if (r.cadio instanceof Error) return out;
  const refs = !BACKENDS.some((b) => r[b] instanceof Error);
  const rs = BACKENDS.map((b) => (r[b] instanceof Error ? undefined : r[b] as TessellationResult));
  const tris = rs.map((x) => (x ? faceTriangles(x) : new Map<number, number[]>()));
  const rowOf = new Map(ids.map((id, row) => [id, row]));
  const all = refs ? [...rowOf.keys()].filter((id) => tris.every((t) => t.has(id))) : [];
  const common = new Set(all);
  const oursOnly = [...rowOf.keys()].filter((id) => tris[0]!.has(id) && !common.has(id));
  if (!all.length && !oursOnly.length) return out;
  const S = T.survey;
  S.faces += all.length;
  BACKENDS.forEach((b, i) => addShapes(rs[i]!, tris[i]!, all, S.shapes[b]));
  for (const id of all) {
    const n = tris.map((t) => t.get(id)!.length);
    S.ratio.cadio[ratioBin(n[0]!, n[2]!)]!++;
    S.ratio.occt[ratioBin(n[1]!, n[2]!)]!++;
  }
  const g = await Geometry.open(buffer);
  const kindOf = (row: number) => (decode.surface(d, d.face.surface[row]!) as { kind: string }).kind;
  const said = (f: FaceAngles) => `${f.missed} of ${f.triangles} triangles (${f.spread} by spread), worst ${
    f.worst.toFixed(1)} deg (+${(f.worst - ANG_DEG).toFixed(1)}), ${((100 * f.missedArea) / f.area).toPrecision(2)}% `
    + 'of its area';
  try {
    let t0 = performance.now();
    const worsts = new Map<number, number[]>();
    for (const id of all) {
      const row = rowOf.get(id)!, surface = d.face.surface[row]!;
      const worst = BACKENDS.map((b, i) => {
        const fd = faceDeviation(g, surface, rs[i]!, tris[i]!.get(id)!, 1e-6 * LIN);
        if (Number.isNaN(fd.worst)) S.uninverted[b]++;
        else S.deviation[b][deviationBin(fd.worst / LIN)]!++;
        return fd.worst;
      });
      worsts.set(id, worst);
      if (worst.some((w) => w > 1.1 * LIN)) {
        S.over.push(`${where} face #${id} (${kindOf(row)}): ${BACKENDS.map((b, i) => `${LABEL[b]} ${
          Number.isNaN(worst[i]!) ? 'not inverted' : `${(worst[i]! / LIN).toFixed(2)} x`}`).join(', ')}`);
      }
    }
    S.deviationMs += performance.now() - t0;
    t0 = performance.now();
    const lines: string[] = [];
    for (const id of [...all, ...oursOnly]) {
      const row = rowOf.get(id)!, surface = d.face.surface[row]!, both = common.has(id);
      let tiltedAt = NaN, radius = NaN;
      const fa = BACKENDS.map((b, i) => (i > 0 && !both ? undefined
        : faceAngles(g, surface, rs[i]!, tris[i]!.get(id)!, 1e-6 * LIN, ANG_DEG,
          i === 0 && tilted !== undefined ? (k, deg) => { if (k === tilted) tiltedAt = deg; } : undefined,
          i === 0 && DENSITY && both ? (uv, judged) => { radius = minRadius(g, surface, uv, judged); } : undefined)));
      if (DENSITY && both) {
        lines.push([where, id, kindOf(row), LIN, radius, ...BACKENDS.flatMap((b, i) => [tris[i]!.get(id)!.length,
          fa[i]!.area, meshExtent(rs[i]!, tris[i]!.get(id)!), worsts.get(id)![i]!])].join('\t'));
      }
      addAngles(S.oursAngles, fa[0]!, ANG_DEG);
      if (both) {
        const worst = worsts.get(id)!;
        BACKENDS.forEach((b, i) => {
          addAngles(S.angles[b], fa[i]!, ANG_DEG);
          if (worst[i]! <= LIN) S.angles[b].within++, S.angles[b].withinMissed += fa[i]!.missed ? 1 : 0;
        });
        let angle = 60;
        const ours = rs[0]!;
        for (const k of tris[0]!.get(id)!) {
          angle = Math.min(angle, triangleShape(ours.positions, ours.indices[k]!, ours.indices[k + 1]!,
            ours.indices[k + 2]!).angle);
        }
        out.set(id, { angle, deviation: worst[0]!, tilted: tiltedAt });
      }
      if (fa.some((f) => f?.missed)) {
        S.angleFaces.push(`${where} face #${id} (${kindOf(row)}): ${BACKENDS.map((b, i) => `${LABEL[b]} ${
          !fa[i] ? 'not compared' : fa[i]!.missed ? said(fa[i]!) : `none, worst ${fa[i]!.worst.toFixed(1)} deg`}${
          both ? `, deviation ${(worsts.get(id)![i]! / LIN).toFixed(2)} x` : ''}`).join('; ')}`);
      }
    }
    S.anglesMs += performance.now() - t0;
    if (lines.length) fs.appendFileSync(`${DENSITY}.${process.pid}.tsv`, lines.join('\n') + '\n');
  } finally {
    g.dispose();
  }
  return out;
}

/** A file's bytes, gunzipped where it's gzip (.stpZ). */
function readStep(f: string): Uint8Array {
  const b = fs.readFileSync(f);
  return new Uint8Array(b[0] === 0x1f && b[1] === 0x8b ? zlib.gunzipSync(b) : b);
}

export const check: FileCheck<string, Tallies> = {
  async setup({ meshWorkers }) {
    const workers = Number(process.env.WORKERS ?? Math.max(1, Math.floor(meshWorkers / 3)));
    const pool = (pkg: string, cls: string, cpu: boolean) => new WorkerTessellator({
      backend: { module: import.meta.resolve(`../packages/${pkg}/src/index.ts`), export: cls,
        ...(cpu && INSERTIONS ? { options: { countInsertions: true } } : {}) }, workers,
      ...(cpu ? { cpuTimeoutMs: CPU_MS, timeoutMs: 4 * CPU_MS } : { timeoutMs: TIMEOUT_MS }) });
    pools = { cadio: pool('tess-cadio', 'CadioTessellator', true), occt: pool('tess-occt', 'OcctTessellator', false),
      smlib: pool('tess-smlib', 'SmlibTessellator', false) };
    await Promise.all(BACKENDS.map((b) => pools[b].init()));
  },
  async teardown() {
    await Promise.all(BACKENDS.map((b) => pools[b].dispose()));
  },
  async file(f, list) {
    void list;
    const T = fresh();
    const note = (k: string, ex: string) => {
      const t = T.tally.get(k) ?? { n: 0, ex: [] };
      t.n++;
      if (t.ex.length < EXAMPLES) t.ex.push(ex);
      T.tally.set(k, t);
    };
    if (fs.statSync(f).size > maxBytes) { T.skippedBig++; return T; }
    T.files++;
    const name = shortName(f);
    const { scene } = await importStep(readStep(f));
    const parts = scene.parts.filter((p) => p.brep);
    const results = await Promise.all(parts.map(async (p) => {
      const req: TessellationRequest = { format: 'cad-brep', data: new Uint8Array(p.brep!.model.buffer),
        origin: p.origin, linearDeflection: LIN, angularDeflection: ANG, edges: true };
      // (Ours timed by the pool, from its start in a worker: its wall and its thread's CPU time.)
      const rs = await Promise.all(BACKENDS.map((b) => pools[b].tessellate(req).catch((e: Error) => e)));
      const ours = rs[0]!;
      const times = ours instanceof Error ? undefined : pools.cadio.timesOf(ours);
      return { p, times, r: Object.fromEntries(BACKENDS.map((b, i) => [b, rs[i]!])) as
        Record<Backend, TessellationResult | Error> };
    }));
    for (const { p, times, r } of results) {
      T.parts++;
      const where = `${name} #${p.sources[0]!.id}`;
      const d: BrepData = p.brep!.model;
      const rows = d.face.surface.length;
      const ids = Array.from({ length: rows }, (_, i) => d.face.id[i]!);
      const planted = PLANT && plantedPart(where) ? plant(r, rows) : undefined;
      if (planted) T.planted.cases++;
      const o = Object.fromEntries(BACKENDS.map((b) => [b, outcome(r[b], ids)])) as Record<Backend, Outcome>;
      for (const b of BACKENDS) {
        T.status[b][o[b].status] = (T.status[b][o[b].status] ?? 0) + 1;
        if (!fine(o[b].status) && o[b].status !== 'partial') note(`${LABEL[b]} ${o[b].status}: ${generic(o[b].why)}`,
          where);
      }
      const ours = o.cadio;
      let insertionPlantSeen = false;
      if (ours.result) {
        for (const x of ours.result.diagnostics) {
          if (x.severity === 'warning') bump(T.warnings, generic(x.message));
        }
        if (INSERTIONS) {
          const said = ours.result.diagnostics.find((x) => x.message.startsWith(INSERTED_HEAD));
          if (!said) T.insertedUnsaid++;
          else said.message.slice(INSERTED_HEAD.length).split(', ').forEach((x, k) => {
            const n = Number(x.slice(x.lastIndexOf(' ') + 1));
            T.inserted[k]! += n;
            if (planted && PLANT === 'insertions' && k === 0 && n >= 1e6) insertionPlantSeen = true;
          });
        }
      }
      const partFailed = !fine(ours.status) && ours.status !== 'partial';
      const cpu = times?.cpuMs;
      if (!partFailed && rows && cpu === undefined) T.untimed++;
      if (!partFailed && rows && cpu !== undefined) {
        T.times[timeBin(cpu)]!++;
        T.wallTimes[timeBin(times!.wallMs)]!++;
        if (cpu > SLOW_MS) T.slow.push(`${where} (${rows} faces): ${(cpu / 1000).toFixed(1)} s CPU, `
          + `${(times!.wallMs / 1000).toFixed(1)} s wall, ${ours.status}`);
      }
      if (partFailed) T.unmeshedParts.push(`${where} (${rows} faces): ${ours.status}: ${ours.why}`);
      if (ours.status === OVER) T.capped.push(`${f}\t${p.sources[0]!.id}\t${where}\t${ours.why}`);
      const causes = ours.result ? failedCauses(ours.result) : new Map<number, string>();
      const surveyed = SURVEY ? await surveyPart(T, where, d, p.brep!.model.buffer, r, ids, planted?.tilted)
        : undefined;
      const modelIds = new Set(ids);
      for (const id of ours.meshed) if (!modelIds.has(id)) T.foreign++;
      let meshedHere = 0, failedHere = 0, plantSeen = insertionPlantSeen;
      let plantGot = '';
      if (planted && PLANT === 'survey') {
        const x = surveyed!.get(planted.face!);
        if (x && x.angle < 0.1 && x.deviation > 1.5 * LIN && x.tilted > 30) plantSeen = true;
        plantGot = x ? `; got ${x.angle.toPrecision(3)} degrees, ${(x.deviation / LIN).toPrecision(3)} x, tilted `
          + `${x.tilted.toPrecision(3)} degrees` : '; not surveyed';
      }
      for (let row = 0; row < rows; row++) {
        const id = ids[row]!;
        T.faces++;
        const occtOk = o.occt.meshed.has(id), smlibOk = o.smlib.meshed.has(id);
        if (!occtOk) T.facesFailed.occt++;
        if (!smlibOk) T.facesFailed.smlib++;
        const col = references(occtOk, smlibOk);
        if (ours.meshed.has(id)) {
          meshedHere++;
          bump(T.matrix, `ours meshes\t${col}`);
          if (col === 'both fail') {
            T.oursAlone++;
            note('ours meshes where OCCT and SMLib both fail', `${where} face #${id}`);
          }
          if (planted?.face === id && refFailed(planted.expect, occtOk, smlibOk)) plantSeen = true;
          continue;
        }
        failedHere++;
        // (A part with no triangles may still name each face's cause: those first, the part's status for the rest.)
        const why = causes.get(id) ?? (partFailed ? `part ${ours.status}` : 'not in our diagnostics');
        const kind = (decode.surface(d, d.face.surface[row]!) as { kind: string }).kind;
        const cls = BEYOND_REPAIR.has(why) ? BEYOND : FAILURE;
        bump(T.matrix, `${why}\t${col}`);
        bump(T.classes, cls);
        if (cls === BEYOND) {
          T.beyondRepair++;
          bump(T.beyondCauses, `${why} (${kind})`);
        } else {
          T.facesFailed.cadio++;
          bump(T.causes, `${why} (${kind})`);
        }
        if (why === 'not in our diagnostics') note('face without our triangles not in our diagnostics',
          `${where} face #${id} (${kind})`);
        T.unmeshed.push(`${where} face #${id} (${kind}): ${why}; ${col}; ${cls}`);
        if (planted?.expect === BEYOND && planted.face === id && cls === BEYOND) plantSeen = true;
        // (Emptying a part's only meshed face leaves it no triangles, so the part's status names the face.)
        const seenAs = (x: string) => x === why || (x === 'not in our diagnostics' && why === 'part no triangles'
          && !causes.has(id));
        if (planted && seenAs(planted.expect) && (planted.face === undefined || planted.face === id)) plantSeen = true;
        if (planted?.face === id && refFailed(planted.expect, occtOk, smlibOk)) plantSeen = true;
      }
      if (meshedHere + failedHere !== rows || meshedHere !== ids.filter((id) => ours.meshed.has(id)).length) {
        T.mismatches.push(`${where}: ${rows} faces, ${meshedHere} meshed + ${failedHere} failed`);
      }
      if (planted) {
        if (plantSeen) T.planted.seen++;
        else T.planted.missed.push(`${where}${planted.face !== undefined ? ` face #${planted.face}` : ''}: `
          + `expected "${planted.expect}"${plantGot}`);
      }
    }
    return T;
  },
};

/** SURVEY's summary lines (shape_survey.ts's bins). */
function surveyReport(T: Tallies): void {
  const S = T.survey;
  const pc = (a: number, b: number) => `${b ? ((100 * a) / b).toFixed(2) : '0'}%`;
  const sum = (h: readonly number[], to: number) => h.slice(0, to).reduce((a, x) => a + x, 0);
  // (Bins whose upper edge is at most 1 and 5 degrees; aspect bins from 100 up.)
  const under = (h: readonly number[], deg: number) => sum(h, Math.round(deg / angleEdge(0)));
  const past = (h: readonly number[], aspect: number) => h.reduce((a, x) => a + x, 0) - sum(h,
    Math.round(Math.log10(aspect) * ASPECT_PER_DECADE));
  console.log(`  survey: ${S.faces} faces all three mesh; sampling their deviation took `
    + `${(S.deviationMs / 1000).toFixed(0)} s`);
  for (const b of BACKENDS) {
    const x = S.shapes[b];
    const qa = (q: number) => quantile(x.angle, q, angleEdge).toFixed(1);
    const qs = (q: number) => quantile(x.aspect, q, aspectEdge).toPrecision(3);
    console.log(`    ${LABEL[b]}: ${x.triangles} triangles; smallest angle (deg, bins' upper edges) 0.1% ${qa(0.001)}, `
      + `1% ${qa(0.01)}, 5% ${qa(0.05)}, median ${qa(0.5)}, under 1 deg ${pc(under(x.angle, 1), x.triangles)}, `
      + `under 5 deg ${pc(under(x.angle, 5), x.triangles)}; aspect median ${qs(0.5)}, 99% ${qs(0.99)}, 99.9% `
      + `${qs(0.999)}; faces with a triangle under 1 deg ${pc(under(x.faceAngle, 1), x.faces)}, under 5 deg `
      + `${pc(under(x.faceAngle, 5), x.faces)}, of aspect over 100 ${pc(past(x.faceAspect, 100), x.faces)}`);
  }
  const ratio = (h: readonly number[]) => h.map((n, k) => [n, k] as const).filter(([n]) => n)
    .map(([n, k]) => `${k === 0 ? '<= ' : k === RATIO_BINS - 1 ? '>= ' : ''}${2 ** ((k - 12) / 2) >= 1
      ? `${(2 ** ((k - 12) / 2)).toPrecision(2)}` : `1/${(2 ** ((12 - k) / 2)).toPrecision(2)}`} ${n}`).join(', ');
  console.log(`    triangles per face over SMLib's (to the nearest half power of 2): ours ${ratio(S.ratio.cadio)}; `
    + `OCCT ${ratio(S.ratio.occt)}`);
  const bounds = DEVIATION_BOUNDS.map((x, k) => (x === Infinity ? `over ${DEVIATION_BOUNDS[k - 1]}` : `<= ${x}`));
  for (const b of BACKENDS) {
    console.log(`    ${LABEL[b]} faces by worst sampled deviation over the deflection: ${S.deviation[b].map((n, k) =>
      `${bounds[k]} ${n}`).join(', ')}; not inverted ${S.uninverted[b]}`);
  }
  console.log(`  the normals' check at the profile's ${ANG_DEG.toFixed(1)} degrees (a triangle's corners' surface `
    + `normals spread past it, or its facet's normal turned past it from a corner's); took `
    + `${(S.anglesMs / 1000).toFixed(0)} s:`);
  for (const b of BACKENDS) angleLine(`${LABEL[b]} on the faces all three mesh`, S.angles[b], true);
  angleLine('ours on every face it meshes', S.oursAngles, false);
}

/** One line of the normals' check's tallies. */
function angleLine(label: string, A: Angles, within: boolean): void {
  const pc = (a: number, b: number) => `${b ? ((100 * a) / b).toPrecision(3) : '0'}%`;
  const ex = EXCESS_BOUNDS.map((x, k) => (x === Infinity ? `over ${EXCESS_BOUNDS[k - 1]}` : `<= ${x}`));
  const sh = AREA_BOUNDS.map((x) => `<= ${100 * x}%`);
  console.log(`    ${label}: faces past it ${A.facesMissed} of ${A.faces} (${pc(A.facesMissed, A.faces)}), triangles `
    + `${A.missed} of ${A.triangles} (${pc(A.missed, A.triangles)}), mesh area ${pc(A.missedArea, A.area)}; by the `
    + `corners' spread alone (the rest by the facet) ${A.facesSpread} faces, ${A.spread} triangles, mesh area `
    + `${pc(A.spreadArea, A.area)}; faces by `
    + `worst excess (deg) ${A.excess.map((n, k) => `${ex[k]} ${n}`).join(', ')}; by their area's share past it `
    + `${A.share.map((n, k) => `${sh[k]} ${n}`).join(', ')}${within ? `; within the deflection (sampled) ${A.within} `
    + `faces, ${A.withinMissed} of them past it` : ''}; left out, a corner at a pole or apex: ${A.excluded} triangles `
    + `on ${A.facesExcluded} faces (${pc(A.excludedArea, A.area)} of the area); a corner not inverted: `
    + `${A.unmeasured} triangles (${pc(A.unmeasuredArea, A.area)} of the area)`);
}

/** Lists named on the command line (comma-separated), else the defaults; paths relative to the repository. */
function lists(arg: string | undefined): string[] {
  return (arg ? arg.split(',') : DEFAULT_LISTS).map((l) => path.resolve(repoDir, l));
}

function report(label: string, T: Tallies): void {
  const pct = (a: number, b: number) => `${a} of ${b} (${b ? ((100 * a) / b).toFixed(2) : '0'}%)`;
  console.log(`## ${label}${PLANT ? `, PLANT=${PLANT}` : ''}`);
  console.log(`${T.files} files (${T.skippedBig} over ${maxBytes / 1e6} MB skipped, ${T.failedFiles} failed), `
    + `${T.parts} B-rep parts, ${T.faces} faces`);
  for (const b of BACKENDS) {
    console.log(`  ${LABEL[b]} parts: ${STATUSES.map((s) => `${s} ${T.status[b][s]}`).join(', ')}; faces without `
      + `triangles ${b === 'cadio' ? 'failed ' : ''}${pct(T.facesFailed[b], T.faces)}`);
  }
  console.log(`  ours: faces beyond repair (input, apart from our failures): ${pct(T.beyondRepair, T.faces)}; by cause `
    + `and surface: ${[...T.beyondCauses].sort((x, y) => y[1] - x[1]).map(([k, n]) => `${k} ${n}`).join(', ')
    || 'none'}`);
  // (Our meshed faces as the matrix has them: what's left once failures and beyond repair are taken out, checked
  // below.)
  const meshed = COLUMNS.reduce((a, c) => a + (T.matrix.get(`ours meshes\t${c}`) ?? 0), 0);
  console.log(`  ours meshes ${meshed} faces, ${T.oursAlone} of them where `
    + `OCCT and SMLib both fail; faces in our results the models don't have: ${T.foreign}`);
  const classes = [...T.classes].map(([k, n]) => `${k} ${n}`).join(', ') || 'none';
  console.log(`  faces without our triangles by class: ${classes}`);
  console.log('  the matrix, faces (rows ours, columns OCCT and SMLib):');
  const rowsOf = [...new Set([...T.matrix.keys()].map((k) => k.split('\t')[0]!))]
    .sort((a, b) => (a === 'ours meshes' ? -1 : b === 'ours meshes' ? 1 : a < b ? -1 : 1));
  // (Counts first and the row's whole label after them: causes are long, and cut ones could look alike.)
  console.log(`  ${COLUMNS.map((c) => c.padStart(12)).join('')}${'all'.padStart(10)}  ours`);
  for (const row of rowsOf) {
    const cells = COLUMNS.map((c) => T.matrix.get(`${row}\t${c}`) ?? 0);
    console.log(`  ${cells.map((n) => String(n).padStart(12)).join('')}`
      + `${String(cells.reduce((a, n) => a + n, 0)).padStart(10)}  ${row}`);
  }
  const sum = [...T.matrix.values()].reduce((a, n) => a + n, 0);
  // (Our meshed faces, failures and beyond repair against the faces, and the by-cause lines against them.)
  const total = (m: Map<string, number>) => [...m.values()].reduce((a, n) => a + n, 0);
  const split = meshed + T.facesFailed.cadio + T.beyondRepair === T.faces && total(T.causes) === T.facesFailed.cadio
    && total(T.beyondCauses) === T.beyondRepair;
  const all = sum === T.faces && split && !T.mismatches.length && !T.failedFiles;
  console.log(`  every face accounted for: ${all ? 'yes' : 'NO'} (${sum} in the matrix of ${T.faces}`
    + `${split ? '' : `; meshed ${meshed}, failed ${T.facesFailed.cadio} (by cause ${total(T.causes)}), beyond `
      + `repair ${T.beyondRepair} (by cause ${total(T.beyondCauses)}) don't add up`}`
    + `${T.mismatches.length ? `; ${T.mismatches.length} parts don't add up` : ''}`
    + `${T.failedFiles ? `; ${T.failedFiles} files failed, their faces uncounted (listed at the end)` : ''})`);
  console.log(`  our failures by cause and surface: ${[...T.causes].sort((x, y) => y[1] - x[1])
    .map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}`);
  const bound = (k: number) => (TIMES[k] === Infinity ? `over ${TIMES[k - 1]} s` : `up to ${TIMES[k]} s`);
  console.log(`  our CPU time on the parts it meshes: ${T.times.map((n, k) => `${bound(k)} ${n}`).join(', ')}, `
    + `untimed ${T.untimed}; ${T.slow.length} slower than ${SLOW_MS / 1000} s, listed below, not failures`);
  console.log(`  our wall time on them: ${T.wallTimes.map((n, k) => `${bound(k)} ${n}`).join(', ')}`);
  console.log(`  our warnings: ${[...T.warnings].sort((x, y) => y[1] - x[1]).map(([k, n]) => `${n} x "${k}"`)
    .join('; ') || 'none'}`);
  if (SURVEY) surveyReport(T);
  if (INSERTIONS) {
    const all = T.inserted.reduce((a, x) => a + x, 0);
    console.log(`  our points inserted, by what queued their triangle (${all}): ${INSERTED_KINDS.map((k, i) =>
      `${k} ${T.inserted[i]} (${all ? ((100 * T.inserted[i]!) / all).toFixed(1) : '0'}%)`).join(', ')}; parts `
      + `that said none ${T.insertedUnsaid}`);
  }
  if (PLANT) {
    console.log(`  planted: ${T.planted.cases} cases, ${T.planted.seen} seen as expected, ${T.planted.missed.length} `
      + 'missed');
    for (const x of T.planted.missed) console.log(`    missed: ${x}`);
  }
  for (const x of T.mismatches) console.log(`  doesn't add up: ${x}`);
  console.log();
  for (const [k, t] of [...T.tally].sort((x, y) => y[1].n - x[1].n)) {
    console.log(`${String(t.n).padStart(8)} ${k}  e.g. ${t.ex.join('; ')}`);
  }
  console.log(`\n### Parts ours doesn't mesh (${T.unmeshedParts.length}), each with its cause`);
  for (const x of [...T.unmeshedParts].sort()) console.log(`  ${x}`);
  console.log(`\n### Parts ours meshes, but slower than ${SLOW_MS / 1000} s of CPU (${T.slow.length}): its CPU and `
    + `wall times, its status`);
  for (const x of [...T.slow].sort()) console.log(`  ${x}`);
  console.log(`\n### Faces without our triangles (${T.unmeshed.length}): our cause; the references; the class`);
  for (const x of [...T.unmeshed].sort()) console.log(`  ${x}`);
  if (SURVEY) {
    console.log(`\n### Faces all three mesh where one leaves a sampled point past 1.1 x the deflection `
      + `(${T.survey.over.length}): each backend's worst over the deflection`);
    for (const x of [...T.survey.over].sort()) console.log(`  ${x}`);
    console.log(`\n### Faces where one backend's triangles miss the profile's angle (${T.survey.angleFaces.length}): `
      + 'each backend\'s triangles past it, its worst and excess, its area past it, its sampled deviation');
    for (const x of [...T.survey.angleFaces].sort()) console.log(`  ${x}`);
  }
  console.log();
}

if (import.meta.main) {
  // (runFiles reads it, in this process.)
  process.env.IDLE_MS ??= '0';
  console.log(await hostLine());
  maxBytes = Number(process.argv[3] ?? 1000) * 1e6;
  const ls = lists(process.argv[2]);
  const label = (l: string) => (l.startsWith(repoDir + path.sep) ? path.relative(repoDir, l) : path.basename(l));
  const files = ls.flatMap((l) => corpusFiles(l).map((f) => ({ path: f, job: label(l) })));
  const listOf = new Map(files.map((f) => [f.path, f.job]));
  const per = new Map(ls.map((l) => [label(l), fresh()]));
  const errors: string[] = [];
  const t0 = performance.now();
  // (A tally's examples are capped when merged; addInto would append them all.)
  const merge = (into: Tallies, r: Tallies) => {
    for (const [k, t] of r.tally) {
      const u = into.tally.get(k) ?? { n: 0, ex: [] };
      u.n += t.n;
      for (const e of t.ex) if (u.ex.length < EXAMPLES) u.ex.push(e);
      into.tally.set(k, u);
    }
    addInto(into, { ...r, tally: new Map() });
  };
  await runFiles(import.meta.url, check, files, process.argv.slice(2), (f, out) => {
    const into = per.get(listOf.get(f)!)!;
    if ('error' in out) {
      into.failedFiles++;
      errors.push(`${shortName(f)}: failed: ${out.error.split('\n')[0]}`);
      return;
    }
    merge(into, out.result);
  });
  const { children, meshWorkers } = division();
  const workers = Number(process.env.WORKERS ?? Math.max(1, Math.floor(meshWorkers / 3)));
  console.log(`coverage: tess-cadio against OCCT (native route) and SMLib, ${PROFILE} profile (${LIN} mm, ${ANG} rad), `
    + `ours's limit ${CPU_MS / 1000} s of CPU (${4 * CPU_MS / 1000} s of wall the backstop), the references' `
    + `${TIMEOUT_MS / 1000} s of wall, slow over ${SLOW_MS / 1000} s of CPU; `
    + `${((performance.now() - t0) / 1000).toFixed(0)} s, ${children || 1} processes x ${workers} workers per backend`);
  console.log();
  for (const [l, T] of per) report(l, T);
  if (per.size > 1) {
    const all = fresh();
    for (const T of per.values()) merge(all, T);
    report('all lists', all);
  }
  for (const e of errors) console.log(e);
  // The parts ours stopped at the CPU limit, again one at a time in a pool of one worker, with the limit unchanged:
  // a part over it only under load (a thread on the efficiency cores) shows here as meshing alone.
  const capped = [...per.values()].flatMap((T) => T.capped).sort();
  if (capped.length) {
    const os = await import('node:os');
    console.log(`\n### Parts over ${CPU_MS / 1000} s of CPU, run again alone at the end (load ${os.loadavg()[0]!
      .toFixed(1)} at the start): the verdict under the run's load; alone`);
    const alone = new WorkerTessellator({ backend: { module: import.meta.resolve('../packages/tess-cadio/src/index.ts'),
      export: 'CadioTessellator' }, workers: 1, cpuTimeoutMs: CPU_MS, timeoutMs: 4 * CPU_MS });
    await alone.init();
    const byFile = new Map<string, string[][]>();
    for (const c of capped) {
      const [file, ...rest] = c.split('\t');
      byFile.set(file!, [...(byFile.get(file!) ?? []), rest]);
    }
    for (const [file, rows] of byFile) {
      const { scene } = await importStep(readStep(file));
      for (const [id, where, why] of rows) {
        const p = scene.parts.find((q) => q.brep && q.sources[0]!.id === Number(id));
        if (!p) { console.log(`  ${where}: not found again`); continue; }
        const r = await alone.tessellate({ format: 'cad-brep', data: new Uint8Array(p.brep!.model.buffer),
          origin: p.origin, linearDeflection: LIN, angularDeflection: ANG, edges: true }).catch((e: Error) => e);
        const ids = Array.from({ length: p.brep!.model.face.surface.length }, (_, i) => p.brep!.model.face.id[i]!);
        const o = outcome(r, ids);
        const times = r instanceof Error ? undefined : alone.timesOf(r);
        const t = times ? ` (${((times.cpuMs ?? NaN) / 1000).toFixed(1)} s CPU, ${(times.wallMs / 1000).toFixed(1)} s `
          + 'wall)' : '';
        console.log(`  ${where}: under load ${OVER} (${why}); alone ${o.status}${t}${o.why ? `: ${o.why}` : ''}`);
      }
    }
    alone.dispose();
  }
}
