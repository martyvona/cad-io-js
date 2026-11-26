// The items of a placement's line and point objects (scene-graph.ts's `edges`, `curves`, `points` and `vertices`
// children): each B-rep edge, curve, point or vertex as a range of the object's index, the tree's edge, curve, point
// and vertex nodes (model.ts). Hiding some of them gives the object a geometry of its own without them (sharing the
// positions), so the ranges an item has now (`rangeOf`, for selection: selection.ts) are kept beside the ones it was
// made with. Every such object is indexed, points too (one index each), so items are index ranges alike.

import * as THREE from 'three';
import { itemIndexAttribute, PICK_INDEX } from './pick-ids.ts';

/** An item: its source id (null: none known), and its range of the object's full index. */
export interface Item { source: number | null; start: number; count: number }

interface Kept {
  items: readonly Item[];
  /** The geometry with every item. */
  full: THREE.BufferGeometry;
  /** Each item's range in the geometry drawn now (count 0: hidden). */
  now: readonly Item[];
  /** The hidden items drawn now, as a key. */
  key: string;
}

const kept = new WeakMap<THREE.Object3D, Kept>();

/**
 * Gives an object its items (its geometry has every one now), and its geometry each vertex's item (pick-ids.ts's
 * `pickIndex`; once per geometry, which placements share).
 */
export function setItems(o: THREE.Object3D & { geometry: THREE.BufferGeometry }, items: readonly Item[]): void {
  kept.set(o, { items, full: o.geometry, now: items, key: '' });
  const g = o.geometry;
  if (!g.getAttribute(PICK_INDEX) && g.index) {
    g.setAttribute(PICK_INDEX, new THREE.BufferAttribute(itemIndexAttribute(g.index.array, items,
      g.getAttribute('position').count), 1));
  }
}

/** An object's items, as made (none for an object without). */
export function itemsOf(o: THREE.Object3D): readonly Item[] {
  return kept.get(o)?.items ?? [];
}

/** An item's range in the object's geometry as drawn now; undefined while it's hidden. */
export function rangeOf(o: THREE.Object3D, k: number): { start: number; count: number } | undefined {
  const r = kept.get(o)?.now[k];
  return r && r.count > 0 ? { start: r.start, count: r.count } : undefined;
}

/**
 * Draws an object without these items (by their place in its list): its full geometry when none, else one of its own
 * with the rest (made again only when the set changes). With every one hidden the full geometry stays (the caller
 * hides the object), each item hidden as far as rangeOf goes.
 */
export function hideItems(o: THREE.Object3D & { geometry: THREE.BufferGeometry }, hidden: ReadonlySet<number>): void {
  const k = kept.get(o);
  if (!k) return;
  const key = [...hidden].sort((a, b) => a - b).join(',');
  if (key === k.key) return;
  if (o.geometry !== k.full) o.geometry.dispose();
  if (!hidden.size || hidden.size >= k.items.length) {
    o.geometry = k.full;
    kept.set(o, { ...k, now: hidden.size ? k.items.map((item) => ({ ...item, count: 0 })) : k.items, key });
    return;
  }
  const index = k.full.index!;
  const out: number[] = [];
  const now = k.items.map((item, i) => {
    if (hidden.has(i)) return { ...item, start: out.length, count: 0 };
    const start = out.length;
    for (let j = item.start; j < item.start + item.count; j++) out.push(index.getX(j));
    return { ...item, start, count: item.count };
  });
  const g = new THREE.BufferGeometry();
  for (const [name, a] of Object.entries(k.full.attributes)) g.setAttribute(name, a);
  g.setIndex(out);
  o.geometry = g;
  kept.set(o, { ...k, now, key });
}
