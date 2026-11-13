// SceneBuilder (docs/scene-formats.md): a scene made a row at a time, as cad-brep's BrepBuilder makes a model, each
// placement's transform checked rigid (a rotation and a translation) and each reference to something added before. What
// it throws on is its caller's bug; problems in a source are an importer's diagnostics. The scene's plain objects stay
// writable: this is a checked way to build one, not the only one.

import type { Component, Diagnostic, InstanceOverride, Layer, Mat4, Material, Occurrence, Part, PartRef, Properties,
  Scene } from './scene.ts';
import { TRANSFORM_TOLERANCE } from './transforms.ts';

/** Whether a transform is a rotation and a translation (column-major), to TRANSFORM_TOLERANCE. */
export function isRigid(m: Mat4): boolean {
  if (m.length !== 16 || !Array.from(m).every(Number.isFinite)) return false;
  if (Math.abs(m[3]!) > TRANSFORM_TOLERANCE || Math.abs(m[7]!) > TRANSFORM_TOLERANCE
    || Math.abs(m[11]!) > TRANSFORM_TOLERANCE || Math.abs(m[15]! - 1) > TRANSFORM_TOLERANCE) return false;
  const c = [0, 1, 2].map((j) => [m[4 * j]!, m[4 * j + 1]!, m[4 * j + 2]!]);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      const dot = c[i]![0]! * c[j]![0]! + c[i]![1]! * c[j]![1]! + c[i]![2]! * c[j]![2]!;
      if (Math.abs(dot - (i === j ? 1 : 0)) > TRANSFORM_TOLERANCE) return false;
    }
  }
  const [a, b, d] = c as [number[], number[], number[]];
  const det = a[0]! * (b[1]! * d[2]! - b[2]! * d[1]!) - b[0]! * (a[1]! * d[2]! - a[2]! * d[1]!)
    + d[0]! * (a[1]! * b[2]! - a[2]! * b[1]!);
  return det > 0;
}

/** Throws unless every placement in the scene is rigid: what exporters call first. */
export function assertRigid(scene: Scene): void {
  const bad = (where: string, m: Mat4) => {
    if (!isRigid(m)) {
      throw new RangeError(`${where}: a transform that isn't a rotation and a translation (placements are rigid: `
        + `make them so with rigidPlacements): ${Array.from(m).map((x) => +x.toPrecision(6)).join(' ')}`);
    }
  };
  scene.roots.forEach((o, k) => bad(`root ${k}`, o.transform));
  (scene.rootParts ?? []).forEach((r, k) => bad(`root part ${k}`, r.transform));
  scene.components.forEach((c, i) => {
    c.parts.forEach((r, k) => bad(`component ${i} (${c.name}), part ${k}`, r.transform));
    c.children.forEach((o, k) => bad(`component ${i} (${c.name}), child ${k}`, o.transform));
  });
}

export class SceneBuilder {
  private readonly scene: Scene;

  constructor(opts: { properties?: Properties; sourceUnit?: number; fileAxes?: Mat4 } = {}) {
    this.scene = { unit: 'millimetre', components: [], roots: [], parts: [], materials: [], layers: [], overrides: [],
      properties: { ...opts.properties }, diagnostics: [], ...(opts.sourceUnit === undefined ? {} : {
        sourceUnit: opts.sourceUnit }), ...(opts.fileAxes ? { fileAxes: opts.fileAxes } : {}) };
  }

  private check(what: string, m: Mat4) {
    if (!isRigid(m)) {
      throw new RangeError(`${what}: a transform that isn't a rotation and a translation (placements are rigid: `
        + 'bake a mirror, scale or shear into the part, or use rigidPlacements on the scene)');
    }
  }

  private index(table: 'parts' | 'components' | 'materials', i: number | undefined, what: string) {
    if (i === undefined) return;
    if (!Number.isInteger(i) || i < 0 || i >= this.scene[table].length) {
      const n = this.scene[table].length;
      throw new RangeError(`${what}: ${table.replace(/s$/, '')} ${i} not added yet (${n} so far)`);
    }
  }

  addMaterial(m: Material): number {
    this.scene.materials.push(m);
    return this.scene.materials.length - 1;
  }

  addLayer(l: Layer): number {
    this.scene.layers.push(l);
    return this.scene.layers.length - 1;
  }

  /** A part: its geometry in its own coordinates (millimetres). */
  addPart(p: Part): number {
    this.index('materials', p.material, `part ${this.scene.parts.length}`);
    for (const f of p.faceMaterials ?? []) this.index('materials', f.material, `part ${this.scene.parts.length}`);
    this.scene.parts.push(p);
    return this.scene.parts.length - 1;
  }

  /** A component, its parts and children added after it (addPartRef, addOccurrence). */
  addComponent(c: Omit<Component, 'parts' | 'children'>): number {
    this.index('materials', c.material, `component ${this.scene.components.length}`);
    this.scene.components.push({ ...c, parts: [], children: [] });
    return this.scene.components.length - 1;
  }

  /** A part placed in a component, or at the top (`'root'`), at a rigid transform. */
  addPartRef(into: number | 'root', r: PartRef): void {
    const what = into === 'root' ? 'a root part' : `component ${into}'s part`;
    this.index('parts', r.part, what);
    this.index('materials', r.material, what);
    this.check(what, r.transform);
    if (into === 'root') (this.scene.rootParts ??= []).push(r);
    else {
      this.index('components', into, what);
      this.scene.components[into]!.parts.push(r);
    }
  }

  /** A component placed in another, or at the top (`'root'`), at a rigid transform. */
  addOccurrence(into: number | 'root', o: Occurrence): void {
    const what = into === 'root' ? 'a root' : `component ${into}'s child`;
    this.index('components', o.component, what);
    this.check(what, o.transform);
    if (into === 'root') this.scene.roots.push(o);
    else {
      this.index('components', into, what);
      this.scene.components[into]!.children.push(o);
    }
  }

  addOverride(o: InstanceOverride): void {
    this.index('materials', o.material, 'an override');
    this.scene.overrides.push(o);
  }

  addDiagnostic(d: Diagnostic): void {
    this.scene.diagnostics.push(d);
  }

  /** The scene, its lists copied (the parts and materials shared): the builder can go on after it. */
  finish(): Scene {
    const s = this.scene;
    return { ...s, components: s.components.map((c) => ({ ...c, parts: [...c.parts], children: [...c.children] })),
      roots: [...s.roots], ...(s.rootParts ? { rootParts: [...s.rootParts] } : {}), parts: [...s.parts],
      materials: [...s.materials], layers: [...s.layers], overrides: [...s.overrides], properties: { ...s.properties },
      diagnostics: [...s.diagnostics] };
  }
}
