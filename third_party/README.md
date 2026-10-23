# Third-party dependencies

Source code and documents this project builds against or reads, other than npm packages. Only this README,
`pull.sh` and `.gitignore` are committed; the checkouts are git-ignored.

`pull.sh` (runnable from any directory) fetches everything at the pinned versions, or brings existing checkouts to
them. To move a dependency to a new version, change its pin in `pull.sh` and run it again. About 400 MB in all.

The test corpus is separate: see `../test_corpus/README.md`. The system tools these need (Emscripten, CMake, Rust, …) are checked by `source ../env.sh`.

## Checked out here

| Directory | Upstream | Pinned at | Used by |
|---|---|---|---|
| `OCCT/` | https://github.com/Open-Cascade-SAS/OCCT | `3d097a0328` (2026-08-24, 8.1.0 development) | The custom Emscripten build of the OCCT tessellation backend: `../packages/tess-occt/build-occt.sh` builds its static libraries (and `occt_overlay/test/` there links against them). |
| `stepcode/` | https://github.com/stepcode/stepcode | `24783b4485` (2026-09-28) | `data/ap203`, `ap203e2`, `ap214e3`, `ap242`: the EXPRESS schemas `npm run gen -w step-schemas` turns into `packages/step-schemas/dict/`, and that package's freshness test (skipped if the checkout is missing). The dictionaries are committed, so this is needed only to regenerate them. |
| `truck/` | https://github.com/ricosjp/truck | `88ed005249` (2026-09-28) | The truck tessellation backend, `../packages/tess-truck` (Cargo `path` dependencies). |
| `mbx-if-recpractices/` | https://www.mbx-if.org/home/cax/recpractices/ | the 21 file URLs in `pull.sh` | CAx-IF / MBx-IF recommended practices (19 PDFs and two trace-information sample zips): the guide for the semantic extractors (assembly structure, validation properties, PMI, styling). Documents only. |

Licenses: OCCT is LGPL-2.1 with the Open CASCADE exception, which is why the architecture isolates it in the
`tess-occt` package; stepcode is BSD-3-Clause; truck is Apache-2.0. See the licensing section of `../docs/initial_analysis.md`.

## Reference only (not checked out here)

Read for background, never built against. The commits are the ones reviewed (see `../docs/initial_analysis.md`).

| Project | Upstream | Commit reviewed | Why |
|---|---|---|---|
| ruststep | https://github.com/ricosjp/ruststep | `cd89e5a` (2025-03-20) | Rust STEP toolkit; its EXPRESS compiler `espr` was a reference for the schema generator, and its parser follows the Part 21 grammar rules. |
| verb | https://github.com/pboyer/verb | `f3ba23c` (2025-04-02) | NURBS library; geometry background. |
| engine_web-ifc | https://github.com/ThatOpen/engine_web-ifc | `e408b65` (2026-10-16) | That Open Company's IFC engine: a WebAssembly parser and tessellator for a STEP-family format. |
| STP2X3D | https://github.com/usnistgov/STP2X3D | `f86980e` (2026-10-15) | NIST's STEP-to-X3D converter (built on OCCT): semantic extraction and presentation. |
| SFA | https://github.com/usnistgov/SFA | `72375d1` (2026-09-14) | NIST STEP File Analyzer and Viewer: semantic checks, validation properties, PMI reporting. |

monstertruck (https://github.com/virtualritz/monstertruck, `d2ad1ed7aa`, 2026-10-07), evaluated and not chosen in phase 0, was
dropped from `pull.sh` on 2026-10-23: only the spike's `mtruck_spike` used it (`phase0_tessellation_spike/` at tag
`V0.1.0`; `../docs/phase0/README.md`). To build that again, clone it at that commit into `monstertruck/`.
