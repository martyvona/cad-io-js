# Phase 0: tessellation spike

The feasibility spike of 2026-10-16/17. It tested whether STEP parts can be cut out of a file as small Part 21 subsets
and tessellated one at a time by WebAssembly backends, with each mesh face traced back to its `ADVANCED_FACE`. Four
backends were tried: `occt-import-js` (OCCT 7.x), a custom Emscripten build of OCCT 8.1, truck and monstertruck.

Everything here is throwaway. Nothing in `packages/` imports it, and it is kept as evidence and as a model for later
work: the custom OCCT build (`occt_tess/`, `occt_variant_build.sh`, `occt_overlay/`) is the starting point for the
real OCCT backend.

## Documents

- `phase0_spike_plan.md`: the plan and the questions, as written before the spike (historical).
- `phase0_results.md`: the results and decisions. **Start here.**
- `phase0_subset_method.md`: how the per-part subsets were cut, and the gaps in that method.
- `occt_overlay/README.md`: the `VBernstein` table overlay and its tests.

Paths in these documents are relative to this directory. All commands below run from this directory.

## Tour of the committed files

### Part 21 indexing and subsets

| File | What it is |
|---|---|
| `p21.mjs` | Crude Part 21 indexer (one pass over a latin1 string), forward-reference closure, and subset writer. Superseded by `packages/step-parser`. |
| `make_subsets.mjs` | Writes a bare and a wrapped subset for every solid-bearing shape representation of one file: `<file>.absr.<id>.stp` and `<file>.absr+wrap.<id>.stp`. |
| `inspect.mjs` | Counts entity types in a file and lists its representations, products and contexts. |
| `bench_index.mjs` | Times `p21.mjs` indexing (best of 5) and the closure of every shape representation. |

### `occt-import-js` (OCCT 7.x, from npm)

| File | What it is |
|---|---|
| `package.json`, `package-lock.json` | The `occt-import-js` 0.0.23 dependency (`npm install` here). CommonJS, which is why the scripts are `.mjs`. |
| `occt_test.mjs` | The first harness: indexes each source file, writes its subsets to `out/` (bare, wrapped, and the obsolete solid-rooted `.solid.*` variant), tessellates them and the whole file, and checks face order against the STEP faces. Writes `occt_results.json`. `ONLY_WRAP=1` runs only wrapped subsets and writes no files. |
| `occt_run1.log`, `occt_run2.log`, `occt_run3.log` | Successive runs on the NIST + gkv311 set; run 3 is the one reported. |
| `occt_bike.log`, `occt_results.json` | The bicycle run (`ONLY_WRAP=1`) and its per-subset results. |
| `occtjs_bench.mjs` | Idle-CPU timing of `occt-import-js` on wrapped subsets. |
| `cold.mjs` | Cold start: WASM read, compile and init times, heap and RSS, optionally one file's tessellation. |
| `dbg2.mjs`, `dbg3.mjs`, `dbg_faces.mjs` | One-off debugging of the face-order heuristic. |

### Custom OCCT 8.1 build

| File | What it is |
|---|---|
| `occt_variant_build.sh` | Configures and builds the static OCCT toolkits (`TKDESTEP`, `TKMesh` and dependencies) for one variant into `occt-build-<name>/`. |
| `occt_tess/occt_tess.cpp` | The C++ wrapper: reads a subset, meshes it, and returns positions, normals, indices, per-face `ADVANCED_FACE` ids (via the transfer bindings) and edge polylines. |
| `occt_tess/build.sh` | Compiles the wrapper and links it against one build's libraries into an ES module plus `.wasm`. |
| `occt_overlay/` | The `VBernstein` overlay header, which computes an 840 kB table instead of storing it, and its tests; see its README. |
| `occt_tess_test.mjs` | Main harness: bare/wrapped × product mode OFF/ON, face-id check against STEP vertices, area against `occt-import-js` (`NOREF=1` skips that). |
| `occt_tess_run.log`, `occt_tess_bike.log` | Its output on `out/` and `out_bike/`. |
| `occt_tess_bench.mjs` | Clean timing: bare subsets, product mode OFF. |
| `occt_variant_diff.mjs` | Compares two linked builds part by part: success, face ids, triangle count, area. |
| `occt_algo_bench.mjs` | Mesh algorithm comparison (Watson vs. Delabella, min-size options). |
| `occt_edges_test.mjs`, `occt_edges_dbg.mjs`, `occt_degen_check.mjs` | Edge prototype checks (id mapping, endpoints, points on the mesh, kinds, dihedral angles), a per-part dump, and a degenerate-edge census. |

The harnesses load `occt_tess/final_Os.mjs` unless `MOD=` names another linked module.

### truck and monstertruck

