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
| 2 | **three.js JSON** (`export-threejs`): JSON Object Scene format 4; an `Object3D` tree that follows the instance tree, geometries and materials shared by uuid, metadata (names, source ids, properties) in `userData`, millimetres with the unit in the root's `userData`, Z-up as in the source; edges and curves as `LineSegments`, points as `Points`, each on request (decision 2). Checked by loading the output with `THREE.ObjectLoader` in Node (three as a dev dependency) and comparing triangle, instance and material counts with the scene | **Done** 2026-10-20 |
| 3 | **`stepconv`** (`cli`): STEP → import → tessellate (pool, cache) → export, the format chosen by the output's extension; options for the backend (OCCT by default, decision 4), the deflections, workers, the cache directory and edges; a summary and diagnostics on standard error, exit codes as `step2json`'s, and 3 for failed parts with `--strict`. Done after the first exporter so the whole path runs early, and each later exporter plugs in | **Done** 2026-10-20 |
| 3a | **Detour: dangling references** (`step-parser`, `step-import`): the importer warns per part of references to instances the file doesn't define, which only OCCT's messages showed before | **Done** 2026-10-21 |
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

**Mutation check:** 15 deliberate bugs in `export.ts`, all caught. *(Corrected in step 2: the first run, committed with step 1, ran `node --test` on the test directory, which fails whatever the code, so every mutation looked caught. Run properly, two survived: the look key without the default material (only faceless instances can tell) and points-only parts (the test's look happened to be another part's); both tests were strengthened. The script now checks that the unmutated tests pass first.)*

