// orientShells, in steps on the healed model, last:
//   - loops: in a shell whose every edge is used by two of its faces but some twice the same way, the faces turned
//     (sense and loops) so each edge is used once each way, the fewer per connected group of faces (a 2-colouring over
//     the shared edges; a shell where none exists, or whose faces to turn another shell uses, left as built), the
//     shell's kind then by its topology (closed);
//   - faces: a face whose loops run against its sense (cad-oracle's `orientation` flag: the loops' signed sum
//     negative, where that's its only flag and the face's area is more than its error and its perimeter times the
//     part's tolerance) where its neighbours agree with its loops (every edge it shares with another face used once
//     each way) gets its sense flipped to its loops', in closed shells and sheets alike, but only where its loops'
//     winding in 3D about its normal (loopWinding) confirms they run against it: the flag alone can be false; a face
//     with no neighbour to tell, or whose winding refuses or can't confirm the flip, is left as built, with a note;
//   - shells: a solid's closed shell facing into its material turned. Which way it faces is decided from its exact
//     geometry: the signed volume (cad-oracle's shellVolumes) and point classification (cad-oracle's RayShellSide,
//     with its second ray), reconciled (both agree: by it; one unsure: the other, with a warning; they disagree: left
//     as built, an error). Which way it must face is by nesting (cad-oracle's nesting: the shells of the body holding
//     it): out where an even number do (an outer shell, a lump inside a void), in where an odd number do (a void); a
//     shell whose nesting can't be told is left as built.
// Turning a shell turns each of its faces: its sense flipped and its loops run the other way (each edge loop's coedge
// rows reversed in place, each orientation flipped; a coedge's range is in its edge's order, so it stays), the same
// operation undoing it, which healing again does before putting the source's values back.

import { BODY_KIND, type BrepData, LOOP_KIND, ORIENTATION, rowCount, writeBrep } from 'cad-brep';
import type { Geometry } from 'cad-geom';
import type { Diagnostic } from 'cad-scene';
import { Oracle, type OracleModule, shellVolumes, type ShellVolume } from 'cad-oracle';
import type { ShellSide } from 'cad-oracle/shell-side';

/** One solid shell's verdict: turned or not, by what. */
export interface ShellVerdict {
  shell: number;
  volume: ShellVolume;
  /** Whether it faces the wrong way as built (then turned); unknown where the methods couldn't say. */
  wrong: boolean | undefined;
  by?: 'volume' | 'side' | 'both';
}

/** The face rows shell `s` uses. */
export function facesOf(model: BrepData, s: number): number[] {
  const out: number[] = [];
  for (let j = model.shell.first[s]!; j < model.shell.first[s]! + model.shell.count[s]!; j++) {
    out.push(model.faceUse.face[j]!);
  }
  return out;
}

/** Per edge row, the uses (coedge rows) of its faces' edge loops among `faces`. */
function edgeUses(model: BrepData, faces: Iterable<number>): Map<number, { face: number; c: number }[]> {
  const uses = new Map<number, { face: number; c: number }[]>();
  for (const f of faces) {
    for (let l = model.face.firstLoop[f]!; l < model.face.firstLoop[f]! + model.face.loopCount[f]!; l++) {
      if (model.loop.kind[l] !== LOOP_KIND.edge) continue;
      for (let c = model.loop.first[l]!; c < model.loop.first[l]! + model.loop.count[l]!; c++) {
        const e = model.coedge.edge[c]!;
        (uses.get(e) ?? uses.set(e, []).get(e)!).push({ face: f, c });
      }
    }
  }
  return uses;
}

/**
 * The faces step: the faces of shells whose loops run against their senses (`against`, the oracle's orientation
 * flag), split into those to flip (`inClosed`, `inSheets`: every edge they share with another face of their shell
 * used once each way, so the neighbours agree with the loops, and `confirm` agreeing that the loops run against the
 * sense) and those left (`alone`: no neighbour shares an edge; `disputed`: a shared edge used twice the same way;
 * `refused`: `confirm` finds the loops with the sense; `unconfirmed`: `confirm` can't tell).
 */
