// What a view of a model is, as data (docs/viewer.md): the camera, the section planes, the rendering settings,
// the tree and the pick level, and which nodes are hidden and selected (by their paths, model.ts). The automation
// interface (automation.ts) reads and applies it, and a page's address carries it, so a link shows what someone else
// saw: the model in the query, the view after # (so no server sees it, however long; older links' view in the query is
// read too):
//
//   ?model=<path in the content root or URL>#view=iso  an axis view, turned about the target (or camera=, exactly)
//   &camera=px,py,pz,tx,ty,tz,ux,uy,uz,height[,panx,pany]  position, target, up, the viewport's height in world
//                                              mm, and the pan (mm along the view's right and up)
//   &cut=x:12.5  &cut=y:-3:flip  &caps=0
//   &ao=0  &smaa=0  &edges=0  &triangleEdges=all  &shininess=50  &aoIntensity=3  &aoRadius=16  &aoQuality=Low
//   &edgeStyle=thin  &edgeWidth=2  &specular=0.3  &ambient=1  &light=2.5  &capStyle=parts  &hatchWidth=2
//   &tree=0  &detail=1  &pick=detail  &instances=1
//   &hide=<path>  &show=<path>  &alpha=0.3:<path>  &alpha=default:<path>  &tri=on:<path>  &select=<path>
//                                              each repeated
//
// hide=, show=, alpha= and tri= are the appearance overrides (model.ts): a node hidden, shown within something
// hidden, its opacity (`default` the file's own), its triangle edges on or off, each holding for what's below it
// unless overridden there; together, exactly these (the others gone).
//
// Everything is optional: what's absent is left as it is. Numbers are written with at most 6 decimals.

import type { ViewName } from './camera.ts';
import { AXES, type Axis, type PlaneSettings } from './section.ts';
import type { PickLevel } from './selection.ts';
import { fixesNamed, HEAL_FIXES, type HealFix } from 'cad-heal/options';
import { MAX_MIN_ANGLE_DEGREES } from 'tess-cadio/options';
import type { MeshProfile } from 'cad-scene';
import { BACKEND_NAMES, defaultFixes, profileSettings, usesCadio, type Backend, type TessellationSettings }
  from './tessellation.ts';
import { DEFAULT_RENDER, type RenderSettings } from './style.ts';

export type Vec3 = [number, number, number];

export interface CameraState {
  position: Vec3;
  target: Vec3;
  up: Vec3;
  /** The viewport's height in world millimetres (the frustum's height over its zoom). */
  height: number;
  /**
   * The pan, in millimetres along the view's right and up: where the orbit centre (target) is drawn, from the view's
   * centre (panning leaves the orbit centre where it is on the model). Absent: none.
   */
  pan?: [number, number];
}

export interface ViewState {
  view?: ViewName;
  camera?: CameraState;
  /** The planes that are on; the others are off when `cut` is given. */
  cut?: Partial<Record<Axis, Omit<PlaneSettings, 'on'>>>;
  caps?: boolean;
  render?: Partial<RenderSettings>;
  tree?: { open?: boolean; detail?: boolean };
  pick?: PickLevel;
  instances?: boolean;
  /** Nodes with an override `hidden: true` (model.ts): with `shown`, exactly these overrides of hiding. */
  hidden?: string[];
  /** Nodes with an override `hidden: false`: shown within something hidden. */
  shown?: string[];
  /** Nodes with an opacity override (`default` the file's own): exactly these. */
  opacity?: { path: string; alpha: number | 'default' }[];
  /** Nodes with a triangle edges override: exactly these. */
  triangleEdges?: { path: string; on: boolean }[];
  selected?: string[];
  /**
   * The meshing settings (B-Rep Meshing's, as tessellation.ts has them): for the next model meshed or Mesh again,
   * not the model open. In states (cadViewer.state, recordings), not in addresses.
   */
  meshing?: Partial<TessellationSettings>;
}

