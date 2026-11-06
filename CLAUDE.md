# CLAUDE.md

Notes for working on cad-io-js: how work is done here, the decisions every part depends on, and where the rest is. [`README.md`](README.md) is the user and developer documentation (building, the tools, the architecture, the APIs, the corpus, the tests, the roadmap and backlog); this file doesn't repeat it.

**Topic notes**, read the one for the work at hand:

| File | For work on |
|---|---|
| [`docs/claude/step.md`](docs/claude/step.md) | STEP parsing and import: the importer's rules, AP242 tessellated geometry, the corpus's examples, the STEP backlog (PMI, SHUO, large files); STEP itself, and what real files do in general, is in `step_tutorial.md` |
| [`docs/claude/backends.md`](docs/claude/backends.md) | tessellation: `tessellateScene`, profiles, timeouts, the cache, faces that fail to mesh, OCCT (build, patches, quirks), truck (workarounds) |
| [`docs/claude/scene-formats.md`](docs/claude/scene-formats.md) | the scene model (levels, leaf products, bounds), the exporters (glTF, three.js, 3MF, `stepconv`), the mesh importers, round trips, those libraries' quirks |
| [`docs/claude/viewer.md`](docs/claude/viewer.md) | the viewer: loading, export, rendering, sections, camera and input, picking, the tree and appearance overrides, automation and replay, the browser check, three.js/Vite quirks |
| [`docs/claude/future.md`](docs/claude/future.md) | new input formats (JT, IGES, BREP, FreeCAD), the JT specifications, prior art |

**The full history** is in this file's earlier versions: `git show V0.2.0:CLAUDE.md` (266 KB: every decision since 0.1.0 with its alternatives, measurements and planted-bug counts) and `git show V0.1.0:CLAUDE.md` (each phase's steps, phase 0's backend comparison, the corpus counts behind each lesson). Older: `docs/phase*_progress.md`, `docs/architecture.md`, `docs/initial_analysis.md` up to commit `614a0cd`; the phase 0 spike in `phase0_tessellation_spike/` at `V0.1.0`. Look there before redoing a measurement or reopening a decision. Source comments cite sections by name ("Decisions", "The viewer", "OCCT", "STEP files in the wild", ...): those are `V0.2.0`'s sections; the topic notes summarize them under the same names.

## Working here

### The repository