export function faceSenses(model: BrepData, against: (face: number) => boolean,
  confirm: (face: number) => boolean | undefined = () => true) {
  const inClosed: number[] = [], inSheets: number[] = [], alone: number[] = [], disputed: number[] = [];
  const refused: number[] = [], unconfirmed: number[] = [];
  const seen = new Set<number>();
  for (let s = 0; s < rowCount(model, 'shell'); s++) {
    const faces = [...new Set(facesOf(model, s))], uses = edgeUses(model, faces);
    for (const f of faces) {
      if (seen.has(f) || !against(f)) continue;
      seen.add(f);
      let shared = 0, agree = true;
      for (const u of uses.values()) {
        const mine = u.filter((x) => x.face === f), others = u.filter((x) => x.face !== f);
        if (!mine.length || !others.length) continue;
        shared++;
        // (Used once each way across the pair: a forward and a reversed use.)
        const dir = (x: { c: number }) => model.coedge.orientation[x.c];
        if (!(u.length === 2 && dir(u[0]!) !== dir(u[1]!))) agree = false;
      }
      if (!shared) alone.push(f);
      else if (!agree) disputed.push(f);
      else {
        const c = confirm(f);
        (c === undefined ? unconfirmed : !c ? refused : model.shell.kind[s] === 1 ? inClosed : inSheets).push(f);
      }
    }
  }
  return { inClosed, inSheets, alone, disputed, refused, unconfirmed };
}

/** loopWinding's samples per edge, and its grid's points across the face's (u, v) box each way. */
const WINDING_SAMPLES = 24, WINDING_GRID = 24;

/**
 * Which way a face's loops run about its normal (its sense applied), independently of the oracle's signed sum: their
 * winding in 3D about the normal at a point inside the face, projected onto the tangent plane there. The point: on a
 * grid over the loops' (u, v) box, the one inside them (whichever way they run) farthest from them. The loops: the
 * model's own, each edge loop's coedges in order, each its edge's 3D curve sampled the way the coedge uses it (not
 * facePieces' p-curves, which are turned so the face lies on their left, hiding the answer). 1: with the sense; -1:
 * against it; undefined where it can't be told: where the surface closes round what the loops leave out too (a
 * torus, a sphere: the face may be the surface less what they bound, so its loops may run against its sense
 * rightly), where loops running round a period bound no face, where no point is inside or the projection is edge-on
 * (a band round a cylinder seen from its side winds 0), or where the side the face lies on at the loops' sample
 * nearest the point (left of their direction about the normal, or right) says otherwise (a strip curved past a half
 * turn folds in projection).
 */
