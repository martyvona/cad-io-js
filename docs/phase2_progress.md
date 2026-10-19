# Phase 2 (the scene model and the tessellator interface): plan and progress

*Paths in this document are relative to this `docs/` directory.*

Phase 2 of `architecture.md` ("Phasing"): the scene model and the tessellator interface, designed together. The design sketch is in `architecture.md`, "Stage 2". Phase 1 delivered what this builds on: the Layer 3 extractors (`phase1_progress.md`, step 6), whose product structure, placements, units and styles become the scene. This file tracks the order of work and what each step finds.

## Steps (proposed)

| # | Step | Status |
|---|---|---|
| 1 | `cad-scene` package: the scene model and the tessellator interface as types, plus small helpers (tree walk, world transforms, unit conversion, validation) | **Done** 2026-10-17 |
| 2 | STEP subset builder: the production version of phase 0's per-part subsets (closure over the pass-1 reference index, verbatim bytes, optional synthetic product wrapper), with the checks `architecture.md` asks for | **Done** 2026-10-17 |
| 3 | STEP importer: Layer 3 semantics → scene (nodes, parts, instancing, units, materials from styles, layers, external references, metadata) | **Done** 2026-10-17 |
| 4 | Tessellation driver and the custom OCCT backend (`tess-occt`), brought forward from phase 3 (decision 5) | **Done** 2026-10-17 |
| 5 | Corpus checks: every file imports; the scene agrees with the semantic counts; end to end against OCCT | **Done** 2026-10-17 |

Phase 3 (the custom OCCT backend, then truck) and phase 4 (exporters, `stepconv`) follow.

## Decisions (made by the user, 2026-10-17)

1. **The scene's length unit is the millimetre** (first chosen as the metre, changed by the user the same day): the usual CAD unit and the unit of most files, so most transforms carry no scale; glTF export adds one root scale to metres. Part geometry stays in its own file unit; the node and part transforms carry the conversion. (Alternatives considered: metres, SI and glTF's unit; the root product's unit.)
2. **A part is one shape representation that holds geometry.** It matches the tessellator interface (one request, one root id) and caches by representation. A product whose geometry spans several representations gets several part references, each with its transform from `productRepresentations`. (Alternative: one part per product.)
3. **Positions become `Float32` in the backend, after subtracting an origin the request carries**, in double precision. The JS side chooses the origin before tessellating, from the part's own `CARTESIAN_POINT`s, so parts modelled far from their origin keep their precision. (Alternatives: `Float32` in representation coordinates, losing precision for far-off parts; `Float64` across the worker boundary.)
4. **The STEP importer is a new package, `step-import`**, depending on `step-parser` and `cad-scene`, so the parser stays usable without the scene model.
5. **Phase 2's end-to-end checks use the custom OCCT build** from phase 0 (`../phase0_tessellation_spike/occt_tess`), brought forward: face ids, edges and file units from the start, so per-face materials are checked in this phase. Its wrapper gains the request origin (decision 3). (Alternative: an `occt-import-js` adapter, without face ids.)

## Step 1: the `cad-scene` package

`../packages/cad-scene` (no dependencies):

