// The axes gnomon (View's Axes): the file's own axes (Scene.fileAxes, turned by the model's place in the world), X red,
// Y green, Z blue, turning with the view, each labelled with its lowercase letter beyond its tip. A scene and camera
// of its own, drawn after the composed frame into a viewport over the view (index.html's #gnomon box, sized here), its
// depth cleared first and its colour not, so the model shows around it, and without the section planes. It turns about
// the centre of the smallest sphere holding its four points (the origin and the three tips), not about the origin: for
// perpendicular unit axes that sphere's centre is the tips' centroid and its radius sqrt(6)/3 (the origin lies inside
// it, sqrt(3)/3 from the centre).
//
// Labels: each centred on its placement point, (1 + LABEL_GAP) along its axis, projected, in a square box of LABEL_BOX
// pixels (one for every letter, not fitted to it); boxes that overlap are nudged sideways apart (layoutLabels), never
// the fourth, unlabelled box at the origin, which the others clear. The labels and the origin box are click targets
// (Viewer: an axis looks along it, the origin box the iso view), a finger's reaching further (TOUCH_REACH).
// An axis along the line of sight shows as a symbol in the origin's box (axisSymbol): a ringed dot pointing at the
// viewer, a ringed cross pointing away, its ring filled with the view's background, fading in over SYMBOL_FADE. The #gnomon box holds every layout the labels can
// take (GNOMON_EXTENT, checked over sampled turns by the unit test), so nothing leaves it as the gnomon turns.
//
// Antialiasing as the view's (Rendering's SMAA): with it on, the gnomon is drawn over a copy of the canvas's pixels
// under its box (copyFramebufferToTexture), that smoothed by an SMAA pass of its own, and only the pixels the gnomon
// touched (its own or SMAA's blend into them: alpha above 0, the copy's being 0) put back, so what's under it isn't
// smoothed twice. Rendering into a texture writes linear values, the canvas sRGB ones: there the colours are set as
// their sRGB numbers taken as linear (raw), so they and their blending come out as on the canvas.
//
// The view cube (View's Cube): a cube of side CUBE_SIZE in the axes' frame, in the positive octant CUBE_GAP off each
// axis, so the axes run beside three of its edges and an axis's symbol where they meet stays clear of it; the labels
// clear its outline on the screen as they clear each other (layoutLabels' `obstacle`), and a label it would move far
// is hidden instead (labelsLayout: no click on it either) until it can be near its tip again. Its faces are lettered
// for the world's views they face (F front, K back, L left, R right, T top, M bottom), each letter upright as that
// view shows it; its edges fat lines over its faces (the faces' polygon offset behind them: thin lines lying in the
// faces' planes fought them for depth and came out dashed on high-DPI screens). A click on it (after the labels,
// before the origin's box) hits a corner or an edge within CUBE_REACH pixels of where it's drawn, either side (outside
// the cube too), a seen one (a face of it toward the viewer), else the face it's on (cubeFeatureAt); each as the signs
// of that place from the cube's centre in the file's axes.
//
// Labels move smoothly: each rides its placement point (which turns with the view, as its tip does), its nudge changing
// at most NUDGE_SPEED as the view turns freely, and during a flight (Viewer's eased moves to a view) blended from what
// it was to the destination's layout as the camera's turn is, so each label ends the flight where it belongs.

import * as THREE from 'three';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { VIEWS, type ViewName } from './camera.ts';

/** The axes' colours, X, Y, Z: readable on the dark and the light themes' backgrounds. */
export const AXIS_COLOURS = [0xff4040, 0x30c030, 0x4080ff] as const;
/** The lines' width, CSS pixels. */
const WIDTH = 2;
/** An axis's length on the screen, CSS pixels. */
export const AXIS_PIXELS = 34;
/** How far beyond its tip a label's placement point is, in axis lengths. */
export const LABEL_GAP = 0.3;
/** The labels' (and the origin box's) square box, CSS pixels. */
export const LABEL_BOX = 14;
/** How far from a target's centre a finger's tap hits it, CSS pixels (its drawn box's half for a mouse). */
export const TOUCH_REACH = 20;
/**
 * How far the gnomon (its lines, its cube, and every label box however nudged) can reach from its sphere's centre, CSS
 * pixels (wider than high: labels pushed sideways off the cube, MAX_CUBE_NUDGE at most): the most over every turn
 * (gnomon.test.ts samples them), rounded up. The #gnomon box is this big, the centre placed `left` and `down` from its
 * lower left corner.
 */
export const GNOMON_EXTENT = { left: 47, right: 47, down: 44, up: 44 };
/** How fast a label's nudge may change while the view turns freely, CSS pixels a second. */
export const NUDGE_SPEED = 120;
/** The longest time between frames a nudge's change counts, seconds: after a pause, the next frame isn't a jump. */
const MAX_STEP = 0.05;
/** The sphere's radius, the axes being of unit length. */
const RADIUS = Math.sqrt(6) / 3;

/**
 * What a click on the gnomon hits: an axis's label, the box at its origin, or a part of the view cube (`cube`: its
 * place from the cube's centre in the file's axes, each -1, 0 or 1; one not 0 a face, two an edge, three a corner).
 */
export type GnomonTarget = 'x' | 'y' | 'z' | 'iso' | { cube: [number, number, number] };

/** The view cube's side, in axis lengths. */
export const CUBE_SIZE = 0.6;
/**
 * How far the view cube is from each axis (its corner nearest the origin at this in each), in axis lengths: clear of
 * an axis's symbol where they meet (SYMBOL's ring, 6.75 pixels to its stroke's outside) looking along that axis.
 */
export const CUBE_GAP = 0.24;
/** How far from a corner, and from an edge, where they're drawn, a click is theirs, CSS pixels. */
export const CUBE_REACH = { corner: 7, edge: 5 };
/** The cube's edges' width, CSS pixels. */
const CUBE_EDGE_WIDTH = 1.25;
/** The face views (camera.ts's VIEWS), each lettered on the cube's face that faces it. */
export const CUBE_LETTERS: Partial<Record<ViewName, string>> = { front: 'F', back: 'K', left: 'L', right: 'R',
  top: 'T', bottom: 'M' };

