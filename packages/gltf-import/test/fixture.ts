// The test scene, as threejs-import's: a part placed twice in one component (once hidden by its reference), three
// instances of that component (one recoloured by override, one hidden), faces, edges, a curve and a point.

import { addLod, identity, multiply, scaling, type Mat4, type Mesh, type Scene } from 'cad-scene';

const translation = (x: number, y: number, z: number): Mat4 => {
  const m = identity();
  m[12] = x; m[13] = y; m[14] = z;
  return m;
};

// As threejs-import's fixture: the plate (faces 8, 7 blue, 9; an edge and a seam) and the wire (a curve, a point);
// three instances of a subassembly placing the plate twice (the second hidden by its reference) and the wire, the
// second instance red by override, the third hidden.
const plate = (): Mesh => ({
  origin: [1, 0, 0],
  positions: Float32Array.of(0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0.1, 2, 2, 0),
  normals: Float32Array.of(0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1),
  indices: Uint32Array.of(0, 1, 2, 0, 2, 3, 1, 4, 2),
  faces: [{ source: 8, start: 0, count: 3 }, { source: 7, start: 3, count: 3 }, { source: 9, start: 6, count: 3 }],
  edgePositions: Float32Array.of(0, 0, 0, 1, 1, 0, 1, 0, 0, 1, 1, 0, 2, 2, 2),
  edges: [{ source: 4, start: 0, count: 2, kind: 'shared', dihedral: 0.5 },
    { source: null, start: 2, count: 3, kind: 'seam' }],
});
const wire = (): Mesh => ({
  origin: [0, 0, 0], positions: new Float32Array(0), indices: new Uint32Array(0), faces: [],
  curvePositions: Float32Array.of(0, 0, 0, 1, 0, 0, 1, 1, 0), curves: [{ source: 9, start: 0, count: 3 }],
  points: Float32Array.of(5, 5, 5), pointSources: [11],
});
export function scene(): Scene {
  const occ = (component: number, t: Mat4, name?: string) => ({ component, transform: t,
    sources: [{ format: 'step', id: 100 + component }], properties: {}, ...(name ? { name } : {}) });
  const part = (name: string) => ({ name, sources: [{ format: 'step', id: 50 }], properties: { pn: 'X-1' }, unit: 1,
    origin: [0, 0, 0] as [number, number, number], lods: [] });
  const s: Scene = {
    unit: 'millimetre',
    components: [
      { name: 'asm', sources: [], properties: {}, parts: [],
        children: [occ(1, translation(100, 0, 0), 'left'), occ(1, translation(200, 0, 0)),
          occ(1, translation(300, 0, 0), 'hidden')] },
      { name: 'sub', sources: [{ format: 'step', id: 7 }], properties: { rev: 'B' },
        parts: [{ part: 0, transform: scaling(25.4) }, { part: 0, transform: multiply(translation(0, 50, 0),
          scaling(25.4)), visible: false }, { part: 1, transform: identity() }], children: [] },
    ],
    roots: [occ(0, translation(0, 0, 5))],
    parts: [{ ...part('plate'), material: 1, faceMaterials: [{ face: 7, material: 2 }], closed: true },
      part('wire')],
    materials: [{ name: 'red', color: [1, 0, 0], opacity: 0.5, sources: [] },
      { color: [0, 1, 0], opacity: 1, sources: [] }, { color: [0, 0, 1], opacity: 1, sources: [] }],
    layers: [],
    overrides: [{ path: [0, 1], material: 0, sources: [] }, { path: [0, 2], visible: false, sources: [] }],
    properties: { schema: 'AP214' },
    diagnostics: [],
  };
  addLod(s.parts[0]!, { mesh: plate(), from: 'tessellated' });
  addLod(s.parts[1]!, { mesh: wire(), from: 'tessellated' });
  return s;
}

