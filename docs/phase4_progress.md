# Phase 4 (exporters and `stepconv`): plan and progress

*Paths in this document are relative to this `docs/` directory.*

Phase 4 of `architecture.md` ("Phasing"): the exporters, three.js JSON, then glTF/GLB, then 3MF, and the `stepconv` CLI that drives import, tessellation and export. The format table is in `architecture.md`, "Stage 4". This file tracks the order of work and what each step finds.

Status: **plan, 2026-10-20.** The four decisions below are made; nothing is built yet.

## Where things stand

- **The scene** (`../packages/cad-scene`): components placed by occurrences (a subassembly stored once), parts defined once, materials, layers, instance overrides, millimetres. `partInstances` expands the tree and resolves each placed part's material, per-face materials and visibility, top down as the CAx-IF practice has it. Meshes are `Float32` relative to a per-part origin, in the part's own unit, with face ranges, edges, wireframe curves and points (`phase3_progress.md`, step 6).
- **Tessellation:** `tessellateScene` (requests in parallel), the worker pool (`tess-workers`, timeout and recycling), the cache (`tess-cache`), and two backends, OCCT (robust, LGPL, 2.18 MB brotli) and truck (Apache, about 1/6 the size, less robust).
- **The CLI** (`../packages/cli`, `cad-io-cli`) has `step2json` only.
- **Nothing exports yet.** The corpus checks compare scenes and meshes against OCCT, but no file leaves the process.

## What every exporter needs

Three things the scene leaves to its consumers, the same for all three formats:

1. **Instances that differ in appearance.** All three formats share geometry between instances, but a mesh carries its materials (glTF: per primitive; three.js: a geometry's groups index the object's material array; 3MF: per triangle). Two instances of one part with different resolved materials (an assembly's colour applied top down, an instance override) need different meshes, or in three.js the same geometry with different material arrays. So each placed part reduces to a *look*: (part, material for unstyled faces, per-face materials). Instances with equal looks share one mesh.
2. **Splitting a mesh by material.** Face ranges with the same material become one primitive (glTF), one group (three.js) or one property id (3MF).
3. **The part's origin and unit.** A mesh is in the part's unit minus its origin, so each instance's transform is the part instance's transform times a translation by the origin; the unit is already in the part instance's transform.

A shared helper in `cad-scene`, `exportView` (step 1), computes the looks, their groups by material and the per-instance transforms once, and each exporter only writes its format.

## Steps

| # | Step | Status |
|---|---|---|
| 1 | **The export view** (`cad-scene`): looks, groups by material, instance transforms with the origin; hidden instances; unit tests on small scenes with overrides, assembly colours and per-face materials; a corpus check against `partInstances` | **Done** 2026-10-20 |
| 2 | **three.js JSON** (`export-threejs`): JSON Object Scene format 4; an `Object3D` tree that follows the instance tree, geometries and materials shared by uuid, metadata (names, source ids, properties) in `userData`, millimetres with the unit in the root's `userData`, Z-up as in the source; edges and curves as `LineSegments`, points as `Points`, each on request (decision 2). Checked by loading the output with `THREE.ObjectLoader` in Node (three as a dev dependency) and comparing triangle, instance and material counts with the scene | Planned |
| 3 | **`stepconv`** (`cli`): STEP → import → tessellate (pool, cache) → export, the format chosen by the output's extension; options for the backend (OCCT by default, decision 4), the deflections, workers, the cache directory and edges; a summary and diagnostics on standard error, exit codes as `step2json`'s. Done after the first exporter so the whole path runs early, and each later exporter plugs in | Planned |
| 4 | **glTF/GLB** (`export-gltf`): glTF 2.0, a mesh per look reused across nodes, the node tree following the instance tree, metadata in `extras`, a root node scaling millimetres to metres and turning Z-up to Y-up; materials as `pbrMetallicRoughness` base colours (sRGB → linear) with alpha blending for transparent ones; edges and curves as `LINES`, points as `POINTS`, on request (decision 2). Checked with the Khronos glTF-Validator (dev dependency) on every corpus file | Planned |
| 5 | **3MF** (`export-3mf`): the core spec with colours (`basematerials`, or `colorgroup`); vertices welded by position across faces so solids come out manifold, and meshes that still aren't manifold left out with a warning, or written as `surface` objects by option (decision 3); components for the assembly tree (an assembly node with its own geometry split into a mesh object and a component object, `architecture.md`); `unit="millimeter"`; zipped with fflate. Checked with lib3mf (the 3MF Consortium's WASM build, `@3mfconsortium/lib3mf`, BSD-2-Clause, dev dependency) | Planned |
| 6 | **Corpus checks:** every corpus file through `stepconv` in all three formats, with each format's validator, counts against the scene, and timings (import, tessellation, export) | Planned |

Order: as `architecture.md` has it. The export view comes first because all three exporters use it; `stepconv` comes right after the first exporter.

## Decisions (made by the user, 2026-10-20)

