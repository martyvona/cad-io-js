// The orthographic camera's geometry: the six views along the world's axes (Z up, millimetres) and the iso views in
// the file's axes, fitting a box in the viewport with a margin ("zoom all", "zoom selected"), the moves to a view
// (with a fit: lookLegs), and near and far planes that follow the model so it's never clipped by them however the
// camera turns (docs/viewer.md).
//
// The frustum is kept in world units: `top` is half the viewport's height in millimetres at zoom 1, and `left`
// and `right` follow the aspect ratio. TrackballControls zooms an orthographic camera through `zoom`.

import * as THREE from 'three';
import { screwMotion } from 'cad-kinematics';
import type { CameraState } from './view-state.ts';

export type ViewName = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom' | 'iso' | 'isoX' | 'isoY' | 'isoZ';

/**
 * Each view's direction from the target to the camera, and its up vector. Front looks along +Y, as CAD systems
 * have it with Z up; top and bottom are the front view turned about X (so bottom has the front edge at the top).
 * `file`: in the file's own axes (Scene.fileAxes in the world: the gnomon's), else the world's. Iso X, Y and Z put
 * that axis of the file up, Iso Z as a Z-up file's iso and Iso Y as a Y-up file's (glTF's): each the same as `iso`,
 * the world's (Z up), for files of that kind. `iso` is links' and the interface's, no button's.
 */
type Vec = readonly [number, number, number];
export const VIEWS: Record<ViewName, { dir: Vec; up: Vec; file?: true }> = {
  front: { dir: [0, -1, 0], up: [0, 0, 1] },
  back: { dir: [0, 1, 0], up: [0, 0, 1] },
  left: { dir: [-1, 0, 0], up: [0, 0, 1] },
  right: { dir: [1, 0, 0], up: [0, 0, 1] },
  top: { dir: [0, 0, 1], up: [0, 1, 0] },
  bottom: { dir: [0, 0, -1], up: [0, -1, 0] },
  iso: { dir: [1, -1, 1], up: [0, 0, 1] },
  isoX: { dir: [1, 1, 1], up: [1, 0, 0], file: true },
  isoY: { dir: [1, 1, 1], up: [0, 1, 0], file: true },
  isoZ: { dir: [1, -1, 1], up: [0, 0, 1], file: true },
};

/** Look Along an Axis's views, in its order (the keys 1 to 9), with their buttons' names. */
export const AXIS_VIEWS: readonly { view: ViewName; name: string }[] = [
  { view: 'front', name: 'Front' }, { view: 'back', name: 'Back' }, { view: 'left', name: 'Left' },
  { view: 'right', name: 'Right' }, { view: 'top', name: 'Top' }, { view: 'bottom', name: 'Bottom' },
  { view: 'isoX', name: 'Iso X' }, { view: 'isoY', name: 'Iso Y' }, { view: 'isoZ', name: 'Iso Z' }];

/** A view's direction and up in the world, the file's axes (a rotation) under its file views. */
export function viewAxes(view: ViewName, axes?: THREE.Matrix4): { dir: THREE.Vector3; up: THREE.Vector3 } {
  const v = VIEWS[view];
  const dir = new THREE.Vector3(...v.dir), up = new THREE.Vector3(...v.up);
  if (v.file && axes) {
    dir.transformDirection(axes);
    up.transformDirection(axes);
  }
  return { dir: dir.normalize(), up: up.normalize() };
}

/**
 * The iso view of the file's axis nearest the world's up (`iso`'s, which shows it the same): Iso Z for a Z-up file,
 * Iso Y for a Y-up one.
 */
export function upIso(axes?: THREE.Matrix4): ViewName {
  if (!axes) return 'isoZ';
  const e = axes.elements;
  const k = [0, 1, 2].reduce((a, b) => (e[b * 4 + 2]! > e[a * 4 + 2]! ? b : a), 2);
  return (['isoX', 'isoY', 'isoZ'] as const)[k]!;
}

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
 * Fits a sphere in the viewport from the camera's current direction (spheres for zoom all and zoom selected, so the
 * framing is the same from every direction): the target moves to its centre, the frustum's smaller side spans its
 * diameter less the margin, zoom back to 1. `aspect` is the view's, which the frustum takes; `fitAspect` the part of it
 * to fit in (the width beside the controls: Viewer.fitAspect), the view's if absent. False if the sphere is empty
 * (nothing changes).
 */
