// What a view of a model is, as data (the user, 2026-10-25; CLAUDE.md, "The viewer"): the camera, centring, the
// section planes, the rendering settings, the tree and the pick level, and which nodes are hidden and selected (by
// their paths, model.ts). The automation interface (automation.ts) reads and applies it, and a page's address
// carries it, so a link shows what someone else saw:
//
//   ?url=<model>&view=iso                      an axis view, fitted (or camera=, exactly)
//   &camera=px,py,pz,tx,ty,tz,ux,uy,uz,height  position, target, up, and the viewport's height in world mm
//   &centered=1  &cut=x:12.5  &cut=y:-3:flip  &caps=0
//   &ao=0  &smaa=0  &edges=0  &shininess=50  &aoIntensity=3  &aoRadius=16  &aoQuality=Low
//   &tree=0  &detail=1  &pick=detail  &instances=1
//   &hide=<path>  &select=<path>               each repeated
//
// Everything is optional: what's absent is left as it is. Numbers are written with at most 6 decimals.

import type { ViewName } from './camera.ts';
import { AXES, type Axis, type PlaneSettings } from './section.ts';
import type { PickLevel } from './selection.ts';
import { DEFAULT_RENDER, type RenderSettings } from './style.ts';

export type Vec3 = [number, number, number];

export interface CameraState {
  position: Vec3;
  target: Vec3;
  up: Vec3;
  /** The viewport's height in world millimetres (the frustum's height over its zoom). */
  height: number;
}

export interface ViewState {
  view?: ViewName;
  camera?: CameraState;
  centered?: boolean;
  /** The planes that are on; the others are off when `cut` is given. */
  cut?: Partial<Record<Axis, Omit<PlaneSettings, 'on'>>>;
  caps?: boolean;
  render?: Partial<RenderSettings>;
  tree?: { open?: boolean; detail?: boolean };
  pick?: PickLevel;
  instances?: boolean;
  hidden?: string[];
  selected?: string[];
}

const VIEW_NAMES: readonly ViewName[] = ['front', 'back', 'left', 'right', 'top', 'bottom', 'iso'];
const PICKS: readonly PickLevel[] = ['assembly', 'part', 'detail'];
const QUALITIES: readonly RenderSettings['aoQuality'][] = ['Performance', 'Low', 'Medium', 'High', 'Ultra'];
const FLAGS = ['ao', 'smaa', 'edges', 'cadMaterials'] as const;
const NUMBERS = ['shininess', 'aoIntensity', 'aoRadius'] as const;

const num = (x: number) => String(Math.round(x * 1e6) / 1e6);
const bool = (s: string | null) => s === null ? undefined : s !== '0' && s !== 'false';
const finite = (s: string | null) => s === null || s.trim() === '' || !Number.isFinite(Number(s)) ? undefined
  : Number(s);

/** The state as query parameters (in a fixed order, so equal states give equal links). */
export function toQuery(s: ViewState): [string, string][] {
  const q: [string, string][] = [];
  if (s.view) q.push(['view', s.view]);
  if (s.camera) {
    const c = s.camera;
    q.push(['camera', [...c.position, ...c.target, ...c.up, c.height].map(num).join(',')]);
  }
  if (s.centered !== undefined) q.push(['centered', s.centered ? '1' : '0']);
  for (const a of AXES) {
    const p = s.cut?.[a];
    if (p) q.push(['cut', `${a}:${num(p.at)}${p.flip ? ':flip' : ''}`]);
  }
  if (s.cut && !AXES.some((a) => s.cut![a])) q.push(['cut', 'none']);
  if (s.caps !== undefined) q.push(['caps', s.caps ? '1' : '0']);
  for (const k of FLAGS) if (s.render?.[k] !== undefined) q.push([k, s.render[k] ? '1' : '0']);
  for (const k of NUMBERS) if (s.render?.[k] !== undefined) q.push([k, num(s.render[k]!)]);
  if (s.render?.aoQuality) q.push(['aoQuality', s.render.aoQuality]);
  if (s.tree?.open !== undefined) q.push(['tree', s.tree.open ? '1' : '0']);
  if (s.tree?.detail !== undefined) q.push(['detail', s.tree.detail ? '1' : '0']);
  if (s.pick) q.push(['pick', s.pick]);
  if (s.instances !== undefined) q.push(['instances', s.instances ? '1' : '0']);
  for (const p of s.hidden ?? []) q.push(['hide', p]);
  for (const p of s.selected ?? []) q.push(['select', p]);
  return q;
}

