import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { Gnomon, gnomonShown } from '../src/gnomon.ts';

const near = (a: number, b: number, what: string) => assert.ok(Math.abs(a - b) < 1e-12, `${what}: ${a} vs ${b}`);

/**
 * The smallest sphere holding the origin and three tips is centred where the gnomon turns (its scene's origin): the
 * tips equally far from it, in their own plane (a centre off it is farther from all three), the origin no farther.
 */
function assertCentred(g: Gnomon): void {
  const [o, x, y, z] = g.points as [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3];
  const r = x.length();
  near(r, Math.sqrt(6) / 3, 'radius');
  near(y.length(), r, 'Y tip');
  near(z.length(), r, 'Z tip');
  const normal = new THREE.Vector3().subVectors(y, x).cross(new THREE.Vector3().subVectors(z, x)).normalize();
  near(normal.dot(x), 0, 'centre in the tips\' plane');
  assert.ok(o.length() <= r + 1e-12, `origin inside: ${o.length()}`);
}

test('the gnomon: the world\'s axes where the file has none, centred on the smallest sphere round its points', () => {
  const g = new Gnomon();
  g.set(undefined, new THREE.Matrix4());
  assertCentred(g);
  const [o, x, y, z] = g.points as THREE.Vector3[];
  // Each tip one unit from the origin along its axis.
  for (const [tip, axis] of [[x, [1, 0, 0]], [y, [0, 1, 0]], [z, [0, 0, 1]]] as const) {
    const d = new THREE.Vector3().subVectors(tip!, o!);
    for (let i = 0; i < 3; i++) near(d.getComponent(i), axis[i]!, `${tip === x ? 'X' : tip === y ? 'Y' : 'Z'}[${i}]`);
  }
});

test('the gnomon: a file\'s Y up as the scene\'s Z, under the model\'s turn; its scale and place dropped', () => {
  const g = new Gnomon();
  // glTF's axes in the scene's: X -> X, Y -> Z, Z -> -Y.
  const yUp = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1];
  g.set(yUp, new THREE.Matrix4());
  assertCentred(g);
  const dir = (k: number) => new THREE.Vector3().subVectors(g.points[k]!, g.points[0]!);
  assert.deepEqual(dir(2).toArray().map((v) => Math.round(v)), [0, 0, 1]);
  assert.deepEqual(dir(3).toArray().map((v) => Math.round(v)), [0, -1, 0]);
  // The model turned 90 degrees about Z, scaled by 3 and moved: the file's X along the world's Y, lengths 1.
  const world = new THREE.Matrix4().compose(new THREE.Vector3(10, 20, 30),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2), new THREE.Vector3(3, 3, 3));
  g.set(yUp, world);
  assertCentred(g);
  const x = dir(1);
  near(x.x, 0, 'X.x');
  near(x.y, 1, 'X.y');
  near(x.z, 0, 'X.z');
  near(dir(3).x, 1, 'Z.x');
});

test('the gnomon starts shown, unless remembered hidden; off in check and shot pages; ?gnomon= decides', () => {
  assert.equal(gnomonShown('', null), true);
  assert.equal(gnomonShown('?model=a.stp', '1'), true);
  assert.equal(gnomonShown('', '0'), false);
  assert.equal(gnomonShown('?check', null), false);
  assert.equal(gnomonShown('?controls=0', null), false);
  assert.equal(gnomonShown('?controls=1', null), true);
  assert.equal(gnomonShown('?check&gnomon=1', '0'), true);
  assert.equal(gnomonShown('?gnomon=0', '1'), false);
});
