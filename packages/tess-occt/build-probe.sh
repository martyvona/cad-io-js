#!/usr/bin/env bash
# Build the OCCT probe for checks (native/occt_probe.cpp: OCCT's points on a representation's faces and edges at given
# parameters, read without shape processing, or built by the native builder, native/occt_build.cpp, unhealed), not
# part of the library: compiled and linked against the same OCCT static toolkits as build.sh. Output:
# dist/occt_probe.mjs and dist/occt_probe.wasm.
#   B=<OCCT build dir>  default build/occt-Os
set -e
command -v em++ >/dev/null || source "${EMSDK:-$HOME/emsdk}/emsdk_env.sh" >/dev/null 2>&1
cd "$(dirname "$0")"
B=${B:-build/occt-Os}
[ -d "$B/include/opencascade" ] || { echo "no OCCT build at $B: run build-occt.sh" >&2; exit 1; }
LIBS=("$B"/lin32/clang/lib/lib*.a)
mkdir -p dist build
EXPORTS='["_occt_probe_read","_occt_probe_faces","_occt_probe_num_faces","_occt_probe_edges",'\
'"_occt_probe_num_edges","_occt_probe_diag","_occt_probe_eval","_occt_probe_free","_occt_probe_build","_malloc",'\
'"_free"]'
# (-DNo_Exception as OCCT's libraries and build.sh.)
for f in occt_probe occt_build; do
  em++ -Os -fwasm-exceptions -std=c++17 -DNo_Exception -I"$B/include/opencascade" -I../cad-brep/include \
    -c native/$f.cpp -o build/$f-probe.o
done
em++ -Os -fwasm-exceptions build/occt_probe-probe.o build/occt_build-probe.o -Wl,--start-group "${LIBS[@]}" -Wl,--end-group -o dist/occt_probe.mjs \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=occtProbe -sENVIRONMENT=node \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=32MB -sSTACK_SIZE=4MB \
  -sEXPORTED_FUNCTIONS="$EXPORTS" -sEXPORTED_RUNTIME_METHODS='["HEAPU8","HEAPF64","UTF8ToString"]'
ls -la dist/occt_probe.wasm dist/occt_probe.mjs
