// The orthographic camera's geometry: the six views along the world's axes (Z up, millimetres), fitting a box in
// the viewport with a margin ("zoom all", "zoom selected"), and near and far planes that follow the model so it's
// never clipped by them however the camera turns (the user, 2026-10-24; CLAUDE.md, "The viewer").
//
// The frustum is kept in world units: `top` is half the viewport's height in millimetres at zoom 1, and `left`
// and `right` follow the aspect ratio. TrackballControls zooms an orthographic camera through `zoom`.

import * as THREE from 'three';
import type { CameraState } from './view-state.ts';

export type ViewName = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom' | 'iso';

/**
 * Each view's direction from the target to the camera, and its up vector. Front looks along +Y, as CAD systems
 * have it with Z up; top and bottom are the front view turned about X (so bottom has the front edge at the top).
 */
type Vec = readonly [number, number, number];
export const VIEWS: Record<ViewName, { dir: Vec; up: Vec }> = {
  front: { dir: [0, -1, 0], up: [0, 0, 1] },
  back: { dir: [0, 1, 0], up: [0, 0, 1] },
  left: { dir: [-1, 0, 0], up: [0, 0, 1] },
  right: { dir: [1, 0, 0], up: [0, 0, 1] },
  top: { dir: [0, 0, 1], up: [0, 1, 0] },
  bottom: { dir: [0, 0, -1], up: [0, -1, 0] },
  iso: { dir: [1, -1, 1], up: [0, 0, 1] },
};

/** The fraction of the box's extent left free around it when fitting. */
export const MARGIN = 0.05;

const _v = new THREE.Vector3();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _c = new THREE.Vector3();

/** Sets the frustum's sides for the viewport's aspect ratio (width / height), keeping its height. */
export function setAspect(camera: THREE.OrthographicCamera, aspect: number): void {
  camera.left = -camera.top * aspect;
  camera.right = camera.top * aspect;
  camera.updateProjectionMatrix();
}

/**
 * Fits a sphere in the viewport from the camera's current direction (the user, 2026-10-30: spheres for zoom all and
 * zoom selected, so the framing is the same from every direction): the target moves to its centre, the frustum's
 * smaller side spans its diameter less the margin, zoom back to 1. False if it's empty (nothing changes).
 */
export function fitSphere(camera: THREE.OrthographicCamera, target: THREE.Vector3, sphere: THREE.Sphere,
  aspect: number, margin = MARGIN): boolean {
  if (sphere.isEmpty()) return false;
  _z.subVectors(camera.position, target);
  if (_z.lengthSq() === 0) _z.set(...VIEWS.iso.dir);
  _z.normalize();
  // The camera's up, as lookAt would take it (any up will do if it lies along the view).
  _x.crossVectors(camera.up, _z);
  if (_x.lengthSq() < 1e-12) _x.crossVectors(Math.abs(_z.z) < 0.9 ? _v.set(0, 0, 1) : _v.set(0, 1, 0), _z);
  _y.crossVectors(_z, _x.normalize());
  const r = sphere.radius || 1;
  const half = Math.max(r, r / aspect) * (1 + 2 * margin);
  target.copy(sphere.center);
  camera.position.copy(sphere.center).addScaledVector(_z, 2 * r + 1);
  camera.up.copy(_y);
  camera.lookAt(target);
  camera.top = half;
  camera.bottom = -half;
  camera.zoom = 1;
  setAspect(camera, aspect);
  return true;
}

/** Turns the camera to a view (its direction and up), then fits the sphere. */
export function setView(camera: THREE.OrthographicCamera, target: THREE.Vector3, view: ViewName,
  sphere: THREE.Sphere, aspect: number): void {
  const { dir, up } = VIEWS[view];
  camera.up.set(...up);
  camera.position.copy(target).add(_v.set(...dir).normalize());
  if (!fitSphere(camera, target, sphere, aspect)) {
    camera.lookAt(target);
    camera.updateProjectionMatrix();
  }
}

/**
 * Near and far planes just around a bounding sphere, whatever the camera's position: an orthographic projection
 * allows a negative near plane, so the camera never has to back away from the model.
 */
export function clipTo(camera: THREE.OrthographicCamera, sphere: THREE.Sphere): void {
  const forward = camera.getWorldDirection(_v);
  const d = _c.subVectors(sphere.center, camera.position).dot(forward);
  const r = Math.max(sphere.radius, 1) * 1.01;
  if (camera.near === d - r && camera.far === d + r) return;
  camera.near = d - r;
  camera.far = d + r;
  camera.updateProjectionMatrix();
}

const _m = new THREE.Matrix4();

/** A camera's turn: the rotation taking the camera's frame (looking along -Z, Y up) to the state's. */
function turnOf(s: CameraState): THREE.Quaternion {
  _m.lookAt(_v.fromArray(s.position), _c.fromArray(s.target), _y.fromArray(s.up));
  return new THREE.Quaternion().setFromRotationMatrix(_m);
}

/**
 * The camera a fraction `f` of the way from `a` to `b` (replaying a drag in real time, recorder.ts): the turn about
 * the target by the shortest rotation, the target and the distance to it straight, the view's height by ratio (so a
 * zoom goes at an even pace).
 */
export function interpolateCamera(a: CameraState, b: CameraState, f: number): CameraState {
  const turn = turnOf(a).slerp(turnOf(b), f);
  const target = _c.fromArray(a.target).lerp(_v.fromArray(b.target), f).clone();
  const dist = (1 - f) * _x.fromArray(a.position).distanceTo(_z.fromArray(a.target)) +
    f * _x.fromArray(b.position).distanceTo(_z.fromArray(b.target));
  const position = new THREE.Vector3(0, 0, dist).applyQuaternion(turn).add(target);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(turn);
  return { position: position.toArray(), target: target.toArray(), up: up.toArray(),
    height: a.height * (b.height / a.height) ** f };
}
