#!/usr/bin/env bash
# Build the SMLib tessellation backend: compile native/smlib_tess.cpp (the wrapper) and native/smlib_build.cpp (the
# builder) and link them against SMLib built for Emscripten by build-smlib.sh. Output: dist/smlib_tess.mjs and
# dist/smlib_tess.wasm.
#   D=<output directory>  default dist
set -e
command -v em++ >/dev/null || source "${EMSDK:-$HOME/emsdk}/emsdk_env.sh" >/dev/null 2>&1
cd "$(dirname "$0")"
S=../../third_party/usd-brep/source
L=build/smlib-wasm/libsmlib.a
[ -f $L ] || { echo "no SMLib build at $L: run build-smlib.sh" >&2; exit 1; }
D=${D:-dist}
mkdir -p "$D" build
EXPORTS='["_smlib_tessellate_model","_smlib_set_measures","_smlib_set_heal","_smlib_set_scale","_smlib_set_edges",'\
'"_smlib_positions","_smlib_normals","_smlib_num_vertices","_smlib_indices","_smlib_num_indices","_smlib_faces",'\
'"_smlib_num_faces",'\
'"_smlib_edge_positions","_smlib_num_edge_points","_smlib_edges","_smlib_edge_angles","_smlib_num_edges",'\
'"_smlib_measures","_smlib_num_measures","_smlib_curve_positions","_smlib_num_curve_points",'\
'"_smlib_curves","_smlib_num_curves","_smlib_points","_smlib_point_ids","_smlib_num_points","_smlib_diag",'\
'"_smlib_free","_malloc","_free"]'
for f in smlib_tess smlib_build; do
  em++ -Os -fwasm-exceptions -std=c++17 -DNDEBUG -DNOMINMAX -w -Inative -I../cad-brep/include -I$S/SM_API/inc \
    -I$S/SMLib/inc -c native/$f.cpp -o build/$f.o
done
em++ -Os -fwasm-exceptions build/smlib_tess.o build/smlib_build.o $L -o "$D"/smlib_tess.mjs \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=smlibTess -sENVIRONMENT=web,worker,node \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=32MB -sMAXIMUM_MEMORY=4GB -sSTACK_SIZE=4MB \
  -sEXPORTED_FUNCTIONS="$EXPORTS" \
  -sEXPORTED_RUNTIME_METHODS='["HEAPU8","HEAPF32","HEAPU32","HEAP32","HEAPF64","UTF8ToString"]'
ls -la "$D"/smlib_tess.wasm "$D"/smlib_tess.mjs