| Path | What |
|---|---|
| `packages/*` | the 17 workspace packages (README, "Package APIs"; the viewer, `packages/viewer`, README "Viewer") |
| `packages/*/test/` | `node:test` tests, run by `npm test` from the root |
| `packages/tess-occt/` | `native/occt_tess.cpp`, `build-occt.sh` (OCCT's libraries into `build/occt-Os/`), `build.sh` (links `dist/`), `occt_patches/` (our patches to OCCT, applied by `build-occt.sh` to `build/occt-src/`, a worktree of the pinned checkout), `occt_overlay/` (the unused `VBernstein` patch) |
| `packages/tess-truck/` | `native/` (the Rust crate, `src/lib.rs`), `build.sh` (`dist/tess_truck.wasm`, cargo target in `build/`) |
| `packages/step-schemas/dict/` | the generated dictionaries, committed; `gen/` the EXPRESS parser and generator |
| `corpus_checks/` | 27 corpus checks with committed logs, `corpus.ts` (the list and paths), `make_subsets.ts`; its README lists them |
| `test_corpus/` | `files.txt` (517 files), `third_party/pull.sh` (fetches them, ignored), `subsets/` (phase 0's subsets, ignored), `models/` (the user's Onshape exports), `demo/` (the deployed demo models, CC BY-SA 4.0) |
| `third_party/` | `pull.sh` fetches OCCT, stepcode, truck, the MBx-IF recommended practices and the JT specifications (`jt/`), all ignored |
| `docs/claude/` | the topic notes above |
| `workdir/` | git-ignored: deep dives, progress notes and measurement records, dated (`workdir/2026-10-30_bounds/`); findings worth keeping go in this file, the topic notes or the README |
| `test/` | repository-wide tests (`ascii.test.ts`), run by `npm test` with the packages' |
| `env.sh` | `source env.sh`: checks and sets up the toolchain |
| `scripts/deploy-viewer.sh` | the viewer's build to GitHub Pages (`gh-pages`), from a clean, pushed commit |
| `scripts/md2pdf.sh` | Markdown to PDF with Typst (`md2pdf.typ` the style, `fetch-typst.sh` the pinned Typst and packages, into `third_party/typst/`) |
| `step_tutorial.md` | a tutorial on STEP in practice (edited separately) |

### Commands

- `npm test`; `npm run typecheck` (`tsc --noEmit`). **Never `npx tsc -b` at the root**: it writes a `.js` beside every `.ts` (100 files, plus `tsconfig.tsbuildinfo`).
- A single package: `node --test packages/<p>/test/*.test.ts`. Not `node --test <directory>`: that fails whatever the code, so a mutation check run that way reports every mutation caught.
- Corpus checks: `node --max-old-space-size=8192 corpus_checks/<check>.ts test_corpus/files.txt 1000` (the list, then the maximum file size in MB; the logs were made with 1000). `roundtrip_corpus` needs `--max-old-space-size=12000` (about 31 min).
- The viewer's browser check (headless Chrome; `BUILD=1` for a build) and `cad-viewer start|stop|status|open|shot|replay`: README, "Viewer".
- Rebuilding the backends: `packages/tess-occt/build-occt.sh` (12 minutes) then `build.sh` (seconds); `packages/tess-truck/build.sh`. A backend's `info.version` carries its module's hash, so caches see each build.

### Code conventions

- **Line length and indentation** (the user, 2026-10-23): code lines at most 120 characters, comments word-wrapped to fit, in every language (TypeScript, JavaScript, bash, Rust, C++, Python, TOML); a long line is folded at commas and brackets (or before `&&`, `||`, `?`, `+`, `.`) with a 2-space continuation indent, and a long string is split into literals joined by `+`. Markdown is the opposite: each paragraph (and list item) is one long line, never folded. Indentation is 2 spaces in TypeScript, JavaScript and bash (4 in Rust), never hard tabs. Data inside template literals (STEP fixtures in tests) is left as it is.
- **ASCII** (the user, 2026-10-23): every tracked text file is ASCII, source code and the topic notes included, enforced by `test/ascii.test.ts`; the exceptions are this file, the corpus checks' `.log` files and binaries. Non-ASCII test data is written as escapes (`'Ä'`, `'﻿'`, `'\u{1F600}'`; not inside `String.raw`). Markdown uses `->` for arrows, `x` for times, `-` for dashes and minus, `...`, `+/-`, `^2`, and diagrams drawn with `+`, `-`, `|`, `v`, `>`.
- TypeScript run directly by Node 24's type stripping: erasable syntax only (no enums, namespaces, parameter properties), imports with `.ts` extensions, `node:` built-ins. No build step yet.
- No runtime dependencies in the core packages. Pinned exact versions where there are dependencies.
- **Comments** (the user, 2026-11-06): say what someone working on the code needs to know, above all what they'd get wrong without it (an invariant, a format's or a library's quirk, why the obvious way fails, which other code depends on this); file-level comments say what a module is. Keep them short: every line is read and maintained. No provenance: not who asked for a feature or when, not which decision or phase it came from (that's in the topic notes and git history). No history either ("was", "now", "since", "no longer", "until"), except where the code still handles the old way (files or builds written before a change) and then say what differs. Write them so they stay true as other documents change: a pointer names a file (`docs/claude/viewer.md`), never a section, a numbered item or a decision's number; no counts or measurements that drift unless they're why a constant has its value, and then say what was measured. When changing code, update or remove the comments it makes untrue, including those in other files that describe it.
- Problems in input are diagnostics (`{severity, message, source}`), never throws; throws are for caller bugs.
- Large data: typed arrays, output in chunks (generators of strings or byte arrays) with backpressure; nothing may need one string near V8's limit (2^29 − 24 characters; real models reach it).
- Deterministic output: the same input gives the same bytes (uuids, zip dates, ordering).
- **Markdown documents** (the user, 2026-10-23): `#` is the document's title and `##` its top-level sections; diagrams are Mermaid `flowchart TD` with concise labels; math is LaTeX (`$...$`, `$$...$$`). Documents must render as they are on GitHub and in browser viewers: PDF-only content goes in `<!--raw-typst ...-->` comments, Markdown-only content between `<!--typst-begin-exclude-->` and `<!--typst-end-exclude-->` (see `scripts/md2pdf.typ`). Identifiers of 30 or more characters in table cells are broken by hand into code spans of at most 24 characters, after underscores, joined by `<br>` (GitHub never breaks inside code and strips `<wbr>`; zero-width spaces rejected because copied text would carry them).
- Lengths in the scene are millimetres; matrices column-major `Float64Array`; mesh positions `Float32Array` minus the part's origin.

### How the user wants work done

These are the user's standing instructions; follow them.