/**
 * The corner or edge of the view cube at a point (CSS pixels), if any: `corners` the cube's eight drawn (corner c at
 * x = c & 1, y = c >> 1 & 1, z = c >> 2 & 1 of its own coordinates), `front` whether each face looks toward the viewer
 * (face k * 2 for the low side of axis k, + 1 the high). The nearest seen corner within CUBE_REACH.corner, else the
 * nearest seen edge within CUBE_REACH.edge (seen: a face of it toward the viewer), as the signs of its place from the
 * cube's centre (an edge's 0 along it).
 */
export function cubeFeatureAt(p: Point2, corners: readonly Point2[], front: readonly boolean[]):
  [number, number, number] | undefined {
  const sign = (c: number, k: number) => (c >> k & 1 ? 1 : -1);
  const seen = (c: number, axes: number[]) => axes.some((k) => front[k * 2 + (c >> k & 1)]);
  let best: { d: number; signs: [number, number, number] } | undefined;
  for (let c = 0; c < 8; c++) {
    if (!seen(c, [0, 1, 2])) continue;
    const d = Math.hypot(p.x - corners[c]!.x, p.y - corners[c]!.y);
    if (d <= CUBE_REACH.corner && (!best || d < best.d)) best = { d, signs: [sign(c, 0), sign(c, 1), sign(c, 2)] };
  }
  if (best) return best.signs;
  for (let c = 0; c < 8; c++) for (let k = 0; k < 3; k++) {
    if (c >> k & 1) continue;
    const others = [0, 1, 2].filter((j) => j !== k);
    if (!seen(c, others)) continue;
    const a = corners[c]!, b = corners[c | 1 << k]!;
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
    const d = Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
    if (d <= CUBE_REACH.edge && (!best || d < best.d)) {
      const signs: [number, number, number] = [0, 0, 0];
      for (const j of others) signs[j] = sign(c, j);
      best = { d, signs };
    }
  }
  return best?.signs;
}

/**
 * Each face of the cube (its axis and side in the file's axes, as `${k}${sign}`: '0+' the +X face) and the face view
 * it gets, the view whose direction is nearest the face's outward normal in the world, with that view's up in the
 * file's axes (the nearest axis, signed): `axes` the file's axes in the world.
 */
export function cubeFaces(axes: THREE.Matrix4): Map<string, { view: ViewName; up: THREE.Vector3 }> {
  const inverse = axes.clone().invert();
  const out = new Map<string, { view: ViewName; up: THREE.Vector3 }>();
  const snap = (v: THREE.Vector3) => {
    const a = [Math.abs(v.x), Math.abs(v.y), Math.abs(v.z)];
    const k = a.indexOf(Math.max(...a));
    return { k, sign: Math.sign(v.getComponent(k)) || 1 };
  };
  for (const view of Object.keys(CUBE_LETTERS) as ViewName[]) {
    const n = snap(new THREE.Vector3(...VIEWS[view].dir).transformDirection(inverse));
    const u = snap(new THREE.Vector3(...VIEWS[view].up).transformDirection(inverse));
    const key = `${n.k}${n.sign > 0 ? '+' : '-'}`;
    if (!out.has(key)) out.set(key, { view, up: new THREE.Vector3().setComponent(u.k, u.sign) });
  }
  return out;
}

export interface Point2 {
  x: number;
  y: number;
}

/**
 * Label centres for the three placement points (screen pixels, any origin, y up) with the fixed box at `origin`, every
 * box `size` square: boxes that overlap are moved sideways apart, a pair of labels each by half, a label alone from the
 * origin box; each pair parts the way their placement points lie (lower index left where they're level). `beside`: the
 * label of the axis whose symbol is in the origin's box (axisSymbol), which parts from that box to the side farthest
 * from the other two labels (besideSide), however its placement point lies.
 */
export function layoutLabels(points: readonly Point2[], origin: Point2, size: number, beside?: number,
  obstacle?: readonly Point2[], skip?: ReadonlySet<number>): Point2[] {
  const start = [...points, origin];
  const at = start.map((p) => ({ x: p.x, y: p.y }));
  const fixed = start.length - 1;
  const side = beside === undefined ? 0 : besideSide(points, origin, size, beside);
  const middle = obstacle?.length ? obstacle.reduce((m, p) => m + p.x, 0) / obstacle.length : 0;
  // Whether a box moved by dx would overlap the obstacle.
  const blocked = (p: Point2, dx: number) => {
    const span = obstacle?.length ? bandSpan(obstacle, p.y - size / 2, p.y + size / 2) : undefined;
    return !!span && p.x + dx + size / 2 > span.lo + 1e-9 && p.x + dx - size / 2 < span.hi - 1e-9;
  };
  for (let pass = 0; pass < 200; pass++) {
    let moved = false;
    // Off the obstacle, sideways: to the side its point lies; level with the origin's box, the side it clears that
    // box to (else each would push it back onto the other).
    if (obstacle?.length) {
      for (let i = 0; i < fixed; i++) {
        if (skip?.has(i)) continue;
        const a = at[i]!, span = bandSpan(obstacle, a.y - size / 2, a.y + size / 2);
        if (!span || a.x + size / 2 <= span.lo || a.x - size / 2 >= span.hi) continue;
        const level = Math.abs(a.y - origin.y) < size;
        const s = (i === beside && side) || (level ? Math.sign(start[i]!.x - origin.x)
          : Math.sign(start[i]!.x - middle)) || -1;
        const to = s > 0 ? span.hi + size / 2 : span.lo - size / 2;
        if (Math.abs(to - a.x) <= 1e-9) continue;
        a.x = to;
        moved = true;
      }
    }
    for (let i = 0; i < at.length; i++) {
      for (let j = i + 1; j < at.length; j++) {
        if (skip?.has(i) || skip?.has(j)) continue;
        const a = at[i]!, b = at[j]!;
        if (Math.abs(a.y - b.y) >= size || Math.abs(a.x - b.x) >= size) continue;
        // i goes to side s of j.
        const s = (j === fixed && i === beside && side) || Math.sign(start[i]!.x - start[j]!.x) || -1;
        const need = size - s * (a.x - b.x);
        if (need <= 1e-9) continue;
        if (j === fixed) a.x += s * need;
        // (One of them against the obstacle, the other moves the whole way.)
        else if (blocked(a, s * need / 2) && !blocked(b, -s * need)) b.x -= s * need;
        else if (blocked(b, -s * need / 2) && !blocked(a, s * need)) a.x += s * need;
        else {
          a.x += s * need / 2;
          b.x -= s * need / 2;
        }
        moved = true;
      }
    }
    if (!moved) break;
  }
  return at.slice(0, fixed);
}

