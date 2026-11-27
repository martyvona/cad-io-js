// A backend for the records' pool test: each plane face of cad-brep's test cube as two triangles (cad-scene's test
// quads), as a backend without measures of its own gives it: with measures the thread's area oracle's areas.

import { openBrep } from 'cad-brep';
import { oracleMeasures, type TessellationRequest, type TessellationResult, type Tessellator } from 'cad-scene';
import { quads } from '../../cad-scene/test/meshes.ts';

export class QuadsTessellator implements Tessellator {
  readonly info = { name: 'quads-test', version: '1', license: 'AGPL-3.0-only', formats: ['cad-brep' as const],
    supportsFaceIds: true, supportsEdges: true, supportsCurves: false };
  async init(): Promise<void> {}
  async tessellate(req: TessellationRequest): Promise<TessellationResult> {
    const d = openBrep(new Uint8Array(req.data).buffer);
    return { ...quads(d), ...(req.measures ? { oracle: oracleMeasures(req.data) } : {}) };
  }
  dispose(): void {}
}
