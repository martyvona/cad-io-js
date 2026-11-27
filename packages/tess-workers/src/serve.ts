// The worker side: load the backend, then answer requests one at a time, transferring the result's buffers; and run
// jobs (protocol.ts), transferring their outputs' buffers. A backend's or job's module is imported by its specifier,
// unless the worker's entry imported it already and passes it in `modules`: a bundler (the viewer's Vite build) can
// only bundle modules imported statically.

import { openBrep } from 'cad-brep';
import { faceRecords, type RecordInputs, setAreaOracle, sha256, TessellationError, type TessellationRequest,
  type TessellationResult, type Tessellator, type TessellatorInfo } from 'cad-scene';
import { AREA_ORACLE_ID, areaOracle, init as initOracle } from 'cad-oracle';
import { CadioTessellator } from 'tess-cadio';
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
  if (r.records) for (const a of Object.values(r.records)) if (ArrayBuffer.isView(a) && a.buffer instanceof ArrayBuffer)
    out.add(a.buffer);
  return [...out];
}

/** What tess-cadio gives a face's record (g, h): its part size and each face's expected count, for a request. */
interface RecordHelper {
  partSize(data: Uint8Array): number;
  expectedCounts(req: Pick<TessellationRequest, 'data' | 'linearDeflection' | 'angularDeflection' | 'minAngle'
    | 'maxEdge' | 'elementaryStretchCap' | 'analysis'>): Map<number, number>;
}
const isHelper = (t: unknown): t is RecordHelper => typeof (t as RecordHelper | undefined)?.expectedCounts
  === 'function' && typeof (t as RecordHelper).partSize === 'function';

/**
 * tess-cadio with its defaults, for the records of another backend's results: its module instantiated on the first
 * request asking for records (only then: it's a few MB of WebAssembly; importing the package loads none), unless
 * the backend is tess-cadio, whose own instance gives the part's size (its (h) is what it reports). Imported
 * statically: the viewer's worker bundles tess-cadio anyway, and a dynamic import there is a build warning.
 */
let helper: Promise<RecordHelper> | undefined;
const recordHelper = (tess: Tessellator) => isHelper(tess) ? Promise.resolve(tess) : helper ??= (async () => {
  const t: Tessellator = new CadioTessellator();
  await t.init();
  if (!isHelper(t)) throw new Error('tess-cadio has no partSize and expectedCounts');
  return t;
})();

/**
 * The last parts' record inputs by a hash of their payload, analysis and the request's deflections and meshing limits
 * (minAngle, maxEdge, elementaryStretchCap: the expected counts depend on them): a
 * part meshed by a primary and then a fallback (two pools, each its own workers, so per worker only when one worker
 * meshes it twice) or asked again counted once.
 */
const inputsCache = new Map<string, RecordInputs>();
const INPUTS_KEPT = 8;

/** The result's triage records (cad-scene's records.ts) for its request, (g) and (h) by tess-cadio. */
async function withRecords(tess: Tessellator, req: TessellationRequest, r: TessellationResult): Promise<void> {
  if (req.format !== 'cad-brep') return;
  const data = new Uint8Array(req.data);
  const model = openBrep(data.buffer);
  const hex = async (u: Uint8Array) => Array.from(await sha256(new Uint8Array(u)), (x) => x.toString(16)
    .padStart(2, '0')).join('');
  const key = `${isHelper(tess) ? 'own' : 'helper'}:${req.recordExpected ? 1 : 0}:${req.linearDeflection},`
    + `${req.angularDeflection},${req.minAngle ?? ''},${req.maxEdge ?? ''},${req.elementaryStretchCap ?? ''}:`
    + `${await hex(data)}:${req.analysis ? await hex(req.analysis) : ''}`;
  let inputs = inputsCache.get(key);
  if (!inputs) {
    try {
      // (tess-cadio's own results: (h) the counts it capped by, which it reports; another backend's only where the
      // request pays for tess-cadio's first meshing, recordExpected, else unmeasured here.)
      const h = await recordHelper(tess);
      inputs = isHelper(tess) || !req.recordExpected ? { partSize: h.partSize(req.data) }
        : { partSize: h.partSize(req.data), expected: h.expectedCounts(req) };
    } catch (e) {
      r.diagnostics.push({ severity: 'warning', message: `triage records without part size and expected counts: `
        + message(e) });
      inputs = {};
    }
    inputsCache.set(key, inputs);
    if (inputsCache.size > INPUTS_KEPT) inputsCache.delete(inputsCache.keys().next().value!);
  }
  r.records = faceRecords(req, r, model, inputs);
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
      if (msg.req.records) await withRecords(tess, msg.req, result);
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
