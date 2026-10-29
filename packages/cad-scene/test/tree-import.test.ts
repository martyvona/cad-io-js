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
    // One part, no component for the edges; its segment lifted by the edges node's matrix.
    assert.deepEqual(scene.components.map((c) => [c.name, c.parts.length, c.children.length]), [['', 0, 1],
      ['p', 1, 0]]);
    const mesh = scene.parts[0]!.lods[0]!.mesh;
    assert.deepEqual(Array.from(mesh.edgePositions!), [0, 0, 2, 1, 0, 2]);
    assert.deepEqual(mesh.edges, [{ source: null, start: 0, count: 2, kind: 'shared' }]);
    // Beside two meshes it's a part of its own: whose edges it holds is unknown.
    part.meshes = [tri, { ...tri, key: 'u' }];
    const two = sceneFromTree(root, { frame: identity() }).scene;
    assert.deepEqual(two.components.map((c) => c.name), ['', 'p', 'edges']);
  });