- **`scene.ts`, the model.** A `Scene` (lengths in millimetres) holds:
  - **components**, one per product or assembly definition, each with its own parts (`PartRef`: a part, its transform into the component's coordinates, an optional material, visibility) and its children (`Occurrence`: a component, a transform into the parent's coordinates, a name, source ids, properties); an optional external reference and material;
  - **roots**, the top-level occurrences;
  - **parts**: `brep` (a payload function, its format and root id, built on demand), `mesh` (levels of detail) or `curves`; each with its own length unit (in mm), an origin, a material and per-face materials by source face id;
  - **materials** (sRGB colour as the source gives it, opacity), **layers** (parts and single faces), **instance overrides** (by occurrence path: material, visibility, per-face materials), properties and diagnostics.

  The architecture sketched "a tree of occurrences". The scene instead stores components once and occurrences of them, so a subassembly used many times is stored once (and 3MF's shared components map directly); `instances` expands the tree on demand, which gives exactly the sketched tree.
- **`tessellator.ts`, the interface** as in `architecture.md`, plus the request's `origin` (decision 3), echoed in the result.
- **`walk.ts`:** matrix basics; `instances(scene)`, the expanded tree with each instance's path and transform to the scene; `partInstances(scene)`, every placed part with its appearance resolved top down as the CAx-IF styling practice has it (an instance override, deepest first; else the topmost component's material; else the part reference's or the part's, with per-face materials on top; instance overrides' face materials last), and visibility; `validate(scene)`, indices, finite transforms, positive units and cycles.

3 tests: the expansion and world transforms; the material rules (part and face materials, component materials top down, instance overrides at two depths, hidden instances); validation, and a cycle the walk survives.

## Step 2: the STEP subset builder

`../packages/step-parser/src/subset.ts`: `closure(file, roots, exclude?)` (the forward-reference closure over the pass-1 reference index, in file order) and `buildSubset(file, roots, {exclude, wrapper, header})`:

- Entities are copied byte for byte from the source, in file order, with the original header.
- **Excluded positions** are neither copied nor followed, and the roots lose their references to them (the root alone is re-serialized). This is how a representation's `MAPPED_ITEM`s stay out of its subset: under decision 2 what they map is a part of its own, placed by the importer, and would otherwise be tessellated twice.
- The optional **synthetic product wrapper** (phase 0's 8 entities) gets ids above every id the file defines *or references*, so that a dangling reference can't come to resolve to a wrapper entity (the first version used the largest defined id; the tests caught it).
- The result lists the ids the subset references but lacks.

2 tests. **Corpus** (`../corpus_checks/subset_corpus.ts`, log `subset_corpus.log`): a subset for each of the 4,549 shape representations the product structure reaches, built as the importer does (10 with mapped items left out): every subset parses without diagnostics, every instance in it equals the source's (the root minus its mapped items), and every reference it lacks is dangling in the source too. 4.25 M instances, 327 MB; building them all took 3.4 s (on battery, low power mode).

## Step 3: the STEP importer

`../packages/step-import` (`importStep(input)`, or `sceneFromStep(model, semantics)`):

| STEP (Layer 3) | Scene |
|---|---|
| product definitions | components, index for index; name, part number, version, description, life-cycle stage as properties; source ids of the definition and the product |
| documents marked external | the component's external reference |
| shape representations with geometry (any item other than placements and mapped items) | parts, one each: a `brep` with a STEP subset payload (mapped items excluded), the representation's unit in mm, and an origin at the centre of the bounding box of the points in its closure; a part without a name takes its product's |
| `productRepresentations` | the component's part references, transforms into the component's millimetres |
| occurrences | the parent component's children, transforms from the child's millimetres to the parent's |
| roots | root occurrences |
| styles | materials, deduplicated by colour and opacity: per part, the most common face colour as the part's material and the others per face (each face's style resolved up through its shell and solid to the representation, within the part); a style on an assembly's own representation as the component's material; a part whose top-level items are all styled invisible is hidden |
| context-dependent overriding styles | instance overrides: the style context (representation relationships, top down) mapped to an occurrence path |
| layers | layers of parts and faces |

2 tests, on an assembly in metres with an inch part used three times (once in a nested subassembly), a mapped item, an external component, a red solid with a blue face, two context-dependent styles (one two levels deep) and a layer. Mutation check: 8 deliberate bugs, all caught (one, a path built from global occurrence indices instead of child indices, only after the test gained the nested subassembly).

**Corpus** (`../corpus_checks/import_corpus.ts`, log `import_corpus.log`): all 517 files import into scenes that `validate` accepts, with a component per product and an occurrence per placed occurrence; 3,279 parts (every payload parses and contains its root), 5,051 placed parts, 653 materials, 111 parts with per-face materials, 3,169 layers, 68 external components. No corpus file has context-dependent styles or a styled assembly representation, so those paths are covered by the unit tests only.

## Step 4: the tessellation driver and the OCCT backend

- **`../packages/tess-occt`** (LGPL-2.1 with the Open CASCADE exception, isolated here as `architecture.md` requires): `native/occt_tess.cpp`, phase 0's wrapper grown up, now taking the request's origin and subtracting it in double precision before every conversion to float (mesh positions, edge points, degenerate edges' vertices); `build.sh`, which links it against the OCCT static libraries phase 0 builds (`../phase0_tessellation_spike/occt_variant_build.sh Os -Os`; 8 s, 7.2 MB of WebAssembly uncompressed; `dist/` and `build/` are git-ignored); and `src/index.ts`, `OcctTessellator` implementing the `Tessellator` interface (results copied out of the WebAssembly heap; OCCT failures become error diagnostics with an empty result).
- **`../packages/cad-scene/src/tessellate.ts`:** `tessellateScene(scene, tessellator, {linearDeflection, angularDeflection, edges, parts, onPart})` sends one request per brep part, with the part's origin and the deflection converted from millimetres to the part's unit, and returns meshes by part index plus diagnostics; `toMesh` converts a result.
- 2 tests, run only when the module is built and the corpus is fetched: a 10 mm cube (six faces with distinct `ADVANCED_FACE` ids, twelve shared edges at 90°, each position equal to the double-precision difference from the origin rounded once to float32, the importer's origin at the cube's centre), and unreadable input.

Still to do here: caching across runs, workers, and `curves` parts for wireframe representations (see step 5).

## Step 5: corpus checks, end to end

**`../corpus_checks/scene_occt.ts`** (log `scene_occt.log`) runs the whole path, import → tessellation with our OCCT backend → placement (`partInstances`), and compares it with `occt-import-js`'s import of the whole file (OCCT's XCAF reader, world millimetres), at a deflection of 1/1000 of the model's size on both sides:

- **Geometry:** sampled vertices of every placed part must lie on OCCT's mesh surface, within the two meshes' deflections. **181,542 of 183,247 (99.1%)**, in 465 files (files up to 5 MB; 37 more where `occt-import-js` produces no meshes). Every placement, unit and origin agrees except in the known cases: `trj4_s1-ai-214.stp` (Alibre: `occt-import-js` places the parts at the identity) and `OCC22238_test.stp` (the transform formula; phase 1, step 6), plus files with broken or degenerate geometry (`bug22871_null-swept-curve.stp`, `bug28414_bug_toroidal_surface.stp`, the `k1_geo` kinematics files).
- **Colour:** each sampled triangle's colour (part, face and instance materials resolved) against the colour OCCT gives the nearest triangle facing the same way (orientation tells touching assembly parts apart), within 0.01 per component (OCCT's colours are linear RGB, `Quantity_Color`; ours are converted from the file's sRGB). **133,018 of 135,966 (97.8%)**, after the boundary-colour decision below (97.1% before it).

The check found three importer bugs, all fixed and covered by tests:

1. **The most common face colour spread to unstyled faces.** The part's material was the most common colour among styled faces, and unstyled faces inherit the part's material; a single red face turned a whole part red (`trj2_io1-ug-214.stp`). Now a part gets a material only when every face resolves to one; otherwise the colours go per face and unstyled faces stay unstyled.
2. **Curve colours used for faces.** Faces now take only surface colours; curve and point colours are for wireframe and point parts.
3. **Per-view styles applied by default.** `PRESENTATION_STYLE_BY_CONTEXT` styles apply only in their presentation context (a view); `trj12_is1-oc-214.stp` has two such overrides, red and yellow, on top of a yellow default. They are now recorded on the styled item (`presentationContext`) and left out of default materials and `effectiveStyle`. Along the way, two plain overrides of one style now resolve to the later one, as in OCCT.

`SURFACE_STYLE_BOUNDARY` (the colour of a surface's boundary curves) is now extracted, as `Style.boundary`.

The remaining colour differences, classified:

- **Boundary colours shown on faces by `occt-import-js`.** Unigraphics styles solids only through `SURFACE_STYLE_BOUNDARY` (the `as1-ug`, `io1-ug`, `ha1-ug`, `bv1-ug` files, and others). OCCT stores that as a curve colour (`XCAFDoc_ColorCurv`), and `occt-import-js` falls back to curve colours when a face has none, so it shows the faces coloured; by the file, the faces are unstyled. **Decided by the user (2026-10-17): faces show a boundary colour when nothing more specific gives them a surface colour**, since that is clearly what these writers mean and what OCCT-based viewers show. Covered by the importer test; colour agreement rose from 97.1% to 97.8%.
- **A representation's style against its faces' own styles** (`bug31670_russian.stp`, 1,177 samples): the representation and the faces carry plain (not overriding) styles in different colours. We let the more specific, the face, win; `occt-import-js` shows the representation's. The CAx-IF practice says styles inherit top down and a face should override its solid with `OVER_RIDING_STYLED_ITEM`, so a plain face style under a styled representation is a writer's ambiguity. **Decided by the user (2026-10-17): the most specific style wins** (as implemented), which is what viewers usually do; this file's differences from `occt-import-js` stay.
- **OCCT losing face colours**: in `2.stp` (the mapped-item assembly) OCCT drops the faces' own fill colours and shows the solid's curve colour (white); ours follow the file.
- **Per-view styles** applied by OCCT (`trj12_is1-oc-214.stp`, 12 samples), and small cases not investigated individually.

**Parts without meshes:** 120 of 1,114 parts in the files compared. By representation type (a rerun classifying them; some parts are counted under both their type and an OCCT error):

| Representation | Parts | Example | Why no mesh |
|---|---|---|---|
| `GEOMETRICALLY_BOUNDED_WIREFRAME_SHAPE_REPRESENTATION` | 66 | `bug32049_sp7_04dx_242.stp` #13458 | wireframe: no faces to triangulate; should become `curves` parts |
| `GEOMETRICALLY_BOUNDED_SURFACE_SHAPE_REPRESENTATION` | 62 | `trj8_k1-pe-214.stp` #2266 | our backend returns no shape; to investigate (OCCT may need these transferred another way). *Phase 3 step 5: these hold only curves and points, no surface* |
| plain `SHAPE_REPRESENTATION` | 12 | `trj8_c2-ac-214.stp` #62 | OCCT "no shape" (16 such errors in all). *Phase 3 step 5: 11 hold only annotations, and are no longer parts* |
| `EDGE_BASED_WIREFRAME_SHAPE_REPRESENTATION` | 4 | `trj6_c1-ct-214.stp` #258 | wireframe |
| `GEOMETRICALLY_BOUNDED_2D_WIREFRAME_REPRESENTATION` | 4 | `trj2_d2-db-214.stp` #1032 | 2D wireframe (drawings) |
| `MANIFOLD_SURFACE_SHAPE_REPRESENTATION` | 2 | `tr9_asd-db.stp` #241 | not investigated |
| `ADVANCED_BREP_SHAPE_REPRESENTATION` | 1 | `bug31292.stp` #62 | OCCT's deliberately broken-references file |

These are in the backlog (`phase1_progress.md`), to revisit in later work.

The other step 5 checks: `import_corpus.ts` and `subset_corpus.ts` (steps 2 and 3) on every file.

