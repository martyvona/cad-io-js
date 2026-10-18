# Phase 0 feasibility spike: results

Run 2026-10-16/17. The spike code is throwaway. `README.md` in this directory is the tour of its files and logs, with the commands that reproduce the builds and the results below. Paths in this document are relative to this directory.

**Status:** four backends were tested.

- **`occt-import-js`** 0.0.23, which wraps OCCT 7.x.
- **Custom OCCT build:** OCCT 8.1 at `3d097a0328` (2026-08-24), built with Emscripten 6.0.12 (static, `-Os`, native WASM exceptions).
- **truck** at commit `88ed005` (2026-09-28).
- **monstertruck** at commit `d2ad1ed` (2026-10-07), a truck fork.
- **Toolchain** for truck and monstertruck: Rust 1.99.1 stable, built natively and with `wasm-pack` 0.15.0.
- **Not tested:** browser timings.

**Correction:** the first truck write-up used `occt-import-js` as the area reference. The custom OCCT 8.1 build showed that `occt-import-js` itself is wrong on some parts. In bicycle #1170, the true solid is a large sphere cut by a plane, and `occt-import-js` keeps only the small cap. truck was right there. All area figures below use the custom OCCT 8.1 build as the reference.

## Summary

| Question | `occt-import-js` (OCCT 7.x) | **Custom OCCT 8.1 build** | truck + wrapper | monstertruck + wrapper |
|---|---|---|---|---|
| 1. Bare closure subset accepted? | **No** (0/76) | **Yes, with product mode OFF**: 76/76 and 112/112. Identical output to wrapped + ON for all 188 parts | Yes: 69/76 and 112/112 | Yes: 71/76 and 111/112 |
| 1. Wrapped subset accepted? | Yes: 76/76 and 112/112 | Yes, in both product modes | Yes, identical to bare | Yes |
| 2. Face entity IDs? | No; order heuristic correct for only 7781/7825 faces | **Yes, via the transfer bindings**: 13,504/13,504 faces mapped, 0 unmapped. Split faces handled (4 on the bicycle). Vertex check passes 13,493/13,496 | Yes: IDs follow `cfs_faces` order | Yes, same method |
| 3. WASM size (brotli) | 7.6 MB (2.3 MB) | 7.2 MB (2.18 MB); **6.3 MB (1.71 MB)** with the computed-table patch (choice deferred) | **1.18 MB (264 kB)** | 1.63 MB (371 kB) |
| 3. Startup (Node) | ~20 ms | ~11 ms | ~6 ms | ~12 ms |
| 3. NIST + gkv311, 76 parts | 9.75 s (idle CPU) | **6.2 s** | 4.3 s | 35.5 s (9× more triangles) |
| 3. Bicycle, 112 parts | 18.0 s (#2022: 6.4 s) | 16.7 s (#2022: 9.1 s) | 11.8 s | 9.5 s (111 parts) |
| 3. Memory | WASM heap 50–90 MiB, never shrinks; RSS 450–575 MB | WASM heap 80–96 MiB; RSS ~550 MB | RSS 200–250 MB | RSS 215–700 MB |
| Area within 1% of OCCT 8.1 (188 parts) | (wrong on #1170, #1377, #1486) | reference | 112 (failed on 7) | 126 (failed on 6) |
| Robustness problems | | none seen | 6 panics, 1 hang | 5 panics, 1 timeout over 60 s, picks the wrong side of single-loop faces |
| 4. JS indexer | 250–290 MB/s | | | |

**Bottom line:**

- **The per-part tessellator interface can be frozen**, with the amendments at the end of this file.
- **The custom OCCT 8.1 build is the primary backend.**
  - It takes bare subsets (product mode OFF), so the wrapper isn't needed for it.
  - It maps every face to its `ADVANCED_FACE`, including faces that ShapeFix splits.
  - It returns flat typed arrays in file units.
- **truck and monstertruck** are much smaller but not robust enough to be the default. Neither dominates the other; see the monstertruck section.

## 1. Per-part subsets

The subset is the transitive closure of one shape representation, keeping the original `#` IDs and copying each entity's original bytes. The header is the original one.

Shape representations were selected as any entity whose type ends in `SHAPE_REPRESENTATION` and that directly holds a `MANIFOLD_SOLID_BREP`, `BREP_WITH_VOIDS`, `SHELL_BASED_SURFACE_MODEL` or `FACETED_BREP`. This covers ABSR, MSSR and plain `SHAPE_REPRESENTATION` (NIST ctc_05 and stc_06 use plain SR).

Variants tested:

- **`absr`** (the bare closure of the representation): **0/76 tessellated.** `ReadStepFile` returns `success=false`.
- **`solid`** (the closure of the bare `MANIFOLD_SOLID_BREP` or `SHELL_BASED_SURFACE_MODEL`): **0/145.**
- **`absr+wrap`** (the closure plus 8 synthetic entities): **76/76 and 112/112.** The synthetic entities are:

  ```
  APPLICATION_CONTEXT, PRODUCT_CONTEXT, PRODUCT, PRODUCT_DEFINITION_FORMATION,
  PRODUCT_DEFINITION_CONTEXT, PRODUCT_DEFINITION, PRODUCT_DEFINITION_SHAPE,
  SHAPE_DEFINITION_REPRESENTATION(#pds, #root)
  ```

  Their IDs are above the file's maximum ID. Triangle counts and bounding boxes are identical to the whole-file result for single-part files when using absolute deflection.

**Why bare subsets fail:** this is a reader setting, not an OCCT limitation. `STEPControl_Reader::NbRootsForTransfer` (`STEPControl_Reader.cxx:470ff`) accepts a `SHAPE_REPRESENTATION` that no SDR shares as a root only when `read.step.product.mode` is OFF. With `read.step.all.shapes` it even accepts bare `MANIFOLD_SOLID_BREP`s. `occt-import-js` uses the default (product mode ON) and doesn't expose `Interface_Static`. So our own build could take bare subsets.

**Decision (revised after the custom build):**

- **Custom OCCT backend:** uses `ReadProductMode = false` and receives the **bare** closure. This is verified: 188/188 parts, and the output is byte-identical to wrapped + product mode ON.
- **The wrapper:** stays an option in the JS subset writer, for `occt-import-js` or any binding that can't change the product mode. It is harmless for truck and monstertruck.
- **`rootId`:** the custom backend uses it to locate the root representation's unit context.
- **An unexpected result:** wrapped + OFF also works (188/188). From the source, I had predicted no roots would be found in that case.

**Subsets are faster and more robust than whole files:**

- **Single-part files with PMI:**
  - bug32049: 10.1 s whole vs 0.48 s subset
  - nist_ftc_08_e2: 13.1 s vs 0.40 s
  - nist_stc_10: 10.1 s vs 0.47 s

  Whole-file import also processes the PMI and tessellated presentation geometry.
- **Whole file fails but subsets succeed:** `nist_stc_07` (whole file fails, all 6 subsets succeed).
- **Bicycle assembly** (`Median_cx-fs01_bicycle.stp`: 24.6 MB, 301k entities, 802 occurrences):

  | | Whole file | 112 unique parts as subsets |
  |---|---|---|
  | Time | 31.0 s | 18.3 s summed (and parallelizable across workers) |
  | Triangles | 1.23M (instances expanded) | 0.81M |

**Side findings for the parser:**

- `bug32314_corrupted.stp` has an unbalanced quote, so a naive scanner swallows the rest of the file. OCCT recovers, so the production lexer needs resynchronization at `\n#<digits>=`.
- `trj7_k1-id-214` has two length units (cm and inch) in different contexts. Units must be resolved per representation context, as `../docs/architecture.md` already says.

## 2. Face IDs

`occt-import-js` returns `brep_faces: [{first, last, color}]` triangle ranges per OCCT face, with no entity IDs.

**Checking order-based correlation:** for each STEP face, take the coordinates of its `VERTEX_POINT`s and check that every one is a vertex of OCCT face *i*'s mesh.

- **NIST + gkv311:** 7781/7825 faces agree. The exception is `trj7_k1-id-214` (an MSSR with open shells), where OCCT reorders the faces, apparently through shell fixing.
- **Bicycle:** 3 of the 112 parts are permuted. In part #2022, **OCCT returns 314 faces for 312 STEP faces**: ShapeFix splits faces and permutes the order.

**Conclusions:**

- Order-based correlation is a usable fallback for the prototype only.
- The real OCCT backend needs the transfer-reader mapping. That is what XCAF already uses for per-face colors: `TransferBRep::ShapeResult(TP, binder)` in `STEPCAFControl_Reader.cxx` together with the shape-processing history merged by `XSAlgo_ShapeProcessor::MergeTransferInfo`. In practice: walk the `ADVANCED_FACE` entities in the subset and map each one to its resulting face or faces.
- **Interface consequence:** one STEP face can produce several triangle ranges. The tessellator's `faces` array must allow repeated `entityId`s, and some ranges may have no source entity.

## 3. Size, speed, memory (OCCT via occt-import-js)

- **Payload:** `occt-import-js.wasm` is 7,604,031 bytes; brotli 2,315,009, gzip 3,083,977. The JS glue is 96,871 bytes (26,653 gzip).
  - The build includes IGES and XCAF.
  - A STEP + mesh-only custom build would be smaller, but by how much is untested.
- **Startup:**
  - In Node 24: `WebAssembly.compile` takes 7 ms and the factory is ready in about 15 ms more.
  - With `--no-liftoff` the factory takes 63 ms.
  - Browser numbers are untested.
- **Tessellation:** measured at 0.05 mm absolute deflection and 0.5 rad angular deflection.
  - **Typical parts:** 3 ms to 1 s.
  - **Bicycle:** the slowest part took 6.9 s (#2022, 25k entities, 310 faces).
  - **NIST ctc_02 main solid:** 2.0 s (98k triangles).
- **Memory:**
  - **WASM linear memory** starts at 29 MiB and reaches 50–90 MiB after one large part. It reached 654 MiB after all 112 bicycle parts in a single instance, because linear memory never shrinks.
  - **Node RSS** peaks at 450–575 MB for a single large part. Most of that is JS-side result objects: the output uses plain JS arrays, not typed arrays.
  - **Implications:**
    - Recycle workers or instances after N parts or above a heap threshold.
    - Our own build should return typed-array views.

## 4. JS indexer baseline

The indexer (`p21.mjs`) is a single pass over a latin1 string. It finds `#id=` boundaries, the type names and the `#refs` of each entity, and skips strings and comments.

| File | Size | Entities | Index time | Throughput |
|---|---|---|---|---|
| `bug29979_firetherm_12.step` | 59.4 MB | 537k | 206 ms | 289 MB/s |
| `bug31711.stp` | 30.7 MB | 413k | 122 ms | 252 MB/s |
| `Median_cx-fs01_bicycle.stp` | 24.6 MB | 302k | 99 ms | 249 MB/s |
| `bug30790.step` | 22.4 MB | 199k | 83 ms | 270 MB/s |

- **Closures:** all 1012 shape-representation closures of the bicycle take 76 ms in total.
- **Memory:** JS heap use is 480–700 MiB, because the spike stores one object plus a refs array per entity. The production index should use typed arrays, with offsets and refs in flat `Int32Array`/`Uint32Array` buffers.

## truck

- **No prebuilt package:** there is no `truck-js` on npm. `truck.js` is an unrelated 2013 package. truck-js's own `step_in.rs` only exposes whole-shell meshes without face IDs, so the spike uses its own crate (`truck_spike`) with path dependencies on the local truck checkout.
- **Subsets:** `truck-stepio::in::Table` is a set of `HashMap<u64, …>` per entity type, keyed by STEP ID, with no product or root logic. Bare closure subsets parse as-is. `shell` keys are STEP IDs of `CLOSED_SHELL`/`OPEN_SHELL`.
- **Units:** truck has no unit handling, so coordinates come out in file units. That's consistent with "the JS side owns units". Tolerances are also in file units.
- **Face IDs:**
  - `convert.rs` `shell_faces` builds faces in `cfs_faces` order but uses `filter_map`. Faces whose surface can't be converted are dropped silently, which would shift later faces.
  - The wrapper (`surviving_face_ids` in `truck_spike/src/lib.rs`) mirrors that filter to produce the ID list, then reads per-face meshes from the `CompressedShell<…, Option<PolygonMesh>>` that `robust_triangulation` returns.
  - A cleaner upstream change would carry the ID inside `CompressedFace`.
- **Face-ID verification:**
  - **Method:** each STEP face's `VERTEX_POINT`s should be vertices of the face's triangles. When they aren't exactly, the reported face should still be the nearest one.
  - **NIST + gkv311:** 5966/6199 exact and 6167/6199 nearest.
  - **Bicycle:** 5514/5624 exact and 5619/5624 nearest.
  - **The misses are inaccurate meshes, not wrong IDs:** a wrong ID would shift every later face in the shell, which never happens. The misses come from vertices off by about 3e-3 and from bad cone faces.
- **Robustness problems:**
  - **Panics:** `tolerance must be no less than 1e-6` at `truck-geometry/src/specifieds/circle.rs:65` on 6 inch-unit parts (`nist_stc_07` ×5, `trj7_k1-ct`). A panic in WASM traps, so the instance has to be recreated.
  - **Hang:** more than 10 minutes on `trj2_as1-id-203` part #891 (5 faces). The host needs a watchdog: run tessellation in a worker that can be terminated.
  - **Wrong geometry:** against the custom OCCT 8.1 build, 64/188 parts are within 0.1%, 112 within 1%, 144 within 5%. The worst cases are on the bicycle:
    - #1821 and #3117: 2.6× the area
    - #1543: 2 of 4 faces empty (0.43×)
    - several parts at about 0.5×

    The earlier "full sphere instead of a cap" claim for #1170 was wrong: there truck is correct, and `occt-import-js` is the one that's wrong.
  - **Empty faces:** 43 on the NIST + gkv311 set and 50 on the bicycle.
- **Size:** `truck_spike_bg.wasm` is 1,183,328 bytes (gzip 375,782, brotli 263,902) after `wasm-pack --release` and `wasm-opt`. That is about 1/6 of `occt-import-js`.
- **Speed:**

  | | NIST + gkv311 subsets | Bicycle, 112 parts |
  |---|---|---|
  | Native, multi-threaded (rayon) | 1.7 s | 3.9 s |
  | WASM, single-threaded | 4.3 s | 11.8 s |

  - **Startup:** compile 3–4 ms, instantiate 2 ms.
  - **Tolerance semantics differ from OCCT** (truck's `tol` is a single absolute distance), so triangle counts aren't directly comparable: on the bicycle truck produced 1.23M triangles at `tol=0.05`, against OCCT's 0.81M at 0.05 mm / 0.5 rad.
  - **Native and WASM give slightly different triangle counts** (1.19M vs 1.23M), because WASM uses `shell_tessellation_single_thread`.
- **Memory:** peak RSS 200–250 MB in Node over a whole run in one instance.

## Custom OCCT 8.1 build

(The "Build variants" subsection below supersedes the size and speed figures in this section.)

**Build:**

- `emcmake cmake` on the local OCCT checkout:
  - static libraries
  - all modules except Draw
  - FreeType, Tk and Tcl off
  - `-fwasm-exceptions -UOCC_CONVERT_SIGNALS`
  - `CMAKE_CXX_FLAGS_RELEASE=-Os -DNDEBUG`
- Only the `TKDESTEP` and `TKMesh` targets and their dependencies are built (23 toolkits, about 25 minutes on 10 cores). `occt_tess/build.sh` then links the wrapper.

**Two build problems:**

- **OCCT's flags win over ours:** its CMake appends `-fexceptions` and `-O3` after our flags, so `-Os` silently became `-O3`. Setting `CMAKE_CXX_FLAGS_RELEASE` fixes the optimization level.
- **Invalid WASM from the full link:** the first build linked to an invalid module (V8: `br_table: label arity inconsistent`) in `ShapeUpgrade_ShapeDivide::Perform`, and `wasm-opt` failed on it too.
  - **Isolated:** the same object validates when linked alone, at every optimization level, with or without `-fPIC`. Only the full link breaks it. The failing `br_table` is the dispatch that LLVM's `setjmp`/`longjmp` lowering generates.
  - **Cause:** OCCT's `OCC_CONVERT_SIGNALS` puts a `setjmp` in every `OCC_CATCH_SIGNALS` block, to turn hardware signals into C++ exceptions.
  - **Fix:** WASM has no signals, so undefining it removes the `setjmp`s and the problem. That is probably the right setting for WASM anyway.
  - **Follow-up:** this looks like an LLVM/wasm-ld bug, and is worth reporting with a reduced test case.

**Wrapper:** `occt_tess.cpp`, about 200 lines, with a C ABI. Per request it:

1. Reads the subset from memory with `STEPControl_Reader::ReadStream(name, DESTEP_Parameters, istream)`, with `ReadProductMode` set from the request.
2. Computes the root representation's length unit factor (`STEPConstruct_UnitContext::ComputeFactors`, as `STEPControl_ActorRead` does) and passes it to `SetSystemLengthUnit`. The output is therefore in **file units** without any rescaling.
3. Calls `TransferRoots`, then `OneShape`.
4. Builds the face map: for every `StepShape_FaceSurface` entity (this includes `ADVANCED_FACE`), `TransferBRep::ShapeResult(TP, entity)` gives the resulting shape. Shape fixing has already replaced the binder result with the fixed shape, possibly several faces. Each face's `TShape` is mapped to the entity's `IdentLabel`.
5. Meshes with `BRepMesh_IncrementalMesh(shape, linDefl, false, angDefl, false)`.
6. For each final face: positions, normals (`BRepLib_ToolTriangulatedShape::ComputeNormals`, flipped for reversed faces), indices, and an `(entityId, firstIndex, indexCount)` triple. `entityId` is −1 when unmapped.
7. JS reads everything through heap views (`HEAPF32`/`HEAPU32`/`HEAP32`).

**Results:**

- **Acceptance:** all 188 parts succeed with bare + OFF, wrapped + OFF and wrapped + ON. Bare + ON fails on all of them, as expected.
- **Face IDs:**
  - **NIST + gkv311:** 7825/7825 faces mapped, and all pass the vertex check. This includes `trj7_k1-id-214`, where OCCT reorders faces and the order heuristic fails.
  - **Bicycle:** 5679/5679 mapped. The vertex check passes 5668/5671; the 3 misses are in #2022, which ShapeFix modifies. On #2016 and #2022, 4 STEP faces are split into 2 OCCT faces each, and both pieces carry the right ID.
- **Agreement with `occt-import-js`:**
  - **NIST + gkv311:** area within 0.1% on 76/76 parts.
  - **Bicycle:** within 0.1% on 108/112. The outliers are #1170, #1377 and #1486, where OCCT 7.x is the one that's wrong (see the correction above), and #1225 at 0.996.
- **Size:**
  - **Totals:** 7,164,096 bytes raw (2,176,748 brotli; 2,915,633 gzip), plus 68 kB of JS glue.
  - **Code:** 5.06 MB. Only about 6% smaller than `occt-import-js`, because XCAF and the visualization toolkits were never linked in anyway.
  - **Largest contributors:**
    - `RWStepAP214` (730 kB): the per-entity-type read/write dispatch
    - `ShapeFix` (367 kB)
    - `Extrema` (157 kB)
    - `BRepMesh` (141 kB)
    - `STEPControl` (118 kB)
    - `TopoDSToStep` (52 kB): writer code that `STEPControl_Controller` pulls in
  - **Data:** 2.05 MB, of which only 138 kB is text. The rest looks like TKernel's CJK code-page tables (`Resource_*`), which could be stubbed.
- **Speed:** see "Build variants" below. The first figures in this section (11.9 s and 33.0 s) were measured while other builds were running, which inflated them by about 2×.
- **Memory:** WASM heap 80–96 MiB after a full run in one instance, much less than `occt-import-js`'s 654 MiB. Node RSS is about 550 MB, mostly V8 compiled code for the 7 MB module.

### Build variants: optimization level, LTO and table patch

Every variant was built from the same OCCT source with the same wrapper (edges included). Timings were taken one variant at a time with the CPU otherwise idle, in Node 24, using bare subsets with product mode OFF, deflection 0.05 and 0.5 rad. The scripts are `occt_variant_build.sh` and `occt_tess/build.sh` (`B=`, `OPT=`, `LINKOPT=`, `OUT=`).

| Variant | WASM raw | Brotli | Code / data (brotli) | NIST + gkv311 (76) | Bicycle (112) | #2022 |
|---|---|---|---|---|---|---|
| `occt-import-js` 0.0.23 (OCCT 7.x), wrapped subsets | 7.60 MB | 2.32 MB | | 9.75 s | 18.0 s | 6.4 s |
| `-Os` | 7.17 MB | 2.18 MB | 1169 / 973 kB | 6.15 s | 16.6 s | 9.0 s |
| `-O2` | 9.41 MB | 2.35 MB | 1341 / 971 kB | 6.11 s | 17.3 s | 9.8 s |
| `-O3` | 9.55 MB | 2.39 MB | 1378 / 971 kB | 6.05 s | 17.9 s | 10.5 s |
| `-Os -flto` + table patch | 6.52 MB | 1.76 MB | 1218 / 505 kB | 5.96 s | 17.1 s | 9.7 s |
| **`-Os` + table patch** | **6.33 MB** | **1.71 MB** (gzip 2.38 MB) | | 6.18 s | 16.7 s | 9.1 s |

- **Optimization level:** `-O2` and `-O3` buy nothing. Speed is within ±3% of `-Os` (noise level), while the download grows 8–10% and the raw size about 30%. A plausible reason is that V8 recompiles the WASM with its own optimizer (TurboFan) anyway, and the hot spots are algorithmic. Use `-Os`.
- **LTO:** makes the code slightly larger (1169 → 1218 kB brotli) through cross-module inlining, with no meaningful speed gain. Don't use it.
- **Post-link `wasm-opt -Oz`:** −0.8% brotli. Not worth a separate step.
- **Table patch** (`occt_overlay/AppCont_ContMatrices.pxx`):
  - **What it does:** OCCT's `AppCont_ContMatrices::VBernstein` reads an 840 kB table of Bernstein basis values at Gauss–Legendre points. The patch computes them instead, in about 30 lines, and writes `M(i, j)` in the same order with the same indexing as upstream.
  - **Applied without touching the OCCT checkout:** after configure, the overlay is copied over the forwarding stub in `<build>/include/opencascade/` (`occt_variant_build.sh ... 1`).
  - **Effect:** −468 kB brotli (−22% of the download) and no speed change.
  - **Only caller:** `AppCont_LeastSquare`, the continuous least-squares fitter behind `Approx_FitAndDivide`/`Approx_FitAndDivide2d`. Those are used by `ProjLib_ComputeApprox`, `ProjLib_ComputeApproxOnPolarSurface` and `ProjLib_ProjectOnPlane`, which compute curve projections when there's no exact form, for example missing p-curves during ShapeFix.
  - **Corpus coverage: none.** A temporarily instrumented build that logged every `VBernstein` call recorded **zero calls** across all 188 parts. So the bit-identical output on those parts says nothing about the patch; the patch's code was never reached.
  - **Tests that do reach it** (`occt_overlay/test/`, results in `results.txt`):
    - **Table match** (`table_test.cpp`, native): all 104,650 table entries match within 6.1e-15, the table's printed precision. This test checks a copy of the function body, not the overlay header itself.
    - **In-situ check** (`instrumented_AppCont_ContMatrices.pxx`): inside the WASM build, every call compared the stored matrix with the table, over 2,843 calls from the real fitter (classe 6–21, nbpoints 11–24, rows `1..classe`, cols `1..nbpoints`). Max difference: 4.2e-15.
    - **End to end** (`appcont_test.cpp` + `compare.py`, run with `run.sh <build dir> <name>`): it drives `Approx_FitAndDivide` on 8 analytic 3D+2D curve cases, against the patched and upstream libraries.
      - **Well-conditioned fits (cases 1, 2, 3, 7):** same segments, degrees and parameters; poles agree to 1e-11 relative or better.
      - **High-degree, very tight-tolerance fits (cases 4, 5, 6, 8):** these diverge, up to a different segmentation. Cases 4–6 fail in both builds, with deviations of 10 to 10⁴ against a requested 1e-10 to 1e-14. Case 8 reaches its tolerance in both builds, with poles differing by 8e-8 relative.
    - **Controls**, run through the same instrumented header:
      - writing the exact table values reproduces upstream bit-for-bit in all 8 cases, which rules out an addressing or layout difference;
      - nudging the table by up to ±4 ulps gives the same size of divergence as the patch in every case.

      So the divergence comes from the fitter's own sensitivity to the last bits; any rounding change, including a compiler change, would cause it too.
    - **Found along the way, in both builds:** upstream throws `MMatrix: classe > 24` for degree 24 or more, although `VBernstein` and its table go to classe 26.
  - **Costs of carrying it:**
    - The overlay is a full copy of an upstream header, so it silently masks any upstream change to that header. A build step should check the upstream file's hash and fail on a mismatch.
    - Results aren't bit-identical with stock OCCT whenever the fitter runs. On well-conditioned inputs the difference is negligible; on ill-conditioned ones it's no larger than ulp-level noise.
    - Possible alternative: offer the change upstream. OCCT already has GTests checking `VBernstein` against direct Bernstein evaluation (`AppCont_ContMatrices_Test.cxx`), so a computed version would fit their test suite.
  - **Decision deferred:** `-Os` versus `-Os` + patch. Both build directories were kept at the time (the overlay build was deleted on 2026-10-17).
  - **Decided (2026-10-17, `../docs/phase3_progress.md` decision 6):** ship `-Os` without the patch; not worth maintaining for now. The overlay stays in `occt_overlay/` in case the download size matters later.
- **Startup:** 10–13 ms in all variants.
- **Remaining size candidates (untried):**
  - The CJK code-page tables in TKernel `Resource_*`: 651 kB raw but only about 103 kB brotli. They're included with quoted `#include`s, so the overlay trick doesn't reach them; a small source patch would.
  - `AdvApp2Var` tables: 215 kB brotli. They're needed by approximation code that may be reachable.
  - Writer code pulled in by `STEPControl_Controller` (`TopoDSToStep`, `GeomToStep`, `STEPControl_ActorWrite`): about 150 kB raw. Removing it would need a reader-only controller.
  - `RWStepAP214` (853 kB raw for the schema read/write modules): inherent to reading STEP with OCCT.
- **#2022 is a mesher regression in OCCT 8.1, not a compiler issue:**
  - **Profile** (`node --cpu-prof` on a `--profiling-funcs` build): 88% of the time is in `BRepMesh_IncrementalMesh`, and 74% in `BRepMesh_Delaun::meshLeftPolygonOf`, the frontier recovery in Delaunay meshing. STEP reading is 1%, transfer and ShapeFix 9%.
  - **Failed faces:** the part ends up with 2 faces that have no triangulation, which suggests the mesher grinds on them before giving up.
  - **Delabella** (`IMeshTools_MeshAlgoType_Delabella`, via the new `occt_set_mesh_options` export): exactly the same time, because the frontier recovery is shared, and worse quality (57 untriangulated faces across the corpus against 5 for Watson; area off by more than 0.1% on 10 parts).
  - **`AdjustMinSize`:** no effect.
  - **Next step:** extract the slow faces and report upstream with a minimal BREP repro.

### Edges (prototype in the custom OCCT wrapper)

**What it produces:** one polyline per topological edge of the final shape (`TopExp::MapShapesAndUniqueAncestors(shape, EDGE, FACE)`). For each edge:

- **Polyline:** the edge's `Poly_PolygonOnTriangulation` on its first adjacent face, mapped to that face's triangulation nodes. The points are therefore exactly mesh vertices. If no face has a polygon for the edge, it falls back to the edge's `Polygon3D`.
- **Entity ID:** from the same transfer-binding lookup as faces, using `StepShape_EdgeCurve`.
- **Kind:**
  - `shared`: two or more faces
  - `seam`: closed on its single face
  - `free`: one face
  - `degenerate`
- **Dihedral angle:** the maximum angle between the two faces' mesh normals at matching polygon nodes. OCCT's stored edge continuity isn't reliably computed during STEP import, so I didn't use it.
- **Cost:** 6 kB of WASM and a relink, with no OCCT rebuild. The exports are `occt_edge_positions`, `occt_edges` (`id, firstPoint, pointCount, kind`), `occt_edge_angles` and `occt_num_edges`.

**Results** (`occt_edges_test.mjs`, at deflection 0.05 file units):

| | NIST + gkv311 (76 parts) | Bicycle (112 parts) |
|---|---|---|
| STEP edges / OCCT edges | 19,973 / 21,216 | 13,043 / 14,239 |
| Edges with an entity ID | 20,078 | 13,330 |
| Polyline points exactly on a mesh vertex | 157,782/157,844 (99.96%) | 135,316/135,316 |
| Both endpoints on the `EDGE_CURVE`'s vertices | 20,072/20,078 (6 with one, 0 with none) | 13,226/13,330 (101 with one, 3 with none) |
| STEP edges split into several OCCT edges | 113 | 284 |
| Kinds: shared / seam / free / degenerate | 19,554 / 410 / 487 / 765 | 13,319 / 817 / 0 / 103 |
| Dihedral angle (shared): <1° / 1–10° / 10–30° / >30° | 9,474 / 177 / 101 / 9,802 | 3,788 / 831 / 236 / 8,452 |
| Edge points vs mesh vertices | 158k vs 407k | 135k vs 537k |

- **Unmapped edges:** almost all are made by OCCT and have no STEP source:
  - 765 degenerate edges at sphere and cone poles
  - 345 seams added to closed periodic faces that arrived without one
  - only 28 free edges are unexplained

  `entityId: null` is the right answer for these.
- **No filtering:** every edge is kept, degenerate ones included; whether to draw them is the renderer's choice. All 868 degenerate edges in the test set come out as 2-point polylines at the pole. If no polygon exists, the wrapper falls back to the edge's `Polygon3D`, and then to its vertex, so every edge has a location.
- **Split edges:** shared edges that ShapeFix split at a new vertex; the pieces repeat the `entityId`. This accounts for the one-endpoint matches (pieces) and the no-endpoint matches (middle pieces of three-way splits).
- **Free edges:** nearly all are in surface models and single-face sheets, where they are real boundaries (`trj7_k1-ug` is 44 disconnected faces). Two solids have a few: `nist_ctc_05` (9) and `nist_stc_06` (19), where ShapeFix rebuilt edges so the two faces no longer share one. A renderer would draw these as boundaries inside a closed solid.
- **Dihedral distribution:** bimodal, so a renderer threshold such as 10° cleanly separates tangent edges from feature edges.

## monstertruck

[monstertruck](https://github.com/virtualritz/monstertruck) is an Apache-2.0 fork of truck: 194 commits ahead of truck and 182 behind, with fixes hand-ported rather than merged.

- **Changes relevant to us:**
  - a rewritten triangulation and trim-constraint (CDT) pipeline
  - a seam-healing pass
  - a forked STEP parser (`step-p21`) that handles `''` and `()`
  - a loss report from shell conversion
- **Porting:** the wrapper ported by renaming imports (`mtruck_spike`). `Table::from_step` now returns `Result`; I used `to_compressed_shell_reported`.
- **Toolchain:** it builds with stable Rust from outside its workspace. Its `rust-toolchain.toml` asks for nightly, but only for its formatter and lints.

**Results**, all at `tol = 0.05`:

| | truck | monstertruck |
|---|---|---|
| NIST + gkv311 subsets OK | 69/76 | 71/76 |
| Bicycle parts OK | 112/112 | 111/112 |
| Panics | 6 (circle tolerance) | 5 (same panic, now at `monstertruck-geometry/src/specifieds/circle.rs:154`, on `nist_stc_07` ×5) |
| Hangs or timeouts | trj2 #891 (>10 min) | bicycle #2016 (>60 s; truck takes 1.5 s natively). trj2 #891 is fixed |
| Empty faces (bicycle) | 50 | 7 |
| Area within 0.1% / 1% / 5% of OCCT 8.1 (188 parts) | 64 / 112 / 144 | 86 / 126 / 141 |
| Face IDs, vertex check exact / nearest | 11,480/11,823 and 11,786 | 11,433/11,763 and 11,702 |
| WASM size (brotli) | 1.18 MB (264 kB) | 1.63 MB (371 kB) |
| WASM time: NIST + gkv311 / bicycle | 4.3 s / 11.8 s | 35.5 s / 9.5 s |
| Triangles: NIST + gkv311 / bicycle | 0.42M / 1.23M | 3.86M / 1.77M |

Measured against OCCT 8.1 on area, monstertruck fixes 29 parts that truck gets wrong but regresses 15, and 47 parts are wrong in both.

- **The regressions are serious:**
  - **#1170, #1377, #1486:** monstertruck gets 4–19% of the true area. On these single-loop periodic faces it keeps the wrong side of the boundary; truck is within 3% on all three.
  - **trj2_as1-id-203 #1589 and #730:** an AP203 file made entirely of B-spline surfaces.
- **Its fixes:** mostly bicycle parts with empty or partial faces.
- **Over-tessellation:** at the same tolerance it produces 9× as many triangles on the NIST set, which explains its slower WASM time there.

**Verdict:** monstertruck isn't a clear improvement over truck for our use. It fixes different problems than it breaks, and it is a single-maintainer fork. Neither replaces OCCT. If a Rust backend is pursued, the corpus harness here (`truck_test.mjs` + `area3.mjs` with `BIN=`) can track both against OCCT 8.1, and the repro subsets can be reported to whichever project is more responsive.

## Other OCCT WASM packages noticed

- **`occt-wasm`** (npm 5.7.1, updated 2026-10-12, declares "MIT OR Apache-2.0" despite wrapping LGPL OCCT): 21.7 MB unpacked. Worth a look as a more current binding.
- **`@bitbybit-dev/occt`:** another binding.
- **`opencascade.js`:** last published 2023-03.

## Changes to the tessellator interface

1. **Faces:** `faces` entries can repeat an `entityId` (one STEP face can produce several OCCT faces), and `entityId` can be `null` for unmapped ranges. The ranges partition `indices`.
2. **STEP payload:** the bare closure of the root representation. `rootId` names the representation. The JS subset writer can optionally append the synthetic product wrapper for backends that need it (`occt-import-js`); the custom OCCT build and the Rust backends don't.
3. **Lifecycle:** the backend may need to recycle its WASM instance. OCCT's linear memory never shrinks, and a truck panic traps the instance. truck can also hang, so the host needs a per-request timeout that terminates the worker. `init`/`dispose` per worker, a "parts per instance" policy and a watchdog belong on the host side, not in the interface.
4. **Units:** tolerances are given in file units (the interface already says so), and output coordinates are in file units. The custom OCCT build does this by setting the system length unit to the root context's unit. `occt-import-js` converts to mm, so it would need the result scaled back.
5. **Edges:** flat `edgePositions` plus `{entityId | null, start, count, kind, dihedral}` per edge, as prototyped in the custom OCCT wrapper. See "Edges" above and `../docs/architecture.md`.

## Suggested next steps

- **Custom OCCT build:**
  - Ship `-Os`, with or without the `VBernstein` table patch (2.18 vs 1.71 MB brotli; decided 2026-10-17: without, see "Build variants"). If the patch is kept, add an upstream-hash check to the build, or propose the change upstream.
  - Optionally stub the CJK code-page tables (about 100 kB brotli) and the writer path.
  - Find a STEP corpus that actually reaches the approximation code (`ProjLib`/`Approx_FitAndDivide`), for example files with missing p-curves.
  - Isolate the #2022 slow faces (OCCT 8.1 `BRepMesh_Delaun` frontier recovery) and report them upstream. Until it's fixed, the host's per-request timeout covers it.
  - Add an `init`/`dispose` cycle and a heap-threshold recycle in the host.
  - Report the `setjmp` + exceptions link bug to LLVM/Emscripten.
- **Rust backends:** optional. Report the circle-tolerance panic (both), the #891 hang (truck), the #2016 timeout and wrong-side trimming (monstertruck), with `out*/` subsets as repros.
- **Test harness:** keep three oracles:
  - the area cross-check against OCCT 8.1
  - the vertex-based face-ID check
  - the bare vs wrapped identity check

  NIST files also carry validation properties (surface area, volume) that could serve as ground truth independent of any backend.
