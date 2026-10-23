# CLAUDE.md

Notes for working on cad-io-js: how work is done here, the history of phases 0–4 and the decisions behind them, the lessons learned, and detailed notes for future work. [`README.md`](README.md) is the user and developer documentation (building, the tools, the architecture, the APIs, the corpus, the tests, the roadmap and backlog); this file doesn't repeat it. The full record of each step (every measurement, test list and mutation check) is in git history: `docs/phase*_progress.md`, `docs/architecture.md` and `docs/initial_analysis.md` up to commit `614a0cd`, and the phase 0 spike's code in `phase0_tessellation_spike/` at tag `V0.1.0`.

## Working here

### The repository

| Path | What |
|---|---|
| `packages/*` | the 13 workspace packages (README, "Packages and their APIs") |
| `packages/*/test/` | `node:test` tests, run by `npm test` from the root |
| `packages/tess-occt/` | `native/occt_tess.cpp`, `build-occt.sh` (OCCT's libraries into `build/occt-Os/`), `build.sh` (links `dist/`), `occt_overlay/` (the unused `VBernstein` patch) |
| `packages/tess-truck/` | `native/` (the Rust crate, `src/lib.rs`), `build.sh` (`dist/tess_truck.wasm`, cargo target in `build/`) |
| `packages/step-schemas/dict/` | the generated dictionaries, committed; `gen/` the EXPRESS parser and generator |
| `corpus_checks/` | 25 corpus checks with committed logs, `corpus.ts` (the list and paths), `make_subsets.ts`; its README lists them |
| `test_corpus/` | `files.txt` (517 files), `third_party/pull.sh` (fetches them, ignored), `subsets/` (phase 0's subsets, ignored) |
| `third_party/` | `pull.sh` fetches OCCT, stepcode, truck, the MBx-IF recommended practices and the JT specifications (`jt/`), all ignored |
| `env.sh` | `source env.sh`: checks and sets up the toolchain |
| `scripts/md2pdf.sh` | Markdown to PDF (the tutorial) |
| `step_tutorial.md` | a tutorial on STEP in practice (edited separately) |

### Commands

- `npm test`; `npm run typecheck` (`tsc --noEmit`). **Never `npx tsc -b` at the root**: it writes a `.js` beside every `.ts` (100 files, plus `tsconfig.tsbuildinfo`).
- A single package: `node --test packages/<p>/test/*.test.ts`. Not `node --test <directory>`: that fails whatever the code, so a mutation check run that way reports every mutation caught.
- Corpus checks: `node --max-old-space-size=8192 corpus_checks/<check>.ts test_corpus/files.txt 1000` (the list, then the maximum file size in MB; the logs were made with 1000).
- Rebuilding the backends: `packages/tess-occt/build-occt.sh` (12 minutes) then `build.sh` (seconds); `packages/tess-truck/build.sh`. A backend's `info.version` carries its module's hash, so caches see each build.

### Code conventions

- **Line length and indentation** (the user, 2026-10-23): code lines at most 120 characters, comments word-wrapped to fit, in every language (TypeScript, JavaScript, bash, Rust, C++, Python, TOML); a long line is folded at commas and brackets (or before `&&`, `||`, `?`, `+`, `.`) with a 2-space continuation indent, and a long string is split into literals joined by `+`. Markdown is the opposite: each paragraph (and list item) is one long line, never folded. Indentation is 2 spaces in TypeScript, JavaScript and bash (4 in Rust, as is its convention), never hard tabs. Data inside template literals (STEP fixtures in tests) is left as it is.
- TypeScript run directly by Node 24's type stripping: erasable syntax only (no enums, namespaces, parameter properties), imports with `.ts` extensions, `node:` built-ins. No build step yet.
- No runtime dependencies in the core packages. Pinned exact versions where there are dependencies.
- File-level comments say what a module is and cite where its design was decided; comments explain why, not what. Match the surrounding density and idiom.
- Problems in input are diagnostics (`{severity, message, source}`), never throws; throws are for caller bugs.
- Large data: typed arrays, output in chunks (generators of strings or byte arrays) with backpressure; nothing may need one string near V8's limit (2^29 − 24 characters).
- Deterministic output: the same input gives the same bytes (uuids, zip dates, ordering).
- Lengths in the scene are millimetres; matrices column-major `Float64Array`; mesh positions `Float32Array` minus the part's origin.

### How the user wants work done

These are the user's standing instructions; follow them.

- **Decisions go to the user, one at a time**, each with the alternatives and their trade-offs; close calls are deferred to the user, not made silently, and when two options are close, both are presented without marking one recommended in the docs. Record the decision and its alternatives in the repository.
- **Commit only when the user says so.** Commit messages end with the attribution line the session gives.
- **Verify before claiming.** Run the test, the check or the measurement; say what wasn't checked. Don't claim "verified" for something no test covers: instrument the code and count calls if in doubt, and run controls to tell real defects from numeric noise.
- **Check against OCCT** for anything geometric or semantic (`occt-import-js`'s prebuilt module in `test_corpus/third_party/occt-import-js/dist`, OCCT's source in `third_party/OCCT`). Where we differ, decide by the standard and the evidence (the corpus has the same models exported by many CAD systems: `trj*_s1-*`, `*as1-*`, the `k1` keys), record the divergence, and ask the user when it's a judgement call.
- **Mutation checks after each step:** a script plants deliberate bugs one at a time (checking first that the unmutated tests pass), and every survivor is either closed with a test or explained (equivalent mutants). Corpus checks get planted bugs too, to show they can fail.
- **Record findings in the repository** (this file and the README now), not only in chat.
- **No upstream reports to any project** (OCCT, truck, glTF-Transform, lib3mf, …) and no forks: workarounds go in our own wrappers, documented here (the user, 2026-10-19).
- **Fixes for imperfect input go into the in-memory scene and meshes** (the importer, `tessellateScene`), so every consumer gets them, not into an exporter; format-specific encoding stays in exporters (the user, 2026-10-22). The library is meant for loading CAD data into memory and recovering names, orientations, hierarchy and transforms as well as possible, not only for converting files. Each fix gets a diagnostic and an opt-out.
- **Ask before deleting** anything you didn't just create; prefer moving to the scratchpad.
- **Don't search the whole disk** (`find /`).
- **Benchmarks only on AC power with low power mode off** (`pmset -g batt`, `pmset -g | grep lowpowermode`) and the CPU otherwise idle; record the power state with timings; compare A and B only when run back to back. Low power mode about halves the speed. After mutation runs with hanging fake backends, look for stray `node --test` processes (one spun a core for 33 hours and skewed phase 3's timings by 1–3%).
- Long corpus runs print progress on standard error and run in the background. Don't edit a script while it runs; run a copy. Edit scripts that assert on several replacements write nothing if one fails: check the result.
- The shell is zsh: an unquoted `$VAR` holding several words isn't split (use `bash -c` or spell the arguments out), and `echo ====` is an error (`=cmd` expansion; quote it).
- To investigate OCCT, copy `occt_tess.cpp` to the scratchpad, add probes switched by environment variables (passed through `Module.ENV` in `preRun`), and link against `packages/tess-occt/build/occt-Os` (compile about 1 s, link 7 s).

## History

| When | What | Commits |
|---|---|---|
| 2026-10-16/17 | Phase 0: the feasibility spike | `b5a1794` (with the schema dictionaries and the parser) |
| 2026-10-17 | Phase 1: the parser, writer, raw JSON, binding, extraction, `step2json`; the repository reorganized and renamed from `step_js` (`cea123e`) | `b5a1794` … `efcd030` |
| 2026-10-17 | Phase 2: the scene model, subsets, the STEP importer, the OCCT backend, end-to-end checks | `d467c0d`, `e2221d1` |
| 2026-10-17 – 20 | Phase 3: workers, truck, caching, OCCT loose ends, wireframe curves, slow faces | `1183e04` … `5a8813d` |
| 2026-10-20 – 23 | Phase 4: the export view, three.js, `stepconv`, dangling references, glTF, 3MF, `stepconv` corpus checks | `6fb5786` … `18a91eb` |
| 2026-10-23 | Release `V0.1.0` (tag on `18a91eb`); the spike removed from the tree (`614a0cd`); `docs/` consolidated into this file and the README | |

### Phase 0: the feasibility spike

The question: can a STEP file be cut into per-part subsets (the closure of one shape representation, original `#` ids) and each tessellated alone by a WebAssembly backend that reports which `ADVANCED_FACE` each triangle came from? Four backends tried on 188 parts (76 from NIST and gkv311 files, 112 from the bicycle):

| | `occt-import-js` (OCCT 7.x) | our OCCT 8.1 build | truck | monstertruck |
|---|---|---|---|---|
| Bare subset | no (0/76) | yes, product mode off (188/188, identical to wrapped) | 69/76, 112/112 | 71/76, 111/112 |
| Face ids | no (order heuristic, 7781/7825) | yes, transfer bindings (13,504/13,504) | yes (mirrored `cfs_faces` order) | yes |
| WASM brotli | 2.3 MB | 2.18 MB (1.71 with the table patch) | 264 kB | 371 kB |
| NIST+gkv311 / bicycle | 9.75 s / 18.0 s | 6.2 s / 16.7 s | 4.3 s / 11.8 s | 35.5 s / 9.5 s |
| Area within 1% of OCCT 8.1 | wrong on 3 bicycle parts | reference | 112 | 126 |
| Problems | | none | 6 panics, 1 hang | 5 panics, a timeout, wrong-side trims |

The outcome: the per-part interface was frozen (faces may repeat an id or have none; the payload is the bare closure; units are file units; the host owns recycling and the watchdog; edges come with kinds and dihedral angles), our OCCT build became the primary backend, truck an optional one. Subsets are also much faster than whole files (single-part PMI files: 10 s whole against 0.5 s subset) and more robust (`nist_stc_07` fails whole, every subset succeeds). The spike's JS indexer ran at 250–290 MB/s but held 480–700 MiB of objects; hence the typed-array index. How the subsets were cut, and the gaps in that method (no per-part comparison with the whole file, placement and styles untested, some representation types skipped), was its own document; the production subsets (`step-parser`'s `buildSubset`) reproduce the spike's entity for entity.

To run the spike again: `git worktree add ../spike V0.1.0`, symlink this tree's `third_party` and `test_corpus` into it, clone monstertruck at `d2ad1ed7aa` into its `third_party/monstertruck` for `mtruck_spike`, and follow `phase0_tessellation_spike/README.md` there (`git show V0.1.0:phase0_tessellation_spike/README.md`), whose commands use the old names (`occt_variant_build.sh`, `occt-build-Os/`).

### Phase 1: the parser (steps 1–7)

1. **Schema generator** (`step-schemas`): an EXPRESS lexer and recursive-descent parser of the declaration subset (about 500 lines; parses AP203, AP203e2, AP214e3, AP242, also AP209, AP210e3 and IFC4) and a generator of committed JSON dictionaries with attribute slots in Part 21 order. A crude tokenizer over the corpus matched 99.93% of 4.82 M instances' attribute counts; every mismatch was the file's or another edition's.
2. **Layer 1** (`scan.ts`, `decode.ts`, `strings.ts`, `file.ts`, `input.ts`, about 1,100 lines): 4.93 M instances, all decoded but 3 in two deliberately broken files; pass 1 211–249 MB/s, pass 2 136–145 MB/s; the index about 20 bytes per instance plus 4 per reference (7 MB for the bicycle).
3. **The writer** (`write.ts`, about 250 lines): the corpus round-trips (parse, write, parse) with 0 differences in 4,925,008 instances, every second write byte-identical; about 65–70 MB/s, a quarter of it in `String(x)`.
4. **Raw JSON** and `lexical-json`: A ≡ B ≡ C (parse, JSON, load, Part 21, parse) on the whole corpus; the list kinds (`reals`, `ints`, `refs`, typed arrays from 16 elements) cut decoded memory by a third at the same speed.
5. **Layer 2** (`bind.ts`, about 440 lines): 99.56% of instances bind with names; the rest are AP209/AP227 entities without a dictionary.
6. **Layer 3** (`extract/`, about 1,330 lines): products, occurrences (2,576 NAUO and 23 mapped-item occurrences, all placed), units, styles, layers, validation properties. Placements against OCCT's assembly reader: every B-rep vertex found in 495 of 512 files, the rest explained.
7. **`step2json`**: raw, NDJSON, semantic; on the largest file 1.2 s raw, 0.36 s semantic.

### Phase 2: the scene model and the tessellator interface

`cad-scene` (components placed by occurrences rather than a stored tree, so a subassembly is stored once; parts once; millimetres), the subset builder (4,549 subsets of the corpus, every one parsing cleanly and equal to its source), `step-import` (all 517 files import into valid scenes: 3,279 parts, 5,051 placed), `tessellateScene`, and the OCCT backend brought forward from phase 3. The end-to-end check against `occt-import-js` (`scene_occt.ts`): 99.1% of sampled vertices on OCCT's surfaces, 97.8% of sampled triangle colours equal; it found three importer bugs (below).

### Phase 3: the backends

1. **`tess-workers`**: the pool, timeout, recycling, both environments; tested with a fake backend that hangs, traps, leaks and exits.
2. **`tess-truck`**: the production Rust wrapper over truck, plain C ABI, a panic hook, the shells built by the wrapper.
3. **truck against OCCT** (`truck_occt.ts`, every part of 515 files): workarounds 4–9 found; 82.6% of parts complete and on OCCT's geometry. 3b. **Face orientation and B-spline clamping** (workarounds 10–12): 83.5%.
4. **`tess-cache`**: keys, stores, failures cached, other versions deleted.
5. **OCCT loose ends**: the 151 parts without meshes classified (135 curves only, 4 drawings, 11 annotations, 1 broken); annotation-only representations not parts; geometric sets' surfaces as faces; OCCT 8's natural bounds turned off for geometrically bounded surfaces; recycling tuned on the heap (256 MiB).
6. **Wireframe curves and points** in the brep result (OCCT only); 2D drawings skipped.
7. **OCCT's slow faces** explained (a ShapeFix mis-split; faces with thousands of holes); no code change.

### Phase 4: exporters and `stepconv`

1. **`exportView`** (looks, groups, transforms); 2. **three.js JSON**; 3. **`stepconv`**; 3a. **dangling references** reported by the importer; 4. **glTF/GLB** with glTF-Transform; 5. **3MF** with fflate, plus the in-memory fixes (names, inside-out shells, degenerate triangles); 6. **every corpus file through `stepconv`** in all four formats with each format's validator (0 problems; three.js 929 MB, GLB 411 MB, 3MF 190 MB; about 200 s each, nearly all tessellation). Every exporter's corpus check reads its output back with the format's own tools and compares every placed part's transform, triangles and colours with the view: 0 problems in all.

## Decisions

Made by the user unless marked. The alternatives considered are in the history's documents.

**Scope and structure**

- TypeScript compiled to plain ESM; browsers and Node from the start; Apache-2.0 except the OCCT backend, which keeps OCCT's LGPL isolated in `tess-occt`; AP242 XML (`.stpx`) out of scope.
- The project is cad-io-js (renamed from step_js, 2026-10-17), since JT and IGES are planned; STEP packages keep their names.
- Raw JSON favours clarity and extensibility over size; lexical numbers (2026-10-17), not context-typed ones (context decides only 98.6% of the corpus's numbers, and loading would need the schema).
- The scene's unit is the millimetre (2026-10-17; first metres); a part is one shape representation with geometry; positions become `Float32` in the backend after subtracting a per-part origin, in double precision; the importer is its own package, `step-import`.
- Phase 2's checks used our OCCT build, brought forward. The tessellator interface stays per part: a "load once, tessellate many" session API was rejected (2026-10-17).
- The worker host is its own package, `tess-workers`, with conditional exports per environment.
- Caching in phase 3, with a maximum size, 0 disabling it; failures (timeouts included) cached; only the same backend's other versions deleted.
- Wireframe curves and points in the brep result, OCCT only; 2D drawings skipped (2026-10-19).
- OCCT build: `-Os` without the `VBernstein` patch (2026-10-17).
- glTF via glTF-Transform; edges and curves each behind an option, both off by default; 3MF meshes that aren't manifold left out with a warning, or `surface` objects by option; `stepconv`'s default backend OCCT (2026-10-20).
- three.js faces single-sided by default (2026-10-20, changed from double).
- `stepconv`: the angular deflection in degrees (default 28.6, exactly 0.5 rad); exit 0 when parts fail, `--strict` exit 3 with the output written; OCCT's messages kept per part as warnings (at most 10, 1000 characters), printed nowhere; no default cache directory; workers cores − 1, timeout 120 s (2026-10-20).
- glTF hidden instances left out by default, `KHR_node_visibility` by option; edges, curves and points as child nodes with their own meshes; `--gltf-no-*`, `--gltf-faces-only`, `--gltf-unlit-lines`, `--gltf-embed` (2026-10-21).
- 3MF: `basematerials` by default, `colorgroup` by option, the Materials extension not required; a build item per placed part by default, the assembly as components by option; hidden instances left out by default (2026-10-21).
- The step 6 corpus check runs `main` in process for every file and spawns the bin for a sample, with the defaults (2026-10-22).

**What the importer and the meshes do with real files**

- References beyond 2^32 − 1 read as `$` with a warning, as OCCT does (2026-10-17).
- Alibre's swapped placements: a writer-specific exception (items kept as written when `originating_system` contains 'Alibre'); everyone else gets OCCT's rule (2026-10-17).
- Placements among a representation's items that nothing uses are coordinate systems, not transforms: not applied, unlike OCCT (2026-10-17).
- Faces show a boundary colour (`SURFACE_STYLE_BOUNDARY`) when nothing more specific colours them; the most specific style wins over a representation's plain style (2026-10-17).
- truck's tolerance is the linear deflection, the angle ignored; small workarounds in our wrapper, no fork (2026-10-17); shells oriented as OCCT does, by volume sign (2026-10-18); faces meshed against all their loops reversed, unclamped B-splines clamped, not OCCT's neighbour-based healing (2026-10-18; a majority rule tried and reverted).
- OCCT 8's natural-bound fix off for geometrically bounded surfaces only (choice confirmed 2026-10-19).
- ShapeFix's split at a seam (bicycle #23723) left as is; Delabella for perforated plates put off (2026-10-20).
- The importer warns of dangling references per part (2026-10-21).
- Names: generic part names (blank, `NONE`, `#digits`) take the first placing product's; blank product names give way to the part number (2026-10-22).
- Closed shells that are inside out and enclosed by nothing are turned over in `tessellateScene`; triangles with two corners at one position dropped there; vertices not merged in stored meshes (2026-10-22).

**Choices made without the user, for review** (each easy to change): the tessellation defaults (`maxMemoryBytes` 256 MiB, cache sizes 256 MiB memory and IndexedDB, 1 GiB files); caching as a wrapper, not a `tessellateScene` option; a worker's exit not cached, out-of-memory traps cached; three.js `MeshStandardMaterial` (roughness 1, metalness 0), black edges, grey (0.8) default colour, shared and free edges written, 4-pixel points; glTF metallic 0 and roughness 1, 16-bit indices up to 65,535 vertices, a node per placed part; 3MF exact welding, an object per look, shortest `float32` text, part numbers (the object the first placing component's, the item its instance path), deflate level 6.

## Lessons learned

### STEP files in the wild

- **Lexical:** a lone `'` ends a string only if followed by `,` or `)` (`bug25171.stp`'s `'l'bracket-assembly'`; strict parsing lost 2,669 instances); OCCT's escape leniencies (`\X2\` in 3-digit groups, unclosed runs, stray `\X0\`, `\N\`, `\T\`; OCCT's test `bugs/step/bug28454_2` has 15 cases, its printed comment for case 13 a typo); unknown escapes keep their backslash; raw non-ASCII decodes as UTF-8 when valid, else ISO 8859-1; an empty parameter is `$`; a reference beyond 2^32 − 1 is `$` (`bug31292.stp`'s `#18446744073709551615` had wrapped to `#0`). `bug32314_corrupted.stp` has an unbalanced quote; resynchronize at `\n#<digits>=`.
- **Schemas:** files mix entities from other schemas and editions (AP203e1 files with presentation entities, AP214 files with AP242 tessellation); falling back to AP242 resolved 33 of 47 unknown names. Writers put values in derived slots (`NAMED_UNIT(#568)` beside `CONVERSION_BASED_UNIT`, 1,357 in AP214 files) and `*` in explicit ones; complex instances list partials out of alphabetical order (125); `TRIMMED_CURVE` trims as bare reals (10,648); reals in INTEGER slots (1,435, `INTEGER_REPRESENTATION_ITEM`); `$` in mandatory attributes is common (7,775). Bind by position with a diagnostic; never fail.
- **The AP242 dictionary** (stepcode's, WG12 N11521) declares 2,407 entities, though its header claims 2,404. AP214 and AP242 differ mostly in kinematics; for geometry, topology, products, units and presentation AP242 is a near-superset.
- **Placements:** the PDM usage guide has `rep_1` the component's representation and `transform_item_1` in it; 692 relationships in 22 files have the representations swapped (invert, as OCCT), 43 in 5 files the items (swap back, as OCCT), except Alibre (`trj4_s1-ai-214.stp`), whose double swap only assembles read as written (OCCT places its parts at the identity). Some NAUOs are placed by a `MAPPED_ITEM` in their own `SHAPE_DEFINITION_REPRESENTATION` (3 files); `2.stp` maps products into others with no NAUO (made occurrences, as OCCT's XCAF does); `bug25167.stp` has `relating_product_definition` pointing at a `PRODUCT_DEFINITION_SHAPE`. OCCT's transform formula is the conjugate of the definition (`M1⁻¹ · M2` against `M2 · M1⁻¹`); they agree when one frame is the identity, which is every corpus assembly but `OCC22238_test.stp`. A left-handed y axis (`x × z`) passes every relative transform test; only an absolute check of one placement catches it.
- **Units:** representations of one file can use different units (`trj7_k1-id-214`: cm and inch). Area and volume units declared as length units (`trj2_as1-pe-203.stp`'s 'INCH' area unit from millimetres) are the length squared or cubed (the literal reading put its volume off by 1,550×). Colour components above 1 (255,255,255) are divided by the largest, as OCCT does.
- **Styles:** a part's material only when every face resolves to one colour, else per face (a single red face had turned a whole part red); faces take surface colours only, never curve colours; `PRESENTATION_STYLE_BY_CONTEXT` styles apply only in their view; Unigraphics styles solids only through `SURFACE_STYLE_BOUNDARY` (shown on faces, as OCCT-based viewers do); `bug31670_russian.stp` styles a representation and its faces plainly in different colours (the face wins). Styles on `CURVE_BOUNDED_SURFACE`s or `GEOMETRIC_SET`s colour faces too.
- **Representations without meshes:** 135 hold only curves and points (wireframes; the 62 "geometrically bounded surface" representations OCCT gave no shape were wireframes all along), 4 are 2D drawings, 11 only annotations (`TEXT_LITERAL`, callouts), 1 broken. Bare `LINE`s as set elements are unbounded and can't be discretized (two OCCT bug files), left as warnings.
- **Names:** writers name representations `NONE` or after their ids (`#609`); 134 of 136 such parts in the corpus take their product's name; `SOLID` and `SHELL` are real names in some files, so not generic.
- **Orientation:** three 1998 ProSTEP round 8 exports of the BV1 block (debis CATIA V4, Mercedes SYRKO, Theorem CADDS5) reverse their voids twice (round 9 fixed it). 13 meshes in the corpus are closed shells facing inward with nothing enclosing them: 9 surface models (the K1 key in eight `trj*_k1*` files, `bug28366_fuselage.stp`; normals follow the winding) and 4 tessellated parts (NIST FTC 08 ×3, `bug33638.stp`; normals point out). Real voids (18 files with `BREP_WITH_VOIDS`; `bug24055_8MTF-75LS05.step` has 32) are pieces inside exactly one other with negative volume. `bug29979_firetherm_12.step` part 19 has two positive pieces inside its body: overlapping bodies or wrongly oriented voids, undecidable.
- **Open meshes are open shells:** with exact welding, 1,940 of the 1,950 open OCCT meshes have free B-rep edges in the file (`bug26451_Test_STEP.stp` alone 1,756); exact `float32` welding suffices, since OCCT gives a shared edge's nodes the same coordinates on both faces, and tolerances make things worse.
- **Validation properties** can be wrong in the file: zero volumes in the 'hc' files; `sp7_08_nx-242.stp`'s part values contradict its shape-aspect values by (1/0.0254)³.
- **The corpus's oddities worth knowing:** `bug25013_25013faces.stp` duplicates two instances; `bug31292.stp` is OCCT's broken-references file; `bug26451_Test_STEP.stp` has `#0` references and syntax errors; external-reference assemblies (`cax_stepLib`) have no geometry; 25 files have nothing to draw.

### OCCT

- **Build:** `-UOCC_CONVERT_SIGNALS` or the full link is invalid WebAssembly (V8 `br_table: label arity inconsistent` in `ShapeUpgrade_ShapeDivide::Perform`: LLVM's `setjmp`/`longjmp` lowering, from the `setjmp` in every `OCC_CATCH_SIGNALS`; the object validates alone, so a wasm-ld bug); set `CMAKE_CXX_FLAGS_RELEASE`, or OCCT appends `-O3` after your flags; `-O2`/`-O3` are within ±3% of `-Os` and 8–10% larger, LTO larger with no gain, `wasm-opt -Oz` −0.8%. Code 1,169 kB brotli, data 973 kB (mostly TKernel's CJK code-page tables, 103 kB brotli, and `AdvApp2Var` tables); `RWStepAP214` dispatch 730 kB raw.
- **Bare subsets** need `read.step.product.mode` off: `STEPControl_Reader::NbRootsForTransfer` takes an unshared `SHAPE_REPRESENTATION` as a root only then (`occt-import-js` uses the default, on). Wrapped + off works too.
- **Units:** compute the root's length unit (`STEPConstruct_UnitContext::ComputeFactors`) and pass it to `SetSystemLengthUnit`, so output is in file units with no rescaling.
- **Face ids:** `TransferBRep::ShapeResult(TP, entity)` for every `StepShape_FaceSurface` gives the faces after shape fixing (ShapeFix splits faces: bicycle #2016, #2022; 314 faces for 312). Geometric sets' surfaces get ids the same way (a face entity's id wins). Edge ids likewise from `StepShape_EdgeCurve`; curve ids from the set's element, a `COMPOSITE_CURVE` before its segments' curves.
- **Edges:** `TopExp::MapShapesAndUniqueAncestors(shape, EDGE, FACE)`, each edge's `Poly_PolygonOnTriangulation` on its first face (so points are mesh vertices), else its `Polygon3D`, else its vertex; OCCT's stored continuity isn't computed on import, so dihedral angles come from the faces' mesh normals. Unmapped edges are OCCT's own (765 pole edges, 345 seams added to periodic faces). Dihedral angles are bimodal (most under 1° or over 30°).
- **Messages:** OCCT prints through Emscripten's `print` (`console.log`), so `stepconv -o -` got them in its output; they're now collected per call. In the corpus: only "Unresolved Reference" (some triggered by the header alone, in three files whose references all resolve) and "Incorrect Syntax" counts.
- **OCCT 8.1 against 7.6.1** (`occt-import-js`): 8.1's `ShapeFix_Face` adds natural bounds to a lone wire on a doubly closed surface, making it a hole; right for `ADVANCED_FACE`s (`bug28414_bug_toroidal_surface.stp`, `bug29564.stp`, whose OCCT tests expect 8.1's areas) but wrong for curve-bounded spheres and tori in geometric sets (`trj4_k1_geo-pe-203.stp`: an Onshape export confirmed the small region, 0.00 mm centroid match, 46 other faces within 0.34%). `occt-import-js` is itself wrong on some parts (bicycle #1170 keeps a sphere's small cap) and drops faces' fill colours in `2.stp`.
- **ShapeFix at a seam:** a hole whose vertices lie on a closed B-spline's seam (bicycle #23723, a tube joining another) projects open by one period; `FixMissingSeam` and `ShapeFix_ComposeShell` then make an overlapping face and a zero-area one, costing 7.4 s of 8.2 s at 0.05 mm. No ShapeFix mode helps. 4 such faces in the corpus.
- **Slow parts:** by size at an absolute deflection (`bug28366_fuselage.stp` #368 and `as1_motor.step` #6322, about 26 s each at 0.1 mm: 32 m tori, millions of triangles), or faces with thousands of holes (`bug24024_slow_import.stp`
  #76247: two plates with 2,232 holes, 9.5 s each; Delabella 3.1 s against Watson's 19.3 s, but Delabella leaves 57
  faces untriangulated over the corpus against 5). Not a mesher regression, as phase 0 thought.
- **Memory:** linear memory never shrinks, but freed memory is reused: over 1,171 parts the heap grew only five times, each to the largest part so far (up to 1,118 MiB). Hence recycling above 256 MiB rather than per part (a restart costs about 250 ms).
- **`instantiateWasm`:** this Emscripten build ignores `Module.wasmBinary`; hand it the compiled module through the `instantiateWasm` hook (needed to hash the module for the cache key, about 3 ms).
- **The `VBernstein` patch** (`occt_overlay/`): computes the 840 kB Bernstein table (−468 kB brotli); reached only by `AppCont_LeastSquare` (`Approx_FitAndDivide`, ProjLib projections when p-curves are missing), never by the corpus. Its tests show divergence on ill-conditioned fits equal to ±4-ulp noise in the table. If adopted: check the upstream header's hash in the build. Upstream throws `MMatrix: classe > 24` though the table goes to 26.

### truck

- **The workarounds** in `packages/tess-truck/native/src/lib.rs` (truck unchanged): (1) shells built by the wrapper, so ids survive faces and edges that fail to convert; (2) `AXIS2_PLACEMENT_3D` without `ref_direction` on an ±x axis gets (0, 1, 0) per ISO 10303-42 (truck's (1, 0, 0) made the frame NaN: phase 0's "tolerance" panics); (3) shells reversed by volume sign, as OCCT's `ShapeFix_Solid`; (4) `SURFACE_CURVE`s by their 3D curve (11,986 in the corpus); (5) edges and faces that evaluate to NaN left out (truck subdivides NaN curves forever: 400 MB/s, a trap at 4 GiB); (6) instances truck's parser can't read skipped one at a time (ruststep fails the whole file on `()`); (7) negative torus radii as absolute values; (8) cone semi-angles converted from the context's angle unit; (9) a shell reversed only if its mesh is consistently oriented; (10) unclamped B-splines clamped (exact knot insertion; 384 edge curves, 78 surfaces); (11) a face meshed against all its loops reversed; (12) the volume sign trusted only if the same from every point of the bounding box and at least 1% of the sum of the triangles' contributions.
- **What's left:** cones (38% of cone faces not right, e.g. 59° countersinks near the apex), surfaces of revolution (30% short), rational B-splines (10%); 10 timeouts (NURBS evaluation); 195 empty parts (geometric sets, triangulated faces, unsupported surfaces). 83.5% of parts complete and on OCCT's geometry.
- Comparing orientation or area with OCCT measures OCCT's healing as much as truck: compare geometry (sampled vertices on the other's faces) and the file's own loops instead. Per-face area flags small fillets for their chords.
- **Size and speed:** opt-level 3 (326 kB brotli); `s` and `z` save 27–40 kB at 1.5–3.5× the time. truck is 2.4–2.7× faster than our OCCT on phase 0's subsets, with more triangles (no angular tolerance). Five wasm-bindgen imports remain from chrono and getrandom, stubbed; a test pins the import list.
- **monstertruck** (a fork, 194 commits ahead, 182 behind): fixes 29 parts truck gets wrong, regresses 15 (the wrong side of single-loop periodic faces), 9× the triangles; not adopted.

### JavaScript, Node and the libraries

- V8's string limit (2^29 − 24) is reached by real models: three.js JSON of `as1_motor.step` is 294 M characters; write in chunks.
- Node's worker flags: passing `execArgv` explicitly makes Node reject process-wide flags (`--max-old-space-size`); let workers inherit unless `--input-type` is set (`node -e`), which breaks a worker's file entry.
- A Node `Buffer` from `readFileSync` may be a view into a pooled `ArrayBuffer`: libraries that read `.buffer` (the glTF validator's external resources) see garbage; pass a copy.
- glTF-Transform's writer drops a node's TRS components within 1e-5 of the default (`bug29715_slow.stp`: 3.4 nm off); our exporter writes the JSON's TRS back exactly and packs the GLB itself. An empty buffer is invalid glTF: remove it. The Khronos validator (2.0.0-dev.3.10) doesn't know `KHR_node_visibility`, and keeps one message per issue (70,000 bad indices exhausted memory).
- lib3mf 2.5.0: refuses numeric character references (`&#38;`); ignores a triangle's `p1` without `pid`; reads transforms as `float32`; `IsManifoldAndOriented` passes an inside-out mesh; `ReadFromBuffer` needs a pointer the module doesn't export `malloc` for (use its file system); Embind objects must be `.delete()`d.
- 3MF spec points: `basematerials` colours are display-only, print intent needs the Materials extension's opaque `colorgroup`; an object with triangle properties needs `pid`/`pindex`; component objects mustn't have them; items' `partnumber` is unique per item; metadata names outside the spec's list need a namespace; triangles' indices distinct; a `model` needs 4+ triangles, manifold, outward.
- `String(x)` is the shortest round-trip text for doubles; Part 21 needs a `.` added and `E` without `+`; for `float32`, shortest text needs its own search (`formatFloat32`).

### Testing

- Mutation survivors were mostly weak fixtures: data where the first group was also the largest, one component where first and last differ, no oriented shells, no seams, frames whose errors cancel. Read a survivor as a missing case.
- A corpus check that takes its expectations from the code under test (the exporter's `srgbToLinear`, its root transform) is blind to that code's bugs; write the expectation independently, and prove each check with planted bugs.
- Cross-checks against OCCT need classification, not counts: OCCT's healing, its version, its colour fallbacks and its errors all show up as differences.

## Notes for future work

### The backlog in detail

(The list is in the README; here, what's known about each.)

- **PMI:** graphical PMI is presentation geometry (polylines, tessellated text) in representations the importer now skips as annotations; semantic PMI is tolerances and datums on shape aspects. `rec_pracs_pmi_v41.pdf` and `rec_prac_polyline_pres_v23.pdf` in `third_party/mbx-if-recpractices/`. 2D drawings (`GEOMETRICALLY_BOUNDED_2D_WIREFRAME`, 4 in the corpus such as `trj2_d2-db-214.stp` #1032) need their sheets and placement, so they belong with presentation.
- **User-defined attributes** (`rec_prac_user_def_attributes_v18.pdf`): name/value properties on products, occurrences, shape aspects. **Materials:** AP214 material products (`dm1-pe-214.stp`'s Titanium 6-4), densities. **SHUO:** overrides deeper than one level. **Kinematics:** where AP214 and AP242 differ most.
- **AP242 tessellated geometry** (`rec_prac_3dtess_geo_v11.pdf`): `TRIANGULATED_FACE`, `COMPLEX_TRIANGULATED_SURFACE_SET` as `mesh` parts instead of through OCCT.
- **Per-instance styles:** context-dependent overrides and styled assembly representations are implemented, but no corpus file has them, so only unit tests cover them; no corpus part has more than one look.
- **Per-curve colours:** 81 curves beside solids in 24 parts show the part's colour; would need `curveMaterials` like `faceMaterials`.
- **Named coordinate systems:** unused `AXIS2_PLACEMENT_3D`s among a representation's items ('MCS2' in `bug24383_224013.stp`) to list for a viewer.
- **Large files:** byte offsets are `Uint32Array` (4 GiB); 64-bit costs about 8 bytes per instance. On-demand range reading (`Blob.slice`, `fs.read` at an offset) would bound memory in every mode, with pass 1 chunked and decoding batched; the user wants large files in the browser as far as possible. Streaming raw conversion is lowest priority.
- **Part 21 edition 3:** anchors, references and signatures are skipped with a warning; `@name` and `<uri>` values fail their instance's decode. The raw model has no representation for them yet.
- **Size-relative deflection:** `occt-import-js` offers a bounding-box ratio; per-part deflection from the part's size would bound the 26 s parts.
- **OCCT:** moving the seam away from a hole before ShapeFix (about 100 lines, uncertain reach) or dropping the bad face; Delabella for faces with many holes (83,033 faces have fewer than 10, only two plates over 100); a deep dive into the two algorithms' structure first (the user's request). Size: stub the CJK tables (a source patch: they're quoted includes, beyond the overlay trick), a reader-only controller to drop the writer code (about 150 kB raw).
- **truck:** curves need `TRIMMED_CURVE` and `COMPOSITE_CURVE` in the wrapper; geometric sets' surfaces need new wrapper code; the weld by position alone (instead of position and normal) is untestable on our fixtures.
- **Vertex merging** with equal position and normal would shrink glTF and three.js meshes losslessly; unmeasured.
- **Not tested:** Firefox and Safari (the browser checks ran in headless Chrome 155); a backend module that compiles but fails to instantiate; how a part needing more than OCCT's 2 GB maximum memory fails.

### Future input formats

None is started; the scene (`brep` parts with a payload format, `mesh` parts with levels of detail, `curves` parts, external references) and the tessellator interface (`format: 'step' | 'iges' | 'brep'`) were designed for them.

| Format | Importer | Tessellation | Notes |
|---|---|---|---|
| JT (ISO 14306) | pure JS: binary segments, zlib or LZMA, compressed mesh coding, logical scene graph, properties; a large project | none needed: JT carries meshes at several levels of detail (`mesh` parts) | high value for automotive and aerospace (Teamcenter); OCCT has no reader; "shattered" assemblies need external references |
| IGES | pure JS: fixed 80-column ASCII, numbered types, no schema | OCCT (`TKDEIGES`, `IGESCAFControl`), subsets with renumbered pointers | much IGES is a surface soup (type 144) needing sewing; weak hierarchy (subfigures 308/408, levels); truck has none |
| BREP (`.brep`) | trivial: one part | OCCT (`format: 'brep'`) | no assembly, names, colours or units; spec `OCCT/dox/specification/brep_format.md` |
| OCCT documents (`.xbf`) | an OCCT WASM importer | OCCT, shapes as `brep` payloads | assembly, names, colours, layers |
| FreeCAD (`.FCStd`) | pure JS: unzip, `Document.xml` (tree, placements), `GuiDocument.xml` (colours) | OCCT, each `.brp` as a `brep` payload | the hard part is which objects are the final visible shapes; assemblies differ by version and workbench |

Suggested order: JT, then IGES, then `.FCStd` (with `.brep` and `.xbf` nearly free once `format: 'brep'` exists).

**JT specifications** (in `third_party/jt/`, fetched by `third_party/pull.sh`, with text versions):

- **v10.6** (Rev D, 2026-02-10, 493 pages, plus the PMI property strings list) is the primary reference: file structure, the logical scene graph, levels of detail including TopoMesh, every compression scheme with reference decoder code (Annexes B–D), the XT B-rep (Annex F, hybrid bodies in 10.6), ULP, Smart Topology Table and LWPA segments, wireframe, procedural geometry guidance (Annex M), deprecated B-rep and PMI segments (Annexes K, L).
- **v9.5** (Rev A, 2010, a third-party copy) is required, not optional: v9 and v10 share the scene graph, TopoMesh coder and arithmetic/bit-length codecs, but v10 replaced the compression layer (a third-generation Int32 CDP and a new Int64 CDP against v9's first-generation and Mk. 2 Int32 CDPs and a Float64 CDP; LZMA against zlib 1.1.2), and ISO 14306:2012 is v9.5, so v9 files are common. v9.5 documents the XT segment in 2 pages only and has wire harness support v10 dropped. **v10.0** (Rev B, 2015) is a cross-check.
- **Gaps:** the STEP B-rep segment (type 33) is "not defined in this document"; no v8 specification exists (v9.5 is a new document; v10.6 still documents the v8-era PMI segment for migrated files); real files from current writers are needed to see what matters.
- **Exact geometry** (XT B-rep) is parseable and could become a payload for our tessellators, but a viewer needs only the meshes.
- **License terms** (identical in v9.5, v10.0, v10.6): anyone may write and distribute software that reads JT data and displays or otherwise interprets it, with an appropriate copyright notice; the documents themselves may not be redistributed (hence fetched, not committed). The permission excludes "incorporating, integrating, or combining" JT into another data format: converting JT to glTF most plausibly counts as interpreting, but review it (or ask counsel) before shipping a converter rather than a viewer. Patents: Siemens' "JT Data Format Reference Patent Clarification Notice" grants a royalty-free license to US 8019788 and US 2011/0199382 (and equivalents) for software producing, consuming and interpreting compliant JT 9.5+ files, for techniques the specification discloses.

### Licensing and provenance

*Not legal advice.* OCCT is LGPL-2.1 plus the Open CASCADE exception (which only covers compiled code incorporating material from OCCT's headers). A line-by-line translation of OCCT, including asking an AI to "port this function", is a derivative work and LGPL would apply, with real costs for every application using the library (users must be able to swap in a modified library, which maps awkwardly onto JS bundles). So:

- Treat OCCT as a behavioural reference and a test oracle (running it carries no obligation), never as source to translate. Copying enough of its special cases in the same order starts to look like copying expression, even without matching lines; the risky areas are shape healing, p-curve and tolerance handling, and meshing.
- Have OCCT's behaviour described (the edge cases and why), then write fresh code from that and the specifications; keep a provenance note of the spec, paper or recommended practice behind each module; don't copy OCCT comments or identifiers (EXPRESS entity names are ISO's, not OCCT's); be able to justify every constant independently. Clean-room discipline (one reads, another implements from a spec) for healing or meshing, if the project ever goes there.
- Mirroring the entity model is fine (it is ISO's EXPRESS); NURBS math comes from the literature (Piegl & Tiller).
- Other sources: stepcode BSD-3 (keep notices if code is copied); NIST's STP2X3D and SFA are US public domain (include the NIST notice if redistributed); the MBx-IF practices are free to implement; the ISO EXPRESS schemas' terms for the generated dictionaries are still to confirm (they hold names and structure only, no schema text).
- The OCCT backend links OCCT itself, which is why it lives in its own LGPL package.

### Reference projects and prior art

Reviewed 2026-10-16 (commits in `third_party/README.md`); none is a dependency except OCCT, stepcode and truck.

- **truck** (Rust, Apache-2.0): a full independent pipeline (STEP via ruststep, B-rep, NURBS, meshing with `spade`'s CDT, assemblies); the most relevant permissive reference. No `truck-js` on npm (`truck.js` is unrelated).
- **ruststep** (Apache-2.0): Part 21 parser and `espr`, an EXPRESS-to-Rust generator; "experimental, do not use".
- **web-ifc** (C++ → WASM, MPL-2.0 per file): a fast browser Part 21 parser for IFC and trimmed NURBS; the closest architectural analogue.
- **verb** (MIT): NURBS evaluation and tessellation, no trimmed surfaces. **openNURBS**: licence unclear, no B-rep mesher. **tinyspline** (MIT), **tinynurbs** (BSD-3): NURBS evaluation. **BRL-CAD `step-g`** (LGPL), **SISL/GoTools** (AGPL), **SolveSpace** (GPL): reference only. **cdt2d**, **poly2tri.js**, **earcut**: 2D triangulation.
- **No open-source equivalent of OCCT's `ShapeFix`** was found: healing is where original work, or acceptance of lower robustness, would be needed for a pure-JS tessellator.
- **SFA** (NIST, Tcl) parses through SECOM's closed IFCsvr and tessellates through STP2X3D (OCCT); useful for how a real tool walks product structure.
- Other OCCT WASM packages: `occt-wasm` (npm, declares MIT/Apache despite wrapping LGPL OCCT), `@bitbybit-dev/occt`, `opencascade.js` (last published 2023).
- **Not obtainable:** the CAx-IF round-robin files (members only) and the ISO standards (paywalled); the corpus stands in for the first, the EXPRESS schemas and OCCT's behaviour for the second.

### Open questions

- stepcode's AP242 schema (N11521) is later than edition 1; edition 2 or 3 is unconfirmed.
- The ISO EXPRESS redistribution terms.
- Whether to use the 3MF Production extension (stable UUIDs).
- Whether to ship more dictionaries (AP209, AP214 edition 1).
- How to represent Part 21 edition 3 constant references and anchors.
- FreeCAD's assembly representations across versions and workbenches; JT's combining-formats clause; sample JT files (v9 and v10) and the distribution of versions in real use.
