// Solids' shells oriented by their meshes: a source can give a solid's shell facing the wrong way (a void's closed
// shell already facing into the void and then used reversed, a closed sheet facing in made a solid), and the model
// takes it as given, so a backend that follows the model's normals meshes it inside out (OCCT's healing turns such
// shells, SMLib doesn't). A solid's outer shell encloses positive volume and its voids negative (normals out of the
// material); the sign of a closed mesh's volume is sure where the exact one isn't to be had (B-splines, the healing a
// measure would need), so the meshes are turned, not the model: the B-rep and its exports keep the source's
// orientation. (mesh.ts's orientShells turns closed pieces by the mesh alone: it can't tell a void facing into the
// material, which encloses positive volume inside another piece.)

import { analysisRowCount, BODY_KIND, type BrepAnalysis, type BrepData, openAnalysis } from 'cad-brep';
import { weld } from './mesh.ts';
import type { Diagnostic } from './scene.ts';
import type { TessellationResult } from './tessellator.ts';

/** A shell whose mesh was turned over: its row, its id (null without one), the signed volume found. */
export interface Turned { shell: number; id: number | null; volume: number }

/**
 * The shells of `d`'s solids whose meshes in `r` enclose volume of the wrong sign: the first member of each solid
 * positive, the rest (voids) negative. Judged only where the shell's mesh is closed and consistently wound (every mesh
 * edge, vertices one where their positions are the same numbers, used as often each way: then the volume doesn't
 * depend on the origin), its faces all have triangles, none is used by another shell, and the volume is larger than
 * the shell's mesh area times `deflection` (a mesh within the deflection of its surface can move the volume by about
 * that much, so a smaller one's sign isn't sure); a void only where its mesh's box is inside the first shell's (a
 * source can put shells side by side in one solid: those aren't voids, and their sign says nothing).
 */
export function wrongShells(d: BrepData, r: Pick<TessellationResult, 'positions' | 'indices' | 'faces'>,
  deflection: number): Turned[] {
  const tris = new Map<number, { start: number; count: number }[]>();
  for (const f of r.faces) {
    if (f.entityId === null || f.count === 0) continue;
    const t = tris.get(f.entityId);
    if (t) t.push(f);
    else tris.set(f.entityId, [f]);
  }
  // Faces by shell, and how many shells use each face.
  const shellFaces = (s: number) => {
    const out: number[] = [];
    for (let j = d.shell.first[s]!, end = j + d.shell.count[s]!; j < end; j++) out.push(d.faceUse.face[j]!);
    return out;
  };
  const shellsOf = new Map<number, number>();
  for (let s = 0; s < d.shell.kind.length; s++) for (const row of new Set(shellFaces(s))) {
    const id = d.face.id[row]!;
    if (id) shellsOf.set(id, (shellsOf.get(id) ?? 0) + 1);
  }
  const { remap } = weld(r.positions);
  // The box of the triangles of a shell's faces (those with triangles).
  const boxOf = (s: number) => {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const row of shellFaces(s)) for (const f of tris.get(d.face.id[row]!) ?? [])
      for (let k = f.start; k < f.start + f.count; k++) for (let c = 0; c < 3; c++) {
        const x = r.positions[3 * r.indices[k]! + c]!;
        if (x < lo[c]!) lo[c] = x;
        if (x > hi[c]!) hi[c] = x;
      }
    return { lo, hi };
  };
  const out: Turned[] = [];
  for (let b = 0; b < d.body.kind.length; b++) {
    if (d.body.kind[b] !== BODY_KIND.solid) continue;
    const first = boxOf(d.member.ref[d.body.first[b]!]!);
    for (let j = d.body.first[b]!, end = j + d.body.count[b]!; j < end; j++) {
      const s = d.member.ref[j]!, outer = j === d.body.first[b];
      const ids = [...new Set(shellFaces(s).map((row) => d.face.id[row]!))];
      if (!ids.length || ids.some((id) => !id || shellsOf.get(id) !== 1 || !tris.has(id))) continue;
      if (!outer) {
        const { lo, hi } = boxOf(s);
        if ([0, 1, 2].some((c) => lo[c]! < first.lo[c]! || hi[c]! > first.hi[c]!)) continue;
      }
      // Closed and consistently wound: each mesh edge's uses one way less the other's zero.
      const use = new Map<number, number>();
      const n = r.positions.length / 3;
      const step = (a: number, c: number) => {
        if (a === c) return;
        const k = a < c ? a * n + c : c * n + a;
        use.set(k, (use.get(k) ?? 0) + (a < c ? 1 : -1));
      };
      let volume = 0, area = 0;
      // (About the first point, for precision.)
      const o = 3 * r.indices[tris.get(ids[0]!)![0]!.start]!;
      const p = (v: number, c: number) => r.positions[3 * v + c]! - r.positions[o + c]!;
      for (const id of ids) for (const f of tris.get(id)!) for (let k = f.start; k < f.start + f.count; k += 3) {
        const [i0, i1, i2] = [r.indices[k]!, r.indices[k + 1]!, r.indices[k + 2]!];
        const [a, c, e] = [remap[i0]!, remap[i1]!, remap[i2]!];
        step(a, c); step(c, e); step(e, a);
        const ax = p(i0, 0), ay = p(i0, 1), az = p(i0, 2), bx = p(i1, 0), by = p(i1, 1), bz = p(i1, 2);
        const cx = p(i2, 0), cy = p(i2, 1), cz = p(i2, 2);
        volume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
        const ux = bx - ax, uy = by - ay, uz = bz - az, wx = cx - ax, wy = cy - ay, wz = cz - az;
        area += Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx) / 2;
      }
      if ([...use.values()].some((x) => x !== 0)) continue;
      if (Math.abs(volume) <= area * deflection) continue;
      if ((volume > 0) !== outer) out.push({ shell: s, id: d.shell.id[s] || null, volume });
    }
  }
  return out;
}

