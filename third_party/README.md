# Third-party dependencies

Source code and documents this project builds against or reads, other than npm packages. Only this README, `pull.sh` and `.gitignore` are committed; the checkouts are git-ignored.

`pull.sh` (runnable from any directory) fetches everything at the pinned versions, or brings existing checkouts to them. To move a dependency to a new version, change its pin in `pull.sh` and run it again. About 400 MB in all.

The test corpus is separate: see `../test_corpus/README.md`. The system tools these need (Emscripten, CMake, Rust, ...) are checked by `source ../env.sh`.

## Checked out here

| Directory | Upstream | Pinned at | Used by |
|---|---|---|---|
| `OCCT/` | https://github.com/Open-Cascade-SAS/OCCT | `3d097a0328` (2026-08-24, 8.1.0 development) | The custom Emscripten build of the OCCT tessellation backend: `../packages/tess-occt/build-occt.sh` builds its static libraries (and `occt_overlay/test/` there links against them). |
| `stepcode/` | https://github.com/stepcode/stepcode | `24783b4485` (2026-09-28) | `data/ap203`, `ap203e2`, `ap214e3`, `ap242`: the EXPRESS schemas `npm run gen -w step-schemas` turns into `packages/step-schemas/dict/`, and that package's freshness test (skipped if the checkout is missing). The dictionaries are committed, so this is needed only to regenerate them. |
| `truck/` | https://github.com/ricosjp/truck | `88ed005249` (2026-09-28) | The truck tessellation backend, `../packages/tess-truck` (Cargo `path` dependencies). |
| `mbx-if-recpractices/` | https://www.mbx-if.org/home/cax/recpractices/ | the 21 file URLs in `pull.sh` | CAx-IF / MBx-IF recommended practices (19 PDFs and two trace-information sample zips): the guide for the semantic extractors (assembly structure, validation properties, PMI, styling). Documents only. |

Licenses: OCCT is LGPL-2.1 with the Open CASCADE exception, which is why the architecture isolates it in the `tess-occt` package; stepcode is BSD-3-Clause; truck is Apache-2.0. See "Licensing and provenance" in `../CLAUDE.md`.

## Typst