/**
 * The x across a convex polygon (in order round it) between two heights, or none where it doesn't reach them: its
 * corners between them and where its sides cross them.
 */
export function bandSpan(polygon: readonly Point2[], y0: number, y1: number): { lo: number; hi: number } | undefined {
  let lo = Infinity, hi = -Infinity;
  const take = (x: number) => {
    lo = Math.min(lo, x);
    hi = Math.max(hi, x);
  };
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]!, b = polygon[(i + 1) % polygon.length]!;
    if (a.y >= y0 && a.y <= y1) take(a.x);
    for (const y of [y0, y1]) {
      if ((a.y - y) * (b.y - y) < 0) take(a.x + (b.x - a.x) * (y - a.y) / (b.y - a.y));
    }
  }
  return lo <= hi ? { lo, hi } : undefined;
}

/** The convex hull of points, in order round it (Andrew's monotone chain). */
export function hull(points: readonly Point2[]): Point2[] {
  const p = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const cross = (o: Point2, a: Point2, b: Point2) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const half = (list: Point2[]) => {
    const h: Point2[] = [];
    for (const q of list) {
      while (h.length >= 2 && cross(h[h.length - 2]!, h[h.length - 1]!, q) <= 0) h.pop();
      h.push(q);
    }
    h.pop();
    return h;
  };
  return [...half(p), ...half(p.reverse())];
}

/**
 * The side of the origin's box (-1 left, 1 right) for label `k` beside it: the one whose place (a box's width from the
 * origin's centre, level with it) is farther from the nearer of the other two labels' placement points; 0 on a tie.
 */
export function besideSide(points: readonly Point2[], origin: Point2, size: number, k: number): -1 | 0 | 1 {
  const others = points.filter((_, i) => i !== k);
  const room = (s: number) => Math.min(...others.map((p) => Math.hypot(p.x - (origin.x + s * size), p.y - origin.y)));
  const d = room(1) - room(-1);
  return Math.abs(d) < 1e-9 ? 0 : d > 0 ? 1 : -1;
}

/**
 * How far the view cube may move a label from where it'd be without it (labelsLayout), CSS pixels: further, it's
 * hidden.
 */
export const MAX_CUBE_NUDGE = LABEL_BOX;

/**
 * The labels' nudges (where layoutLabels puts them less their placement points) for a projection, `beside` the label of
 * the axis whose symbol shows in the origin's box, if one does; with `cube`, the view cube's outline cleared too, and a
 * label the cube would move further than MAX_CUBE_NUDGE from where it'd be without it hidden instead (the farthest
 * first, the rest laid out again without it), its nudge none.
 */
export function labelsLayout(p: { placements: Point2[]; origin: Point2; cube?: Point2[] }, beside?: number,
  cube = false): { nudges: Point2[]; hidden: boolean[] } {
  const hidden = new Set<number>();
  const without = cube ? layoutLabels(p.placements, p.origin, LABEL_BOX, beside) : [];
  for (;;) {
    const at = layoutLabels(p.placements, p.origin, LABEL_BOX, beside, cube ? p.cube : undefined, hidden);
    const nudges = at.map((l, k) => (hidden.has(k) ? { x: 0, y: 0 } : { x: l.x - p.placements[k]!.x,
      y: l.y - p.placements[k]!.y }));
    let far = -1, most = MAX_CUBE_NUDGE;
    if (cube) {
      for (const [k, l] of at.entries()) {
        const d = hidden.has(k) ? 0 : Math.hypot(l.x - without[k]!.x, l.y - without[k]!.y);
        if (d > most) [far, most] = [k, d];
      }
    }
    if (far < 0) return { nudges, hidden: [0, 1, 2].map((k) => hidden.has(k)) };
    hidden.add(far);
  }
}

/** The labels' nudges (labelsLayout's). */
export function nudgesOf(p: { placements: Point2[]; origin: Point2; cube?: Point2[] }, beside?: number,
  cube = false): Point2[] {
  return labelsLayout(p, beside, cube).nudges;
}

/** The symbol's axis for a turn of the axes relative to the view (project's), if one shows. */
const symbolAxis = (turn: THREE.Matrix4) => axisSymbol([0, 1, 2].map((k) => turn.elements[k * 4 + 2]!))?.axis;

/** Nudges moved from `shown` towards `target`, each by at most `step` pixels. */
export function stepNudges(shown: readonly Point2[], target: readonly Point2[], step: number): Point2[] {
  return shown.map((a, k) => {
    const b = target[k]!, d = Math.hypot(b.x - a.x, b.y - a.y);
    return d <= step ? { ...b } : { x: a.x + (b.x - a.x) * step / d, y: a.y + (b.y - a.y) * step / d };
  });
}

/**
 * Where the gnomon's points are on the screen for a turn of its axes relative to the view (`axes`, columns the axes in
 * the camera's frame): the sphere's centre at (0, 0), CSS pixels, y up. `placements` the labels' points, `tips` the
 * lines' ends, `origin` where they meet.
 */
export function project(axes: THREE.Matrix4): { tips: Point2[]; placements: Point2[]; origin: Point2;
  cube: Point2[] } {
  const e = axes.elements;
  const col = (k: number) => new THREE.Vector3(e[k * 4]!, e[k * 4 + 1]!, e[k * 4 + 2]!);
  const centre = col(0).add(col(1)).add(col(2)).divideScalar(3);
  const px = (v: THREE.Vector3) => ({ x: (v.x - centre.x) * AXIS_PIXELS, y: (v.y - centre.y) * AXIS_PIXELS });
  const corner = (c: number) => px(new THREE.Vector3().addScaledVector(col(0), CUBE_GAP + (c & 1) * CUBE_SIZE)
    .addScaledVector(col(1), CUBE_GAP + (c >> 1 & 1) * CUBE_SIZE).addScaledVector(col(2), CUBE_GAP + (c >> 2 & 1)
    * CUBE_SIZE));
  return { tips: [0, 1, 2].map((k) => px(col(k))), placements: [0, 1, 2].map((k) => px(col(k)
    .multiplyScalar(1 + LABEL_GAP))), origin: px(new THREE.Vector3()), cube: hull([0, 1, 2, 3, 4, 5, 6, 7]
    .map(corner)) };
}

