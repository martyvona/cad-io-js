import assert from 'node:assert/strict';
import { test } from 'node:test';
import { identity, sceneFromTree, type TreeNode } from '../src/index.ts';

const at = (x: number, y: number, z: number) => {
  const m = identity();
  m[12] = x; m[13] = y; m[14] = z;
  return m;
};

test('other files: a node\'s `edges` child of lines its mesh\'s edges, in the node\'s frame (its matrix applied)',
  () => {
    const tri = { key: 't', mode: 'triangles' as const, positions: Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0),
      indices: Uint32Array.of(0, 1, 2), groups: [{ start: 0, count: 3 }] };
    const line = { key: 'l', mode: 'lines' as const, positions: Float32Array.of(0, 0, 0, 1, 0, 0), groups: [] };
    const edges: TreeNode = { name: 'edges', matrix: at(0, 0, 2), visible: true, meshes: [line], children: [] };
    const part: TreeNode = { name: 'p', matrix: identity(), visible: true, meshes: [tri], children: [edges] };
    const root: TreeNode = { name: '', matrix: identity(), visible: true, meshes: [], children: [part] };
    const { scene } = sceneFromTree(root, { frame: identity() });
    // One part, placed (a node of meshes and its own lines is a placed part; the root's only content, so a root part),
    // no component for the edges; its segment lifted by the edges node's matrix.
    assert.deepEqual(scene.components, []);
    assert.deepEqual(scene.rootParts!.map((r) => [r.name, r.part]), [['p', 0]]);
    const mesh = scene.parts[0]!.lods[0]!.mesh;
    assert.deepEqual(Array.from(mesh.edgePositions!), [0, 0, 2, 1, 0, 2]);
    assert.deepEqual(mesh.edges, [{ source: null, start: 0, count: 2, kind: 'shared' }]);
    // Beside two meshes too: the node's meshes are one part, merged (a face per group of each), the edges its.
    part.meshes = [tri, { ...tri, key: 'u', indices: Uint32Array.of(0, 1, 2, 0, 2, 1), groups: [{ start: 0, count: 3 },
      { start: 3, count: 3 }] }];
    const two = sceneFromTree(root, { frame: identity() }).scene;
    assert.deepEqual(two.components, []);
    assert.equal(two.parts.length, 1);
    const merged = two.parts[0]!.lods[0]!.mesh;
    assert.deepEqual(merged.faces, [{ source: 0, start: 0, count: 3 }, { source: 1, start: 3, count: 3 },
      { source: 2, start: 6, count: 3 }]);
    assert.deepEqual(Array.from(merged.indices), [0, 1, 2, 3, 4, 5, 3, 5, 4]);
    assert.deepEqual(Array.from(merged.edgePositions!), [0, 0, 2, 1, 0, 2]);
    // Under a node of its own, a part reference of that node's component, named as its node.
    const holder: TreeNode = { name: 'h', matrix: identity(), visible: true, meshes: [], children: [part,
      { ...part, name: 'q', matrix: at(5, 0, 0), visible: false }] };
    const held = sceneFromTree({ ...root, children: [holder] }, { frame: identity() }).scene;
    assert.deepEqual(held.components.map((c) => [c.name, c.parts.map((r) => [r.name, r.part, r.visible]),
      c.children.length]), [['', [], 1], ['h', [['p', 0, undefined], ['q', 0, false]], 0]]);
    // The root a container (a file's scene): its nodes the roots.
    const contained = sceneFromTree({ ...root, children: [holder] }, { frame: identity(), container: true }).scene;
    assert.deepEqual(contained.components.map((c) => c.name), ['h']);
    assert.deepEqual([...held.components[1]!.parts[1]!.transform].slice(12, 15), [5, 0, 0]);
  });
