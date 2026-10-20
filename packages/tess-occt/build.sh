#!/usr/bin/env bash
# Build the OCCT tessellation backend: compile native/occt_tess.cpp and link it against OCCT's static toolkits,
# built for Emscripten with -Os by ../../phase0_tessellation_spike/occt_variant_build.sh (see that directory's
# README.md, which also lists the build's gotchas). Output: dist/occt_tess.mjs and dist/occt_tess.wasm.
#   B=<OCCT build dir>  default ../../phase0_tessellation_spike/occt-build-Os
set -e
command -v em++ >/dev/null || source "${EMSDK:-$HOME/emsdk}/emsdk_env.sh" >/dev/null 2>&1  # as in env.sh at the repo root
cd "$(dirname "$0")"
B=${B:-../../phase0_tessellation_spike/occt-build-Os}
[ -d "$B/include/opencascade" ] || { echo "no OCCT build at $B: run phase0_tessellation_spike/occt_variant_build.sh Os -Os" >&2; exit 1; }
LIBS=("$B"/lin32/clang/lib/lib*.a)
mkdir -p dist build
EXPORTS='["_occt_tessellate","_occt_positions","_occt_normals","_occt_num_vertices","_occt_indices","_occt_num_indices","_occt_faces","_occt_num_faces","_occt_diag","_occt_free","_occt_set_mesh_options","_occt_edge_positions","_occt_num_edge_points","_occt_edges","_occt_edge_angles","_occt_num_edges","_occt_curve_positions","_occt_num_curve_points","_occt_curves","_occt_num_curves","_occt_points","_occt_point_ids","_occt_num_points","_malloc","_free"]'
em++ -Os -fwasm-exceptions -std=c++17 -I"$B/include/opencascade" -c native/occt_tess.cpp -o build/occt_tess.o
em++ -Os -fwasm-exceptions build/occt_tess.o -Wl,--start-group "${LIBS[@]}" -Wl,--end-group -o dist/occt_tess.mjs \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=occtTess -sENVIRONMENT=web,worker,node \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=32MB -sSTACK_SIZE=4MB \
  -sEXPORTED_FUNCTIONS="$EXPORTS" -sEXPORTED_RUNTIME_METHODS='["HEAPU8","HEAPF32","HEAPU32","HEAP32","HEAPF64","UTF8ToString"]'
ls -la dist/occt_tess.wasm dist/occt_tess.mjs
