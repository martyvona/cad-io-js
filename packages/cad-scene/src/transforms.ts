// What a model's transforms do beyond turning, moving and scaling evenly: reflection (a mirror: a negative
// determinant, which takes a right-handed frame to a left-handed one), non-uniform scale (axes scaled differently) and
// shear (axes no longer at right angles: not a turn times a scale per axis, the only form glTF's translation, rotation
// and scale hold). Some formats can't hold all three, so exporters say what they couldn't write and the viewer warns
// before exporting (docs/scene-formats.md). Every format we read and the scene itself are right-handed.

import type { Mat4, Scene } from './scene.ts';
import { partInstances } from './walk.ts';

export type TransformKind = 'reflection' | 'nonUniformScale' | 'shear';
export const TRANSFORM_KINDS: readonly TransformKind[] = ['reflection', 'nonUniformScale', 'shear'];

/**
 * Relative to the axes' lengths: what float32 data (glTF's rotations as quaternions, three.js's and 3MF's numbers)
 * leaves of a plain turn stays under it.
 */
export const TRANSFORM_TOLERANCE = 1e-5;

/** What an affine matrix (column-major) does of the three; none for a degenerate one (an axis of length zero). */
export function transformKinds(m: Mat4): TransformKind[] {
  const a = [m[0]!, m[1]!, m[2]!], b = [m[4]!, m[5]!, m[6]!], d = [m[8]!, m[9]!, m[10]!];
  const c = [a, b, d];
  const len = c.map(([x, y, z]) => Math.hypot(x!, y!, z!));
  if (!len.every((l) => l > 0 && Number.isFinite(l))) return [];
  const dot = (i: number, j: number) => (c[i]![0]! * c[j]![0]! + c[i]![1]! * c[j]![1]! + c[i]![2]! * c[j]![2]!)
    / (len[i]! * len[j]!);
  const det = (a[0]! * (b[1]! * d[2]! - b[2]! * d[1]!) - b[0]! * (a[1]! * d[2]! - a[2]! * d[1]!)
    + d[0]! * (a[1]! * b[2]! - a[2]! * b[1]!)) / (len[0]! * len[1]! * len[2]!);
  const out: TransformKind[] = [];
  if (det < -TRANSFORM_TOLERANCE) out.push('reflection');
  if (Math.max(...len) / Math.min(...len) - 1 > TRANSFORM_TOLERANCE) out.push('nonUniformScale');
  if (Math.abs(dot(0, 1)) > TRANSFORM_TOLERANCE || Math.abs(dot(0, 2)) > TRANSFORM_TOLERANCE
    || Math.abs(dot(1, 2)) > TRANSFORM_TOLERANCE) out.push('shear');
  return out;
}

/** How many transforms do each. */
export type TransformCounts = Record<TransformKind, number>;

export const noTransformCounts = (): TransformCounts => ({ reflection: 0, nonUniformScale: 0, shear: 0 });

/** Adds a transform to counts; the kinds it does. */
export function countTransform(counts: TransformCounts, m: Mat4): TransformKind[] {
  const kinds = transformKinds(m);
  for (const k of kinds) counts[k]++;
  return kinds;
}

export interface TransformUse {
  /** The scene's own transforms: occurrences' and part references' (a tree written as it is: glTF, three.js). */
  own: TransformCounts;
  /** Each placed part's, from its part to the scene (written flat: 3MF's items, glTF's GPU instances). */
  placed: TransformCounts;
}

/** What the scene's transforms do, its own and its placed parts' (composition can shear where no own one does). */
export function transformUse(scene: Scene): TransformUse {
  const own = noTransformCounts(), placed = noTransformCounts();
  for (const c of scene.components) for (const t of [...c.parts, ...c.children]) countTransform(own, t.transform);
  for (const t of [...scene.roots, ...scene.rootParts ?? []]) countTransform(own, t.transform);
  for (const p of partInstances(scene)) countTransform(placed, p.transform);
  return { own, placed };
}

/** Counts as words: `2 mirrored, 1 sheared`; empty for none. */
export function describeTransforms(counts: TransformCounts, only: readonly TransformKind[] = TRANSFORM_KINDS): string {
  const words: Record<TransformKind, string> = { reflection: 'mirrored', nonUniformScale: 'scaled unevenly',
    shear: 'sheared' };
  return only.filter((k) => counts[k]).map((k) => `${counts[k]} ${words[k]}`).join(', ');
}
