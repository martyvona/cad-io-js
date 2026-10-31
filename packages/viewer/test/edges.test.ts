import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { EDGE_GRID_MM, findEdges } from '../src/edges.ts';

const found = (g: THREE.BufferGeometry, angle: number, scale: number) => Array.from(findEdges(
  g.getAttribute('position').array, g.getIndex()?.array, angle, scale));

test('findEdges: three.js\'s EdgesGeometry exactly at its 4 places, on shapes indexed and not', () => {
  const shapes = [new THREE.BoxGeometry(1, 2, 3), new THREE.SphereGeometry(5, 12, 8),
    new THREE.TorusGeometry(10, 2, 8, 24), new THREE.CylinderGeometry(1, 2, 3, 9, 1, true),
    new THREE.BoxGeometry(1, 2, 3).toNonIndexed()];
  for (const g of shapes) {
    for (const angle of [1, 10, 40]) {
      assert.deepEqual(found(g, angle, 1e4), Array.from(new THREE.EdgesGeometry(g, angle).getAttribute('position')
        .array), `${g.type} at ${angle} degrees`);
    }
  }
});

test('findEdges: vertices one or apart by the grid; 1 um in the world', () => {
  assert.equal(EDGE_GRID_MM, 0.001);
  // Two triangles in one plane sharing an edge whose ends differ by 2e-5 between them: on a grid of 1e-4 one vertex
  // each (no edge between them, only the outline: 4 segments); on 1e-5 apart (the shared edge open on both sides: 6).
  const p = [0, 0, 0, 1, 0, 0, 0, 1, 0, 1.00002, 0, 0, 1, 1, 0, 0.00002, 1, 0];
  assert.equal(findEdges(p, undefined, 10, 1e4).length / 6, 4);
  assert.equal(findEdges(p, undefined, 10, 1e5).length / 6, 6);
});
