# Tessellation backends notes

Notes for work on `cad-scene`'s tessellation, `tess-occt`, `tess-truck`, `tess-workers` and `tess-cache`. The full record (measurements, alternatives, checks) is in `git show V0.2.0:CLAUDE.md`; phase 0's backend comparison and spike in `V0.1.0`'s.

## Phase 0

The per-part interface: faces may repeat an id or have none; the payload is the bare closure of one shape representation with its original `#` ids (`step-parser`'s `buildSubset`); units are file units; the host owns recycling and the watchdog; edges come with kinds and dihedral angles. Subsets are faster and more robust than whole files. OCCT 8.1 (our build) is the primary backend (bare subsets need product mode off; face ids from transfer bindings), truck optional (much smaller and faster, less robust); `occt-import-js` (no face ids, no bare subsets) and monstertruck not adopted. A "load once, tessellate many" session API was rejected.

## The host side

- Backends take a host's module through `init` (`glue`, `wasm`, `version`; a compiled module needs `version`). `info.version` carries the module's hash, so caches see each build. Custom OCCT builds must link our wrapper (`occt_tess.cpp`).
- `tessellateScene` adds its meshes to the parts' levels (`from: 'tessellated'`, deflections in mm and radians, `backend` name and version), replacing one from the same backend and settings (equal to 1e-9 relative), mutating the scene; returns diagnostics and the meshes made. It turns over closed shells that are inside out and enclosed by nothing, drops triangles with two corners at one position, boxes each mesh (`Mesh.box`), and with `outlines` outlines failed faces from the file. Vertices aren't merged.
- Meshing profiles (`cad-scene`'s `profiles.ts`, the one place they're defined): coarse 0.2 mm / 30 degrees, medium 0.1 mm / 15 degrees (`DEFAULT_MESH_PROFILE`), fine 0.05 mm / 7.5 degrees; `linearDeflection` and `angularDeflection` override. The corpus checks keep explicit 0.1 mm and 0.5 rad so their logs stay comparable.
- Timeouts: 60 s by default (`DEFAULT_TIMEOUT_MS`, `stepconv`, the pool, the viewer). The corpus's slowest successful part is 28 s (`bug24024_slow_import.stp`, OCCT) on an M4; slower machines or finer settings may time it out. Workers: cores - 1.
- Caching: maximum size (0 disables), failures and timeouts cached (a cached timeout answers only while the limit is no longer), only the same backend's other versions deleted, a wrapper rather than a `tessellateScene` option; a worker's exit not cached, out-of-memory traps cached. A result without measures doesn't answer a request for them.
- Defaults: `maxMemoryBytes` 256 MiB (recycle above it; a restart costs about 250 ms), caches 256 MiB memory and IndexedDB, 1 GiB files.
- Wireframe curves and points come in the B-rep result, OCCT only; 2D drawings skipped.
- SHA-256 everywhere (`cad-scene`'s `sha256`: Web Crypto where it exists, our `sha256Js` where it doesn't, since `crypto.subtle` is missing outside secure contexts, e.g. plain http on a LAN).

## Faces that fail to mesh

- `Part.measures` (`by`, and `faces` by source id: `area`, `perimeter`, `valid`), measured by OCCT in the tessellation call when asked (`occt_set_measures`: per STEP face its healed pieces' `BRepGProp` area and length, `valid` when `BRepCheck_Analyzer` passes every piece; about 3 % of meshing time) and carried in our extras through exports.
- `faceFailures` (`cad-scene`'s `mesh.ts`) gives `failed` (no triangles, area over d x d), `partly` (mesh area short by more than max(3 % of A, d x P)), `excess` (over by more than max(10 % of A, d x P)), `unverified` (no valid area, or over 1e20); d the linear deflection, P the perimeter (`MISSING_FRACTION`, `EXCESS_FRACTION`, `BOUNDARY_SLACK`, `MAX_PLAUSIBLE_AREA`). Without measures or a known deflection, only the no-triangles rule. All but `partly` draw red in the viewer.
- Why areas: OCCT can mesh a face only in part with no empty piece (VW's Differential Pinion), and healed pieces' areas can be wrong by half (Ring Gear #297982); every wrong OCCT area in the survey was on a face invalid by BRepCheck. 621 corpus faces are under 0.01 mm^2 (`bug30790.step`'s 148 at 1e-23 are empty, not failures). `bug30790.step` parts 11-24 mesh 616 mm^2 faces to 12,900 mm^2: garbage meshes (`excess`).
- Failed faces' red outlines: the backend's polylines for a wholly failed face, else the source's outline.

## OCCT

- **Build:** `-UOCC_CONVERT_SIGNALS` or the full link is invalid WebAssembly (V8 `br_table: label arity inconsistent`: LLVM's `setjmp`/`longjmp` lowering of `OCC_CATCH_SIGNALS`, a wasm-ld bug); set `CMAKE_CXX_FLAGS_RELEASE`, or OCCT appends `-O3` after your flags; `-O2`/`-O3` are no faster than `-Os` and larger, LTO larger with no gain. The data segment is mostly TKernel's CJK code-page tables and `AdvApp2Var` tables. We build `-Os` without the `VBernstein` patch.
- **Our patches** (`occt_patches/`, unified diffs applied by `build-occt.sh` to the worktree `build/occt-src/`, reset each run; a patch that doesn't apply stops the build; each with a header giving bug, evidence and check, and named in the backend's version). Not reported upstream.
- **Bare subsets** need `read.step.product.mode` off: `NbRootsForTransfer` takes an unshared `SHAPE_REPRESENTATION` as a root only then.
- **Units:** compute the root's length unit (`STEPConstruct_UnitContext::ComputeFactors`) and pass it to `SetSystemLengthUnit`, so output is in file units.
- **Face ids:** `TransferBRep::ShapeResult(TP, entity)` for every `StepShape_FaceSurface` gives the faces after shape fixing (ShapeFix splits faces, so an id can repeat). Geometric sets' surfaces likewise (a face entity's id wins). Edge ids from `StepShape_EdgeCurve`; curve ids from the set's element, a `COMPOSITE_CURVE` before its segments' curves.
- **Edges:** `TopExp::MapShapesAndUniqueAncestors(shape, EDGE, FACE)`, each edge's `Poly_PolygonOnTriangulation` on its first face, else its `Polygon3D`, else its vertex; dihedral angles from the faces' mesh normals (OCCT's stored continuity isn't computed on import). Unmapped edges are OCCT's own (poles, seams added to periodic faces).
- **Messages** go through Emscripten's `print`; collected per call so they can't reach `stepconv -o -`'s output; kept per part as warnings (at most 10, 1000 characters). "Unresolved Reference" can be triggered by the header alone.
- **OCCT 8.1 against 7.6.1** (`occt-import-js`): 8.1's `ShapeFix_Face` adds natural bounds to a lone wire on a doubly closed surface, right for `ADVANCED_FACE`s (`bug28414_bug_toroidal_surface.stp`, `bug29564.stp`) but wrong for curve-bounded spheres and tori in geometric sets (`trj4_k1_geo-pe-203.stp`), so we turn it off for geometrically bounded surfaces only. `occt-import-js` is itself wrong on some parts (bicycle #1170) and drops faces' fill colours in `2.stp`.
- **ShapeFix at a seam:** a hole whose vertices lie on a closed B-spline's seam (bicycle #23723) projects open by one period; `FixMissingSeam` and `ShapeFix_ComposeShell` then make an overlapping face and a zero-area one, slowly. No ShapeFix mode helps. Left as is.
- **BRepMesh's cone seam amplifier** (patch `0001`, `conical-surface.step`): `SeamEdgeAmplifier` matches pcurves by the point at `FirstParameter()`, -2e100 for a `Geom2d_Line`, so a seam line with any U slope swaps them and the face fails. Found with a probe build running the mesher's stages one at a time through `BRepMesh_Context` (initialise parameters as `BRepMesh_IncrementalMesh::initParameters` does, or the healer crashes on `MinSize` 0). Lesson: an expectation that encodes a difference without finding its cause (truck's "1.35 x OCCT's area" there) can hide the other side's bug.
- **Tessellated strips and fans:** OCCT 8.1 (`StepToTopoDS_TranslateFace`) winds them the reverse of Part 42 (the files' normals agree with Part 42), gives no face ids and no edges; we read them ourselves.
- **Slow parts:** by size at an absolute deflection (`bug28366_fuselage.stp` #368, `as1_motor.step` #6322), or faces with thousands of holes (`bug24024_slow_import.stp` #76247; Delabella faster there but leaves more faces untriangulated over the corpus). `bug30790.step`'s parts #11-21 and #24 get far slower at tighter angles (0.5 s at 28.6 degrees, 24-44 s at 15, timeouts at 12.5): not investigated; a probe timing BRepMesh's stages would show where.
- **Memory:** linear memory never shrinks, but is reused, so the heap grows only to the largest part so far.
- **`instantiateWasm`:** this Emscripten build ignores `Module.wasmBinary`; hand it the compiled module through the hook (needed to hash the module).
- **The `VBernstein` patch** (`occt_overlay/`, unused): computes the 840 kB Bernstein table instead of storing it (-468 kB brotli); reached only by `AppCont_LeastSquare`, never by the corpus. If adopted, check the upstream header's hash in the build.
- **Probing:** copy `occt_tess.cpp` to the scratchpad, add probes switched by environment variables (through `Module.ENV` in `preRun`), link against `build/occt-Os` (compile 1 s, link 7 s).

## truck

- **Workarounds** in `native/src/lib.rs` (truck unchanged): (1) shells built by the wrapper, so ids survive faces and edges that fail; (2) `AXIS2_PLACEMENT_3D` without `ref_direction` on an +/-x axis gets (0, 1, 0) per Part 42; (3) shells reversed by volume sign; (4) `SURFACE_CURVE`s by their 3D curve; (5) NaN edges and faces left out (truck subdivides NaN curves until memory runs out); (6) instances truck's parser can't read skipped one at a time (ruststep fails the whole file on `()`); (7) negative torus radii as absolute; (8) cone semi-angles from the context's angle unit; (9) a shell reversed only if its mesh is consistently oriented; (10) unclamped B-splines clamped; (11) a face meshed against all its loops reversed; (12) the volume sign trusted only if the same from every point of the bounding box and at least 1 % of the sum of the triangles' contributions.
- The tolerance is the linear deflection; the angle is ignored.
- **What's left:** cones near the apex, surfaces of revolution, rational B-splines; timeouts in NURBS evaluation (9 corpus hangs that never finish); empty parts (geometric sets, triangulated faces, unsupported surfaces). About 83 % of parts complete and on OCCT's geometry. A truck fallback for OCCT's failures isn't shown to be safe.
- Comparing orientation or area with OCCT measures OCCT's healing as much as truck: compare geometry (sampled vertices on the other's faces) and the file's own loops.
- **Size and speed:** opt-level 3 (`s`, `z` save little at 1.5-3.5 x the time). On parts both mesh, truck 2.2 x faster in total, 26 % fewer triangles; its hangs make whole runs far slower. Five wasm-bindgen imports from chrono and getrandom are stubbed; a test pins the import list. `info.license` is AGPL-3.0-only (our wrapper over truck's Apache-2.0).
- **monstertruck** fixes some parts and regresses others, with 9 x the triangles; not adopted.

## Backlog

- **Size-relative deflection** (the user: an adaptive mode, perhaps a profile): would bound the slowest parts.
- **Maximum chord length** (another CAD system's profiles set 10 m): neither mesher has one; would need our own pass splitting long edges.
- **OCCT:** moving the seam away from a hole before ShapeFix or dropping the bad face; Delabella for faces with many holes; a deep dive into both algorithms first (the user's request). Size: stub the CJK tables (a source patch), a reader-only controller (about 150 kB).
- **truck:** curves need `TRIMMED_CURVE` and `COMPOSITE_CURVE` in the wrapper; geometric sets' surfaces need new code.
- Not tested: a module that compiles but fails to instantiate; a part needing more than OCCT's 2 GB.
