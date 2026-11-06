// Leaf products as part references (docs/claude/scene-formats.md): a component whose only content is one part reference
// (no children, no external reference, no material of its own) is the part placed, not a component: each occurrence of
// it becomes a part reference in its parent's component (or among the scene's root parts), with the occurrence's name,
// sources and properties, the component's as its `product`. So a placed part is one node in a tree, as CAD systems and
// 3MF show it, not an assembly holding a part of the same name (the corpus had 3,979 such occurrences). Every importer
// ends with it, so every file (ours written before, too) reads alike.
//
// The new part references come after the component's own, in the order of the occurrences they replace; the other
// children keep their order; overrides' paths follow (one that ends at a leaf's occurrence names its part reference);
// the leaf components, no longer placed, are removed and the others renumbered.

import type { Component, InstanceOverride, Occurrence, PartRef, Scene } from './scene.ts';
import { multiply } from './walk.ts';

/**
 * Whether a component is a leaf product: one part reference and nothing else, the reference a shape of its own, not
 * a product placed (an assembly of one placed product stays one, as the file has it; so a second pass changes
 * nothing).
 */
export function isLeaf(c: Component): boolean {
  return c.parts.length === 1 && !c.parts[0]!.product && !c.children.length && !c.external &&
    c.material === undefined;
}

/** The part reference an occurrence of a leaf component becomes, in the occurrence's parent's coordinates. */
function placed(occ: Occurrence, c: Component): PartRef {
  const own = c.parts[0]!;
  const ref: PartRef = { ...own, transform: multiply(occ.transform, own.transform) };
  const name = occ.name ?? own.name;
  if (name !== undefined) ref.name = name;
  else delete ref.name;
  const sources = [...occ.sources, ...own.sources ?? []];
  if (sources.length) ref.sources = sources;
  const properties = { ...own.properties, ...occ.properties };
  if (Object.keys(properties).length) ref.properties = properties;
  ref.product = { name: c.name, sources: c.sources, properties: c.properties };
  return ref;
}

/** Each leaf component's occurrences as part references, in place. */
export function leafParts(scene: Scene): void {
  const leaf = scene.components.map(isLeaf);
  if (!leaf.some((x) => x)) return;
  // Where each child went: a child index, or a part reference index.
  type Moved = { child: number } | { ref: number };
  const moved: Moved[][] = scene.components.map(() => []);
  scene.components.forEach((c, i) => {
    if (leaf[i]) return;
    const children: Occurrence[] = [];
    moved[i] = c.children.map((o) => {
      if (leaf[o.component]) {
        c.parts.push(placed(o, scene.components[o.component]!));
        return { ref: c.parts.length - 1 };
      }
      children.push(o);
      return { child: children.length - 1 };
    });
    c.children = children;
  });
  const roots: Occurrence[] = [];
  const rootParts = scene.rootParts ?? [];
  const movedRoots: Moved[] = scene.roots.map((o) => {
    if (leaf[o.component]) {
      rootParts.push(placed(o, scene.components[o.component]!));
      return { ref: rootParts.length - 1 };
    }
    roots.push(o);
    return { child: roots.length - 1 };
  });
  scene.roots = roots;
  if (rootParts.length) scene.rootParts = rootParts;

  // Overrides' paths through the moved children.
  const remap = (o: InstanceOverride): InstanceOverride | undefined => {
    if (!o.path.length) return o;
    const path: number[] = [];
    let list = movedRoots, comp: number | undefined;
    for (const [k, i] of o.path.entries()) {
      const m = list[i];
      if (!m) return undefined;
      if ('ref' in m) {
        // A leaf's occurrence: its part reference (whose own index in the leaf was 0); nothing below it.
        if (k !== o.path.length - 1 || (o.ref !== undefined && o.ref !== 0)) return undefined;
        return { ...o, path, ref: m.ref };
      }
      path.push(m.child);
      const occ: Occurrence = comp === undefined ? roots[m.child]! : scene.components[comp]!.children[m.child]!;
      comp = occ.component;
      list = moved[comp] ?? [];
    }
    return { ...o, path };
  };
  scene.overrides = scene.overrides.flatMap((o) => remap(o) ?? []);

  // The leaf components gone, the others renumbered.
  const index = new Map<number, number>();
  const kept: Component[] = [];
  scene.components.forEach((c, i) => {
    if (leaf[i]) return;
    index.set(i, kept.length);
    kept.push(c);
  });
  for (const c of kept) for (const o of c.children) o.component = index.get(o.component)!;
  for (const o of scene.roots) o.component = index.get(o.component)!;
  scene.components = kept;
}
