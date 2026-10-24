// Test fixtures: a scene (an assembly with two placements of a subassembly holding a plate and a wireframe, a
// third placement hidden) and the parts' meshes.

import { identity, scaling, type Mat4, type Mesh, type Scene } from 'cad-scene';

export const translation = (x: number, y: number, z: number): Mat4 => {
  const m = identity();
  m[12] = x; m[13] = y; m[14] = z;
  return m;
};

// The plate: two triangles (faces 7 and 8) on a unit square, with normals; one shared edge and one seam.
export const plate = (): Mesh => ({
  origin: [1, 0, 0],
  positions: Float32Array.of(0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0.1),
  normals: Float32Array.of(0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1),
  indices: Uint32Array.of(0, 1, 2, 0, 2, 3),
  faces: [{ source: 8, start: 0, count: 3 }, { source: 7, start: 3, count: 3 }],
  edgePositions: Float32Array.of(0, 0, 0, 1, 1, 0, 1, 0, 0, 1, 1, 0, 2, 2, 2),
  edges: [{ source: 4, start: 0, count: 2, kind: 'shared', dihedral: 0.5 },
    { source: null, start: 2, count: 3, kind: 'seam' }],
});
// A wireframe: one curve of three points, and a point.
export const wire = (): Mesh => ({
  origin: [0, 0, 0], positions: new Float32Array(0), indices: new Uint32Array(0), faces: [],
  curvePositions: Float32Array.of(0, 0, 0, 1, 0, 0, 1, 1, 0), curves: [{ source: 9, start: 0, count: 3 }],
  points: Float32Array.of(5, 5, 5), pointSources: [11],
});

// An assembly with two instances of a subassembly holding the plate (in inches; green, face 7 blue; 50% opaque red
// for its second instance by override) and the wireframe; a third, hidden instance. Materials: 0 red half opaque,
// 1 green, 2 blue.
export function scene(): Scene {
  const occ = (component: number, t: Mat4, name?: string) => (
    { component, transform: t, sources: [], properties: {}, ...(name ? { name } : {}) });
  const brep = (name: string, unit: number) => (
    { kind: 'brep' as const, name, sources: [], properties: {}, unit, origin: [0, 0, 0] as [number, number, number],
    format: 'step' as const, payload: () => new Uint8Array() });
  return {
    unit: 'millimetre',
    components: [
      { name: 'asm', sources: [], properties: {}, parts: [],
        children: [occ(1, translation(100, 0, 0), 'left'), occ(1, translation(200, 0, 0)),
          occ(1, translation(300, 0, 0), 'hidden')] },
      { name: 'sub', sources: [], properties: {},
        parts: [{ part: 0, transform: scaling(25.4) }, { part: 1, transform: identity() }], children: [] },
    ],
    roots: [occ(0, translation(0, 0, 5))],
    parts: [{ ...brep('plate', 25.4), material: 1, faceMaterials: [{ face: 7, material: 2 }] }, brep('wire', 1)],
    materials: [{ name: 'red', color: [1, 0, 0], opacity: 0.5, sources: [] },
      { color: [0, 1, 0], opacity: 1, sources: [] }, { color: [0, 0, 1], opacity: 1, sources: [] }],
    layers: [],
    overrides: [{ path: [0, 1], material: 0, sources: [] }, { path: [0, 2], visible: false, sources: [] }],
    properties: {},
    diagnostics: [],
  };
}