export function loopWinding(g: Geometry, model: BrepData, f: number): 1 | -1 | undefined {
  const info = g.faceInfo(f);
  if (info.status !== 'ok') return undefined;
  const P2 = [info.uPeriod, info.vPeriod];
  // (Closed both ways, as a torus, or one way with a pole at each end of the other, as a sphere: tess-cadio's
  // edges.cpp meshes a sphere's or torus's face with one loop as the surface less it where its neighbours confirm
  // that, LMP1 #172535's tori among them.)
  if (P2[0]! > 0 && P2[1]! > 0) return undefined;
  const sing = g.surfaceSingularities(model.face.surface[f]!);
  if (sing.status !== 'ok' || sing.singularities.length >= 2) return undefined;
  // (The ends exactly: an end interpolated can round past its range, its value then not given.)
  const samples = (t0: number, t1: number) => Array.from({ length: WINDING_SAMPLES + 1 },
    (_, i) => i === WINDING_SAMPLES ? t1 : t0 + (t1 - t0) * i / WINDING_SAMPLES);
  const p = g.facePieces(f);
  if (p.status !== 'ok' || !p.coedge.length) return undefined;
  const uv: number[] = [], starts: number[] = [];
  for (let k = 0; k < p.coedge.length; k++) {
    starts.push(uv.length / 2);
    const e = g.evalCoedge(p.coedge[k]!, samples(p.travel[2 * k]!, p.travel[2 * k + 1]!), 0);
    if (e.status !== 'ok') return undefined;
    // (Values: 3 per point, z 0; a point not evaluated skipped.)
    for (let i = 0; i <= WINDING_SAMPLES; i++) if (e.statuses[i] === 0) uv.push(e.values[3 * i]!, e.values[3 * i + 1]!);
  }
  if (!uv.every(Number.isFinite)) return undefined;
  const end = (k: number) => k + 1 < starts.length ? starts[k + 1]! : uv.length / 2;
  // Where the surface closes one way, the loops' travels round it summed (each piece's, from its first point to its
  // last): a whole period, not cancelling (a band's two loops run opposite ways), they bound no face
  // (Checking_Fixture_Clamping #5594's #8400, its one loop round its cylinder once). (Not half: a loop closed along a
  // pole line, not a piece, travels anything up to one, PRO7071 #403's half cones' pi.)
  for (const c of [0, 1]) {
    if (!(P2[c]! > 0)) continue;
    let sum = 0;
    for (let k = 0; k < starts.length; k++) sum += uv[2 * (end(k) - 1) + c]! - uv[2 * starts[k]! + c]!;
    if (Math.abs(sum) > 0.9 * P2[c]!) return undefined;
  }
  const lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
  for (let i = 0; i < uv.length; i++) {
    lo[i % 2] = Math.min(lo[i % 2]!, uv[i]!), hi[i % 2] = Math.max(hi[i % 2]!, uv[i]!);
  }
  const grid: number[] = [];
  for (let i = 0; i < WINDING_GRID; i++) {
    for (let j = 0; j < WINDING_GRID; j++) {
      grid.push(lo[0]! + (hi[0]! - lo[0]!) * (i + 0.5) / WINDING_GRID,
        lo[1]! + (hi[1]! - lo[1]!) * (j + 0.5) / WINDING_GRID);
    }
  }
  // Inside by the loops' (u, v) pieces alone, whichever way they run (geom2d's classification goes by their
  // direction, so a face whose loops run against its sense comes out the complement): crossings even or odd of a ray
  // along +v where u closes, else along +u, the other coordinate (`across`) folded by its period.
  const along = P2[0]! > 0 ? 1 : 0, across = 1 - along, period = P2[across]!;
  const inside = (x: number, y: number) => {
    let n = 0;
    for (let k = 0; k < starts.length; k++) {
      for (let i = starts[k]! + 1; i < end(k); i++) {
        const a = [uv[2 * i - 2]! - x, uv[2 * i - 1]! - y], b = [uv[2 * i]! - x, uv[2 * i + 1]! - y];
        if (period > 0) {
          const shift = Math.round((a[across]! + b[across]!) / 2 / period) * period;
          a[across] = a[across]! - shift, b[across] = b[across]! - shift;
        }
        if ((a[across]! > 0) === (b[across]! > 0)) continue;
        const t = a[across]! / (a[across]! - b[across]!);
        if (a[along]! + t * (b[along]! - a[along]!) > 0) n++;
      }
    }
    return n % 2 === 1;
  };
  let best = -1, far = 0;
  for (let k = 0; k < grid.length / 2; k++) {
    const x = grid[2 * k]!, y = grid[2 * k + 1]!;
    if (!inside(x, y)) continue;
    let m = Infinity;
    for (let i = 0; i < uv.length; i += 2) m = Math.min(m, Math.hypot(uv[i]! - x, uv[i + 1]! - y));
    if (m > far) far = m, best = k;
  }
  if (best < 0) return undefined;
  const at = g.faceEval(f, [grid[2 * best]!, grid[2 * best + 1]!], 1);
  if (at.status !== 'ok' || at.statuses[0] !== 0) return undefined;
  const v = at.values, P = [v[0]!, v[1]!, v[2]!], su = [v[3]!, v[4]!, v[5]!], sv = [v[6]!, v[7]!, v[8]!];
  const cross = (a: number[], b: number[]) => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!,
    a[0]! * b[1]! - a[1]! * b[0]!];
  const dot = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
  const N = cross(su, sv).map((x) => model.face.sameSense[f] ? x : -x), nl = Math.hypot(...N);
  if (!(nl > 0)) return undefined;
  const n = N.map((x) => x / nl), a = Math.abs(n[0]!) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const e1u = a.map((x, c) => x - dot(a, n) * n[c]!), e1 = e1u.map((x) => x / Math.hypot(...e1u)), e2 = cross(n, e1);
  let total = 0, near = Infinity, side = 0;
  for (let l = model.face.firstLoop[f]!; l < model.face.firstLoop[f]! + model.face.loopCount[f]!; l++) {
    if (model.loop.kind[l] !== LOOP_KIND.edge) continue;
    let prev: number | undefined;
    for (let c = model.loop.first[l]!; c < model.loop.first[l]! + model.loop.count[l]!; c++) {
      const e = model.coedge.edge[c]!, curve = model.edge.curve[e]!;
      if (curve < 0) continue;
      const ep = g.edgeParams(e);
      if (ep.status !== 'ok') return undefined;
      const [t0, t1] = model.coedge.orientation[c] === ORIENTATION.reversed ? [ep.t1, ep.t0] : [ep.t0, ep.t1];
      const ev = g.evalCurve(curve, samples(t0, t1), 0);
      if (ev.status !== 'ok') return undefined;
      const at3 = (i: number) => [0, 1, 2].map((k) => ev.values[3 * i + k]!);
      for (let i = 0; i <= WINDING_SAMPLES; i++) {
        if (ev.statuses[i] !== 0) continue;
        const X = [0, 1, 2].map((k) => ev.values[3 * i + k]! - P[k]!), ang = Math.atan2(dot(X, e2), dot(X, e1));
        const dist = Math.hypot(...X);
        if (dist < near) {
          // (The interior's side of the boundary at its sample nearest the point: P - B against n x T.)
          const a = at3(Math.max(0, i - 1)), b = at3(Math.min(WINDING_SAMPLES, i + 1));
          const T = b.map((x, k) => x - a[k]!);
          near = dist, side = Math.sign(dot(cross(n, T), X.map((x) => -x)));
        }
        if (prev !== undefined) {
          let d = ang - prev;
          while (d > Math.PI) d -= 2 * Math.PI;
          while (d < -Math.PI) d += 2 * Math.PI;
          total += d;
        }
        prev = ang;
      }
    }
  }
  const w = total / (2 * Math.PI), r = Math.round(w);
  return Math.abs(w - r) <= 0.1 && (r === 1 || r === -1) && side === r ? r : undefined;
}