1. **How glTF is written. Decided by the user (2026-10-20): glTF-Transform**, as `architecture.md` has it (MIT; `@gltf-transform/core` 4.5.1, one dependency, 1.8 MB unpacked): a tested writer, GLB packing, and later Draco, meshopt and `EXT_mesh_gpu_instancing` through its extensions, at the cost of a runtime dependency and a second document model beside the scene. (Alternative: written by hand; the JSON and GLB container are small and need no dependency, but compression later would bring one in or need our own code.)
2. **Edges, wireframe curves and points in the output. Decided by the user (2026-10-20): B-rep edges and wireframe curves each behind their own option.** three.js has `LineSegments` and `Points`; glTF has `LINES` and `POINTS` primitives (in the spec, but some viewers ignore them); 3MF has no lines, so neither option applies to it. (Alternatives: everything always; curves always and edges on request; one option for all.) **Both off by default** (the user, the same day), so wireframe-only parts export empty unless curves are turned on; isolated points go with the curves option, since both come from wireframe representations.
3. **3MF meshes that aren't manifold.** Surface models, open shells and parts the backend meshed with gaps (truck's empty faces, say) break the core spec's rules for `model` objects. 3MF 1.4 allows `surface` and `other` objects to break them (core spec, section 4.1). **Decided by the user (2026-10-20): each welded mesh is checked; by default the ones that fail are left out with a warning, and a `stepconv` flag (and the matching exporter option) writes them as `surface` objects with a warning instead.** (Alternative: everything written as `model`, left to the slicer.)
4. **`stepconv`'s default backend. Decided by the user (2026-10-20): OCCT, with truck by option.** OCCT is the more robust (the reference in every check), truck the smaller and Apache-licensed; the CLI runs in Node, where download size doesn't matter. (Alternative: no default, the backend always named.)

Not proposed for this phase: Draco or meshopt compression and `EXT_mesh_gpu_instancing` ("optional later" in `architecture.md`), the 3MF Production extension (open item in `architecture.md`), and per-curve colours (backlog).

## Step 1: the export view

`../packages/cad-scene/src/export.ts`, `exportView(scene, meshes, {edges, curves})`:

- **Looks:** each placed part's appearance comes from `partInstances`, so the CAx-IF rule (overrides, then the topmost component's material, then the part's with its per-face materials) stays in one place. A look is a part plus the material of each of its mesh's face ranges (its own, else the instance's) and the default material, which edges, curves and points take. Face materials of faces the mesh doesn't have don't split looks. Instances with equal looks share one.
- **Groups:** a look's triangles reordered so faces with the same material are contiguous, groups in order of first appearance; a mesh with one material keeps its own index array, and a mesh without face ranges (a future mesh part) is one group.
- **Nodes:** the expanded instance tree as `instances` walks it (a component inside itself isn't expanded again), each node with its occurrence, its name (the occurrence's, else the component's), its local transform, and its parts as looks with the part reference's transform times the translation by the mesh's origin, and visibility.
- **What's dropped:** parts with nothing to draw: no mesh (failed or not tessellated), or only edges, curves or points when their option is off (decision 2, both off by default). Hidden part instances are kept, marked `visible: false`, for each exporter to decide.
- `partMesh` gives a part's mesh: its tessellation, a mesh part's finest level, or a curves part as a curves-only mesh.

**Tests** (4 new, 148 in the repo): one small scene (an assembly with two subassembly instances, a plate in inches with per-face materials and an origin, a bolt with an edge, a wireframe, a part that failed): the tree, names and transforms; two instances sharing a look; groups and the reordered indices; the origin in inches; overrides making new looks and hiding a subtree; a face material equal to the default giving one group; the two options; a brep part with only points; a mesh part without face ranges; a cycle.

**Mutation check:** 15 deliberate bugs in `export.ts`, all caught.

**Corpus check** (`../corpus_checks/export_view.ts`, log `export_view.log`): every corpus file imported, tessellated with our OCCT backend at 0.1 mm with edges (a `tess-workers` pool), and its view (edges and curves on) compared with `partInstances`: each drawable part instance once at its path, its world transform (the view's transforms multiplied down the tree) equal to `partInstances`' times the origin's translation, its visibility and default material, its triangles with their group's material equal as a multiset to the mesh's triangles with the materials the scene resolves per face, and equal instances sharing a look. Planted bugs show (the origin dropped: 130 problems in 20 files; the default not applied to faces: 91). Result over all 517 files (174 s, 9 workers): 5,036 part instances, 5,027 with something to draw (the other 9 have no mesh), 3,262 looks, 115 of them with more than one group, 16.8 M triangles; **0 problems**. No part has more than one look: the importer makes no instance overrides or component materials for any corpus file (per-instance style resolution is in the backlog), so instances of a part always resolve alike; 91 files instance parts, and those instances share looks. Looks that differ per instance are covered by the unit tests only.

### Open from step 1

- **Hidden instances in each format** (for the exporters' steps): three.js has `visible`; glTF core has none (`KHR_node_visibility` is an extension); 3MF has none. Proposed: three.js writes them hidden, glTF and 3MF leave them out.

## Not planned

- **Exporting from other sources:** the exporters take any scene, but only the STEP importer exists; other formats come with their importers ("Future input formats" in `architecture.md`).
