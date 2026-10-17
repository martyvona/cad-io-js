// Walking a scene: the expanded tree of instances with their world transforms and resolved appearance, and a
// structural check.

import type { Mat4, Part, PartRef, Scene } from './scene.ts';

export function identity(): Mat4 {
  const m = new Float64Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float64Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r]! * b[c * 4 + k]!;
      out[c * 4 + r] = s;
    }
  }
  return out;
}

export function scaling(s: number): Mat4 {
  const m = identity();
  m[0] = m[5] = m[10] = s;
  return m;
}

/** One instance of a component in the expanded tree. */
export interface ComponentInstance {
  /** Indices from the root: into `roots`, then into each component's `children`. */
  path: number[];
  component: number;
  /** From the component's coordinates to the scene's, in millimetres. */
  transform: Mat4;
}

/**
 * Every component instance, depth first in order. A component that (through a cycle) contains itself is not
 * expanded again inside itself.
 */
export function* instances(scene: Scene): Generator<ComponentInstance> {
  function* visit(component: number, path: number[], transform: Mat4, onPath: Set<number>): Generator<ComponentInstance> {
    yield { path, component, transform };
    const children = scene.components[component]!.children;
    for (let i = 0; i < children.length; i++) {
      const occ = children[i]!;
      if (onPath.has(occ.component)) continue;
      onPath.add(occ.component);
      yield* visit(occ.component, [...path, i], multiply(transform, occ.transform), onPath);
      onPath.delete(occ.component);
    }
  }
  for (let i = 0; i < scene.roots.length; i++) {
    const occ = scene.roots[i]!;
    yield* visit(occ.component, [i], occ.transform, new Set([occ.component]));
  }
}

/** One placed part, with its appearance resolved. */
export interface PartInstance {
  /** The component instance's path. */
  path: number[];
  part: number;
  ref: PartRef;
  /** From the part's coordinates (its own unit) to the scene's, in millimetres. */
  transform: Mat4;
  /** The material of faces without one of their own; undefined: the viewer's default. */
  material?: number;
  /** Per-face materials, by face source id. */
  faceMaterials: Map<number, number>;
  visible: boolean;
}

/**
 * Every placed part, with materials resolved top down, as the CAx-IF styling practice has it (an assembly's style
 * applies to everything in it, regardless of how the parts are styled):
 *
 * 1. an instance override with a material, the deepest on the path first, recolours the whole part instance;
 * 2. otherwise the topmost component on the path with a material does;
 * 3. otherwise the part reference's material, else the part's, with the part's per-face materials on top.
 *
 * Instance overrides' per-face materials apply last. A part instance is hidden if an override on its path or its part
 * reference says so.
 */
export function* partInstances(scene: Scene): Generator<PartInstance> {
  const overrides = new Map<string, Scene['overrides']>();
  for (const o of scene.overrides) {
    const key = o.path.join('/');
    let list = overrides.get(key);
    if (!list) overrides.set(key, (list = []));
    list.push(o);
  }
  // Component instances by path, for the components along each path.
  const byPath = new Map<string, ComponentInstance>();
  for (const inst of instances(scene)) {
    byPath.set(inst.path.join('/'), inst);
    const comp = scene.components[inst.component]!;
    const prefixes = inst.path.map((_, i) => inst.path.slice(0, i + 1).join('/'));
    const chain = prefixes.map((p) => byPath.get(p)!);
    const pathOverrides = prefixes.flatMap((p) => overrides.get(p) ?? []);
    const visible = !pathOverrides.some((o) => o.visible === false);
    const overrideMaterial = [...pathOverrides].reverse().find((o) => o.material !== undefined)?.material;
    const componentMaterial = chain.map((c) => scene.components[c.component]!.material).find((m) => m !== undefined);
    for (const ref of comp.parts) {
      const part: Part = scene.parts[ref.part]!;
      const faceMaterials = new Map<number, number>();
      let material = overrideMaterial ?? componentMaterial;
      if (material === undefined) {
        material = ref.material ?? part.material;
        for (const f of part.faceMaterials ?? []) faceMaterials.set(f.face, f.material);
      }
      for (const o of pathOverrides) for (const f of o.faceMaterials ?? []) if (f.part === ref.part) faceMaterials.set(f.face, f.material);
      const pi: PartInstance = { path: inst.path, part: ref.part, ref, transform: multiply(inst.transform, ref.transform), faceMaterials, visible: visible && ref.visible !== false };
      if (material !== undefined) pi.material = material;
      yield pi;
    }
  }
}

/** Structural problems: indices out of range, non-finite transforms, components that contain themselves. */
export function validate(scene: Scene): string[] {
  const problems: string[] = [];
  const nc = scene.components.length, np = scene.parts.length, nm = scene.materials.length;
  const finite = (m: Mat4, where: string) => {
    if (m.length !== 16 || !m.every(Number.isFinite)) problems.push(`${where}: transform is not 16 finite numbers`);
  };
  const material = (m: number | undefined, where: string) => {
    if (m !== undefined && !(Number.isInteger(m) && m >= 0 && m < nm)) problems.push(`${where}: material ${m} out of range`);
  };
  scene.roots.forEach((o, i) => {
    if (!(o.component >= 0 && o.component < nc)) problems.push(`roots[${i}]: component ${o.component} out of range`);
    finite(o.transform, `roots[${i}]`);
  });
  scene.components.forEach((c, i) => {
    material(c.material, `components[${i}]`);
    c.children.forEach((o, k) => {
      if (!(o.component >= 0 && o.component < nc)) problems.push(`components[${i}].children[${k}]: component ${o.component} out of range`);
      finite(o.transform, `components[${i}].children[${k}]`);
    });
    c.parts.forEach((r, k) => {
      if (!(r.part >= 0 && r.part < np)) problems.push(`components[${i}].parts[${k}]: part ${r.part} out of range`);
      finite(r.transform, `components[${i}].parts[${k}]`);
      material(r.material, `components[${i}].parts[${k}]`);
    });
  });
  scene.parts.forEach((p, i) => {
    material(p.material, `parts[${i}]`);
    for (const f of p.faceMaterials ?? []) material(f.material, `parts[${i}].faceMaterials`);
    if (!(p.unit > 0)) problems.push(`parts[${i}]: unit ${p.unit} is not positive`);
  });
  // Cycles: a component reachable from itself.
  const state = new Uint8Array(nc); // 0 new, 1 on the stack, 2 done
  const visit = (c: number): void => {
    state[c] = 1;
    for (const o of scene.components[c]!.children) {
      if (!(o.component >= 0 && o.component < nc)) continue;
      if (state[o.component] === 1) problems.push(`component ${o.component} contains itself`);
      else if (state[o.component] === 0) visit(o.component);
    }
    state[c] = 2;
  };
  for (let c = 0; c < nc; c++) if (state[c] === 0) visit(c);
  return problems;
}