/**
 * The loops step: per shell whose every edge is used by two of its faces, some twice the same way, the faces to turn
 * so each edge is used once each way (`turn`, by shell), or why it's left (`left`).
 */
export function loopTurns(model: BrepData): { turn: Map<number, number[]>; left: { shell: number; why: string }[] } {
  const turn = new Map<number, number[]>(), left: { shell: number; why: string }[] = [];
  const users = new Map<number, number>();
  for (let s = 0; s < rowCount(model, 'shell'); s++) {
    for (const f of new Set(facesOf(model, s))) users.set(f, (users.get(f) ?? 0) + 1);
  }
  for (let s = 0; s < rowCount(model, 'shell'); s++) {
    const faces = [...new Set(facesOf(model, s))], uses = edgeUses(model, faces);
    let same = false, twice = true;
    for (const u of uses.values()) {
      if (u.length !== 2) twice = false;
      else if (model.coedge.orientation[u[0]!.c] === model.coedge.orientation[u[1]!.c]) same = true;
    }
    if (!twice || !same) continue;
    // Faces turned or not (0, 1) so that across each edge the uses differ: same-way uses, one of the two turned.
    const adj = new Map<number, { g: number; flip: number }[]>();
    let ok = true;
    for (const u of uses.values()) {
      const [a, b] = u as [{ face: number; c: number }, { face: number; c: number }];
      const flip = model.coedge.orientation[a.c] === model.coedge.orientation[b.c] ? 1 : 0;
      if (a.face === b.face) { if (flip) ok = false; continue; }
      (adj.get(a.face) ?? adj.set(a.face, []).get(a.face)!).push({ g: b.face, flip });
      (adj.get(b.face) ?? adj.set(b.face, []).get(b.face)!).push({ g: a.face, flip });
    }
    const colour = new Map<number, number>(), out: number[] = [];
    for (const f0 of faces) {
      if (!ok || colour.has(f0)) continue;
      const group = [f0];
      colour.set(f0, 0);
      for (let i = 0; i < group.length && ok; i++) {
        const f = group[i]!;
        for (const { g, flip } of adj.get(f) ?? []) {
          const want = colour.get(f)! ^ flip;
          if (!colour.has(g)) colour.set(g, want), group.push(g);
          else if (colour.get(g) !== want) ok = false;
        }
      }
      const ones = group.filter((f) => colour.get(f) === 1), zeros = group.filter((f) => colour.get(f) === 0);
      out.push(...(ones.length <= zeros.length ? ones : zeros));
    }
    if (!ok) left.push({ shell: s, why: 'no turning of its faces uses every edge once each way' });
    else if (out.some((f) => users.get(f)! > 1)) left.push({ shell: s, why: 'a face to turn is another shell\'s too' });
    else turn.set(s, out);
  }
  return { turn, left };
}

