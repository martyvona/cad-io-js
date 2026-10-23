# Phase 0 feasibility spike: handoff notes

*Moved from `phase0_tessellation_spike/` to `docs/phase0/` on 2026-10-23, when the spike's code left the tree. Names of the spike's files (scripts, logs, `occt_tess/`, `truck_spike/`, `out/`, …) refer to that directory at tag `V0.1.0`; `README.md` here says where each part went and how to get the rest back.*

*Historical: the plan as written before the spike ran. The outcome is in `phase0_results.md`, and the code tour in `README.md`.*

Written 2026-10-16 before a session restart. **The spike is the next step.** Read `../architecture.md` first (stage 2, "The tessellator interface", and "Phasing"); `../docs/initial_analysis.md` has the background research. No project code exists yet.

## What the spike must answer

The answers determine whether the per-part tessellator interface in `../architecture.md` can be frozen.

1. **Per-part subsets:** will OCCT and truck tessellate a STEP subset file that contains only the closure of one shape representation? That means every entity transitively referenced from, for example, an `ADVANCED_BREP_SHAPE_REPRESENTATION` or `MANIFOLD_SOLID_BREP`, keeping the original `#` IDs. If not, would a minimal synthetic product wrapper make them accept it?
2. **Face IDs:** can each backend report which source `ADVANCED_FACE` entity each triangle range came from?
3. **Size and speed:** what are the realistic WASM payload size, load/compile time, tessellation time and peak memory?
4. **Optional:** as a baseline, how fast is a minimal JS Part 21 tokenizer and entity index on the same files?

## Candidate backends and what's known

**OCCT:**

- **`occt-import-js`** (npm, LGPL, by kovacsv): OCCT compiled to WASM. Takes whole STEP/IGES/BREP files and returns meshes plus a node tree. Probably doesn't expose face entity IDs. This is the fastest way to test question 1: feed it a subset file.
- **`opencascade.js`** (npm, LGPL): a fuller OCCT binding with custom builds. Its maintenance status is unverified.
- **Our own Emscripten build of only the needed toolkits.** OCCT can map a face back to its STEP entity through `XSControl_TransferReader` / `Transfer_TransientProcess`. Requires Emscripten, which is **not installed**.
- **Relevant OCCT sources** (`/Users/vona/src/others/OCCT`, version 8.1.0): `src/DataExchange/TKDESTEP/` (`STEPControl`, `STEPCAFControl`, `StepToTopoDS`), `src/ModelingAlgorithms/TKMesh` (`BRepMesh`).
- **Open question:** can OCCT's `STEPControl_Reader` transfer a bare shape representation with no product wrapper? It has root-selection and product-mode settings, such as `read.step.product.mode`.

**truck** (Apache-2.0, `/Users/vona/src/others/truck`):

- **`truck-js`** is wasm-bindgen bindings. The STEP API is in `truck-js/src/step_in.rs`:
  - `Table.from_step(step_str)` parses a whole STEP string.
  - `table.shell_indices()` returns the keys of the shell map. These are likely the STEP entity IDs of the shells, which would give correlation at the shell level; to verify.
  - `table.get_shape(idx).to_polygon(tol)` → `PolygonMesh`, using `robust_triangulation`.
- **Face IDs:** probably need a small Rust change to report source face IDs per triangle range. Look at `truck-stepio/src/in/mod.rs` and `truck-meshalgo`.
- **Building:** requires Rust plus `wasm-pack` (`rustup` and `cargo install wasm-pack`), which are **not installed**. Check first whether a prebuilt `truck-js` is published on npm.

## Local environment (checked 2026-10-16)

- **Installed:** Node v24.5.0, npm 11.5.1, cmake 4.2.0, Python 3.14.4, git 2.50.1.
- **Not installed:** pnpm, Rust/cargo/rustc, wasm-pack, Emscripten (`emcc`), poppler.
- **No `gh` CLI:** use `curl` with the GitHub API instead.
- **macOS zsh gotchas:**
  - Quote globs in `grep --include='*.cpp'`.
  - Some files contain non-UTF-8 bytes, so use `LC_ALL=C grep -a`.

## Test inputs

- **NIST AP242 single parts** (since moved to `test_corpus/third_party/`; `/Users/vona/src/others/nist-pmi-models/NIST-PMI-STEP-Files/NIST-PMI-STEP-Files/`):
  - `nist_ctc_01_asme1_ap242-e1.stp` … `nist_ctc_05_*` (editions e1/e2)
  - `nist_ftc_06..11_asme1_ap242-e2.stp`
  - `nist_stc_06..10_asme1_ap242-e3.stp`
  - Filename suffixes give the AP242 edition (e1/e2/e3).
  - Many of these files carry validation properties (volume, area, centroid) for accuracy checks.
- **CAx-IF-style assemblies and mixed APs** (`/Users/vona/src/others/gkv311-opencascade-dataset/step/`):
  - `trj2_as1-id-203.stp`, `trj2_as1-tc-214.stp`, `bug21802_as1-oc-214.stp` ("as1" = the standard assembly test model, in AP203 and AP214)
  - `trj7_k1-*-214.stp`
  - AP242: `sp7_04-dx-242.stp`, `bug32049_sp7_10nx_242.stp`, `bug33569.stp`
  - Deliberately broken: `bug32314_corrupted.stp`
- **More files:** 470 STEP files in gkv311 (28 of them AP242), plus `/Users/vona/src/others/nist-pmi-models/NIST-D2MI-Models/`.

## Suggested spike steps

1. **Create a scratch spike directory** outside the eventual monorepo, for example `step_js/spike/`. Throwaway code is fine. (It ended up as `step_js/spike/`, renamed `phase0_tessellation_spike/` on 2026-10-17.)
2. **Write a crude subset extractor** in Node, deliberately not production quality:
   - Scan the file for `#n=` entity boundaries, which gives an ID → text map. Watch for strings containing `;` and for multi-line entities.
   - Extract `#refs` from each entity and compute the transitive closure from a chosen root.
   - Emit a Part 21 file with the original header, the closure entities and the original IDs.
3. **Install `occt-import-js`** and run it on (a) whole files and (b) subset files. Record success/failure, triangle counts and timing, and compare subset results with the whole-file results for the same part.
4. **Check `occt-import-js`'s output** for any face or entity identifiers.
5. **truck:** check npm for a prebuilt `truck-js`. Otherwise ask the user before installing Rust and `wasm-pack`, then build `truck-js` and repeat steps 3–4.
6. **Record payload sizes, load times and peak memory** (Node's `process.memoryUsage()`).
7. **Write up the results** in `step_js/phase0_results.md` (now `phase0_results.md` in this directory), and update the tessellator interface in `../architecture.md` if anything changes.

## Decisions already made (don't revisit)

- TypeScript compiled to ESM, browser and Node, Apache-2.0 (the OCCT backend package isolates the LGPL), `.stpx` out of scope.
- **Tessellator interface: per part.** One request is one part, as `{format: 'step'|'iges'|'brep', data, rootId?, deflection...}`, and the response is a mesh with per-face entity ID ranges. The user explicitly rejected a "load once, tessellate many" session API.
- Treat OCCT as a behavioral reference only (no line-by-line translation), keeping a provenance log.
