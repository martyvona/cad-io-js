// Empty assemblies dropped (docs/brep-model.md, decision 44): a component with nothing drawn beneath it (no parts,
// no external reference, every child such a component) removed with its occurrences; what refers to occurrences by
// their places (overrides' paths) renumbered, an override inside a removed one dropped. Every importer runs it.

import type { InstanceOverride, Scene } from './scene.ts';

/** Removes the scene's empty components (in place); how many it removed. */
export function dropEmptyComponents(scene: Scene): number {
  const n = scene.components.length;
  // 1 empty, 2 not, 0 unknown; a component met again on its own path (a cycle) counts as not empty.
  const state = new Uint8Array(n);
  const onPath = new Uint8Array(n);
  const empty = (c: number): boolean => {
    if (state[c]) return state[c] === 1;
    if (onPath[c] || !scene.components[c]) return false;
    onPath[c] = 1;
    const comp = scene.components[c]!;
    const e = !comp.parts.length && !comp.external && comp.children.every((o) => empty(o.component));
    onPath[c] = 0;
    state[c] = e ? 1 : 2;
    return e;
  };
  const keep: number[] = [];
  for (let c = 0; c < n; c++) if (!empty(c)) keep.push(c);
  const removed = n - keep.length;
  if (!removed) return 0;
  const newIndex = new Int32Array(n).fill(-1);
  keep.forEach((c, i) => { newIndex[c] = i; });
  // Each kept occurrence's new place among its siblings, per list (roots, and each component's children).
  const placeMap = (list: { component: number }[]) => {
    const m = new Int32Array(list.length).fill(-1);
    let k = 0;
    list.forEach((o, i) => { if (newIndex[o.component]! >= 0) m[i] = k++; });
    return m;
  };
  const rootPlaces = placeMap(scene.roots);
  const childPlaces = scene.components.map((c) => placeMap(c.children));
  // Overrides: each step of a path through the old lists, mapped; one through a removed occurrence goes.
  const renumber = (o: InstanceOverride): InstanceOverride | undefined => {
    const path: number[] = [];
    let list = rootPlaces, comp = -1;
    for (let i = 0; i < o.path.length; i++) {
      const at = o.path[i]!, to = list[at];
      if (to === undefined || to < 0) return undefined;
      path.push(to);
      comp = i === 0 ? scene.roots[at]!.component : scene.components[comp]!.children[at]!.component;
      list = childPlaces[comp]!;
    }
    return { ...o, path };
  };
  scene.overrides = scene.overrides.flatMap((o) => renumber(o) ?? []);
  scene.roots = scene.roots.filter((o) => newIndex[o.component]! >= 0).map((o) => ({ ...o,
    component: newIndex[o.component]! }));
  scene.components = keep.map((c) => {
    const comp = scene.components[c]!;
    return { ...comp, children: comp.children.filter((o) => newIndex[o.component]! >= 0).map((o) => ({ ...o,
      component: newIndex[o.component]! })) };
  });
  return removed;
}

/** dropEmptyComponents with its diagnostic: what importers call. */
export function dropEmptyAssemblies(scene: Scene): void {
  const n = dropEmptyComponents(scene);
  if (n) {
    scene.diagnostics.push({ severity: 'info', message: `${n === 1 ? 'an empty assembly' : `${n} empty assemblies`} `
      + '(nothing drawn beneath) left out' });
  }
}
