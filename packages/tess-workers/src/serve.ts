// The worker side: load the backend, then answer requests one at a time, transferring the result's buffers. The
// backend's module is imported by its specifier, unless the worker's entry imported it already and passes it in
// `modules`: a bundler (the viewer's Vite build) can only bundle modules imported statically.

import { TessellationError, type TessellationResult, type Tessellator } from 'cad-scene';
import type { WorkerPort } from './protocol.ts';

const message = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

/**
 * This thread's CPU time in milliseconds (Node's process.threadCpuUsage: a worker's own, not the process's), or
 * undefined where the host has none (browsers).
 */
const threadCpu: (() => number) | undefined = (() => {
  const p = (globalThis as { process?: { threadCpuUsage?: () => { user: number; system: number } } }).process;
  const f = p?.threadCpuUsage;
  return typeof f === 'function' ? () => {
    const u = f.call(p);
    return (u.user + u.system) / 1000;
  } : undefined;
})();

function buffers(r: TessellationResult): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>();
  for (const a of [r.positions, r.normals, r.indices, r.edgePositions, r.curvePositions, r.points,
    r.outlinePositions]) if (
    a && a.buffer instanceof ArrayBuffer) out.add(a.buffer);
  return [...out];
}

/** Answers the pool's requests on `port`. `modules`: backend modules already imported, by specifier. */
export function serve(port: WorkerPort, modules: Record<string, Record<string, unknown>> = {}): void {
  let tess: Tessellator | undefined;
  port.onMessage(async (msg) => {
    if (msg.type === 'init') {
      try {
        const mod = modules[msg.backend.module] ?? (await import(msg.backend.module)) as Record<string, unknown>;
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
      const id = msg.id;
      const t0 = threadCpu?.();
      const cpu = () => (t0 === undefined ? {} : { cpuMs: threadCpu!() - t0 });
      const result = await tess.tessellate(msg.req, (progress) => port.post({ type: 'progress', id, progress,
        ...cpu() }, []));
      const memory = tess.memoryBytes?.();
      port.post({ type: 'result', id: msg.id, result, ...(memory === undefined ? {} : { memory }), ...cpu() },
        buffers(result));
    } catch (e) {
      const part = e instanceof TessellationError || e instanceof WebAssembly.RuntimeError;
      const timeoutMs = e instanceof TessellationError ? e.timeoutMs : undefined;
      port.post({ type: 'error', id: msg.id, message: message(e), part,
        ...(timeoutMs === undefined ? {} : { timeoutMs }) }, []);
    }
  });
}