/** The model with the faces' senses flipped (loops as they are). */
export function flipSenses(model: BrepData, faces: Iterable<number>): BrepData {
  const set = new Set(faces);
  return writeBrep((c) => {
    const col = (model as unknown as Record<string, Record<string, ArrayLike<number>>>)[c.table]![c.column]!;
    if (c.table !== 'face' || c.column !== 'sameSense') return col;
    const x = Uint8Array.from(col);
    for (const f of set) x[f] = x[f] ? 0 : 1;
    return x;
  });
}

/**
 * The shells step's verdicts for every solid's shell, with what was said (disagreements, one method deciding
 * alone as warnings, shells sharing faces or whose nesting can't be told left as built). `sides` the point
 * classification (none: the volume alone, nothing said for it).
 */
export function shellVerdicts(model: BrepData, module: OracleModule, sides?: ShellSide):
  { verdicts: ShellVerdict[]; diagnostics: Diagnostic[] } {
  const volumes = new Map(shellVolumes(module, model, sides ? { sides } : {}).map((v) => [v.shell, v]));
  const diagnostics: Diagnostic[] = [], verdicts: ShellVerdict[] = [];
  const name = (s: number) => model.shell.id[s] ? `shell #${model.shell.id[s]}` : `shell row ${s}`;
  const users = new Map<number, number>();
  for (let s = 0; s < rowCount(model, 'shell'); s++) {
    for (const f of new Set(facesOf(model, s))) users.set(f, (users.get(f) ?? 0) + 1);
  }
  using o = new Oracle(module, model.buffer);
  for (let b = 0; b < rowCount(model, 'body'); b++) {
    if (model.body.kind[b] !== BODY_KIND.solid) continue;
    const members: number[] = [];
    for (let j = model.body.first[b]!; j < model.body.first[b]! + model.body.count[b]!; j++) {
      members.push(model.member.ref[j]!);
    }
    // How many of the body's shells hold each (-1 where it can't be told): even, it must face out; odd, in.
    const parent = members.length > 1 ? o.nesting(b) : [-1];
    const depth = members.map((_, i) => {
      let n = 0, k = parent[i];
      while (k !== undefined && k >= 0) {
        if (++n > members.length) return -1;
        k = parent[k];
      }
      // (Ended at none, -1: that deep; at -2 (unknown) or no answer: not told.)
      return k === -1 ? n : -1;
    });
    members.forEach((s, i) => {
      const v = volumes.get(s);
      if (!v) return;
      if (depth[i]! < 0) {
        verdicts.push({ shell: s, volume: v, wrong: undefined });
        return;
      }
      const out = depth[i]! % 2 === 0;
      const byVolume = v.known ? v.volume > 0 : undefined;
      const bySide = v.side === 'outside' ? true : v.side === 'inside' ? false : undefined;
      if (byVolume !== undefined && bySide !== undefined && byVolume !== bySide) {
        diagnostics.push({ severity: 'warning', message: `orientShells: ${name(s)} left as built: its exact volume `
          + `(${v.volume.toPrecision(6)}) and point classification (${v.side}) disagree on which way it faces` });
        verdicts.push({ shell: s, volume: v, wrong: undefined });
        return;
      }
      const facesOut = byVolume ?? bySide;
      if (facesOut === undefined) { verdicts.push({ shell: s, volume: v, wrong: undefined }); return; }
      const by = byVolume !== undefined && bySide !== undefined ? 'both' : byVolume !== undefined ? 'volume' : 'side';
      const wrong = facesOut !== out;
      // (One method alone, where the other was asked: said where it turns the shell.)
      if (wrong && by !== 'both' && !(by === 'volume' && !sides)) {
        diagnostics.push({ severity: 'warning', message: `orientShells: ${name(s)} oriented by ${by === 'volume'
          ? `its exact volume alone (point classification unsure: ${v.sideWhy ?? 'unknown'})`
          : `point classification alone (its exact volume unsure: ${v.why ?? 'unknown'})`}` });
      }
      if (wrong && [...new Set(facesOf(model, s))].some((f) => users.get(f)! > 1)) {
        diagnostics.push({ severity: 'warning', message: `orientShells: ${name(s)} faces the wrong way but shares `
          + 'faces with another shell: left as built' });
        verdicts.push({ shell: s, volume: v, wrong: undefined });
        return;
      }
      verdicts.push({ shell: s, volume: v, wrong, by });
    });
  }
  return { verdicts, diagnostics };
}

