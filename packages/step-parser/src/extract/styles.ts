// Presentation: colours, transparency, invisibility and layers, following the CAx-IF Recommended Practices for
// Model Styling and Organization (v1.10). Styles are extracted as the file states them, per styled item; resolving
// what a given face of a given instance looks like (inheritance down the assembly and the topology, overrides) is
// done by effectiveStyle, for a single item.

import type { Reader } from './reader.ts';

export type Rgb = [number, number, number];

export interface Style {
  /** Surface colour (from SURFACE_STYLE_RENDERING when present, else the fill area colour). */
  surface?: Rgb;
  /** Which side of the surface the colour is for, when not both. */
  surfaceSide?: 'positive' | 'negative';
  /** Surface transparency, 0 (opaque) to 1. */
  transparency?: number;
  /** The colour of a surface's boundary curves (SURFACE_STYLE_BOUNDARY): a curve colour, not the surface's. */
  boundary?: Rgb;
  curve?: Rgb;
  point?: Rgb;
  /** A null style: shown, with the receiving system's default appearance. */
  null?: true;
  /** Hidden, by an INVISIBILITY of the styled item (or of a layer it belongs to). */
  invisible?: true;
}

export interface StyledItem {
  /** The STYLED_ITEM's instance id. */
  id: number;
  /** The styled item's instance id: a representation item, or a representation. */
  item: number;
  style: Style;
  /** For an OVER_RIDING_STYLED_ITEM, the styled item whose style it overrides. */
  overrides?: number;
  /**
   * For a CONTEXT_DEPENDENT_OVER_RIDING_STYLED_ITEM, its style_context: representation relationships top down from
   * the root (identifying one assembly instance), or other context items, by instance id.
   */
  context?: number[];
  /**
   * Set when the styles apply only in a presentation context (PRESENTATION_STYLE_BY_CONTEXT: a particular view, say):
   * the context items' ids. Such styles don't apply to the default appearance.
   */
  presentationContext?: number[];
}

export interface Layer {
  /** The PRESENTATION_LAYER_ASSIGNMENT's instance id. */
  id: number;
  name: string;
  description?: string;
  /** Assigned item instance ids. */
  items: number[];
  invisible?: true;
}

export interface Styles {
  /** Every styled item, in file order. */
  styled: StyledItem[];
  /** Styled items by the id of the item they style. */
  byItem: Map<number, StyledItem[]>;
  layers: Layer[];
}

// CAx-IF Model Styling, table 2.
const PREDEFINED: Record<string, Rgb> = {
  black: [0, 0, 0], white: [1, 1, 1], red: [1, 0, 0], green: [0, 1, 0], blue: [0, 0, 1],
  yellow: [1, 1, 0], cyan: [0, 1, 1], magenta: [1, 0, 1],
};

export function extractStyles(r: Reader): Styles {
  const m = r.model;
  const hidden = new Set<number>();
  for (const p of m.instancesOf('INVISIBILITY')) for (const q of r.refs(p, 'invisible_items')) hidden.add(q);

  const styled: StyledItem[] = [];
  const byItem = new Map<number, StyledItem[]>();
  for (const p of m.instancesOf('STYLED_ITEM')) {
    const item = r.ref(p, 'item');
    if (item < 0) { r.warn('styled item without an item', p); continue; }
    const style: Style = {};
    for (const psa of r.refs(p, 'styles')) styleAssignment(r, psa, style, p);
    if (hidden.has(p)) style.invisible = true;
    const s: StyledItem = { id: r.id(p), item: r.id(item), style };
    if (r.is(p, 'OVER_RIDING_STYLED_ITEM')) {
      const o = r.ref(p, 'over_ridden_style');
      if (o >= 0) s.overrides = r.id(o);
    }
    if (r.is(p, 'CONTEXT_DEPENDENT_OVER_RIDING_STYLED_ITEM')) s.context = r.refs(p, 'style_context').map((q) => r.id(q));
    const byContext = r.refs(p, 'styles').filter((q) => r.is(q, 'PRESENTATION_STYLE_BY_CONTEXT'));
    if (byContext.length) s.presentationContext = byContext.flatMap((q) => r.refs(q, 'style_context')).map((q) => r.id(q));
    styled.push(s);
    let list = byItem.get(s.item);
    if (!list) byItem.set(s.item, (list = []));
    list.push(s);
  }

  const layers: Layer[] = [];
  for (const p of m.instancesOf('PRESENTATION_LAYER_ASSIGNMENT')) {
    const layer: Layer = { id: r.id(p), name: r.str(p, 'name') ?? '', items: r.refs(p, 'assigned_items').map((q) => r.id(q)) };
    const d = r.str(p, 'description');
    if (d) layer.description = d;
    if (hidden.has(p)) layer.invisible = true;
    layers.push(layer);
  }
  return { styled, byItem, layers };
}

/** Merge a PRESENTATION_STYLE_ASSIGNMENT's styles into `style`. */
function styleAssignment(r: Reader, psa: number, style: Style, owner: number): void {
  const v = r.attr(psa, 'styles');
  if (v?.k === 'list') {
    // NULL_STYLE(.NULL.) is a typed enumeration among the style references.
    for (const e of v.v) if (e.k === 'typed' && e.type === 'NULL_STYLE') style.null = true;
  }
  for (const s of r.refs(psa, 'styles')) {
    if (r.is(s, 'SURFACE_STYLE_USAGE')) {
      const side = r.enum(s, 'side');
      if (side === 'POSITIVE') style.surfaceSide = 'positive';
      else if (side === 'NEGATIVE') style.surfaceSide = 'negative';
      surfaceSideStyle(r, r.ref(s, 'style'), style);
    } else if (r.is(s, 'CURVE_STYLE')) {
      const c = colour(r, r.ref(s, 'curve_colour'));
      if (c) style.curve = c;
    } else if (r.is(s, 'POINT_STYLE')) {
      const c = colour(r, r.ref(s, 'marker_colour'));
      if (c) style.point = c;
    } else if (!r.is(s, 'FILL_AREA_STYLE') && !r.is(s, 'TEXT_STYLE')) {
      r.warn(`unsupported presentation style ${r.model.types(s).join('+')}`, owner, 'info');
    }
  }
}

