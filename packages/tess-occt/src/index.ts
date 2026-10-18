// The OCCT tessellation backend: implements cad-scene's Tessellator over the WebAssembly build of native/occt_tess.cpp
// (build with ./build.sh). License: LGPL-2.1 with the Open CASCADE exception, isolated in this package.

import type { Diagnostic, EdgeKind, TessellationRequest, TessellationResult, Tessellator, TessellatorInfo } from 'cad-scene';

interface OcctModule {
  HEAPU8: Uint8Array;
  HEAPF32: Float32Array;
  HEAPU32: Uint32Array;
  HEAP32: Int32Array;
  UTF8ToString(p: number): string;
  _malloc(n: number): number;
  _free(p: number): void;
  _occt_tessellate(data: number, len: number, rootId: number, lin: number, ang: number, productMode: number, ox: number, oy: number, oz: number): number;
  _occt_positions(): number;
  _occt_normals(): number;
  _occt_num_vertices(): number;
  _occt_indices(): number;
  _occt_num_indices(): number;
  _occt_faces(): number;
  _occt_num_faces(): number;
  _occt_edge_positions(): number;
  _occt_num_edge_points(): number;
  _occt_edges(): number;
  _occt_edge_angles(): number;
  _occt_num_edges(): number;
  _occt_diag(): number;
  _occt_free(): void;
}

const KINDS: EdgeKind[] = ['shared', 'seam', 'free', 'degenerate'];

export class OcctTessellator implements Tessellator {
  readonly info: TessellatorInfo = {
    name: 'occt', version: 'OCCT 8.1 (3d097a0328)', license: 'LGPL-2.1-only WITH OCCT-exception-1.0',
    formats: ['step'], supportsFaceIds: true, supportsEdges: true,
  };
  private m?: OcctModule;

  /** Load and instantiate the WebAssembly module (dist/occt_tess.mjs). */
  async init(): Promise<void> {
    if (this.m) return;
    const factory = (await import(new URL('../dist/occt_tess.mjs', import.meta.url).href)).default as () => Promise<OcctModule>;
    this.m = await factory();
  }

  async tessellate(req: TessellationRequest): Promise<TessellationResult> {
    const m = this.m;
    if (!m) throw new Error('OcctTessellator: call init() first');
    if (req.format !== 'step') throw new Error(`OcctTessellator: format '${req.format}' isn't supported yet`);
    const origin = req.origin ?? [0, 0, 0];
    const ptr = m._malloc(req.data.length);
    m.HEAPU8.set(req.data, ptr);
    let rc: number;
    try {
      rc = m._occt_tessellate(ptr, req.data.length, req.rootId ?? 0, req.linearDeflection, req.angularDeflection, 0, origin[0], origin[1], origin[2]);
    } finally {
      m._free(ptr);
    }
    const diagText = m.UTF8ToString(m._occt_diag());
    const diag = JSON.parse(diagText) as Record<string, unknown>;
    const diagnostics: Diagnostic[] = [];
    if (rc !== 0) {
      m._occt_free();
      diagnostics.push({ severity: 'error', message: `OCCT: ${String(diag.error)}${diag.what ? `: ${String(diag.what)}` : ''}` });
      return { origin, positions: new Float32Array(), indices: new Uint32Array(), faces: [], diagnostics };
    }
    // Copy out of the heap: it can move on the next allocation.
    const f32 = (p: number, n: number) => m.HEAPF32.slice(p >> 2, (p >> 2) + n);
    const u32 = (p: number, n: number) => m.HEAPU32.slice(p >> 2, (p >> 2) + n);
    const i32 = (p: number, n: number) => m.HEAP32.slice(p >> 2, (p >> 2) + n);
    const nv = m._occt_num_vertices();
    const positions = f32(m._occt_positions(), nv * 3);
    const normals = f32(m._occt_normals(), nv * 3);
    const indices = u32(m._occt_indices(), m._occt_num_indices());
    const faceData = i32(m._occt_faces(), m._occt_num_faces() * 3);
    const faces: TessellationResult['faces'] = [];
    for (let i = 0; i < faceData.length; i += 3) {
      faces.push({ entityId: faceData[i]! < 0 ? null : faceData[i]!, start: faceData[i + 1]!, count: faceData[i + 2]! });
    }
    const result: TessellationResult = { origin, positions, normals, indices, faces, diagnostics };
    if (req.edges) {
      const ne = m._occt_num_edges();
      const edgeData = i32(m._occt_edges(), ne * 4);
      const angles = f32(m._occt_edge_angles(), ne);
      result.edgePositions = f32(m._occt_edge_positions(), m._occt_num_edge_points() * 3);
      result.edges = [];
      for (let i = 0; i < ne; i++) {
        const e: NonNullable<TessellationResult['edges']>[number] = {
          entityId: edgeData[i * 4]! < 0 ? null : edgeData[i * 4]!, start: edgeData[i * 4 + 1]!, count: edgeData[i * 4 + 2]!, kind: KINDS[edgeData[i * 4 + 3]!]!,
        };
        if (angles[i]! >= 0) e.dihedral = angles[i]!;
        result.edges.push(e);
      }
    }
    m._occt_free();
    if (diag.unmapped) diagnostics.push({ severity: 'info', message: `${String(diag.unmapped)} faces without a STEP entity id` });
    if (diag.noTriangulation) diagnostics.push({ severity: 'warning', message: `${String(diag.noTriangulation)} faces failed to mesh` });
    return result;
  }

  memoryBytes(): number {
    return this.m?.HEAPU8.buffer.byteLength ?? 0;
  }

  dispose(): void {
    this.m = undefined;
  }
}
