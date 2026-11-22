// A backend for the area oracle's pool test: no triangles, and with measures the thread's area oracle's areas
// (cad-scene's oracleMeasures), as every backend's adapter gives them.

import { oracleMeasures, type TessellationRequest, type TessellationResult, type Tessellator } from 'cad-scene';

export class OracleTessellator implements Tessellator {
  readonly info = { name: 'oracle-test', version: '1', license: 'AGPL-3.0-only', formats: ['cad-brep' as const],
    supportsFaceIds: true, supportsEdges: false, supportsCurves: false };
  async init(): Promise<void> {}
  async tessellate(req: TessellationRequest): Promise<TessellationResult> {
    return { origin: [0, 0, 0], positions: new Float32Array(), indices: new Uint32Array(), faces: [], diagnostics: [],
      ...(req.measures ? { oracle: oracleMeasures(req.data) } : {}) };
  }
  dispose(): void {}
}
