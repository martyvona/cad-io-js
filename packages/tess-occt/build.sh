#!/usr/bin/env bash
# Build the OCCT tessellation backend: compile native/occt_tess.cpp and link it against OCCT's static toolkits,
# built for Emscripten with -Os by build-occt.sh (which lists the build's gotchas), with its list of our OCCT patches
# compiled in (occt_patches(), named in the backend's version). Output: dist/occt_tess.mjs and dist/occt_tess.wasm.
#   B=<OCCT build dir>  default build/occt-Os
set -e
# Emscripten's environment, as in env.sh at the repo root.
command -v em++ >/dev/null || source "${EMSDK:-$HOME/emsdk}/emsdk_env.sh" >/dev/null 2>&1
cd "$(dirname "$0")"
B=${B:-build/occt-Os}
[ -d "$B/include/opencascade" ] || { echo "no OCCT build at $B: run build-occt.sh" >&2; exit 1; }
LIBS=("$B"/lin32/clang/lib/lib*.a)
mkdir -p dist build
EXPORTS='["_occt_tessellate","_occt_positions","_occt_normals","_occt_num_vertices","_occt_indices",'\
'"_occt_num_indices","_occt_faces","_occt_num_faces","_occt_diag","_occt_free","_occt_set_mesh_options",'\
'"_occt_edge_positions","_occt_num_edge_points","_occt_edges","_occt_edge_angles","_occt_num_edges",'\
'"_occt_curve_positions","_occt_num_curve_points","_occt_curves","_occt_num_curves","_occt_points",'\
'"_occt_point_ids","_occt_num_points","_occt_patches","_occt_face_areas","_occt_outline_positions",'\
'"_occt_num_outline_points","_occt_outlines","_occt_num_outlines","_malloc","_free"]'
# The patches the libraries were built with, comma-separated (build-occt.sh writes them; none before it did).
PATCHES=$(paste -sd, - < "$B/patches.txt" 2>/dev/null || true)
em++ -Os -fwasm-exceptions -std=c++17 -I"$B/include/opencascade" -DOCCT_PATCHES="\"$PATCHES\"" \
  -c native/occt_tess.cpp -o build/occt_tess.o
em++ -Os -fwasm-exceptions build/occt_tess.o -Wl,--start-group "${LIBS[@]}" -Wl,--end-group -o dist/occt_tess.mjs \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=occtTess -sENVIRONMENT=web,worker,node \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=32MB -sSTACK_SIZE=4MB \
  -sEXPORTED_FUNCTIONS="$EXPORTS" \
  -sEXPORTED_RUNTIME_METHODS='["HEAPU8","HEAPF32","HEAPU32","HEAP32","HEAPF64","UTF8ToString"]'
ls -la dist/occt_tess.wasm dist/occt_tess.mjs