- **Decisions go to the user, one at a time**, each with the alternatives and their trade-offs; close calls are deferred to the user, not made silently, and when two options are close, both are presented without marking one recommended in the docs. Record the decision and its alternatives in the repository (briefly: the rule and the alternatives in a phrase, in the topic note it belongs to; long records in `workdir/`).
- **Small choices made without the user** (a threshold, a default, a name, made on the way) are listed in the end-of-task summary in chat, for the user to object to there (the user, 2026-11-06); they're not recorded as "choices for review" in this file or the topic notes, which state only the rule as built. This file and the notes are for Claude, not for the user to read.
- **Commit only when the user says so.** Commit messages end with the attribution line the session gives.
- **Verify before claiming.** Run the test, the check or the measurement; say what wasn't checked. Don't claim "verified" for something no test covers: instrument the code and count calls if in doubt, and run controls to tell real defects from numeric noise.
- **Check against OCCT** for anything geometric or semantic (`occt-import-js`'s prebuilt module in `test_corpus/third_party/occt-import-js/dist`, OCCT's source in `third_party/OCCT`). Where we differ, decide by the standard and the evidence (the corpus has the same models exported by many CAD systems: `trj*_s1-*`, `*as1-*`, the `k1` keys; the user's Onshape exports in `test_corpus/models/` give a third opinion), record the divergence, and ask the user when it's a judgement call.
- **Mutation checks after each step:** a script plants deliberate bugs one at a time (checking first that the unmutated tests pass), and every survivor is either closed with a test or explained (equivalent mutants). Corpus checks get planted bugs too, to show they can fail.
- **Record findings in the repository** (this file, the topic notes and the README), not only in chat.
- **No upstream reports to any project** (OCCT, truck, glTF-Transform, lib3mf, ...) and no forks: workarounds go in our own wrappers; bugs inside OCCT we understand go in `occt_patches/` (the user, 2026-10-19, 2026-10-25).
- **Fixes for imperfect input go into the in-memory scene and meshes** (the importer, `tessellateScene`), so every consumer gets them, not into an exporter; format-specific encoding stays in exporters (the user, 2026-10-22). The library is meant for loading CAD data into memory and recovering names, orientations, hierarchy and transforms as well as possible, not only for converting files. Each fix gets a diagnostic and an opt-out.
- **Ask before deleting** anything you didn't just create; prefer moving to the scratchpad.
- **Don't search the whole disk** (`find /`).
- **Benchmarks only with low power mode off** and the CPU otherwise idle: check the mode in effect, `pmset -g | grep -i powermode` (`lowpowermode 0`; on Macs with High Power Mode also `powermode`, 0 automatic, 1 low, 2 high), not the power source, since the user may leave low power mode off on battery; `pmset -g custom` shows each source's setting; record the power state with timings; compare A and B only when run back to back. Low power mode about halves the speed. After mutation runs with hanging fake backends, look for stray `node --test` processes (one spun a core for 33 hours and skewed timings by 1–3%).
- Long corpus runs print progress on standard error and run in the background. Don't edit a script while it runs; run a copy. Edit scripts that assert on several replacements write nothing if one fails: check the result.
- The shell is zsh: an unquoted `$VAR` holding several words isn't split (use `bash -c` or spell the arguments out), `echo ====` is an error (`=cmd` expansion; quote it), and an unmatched glob (`--include=*.ts`) is an error.
- To investigate OCCT, copy `occt_tess.cpp` to the scratchpad, add probes switched by environment variables (passed through `Module.ENV` in `preRun`), and link against `packages/tess-occt/build/occt-Os` (compile about 1 s, link 7 s).

## History

| Phase | What | Released |
|---|---|---|
| 0 | the feasibility spike: per-part subsets tessellated by WebAssembly backends that report each triangle's face | |
| 1 | the parser, writer, raw JSON, binding, extraction, `step2json` | |
| 2 | the scene model, subsets, the STEP importer, the OCCT backend, end-to-end checks against OCCT | |
| 3 | workers, truck, caching, OCCT loose ends, wireframe curves | |
| 4 | the export view, three.js, glTF, 3MF, `stepconv`, corpus checks through `stepconv` | `V0.1.0` (2026-10-23) |
| after 4 | the viewer, importers for glTF, three.js JSON, 3MF and AP242 tessellated STEP, B-rep face measures, leaf products as placed parts, exports in the input's frame; the license AGPL-3.0-only, a CLA | `V0.2.0` (2026-11-01) |

## Decisions

Made by the user; the alternatives behind each are in `V0.2.0`'s or `V0.1.0`'s version of this file. These are the ones every part depends on; the rest are in the topic notes.

- **Scope:** TypeScript as plain ESM, browsers and Node from the start; AP242 XML (`.stpx`) out of scope; the project is cad-io-js (was step_js), since JT and IGES are planned, STEP packages keeping their names; a package per format (`step-import`, `gltf-import`, `export-gltf`, ...).
- **License:** AGPL-3.0-only (version 3 only) for every package, the viewer and the tools, except `tess-occt`, which stays LGPL-2.1 with the Open CASCADE exception, as OCCT is; versions before 0.2.0 were Apache-2.0. Told the user (not legal advice): AGPL's network clause makes a web application bundling the library AGPL as a whole; dual licensing needs the rights to all the code; the copyright status of AI-written code is unsettled. Contributions under a CLA (`CLA.md`, adapted from the Apache ICLA v2.2, the user as Maintainer with the right to sublicense; signed by a pull request comment recorded by `contributor-assistant/github-action` v2.6.1 in `signatures/cla.json` on `cla-signatures`; `CONTRIBUTING.md`); no corporate CLA yet.
- **Units and frames:** the scene is millimetres; a part is one shape representation with geometry, its positions `Float32` minus a per-part origin computed in double precision; the viewer's world is Z up. Exports use each format's convention (glTF and three.js metres, Y up; 3MF the source unit, Z up) with no root node of ours.
- **The tessellator interface is per part** (no session API); OCCT the primary backend, truck optional; backends take a host's module through `init`.
- **Importers for every format into the scene model**, and one viewer path through them (three.js's loaders dropped); textures not supported anywhere (warned of).
- **Extras off by default** in every exporter, library and `stepconv` alike: exports are mostly for other systems.
- **Meshing profiles** coarse, medium (the default), fine, defined only in `cad-scene`'s `profiles.ts`; the viewer medium on desktops, coarse on phones and tablets.
- **SHA-256 everywhere**, with our own implementation where Web Crypto is missing (plain http on a LAN).
- **Markdown to PDF with Typst** (0.15.1, pinned and checksummed, with cmarker, mitex and merman; only Typst's embedded fonts; diagram labels in Libertinus Serif); no pandoc, LaTeX or browser. Prototype: `workdir/2026-10-23_md2pdf/`.
- **Releases** bump every workspace package (and `tess-truck`'s crate) to the release's version, and tag it `V<version>`; the viewer shows it.

## Lessons learned

### Testing

- Mutation survivors are mostly weak fixtures: data where the first group is also the largest, one component where first and last differ, no oriented shells, no seams, frames whose errors cancel. Read a survivor as a missing case.
- A check that takes its expectations from the code under test is blind to that code's bugs; write the expectation independently, and prove each check with planted bugs.
- A check that searches for a case where the code already works, then tests only that case, proves nothing (the viewer's picking check missed picks wrong 23 % of the time). Check against an independent oracle over many points, classify the oracle's own limits rather than loosening the tolerance, check every outcome it can judge, and vary the inputs' conditions (units, scales), not only their content.
- Matching with a tolerance must pair nearest first over all candidates, not first come: greedy matching made mismatches that grew with the tolerance, twice.
- Unit tests in Node don't transfer buffers between threads: what depends on transfer needs the browser check.
- An expectation that encodes a difference without finding its cause can hide the other side's bug (truck's "1.35 x OCCT's area" was OCCT missing a cone).
- Cross-checks against OCCT need classification, not counts: OCCT's healing, its version, its colour fallbacks and its errors all show up as differences.

### JavaScript and Node

- Node's worker flags: passing `execArgv` explicitly makes Node reject process-wide flags (`--max-old-space-size`); let workers inherit unless `--input-type` is set (`node -e`), which breaks a worker's file entry.
- A Node `Buffer` from `readFileSync` may be a view into a pooled `ArrayBuffer`: pass a copy to libraries that read `.buffer`.
- V8's string limit (2^29 − 24) is reached by real models: write in chunks.

## Licensing and provenance

*Not legal advice.* OCCT is LGPL-2.1 plus the Open CASCADE exception. A line-by-line translation of OCCT, including asking an AI to "port this function", is a derivative work and LGPL would apply. So:

- Treat OCCT as a behavioural reference and a test oracle (running it carries no obligation), never as source to translate. Copying enough of its special cases in the same order starts to look like copying expression; the risky areas are shape healing, p-curve and tolerance handling, and meshing.
- Have OCCT's behaviour described, then write fresh code from that and the specifications; keep a provenance note of the spec, paper or recommended practice behind each module; don't copy OCCT comments or identifiers (EXPRESS entity names are ISO's); be able to justify every constant independently. Clean-room discipline for healing or meshing, if the project ever goes there.
- Mirroring the entity model is fine (it is ISO's EXPRESS); NURBS math comes from the literature (Piegl & Tiller).
- Other sources: stepcode BSD-3 (keep notices if code is copied); NIST's STP2X3D and SFA are US public domain; the MBx-IF practices are free to implement; the ISO EXPRESS schemas' terms for the generated dictionaries are still to confirm.
- The OCCT backend links OCCT itself, which is why it lives in its own LGPL package.
