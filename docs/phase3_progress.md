# Phase 3 (the backends): plan and progress

*Paths in this document are relative to this `docs/` directory.*

Phase 3 of `architecture.md` ("Phasing"): the tessellation backends, OCCT first, then truck, tested against OCCT. The OCCT backend was brought forward into phase 2 (`phase2_progress.md`, step 4, decision 5) and already passes the end-to-end check, so this phase is mostly the truck backend, plus the host-side machinery both backends need (workers, a watchdog, instance recycling, caching), plus the OCCT loose ends phase 0 and phase 2 left open. This file tracks the order of work and what each step finds.

## Where things stand

- **OCCT backend** (`../packages/tess-occt`): the `Tessellator` interface with face ids, edges, file units and the request origin; 99.1% geometric and 97.8% colour agreement with `occt-import-js` over the corpus (`phase2_progress.md`, step 5). Open: the 62 geometrically bounded surface representations it returns no shape for and the 16 "no shape" errors, instance recycling (OCCT's heap never shrinks), and phase 0's slow `BRepMesh` faces (bicycle #2022).
- **truck** (`../phase0_tessellation_spike/truck_spike`): phase 0's prototype, about 120 lines of Rust over truck `88ed005`, tessellates every shell in a subset and reports face ids by mirroring the `filter_map` in truck's `shell_faces`. It returns unindexed triangles as JSON, with no normals, edges, origin or root. Robustness against OCCT 8.1: 144 of 188 parts within 5% of OCCT's area; 6 panics (`circle.rs:65`, tolerance below 1e-6 on inch parts), one hang over 10 minutes (`trj2_as1-id-203` #891), 93 empty faces. 263,902 bytes brotli, about 1/6 of OCCT.
- **truck upstream** has only a dependency upgrade (`c2a1da8`, 2026-10-12) since our pin, so none of those problems has been fixed upstream.
- **`tessellateScene`** (`../packages/cad-scene/src/tessellate.ts`) runs one request at a time on the calling thread, with no timeout and no cache.

## Steps

| # | Step | Status |
|---|---|---|
| 1 | **Worker host**: a `Tessellator` that runs another backend in a pool of workers (Web Workers in browsers, `worker_threads` in Node), with a per-request timeout that terminates a stuck worker, recycling after a backend trap or after a number of parts or heap size, and `tessellateScene` sending requests in parallel. Tested with a fake backend that hangs, traps and leaks | **Done** 2026-10-17 |
| 2 | **truck backend** (`tess-truck`, Apache-2.0): the production wrapper. A Rust crate in the package (path dependencies on `../third_party/truck`, no fork), built with `wasm-pack`; the representation named by `rootId` (its solids and shells, not every shell in the file); an indexed mesh with normals (truck's per-corner attributes welded into shared vertices); face ids carried through instead of mirrored where truck allows; edges from truck's meshed edges (`PolylineCurve`s that share the faces' boundary points), with kinds and dihedral angles; the origin subtracted in double precision before `Float32`; flat typed arrays across the WebAssembly boundary instead of JSON | Proposed |
| 3 | **truck against OCCT**: unit tests on the cube and small fixtures; corpus checks reusing phase 0's three oracles (area per part against OCCT 8.1, the vertex-based face-id check, bare against wrapped subsets) plus the scene-level check of `scene_occt.ts` with truck in place of our OCCT backend; edges against OCCT's (counts and kinds per part); the files' own validation properties (`validation_occt.ts`) for both backends. Each truck failure classified (panic, hang, wrong area, empty face) with a repro subset | Proposed |
| 4 | **Caching**: tessellation results stored per part, keyed by the payload's hash, the backend's name and version and the request options; an in-memory store, plus stores for the file system (Node) and IndexedDB (browsers); each with a configurable maximum size (least recently used entries evicted), 0 disabling it (decision 4) | Proposed |
| 5 | **OCCT loose ends**: the geometrically bounded surface representations and "no shape" parts; the recycle policy from step 1 tuned on OCCT's heap growth over the corpus | Proposed |
| 6 | **`curves` parts** (decision 5): wireframe representations (74 parts in phase 2's end-to-end check) as polylines, discretized by the backend, with a request and result shape for curves added to the interface | Proposed |

Order: the worker host comes first because truck needs the watchdog to get through the corpus at all (the #891 hang), and OCCT benefits from it as is. Steps 4–6 are independent of truck and could move.

## Decisions (made by the user, 2026-10-17)

1. **Where the worker host lives. Decided by the user (2026-10-17): a new package, `tess-workers`**, so `cad-scene` stays pure data and types. (Alternative: in `cad-scene`, next to `tessellateScene`.) The one package serves both environments:
   - the pool, timeout, recycling and request routing are written once against a small worker handle (`post`, `onMessage`, `onError`, `terminate`);
   - two adapters implement the handle, one over `worker_threads` (Node has no global `Worker`) and one over Web Workers, plus the matching worker-side entry (`parentPort` against `self`);
   - `package.json` conditional exports pick the adapter (`"node"` → the `worker_threads` one, `"default"` → the Web Worker one), so browser bundles never see `worker_threads`.
2. **How truck's tolerance maps onto the request.** truck takes one absolute distance (`tol`, in file units); the interface also has an angular deflection. **Decided by the user (2026-10-17): `tol = linearDeflection`, the angular deflection ignored** (noted in the backend's `info`). Meshes of small round features come out coarser than OCCT's at the same request, and triangle counts differ (phase 0: 1.23 M against OCCT's 0.81 M on the bicycle, at 0.05 mm against 0.05 mm / 0.5 rad). (Alternative: also bound the angle by lowering `tol` per face from its curvature, `r (1 − cos(θ/2))` for radius `r`; closer to OCCT's meshes, but more wrapper code, and truck applies one tolerance per shell, so per-face control may need a call per face.)
3. **truck's known failures.** **Decided by the user (2026-10-17): small workarounds in our wrapper where feasible** (for example, checking each circle's radius against the tolerance before meshing and raising the tolerance locally, to avoid the circle-tolerance panic; keeping the face-id mirroring), **and no upstream reports for now.** Each failure, workaround and repro subset is documented here instead, and how to work with the truck project is decided later. Whatever the workarounds don't cover, the host's trap recovery and watchdog turn into diagnostics. truck itself is not patched (no fork). (Alternative: upstream reports only, with no workarounds.)
4. **Caching. Decided by the user (2026-10-17): in phase 3 (step 4), with a configurable maximum size, in Node and in browsers, that can be set to 0 to disable caching.** (Alternative: deferred to phase 4's `stepconv`.)
5. **`curves` parts. Decided by the user (2026-10-17): in phase 3 (step 6).** (Alternative: left in the backlog.)
6. **The OCCT build variant. Decided by the user (2026-10-17): `-Os` without the `VBernstein` patch**, which isn't worth maintaining for now (2.18 against 1.71 MB brotli). The patch stays documented in `../phase0_tessellation_spike/phase0_results.md` ("Build variants") in case the download size matters later.

## Step 1: the worker host

`../packages/tess-workers` (Apache-2.0; depends on `cad-scene` only):

- **`pool.ts`, `PoolTessellator`:** a `Tessellator` that runs a backend in workers, written against a small `WorkerHandle` (`post`, `onMessage`, `onError`, `terminate`, and in Node `ref`/`unref`). The backend is named by module and export (`{module, export, options}`; the module an absolute URL, e.g. `import.meta.resolve('tess-occt')`) and constructed in each worker. One request per worker at a time, first come first served. Options and defaults:

  | Option | Default | Meaning |
  |---|---|---|
  | `workers` | hardware concurrency − 1, at least 1 | pool size; workers start as requests arrive (`init()` starts the first, which reports the backend's `info`) |
  | `timeoutMs` | 120,000 | per request; the worker is terminated and the request rejected. 0: none |
  | `maxPartsPerWorker` | 0 (never) | recycle a worker after this many parts |
  | `maxMemoryBytes` | 1 GiB | recycle once the backend reports more (`memoryBytes()`, below) |

  A worker is also replaced after any error its backend throws, since a WebAssembly trap (a Rust panic, say) can leave the instance broken, and after it exits or fails; its request is rejected and the queue carries on. A replacement that can't load the backend fails the queued requests only when no other worker is alive, and no further worker starts until one is ready, so a broken backend doesn't respawn forever. Idle workers are `unref`'d in Node, so a pool that isn't disposed doesn't keep the process alive. `dispose()` terminates everything and rejects what's pending. These defaults are placeholders, to be tuned on OCCT in step 5.
- **The two environments** (decision 1): `node.ts` (`worker_threads`) and `browser.ts` (module Web Workers), each with its worker entry (`worker.node.ts`, `worker.browser.ts`, both calling `serve.ts`) and exporting the same `WorkerTessellator`; `package.json` picks one by the `"node"` and `"default"` export conditions. The Node adapter leaves `--input-type` out of the flags workers inherit, since with it (`node -e`) a worker's file entry fails to load.
- **`serve.ts`, the worker side:** imports the backend, then answers each request, transferring the result's buffers rather than copying them (requests are copied, so the caller keeps its payload).
- **Interface addition** (`cad-scene`): the optional `Tessellator.memoryBytes()`, the backend's memory (WASM linear memory, which never shrinks); `OcctTessellator` implements it.
- **`tessellateScene`** gains `concurrency` (requests in flight at once, default 1; set it to the pool's size). Meshes and diagnostics stay in part order whatever order the parts finish in; `onPart` reports in finishing order.

**Tests** (14 new, 90 in the repo): 11 pool tests on a fake backend whose payload picks its behaviour (a result, a hang, a WASM trap, memory growth, a delay, the worker exiting), naming its instance in each result so the tests see replacements: parallel results, the timeout, a trap and an exit (each with a request queued behind), recycling by parts and by memory, init failures, a replacement that can't load (alone, and while another worker is busy, counting the workers started), dispose, and a child Node process that must exit with an undisposed pool. One test runs `tess-occt` in two workers, a fresh one per part, through `tessellateScene` with concurrency 2, and gets meshes and diagnostics identical to OCCT on the main thread (`as1-oc-214-mat.stp`, 5 parts; an instrumented run confirmed 5 workers started and 2 requests in flight). Two `cad-scene` tests check `tessellateScene` at concurrency 1 and 3 (requests, units, the order of results and diagnostics, a failed part).

**Mutation check:** 17 deliberate bugs in the pool, the worker side, the Node adapter and `tessellateScene`, all caught. Two survived the first round, both from weak tests: the exit test queued its follow-up request before the crashing one, and no test had a replacement fail to load while another worker was alive (the only case where blocking further starts matters); both tests were fixed.

**Browsers:** `npm test` runs in Node, which has no Web Workers, so `../packages/tess-workers/test/browser-check.ts` (run by hand: `node packages/tess-workers/test/browser-check.ts [chrome]`) serves the sources with their types stripped (`module.stripTypeScriptTypes`) and runs six of the scenarios in headless Chrome: parallel results, the timeout, a trap, recycling, init failure and a missing backend module. All pass in HeadlessChrome 155. With the adapter mutated to start classic instead of module workers, all six fail, through the `onerror` path. Not checked: Firefox and Safari.

## Not planned

- **monstertruck:** phase 0 found it no clear improvement over truck (fixes 29 parts, regresses 15); the corpus harness can track it later if that changes.
- **IGES and BREP payloads** for OCCT: they come with their importers ("Future input formats" in `architecture.md`).
