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

A shared helper in `cad-scene` (proposed: `exportView(scene, meshes)` next to `partInstances`) would compute the looks, the per-look primitives and the per-instance transforms once, and each exporter would only write its format.

## Steps (proposed)

| # | Step | Status |
|---|---|---|
| 1 | **The export view** (`cad-scene`): looks, primitives by material, instance transforms with the origin; hidden instances; unit tests on small scenes with overrides, assembly colours and per-face materials | Planned |
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

## Not planned

- **Exporting from other sources:** the exporters take any scene, but only the STEP importer exists; other formats come with their importers ("Future input formats" in `architecture.md`).
