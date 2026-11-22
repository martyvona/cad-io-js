// The worker side: load the backend, then answer requests one at a time, transferring the result's buffers; and run
// jobs (protocol.ts), transferring their outputs' buffers. A backend's or job's module is imported by its specifier,
// unless the worker's entry imported it already and passes it in `modules`: a bundler (the viewer's Vite build) can
// only bundle modules imported statically.

import { setAreaOracle, TessellationError, type TessellationResult, type Tessellator, type TessellatorInfo }
  from 'cad-scene';
import { AREA_ORACLE_ID, areaOracle, init as initOracle } from 'cad-oracle';
import type { WorkerPort } from './protocol.ts';

/**
 * cad-oracle as this thread's area oracle (cad-scene's setAreaOracle), so every backend's adapter gives its areas in
 * results with measures: loaded on the first request asking for measures (about 1 MB of WebAssembly). Where it fails
 * to load, cad-scene's own stays, said in the result.
 */
let oracle: Promise<string | undefined> | undefined;
const oracleLoaded = () => oracle ??= initOracle().then((m) => {
  setAreaOracle(areaOracle(m));
  return undefined;
}, (e: unknown) => `the area oracle (cad-oracle) failed to load, cad-scene's used: ${message(e)}`);

/** A pool without a backend's info: it only runs jobs. */
export const NO_BACKEND: TessellatorInfo = { name: 'none', version: '', license: '', formats: [],
  supportsFaceIds: false, supportsEdges: false, supportsCurves: false };

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

/** The buffers of the typed arrays in a job's output (plain objects and arrays, walked), once each. */
export function outputBuffers(output: unknown): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>(), seen = new Set<object>();
  const walk = (v: unknown) => {
    if (typeof v !== 'object' || v === null || seen.has(v)) return;
    seen.add(v);
    if (ArrayBuffer.isView(v)) {
      if (v.buffer instanceof ArrayBuffer) out.add(v.buffer);
    } else if (v instanceof ArrayBuffer) out.add(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (Object.getPrototypeOf(v) === Object.prototype) Object.values(v).forEach(walk);
  };
  walk(output);
  return [...out];
}

type JobFunction = (input: unknown, progress: (message: string) => void) => unknown;

/** Answers the pool's requests on `port`. `modules`: backend modules already imported, by specifier. */
export function serve(port: WorkerPort, modules: Record<string, Record<string, unknown>> = {}): void {
  let tess: Tessellator | undefined;
  const load = async (spec: { module: string }) =>
    modules[spec.module] ?? (await import(spec.module)) as Record<string, unknown>;
  port.onMessage(async (msg) => {
    if (msg.type === 'init') {
      if (!msg.backend) {
        port.post({ type: 'ready', info: NO_BACKEND }, []);
        return;
      }
      try {
        const mod = await load(msg.backend);
        const C = mod[msg.backend.export] as (new () => Tessellator) | undefined;
        if (typeof C !== 'function') throw new Error(`${msg.backend.module} has no export '${msg.backend.export}'`);
        tess = new C();
        await tess.init(msg.backend.options);
        // (Its results' areas are cad-oracle's, so a cache keyed on the version misses when those change.)
        const info = { ...tess.info, version: `${tess.info.version}, area oracle ${AREA_ORACLE_ID}` };
        port.post({ type: 'ready', info }, []);
      } catch (e) {
        port.post({ type: 'initError', message: message(e) }, []);
      }
      return;
    }
    if (msg.type === 'run') {
      const id = msg.id;
      try {
        const f = (await load(msg.job))[msg.job.export] as JobFunction | undefined;
        if (typeof f !== 'function') throw new Error(`${msg.job.module} has no function '${msg.job.export}'`);
        const t0 = threadCpu?.();
        const output = await f(msg.input, (message) => port.post({ type: 'jobProgress', id, message,
          ...(t0 === undefined ? {} : { cpuMs: threadCpu!() - t0 }) }, []));
        port.post({ type: 'output', id, output }, outputBuffers(output));
      } catch (e) {
        port.post({ type: 'error', id, message: message(e), part: false }, []);
      }
      return;
    }
    try {
      if (!tess) throw new Error('worker: no backend loaded');
      const id = msg.id;
      const t0 = threadCpu?.();
      const cpu = () => (t0 === undefined ? {} : { cpuMs: threadCpu!() - t0 });
      const failed = msg.req.measures ? await oracleLoaded() : undefined;
      const result = await tess.tessellate(msg.req, (progress) => port.post({ type: 'progress', id, progress,
        ...cpu() }, []));
      if (failed) result.diagnostics.push({ severity: 'warning', message: failed });
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
