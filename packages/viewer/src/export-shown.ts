// The viewer's hiding and opacity for an export (Export's "Apply the viewer's hiding and opacity"), as the scene can
// say them: each placed part's visibility and materials by an instance override of its part reference
// (InstanceOverride.ref), in place of the scene's own visibility overrides (the node model already started from them:
// model.ts); opacity as copies of the placement's materials at the alpha it draws with, its faces' too, and a face's
// own opacity a per-face material of the placement. While something is revealed (model.ts's Reveal), what isn't is at
// Reveal alpha (`revealAlpha`), as if overridden so, whatever its own opacity. What the scene can't say is said
// instead: a face hidden in a placement still shown (no format here hides one face of a placed part), triangle edges.

import type { InstanceOverride, Material, Scene } from 'cad-scene';
import type { NodeModel } from './model.ts';
import { DEFAULT_COLOR, type SceneGraph } from './scene-graph.ts';

export interface ShownEdits {
  /** Materials to add after the scene's (indices from its count on). */
  materials: Material[];
  /** The scene's overrides to use instead of its own. */
  overrides: InstanceOverride[];
  /** What couldn't be written, in words (the status line, a warning). */
  warnings: string[];
}

/** The scene's overrides and added materials that make an export draw as the viewer does. */
export function shownEdits(scene: Scene, nodes: NodeModel, graph: SceneGraph, revealAlpha = 0.1): ShownEdits {
  const materials: Material[] = [];
  const made = new Map<string, number>();
  // A material at an alpha (undefined, the default material's grey), each once.
  const at = (m: number | undefined, alpha: number): number => {
    const key = `${m}@${alpha}`;
    let i = made.get(key);
    if (i === undefined) {
      const base = m === undefined ? undefined : scene.materials[m];
      i = scene.materials.length + materials.length;
      materials.push({ ...(base?.name ? { name: base.name } : {}), color: base ? [...base.color] : [...DEFAULT_COLOR],
        opacity: alpha, sources: base ? [...base.sources] : [] });
      made.set(key, i);
    }
    return i;
  };
  // The scene's overrides but for visibility, which the node model's looks now give.
  const overrides: InstanceOverride[] = scene.overrides.flatMap((o) => {
    const { visible: _, ...rest } = o;
    return rest.material === undefined && !rest.faceMaterials?.length ? [] : [rest];
  });
  let hiddenFaces = 0, triangleEdges = false;
  for (const n of nodes.nodes) {
    if (n.kind !== 'part' || !n.object) continue;
    const part = n.object.userData.part as number;
    const p = graph.placements.get(part)?.find((q) => q.group === n.object);
    if (!p) continue;
    const pi = p.instance;
    // (A root part's reference among the scene's root parts, at the empty path.)
    const component = pi.path.length ? componentAt(scene, pi.path) : undefined;
    const refs = pi.path.length ? component === undefined ? [] : scene.components[component]!.parts
      : scene.rootParts ?? [];
    const ref = refs.indexOf(pi.ref);
    if (ref < 0) continue;
    // (Its faces as their group resolves them: model.ts.)
    const look = nodes.groupLook(n.id, 'faces'), own = nodes.faceOverrides(n.id);
    triangleEdges ||= look.triangleEdges === true;
    const base = { path: [...pi.path], ref, sources: [] };
    if (!n.object.visible) {
      overrides.push({ ...base, visible: false });
      continue;
    }
    // Faces it draws with nothing: each by its own override, else its faces' (shown here only for a face).
    const sources = (n.object.children.find((c) => c.userData.faces)?.userData.faces ?? []) as number[];
    hiddenFaces += sources.filter((f) => own.get(f)?.hidden ?? look.hidden).length;
    // (A ghost, while something's revealed, at Reveal alpha.)
    const ghost = (reveal: boolean | undefined) => nodes.revealing && reveal !== true;
    const placementAlpha = ghost(look.reveal) ? revealAlpha : look.alpha;
    // Its faces' own overrides.
    const faces: { part: number; face: number; material: number }[] = [];
    for (const [face, o] of own) {
      triangleEdges ||= o.triangleEdges === true;
      if (o.transparent === undefined && o.reveal === undefined) continue;
      const mine = pi.faceMaterials.get(face) ?? pi.material;
      const alpha = ghost(o.reveal ?? look.reveal) ? revealAlpha : o.transparent === undefined ? look.alpha
        : o.transparent ? o.alpha ?? 1 : undefined;
      faces.push({ part, face, material: alpha === undefined ? mine ?? at(undefined, 1) : at(mine, alpha) });
    }
    if (placementAlpha !== undefined) {
      // The placement at its alpha, its faces' own colours too (the override's material recolours them all).
      const listed = new Set(faces.map((f) => f.face));
      for (const [face, m] of pi.faceMaterials) {
        if (!listed.has(face)) faces.push({ part, face, material: at(m, placementAlpha) });
      }
      overrides.push({ ...base, material: at(pi.material, placementAlpha), ...(faces.length
        ? { faceMaterials: faces } : {}) });
    } else if (faces.length) overrides.push({ ...base, faceMaterials: faces });
  }
  const warnings = [...(hiddenFaces ? [`${hiddenFaces} hidden ${hiddenFaces === 1 ? 'face' : 'faces'} written ` +
    'shown: the formats have no hiding of one face of a placed part'] : []),
  ...(triangleEdges ? ["triangle edges aren't written: the formats have no such setting"] : [])];
  return { materials, overrides, warnings };
}

/** The component at an instance path (into the roots, then each component's children). */
function componentAt(scene: Scene, path: readonly number[]): number | undefined {
  let c = scene.roots[path[0]!]?.component;
  for (const i of path.slice(1)) c = c === undefined ? undefined : scene.components[c]?.children[i]?.component;
  return c;
}