/** The state from query parameters; what's malformed is left out, with a message for each. */
export function fromQuery(params: URLSearchParams): { state: ViewState; problems: string[] } {
  const state: ViewState = {};
  const problems: string[] = [];
  const view = params.get('view');
  if (view !== null) {
    if (VIEW_NAMES.includes(view as ViewName)) state.view = view as ViewName;
    else problems.push(`view: not one of ${VIEW_NAMES.join(', ')}: ${view}`);
  }
  const camera = params.get('camera');
  if (camera !== null) {
    const v = camera.split(',').map((x) => finite(x));
    if (v.length === 10 && v.every((x) => x !== undefined) && v[9]! > 0) {
      const n = v as number[];
      state.camera = { position: [n[0]!, n[1]!, n[2]!], target: [n[3]!, n[4]!, n[5]!], up: [n[6]!, n[7]!, n[8]!],
        height: n[9]! };
    } else problems.push(`camera: 10 numbers expected (position, target, up, height > 0): ${camera}`);
  }
  const centered = bool(params.get('centered'));
  if (centered !== undefined) state.centered = centered;
  const cuts = params.getAll('cut');
  if (cuts.length) {
    state.cut = {};
    for (const c of cuts) {
      if (c === 'none') continue;
      const [axis, at, flip, ...rest] = c.split(':');
      const pos = finite(at ?? null);
      if (!AXES.includes(axis as Axis) || pos === undefined || (flip !== undefined && flip !== 'flip') ||
        rest.length) problems.push(`cut: <x|y|z>:<position>[:flip] expected: ${c}`);
      else state.cut[axis as Axis] = { at: pos, flip: flip === 'flip' };
    }
  }
  const caps = bool(params.get('caps'));
  if (caps !== undefined) state.caps = caps;
  const render: Partial<RenderSettings> = {};
  for (const k of FLAGS) {
    const b = bool(params.get(k));
    if (b !== undefined) render[k] = b;
  }
  for (const k of NUMBERS) {
    const s = params.get(k);
    if (s === null) continue;
    const x = finite(s);
    if (x === undefined || x < 0) problems.push(`${k}: a number >= 0 expected: ${s}`);
    else render[k] = x;
  }
  const quality = params.get('aoQuality');
  if (quality !== null) {
    if (QUALITIES.includes(quality as RenderSettings['aoQuality'])) render.aoQuality =
      quality as RenderSettings['aoQuality'];
    else problems.push(`aoQuality: not one of ${QUALITIES.join(', ')}: ${quality}`);
  }
  if (Object.keys(render).length) state.render = render;
  const open = bool(params.get('tree'));
  const detail = bool(params.get('detail'));
  if (open !== undefined || detail !== undefined) state.tree = { ...(open !== undefined ? { open } : {}),
    ...(detail !== undefined ? { detail } : {}) };
  const pick = params.get('pick');
  if (pick !== null) {
    if (PICKS.includes(pick as PickLevel)) state.pick = pick as PickLevel;
    else problems.push(`pick: not one of ${PICKS.join(', ')}: ${pick}`);
  }
  const instances = bool(params.get('instances'));
  if (instances !== undefined) state.instances = instances;
  if (params.has('hide')) state.hidden = params.getAll('hide');
  if (params.has('select')) state.selected = params.getAll('select');
  return { state, problems };
}

/** The rendering settings that differ from the defaults (what a link needs to carry). */
export function renderChanges(r: RenderSettings): Partial<RenderSettings> {
  const out: Partial<RenderSettings> = {};
  for (const k of Object.keys(DEFAULT_RENDER) as (keyof RenderSettings)[]) {
    if (r[k] !== DEFAULT_RENDER[k]) (out as Record<string, unknown>)[k] = r[k];
  }
  return out;
}
