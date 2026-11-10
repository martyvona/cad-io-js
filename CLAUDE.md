# CLAUDE.md

Notes for working on cad-io-js: how work is done here, the decisions every part depends on, and where the rest is. [`README.md`](README.md) is the user and developer documentation (building, the tools, the architecture, the APIs, the corpus, the tests, the roadmap and backlog); this file doesn't repeat it.

**Topic notes**, read the one for the work at hand:

| File | For work on |
|---|---|
| [`docs/step.md`](docs/step.md) | STEP parsing and import: the importer's rules, AP242 tessellated geometry, the corpus's examples, the STEP backlog; STEP itself and what real files do is in [`docs/step_tutorial.md`](docs/step_tutorial.md) |
| [`docs/backends.md`](docs/backends.md) | tessellation: `tessellateScene`, profiles, timeouts, the cache, faces that fail to mesh, the area oracle, OCCT (build, patches, probing, quirks), truck, BRL-CAD (evaluated, not pursued), SMLib and Solid Core (evaluated) |
| [`docs/scene-formats.md`](docs/scene-formats.md) | the scene model, the exporters (glTF, three.js, 3MF, `stepconv`), the mesh importers, round trips, those libraries' quirks |
| [`docs/viewer.md`](docs/viewer.md) | the viewer: loading, export, rendering, sections, camera and input, picking, the tree and appearance overrides, updates, automation and replay, the browser check, three.js/Vite quirks |
| [`docs/future.md`](docs/future.md) | new input formats (IGES, BREP, FreeCAD, QIF, JT and why it's not a priority), the JT specifications, prior art |
| [`docs/brep-model.md`](docs/brep-model.md) | the B-rep model that replaced STEP subsets: its rules, the buffer layout, the scene and tessellator changes, backends, exporters, phases and decisions |
| [`docs/shape-interrogation.md`](docs/shape-interrogation.md) | geometry on exact curves and surfaces: what our code does (evaluation, inversion, nearest points) and how sound it is, what a rigorous implementation needs, the libraries surveyed (SISL ...) |
| [`docs/licensing.md`](docs/licensing.md) | the licenses, the CLA, and clean-room rules for code that could derive from OCCT or others |

**History:** every decision since 0.1.0 with its alternatives and measurements is in `git show V0.2.0:CLAUDE.md`; each phase's steps and phase 0's backend comparison in `git show V0.1.0:CLAUDE.md`. Look there before redoing a measurement or reopening a decision.

## Working here

### The repository

| Path | What |
|---|---|
| `docs/` | the topic notes above, and `step_tutorial.md` (STEP AP203/214/242 in practice, for users too; built as a PDF with the viewer); new notes go here |
| `packages/*` | the 19 workspace packages (README, "Package APIs"; the viewer, `packages/viewer`, README "Viewer"); tests in each `test/` |
| `packages/cad-brep/` | `src/layout.ts` (the B-rep buffer's format), `include/cad_brep.h` (generated from it by `gen/header.ts`: run it after changing the layout; a test checks it's current) |
| `packages/tess-occt/` | `native/occt_tess.cpp`; `build-occt.sh` (OCCT into `build/occt-Os/`, applying `occt_patches/` to `build/occt-src/`); `build.sh` (links `dist/`) |
| `packages/tess-truck/` | `native/` (the Rust crate), `build.sh` (`dist/tess_truck.wasm`) |
| `packages/step-schemas/` | `dict/` the generated dictionaries (committed), `gen/` their generator |
| `corpus_checks/` | the corpus checks with committed logs (its README lists them) |
| `test_corpus/` | `files.txt` (517 files), `third_party/pull.sh` (fetches them), `models/` (the user's Onshape exports), `demo/` (the deployed demo models) |
| `third_party/` | `pull.sh`: OCCT, stepcode, truck, the 3MF specifications, the MBx-IF practices, the JT specifications (all ignored) |
| `workdir/` | ignored: dated deep dives and measurement records; findings worth keeping go in this file, the notes or the README |
| `test/` | repository-wide tests (`ascii.test.ts`) |
| `env.sh` | `source env.sh`: checks and sets up the toolchain |
| `scripts/` | `deploy-viewer.sh` (to GitHub Pages, from a clean, pushed commit), `deploy-demo.sh` (the demo models alone), `demo-catalog.ts` (their `catalog.json`), `md2pdf.sh` (Markdown to PDF with Typst) |

### Commands

- `npm test`; `npm run typecheck` (`tsc --noEmit`). **Never `npx tsc -b` at the root**: it writes a `.js` beside every `.ts`.
- A single package: `node --test packages/<p>/test/*.test.ts`, not `node --test <directory>` (that fails whatever the code, so a mutation run reports every mutant caught).
- Corpus checks: `node --max-old-space-size=8192 corpus_checks/<check>.ts test_corpus/files.txt 1000` (the list, then the maximum file size in MB); `roundtrip_corpus` needs `--max-old-space-size=12000` (about 31 min).
- The viewer's browser check and `cad-viewer start|stop|status|open|shot|replay`: README, "Viewer".
- Rebuilding the backends: `packages/tess-occt/build-occt.sh` (12 minutes) then `build.sh` (seconds); `packages/tess-truck/build.sh`.

### Code conventions

- **Lines and indentation:** code lines at most 120 characters in every language, comments word-wrapped to fit; a long line folds at commas and brackets (or before `&&`, `||`, `?`, `+`, `.`) with a 2-space continuation, a long string splits into literals joined by `+`. Markdown is the opposite: each paragraph and list item one long line. 2-space indentation (4 in Rust), never tabs. Data in template literals (test fixtures) as it is.
- **ASCII:** every tracked text file, enforced by `test/ascii.test.ts`; exceptions this file, the corpus checks' `.log` files and binaries. Non-ASCII test data as escapes (not inside `String.raw`). Markdown uses `->`, `x`, `-`, `...`, `+/-`, `^2`.
- TypeScript run directly by Node 24's type stripping: erasable syntax only (no enums, namespaces, parameter properties), `.ts` import extensions, `node:` built-ins. No build step.
- No runtime dependencies in the core packages; exact versions pinned where there are dependencies.
- **Comments:** say what someone working on the code needs to know, above all what they'd get wrong without it (an invariant, a quirk, why the obvious way fails, what depends on this); file-level comments say what a module is. Short. No provenance (who asked, when, which decision or phase) and no history ("was", "now", "no longer"), except where the code still handles the old way. Pointers name a file, never a section; no counts or measurements that drift unless they're why a constant has its value. When changing code, fix the comments it makes untrue, in other files too.
- Problems in input are diagnostics (`{severity, message, source}`), never throws; throws are for caller bugs.
- Large data: typed arrays, output in chunks (generators) with backpressure; nothing may need one string near V8's limit (2^29 − 24 characters; real models reach it).
- Deterministic output: the same input gives the same bytes (uuids, zip dates, ordering).
- **Markdown documents:** `#` the title, `##` top-level sections; diagrams Mermaid `flowchart TD`; math LaTeX. They must render on GitHub and in browsers as they are: PDF-only content in `<!--raw-typst ...-->`, Markdown-only between `<!--typst-begin-exclude-->` and `<!--typst-end-exclude-->` (`scripts/md2pdf.typ`). Identifiers of 30+ characters in table cells broken by hand into code spans of at most 24 characters after underscores, joined by `<br>`.
- The scene: millimetres; matrices column-major `Float64Array`; mesh positions `Float32Array` minus the part's origin.

### How the user wants work done

- **Decisions go to the user, one at a time**, each with the alternatives and their trade-offs; close calls are the user's, and in the docs two close options are presented without marking one recommended. Record the rule and its alternatives briefly in the topic note it belongs to (long records in `workdir/`).
- **Small choices made on the way** (a threshold, a default, a name) are listed in the end-of-task summary in chat for the user to object to, not recorded in this file or the notes, which state only the rule as built. This file and the notes are for Claude.
- **Commit only when the user says so.** Commit messages end with the attribution lines the session gives.
- **Verify before claiming:** run the test, check or measurement and say what wasn't checked; don't call something verified that no test covers (instrument and count if in doubt; run controls to tell defects from noise).
- **Check against OCCT** for anything geometric or semantic (`occt-import-js` in `test_corpus/third_party/occt-import-js/dist`, OCCT's source in `third_party/OCCT`). Where we differ, decide by the standard and the evidence (the corpus has the same models from many CAD systems: `trj*_s1-*`, `*as1-*`, the `k1` keys; `test_corpus/models/` a third opinion), record the divergence, and ask when it's a judgement call.
- **Mutation checks after each step:** plant bugs one at a time (the unmutated tests passing first); close every survivor with a test or explain it (equivalent mutants). Corpus checks get planted bugs too.
- **Record findings in the repository** (this file, the notes, the README), not only in chat.
- **No upstream reports or forks** of any project: workarounds go in our wrappers, understood OCCT bugs in `occt_patches/`.
- **Fixes for imperfect input go into the in-memory scene and meshes** (the importer, `tessellateScene`) so every consumer gets them, never into an exporter; each with a diagnostic and an opt-out. The library is for loading CAD data into memory with names, orientations, hierarchy and transforms recovered as well as possible, not only for converting files.
- **Ask before deleting** anything you didn't just create; prefer moving to the scratchpad. **Don't search the whole disk.**
- **Benchmarks only with low power mode off** and the CPU otherwise idle: check the mode in effect with `pmset -g | grep -i powermode` (`lowpowermode 0`; with High Power Mode, `powermode` 0 automatic, 1 low, 2 high), not the power source; record it with timings; compare A and B only back to back. Low power mode about halves the speed. After mutation runs with hanging fake backends, look for stray `node --test` processes.
- Long corpus runs print progress on standard error and run in the background; don't edit a script while it runs (run a copy). Edit scripts that assert several replacements write nothing if one fails: check the result.
- The shell is zsh: an unquoted `$VAR` of several words isn't split, `echo ====` is an error, an unmatched glob is an error.

## History

| Phase | What | Released |
|---|---|---|
| 0 | the feasibility spike: WebAssembly backends reporting each triangle's face | |
| 1 | the parser, writer, raw JSON, binding, extraction, `step2json` | |
| 2 | the scene model, the STEP importer, the OCCT backend, checks against OCCT | |
| 3 | workers, truck, caching, wireframe curves | |
| 4 | the export view, three.js, glTF, 3MF, `stepconv` | `V0.1.0` (2026-10-23) |
| after 4 | the viewer, the mesh and AP242 tessellated importers, face measures, leaf products as placed parts, exports in the input's frame, AGPL and a CLA | `V0.2.0` (2026-11-01) |

## Decisions

The ones every part depends on; the rest are in the topic notes, and the alternatives behind each in `V0.2.0`'s or `V0.1.0`'s version of this file.

- **Scope:** TypeScript as plain ESM, browsers and Node; AP242 XML (`.stpx`) out of scope; a package per format (`step-import`, `gltf-import`, `export-gltf`, ...); the project is cad-io-js, STEP packages keeping their names. Viewing is one use among several: the scene is to evolve toward geometry processing on loaded B-reps (booleans and other B-rep operations), and conversion is to include B-rep exports (such as STEP), so choices that only suffice for viewing (unsewn faces, approximate geometry) are judged against those uses too.
- **The B-rep model:** each part's exact geometry a parsed, format-neutral buffer built at import (Part 42's parameterizations, radians), replacing STEP subsets; backends, exporters and other kernels read it (`docs/brep-model.md`).
- **License:** AGPL-3.0-only, except `tess-occt` (LGPL-2.1 with the Open CASCADE exception); contributions under a CLA. **Never translate OCCT's source**, it's a reference and an oracle only: `docs/licensing.md`.
- **Units and frames:** the scene is millimetres; a part is one shape representation, its positions `Float32` minus a per-part origin computed in double precision; the viewer's world is Z up. Exports use each format's convention (glTF and three.js metres, Y up; 3MF the source unit, Z up) with no root node of ours.
- **The tessellator interface is per part**; OCCT the primary backend, truck optional; backends take a host's module through `init`.
- **Importers for every format into the scene model**, one viewer path through them; textures not supported (warned of).
- **Extras off by default** in every exporter: exports are mostly for other systems.
- **Meshing profiles** coarse, medium (the default), fine, defined only in `cad-scene`'s `profiles.ts`; the viewer medium on desktops, coarse on phones and tablets.
- **SHA-256 everywhere**, our own implementation where Web Crypto is missing (a page over plain http, not from localhost: the viewer's build on such a server, or another app's page; our dev server's LAN mode is always https).
- **Markdown to PDF with Typst** (pinned and checksummed, with cmarker, mitex and merman; Typst's embedded fonts only); no pandoc, LaTeX or browser.
- **Releases** bump every workspace package (and `tess-truck`'s crate) to the release's version and tag it `V<version>`; the viewer shows it.

## Lessons learned

### Testing

- Mutation survivors are mostly weak fixtures (the first group also the largest, one component, no oriented shells, no seams, errors that cancel): read a survivor as a missing case.
- A check that takes its expectations from the code under test is blind to its bugs: write the expectation independently, and prove each check with planted bugs.
- A check that searches for a case where the code already works, then tests only that, proves nothing. Check against an independent oracle over many points, classify the oracle's own limits rather than loosening the tolerance, and vary conditions (units, scales), not only content.
- Matching with a tolerance must pair nearest first over all candidates, not first come.
- Unit tests in Node don't transfer buffers between threads: what depends on transfer needs the browser check.
- An expectation that encodes a difference without finding its cause can hide the other side's bug.
- Cross-checks against OCCT need classification, not counts: its healing, version, colour fallbacks and errors all show up as differences.

### JavaScript and Node

- Worker flags: passing `execArgv` makes Node reject process-wide flags (`--max-old-space-size`); let workers inherit, except under `--input-type` (`node -e`), which breaks a worker's file entry.
- A `Buffer` from `readFileSync` may view a pooled `ArrayBuffer`: pass a copy to libraries that read `.buffer`.
- What keeps a large object (a file) alive: closures made in one scope share its context, so a small closure kept in the result keeps whatever the scope's other closures use; and a suspended async function keeps its locals in its saved registers, even dead ones, until it ends. Touch the object only in a function that returns before the long work, and check with a heap snapshot (`v8.writeHeapSnapshot`: retainer paths) or a `WeakRef` test, not by reading the code.
