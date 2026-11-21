// A scene of parts that healing changes in different ways (and one it leaves alone), each placed at the root, for
// healScene's tests and the importers': serial against parallel healing, the switches, the per-fix options. `stepOf`
// writes it as STEP (step-export), for an import to heal.

import { identity, type Part, type Scene } from 'cad-scene';
import { BrepBuilder, type BrepData } from '../../cad-brep/src/index.ts';
import { box } from '../../cad-brep/test/models.ts';
import { exportStep } from '../../step-export/src/index.ts';
import { cylinderSide, planeArc, strayPole } from './models.ts';

/**
 * The parts: a stray pole (strayPole moves it; its face 8), an arc 0.01 mm off its plane (edgeTolerance grows its
 * edges; face 8), a cylinder's side, its bottom coedge without a p-curve (made by pcurveMissingOnElementary only), a
 * box (nothing to heal). Their names say which.
 */
export function healParts(): { name: string; model: BrepData }[] {
  const solid = new BrepBuilder({ uncertainty: 1e-6 });
  solid.addItem({ kind: 'body', ref: solid.addBody({ kind: 'solid', members: [{ ref: box(solid), sense: true }] }) });
  return [{ name: 'stray', model: strayPole().finish() },
    { name: 'lifted', model: planeArc(undefined, undefined, 0.01).finish() },
    { name: 'cylinder', model: cylinderSide({ bottom: {} }).finish() }, { name: 'box', model: solid.finish() }];
}

export function healTestScene(): Scene {
  const parts: Part[] = healParts().map(({ name, model }, i) => ({ name, sources: [{ format: 'step', id: 100 + i }],
    properties: {}, origin: [0, 0, 0], brep: { model, format: 'step' }, lods: [] }));
  return { unit: 'millimetre', components: [{ name: 'top', sources: [], properties: {}, parts: parts.map((_, part) =>
    ({ part, transform: identity(), sources: [], properties: {} })), children: [] }],
  roots: [{ component: 0, transform: identity(), sources: [], properties: {} }], parts, materials: [], layers: [],
  overrides: [], properties: {}, diagnostics: [] } as unknown as Scene;
}

/** The scene as a STEP file's bytes. */
export function stepOf(scene: Scene): Uint8Array {
  const chunks = [...exportStep(scene).chunks];
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}
