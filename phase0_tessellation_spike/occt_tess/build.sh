#!/usr/bin/env bash
# Compile + link the spike wrapper against the static OCCT toolkits built in ../occt-build-Os (or $B).
set -e
command -v em++ >/dev/null || source "${EMSDK:-$HOME/emsdk}/emsdk_env.sh" >/dev/null 2>&1  # as in env.sh at the repo root
cd "$(dirname "$0")"
B=${B:-../occt-build-Os}
OUT=${OUT:-occt_tess}
LIBS=("$B"/lin32/clang/lib/lib*.a)
OPT=${OPT:--Os}
LINKOPT=${LINKOPT:-$OPT}
EXPORTS='["_occt_tessellate","_occt_positions","_occt_normals","_occt_num_vertices","_occt_indices","_occt_num_indices","_occt_faces","_occt_num_faces","_occt_diag","_occt_free","_occt_set_mesh_options","_occt_edge_positions","_occt_num_edge_points","_occt_edges","_occt_edge_angles","_occt_num_edges","_malloc","_free"]'
em++ $OPT -fwasm-exceptions -std=c++17 -I"$B/include/opencascade" -c occt_tess.cpp -o "$OUT.o"
em++ $LINKOPT -fwasm-exceptions "$OUT.o" -Wl,--start-group "${LIBS[@]}" -Wl,--end-group -o "$OUT.mjs" \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=occtTess -sENVIRONMENT=web,worker,node \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=32MB -sSTACK_SIZE=4MB \
  -sEXPORTED_FUNCTIONS="$EXPORTS" -sEXPORTED_RUNTIME_METHODS='["HEAPU8","HEAPF32","HEAPU32","HEAP32","UTF8ToString"]'
ls -la "$OUT.wasm" "$OUT.mjs"