/**
 * The model with the shells' faces turned (turnFaces).
 */
export function turnShells(model: BrepData, shells: Iterable<number>): { model: BrepData; perm: Int32Array } {
  const faces = new Set<number>();
  for (const s of shells) for (const f of facesOf(model, s)) faces.add(f);
  return turnFaces(model, faces);
}

/** A shell's kind by its topology: closed where every edge its faces' edge loops use is used twice, once each way. */
export function shellKind(model: BrepData, s: number): number {
  for (const u of edgeUses(model, new Set(facesOf(model, s))).values()) {
    if (u.length !== 2 || model.coedge.orientation[u[0]!.c] === model.coedge.orientation[u[1]!.c]) return 2;
  }
  return 1;
}

/**
 * The model with the faces turned (each face's sense flipped, each edge loop's coedge rows reversed in place and their
 * orientations flipped), the kinds of the shells using them by their topology again, and `perm`, the coedge rows' map
 * (new row to old: its own inverse), for what's indexed by coedge (the analysis's rows). The same call on the result
 * with the same faces gives the model back.
 */
export function turnFaces(model: BrepData, faces: ReadonlySet<number>): { model: BrepData; perm: Int32Array } {
  const nc = rowCount(model, 'coedge'), perm = Int32Array.from({ length: nc }, (_, i) => i);
  const flipped = new Uint8Array(nc);
  for (const f of faces) {
    for (let l = model.face.firstLoop[f]!; l < model.face.firstLoop[f]! + model.face.loopCount[f]!; l++) {
      if (model.loop.kind[l] !== LOOP_KIND.edge) continue;
      const a = model.loop.first[l]!, n = model.loop.count[l]!;
      for (let i = 0; i < n; i++) perm[a + i] = a + n - 1 - i, flipped[a + i] = 1;
    }
  }
  const turn = (o: number) => o === ORIENTATION.forward ? ORIENTATION.reversed
    : o === ORIENTATION.reversed ? ORIENTATION.forward : o;
  type Col = ArrayLike<number> & { slice(): ArrayLike<number> };
  const out = writeBrep((c) => {
    const col = (model as unknown as Record<string, Record<string, Col>>)[c.table]![c.column]!;
    if (c.table === 'face' && c.column === 'sameSense') {
      const x = Uint8Array.from(col as ArrayLike<number>);
      for (const f of faces) x[f] = x[f] ? 0 : 1;
      return x;
    }
    if (c.table !== 'coedge') return col;
    const x = col.slice() as unknown as { [i: number]: number; length: number };
    for (let r = 0; r < nc; r++) {
      for (let w = 0; w < c.width; w++) x[r * c.width + w] = col[perm[r]! * c.width + w]!;
    }
    if (c.column === 'orientation') for (let r = 0; r < nc; r++) if (flipped[r]) x[r] = turn(x[r]!);
    return x as ArrayLike<number>;
  });
  // The kinds of the shells whose faces turned, by their topology now.
  const shells = new Set<number>();
  for (let s = 0; s < rowCount(out, 'shell'); s++) if (facesOf(out, s).some((f) => faces.has(f))) shells.add(s);
  const kinds = Uint8Array.from(out.shell.kind);
  let changed = false;
  for (const s of shells) {
    const k = shellKind(out, s);
    if (k !== kinds[s]) kinds[s] = k, changed = true;
  }
  if (!changed) return { model: out, perm };
  return { model: writeBrep((c) => c.table === 'shell' && c.column === 'kind' ? kinds
    : (out as unknown as Record<string, Record<string, ArrayLike<number>>>)[c.table]![c.column]!), perm };
}