| File | What it is |
|---|---|
| `truck_spike/` | Rust crate wrapping truck (path dependencies on a truck checkout): native binary `truck_spike <tol> <withPositions 0/1> <outDir> <files…>` and a wasm-bindgen library. |
| `mtruck_spike/` | The same wrapper ported to monstertruck. |
| `truck_test.mjs` | Runs the native binary on each subset (one process each, with a timeout) and checks face ids. `BIN=` selects the binary, `TAG=` the results file name (`<TAG>_results_<filter>.json`). |
| `truck_absr.log`, `truck_bike.log`, `truck_wrap.log`, `truck_absr.err` | truck on bare subsets of both sets, on wrapped subsets, and panic messages from the bare run. |
| `mtruck_absr.log`, `mtruck_bike.log` | monstertruck on bare subsets of both sets. |
| `truck_results_.absr..json`, `truck_results_.absr+wrap..json`, `mtruck_results_.absr..json` | Per-subset results behind those logs. |
| `truck_wasm.mjs`, `mtruck_wasm.mjs` | WASM timing of the two wrappers. |
| `area_compare.mjs`, `area_truck.json`, `area_mtruck.json` | Area against `occt-import-js` (superseded by `area3.mjs`). |
| `dbg_truck.mjs`, `dbg_area.mjs` | One-off debugging. |

### Cross-backend

| File | What it is |
|---|---|
| `area3.mjs`, `area3.json` | Per-part area of truck and monstertruck against the custom OCCT 8.1 build, on both sets. |

### Not committed (git-ignored, regenerated by the commands below)

- `out/` (NIST + gkv311 subsets) and `out_bike/` (bicycle subsets); `tout/` (per-file truck JSON from an early run)
- `node_modules/` (`occt-import-js`)
- `occt-build-Os/` (about 850 MB): the `-Os` OCCT libraries, built on 2026-10-17 from `../third_party/OCCT` with the current `occt_variant_build.sh`. Linked and run through `occt_tess_test.mjs`, they reproduced `occt_tess_run.log` and `occt_tess_bike.log` apart from timings. (The results themselves came from equivalent builds made from a sibling OCCT checkout, `occt-build/` and the overlay variant `occt-build-Osvb/`, deleted on 2026-10-17.)
- `occt_tess/final_Os.{mjs,wasm}`: the linked module the harnesses load by default, from the original `occt-build/`. It differs from a link against `occt-build-Os/` only through the source paths embedded in OCCT's assertion messages. The overlay variant's `final_Osvb.{mjs,wasm}` was deleted with its build; step 3 below rebuilds it.
- `truck_spike/target/`, `truck_spike/pkg-node/`, and the same in `mtruck_spike/`

## Prerequisites

| What | Version used | Where the scripts expect it |
|---|---|---|
| (all tools) | | `source ../env.sh` checks them, sets up Rust's and Emscripten's environment, and prints install commands for anything missing |
| Node | 24.5 | `PATH` |
| Test corpus | see `../test_corpus/README.md` | `../test_corpus/third_party/` (run `../test_corpus/third_party/pull.sh`) |
| `occt-import-js` | 0.0.23 | `npm install` in this directory |
| Emscripten | 6.0.12 | the emsdk named by `$EMSDK`, else `~/emsdk` (the build scripts source its `emsdk_env.sh` unless `em++` is already on `PATH`) |
| OCCT source | `3d097a0328` (2026-08-24) | `../third_party/OCCT` (run `../third_party/pull.sh`) |
| Rust, `wasm-pack` | 1.99.1 stable, 0.15.0 | `~/.cargo/bin` |
| truck | `88ed005` (2026-09-28) | `../third_party/truck` |
| monstertruck | `d2ad1ed` (2026-10-07) | `../third_party/monstertruck` |

**Paths:** the scripts find the test corpus, OCCT, truck and monstertruck by paths relative to this directory, and
write temporary files under the system temp directory. (Until 2026-10-17 they used absolute paths on the original
machine.) `final_Os.{mjs,wasm}` was linked from an earlier build of
the same OCCT commit in a sibling checkout, so its assertion messages name `/Users/vona/src/others/OCCT`.

## Reproducing

### 1. Subsets

```sh
N=../test_corpus/third_party/nist-pmi-models/NIST-PMI-STEP-Files/NIST-PMI-STEP-Files
G=../test_corpus/third_party/gkv311-opencascade-dataset/step
for f in $N/*.stp $G/trj2_as1-id-203.stp $G/trj2_as1-tc-214.stp $G/bug21802_as1-oc-214.stp $G/trj7_k1-*-214.stp \
         $G/sp7_04-dx-242.stp $G/bug32049_sp7_10nx_242.stp $G/bug33569.stp; do
  node make_subsets.mjs "$f" out
done                                                     # 29 files, 76 parts
node make_subsets.mjs $G/Median_cx-fs01_bicycle.stp out_bike   # 112 parts
```

`out/` was originally written by `occt_test.mjs` (step 2), which also writes the obsolete `.solid.*` files. On
2026-10-17, the loop above was checked to reproduce every `.absr.` and `.absr+wrap.` file in `out/`, and all of
`out_bike/`, byte for byte.

### 2. `occt-import-js`

