// The worker side: load the backend, then answer requests one at a time, transferring the result's buffers.

import { TessellationError, type TessellationResult, type Tessellator } from 'cad-scene';
import type { WorkerPort } from './protocol.ts';

const message = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

function buffers(r: TessellationResult): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>();
  for (const a of [r.positions, r.normals, r.indices, r.edgePositions, r.curvePositions, r.points]) if (
    a && a.buffer instanceof ArrayBuffer) out.add(a.buffer);
  return [...out];
}

export function serve(port: WorkerPort): void {
  let tess: Tessellator | undefined;
  port.onMessage(async (msg) => {
    if (msg.type === 'init') {
      try {
        const mod = (await import(msg.backend.module)) as Record<string, unknown>;
        const C = mod[msg.backend.export] as (new () => Tessellator) | undefined;
        if (typeof C !== 'function') throw new Error(`${msg.backend.module} has no export '${msg.backend.export}'`);
        tess = new C();
        await tess.init(msg.backend.options);
        port.post({ type: 'ready', info: tess.info }, []);
      } catch (e) {
        port.post({ type: 'initError', message: message(e) }, []);
      }
      return;
    }
    try {
      if (!tess) throw new Error('worker: no backend loaded');
      const result = await tess.tessellate(msg.req);
      const memory = tess.memoryBytes?.();
      port.post(memory === undefined ? { type: 'result', id: msg.id, result } : { type: 'result', id: msg.id, result,
        memory }, buffers(result));
    } catch (e) {
      const part = e instanceof TessellationError || e instanceof WebAssembly.RuntimeError;
      const timeoutMs = e instanceof TessellationError ? e.timeoutMs : undefined;
      port.post({ type: 'error', id: msg.id, message: message(e), part,
        ...(timeoutMs === undefined ? {} : { timeoutMs }) }, []);
    }
  });
}
