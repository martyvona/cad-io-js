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
| 2 | **truck backend** (`tess-truck`, Apache-2.0): the production wrapper. A Rust crate in the package (path dependencies on `../third_party/truck`, no fork), built with `cargo` and `wasm-opt` into a plain WebAssembly module; the representation named by `rootId` (its solids and shells, not every shell in the file); an indexed mesh with normals (truck's per-corner attributes welded into shared vertices); face ids carried through instead of mirrored where truck allows; edges from truck's meshed edges (`PolylineCurve`s that share the faces' boundary points), with kinds and dihedral angles; the origin subtracted in double precision before `Float32`; flat typed arrays across the WebAssembly boundary instead of JSON | **Done** 2026-10-18 |
| 3 | **truck against OCCT**: unit tests on the cube and small fixtures; corpus checks reusing phase 0's three oracles (area per part against OCCT 8.1, the vertex-based face-id check, bare against wrapped subsets) plus the scene-level check of `scene_occt.ts` with truck in place of our OCCT backend; edges against OCCT's (counts and kinds per part); the files' own validation properties (`validation_occt.ts`) for both backends. Each truck failure classified (panic, hang, wrong area, empty face) with a repro subset | **Done** 2026-10-18 |
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

## Step 2: the truck backend

`../packages/tess-truck` (Apache-2.0):

- **`native/`, the Rust wrapper** (`src/lib.rs`, 554 lines), over truck `88ed005` by path (`../third_party/truck`, unchanged; no fork). It parses the payload with truck's own parser (ruststep), reads the root representation's `items` itself (simple or complex instance), and meshes the shells of each `MANIFOLD_SOLID_BREP` (and `BREP_WITH_VOIDS`), `SHELL_BASED_SURFACE_MODEL` or shell among them; other items (a `GEOMETRIC_SET`, say) are listed in a warning, placements ignored. Without a `rootId` it meshes every solid and surface model. Output:
  - an indexed mesh: truck's per-corner attributes welded into vertices per face, by position and normal; normals from the surface, flipped with the face;
  - faces by `ADVANCED_FACE` id (an `ORIENTED_FACE` reports the face it orients), in shell order;
  - edges by `EDGE_CURVE` id: truck's meshed edges are polylines whose points the face meshes reuse exactly (the triangulation keeps boundary points as given), so edge points are mesh vertices. Kinds from the topology (used by two faces: shared; twice by one face: seam; once: free; all points coincident: degenerate), and the dihedral angle of shared edges from the two faces' normals at the edge's points;
  - positions minus the request's origin in double precision, then `Float32`; ids above 2³¹ − 1 come back as null (as in the OCCT wrapper, which also uses `Int32`).
  - The tolerance is `linearDeflection` (decision 2).
- **A plain C ABI** (`tess_run`, `tess_ptr`/`tess_len` for each result array, `tess_free`, `tess_alloc`), like the OCCT wrapper's, instead of wasm-bindgen: one `.wasm` file and no generated glue. truck's dependencies still leave five wasm-bindgen runtime imports in the module (from chrono and getrandom, which truck enables for wasm); nothing on our path calls them, and `src/index.ts` supplies stubs that throw if anything does. A test pins the module's import list, so a change shows.
- **`build.sh`:** `cargo build --release --locked --target wasm32-unknown-unknown` (`panic = "abort"`, LTO) and `wasm-opt -O` (from `PATH`, or wasm-pack's download). 1,505,702 bytes, 312,068 brotli; phase 0's spike was 263,902 brotli. Optimizing for size is to be weighed against speed in step 3.
- **`src/index.ts`, `TruckTessellator`:** loads `dist/tess_truck.wasm` (from the file system in Node, by `fetch` elsewhere, or bytes or a URL in `init({wasm})`), runs requests and reports truck's diagnostics: faces and edges it can't convert, faces it fails to mesh, items it doesn't mesh, and placements fixed (below). **Panics:** a panic hook passes truck's message out through an import before the module traps; the request returns an empty result with an error diagnostic (`truck panicked: …`), and the instance is replaced (re-instantiated from the compiled module, a few milliseconds), so a panic costs only its own part, with or without the worker pool. truck can also hang; only the pool's timeout (step 1) covers that.

### Workarounds (decision 3)

1. **Shells are built by the wrapper**, not by truck's `Table::to_compressed_shell`, so each face and edge keeps its STEP id. Reading truck's code (`truck-stepio/src/in/convert.rs`) shows two problems the wrapper avoids, neither yet seen in our corpus (step 3 will count): truck numbers a vertex or edge before converting it, so one that fails to convert shifts every later index in the shell (faces would then use the wrong edges); and it drops faces it can't convert without saying which (phase 0 mirrored its filter to recover the ids). Here a face whose surface or edges don't convert is left out and reported by id.
2. **`AXIS2_PLACEMENT_3D` without a `ref_direction`.** The phase 0 panics (`tolerance must be no less than 1e-6` in truck-geometry `specifieds/circle.rs`, on 6 parts of `nist_stc_07` and `trj7_k1-ct`) are not about small tolerances, as phase 0 guessed: truck defaults a missing `ref_direction` to (1, 0, 0) even when the axis is ±(1, 0, 0) (`truck-stepio/src/in/mod.rs`, `From<&Axis2Placement3d> for Matrix4`). The placement's x axis is then the normalized zero vector, NaN, and the tolerance check fails on NaN. ISO 10303-42 (`first_proj_axis`) prescribes (0, 1, 0) in that case. The wrapper adds a `DIRECTION` (0, 1, 0) and points such placements at it, in the parsed file before truck reads it, and reports how many (an info diagnostic): 26 in `trj7_k1-ct-214.stp` #1926, 72 in `nist_stc_07_asme1_ap242-e3.stp` #11020. Both parts now mesh: #1926 fully (area within 0.6% of OCCT's), #11020 with 288 of 304 faces (16 small faces fail to mesh; area within 0.1%). A first attempt, raising the tolerance above 1e-6 × the largest radius, didn't help and was removed.
3. **Shells that face the wrong way are reversed** (decided by the user, 2026-10-18, below), as OCCT's shape healing does (`ShapeFix_Solid`, `CreateSolids`: each closed shell is put alone in a solid and the point at infinity classified; an outer shell with infinity inside, or a void with infinity outside, is reversed). The wrapper does the equivalent on the mesh with the divergence theorem: the signed volume of a closed triangle mesh, Σ a · (b × c) / 6, is positive when its triangles face outward. After meshing, each solid shell (a solid's outer shell or a void; surface models' shells are left alone) whose mesh is closed (every face meshed, every edge used twice) is reversed when the sign is wrong: negative for an outer shell, positive for a void. STEP says which shells are voids, so OCCT's containment analysis isn't needed. An info diagnostic names each reversed shell, and another lists solid shells whose mesh isn't closed, which are left as written.

### Findings

- **Against OCCT** on the step's fixtures (5 parts of `as1-oc-214-mat.stp`, the voids of `tr9_bv1-tc.stp`, the seams of `trj9_io1-oc-214.stp`, the open shell of `trj7_c2-ug-214.stp`, `conical-surface.step`): the same face ids, the same edge ids and kinds (shared, seam, free), the same face orientation, every edge point on a mesh vertex, and areas within 0.5%, except the cone (below).
- **`conical-surface.step`: 1.35 × OCCT's area.** truck's known trouble with cone faces (phase 0); to be classified in step 3.
- **Voids reversed twice in older exports.** The gkv311 dataset (OCCT's test data; OCCT's `tests/xcaf/stp_to_xbf` uses these files) holds exports of one test model, "BV1", a block with two box-shaped voids, from ProSTEP's AP214 test rallies 8 and 9 (1998; `tr8_*`, `tr9_*`), one file per participating system. In three round 8 files the void shells' faces already point into the void and the `ORIENTED_CLOSED_SHELL(.F.)` around them reverses that again, so by the file the voids face into the material:

  | File | Writer (FILE_NAME) | Date |
  |---|---|---|
  | `tr8_bv1_db` | debis Systemhaus, CATIA V4 → STEP 3.1.0.0 | 1998-03-13 |
  | `tr8_bv1_sy` | Mercedes-Benz, in-house SYRKO | 1998-03-19 |
  | `tr8_bv1_tc` | Theorem Solutions, CADDS5 → AP214 preprocessor 1.1.000 | 1998-04-15 |

  The round 9 files from debis (3.1.0.3, 1998-08-24) and Theorem (2.0.001, 1998-09-01) are correct, so the writers fixed it after round 8. OCCT reads the file literally (`StepToTopoDS_Builder.cxx` reverses a `.F.` void) and then corrects the solid in its shape healing; the truck backend at first followed the file. **Decided by the user (2026-10-18): correct the orientation as OCCT does, for voids and outer shells** (workaround 3). All 13 bv1 files now agree with OCCT, and the three above report both voids reversed.
- **Edge points off the mesh** in two parts: 16 of 3,773 points in `nist_stc_07` #11020 (likely on the faces that failed to mesh) and 2 of 844 in `trj7_k1-ct-214` #1926; step 3 will count them over the corpus.

### Tests

12 tests (102 in the repo; the corpus-dependent ones skip without the corpus or the builds): the import list; the cube (ids, unit normals pointing outward, 12 shared edges at 90°, area 600, the origin subtracted in double precision for vertices and edge points, no edges unless asked); the OCCT comparison above (with `tr8_bv1_tc`, whose two voids must be reported reversed and then agree with OCCT); the cube's shell wrapped in `ORIENTED_CLOSED_SHELL(.F.)` as a solid's outer shell, which must come back reversed, identical to the plain cube; the same with one face removed from the shell, an open mesh, which is left as written and reported unchecked; an `ORIENTED_FACE(.F.)` wrapped around one of the cube's faces (its face's id, its normals reversed); ids above 2³¹ − 1; the faces that fail to mesh in `nist_stc_07`; the placement workaround; a panic (the k1 part with the bad default spelled out, `ref_direction` = axis, which the workaround leaves alone), after which the instance's memory is back to a fresh instance's and the next request succeeds; unreadable input, a missing root and an unsupported format; and truck in the worker pool, equal to direct results.

**Mutation check:** 22 deliberate bugs (18 in the Rust wrapper, 4 in `index.ts`). The first round, on the first 17, caught 5: the fixtures had no oriented shells, seams, free edges, oriented faces, large ids or unmeshed faces, and nothing compared face orientation with OCCT or checked that a panicked instance was replaced. With the fixtures and checks above, 21 are caught, including the 5 on the orientation check (the check skipped, the sign inverted, voids taken for outer shells, the closure test without its face or edge condition). One more mutation, the closure test without a separate "no face dropped" condition, survived and showed that condition redundant (a dropped face leaves its neighbours' edges used once, unless the rest is closed, when the volume is meaningful anyway); the condition was removed. The survivor welds vertices by position alone instead of position and normal; on our fixtures, the positions that carry two normals within one face (at a cone's seam) carry the same normal up to rounding, so no test can tell the difference.

## Step 3: truck against OCCT

**`../corpus_checks/truck_occt.ts`** (log `truck_occt.log`) runs every brep part of every corpus file up to 30 MB (515 files; `bug29979_firetherm_12.step` and `bug31711.stp` are larger) through the truck backend and our OCCT backend, each in a `tess-workers` pool (4 workers; timeouts 60 s for truck, 300 s for OCCT), at 0.05 mm (phase 0's tolerance; OCCT also 0.5 rad), and compares them part by part, and face by face where both mesh a part. `DUMP=<dir>` writes every problem part's subset, for repros (1,291 files, 177 MB, in the git-ignored `../corpus_checks/truck_repros/`). It replaces phase 0's three oracles: the area check is kept per part; the face ids are compared directly with OCCT's (the vertex-based check was only needed while ids came from mirroring truck); the bare-against-wrapped check no longer applies, since the wrapper reads the root representation itself. **`../corpus_checks/truck_bench.ts`** times truck builds and OCCT single-threaded over phase 0's subsets.

The run found eight more truck failures with workarounds, all now in the wrapper (decision 3), and showed that comparing orientation and area with OCCT confuses truck's errors with OCCT's healing and with the meshes' different chords. So the per-face comparison is geometric and topological:

- **Geometry:** up to 10 vertices of each face sampled from each mesh, against the other mesh's triangles of the same face (by entity id), within twice the tolerance. A truck vertex off OCCT's face means truck's surface is wrong or extends too far ("wrong"); an OCCT vertex off truck's face means part of the face is missing ("short"). Per-face area, the first measure, flagged many small fillets merely for their chords (at 0.05 mm, a fillet of 0.2 mm radius loses about 10% of its area to either mesher); all such cylinders and tori pass the geometric test.
- **Orientation against the file's own loops:** truck's triangles wind counter-clockwise about its normals, and ISO 10303-42 orients a face's loops counter-clockwise about the face normal, so each loop edge, traversed as the loop uses it, should run along the face's own triangle boundaries. A face whose loop edges all run the other way has a normal that contradicts its loops ("contra"). This needs no OCCT: comparing with OCCT turned out to measure OCCT's healing (below) as much as truck.

### Workarounds added (decision 3)

4. **`SURFACE_CURVE`s are read by their 3D curve**, as OCCT does (`StepToGeom::MakeCurve` takes `Curve3d()` whatever the `master_representation`). truck follows a `.PCURVE_S1.` or `.PCURVE_S2.` master and evaluates the pcurve on its surface, which in many files yields NaN; 11,986 surface curves in the corpus are switched.
5. **Edges and faces that evaluate to NaN are left out.** truck subdivides a curve until each piece is within the tolerance, to a depth of 100 halvings (`truck-geotrait/src/algo/curve.rs`, `sub_parameter_division`), so a curve that yields NaN anywhere is divided without end: memory grows by about 400 MB/s natively, and in WebAssembly the allocation fails at 4 GiB and traps, without a panic message (the first run's 19 "unreachable" traps). The same happens when meshing along a bounded surface's range edges. The wrapper samples each edge's curve (33 points) and each bounded surface (17 × 17) and leaves out what isn't finite, reporting it. After workaround 4, what remains are B-splines with unclamped ("periodic") knot vectors, which truck evaluates over their whole knot range instead of the valid inner range: 11 edges and 24 faces in the corpus. Clamping them by knot insertion would recover them (not done).
6. **Instances truck's parser can't read are left out**, and the rest read. ruststep fails the whole file on the first instance it can't tokenize, such as an empty list `()`, which Part 21 allows (an `ADVANCED_FACE` with no bounds, a `TRIANGULATED_FACE`), and on malformed instances (`bug26451_Test_STEP.stp`). When the whole file fails, the wrapper splits the DATA section into instances (outside strings and comments) and tokenizes them one at a time: 868 instances left out across the corpus, which turned the first run's 50 parse errors into partial or empty results.
7. **Negative torus radii are taken as absolute values**, as OCCT does (`StepToGeom::MakeToroidalSurface`): one writer gives spindle tori a negative major radius, and truck's `Torus::new` panics on it (6 tori, 3 parts).
8. **Cone semi-angles are converted to radians** from the plane angle unit of the root representation's context (often a conversion-based `DEGREE`); truck has no unit handling and builds the cone from `tan(semi_angle)`. 2,092 cones in the corpus; cone faces off OCCT's geometry fell from 224 to 86.
9. **A shell is reversed only if its mesh is consistently oriented** (workaround 3 refined): no boundary segment traversed the same way by two triangles. The first run reversed 47 shells, most of them wrongly: where truck orients a few faces against their neighbours, the signed volume is meaningless, and reversing then flipped every correct face (1,256 of the 1,469 faces facing opposite to OCCT were in reversed shells). Now 15 shells are reversed (the round 8 voids of step 2, `brep_wv1.stp`, outer shells in `trj3_s1-al-214.stp` and others, each agreeing with OCCT afterwards) and 236 are reported unchecked for disagreeing faces, besides 155 with open meshes.

Two smaller fixes: a NaN edge is no longer also counted as unconverted, and the panic test now uses an explicitly invalid file (a B-spline with descending knots, which truck unwraps into a panic; not seen in the corpus), since the earlier fixture no longer panics.

### Results

From `truck_occt.log` (the final run, 18 minutes; three earlier runs, before and between the workarounds, are summarized above):

| | |
|---|---|
| Parts compared (OCCT meshes them) | 3,098 of 3,252 (154 empty or failed in OCCT, not compared) |
| truck: ok / timeout / empty / panic / error | 2,891 / 10 / 197 / 0 / 0 (first run: 2,870 / 10 / 146 / 22 / 50) |
| **Parts complete and on OCCT's geometry** (no face missing or off) | **2,560 (82.6%)** |
| Part area against OCCT (truck ok) | within 0.1%: 1,205; 1%: 757; 5%: 514; over 5%: 415 |
| Faces of OCCT's that truck lacks | 1,578 of 62,218 (2.5%): 1,040 fail to mesh, 525 don't convert |
| Edge kinds differing | 1,874 of 151,598 (1.2%): 1,585 free in truck and shared in OCCT (truck lacks the neighbouring face), 287 the other way, 2 seam against free |
| Edge points not on a mesh vertex | 21,559 of 1,269,673 (1.7%), in 337 parts; 15,285 of them on `B_SPLINE_CURVE_WITH_KNOTS` edges |
| Faces facing opposite to OCCT's | 402 in 41 parts (first run: 1,469 in 63) |
| Surface area validation property, within 1% | truck 45 of 67 files, OCCT 58 of 67 |

Faces by surface type (parts truck meshes; OCCT's faces):

| Surface | Faces | Missing | Ok | Wrong | Short | Contra |
|---|---|---|---|---|---|---|
| `CYLINDRICAL_SURFACE` | 22,235 | 93 | 21,454 | 649 | 39 | 46 |
| `PLANE` | 21,540 | 38 | 21,364 | 99 | 39 | 158 |
| rational B-spline | 5,368 | 162 | 4,640 | 208 | 358 | 36 |
| `CONICAL_SURFACE` | 4,132 | 922 | 2,580 | 86 | 544 | 4 |
| `TOROIDAL_SURFACE` | 2,961 | 14 | 2,894 | 52 | 1 | 16 |
| `B_SPLINE_SURFACE_WITH_KNOTS` | 2,768 | 256 | 2,368 | 129 | 15 | 1 |
| `SPHERICAL_SURFACE` | 1,732 | 68 | 1,618 | 41 | 5 | 4 |
| `SURFACE_OF_LINEAR_EXTRUSION` | 720 | 14 | 682 | 22 | 2 | 1 |
| `SURFACE_OF_REVOLUTION` | 603 | 1 | 405 | 17 | 180 | 2 |
| `QUASI_UNIFORM_SURFACE` | 149 | 0 | 146 | 0 | 3 | 9 |
| `DEGENERATE_TOROIDAL_SURFACE` | 10 | 10 | 0 | 0 | 0 | 0 |

**What remains, classified** (repros for each in `truck_repros/`; no upstream reports, per decision 3):

- **Cones** are truck's weakest surface: 922 faces fail to mesh, 544 are short, 86 wrong (38% of cone faces not right). In `nist_ctc_02_asme1_rc.stp` all 148 faces that fail are 59-degree countersinks near their apexes; the 3-degree cones in the same part mesh. A truck meshing problem, not a reading one; phase 0 saw bad cone faces too.
- **Surfaces of revolution** come out short in 30% of faces, rational B-splines wrong or short in 10%: truck's trimming of these surfaces, not investigated further.
- **Timeouts** (10 parts, 8 of them from one writer's `-id-203`/`-id-214` exports, including phase 0's `trj2_as1-id-203` #891): compute-bound in NURBS surface evaluation, with memory flat. Only the pool's timeout covers them.
- **Empty parts** (197): representations whose only geometry truck doesn't mesh, such as `GEOMETRIC_SET`s of surfaces (48 parts) and `TRIANGULATED_FACE`s, faces of unsupported surface types (`DEGENERATE_TOROIDAL_SURFACE`, 10 faces), and parts whose faces don't convert.
- **Orientation:** the 402 faces opposite to OCCT are of two kinds. Mostly truck follows the file and OCCT heals: in `Checking_Fixture_Clamping.STEP` (a surface model; its open shells have no inside) 118 faces follow both their `same_sense` and their loops, yet OCCT shows them reversed, and in closed shells OCCT's `ShapeFix_Shell` reorients faces against their neighbours. The rest are faces whose truck normals contradict their own loops (277 faces in all, the "contra" column), which is truck's error by the file's own topology.
- **Validation property misses:** 22 files miss; in 9 of them OCCT misses too, so the check itself is at fault there: seven at −100% for both (`trj4_xr1-pe-214.stp` and the `cax_stepLib` `s1_pe_214` and `s1-tu-203` files, where the placed totals are evidently incomplete), `sp7_08_nx-242.stp` (OCCT −99.93%) and `trj7_as1-hc-214.stp` (OCCT +101%). Not refined further here.

### Size and speed

`truck_bench.ts`, single-threaded, on AC power with the CPU otherwise idle, phase 0's subsets at 0.05 file units without edges:

| Build | brotli | NIST + gkv311 (75 parts) | Bicycle (112 parts) |
|---|---|---|---|
| opt-level 3 (current), before the step 3 workarounds | 312,068 | 2.53 s | 6.31 s |
| opt-level `s` | 284,998 | 3.80 s | 11.22 s |
| opt-level `z` | 272,563 | 6.51 s | 21.84 s |
| **opt-level 3, final** | **318,480** | **2.62 s** | **6.36 s** |
| our OCCT backend | (2.18 MB) | 6.20 s | 17.29 s |

Repeated runs agree within 0.5%. Size optimization saves 27–40 kB at 1.5–3.5 times the time, so the build stays at opt-level 3. The workarounds cost 1–4%. truck is now 2.4–2.7 times faster than our OCCT backend on these sets (with 1.5 times OCCT's triangles on the bicycle, since truck has no angular tolerance), and faster than phase 0's spike (4.3 s and 11.8 s; our OCCT backend measured 16.7 s on the bicycle then, so the machine is comparable; the cause is not investigated).

### Tests

7 more truck tests (18 in the package): surface curves read by their 3D curves (`ec_exhaust-A.stp` #3049); NaN faces and edges left out (`trj5_s1-ug-214.stp` #80, `OCC22962-dm1-oc-214.stp` #37), which ran out of memory before; a closed shell whose faces disagree, left unreversed (`trj5_s1-ug-214.stp` #75); negative torus radii (`bug25287_bad_tess_face_plus.step` #2134); a cone's angle in degrees (the cone fixture rewritten in degrees must mesh as in radians); an unreadable instance among readable ones (the cube with an empty list, inside a string containing `;`). **Mutation check:** 32 deliberate bugs in the wrapper and `index.ts` (step 2's 22, plus 10 on the new workarounds: each disabled, the string handling of the instance splitter, the consistency guard, the angle factor, the double count), 31 caught; the survivor is step 2's weld by position alone.

### Open from step 3, for the user

- **Face orientation healing.** Flipping each face whose truck normal contradicts all its loops would fix the 277 "contra" faces with an OCCT-independent rule (the file's own topology). Going further, as OCCT's `ShapeFix_Shell` does, and making faces consistent with their neighbours where `same_sense` and loops agree but neighbours disagree, would change faces the file defines one way. Neither is done.
- **Clamping unclamped B-splines** (knot insertion) to recover the 11 edges and 24 faces now left out.
- **Cones, surfaces of revolution, rational B-splines:** truck's own meshing; no workaround in sight short of patching truck.

## Not planned

- **monstertruck:** phase 0 found it no clear improvement over truck (fixes 29 parts, regresses 15); the corpus harness can track it later if that changes.
- **IGES and BREP payloads** for OCCT: they come with their importers ("Future input formats" in `architecture.md`).