/** How opaque a label's backing is: a little off the view's background (backingColour), veiling what's behind. */
export const BACKING_OPACITY = 0.75;
/** How far a backing's colour is from the view's background, towards white on dark ones, black on light ones. */
const BACKING_TINT = 0.15;

/** A label's backing's colour for a view's background: a shade lighter on a dark one, darker on a light one. */
export function backingColour(background: THREE.Color): THREE.Color {
  const dark = background.getHSL({ h: 0, s: 0, l: 0 }, THREE.SRGBColorSpace).l < 0.5;
  return background.clone().lerp(new THREE.Color(dark ? 0xffffff : 0x000000), BACKING_TINT);
}
/** The backing's corners' radius, CSS pixels. */
const BACKING_RADIUS = 3;

/**
 * A label's backing: a square of rounded corners, white on transparent, as an alpha map (its green channel). Not as a
 * colour map: filtering mixes in the transparent texels' black, a dark fringe at every edge once tinted.
 */
function backingTexture(): THREE.CanvasTexture {
  const n = 64, r = n * BACKING_RADIUS / LABEL_BOX;
  const canvas = Object.assign(document.createElement('canvas'), { width: n, height: n });
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#fff';
  // (arcTo, not roundRect: older Safari lacks it.)
  g.beginPath();
  g.moveTo(r, 0);
  g.arcTo(n, 0, n, n, r);
  g.arcTo(n, n, 0, n, r);
  g.arcTo(0, n, 0, 0, r);
  g.arcTo(0, 0, n, 0, r);
  g.closePath();
  g.fill();
  return new THREE.CanvasTexture(canvas);
}

/** The symbol of an axis along the line of sight: its ring's radius, its stroke, its dot's radius, CSS pixels. */
export const SYMBOL = { ring: 6, stroke: 1.5, dot: 2.25, arm: 3.75 };
/** How far off the line of sight an axis's symbol starts fading in, and where it's whole, degrees. */
export const SYMBOL_FADE = { from: 10, whole: 3 };

/**
 * An axis's symbol along the line of sight, as an alpha map (as the backing's) the label box's size: a ring with a
 * dot (`head`: the axis points at the viewer, an arrow's head) or a cross (its tail).
 */
function symbolTexture(head: boolean): THREE.CanvasTexture {
  const n = 64, k = n / LABEL_BOX, c = n / 2;
  const canvas = Object.assign(document.createElement('canvas'), { width: n, height: n });
  const g = canvas.getContext('2d')!;
  g.strokeStyle = g.fillStyle = '#fff';
  g.lineWidth = SYMBOL.stroke * k;
  g.lineCap = 'round';
  g.beginPath();
  g.arc(c, c, SYMBOL.ring * k, 0, 2 * Math.PI);
  g.stroke();
  g.beginPath();
  if (head) {
    g.arc(c, c, SYMBOL.dot * k, 0, 2 * Math.PI);
    g.fill();
  } else {
    const a = SYMBOL.arm * k / Math.SQRT2;
    g.moveTo(c - a, c - a);
    g.lineTo(c + a, c + a);
    g.moveTo(c - a, c + a);
    g.lineTo(c + a, c - a);
    g.stroke();
  }
  return new THREE.CanvasTexture(canvas);
}

/** The inside of a symbol's ring, filled, as an alpha map the label box's size (to the ring's middle). */
function discTexture(): THREE.CanvasTexture {
  const n = 64, c = n / 2;
  const canvas = Object.assign(document.createElement('canvas'), { width: n, height: n });
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#fff';
  g.beginPath();
  g.arc(c, c, SYMBOL.ring * n / LABEL_BOX, 0, 2 * Math.PI);
  g.fill();
  return new THREE.CanvasTexture(canvas);
}

/**
 * The symbol for axes `back` (each axis's part along the view's back, a unit's): the axis within SYMBOL_FADE.from
 * degrees of the line of sight (one at most), whether it points at the viewer, and how much shown.
 */
export function axisSymbol(back: readonly number[]): { axis: number; head: boolean; opacity: number } | undefined {
  const cos = (deg: number) => Math.cos(deg * Math.PI / 180);
  const k = back.findIndex((z) => Math.abs(z) > cos(SYMBOL_FADE.from));
  if (k < 0) return undefined;
  const t = (Math.abs(back[k]!) - cos(SYMBOL_FADE.from)) / (cos(SYMBOL_FADE.whole) - cos(SYMBOL_FADE.from));
  return { axis: k, head: back[k]! > 0, opacity: Math.min(1, t) };
}

/**
 * A letter's alpha map (as the backing's): white on transparent, its x-height centred; `capital`, a capital's height
 * centred and smaller (the cube's faces).
 */