`../scripts/fetch-typst.sh` fetches what `../scripts/md2pdf.sh` needs to make PDFs of the Markdown documents into `typst/` here (git-ignored like the rest), pinned and checked against SHA-256 digests: the official Typst 0.15.1 release binary for the platform (https://github.com/typst/typst, Apache-2.0; macOS and Linux, arm64 and x86_64), and three Typst packages from https://packages.typst.org, unpacked where Typst's package cache expects them (`typst/packages/preview/<name>/<version>/`), so a build never downloads anything:

| Package | Version | What it does | License |
|---|---|---|---|
| cmarker | 0.1.10 | CommonMark Markdown to Typst, inside Typst (a WebAssembly plugin) | MIT |
| mitex | 0.2.7 | LaTeX math to Typst math (a WebAssembly plugin) | Apache-2.0 |
| merman | 0.5.0 | Mermaid diagrams to SVG without a browser (a WebAssembly plugin of a headless Rust implementation of Mermaid) | MIT or Apache-2.0; its ELK layout component EPL-2.0 |

They are build tools for documentation only; nothing ships with the packages. To move to new versions, change the pins (versions and digests) in `fetch-typst.sh`; the Typst release's digests are on its GitHub release page, the packages' are those of `https://packages.typst.org/preview/<name>-<version>.tar.gz`. cmarker and merman need Typst 0.15 or later.

## A custom OCCT build for tess-occt

The OCCT backend (`../packages/tess-occt`) is our wrapper, `native/occt_tess.cpp`, and OCCT compiled together into one Emscripten module; its TypeScript side calls the wrapper's C functions, not OCCT's classes. A host that builds OCCT itself (to bind more of OCCT for its own use, to pin another commit, to ship one module instead of two) can have the backend use that build instead of ours, as long as the wrapper is linked into it. An OCCT module without the wrapper (`occt-import-js`, `opencascade.js`, a host's own bindings) can't be used: the wrapper's work could in principle be redone from JavaScript through bindings of the same OCCT classes, but that was decided against (2026-10-23), for the speed of copying meshes out one node at a time and the per-object memory management.

What such a build needs, as `../packages/tess-occt/build-occt.sh` and `build.sh` do it for ours:

1. **OCCT 8.** The wrapper uses OCCT 8's API (`occ::handle`, `DESTEP_Parameters`, `DE_ShapeFixParameters`, `STEPControl_Reader::ReadStream` with parameters), so it doesn't compile against 7.x. Our results are for the commit pinned above (`3d097a0328`); another commit can mesh some faces differently.
2. **Configure** with Emscripten's CMake wrapper, static libraries, and the flags that matter for WebAssembly:

   ```sh
   emcmake cmake <OCCT source> -G "Unix Makefiles" -DCMAKE_BUILD_TYPE=Release -DBUILD_LIBRARY_TYPE=Static      -DBUILD_MODULE_Draw=OFF -DUSE_FREETYPE=OFF -DUSE_TK=OFF -DUSE_TCL=OFF -DUSE_GLES2=OFF -DUSE_OPENGL=OFF      -DCMAKE_CXX_FLAGS="-fwasm-exceptions -UOCC_CONVERT_SIGNALS" -DCMAKE_C_FLAGS="-fwasm-exceptions -UOCC_CONVERT_SIGNALS"      -DCMAKE_CXX_FLAGS_RELEASE="-Os -DNDEBUG" -DCMAKE_C_FLAGS_RELEASE="-Os -DNDEBUG"
   cmake --build . --target TKDESTEP TKMesh -j8
   ```

   - `-fwasm-exceptions` everywhere (OCCT, the wrapper, the link): the wrapper catches OCCT's exceptions, and the glue's imports depend on the exception model, so every object must agree.
   - `-UOCC_CONVERT_SIGNALS`: without it, the `setjmp` in every `OCC_CATCH_SIGNALS` makes the linked module invalid WebAssembly (`br_table: label arity inconsistent`).
   - `CMAKE_CXX_FLAGS_RELEASE` set explicitly, or OCCT appends `-O3` after your flags (harmless, but larger).
   - The toolkits the wrapper needs are `TKDESTEP` (the STEP reader) and `TKMesh` (the mesher) and what they depend on; a host builds whatever else it uses beside them.
3. **Compile the wrapper** against that build's headers: `em++ -Os -fwasm-exceptions -std=c++17 -I<build>/include/opencascade -c occt_tess.cpp`.
4. **Link** it with the host's own code and OCCT's libraries into one module, with at least these settings:
   - `-fwasm-exceptions`;
   - `-sMODULARIZE=1 -sEXPORT_ES6=1`: an ES module whose default export is the factory (`init`'s `glue`); its separate `.wasm` file is `init`'s `wasm`;
   - `-sENVIRONMENT=web,worker,node` (or the subset the host runs in; `worker` for the worker pool);
   - `-sALLOW_MEMORY_GROWTH=1` (large parts take hundreds of MiB) and `-sSTACK_SIZE=4MB`, as ours (Emscripten's default is 64 kB; ours hasn't been tried with less, and OCCT recurses deeply);
   - `-sEXPORTED_FUNCTIONS` with the wrapper's functions and the allocator, besides the host's own: `_occt_tessellate`, `_occt_positions`, `_occt_normals`, `_occt_num_vertices`, `_occt_indices`, `_occt_num_indices`, `_occt_faces`, `_occt_num_faces`, `_occt_edge_positions`, `_occt_num_edge_points`, `_occt_edges`, `_occt_edge_angles`, `_occt_num_edges`, `_occt_curve_positions`, `_occt_num_curve_points`, `_occt_curves`, `_occt_num_curves`, `_occt_points`, `_occt_point_ids`, `_occt_num_points`, `_occt_diag`, `_occt_free`, `_malloc`, `_free` (and optionally `_occt_set_mesh_options`);
   - `-sEXPORTED_RUNTIME_METHODS` with `HEAPU8`, `HEAPF32`, `HEAPU32`, `HEAP32` and `UTF8ToString`, besides the host's own.

   The factory must honour the module arguments Emscripten's glue normally does: `instantiateWasm` (the backend compiles and instantiates the module itself) and `print`/`printErr` (OCCT's messages become warnings on the part). Embind bindings, other exports and other toolkits can be in the same module. `tess-occt`'s `REQUIRED_EXPORTS` lists what the backend checks for at `init`; a module without them fails there, naming what's missing.
5. **Use it:** `new OcctTessellator().init({glue, wasm, version})`, with `glue` the factory or the `.mjs`'s URL, and `wasm` the module's bytes, URL, or compiled `WebAssembly.Module`. In a worker pool, pass the same as the backend's `options` (URLs or a compiled module: those can be posted to workers, a factory function can't). `info.version`, which cache keys include, then names the build: by the module's hash when there are bytes to hash, by `version` (required with a compiled module, and it must change whenever the module does).

Each `OcctTessellator` (each worker's, in a pool) instantiates the module afresh, with its own memory: what is shared with the host is the download and the compilation, not a running instance, whose memory and global state (the wrapper keeps one result at a time) are the backend's alone.

If the host's OCCT build is a CMake build directory like ours, the quickest check is to link our wrapper against it with our script, `B=<its build directory> ../packages/tess-occt/build.sh` (it reads `<B>/include/opencascade` and `<B>/lin32/clang/lib/*.a`), and run the package's tests (`node --test ../packages/tess-occt/test/*.test.ts`) against the result. That replaces `../packages/tess-occt/dist/` (run `build.sh` again without `B` to restore ours); to compare a host's module with ours on real files, tessellate the corpus with both (as `../corpus_checks/scene_occt.ts` does with ours).

Licensing: `occt_tess.cpp` is part of `tess-occt`, which is LGPL-2.1 with the Open CASCADE exception, as OCCT is, so linking it adds no license beyond the one a host's OCCT build already has (not legal advice).

## Reference only (not checked out here)

Read for background, never built against. The commits are the ones reviewed (see "Reference projects and prior art" in `../CLAUDE.md`).

| Project | Upstream | Commit reviewed | Why |
|---|---|---|---|
| ruststep | https://github.com/ricosjp/ruststep | `cd89e5a` (2025-03-20) | Rust STEP toolkit; its EXPRESS compiler `espr` was a reference for the schema generator, and its parser follows the Part 21 grammar rules. |
| verb | https://github.com/pboyer/verb | `f3ba23c` (2025-04-02) | NURBS library; geometry background. |
| engine_web-ifc | https://github.com/ThatOpen/engine_web-ifc | `e408b65` (2026-10-16) | That Open Company's IFC engine: a WebAssembly parser and tessellator for a STEP-family format. |
| STP2X3D | https://github.com/usnistgov/STP2X3D | `f86980e` (2026-10-15) | NIST's STEP-to-X3D converter (built on OCCT): semantic extraction and presentation. |
| SFA | https://github.com/usnistgov/SFA | `72375d1` (2026-09-14) | NIST STEP File Analyzer and Viewer: semantic checks, validation properties, PMI reporting. |

monstertruck (https://github.com/virtualritz/monstertruck, `d2ad1ed7aa`, 2026-10-07), evaluated and not chosen in phase 0, was dropped from `pull.sh` on 2026-10-23: only the spike's `mtruck_spike` used it (`phase0_tessellation_spike/` at tag `V0.1.0`; "Phase 0" in `../CLAUDE.md`). To build that again, clone it at that commit into `monstertruck/`.