function surfaceSideStyle(r: Reader, p: number, style: Style): void {
  let fill: Rgb | undefined, rendering: Rgb | undefined;
  for (const s of r.refs(p, 'styles')) {
    if (r.is(s, 'SURFACE_STYLE_FILL_AREA')) {
      for (const fs of r.refs(r.ref(s, 'fill_area'), 'fill_styles')) {
        if (r.is(fs, 'FILL_AREA_STYLE_COLOUR')) fill ??= colour(r, r.ref(fs, 'fill_colour'));
      }
    } else if (r.is(s, 'SURFACE_STYLE_BOUNDARY')) {
      const c = colour(r, r.ref(r.ref(s, 'style_of_boundary'), 'curve_colour'));
      if (c) style.boundary = c;
    } else if (r.is(s, 'SURFACE_STYLE_RENDERING')) {
      rendering ??= colour(r, r.ref(s, 'surface_colour'));
      if (r.is(s, 'SURFACE_STYLE_RENDERING_WITH_PROPERTIES')) {
        for (const prop of r.refs(s, 'properties')) {
          if (r.is(prop, 'SURFACE_STYLE_TRANSPARENT')) {
            const t = r.num(prop, 'transparency');
            if (t !== undefined) style.transparency = t;
          }
        }
      }
    }
  }
  // CAx-IF: when both are given, the rendering colour wins.
  const c = rendering ?? fill;
  if (c) style.surface = c;
}

/** A colour as RGB in [0, 1]: COLOUR_RGB, or a pre-defined colour by name. */
export function colour(r: Reader, p: number): Rgb | undefined {
  if (p < 0) return undefined;
  if (r.is(p, 'COLOUR_RGB')) {
    const c = [r.num(p, 'red'), r.num(p, 'green'), r.num(p, 'blue')];
    if (c.some((x) => x === undefined || !(x >= 0))) { r.warn('colour with a missing or negative component', p); return undefined; }
    const max = Math.max(...(c as number[]));
    if (max > 1) {
      // Some writers use 0..255 (trj5_k1-ct-214.stp: 255,255,255). OCCT divides by the largest component; so do we.
      r.warn('colour component above 1; scaled by the largest component', p, 'info');
      return (c as number[]).map((x) => x / max) as Rgb;
    }
    return c as Rgb;
  }
  if (r.is(p, 'PRE_DEFINED_COLOUR') || r.is(p, 'DRAUGHTING_PRE_DEFINED_COLOUR')) {
    const name = r.str(p, 'name') ?? '';
    const c = PREDEFINED[name.toLowerCase()];
    if (!c) r.warn(`unknown pre-defined colour '${name}'`, p);
    return c;
  }
  r.warn(`unsupported colour ${r.model.types(p).join('+')}`, p, 'info');
  return undefined;
}

/**
 * The style that applies to an item (a face, say) through the topology, without assembly context: the item's own
 * styled items, then those of what contains it (shell, solid or surface model, representation), nearest first, with
 * overrides beating what they override. Each property is taken from the nearest style that has it.
 */
export function effectiveStyle(r: Reader, styles: Styles, item: number): Style | undefined {
  const m = r.model;
  const out: Style = {};
  let found = false;
  const seen = new Set<number>();
  // Breadth first up the containment (referrers), nearest first.
  let level = [item];
  for (let depth = 0; level.length && depth < 8; depth++) {
    const next: number[] = [];
    for (const p of level) {
      if (seen.has(p)) continue;
      seen.add(p);
      const own = styles.byItem.get(r.id(p)) ?? [];
      // Overriding styles first, then plain ones, later ones before earlier (two overrides of one style: the later
      // wins, as in OCCT).
      const general = own.filter((x) => !x.presentationContext);
      for (const s of [...general.filter((x) => x.overrides !== undefined && !x.context).reverse(), ...general.filter((x) => x.overrides === undefined).reverse()]) {
        found = true;
        for (const k of Object.keys(s.style) as (keyof Style)[]) if (out[k] === undefined) (out as Record<string, unknown>)[k] = s.style[k];
      }
      for (const q of m.referrers(p)) {
        if (m.isInstanceOf(q, 'STYLED_ITEM') || m.isInstanceOf(q, 'PRESENTATION_LAYER_ASSIGNMENT')) continue;
        if (isContainer(r, q)) next.push(q);
      }
    }
    level = next;
  }
  return found ? out : undefined;
}

// Topology and representations that pass their style down to what they contain.
const CONTAINERS = [
  'CONNECTED_FACE_SET', 'MANIFOLD_SOLID_BREP', 'BREP_WITH_VOIDS', 'SHELL_BASED_SURFACE_MODEL', 'FACE_BASED_SURFACE_MODEL',
  'GEOMETRIC_SET', 'REPRESENTATION', 'TESSELLATED_SOLID', 'TESSELLATED_SHELL', 'TESSELLATED_SURFACE_SET',
  'TESSELLATED_GEOMETRIC_SET',
];
function isContainer(r: Reader, p: number): boolean {
  return CONTAINERS.some((e) => r.is(p, e));
}