export function fitSphere(camera: THREE.OrthographicCamera, target: THREE.Vector3, sphere: THREE.Sphere,
  aspect: number, fitAspect = aspect, margin = MARGIN): boolean {
  if (sphere.isEmpty()) return false;
  _z.subVectors(camera.position, target);
  if (_z.lengthSq() === 0) _z.set(...VIEWS.iso.dir);
  _z.normalize();
  // The camera's up, as lookAt would take it (any up will do if it lies along the view).
  _x.crossVectors(camera.up, _z);
  if (_x.lengthSq() < 1e-12) _x.crossVectors(Math.abs(_z.z) < 0.9 ? _v.set(0, 0, 1) : _v.set(0, 1, 0), _z);
  _y.crossVectors(_z, _x.normalize());
  const r = sphere.radius || 1;
  const half = Math.max(r, r / fitAspect) * (1 + 2 * margin);
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

/**
 * A camera turned to look along a view's axis (its direction and up; a file view's in `axes`, the file's) about the
 * same target, from the same distance, with the same height and pan (the views turn about the orbit centre, leaving
 * zoom and pan alone).
 */
export function viewCamera(s: CameraState, view: ViewName, axes?: THREE.Matrix4): CameraState {
  const { dir, up } = viewAxes(view, axes);
  const target = new THREE.Vector3().fromArray(s.target);
  const d = new THREE.Vector3().fromArray(s.position).distanceTo(target) || 1;
  return { position: dir.multiplyScalar(d).add(target).toArray(), target: s.target,
    up: up.toArray(), height: s.height, ...(s.pan ? { pan: s.pan } : {}) };
}

/** The camera `fitSphere` would make from `s` (its direction kept), as a state; `s` itself if the sphere is empty. */
export function fitCamera(s: CameraState, sphere: THREE.Sphere, aspect: number): CameraState {
  const cam = new THREE.OrthographicCamera();
  cam.position.fromArray(s.position);
  cam.up.fromArray(s.up);
  const target = new THREE.Vector3().fromArray(s.target);
  if (!fitSphere(cam, target, sphere, aspect)) return s;
  return { position: cam.position.toArray(), target: target.toArray(), up: cam.up.toArray(),
    height: (cam.top - cam.bottom) / cam.zoom };
}

/** Easing in and out over [0, 1] (3t^2 - 2t^3), clamped. */
export function smoothstep(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
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
/** A camera state's turn, as a camera's quaternion. */
export function turnOf(s: CameraState): THREE.Quaternion {
  _m.lookAt(_v.fromArray(s.position), _c.fromArray(s.target), _y.fromArray(s.up));
  return new THREE.Quaternion().setFromRotationMatrix(_m);
}

/**
 * The camera a fraction `f` of the way from `a` to `b` (replaying a drag in real time, recorder.ts): the turn about
 * the target by the shortest rotation, the target, the distance to it and the pan straight, the view's height by
 * ratio (so a zoom goes at an even pace).
 */
export function interpolateCamera(a: CameraState, b: CameraState, f: number): CameraState {
  const turn = turnOf(a).slerp(turnOf(b), f);
  const target = _c.fromArray(a.target).lerp(_v.fromArray(b.target), f).clone();
  const dist = (1 - f) * _x.fromArray(a.position).distanceTo(_z.fromArray(a.target)) +
    f * _x.fromArray(b.position).distanceTo(_z.fromArray(b.target));
  const position = new THREE.Vector3(0, 0, dist).applyQuaternion(turn).add(target);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(turn);
  const pan: [number, number] = [0, 1].map((k) => (1 - f) * (a.pan?.[k] ?? 0) + f * (b.pan?.[k] ?? 0)) as
    [number, number];
  return { position: position.toArray(), target: target.toArray(), up: up.toArray(),
    height: a.height * (b.height / a.height) ** f, ...(pan[0] || pan[1] ? { pan } : {}) };
}

/**
 * A camera state's frame (lookAt's: x right, y up, z from the target towards the camera) and its view's centre: the
 * target less the pan (the pan draws the target that far right and up of the centre: Viewer.shift).
 */
function frameOf(s: CameraState): { x: THREE.Vector3; y: THREE.Vector3; z: THREE.Vector3; centre: THREE.Vector3;
  distance: number } {
  const target = new THREE.Vector3().fromArray(s.target);
  const z = new THREE.Vector3().fromArray(s.position).sub(target);
  const distance = z.length();
  if (distance === 0) z.set(...VIEWS.iso.dir);
  z.normalize();
  const x = new THREE.Vector3().fromArray(s.up).cross(z);
  if (x.lengthSq() < 1e-24) x.crossVectors(Math.abs(z.z) < 0.9 ? new THREE.Vector3(0, 0, 1)
    : new THREE.Vector3(0, 1, 0), z);
  x.normalize();
  const y = new THREE.Vector3().crossVectors(z, x);
  const centre = target.clone().addScaledVector(x, -(s.pan?.[0] ?? 0)).addScaledVector(y, -(s.pan?.[1] ?? 0));
  return { x, y, z, centre, distance };
}

/** The same view with no pan: the orbit centre moved to the view's centre (nothing drawn moves). */
export function centred(s: CameraState): CameraState {
  if (!s.pan) return s;
  const f = frameOf(s);
  return { position: f.centre.clone().addScaledVector(f.z, f.distance).toArray(), target: f.centre.toArray(),
    up: f.y.toArray(), height: s.height };
}

/** How a move to a view that fits goes (the View's Look and fit). */
export type LookMotion = 'steps' | 'together';

/**
 * One leg of a move: `zoom` the view's height alone (about the view's centre), `orbit` the camera's pose along the
 * screw motion between the two (screwCamera), `blend` everything at once (interpolateCamera). `ms`: its share of the
 * move's time, as a multiple of a flight's.
 */
export interface Leg { kind: 'zoom' | 'orbit' | 'blend'; from: CameraState; to: CameraState; ms: number }

/** How close two cameras must be for a leg between them to be skipped (fractions of the view's height; radians). */
const SAME = 1e-9;

/**
 * The height that shows a sphere whole, with the margin, from a camera without moving or turning it: the sphere's
 * centre where it is in the view, `fitAspect` the free width's (fitSphere's).
 */
export function heightShowing(s: CameraState, sphere: THREE.Sphere, fitAspect: number, margin = MARGIN): number {
  const f = frameOf(s);
  const off = sphere.center.clone().sub(f.centre);
  const r = sphere.radius || 1;
  return 2 * Math.max(Math.abs(off.dot(f.y)) + r, (Math.abs(off.dot(f.x)) + r) / fitAspect) * (1 + 2 * margin);
}

/**
 * The legs of a move from `from` to `to` (a view's camera, fitted). `together`: one blend. `steps`: zoom out until
 * `model` shows whole (the camera neither moving nor turning), orbit to `to`'s pose at that height, zoom to `to`'s
 * height; each leg left out where the camera is there already, and the zoom out where there's no orbit (nothing to
 * see the model whole for).
 */
export function lookLegs(from: CameraState, to: CameraState, motion: LookMotion, model: THREE.Sphere,
  fitAspect: number): Leg[] {
  if (motion === 'together') return [{ kind: 'blend', from, to, ms: 1 }];
  const legs: Leg[] = [];
  let at = centred(from);
  const a = frameOf(at), b = frameOf(to);
  const turn = Math.max(a.x.angleTo(b.x), a.y.angleTo(b.y), a.z.angleTo(b.z));
  const orbit = turn > SAME || a.centre.distanceTo(b.centre) > SAME * at.height;
  const out = model.isEmpty() || !orbit ? 0 : heightShowing(at, model, fitAspect);
  if (out > at.height * (1 + SAME)) {
    const next = { ...at, height: out };
    legs.push({ kind: 'zoom', from: at, to: next, ms: 0.5 });
    at = next;
  }
  if (orbit) {
    const next = { ...centred(to), height: at.height };
    legs.push({ kind: 'orbit', from: at, to: next, ms: 1 });
    at = next;
  }
  if (Math.abs(to.height / at.height - 1) > SAME) legs.push({ kind: 'zoom', from: at, to, ms: 0.5 });
  return legs;
}

/**
 * The camera a fraction `f` of the way along a screw motion (cad-kinematics' screwMotion) between two cameras' frames
 * at their views' centres: turning about one axis while sliding along it at an even pace (Chasles' theorem), the
 * distance from the camera to the centre (which an orthographic view doesn't show) and the height by ratio between
 * theirs. No pan: the centre is the orbit centre throughout.
 */
export function screwCamera(a: CameraState, b: CameraState): (f: number) => CameraState {
  const pose = (s: CameraState) => {
    const { x, y, z, centre, distance } = frameOf(s);
    return { m: new THREE.Matrix4().makeBasis(x, y, z).setPosition(centre).elements, distance };
  };
  const pa = pose(a), pb = pose(b);
  const motion = screwMotion(pa.m, pb.m);
  return (f) => {
    const m = new THREE.Matrix4().fromArray(Array.from(motion.at(f)));
    const centre = new THREE.Vector3().setFromMatrixPosition(m);
    const y = new THREE.Vector3().setFromMatrixColumn(m, 1), z = new THREE.Vector3().setFromMatrixColumn(m, 2);
    const d = (1 - f) * pa.distance + f * pb.distance;
    return { position: centre.clone().addScaledVector(z, d).toArray(), target: centre.toArray(), up: y.toArray(),
      height: a.height * (b.height / a.height) ** f };
  };
}

/** A leg's camera a fraction `f` of the way (eased by the caller). */
export function legCamera(leg: Leg): (f: number) => CameraState {
  if (leg.kind === 'orbit') return screwCamera(leg.from, leg.to);
  if (leg.kind === 'blend') return (f) => interpolateCamera(leg.from, leg.to, f);
  const { from, to } = leg;
  return (f) => ({ ...from, height: from.height * (to.height / from.height) ** f });
}
