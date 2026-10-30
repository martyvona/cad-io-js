import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import * as THREE from 'three';
import { LoadFit } from '../src/load-fit.ts';

/** A LoadFit on a fake clock, recording the radii it zooms to. */
function fitter() {
  mock.timers.enable({ apis: ['setTimeout'] });
  let t = 0;
  const state = { moved: false, zooms: [] as number[][] };
  const fit = new LoadFit((s) => state.zooms.push([s.radius, ...s.center.toArray()]), () => state.moved, () => t);
  const tick = (ms: number) => { t += ms; mock.timers.tick(ms); };
  return { fit, state, tick };
}
const at = (x: number, r: number) => new THREE.Sphere(new THREE.Vector3(x, 0, 0), r);

test('LoadFit: the estimate at once; growth at most once a second, the last put off; only out; the end at once',
  () => {
  const { fit, state, tick } = fitter();
  try {
    fit.start({ center: [0, 0, 0], radius: 10, from: 'estimated' });
    assert.deepEqual(state.zooms, [[10, 0, 0, 0]]);
    // Inside: nothing. Outside, within the second: put off, then once at the second, the latest size.
    fit.add(at(1, 2));
    tick(100);
    fit.add(at(15, 1));
    tick(100);
    fit.add(at(18, 2));
    assert.equal(state.zooms.length, 1);
    tick(799);
    assert.equal(state.zooms.length, 1);
    tick(1);
    assert.deepEqual(state.zooms.at(-1), [20, 0, 0, 0]);
    // Past the second: at once. The centre kept.
    tick(2000);
    fit.add(at(-25, 0));
    assert.deepEqual(state.zooms.at(-1), [25, 0, 0, 0]);
    assert.deepEqual(fit.sphere.radius, 25);
    // The end: the sphere made again (smaller, elsewhere) for zoom all, but the last zoom stays out.
    fit.end({ center: [-2, 0, 0], radius: 22, from: 'meshes' });
    assert.deepEqual(state.zooms.slice(3), [[25, 0, 0, 0]]);
    assert.deepEqual([fit.sphere.radius, fit.sphere.center.x], [22, -2]);
  } finally { mock.timers.reset(); }
});

test("LoadFit: the end zooms at once, a growth put off replaced; a file's sphere doesn't grow; moved: no zooms",
  () => {
  const { fit, state, tick } = fitter();
  try {
    fit.start({ center: [0, 0, 0], radius: 10, from: 'estimated' });
    fit.add(at(20, 0));
    fit.end();
    assert.deepEqual(state.zooms, [[10, 0, 0, 0], [20, 0, 0, 0]]);
    tick(5000);
    assert.equal(state.zooms.length, 2);
    // The file's: kept as it is, whatever arrives or ends.
    fit.start({ center: [1, 2, 3], radius: 5, from: 'source' });
    fit.add(at(100, 1));
    fit.end({ center: [0, 0, 0], radius: 50, from: 'meshes' });
    assert.deepEqual(state.zooms.slice(2), [[5, 1, 2, 3], [5, 1, 2, 3]]);
    assert.equal(fit.sphere.radius, 5);
    // No sphere at first: the first mesh's.
    fit.start();
    assert.equal(state.zooms.length, 4);
    tick(5000);
    fit.add(at(7, 3));
    assert.deepEqual(state.zooms.at(-1), [3, 7, 0, 0]);
    // Moved: the spheres still grow, but nothing zooms, even at the end.
    state.moved = true;
    fit.add(at(-7, 3));
    tick(5000);
    fit.end({ center: [0, 0, 0], radius: 10, from: 'meshes' });
    assert.equal(state.zooms.length, 5);
    assert.equal(fit.sphere.radius, 10);
    // A new load forgets one put off.
    state.moved = false;
    fit.start({ center: [0, 0, 0], radius: 1, from: 'estimated' });
    fit.add(at(5, 1));
    fit.start({ center: [0, 0, 0], radius: 2, from: 'estimated' });
    tick(5000);
    assert.deepEqual(state.zooms.slice(5), [[1, 0, 0, 0], [2, 0, 0, 0]]);
  } finally { mock.timers.reset(); }
});