function letterTexture(letter: string, capital = false): THREE.CanvasTexture {
  const n = 64;
  const canvas = Object.assign(document.createElement('canvas'), { width: n, height: n });
  const g = canvas.getContext('2d')!;
  g.font = `600 ${Math.round(n * (capital ? 0.6 : 0.8))}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  g.fillStyle = '#fff';
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  const height = g.measureText(capital ? 'H' : 'x').actualBoundingBoxAscent;
  g.fillText(letter, n / 2, n / 2 + height / 2);
  return new THREE.CanvasTexture(canvas);
}

export class Gnomon {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 4);
  /** The labels, in pixels of the viewport (labelCamera). */
  private readonly labelScene = new THREE.Scene();
  private readonly labelCamera = new THREE.OrthographicCamera(0, 1, 1, 0, -1, 1);
  private labels?: THREE.Object3D[];
  /** The labels' backings' material, its colour set from the view's background at each draw. */
  private backing?: THREE.MeshBasicMaterial;
  /** Holds the axes in the world's frame (`set`), moved so the sphere's centre is at the origin. */
  private readonly axes = new THREE.Group();
  /** The file's axes in the world, columns of unit length. */
  private readonly frame = new THREE.Matrix4();
  /** The last drawn layout's boxes' centres, CSS pixels from the viewport's lower left: x, y, z, then the origin. */
  private boxes: Point2[] = [];
  /**
   * The labels' nudges as drawn: following the layout's at NUDGE_SPEED as the view turns freely, or blended from what
   * they were to the destination's during a flight; undefined, the layout's at the next draw (a new model).
   */
  private nudges?: Point2[];
  /** The flight being followed (Viewer's, by identity) and the nudges it goes from and to. */
  private flight?: { id: object; from: Point2[]; to: Point2[] };
  /** When the last draw was (performance.now()). */
  private last = -Infinity;
  /** The labels are still on their way to the layout's places: more frames wanted. */
  moving = false;
  /** Each label hidden (x, y, z), as last laid out: the view cube in its way (labelsLayout). */
  hiddenLabels = [false, false, false];
  /** Whether the view cube is drawn (and clicked). */
  showCube = true;
  /** The view cube (in `axes`, the file's axes), made at the first draw and for each new frame (`set`). */
  private cube?: THREE.Group;
  private cubeStale = true;
  /** Its faces' fill, letters' and edges' materials, coloured from the view's background at each draw. */
  private cubeMaterials?: { face: THREE.MeshBasicMaterial; letter: THREE.MeshBasicMaterial[];
    edge: LineMaterial };
  /** Which face view each of the cube's faces gets (cubeFaces). */
  private faces = cubeFaces(new THREE.Matrix4());
  /** The box last drawn into, CSS pixels: for clicks on the cube. */
  private drawnSize = { width: 0, height: 0 };
  /** The symbol of the axis along the line of sight, if one is (axisSymbol), as last laid out. */
  symbol?: { axis: number; head: boolean; opacity: number };
  private symbolMesh?: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  /** Behind the symbol, inside its ring: the view's background, opaque (but as the symbol fades). */
  private disc?: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private symbolMaps?: { head: THREE.Texture; tail: THREE.Texture };
  /**
   * Smoothing's (drawSmoothed): the canvas's pixels under the box, the gnomon drawn over them, SMAA's result, the pass,
   * and the quads that copy the pixels in (alpha 0) and put the gnomon's back; for a size of the box in device pixels.
   */
  private smoothing?: { width: number; height: number; under: THREE.FramebufferTexture;
    drawn: THREE.WebGLRenderTarget; out: THREE.WebGLRenderTarget; smaa: SMAAPass; copy: FullScreenQuad;
    put: FullScreenQuad };

  constructor() {
    for (const [i, colour] of AXIS_COLOURS.entries()) {
      const g = new LineSegmentsGeometry().setPositions([0, 0, 0, i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0]);
      const line = new LineSegments2(g, new LineMaterial({ color: colour, linewidth: WIDTH }));
      line.name = 'XYZ'[i]!;
      this.axes.add(line);
    }
    this.axes.matrixAutoUpdate = false;
    this.scene.add(this.axes);
  }

  /** The #gnomon box's size, CSS pixels. */
  static get size(): { width: number; height: number } {
    return { width: GNOMON_EXTENT.left + GNOMON_EXTENT.right, height: GNOMON_EXTENT.down + GNOMON_EXTENT.up };
  }

  /**
   * The file's axes in the world: `fileAxes` (Scene.fileAxes; undefined, the world's) under `world`, the model's place
   * (its turn only: scale and translation dropped).
   */
  set(fileAxes: ArrayLike<number> | undefined, world: THREE.Matrix4): void {
    // (extractRotation drops the scale and translation; fileAxes is a rotation alone.)
    this.frame.extractRotation(world);
    if (fileAxes) this.frame.multiply(new THREE.Matrix4().fromArray(Array.from(fileAxes)));
    const e = this.frame.elements;
    // The tips' centroid to the origin.
    const centre = new THREE.Vector3(e[0]! + e[4]! + e[8]!, e[1]! + e[5]! + e[9]!, e[2]! + e[6]! + e[10]!)
      .divideScalar(3);
    this.axes.matrix.copy(this.frame).premultiply(new THREE.Matrix4().makeTranslation(centre.negate()));
    this.axes.matrixWorldNeedsUpdate = true;
    this.nudges = undefined;
    this.faces = cubeFaces(this.frame);
    this.cubeStale = true;
  }

  /** The face view a part of the cube stands for (a face's), if it's one. */
  cubeView(signs: readonly number[]): ViewName | undefined {
    const k = signs.findIndex((x) => x !== 0);
    if (k < 0 || signs.filter((x) => x !== 0).length !== 1) return undefined;
    return this.faces.get(`${k}${signs[k]! > 0 ? '+' : '-'}`)?.view;
  }

  /** The view cube's part under a point (CSS pixels from the viewport's lower left), as last drawn. */
  private cubeAt(x: number, y: number): [number, number, number] | undefined {
    if (!this.showCube || !this.cube || !this.drawnSize.width) return undefined;
    const ndc = new THREE.Vector2(x / this.drawnSize.width * 2 - 1, y / this.drawnSize.height * 2 - 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    // A corner or an edge where it's drawn (cubeFeatureAt), else the face hit.
    this.cube.updateWorldMatrix(true, false);
    const back = new THREE.Vector3(0, 0, 1).applyQuaternion(this.camera.quaternion);
    const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((c) => {
      const q = this.cube!.localToWorld(new THREE.Vector3(c & 1, c >> 1 & 1, c >> 2 & 1).multiplyScalar(CUBE_SIZE))
        .project(this.camera);
      return { x: (q.x + 1) / 2 * this.drawnSize.width, y: (q.y + 1) / 2 * this.drawnSize.height };
    });
    const front = [0, 1, 2].flatMap((k) => [-1, 1].map((s) => new THREE.Vector3().setComponent(k, s)
      .transformDirection(this.cube!.matrixWorld).dot(back) > 1e-6));
    const feature = cubeFeatureAt({ x, y }, corners, front);
    if (feature) return feature;
    const fills = this.cube.children.filter((c) => c.userData.fill);
    const key = ray.intersectObjects(fills, false)[0]?.object.userData.fill as string | undefined;
    if (!key) return undefined;
    const signs: [number, number, number] = [0, 0, 0];
    signs[Number(key[0])] = key[1] === '+' ? 1 : -1;
    return signs;
  }

  /** The axes in the frame of a camera turned so (columns: each axis's right, up and back there). */
  private turnFor(q: THREE.Quaternion): THREE.Matrix4 {
    return new THREE.Matrix4().makeRotationFromQuaternion(q).invert().multiply(this.frame);
  }

  /** The origin and the three tips where they're drawn in the gnomon's scene, for checks. */
  get points(): THREE.Vector3[] {
    return [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]].map((p) => new THREE.Vector3().fromArray(p)
      .applyMatrix4(this.axes.matrix));
  }

  /** The file's axes in the world (unit columns). */
  get axesInWorld(): THREE.Matrix4 {
    return this.frame.clone();
  }

  /** The last drawn boxes' centres (x, y, z, origin), CSS pixels from the viewport's lower left, for checks. */
  get layout(): Point2[] {
    return this.boxes.map((b) => ({ ...b }));
  }

  /**
   * What's at a point (CSS pixels from the viewport's lower left) in the last drawn layout: a label's box or the
   * origin's, reaching `reach` pixels from its centre across and up (its drawn box's half by default; TOUCH_REACH for a
   * finger), the nearest centre where reaches overlap.
   */
  hit(x: number, y: number, reach = LABEL_BOX / 2): GnomonTarget | undefined {
    let best: number | undefined, nearest = Infinity;
    for (const [k, b] of this.boxes.entries()) {
      if (this.hiddenLabels[k] || Math.abs(x - b.x) > reach || Math.abs(y - b.y) > reach) continue;
      const d = Math.hypot(x - b.x, y - b.y);
      if (d < nearest) [best, nearest] = [k, d];
    }
    // (The cube under the labels, over the origin's box: its corner there is the cube's.)
    if (best === undefined || best === 3) {
      const cube = this.cubeAt(x, y);
      if (cube) return { cube };
    }
    return best === undefined ? undefined : (['x', 'y', 'z', 'iso'] as const)[best];
  }

  /**
   * Draws over what's on the canvas: looking as `view` looks (its turn), into `box` (CSS pixels from the canvas's
   * bottom left, as setViewport takes them; Gnomon.size), the sphere's centre at GNOMON_EXTENT's left and down; the
   * labels' backings a shade off `background`, the view's. `motion`: the time, and the flight in progress (its
   * identity, its destination's turn, and how far it has come, smoothstepped as the camera is). `smaa`: antialiased as
   * the view is with Rendering's SMAA (drawSmoothed), where the box lies within the canvas.
   */
  draw(renderer: THREE.WebGLRenderer, view: THREE.Camera, box: { x: number; y: number; width: number;
    height: number }, background: THREE.Color, motion: { now: number; flight?: { id: object;
    to: THREE.Quaternion; s: number } } = { now: 0 }, smaa = false): void {
    view.getWorldQuaternion(this.camera.quaternion);
    this.camera.position.set(0, 0, 2).applyQuaternion(this.camera.quaternion);
    this.camera.updateMatrixWorld();
    // The lines' camera: axis lengths across the viewport, the sphere's centre (the scene's origin) where it belongs.
    const cx = GNOMON_EXTENT.left, cy = GNOMON_EXTENT.down;
    Object.assign(this.camera, { left: -cx / AXIS_PIXELS, right: (box.width - cx) / AXIS_PIXELS,
      bottom: -cy / AXIS_PIXELS, top: (box.height - cy) / AXIS_PIXELS });
    this.camera.updateProjectionMatrix();
    this.advance(this.camera.quaternion, motion);
    this.layOut(box);
    this.drawnSize = { width: box.width, height: box.height };
    this.makeCube();
    this.cube!.visible = this.showCube;
    const pr = renderer.getPixelRatio(), canvas = renderer.getDrawingBufferSize(new THREE.Vector2());
    // (In device pixels as setViewport makes them: each rounded.)
    const px = { x: Math.round(box.x * pr), y: Math.round(box.y * pr), width: Math.round(box.width * pr),
      height: Math.round(box.height * pr) };
    const smooth = smaa && px.x >= 0 && px.y >= 0 && px.width > 0 && px.height > 0 && px.x + px.width <= canvas.x &&
      px.y + px.height <= canvas.y;
    this.paint(background, smooth);
    const viewport = renderer.getViewport(new THREE.Vector4());
    const scissor = renderer.getScissor(new THREE.Vector4());
    const scissorTest = renderer.getScissorTest();
    const autoClear = renderer.autoClear;
    const target = renderer.getRenderTarget();
    // (The section planes are the renderer's global clipping planes: not the gnomon's.)
    const planes = renderer.clippingPlanes;
    try {
      renderer.clippingPlanes = [];
      renderer.setRenderTarget(null);
      renderer.autoClear = false;
      renderer.setViewport(box.x, box.y, box.width, box.height);
      renderer.setScissor(box.x, box.y, box.width, box.height);
      renderer.setScissorTest(true);
      if (smooth) this.drawSmoothed(renderer, px);
      else {
        renderer.clearDepth();
        renderer.render(this.scene, this.camera);
        renderer.render(this.labelScene, this.labelCamera);
      }
    } finally {
      renderer.setRenderTarget(target);
      renderer.setViewport(viewport);
      renderer.setScissor(scissor);
      renderer.setScissorTest(scissorTest);
      renderer.autoClear = autoClear;
      renderer.clippingPlanes = planes;
    }
  }

  /** The colours: as sRGB (the canvas's), or `raw`, their sRGB numbers taken as linear (drawSmoothed's texture). */
  private paint(background: THREE.Color, raw: boolean): void {
    const set = (c: THREE.Color, hex: number) => c.setHex(hex, raw ? THREE.LinearSRGBColorSpace : THREE.SRGBColorSpace);
    for (const [i, line] of this.axes.children.slice(0, 3).entries()) {
      set((line as LineSegments2).material.color, AXIS_COLOURS[i]!);
    }
    for (const [i, label] of this.labels!.entries()) {
      set(((label.children[1] as THREE.Mesh).material as THREE.MeshBasicMaterial).color, AXIS_COLOURS[i]!);
    }
    set(this.backing!.color, backingColour(background).getHex());
    set(this.disc!.material.color, background.getHex());
    if (this.symbol) set(this.symbolMesh!.material.color, AXIS_COLOURS[this.symbol.axis]!);
    const c = this.cubeMaterials!, dark = background.getHSL({ h: 0, s: 0, l: 0 }, THREE.SRGBColorSpace).l < 0.5;
    set(c.face.color, backingColour(background).getHex());
    for (const l of c.letter) set(l.color, dark ? 0xe0e0e0 : 0x303030);
    set(c.edge.color, dark ? 0x909090 : 0x707070);
  }

  /**
   * The view cube, made again for a new frame: a fill per face, its letter just outside it, upright as its view shows
   * it, and its edges; CUBE_GAP off the axes.
   */
  private makeCube(): void {
    if (!this.cubeStale && this.cube) return;
    this.cubeStale = false;
    if (this.cube) {
      this.axes.remove(this.cube);
      this.cube.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    }
    if (!this.cubeMaterials) {
      // (The faces behind their edges by a polygon offset: the edges win the depth test where they lie on them.)
      this.cubeMaterials = { face: new THREE.MeshBasicMaterial({ polygonOffset: true, polygonOffsetFactor: 1,
        polygonOffsetUnits: 1 }), letter: [], edge: new LineMaterial({ linewidth: CUBE_EDGE_WIDTH }) };
    }
    const m = this.cubeMaterials;
    const cube = new THREE.Group();
    cube.name = 'cube';
    cube.position.setScalar(CUBE_GAP);
    const h = CUBE_SIZE / 2;
    for (const [key, { view, up }] of this.faces) {
      const k = Number(key[0]), sign = key[1] === '+' ? 1 : -1;
      const normal = new THREE.Vector3().setComponent(k, sign);
      const right = new THREE.Vector3().crossVectors(up, normal);
      const basis = new THREE.Matrix4().makeBasis(right, up, normal)
        .setPosition(new THREE.Vector3(h, h, h).addScaledVector(normal, h));
      const plane = new THREE.PlaneGeometry(CUBE_SIZE, CUBE_SIZE);
      const fill = new THREE.Mesh(plane, m.face);
      fill.applyMatrix4(basis);
      fill.userData.fill = key;
      let material = m.letter.find((l) => l.userData.letter === CUBE_LETTERS[view]);
      if (!material) {
        material = new THREE.MeshBasicMaterial({ alphaMap: letterTexture(CUBE_LETTERS[view]!, true),
          transparent: true, depthWrite: false });
        material.userData.letter = CUBE_LETTERS[view];
        m.letter.push(material);
      }
      const letter = new THREE.Mesh(plane, material);
      letter.applyMatrix4(basis.clone().multiply(new THREE.Matrix4().makeTranslation(0, 0, 0.002)));
      letter.renderOrder = 1;
      cube.add(fill, letter);
    }
    const box = new THREE.BoxGeometry(CUBE_SIZE, CUBE_SIZE, CUBE_SIZE).translate(h, h, h);
    const edges = new THREE.EdgesGeometry(box);
    cube.add(new LineSegments2(new LineSegmentsGeometry().setPositions(edges.getAttribute('position').array as
      Float32Array), m.edge));
    edges.dispose();
    box.dispose();
    this.axes.add(cube);
    this.cube = cube;
  }

  /**
   * The gnomon antialiased by SMAA (see the file's comment), into the canvas's `px` (device pixels from its lower
   * left), the canvas's viewport and scissor set to the box: its pixels copied, drawn over, smoothed, the touched ones
   * put back.
   */
  private drawSmoothed(renderer: THREE.WebGLRenderer, px: { x: number; y: number; width: number; height: number }):
    void {
    let t = this.smoothing;
    if (t?.width !== px.width || t.height !== px.height) {
      if (t) for (const x of [t.under, t.drawn, t.out, t.smaa]) x.dispose();
      const vertexShader = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * ' +
        'modelViewMatrix * vec4(position, 1.0); }';
      const quad = (fragmentShader: string, uniforms: Record<string, THREE.IUniform>) => new FullScreenQuad(
        new THREE.ShaderMaterial({ uniforms, vertexShader, fragmentShader, depthTest: false, depthWrite: false,
          blending: THREE.NoBlending }));
      const under = new THREE.FramebufferTexture(px.width, px.height);
      const drawn = new THREE.WebGLRenderTarget(px.width, px.height, { depthBuffer: true });
      const out = new THREE.WebGLRenderTarget(px.width, px.height, { depthBuffer: false });
      const smaa = new SMAAPass();
      smaa.setSize(px.width, px.height);
      // (The canvas's pixels with alpha 0, so only what the gnomon touches has any; put back only those, opaque.)
      const copy = quad('uniform sampler2D tUnder; varying vec2 vUv; void main() { gl_FragColor = ' +
        'vec4(texture2D(tUnder, vUv).rgb, 0.0); }', { tUnder: { value: under } });
      const put = quad('uniform sampler2D tColor; varying vec2 vUv; void main() { vec4 c = texture2D(tColor, vUv); ' +
        'if (c.a < 0.5 / 255.0) discard; gl_FragColor = vec4(c.rgb, 1.0); }', { tColor: { value: out.texture } });
      t = this.smoothing = { width: px.width, height: px.height, under, drawn, out, smaa, copy, put };
    }
    renderer.setRenderTarget(null);
    renderer.copyFramebufferToTexture(t.under, new THREE.Vector2(px.x, px.y));
    renderer.setRenderTarget(t.drawn);
    t.copy.render(renderer);
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
    renderer.render(this.labelScene, this.labelCamera);
    // (SMAA's edges pass draws only edges: its targets cleared first, to nothing.)
    const clear = renderer.getClearColor(new THREE.Color()), alpha = renderer.getClearAlpha();
    renderer.setClearColor(0x000000, 0);
    renderer.autoClear = true;
    try {
      t.smaa.render(renderer, t.out, t.drawn, 0, false);
    } finally {
      renderer.autoClear = false;
      renderer.setClearColor(clear, alpha);
    }
    renderer.setRenderTarget(null);
    t.put.render(renderer);
  }

  /**
   * The labels for a camera turned `q`: each at its placement point plus its nudge as drawn (`nudges`), in `layout`
   * (draw's `motion`).
   */
  advance(q: THREE.Quaternion, motion: { now: number; flight?: { id: object; to: THREE.Quaternion; s: number } }):
    void {
    const turn = this.turnFor(q);
    const now = project(turn);
    this.symbol = axisSymbol([0, 1, 2].map((k) => turn.elements[k * 4 + 2]!));
    const laid = labelsLayout(now, this.symbol?.axis, this.showCube), target = laid.nudges;
    this.hiddenLabels = laid.hidden;
    const dt = Math.min(MAX_STEP, Math.max(0, (motion.now - this.last) / 1000));
    this.last = motion.now;
    const f = motion.flight;
    if (!this.nudges) this.nudges = target;
    else if (f) {
      if (this.flight?.id !== f.id) {
        const to = this.turnFor(f.to);
        this.flight = { id: f.id, from: this.nudges, to: nudgesOf(project(to), symbolAxis(to), this.showCube) };
      }
      const { from, to } = this.flight;
      this.nudges = from.map((a, k) => ({ x: a.x + (to[k]!.x - a.x) * f.s, y: a.y + (to[k]!.y - a.y) * f.s }));
    } else {
      this.flight = undefined;
      this.nudges = stepNudges(this.nudges, target, NUDGE_SPEED * dt);
    }
    // (A hidden label at its place, its point, so shown again it glides from there; in a flight, blended as the rest.)
    if (!f) this.nudges = this.nudges.map((n, k) => (laid.hidden[k] ? { ...target[k]! } : n));
    this.moving = this.nudges.some((n, k) => Math.hypot(n.x - target[k]!.x, n.y - target[k]!.y) > 1e-3);
    const labels = now.placements.map((p, k) => ({ x: p.x + this.nudges![k]!.x, y: p.y + this.nudges![k]!.y }));
    this.boxes = [...labels, now.origin].map((p) => ({ x: p.x + GNOMON_EXTENT.left, y: p.y + GNOMON_EXTENT.down }));
  }

  /** The labels' quads where `layout` says (made the first time: they need a document). */
  private layOut(box: { width: number; height: number }): void {
    if (!this.labels) {
      const quad = new THREE.PlaneGeometry(LABEL_BOX, LABEL_BOX);
      this.backing = new THREE.MeshBasicMaterial({ alphaMap: backingTexture(), transparent: true,
        opacity: BACKING_OPACITY, depthTest: false, depthWrite: false });
      this.labels = AXIS_COLOURS.map((colour, i) => {
        const label = new THREE.Group();
        const back = new THREE.Mesh(quad, this.backing);
        const letter = new THREE.Mesh(quad, new THREE.MeshBasicMaterial({ alphaMap: letterTexture('xyz'[i]!),
          color: colour, transparent: true, depthTest: false, depthWrite: false }));
        // (No depth test: drawn in this order, the letter over its backing.)
        back.renderOrder = 0;
        letter.renderOrder = 1;
        label.add(back, letter);
        this.labelScene.add(label);
        return label;
      });
    }
    for (const [i, m] of this.labels.entries()) {
      m.position.set(this.boxes[i]!.x, this.boxes[i]!.y, 0);
      m.visible = !this.hiddenLabels[i];
    }
    // The symbol where the axes meet, in the origin's box, which the labels clear.
    if (!this.symbolMesh) {
      this.symbolMaps = { head: symbolTexture(true), tail: symbolTexture(false) };
      // (Made with an alpha map, so its program has one: the maps are swapped, never added.)
      this.symbolMesh = new THREE.Mesh(new THREE.PlaneGeometry(LABEL_BOX, LABEL_BOX), new THREE.MeshBasicMaterial({
        alphaMap: this.symbolMaps.tail, transparent: true, depthTest: false, depthWrite: false }));
      this.disc = new THREE.Mesh(this.symbolMesh.geometry, new THREE.MeshBasicMaterial({ alphaMap: discTexture(),
        transparent: true, depthTest: false, depthWrite: false }));
      // (No depth test: drawn in this order, the disc under the symbol.)
      this.disc.renderOrder = 0;
      this.symbolMesh.renderOrder = 1;
      this.symbolMesh.add(this.disc);
      this.labelScene.add(this.symbolMesh);
    }
    const sym = this.symbol, m = this.symbolMesh;
    m.visible = sym !== undefined;
    if (sym) {
      m.material.alphaMap = sym.head ? this.symbolMaps!.head : this.symbolMaps!.tail;
      m.material.opacity = this.disc!.material.opacity = sym.opacity;
      m.position.set(this.boxes[3]!.x, this.boxes[3]!.y, 0);
    }
    Object.assign(this.labelCamera, { left: 0, right: box.width, bottom: 0, top: box.height });
    this.labelCamera.updateProjectionMatrix();
  }
}

/** How near a view must be to a direction (or the iso view's turn) to count as along it, degrees. */
export const ALIGNED_DEGREES = 1;
const ALIGNED = Math.cos(ALIGNED_DEGREES * Math.PI / 180);

/**
 * The view a click on axis `k`'s label asks for: the one with that axis pointing at the viewer, or away if it already
 * does (`back` the view's back, a unit, in the world); undefined where no view is along it (axes turned off the
 * world's).
 */
export function axisView(k: number, axes: THREE.Matrix4, back: THREE.Vector3): ViewName | undefined {
  const e = axes.elements;
  const d = new THREE.Vector3(e[k * 4]!, e[k * 4 + 1]!, e[k * 4 + 2]!).normalize();
  if (d.dot(back) >= ALIGNED) d.negate();
  // (A view's `dir` is where the camera sits from what it looks at: the axis pointing at it.)
  return (Object.keys(VIEWS) as ViewName[]).find((v) => !v.startsWith('iso') &&
    new THREE.Vector3(...VIEWS[v].dir).normalize().dot(d) >= ALIGNED);
}

/** Whether two cameras' turns are within ALIGNED_DEGREES of each other. */
export function sameTurn(a: THREE.Quaternion, b: THREE.Quaternion): boolean {
  return 2 * Math.acos(Math.min(1, Math.abs(a.dot(b)))) <= ALIGNED_DEGREES * Math.PI / 180;
}

/**
 * Whether the gnomon starts shown, from the page's query and what this browser remembers ('0' hidden): ?gnomon=0 or 1
 * decides; else pages for checks and shots (?check, ?controls=0) start without it; else as remembered, shown at first.
 * The view cube's the same by ?cube (`option`).
 */
export function gnomonShown(search: string, remembered: string | null, option = 'gnomon'): boolean {
  const q = new URLSearchParams(search);
  const asked = q.get(option);
  if (asked !== null) return asked !== '0';
  if (q.has('check') || q.get('controls') === '0') return false;
  return remembered !== '0';
}