const VIEW_NAMES: readonly ViewName[] = ['front', 'back', 'left', 'right', 'top', 'bottom', 'iso'];
const PICKS: readonly PickLevel[] = ['assembly', 'part', 'detail'];
const QUALITIES: readonly RenderSettings['aoQuality'][] = ['Performance', 'Low', 'Medium', 'High', 'Ultra'];
const FLAGS = ['ao', 'smaa', 'edges'] as const;
const TRIANGLE_EDGES: readonly RenderSettings['triangleEdges'][] = ['off', 'selected', 'all'];
const NUMBERS = ['shininess', 'aoIntensity', 'aoRadius', 'edgeWidth', 'specular', 'ambient', 'light',
  'hatchWidth'] as const;
/** Settings that are one of a few words. */
const CHOICES = { edgeStyle: ['thin', 'fat'], capStyle: ['drawing', 'parts'] } as const;

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
    q.push(['camera', [...c.position, ...c.target, ...c.up, c.height, ...c.pan ?? []].map(num).join(',')]);
  }
  for (const a of AXES) {
    const p = s.cut?.[a];
    if (p) q.push(['cut', `${a}:${num(p.at)}${p.flip ? ':flip' : ''}`]);
  }
  if (s.cut && !AXES.some((a) => s.cut![a])) q.push(['cut', 'none']);
  if (s.caps !== undefined) q.push(['caps', s.caps ? '1' : '0']);
  for (const k of FLAGS) if (s.render?.[k] !== undefined) q.push([k, s.render[k] ? '1' : '0']);
  for (const k of NUMBERS) if (s.render?.[k] !== undefined) q.push([k, num(s.render[k]!)]);
  if (s.render?.aoQuality) q.push(['aoQuality', s.render.aoQuality]);
  if (s.render?.triangleEdges) q.push(['triangleEdges', s.render.triangleEdges]);
  for (const k of Object.keys(CHOICES) as (keyof typeof CHOICES)[]) if (s.render?.[k]) q.push([k, s.render[k]!]);
  if (s.tree?.open !== undefined) q.push(['tree', s.tree.open ? '1' : '0']);
  if (s.tree?.detail !== undefined) q.push(['detail', s.tree.detail ? '1' : '0']);
  if (s.pick) q.push(['pick', s.pick]);
  if (s.instances !== undefined) q.push(['instances', s.instances ? '1' : '0']);
  for (const p of s.hidden ?? []) q.push(['hide', p]);
  for (const p of s.shown ?? []) q.push(['show', p]);
  for (const o of s.triangleEdges ?? []) q.push(['tri', `${o.on ? 'on' : 'off'}:${o.path}`]);
  for (const o of s.opacity ?? []) q.push(['alpha', `${o.alpha === 'default' ? 'default' : num(o.alpha)}:${o.path}`]);
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
    if ((v.length === 10 || v.length === 12) && v.every((x) => x !== undefined) && v[9]! > 0) {
      const n = v as number[];
      state.camera = { position: [n[0]!, n[1]!, n[2]!], target: [n[3]!, n[4]!, n[5]!], up: [n[6]!, n[7]!, n[8]!],
        height: n[9]!, ...(n.length === 12 ? { pan: [n[10]!, n[11]!] as [number, number] } : {}) };
    } else problems.push(`camera: 10 or 12 numbers expected (position, target, up, height > 0, pan): ${camera}`);
  }
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
  const edges = params.get('triangleEdges');
  if (edges !== null) {
    if (TRIANGLE_EDGES.includes(edges as RenderSettings['triangleEdges'])) render.triangleEdges =
      edges as RenderSettings['triangleEdges'];
    else problems.push(`triangleEdges: not one of ${TRIANGLE_EDGES.join(', ')}: ${edges}`);
  }
  for (const [k, words] of Object.entries(CHOICES) as [keyof typeof CHOICES, readonly string[]][]) {
    const v = params.get(k);
    if (v === null) continue;
    if (words.includes(v)) (render as Record<string, string>)[k] = v;
    else problems.push(`${k}: not one of ${words.join(', ')}: ${v}`);
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
  if (params.has('show')) state.shown = params.getAll('show');
  if (params.has('tri')) {
    state.triangleEdges = [];
    for (const t of params.getAll('tri')) {
      const k = t.indexOf(':'), word = t.slice(0, k);
      if (k < 0 || (word !== 'on' && word !== 'off') || k === t.length - 1) {
        problems.push(`tri: <on or off>:<path> expected: ${t}`);
      } else state.triangleEdges.push({ path: t.slice(k + 1), on: word === 'on' });
    }
  }
  if (params.has('alpha')) {
    state.opacity = [];
    for (const a of params.getAll('alpha')) {
      // (The opacity first: a path may hold `:`.)
      const k = a.indexOf(':'), word = k > 0 ? a.slice(0, k) : null;
      const alpha = word === 'default' ? word : finite(word);
      if (alpha === undefined || (alpha !== 'default' && (alpha < 0 || alpha > 1)) || k === a.length - 1) {
        problems.push(`alpha: <opacity 0 to 1, or default>:<path> expected: ${a}`);
      } else state.opacity.push({ path: a.slice(k + 1), alpha });
    }
  }
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

/**
 * The backends from the address, for the model it opens (address only, as healing): `backend=` and `fallback=` (a
 * backend, or `none`), `minAngle=` tess-cadio's smallest angle in degrees, `keepFailing=1` its debugging switch; what's
 * malformed is left out, with a message for each, as is minAngle or keepFailing where tess-cadio wouldn't mesh (the
 * backends then the address's, else the settings' `current`).
 */
export function backendsFromQuery(params: URLSearchParams, current: Pick<TessellationSettings, 'backend' |
  'fallback'>): { meshing?: Partial<Pick<TessellationSettings, 'backend' | 'fallback' | 'minAngle' | 'keepFailing'>>;
  problems: string[] } {
  const problems: string[] = [];
  const out: Partial<Pick<TessellationSettings, 'backend' | 'fallback' | 'minAngle' | 'keepFailing'>> = {};
  const backend = params.get('backend'), fallback = params.get('fallback');
  if (backend !== null) {
    if ((BACKEND_NAMES as readonly string[]).includes(backend)) out.backend = backend as Backend;
    else problems.push(`backend: not one of ${BACKEND_NAMES.join(', ')}: ${backend}`);
  }
  if (fallback !== null) {
    if (fallback === 'none' || (BACKEND_NAMES as readonly string[]).includes(fallback)) {
      out.fallback = fallback as Backend | 'none';
    } else problems.push(`fallback: not one of ${BACKEND_NAMES.join(', ')}, none: ${fallback}`);
  }
  const cadio = usesCadio({ backend: out.backend ?? current.backend, fallback: out.fallback ?? current.fallback });
  const min = params.get('minAngle');
  if (min !== null) {
    const v = Number(min);
    if (min.trim() === '' || !Number.isFinite(v) || v < 0 || v > MAX_MIN_ANGLE_DEGREES) {
      problems.push(`minAngle: not a number of degrees from 0 to ${MAX_MIN_ANGLE_DEGREES}: ${min}`);
    } else if (!cadio) problems.push('minAngle: only tess-cadio (backend=cadio or fallback=cadio) reads it: ignored');
    else out.minAngle = v;
  }
  const keep = bool(params.get('keepFailing'));
  if (keep !== undefined) {
    if (keep && !cadio) problems.push('keepFailing: only tess-cadio (backend=cadio or fallback=cadio) has it: ignored');
    else out.keepFailing = keep;
  }
  return Object.keys(out).length ? { meshing: out, problems } : { problems };
}

/** The profiles the address's `profile=` names, as B-Rep Meshing's Profile does. */
const PROFILES = ['coarse', 'medium', 'fine', 'custom'] as const;
/** The largest angle (degrees) `angularDeflection=` takes: the control's. */
const MAX_ANGLE_DEGREES = 90;

/**
 * The meshing's deflections from the address, for the model it opens (address only, as healing): `profile=` one of
 * coarse, medium, fine or custom (its deflections then the settings' `current`), `linearDeflection=` millimetres and
 * `angularDeflection=` degrees, either making it custom (the other then `current`'s); what's malformed is left out,
 * with a message for each, and a profile other than custom with a deflection is custom, said.
 */
export function deflectionFromQuery(params: URLSearchParams, current: Pick<TessellationSettings,
  'linearDeflection' | 'angularDeflection'>): { meshing?: Pick<TessellationSettings, 'profile' | 'linearDeflection'
  | 'angularDeflection'>; problems: string[] } {
  const problems: string[] = [];
  const profile = params.get('profile');
  let named: (typeof PROFILES)[number] | undefined;
  if (profile !== null) {
    if ((PROFILES as readonly string[]).includes(profile)) named = profile as (typeof PROFILES)[number];
    else problems.push(`profile: not one of ${PROFILES.join(', ')}: ${profile}`);
  }
  const value = (k: string, ok: (v: number) => boolean, what: string) => {
    const s = params.get(k);
    if (s === null) return undefined;
    const v = finite(s);
    if (v === undefined || !ok(v)) {
      problems.push(`${k}: not ${what}: ${s}`);
      return undefined;
    }
    return v;
  };
  const linear = value('linearDeflection', (v) => v > 0, 'a positive number of millimetres');
  const angular = value('angularDeflection', (v) => v > 0 && v <= MAX_ANGLE_DEGREES,
    `a number of degrees above 0, at most ${MAX_ANGLE_DEGREES}`);
  if (linear !== undefined || angular !== undefined) {
    if (named && named !== 'custom') problems.push(`profile=${named} with a deflection: custom`);
    return { meshing: { profile: 'custom', linearDeflection: linear ?? current.linearDeflection,
      angularDeflection: angular ?? current.angularDeflection }, problems };
  }
  if (named === 'custom') return { meshing: { profile: 'custom', linearDeflection: current.linearDeflection,
    angularDeflection: current.angularDeflection }, problems };
  if (named) return { meshing: profileSettings(named), problems };
  return { problems };
}

/**
 * The address's parameters for a model meshed with `m` (deflectionFromQuery's, which read them back): its profile,
 * or its deflections where custom; none where it's `usual`, the device's profile (undefined: always, Copy link's
 * Include device defaults).
 */
export function deflectionQuery(m: Pick<TessellationSettings, 'profile' | 'linearDeflection' | 'angularDeflection'>,
  usual?: MeshProfile): [string, string][] {
  if (m.profile === usual) return [];
  if (m.profile !== 'custom') return [['profile', m.profile]];
  return [['linearDeflection', String(m.linearDeflection)], ['angularDeflection', String(m.angularDeflection)]];
}

/**
 * Healing from the address, for the model it opens (address only: a state's meshing carries it otherwise): `heal=1`
 * or `0` (Heal B-reps), `healOn=` and `healOff=` comma-separated fixes on or off from cad-heal's defaults, and
 * `healFit=` the fit tolerance in mm (pcurveFitTolerance), which turn healing on; what's malformed is left out, with a
 * message for each.
 */
export function healingFromQuery(params: URLSearchParams): { meshing?: Pick<TessellationSettings, 'heal' |
  'healFixes'> & Partial<Pick<TessellationSettings, 'healFit'>>; problems: string[] } {
  const problems: string[] = [];
  const heal = bool(params.get('heal'));
  // (An alias, cad-heal's FIX_ALIASES, as its fixes.)
  const named = (k: string) => new Set((params.get(k) ?? '').split(',').map((x) => x.trim()).flatMap((f) => {
    const fixes = fixesNamed(f);
    if (f && !fixes.length) problems.push(`${k}: not one of ${HEAL_FIXES.join(', ')}: ${f}`);
    return fixes;
  }));
  const on = named('healOn'), off = named('healOff'), fixes: Partial<Record<HealFix, boolean>> = {};
  for (const f of on) if (off.has(f)) problems.push(`healOn and healOff: ${f} in both, left as it is`);
  for (const [set, v] of [[on, true], [off, false]] as const) for (const f of set) {
    if (!(on.has(f) && off.has(f))) fixes[f] = v;
  }
  const fitText = params.get('healFit'), fitValue = fitText === null ? undefined : Number(fitText);
  const fit = fitValue !== undefined && Number.isFinite(fitValue) && fitValue > 0 ? fitValue : undefined;
  if (fitText !== null && fit === undefined) problems.push(`healFit: not a positive number of mm: ${fitText}`);
  const listed = Object.keys(fixes).length > 0 || fit !== undefined;
  if (heal === false && listed) {
    problems.push('heal=0 with healOn, healOff or healFit: ignored');
    return { meshing: { heal: false, healFixes: defaultFixes() }, problems };
  }
  if (heal === undefined && !listed) return { problems };
  return { meshing: { heal: heal ?? true, healFixes: { ...defaultFixes(), ...fixes },
    ...(fit === undefined ? {} : { healFit: fit }) }, problems };
}