/** The warning for shells turned over (`turned` not empty). */
export function turnedMessage(turned: readonly Turned[]): string {
  const n = turned.length, ids = turned.filter((t) => t.id !== null).slice(0, 10).map((t) => `#${t.id}`);
  return `${n} ${n === 1 ? 'shell' : 'shells'} of solids facing into the material turned over in the mesh (its `
    + `volume of the wrong sign: the source gives ${n === 1 ? 'it' : 'them'} facing the wrong way; the B-rep keeps `
    + `the source's orientation)${ids.length ? `: ${ids.join(', ')}${n > ids.length ? ', ...' : ''}` : ''}`;
}

/**
 * Whether healing oriented the model's shells (its analysis's shell rows say how each faced: cad-heal's orientShells),
 * so a mesh facing otherwise is the backend's doing.
 */
export function shellsOriented(analysis: BrepAnalysis | Uint8Array | undefined): boolean {
  if (!analysis) return false;
  const a = analysis instanceof Uint8Array ? openAnalysis(analysis) : analysis;
  for (let s = 0; s < analysisRowCount(a, 'shell'); s++) if (a.shell.facingFrom[s]) return true;
  return false;
}

/** The warning for shells a backend meshed facing into the material where healing oriented the model's. */
export function againstHealedMessage(turned: readonly Turned[], backend: string): string {
  const n = turned.length, ids = turned.filter((t) => t.id !== null).slice(0, 10).map((t) => `#${t.id}`);
  return `${n} ${n === 1 ? 'shell' : 'shells'} of solids meshed by ${backend} facing into the material, against the `
    + `healed model's orientation, turned over in the mesh${ids.length ? `: ${ids.join(', ')}${n > ids.length
      ? ', ...' : ''}` : ''}`;
}

/**
 * `r` with the meshes of the shells wrongShells finds turned over (triangles wound the other way, normals negated;
 * a vertex they share with faces not turned copied), and a warning naming them; `r` itself where there are none.
 * `healed`, where healing oriented the model's shells (shellsOriented): the backend's name, for a warning that its
 * mesh went against the healed model.
 */
export function orientResult(d: BrepData, r: TessellationResult, deflection: number, healed?: { backend: string }):
  TessellationResult {
  const turned = wrongShells(d, r, deflection);
  if (!turned.length) return r;
  const ids = new Set<number>();
  for (const { shell: s } of turned) for (let j = d.shell.first[s]!, end = j + d.shell.count[s]!; j < end; j++)
    ids.add(d.face.id[d.faceUse.face[j]!]!);
  const flip = (f: TessellationResult['faces'][number]) => f.entityId !== null && ids.has(f.entityId);
  // Vertices used by faces turned and by others: copied for the turned ones.
  const n = r.positions.length / 3, by = new Uint8Array(n);
  for (const f of r.faces) for (let k = f.start; k < f.start + f.count; k++) by[r.indices[k]!]! |= flip(f) ? 1 : 2;
  const copy = new Map<number, number>();
  for (let v = 0; v < n; v++) if (by[v] === 3) copy.set(v, n + copy.size);
  const positions = new Float32Array(3 * (n + copy.size));
  positions.set(r.positions);
  const normals = r.normals ? new Float32Array(positions.length) : undefined;
  if (normals) normals.set(r.normals!);
  for (const [v, w] of copy) for (let c = 0; c < 3; c++) {
    positions[3 * w + c] = r.positions[3 * v + c]!;
    if (normals) normals[3 * w + c] = r.normals![3 * v + c]!;
  }
  if (normals) for (let v = 0; v < n + copy.size; v++) {
    if (v < n ? by[v] !== 1 : false) continue;
    for (let c = 0; c < 3; c++) normals[3 * v + c] = -normals[3 * v + c]!;
  }
  const indices = Uint32Array.from(r.indices);
  for (const f of r.faces) {
    if (!flip(f)) continue;
    for (let k = f.start; k < f.start + f.count; k += 3) {
      const i1 = indices[k + 1]!;
      indices[k + 1] = indices[k + 2]!;
      indices[k + 2] = i1;
      for (let j = 0; j < 3; j++) indices[k + j] = copy.get(indices[k + j]!) ?? indices[k + j]!;
    }
  }
  const note: Diagnostic = { severity: 'warning', message: healed ? againstHealedMessage(turned, healed.backend)
    : turnedMessage(turned) };
  return { ...r, positions, indices, ...(normals ? { normals } : {}), diagnostics: [...r.diagnostics, note] };
}
