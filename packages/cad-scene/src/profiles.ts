// Meshing profiles: named pairs of deflections, the one place their values and the default are defined (the user,
// 2026-10-26; CLAUDE.md, "Decisions"). Every consumer (tessellateScene, stepconv, the viewer) takes them from here.
// Measured over the corpus with OCCT against the earlier default, 0.1 mm and 0.5 rad
// (workdir/2026-10-26_mesh_profiles): coarse 0.59 times its triangles, medium 1.25 times (the median part 1.7), fine
// 3.3 times.

export type MeshProfile = 'coarse' | 'medium' | 'fine';

/** A mesh's tolerances: the distance from the surface in millimetres, the angle between normals in radians. */
export interface Deflections {
  linearDeflection: number;
  angularDeflection: number;
}

const deg = (d: number) => (d * Math.PI) / 180;

export const MESH_PROFILES: Readonly<Record<MeshProfile, Readonly<Deflections>>> = {
  coarse: { linearDeflection: 0.2, angularDeflection: deg(30) },
  medium: { linearDeflection: 0.1, angularDeflection: deg(15) },
  fine: { linearDeflection: 0.05, angularDeflection: deg(7.5) },
};

export const MESH_PROFILE_NAMES = Object.keys(MESH_PROFILES) as readonly MeshProfile[];

/** The profile when none is named (the viewer's on phones and tablets is coarse: see its device.ts). */
export const DEFAULT_MESH_PROFILE: MeshProfile = 'medium';

/**
 * The deflections for a profile (default DEFAULT_MESH_PROFILE), each replaced by the value given, if any: so
 * `{ profile: 'fine', linearDeflection: 0.03 }` is fine's angle with a 0.03 mm distance.
 */
export function meshDeflections(o: { profile?: MeshProfile; linearDeflection?: number; angularDeflection?: number }
  = {}): Deflections {
  const p = MESH_PROFILES[o.profile ?? DEFAULT_MESH_PROFILE];
  if (!p) throw new Error(`unknown meshing profile: ${o.profile}`);
  return { linearDeflection: o.linearDeflection ?? p.linearDeflection,
    angularDeflection: o.angularDeflection ?? p.angularDeflection };
}

/** The profile whose deflections these are exactly, if any (else they're custom). */
export function meshProfileOf(d: Deflections): MeshProfile | undefined {
  return MESH_PROFILE_NAMES.find((n) => MESH_PROFILES[n].linearDeflection === d.linearDeflection &&
    MESH_PROFILES[n].angularDeflection === d.angularDeflection);
}
