// Mesh edge detection... (edge-dialog.ts, Viewer.detectEdges): edges found from a part's triangles (edges.ts) off the
// page's thread, one request at a time. In: an id, the mesh's positions and indices (copies, transferred) and how to
// find them; out: the id and the edges' segments (transferred).

import { findEdges, type EdgeDetection } from './edges.ts';

export interface EdgeRequest { id: number; positions: Float32Array; indices: Uint32Array; detection: EdgeDetection }
export interface EdgeAnswer { id: number; positions?: Float32Array; error?: string }

const scope = globalThis as unknown as {
  postMessage(msg: EdgeAnswer, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<EdgeRequest>) => void) | null;
};

scope.onmessage = (e) => {
  const { id, positions, indices, detection } = e.data;
  try {
    const found = findEdges(positions, indices, detection.angle, 1 / detection.grid);
    scope.postMessage({ id, positions: found }, [found.buffer as ArrayBuffer]);
  } catch (err) {
    scope.postMessage({ id, error: (err as Error).message ?? String(err) });
  }
};