**Corpus check** (`../corpus_checks/export_view.ts`, log `export_view.log`): every corpus file imported, tessellated with our OCCT backend at 0.1 mm with edges (a `tess-workers` pool), and its view (edges and curves on) compared with `partInstances`: each drawable part instance once at its path, its world transform (the view's transforms multiplied down the tree) equal to `partInstances`' times the origin's translation, its visibility and default material, its triangles with their group's material equal as a multiset to the mesh's triangles with the materials the scene resolves per face, and equal instances sharing a look. Planted bugs show (the origin dropped: 130 problems in 20 files; the default not applied to faces: 91). Result over all 517 files (174 s, 9 workers): 5,036 part instances, 5,027 with something to draw (the other 9 have no mesh), 3,262 looks, 115 of them with more than one group, 16.8 M triangles; **0 problems**. No part has more than one look: the importer makes no instance overrides or component materials for any corpus file (per-instance style resolution is in the backlog), so instances of a part always resolve alike; 91 files instance parts, and those instances share looks. Looks that differ per instance are covered by the unit tests only.

### Open from step 1

- **Hidden instances in each format** (for the exporters' steps): three.js has `visible`; glTF core has none (`KHR_node_visibility` is an extension); 3MF has none. Proposed: three.js writes them hidden, glTF and 3MF leave them out.

## Step 2: three.js JSON

`../packages/export-threejs` (Apache-2.0; depends on `cad-scene`; three 0.186.1 and its types as dev dependencies, for the tests and the corpus check):

- **`threejsChunks(scene, view, opts)`** yields the JSON Object Scene format 4 document (version 4.7, as `Object3D.toJSON` writes it) in chunks, since the arrays are plain JSON numbers and a large model's JSON can exceed V8's maximum string length; `threejsJson` joins them for small scenes. Floats are written in the fewest digits that read back to the same `Float32` (`formatFloat32`), and uuids are deterministic, so the same scene gives the same file.
- **Objects:** a root `Group` (`userData`: `unit: 'millimetre'` and the scene's properties); a `Group` per node of the view's tree, with its local matrix (both column-major, written as is) and `userData` with the occurrence's sources and properties, the component's index, name, sources and properties, and any external reference; per placed part a `Mesh` (a `Group` for a part without triangles) with the part's matrix, `visible: false` for hidden instances, and `userData` with the part's index, sources, properties and its faces' sources as index ranges (`Look.faces`, added to the export view for picking). Lengths are millimetres and axes as in the source (`architecture.md`'s "keep file units": the scene's unit since phase 2).
- **Lines and points** (decision 2, each on request): B-rep edges and wireframe curves as `LineSegments` children of the part (polylines turned into segment pairs, so one geometry holds all of a part's edges; `userData` lists each polyline's source, kind, dihedral and index range), points as a `Points` child (`userData`: their sources).
- **Geometries** are shared by every instance of a look, and by looks with the same triangles; a look with one material reuses any geometry of its mesh, with its material repeated for each group, so an instance recoloured by an override doesn't repeat the vertices. A geometry with several materials has `groups` indexing the `Mesh`'s material array.
- **Materials:** one per scene material and kind: `MeshStandardMaterial` (three's defaults otherwise), `LineBasicMaterial`, `PointsMaterial`; colours are the scene's sRGB as hex, which is how three's JSON stores colours; opacity below 1 sets `transparent`; `userData.material` is the scene material's index.

Choices made here, for the user's review (each an option where marked):

| Choice | Made | Alternatives |
|---|---|---|
| Faces rendered from both sides (`doubleSided`) | off, three's default (**changed by the user**, 2026-10-20, from on): open shells and surface models vanish from behind | on |
| Edge kinds written (`edgeKinds`) | `shared` and `free` (`architecture.md`'s typical choice) | all four, and leave filtering to the viewer by `userData.edges[].kind` (needs one object per kind to hide them) |
| Edge colour (`edgeColor`) | black | the part's colour |
| Colour without a material (`defaultColor`) | light grey (0.8) | |
| Point size | 4 pixels, not attenuated | |
| Hidden instances (open from step 1) | written, `visible: false` | left out |
| Material type | `MeshStandardMaterial`, three's defaults (roughness 1, metalness 0) | `MeshPhongMaterial`; tuned roughness |

**Found on the way: worker flags.** The corpus check, run with `--max-old-space-size`, failed to start its pool: `tess-workers`' Node adapter passed the process's flags to workers explicitly (to leave `--input-type` out, phase 3 step 1), and Node rejects process-wide flags in an explicit list, though it drops them when workers inherit by default. Fixed: workers inherit by default unless `--input-type` is set; with it, the list is passed without it, and any flags Node names as invalid are left out on a second try. A new test runs a pool in child processes with `--max-old-space-size` and `--stack-size`, from a file and under `node -e`; it fails on the old adapter.

**Tests** (4 new in `export-threejs`, 1 in `tess-workers`, 153 in the repo): the output loaded with three's own `ObjectLoader`: the tree, names and `userData`; world matrices (the instance, inches to mm, the origin); one geometry for both instances; groups, positions, normals and indices; colours, opacity and sides per group, the override's material shared across groups; edges by kind, as segments, with colour and `userData`; curves and points in the default colour, and red by override; options; chunks forming one document, deterministic, with arrays split across chunks; `formatFloat32` over 20,000 random floats (exact and shortest).

**Mutation check:** 23 deliberate bugs in the exporter, all caught (baseline checked first), and 2 in the worker fix (the old adapter, the retry removed), both caught.

**Corpus check** (`../corpus_checks/threejs_corpus.ts`, log `threejs_corpus.log`): every file exported with edges and curves, the JSON parsed and loaded with `ObjectLoader`, and compared with the view: one part object per placed part in tree order, world matrices, index counts, and every triangle with its material's colour and opacity, as multisets per part. Planted bugs show (colour channels swapped: 82 problems in 20 files; part matrices dropped: 130). Result over all 517 files (194 s with tessellation, 9 workers): 4,857 meshes on 3,125 geometries (instances share them), 5,146 groups, 17.7 M placed triangles, 2.0 M edge and curve segments, 1,064 points; **0 problems**. The JSON totals 1,024 M characters, written in 16.8 s; parsing and loading it all took 2.2 s. The largest files are `as1_motor.step` (294 M characters, 5.0 s) and `bug28366_fuselage.stp` (207 M), both under V8's string limit (537 M), so every file loaded; as phase 3 step 7 found, these two are large because of the absolute 0.1 mm deflection (backlog row "Size-relative deflection").

## Step 3: `stepconv`

`../packages/cli/src/stepconv.ts` (bin `stepconv`), structured like `step2json` (`Io` streams in, an exit code out: 0 done, 1 usage, 2 failure with nothing written, 3 parts that failed with `--strict`):

```
stepconv [options] <file.stp | file.stpZ | -> -o <output>
  -o, --output <file>      the output file ('-': standard output, with --format)
  -f, --format <format>    threejs (.json); glTF/GLB and 3MF with steps 4 and 5
  -b, --backend <name>     occt (default, decision 4) or truck
  -d, --deflection <mm>    default 0.1        --angular <deg>   default 28.6, exactly the library's 0.5 rad (truck ignores it, phase 3 decision 2)
      --edges, --curves    B-rep edges; wireframe curves and points (decision 2: both off by default)
      --double-sided       three.js faces from both sides
  -j, --workers <n>        default cores - 1; 0: on the main thread, one part at a time, no timeout
      --timeout <s>        per part, default 120 (0: none)
      --cache <dir>        a tess-cache FileStore; --cache-size <MB>, default 1024 (0 disables)
      --strict             exit 3 if a brep part isn't tessellated (the output is written all the same)
  -q, --quiet, -h, --help
```

- **The path:** `readStep` (plain or gzipped, file or standard input) → `importStep` → `tessellateScene` over a `tess-workers` pool of the backend (or the backend itself with `-j 0`), wrapped in a `CachedTessellator` with `--cache` → `exportView` → the format's writer, its chunks written with backpressure. The root object is named after the input file (`stdin` for standard input).
- **Output:** opened after the import and before tessellating, so a bad path fails at once (exit 2); on a later failure the partial file is removed.
- **Summary** on standard error (unless `-q`): parts (brep parts tessellated), placed parts, triangles, bytes written; import, tessellation and export times; cache hits and misses with `--cache`; error, warning and note counts and the first 20 errors and warnings, as `step2json` lists them. A progress line (`tessellating n/total`) when standard error is a terminal. Parts that fail don't fail the run (they're in the summary, as in `step2json`) unless `--strict`: then a brep part without a mesh makes the exit code 3, after the output is written. A part whose result is empty gets no error of its own (`tessellateScene` leaves it out of the meshes; the test's broken cube shows 0 errors and OCCT's one warning), so the count of parts tessellated is what `--strict` goes by.

**Found on the way: OCCT's messages on standard output.** OCCT prints messages (`*** ERR StepReaderData : ...`) through Emscripten's `print`, which is `console.log`, so with `-o -` they landed in the middle of the JSON (`bug32314_corrupted.stp` and others, on the main thread and in workers alike, since a worker's standard output is the process's). First fixed by sending them to standard error; then, at the user's review, kept as diagnostics instead (below).

**OCCT's messages as diagnostics** (the user, 2026-10-20: printed nowhere; kept per part if they're informative, within a memory limit). A survey of what OCCT prints for every corpus part (OCCT, 0.1 mm, edges): 99 lines from 59 parts of 3264, in 7 files of 517, at most 2 lines (126 characters) per part, and only two kinds, each a count without entity ids:

| Message | Lines | What's behind it |
|---|---|---|
| `*** ERR StepReaderData : Unresolved Reference : Fails Count : n ***` | 59 | A reference to an entity the file doesn't have: `bug32314_corrupted.stp` (12 parts; the file is damaged, and the importer reports 3 syntax errors), `bug31292.stp` (`#18446744073709552000`), `bug33665.step` (`#18`), `bug26451_Test_STEP.stp` (`#0`, 40 parts). In three files (`bug32049_sp7_10nx_242.stp`, `bug26689_nist_ctc_01_asme1_ap242.stp`, `nist_stc_10_asme1_ap242-e2.stp`; 5 parts) every reference resolves: their header provokes it (the payload's own entities with another header print nothing), and OCCT prints it for the whole original file as well, so it isn't our subsetting. |
| `**** ERR StepFile : Incorrect Syntax : Fails Count : n ****` | 40 | `bug26451_Test_STEP.stp`, beside the `#0` references. |

Also, for input OCCT can't parse, its parser's message with a line number (`ERR StepFile : Undefined Parsing: Line 2: Incorrect syntax: unexpected TYPE, expecting STEP`), before our `read failed`. Informative, then, in 4 of the 7 files: a dangling reference our importer doesn't report (it reports nothing for `bug31292.stp`, `bug33665.step` and `bug26451_Test_STEP.stp`), and the only sign that a part came out without some of its faces for that reason. Nothing in the corpus goes through `printErr` (checked by tagging those lines in a second survey).

So `tess-occt` now collects what the module prints during each `tessellate` call (`print` and `printErr`; output at other times, as during `init`, is dropped) as the part's **warnings**, `OCCT: ` and the text without its asterisks, first in the result's diagnostics. Within a call at most `MAX_MESSAGES` (10) messages of `MAX_MESSAGE_CHARS` (1000) characters in all are kept, a message that crosses the limit cut with `...`, and the rest counted in one more warning (`OCCT: n more messages left out`). The limit is per part, so it's deterministic and cacheable, and the total is at most about 1 KB per part; a limit per run would make a part's diagnostics depend on which parts a worker had done before. `info.version` gained `adapter 2`, so cached results from before (without the warnings) aren't read.

Choices made here, as reviewed by the user (2026-10-20):

| Choice | Made | Alternatives |
|---|---|---|
| Angular deflection's unit | degrees (the user); the default 28.6° is exactly the library's 0.5 rad | a round 30° default |
| Parts that fail | exit 0, in the summary (as `step2json`); `--strict` (the user): exit 3, the output written | exit 2, as for nothing written; leaving no output |
| OCCT's messages | per part as warnings, at most 10 and 1000 characters per part (the user: diagnostics within a memory limit) | a limit per run; `error` severity (OCCT calls them ERR, but the part is usually meshed) |
| Default cache | none (phase 3 step 4 left no default directory); kept by the user | a user cache directory (`~/.cache/cad-io-js`) |
| Workers | cores − 1, timeout 120 s (the pool's defaults); kept by the user | |

**Tests** (10 new for `stepconv` and 2 for `tess-occt`, 165 in the repo; they need the built backends and the corpus, and skip without them): the output byte-identical to the library pipeline's (import, OCCT, view, exporter) with a pool and on the main thread, and the exact summary; defaults (no edges, single-sided) and `--double-sided`; wireframe curves only with `--curves`, and `-j 0` starting no worker (counted on Node's `worker_threads` diagnostics channel); the cache (5 misses, then 5 hits and the same bytes, misses again for another linear or angular deflection, nothing with size 0); `--angular 10` byte-identical to the library at 10π/180 and finer than the default; `--strict` (a cube whose shell refers to nothing: exit 0 without it, 3 with it and the output written, 0 for the sound cube); truck on the cube; gzipped standard input to standard output; 14 usage errors (`--angular 181` among them) and help; an unreadable input and an unopenable output (exit 2); the bin script; OCCT's messages for `bug32314_corrupted.stp` through the bin into a pipe, with and without workers: JSON on standard output, no asterisks on standard error, 14 warnings in the summary. In `tess-occt`: a dangling reference added to the cube's payload gives exactly the one warning, the mesh all the same, nothing written to the process's standard output or error, and no warning on the next call; the limits (`Messages`) on their own; the unreadable-input test now expects OCCT's parse message before the error.

**Mutation check:** 15 deliberate bugs in `stepconv.ts`, all caught after a second round: four survived the first (curves dropped, the angular deflection and the cache size ignored, `-j 0` using the pool); the curves, `-j 0`, angular and size-0 cache tests were added for them. After the review, 15 more in `stepconv.ts` and `tess-occt` (degrees not converted, the 180° bound, `--strict` ignored or always on, the failed-part count, `print` to the console, the message limit off by one, the left-out count, the asterisks, the `...`, empty lines kept, the `adapter` revision, messages lost on a failed read, severity info): 14 caught; `printErr` going to the console survives, as nothing makes OCCT write to standard error (the guard is kept for Emscripten's own abort messages).

**Corpus run** (before the review's changes; the step 6 check will rerun it): the bin on every corpus file with the defaults (a scratch run; step 6 makes it a committed check): all 517 exit 0 with nothing on standard output, 931 MB of three.js JSON in all; the largest `as1_motor.step` (289 MB, 5.3 M triangles) and `bug28366_fuselage.stp` (207 MB), against 294 M and 207 M characters with edges and curves in step 2's check, so edges add little to these two.

## Step 3a: dangling references (a detour, decided by the user 2026-10-21)

Step 3's survey of OCCT's messages found references to instances the file doesn't define that the importer didn't report, in 4 corpus files; OCCT's warnings counted them, without ids, and only with the OCCT backend. The importer already had what it needed: each part's closure (`closure`, computed at import for the origin and faces), and the scan's index of references.

- **`danglingRefs(file, positions)`** (`step-parser`, `subset.ts`): the ids that instances at those positions refer to but the file doesn't define, once each, ascending.
- **The importer** warns once per part with any: `13 references to instances the file doesn't define: #11, #393036, ..., #393179, ...` (at most 10 named, `MAX_DANGLING`), or `1 reference to an instance the file doesn't define: #18`, with the representation as the source. Parts only: elsewhere a dangling reference doesn't change the geometry, and `step2json --check` already reports every one in the file.
- **References beyond the largest id** (`#18446744073709551615` in `bug31292.stp`): the scan leaves them out of its index (so they can't wrap around to a small id), and so out of `danglingRefs`; it warned of nothing, and the decoder warned only when an instance was decoded with a `warnings` list (`step2json --check`, not the importer). Now the scan warns, once per reference, with the instance's id (`reference beyond the largest instance id (2^32 - 1) read as $`), and the decoder no longer does, so `--check` doesn't list it twice. That is a file warning rather than the part's: the scan doesn't know the parts.

**Corpus** (`../corpus_checks/dangling_refs.ts`, log `dangling_refs.log`, 16 s): 53 parts of 3264 in 4 files of 517 with dangling references, and 1 reference beyond the largest id. These are exactly the files and parts where OCCT's message reflected a real problem, the counts agreeing with OCCT's (`bug32314_corrupted.stp` 12 parts, `#392938` with 13, OCCT's `Fails Count : 13`; `bug26451_Test_STEP.stp` 40 parts, all `#0`; `bug33665.step` 1, `#18`; `bug31292.stp` the file warning, on `#69` in OCCT's part `#62`), and none in the three files where OCCT's message comes from the header. Two committed logs changed: `parser_corpus.log` has the new scan warning (one line), and `import_corpus.log` a payload with diagnostics (`bug31292.stp #62`: the subset copies `#69` verbatim, so its parse warns too). `import_corpus.log` also had stale counts from phase 2 (666 materials and 114 parts with per-face materials, now 687 and 118): the same on the commit before this detour, so they come from phase 3's importer changes (steps 5 and 6), not this one; refreshed.

**Tests** (3 new or changed, 167 in the repo): `danglingRefs` (repeats and order, a clean closure, none); the importer on three parts (12 dangling, 10 named and `...`; one, singular, beside a reference beyond the largest id with the scan's warning on its instance; a sound part, nothing); the parser test now expects the scan's warning, with the instance id, and none from the decoder; `stepconv`'s noisy-file test 26 warnings, among them the 13 references.

**Mutation check:** 12 deliberate bugs (the `< 0` test, order, repeats, the 10 limit, the `...`, the singular, no warning, the root alone instead of the closure, no source, the scan's warning dropped or without the id, the decoder warning again): all caught.

## Not planned

- **Exporting from other sources:** the exporters take any scene, but only the STEP importer exists; other formats come with their importers ("Future input formats" in `architecture.md`).