```sh
npm install
node occt_test.mjs $N/*.stp $G/trj2_as1-id-203.stp $G/trj2_as1-tc-214.stp $G/bug21802_as1-oc-214.stp \
  $G/trj7_k1-*-214.stp $G/sp7_04-dx-242.stp $G/bug32049_sp7_10nx_242.stp $G/bug33569.stp > occt_run3.log 2>&1
ONLY_WRAP=1 node occt_test.mjs $G/Median_cx-fs01_bicycle.stp > occt_bike.log 2>&1
node occtjs_bench.mjs out out_bike        # idle-CPU timing (results table, row "NIST + gkv311" / "Bicycle")
node cold.mjs out/nist_ctc_02_asme1_ap242-e2.stp.absr+wrap.1341.stp   # startup and memory
node bench_index.mjs $G/Median_cx-fs01_bicycle.stp                   # JS indexer speed
```

`occt_test.mjs` deletes nothing, but rewrites the subsets in `out/` and `occt_results.json`.

### 3. Custom OCCT 8.1 build

Build the static libraries (about 6 minutes each on 10 cores; `JOBS=` sets the parallelism, default all CPUs), then
link. The build scripts are bash, and run on macOS and Linux:

```sh
./occt_variant_build.sh Os "-Os"                 # → occt-build-Os/ (kept)
./occt_variant_build.sh Osvb "-Os" "" 1          # → occt-build-Osvb/, with the occt_overlay/ header (not kept)
B=../occt-build-Os OUT=final_Os occt_tess/build.sh
B=../occt-build-Osvb OUT=final_Osvb occt_tess/build.sh
```

`build.sh` defaults to `B=../occt-build-Os OUT=occt_tess OPT=-Os`; `LINKOPT` overrides the link optimization. The other
variants in the results ("Build variants") were `./occt_variant_build.sh O2 "-O2"`, `O3 "-O3"`, and
`Oslto "-Os" "-flto" 1`, linked with `OPT`/`LINKOPT` set to the same flags.

Then the tests:

```sh
node occt_tess_test.mjs out > occt_tess_run.log 2>&1        # needs npm install, or NOREF=1
node occt_tess_test.mjs out_bike > occt_tess_bike.log 2>&1
node occt_tess_bench.mjs out; node occt_tess_bench.mjs out_bike           # timing
MOD=./occt_tess/final_Osvb.mjs node occt_tess_bench.mjs out               # the same for the overlay build
node occt_variant_diff.mjs ./occt_tess/final_Os.mjs ./occt_tess/final_Osvb.mjs out out_bike
node occt_edges_test.mjs out; node occt_edges_test.mjs out_bike           # edges
node occt_degen_check.mjs out out_bike
node occt_algo_bench.mjs out out_bike                                     # mesh algorithms
```

On 2026-10-17, `node occt_tess_test.mjs out` reproduced `occt_tess_run.log` line for line apart from timings, both with
`final_Os.mjs` and with a module linked against `occt-build-Os/`; so did `out_bike` and `occt_tess_bike.log` with the
latter. The overlay commands need the `Osvb` build and link first.

The overlay tests (see `occt_overlay/README.md`):

```sh
occt_overlay/test/run.sh ../../occt-build-Osvb patched
occt_overlay/test/run.sh ../../occt-build-Os orig
(cd occt_overlay/test && python3 compare.py patched.txt orig.txt)
```

The two control runs (`ctl1.txt`, `ctl2.txt`) need `instrumented_AppCont_ContMatrices.pxx` copied into the build's
`include/opencascade/`, `VB_CONTROL_MODE` set to 1 or 2, and the libraries rebuilt; restore the plain overlay
afterwards.

### 4. truck and monstertruck

```sh
(cd truck_spike && cargo build --release && wasm-pack build --release --target nodejs --out-dir pkg-node)
(cd mtruck_spike && cargo build --release && wasm-pack build --release --target nodejs --out-dir pkg-node)
TIMEOUT=30000 node truck_test.mjs out '.absr.' > truck_absr.log 2>&1
TIMEOUT=60000 node truck_test.mjs out_bike '.absr.' > truck_bike.log 2>&1
TIMEOUT=30000 node truck_test.mjs out '.absr+wrap.' > truck_wrap.log 2>&1
export BIN=mtruck_spike/target/release/mtruck_spike TAG=mtruck
TIMEOUT=30000 node truck_test.mjs out '.absr.' > mtruck_absr.log 2>&1
TIMEOUT=60000 node truck_test.mjs out_bike '.absr.' > mtruck_bike.log 2>&1
unset BIN TAG
node truck_wasm.mjs out; node truck_wasm.mjs out_bike         # WASM timing
node mtruck_wasm.mjs out; node mtruck_wasm.mjs out_bike
```

On 2026-10-17, the first `truck_test.mjs` command reproduced `truck_absr.log` line for line apart from timings.
`truck_test.mjs` rewrites the `*_results_*.json` file for its `TAG`, so the reproduction check restored the committed
one afterwards.

### 5. Area across backends

```sh
node area3.mjs out out_bike        # needs step 3 (final_Os) and both native Rust binaries; writes area3.json
```
