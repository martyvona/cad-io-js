#!/usr/bin/env bash
# Build SMLib and its SM_API layer (NVIDIA's usd-brep, third_party/usd-brep, fetched by third_party/pull.sh) as one
# static library, with oneTBB replaced by the serial stand-in in native/tbb/. Output: build/smlib-<target>/libsmlib.a.
#   T=wasm (default; Emscripten, -Os, WebAssembly exceptions as build.sh links) or T=native (the host's compiler, -O2,
#     for the probe and checks)
#   J=<parallel jobs> (default 4)
# Objects are rebuilt only when older than their source.
set -euo pipefail
cd "$(dirname "$0")"
T=${T:-wasm}
J=${J:-4}
S=../../third_party/usd-brep/source
[ -d "$S/SMLib/src" ] || { echo "no SMLib source at $S: run third_party/pull.sh" >&2; exit 1; }
case $T in
  wasm)
    command -v em++ >/dev/null || source "${EMSDK:-$HOME/emsdk}/emsdk_env.sh" >/dev/null 2>&1
    CXX=em++; AR=emar; OPT=(-Os -fwasm-exceptions) ;;
  native) CXX=c++; AR=ar; OPT=(-O2) ;;
  *) echo "T must be wasm or native" >&2; exit 1 ;;
esac
B=build/smlib-$T
mkdir -p "$B/obj"
# -w: SMLib's sources warn heavily under clang; its own build silences most of them too.
# Each library's own inc/ first: both have a StdAfx.h, and SM_API's declares more.
FLAGS=(-std=c++17 "${OPT[@]}" -DNDEBUG -DNOMINMAX -DSM_API_EXPORTS -w -Inative)
export CXX B S
export FLAGS_STR="${FLAGS[*]}"
ls "$S"/SMLib/src/*.cpp "$S"/SM_API/src/*.cpp | grep -v '/StdAfx\.cpp$' | xargs -P "$J" -n 1 sh -c '
  src=$1; o=$B/obj/$(basename $(dirname $(dirname $src)))_$(basename $src .cpp).o
  if [ ! -f "$o" ] || [ "$src" -nt "$o" ]; then
    lib=$(basename $(dirname $(dirname $src)))
    if [ $lib = SM_API ]; then inc="-I$S/SM_API/inc -I$S/SMLib/inc"; else inc="-I$S/SMLib/inc -I$S/SM_API/inc"; fi
    $CXX $FLAGS_STR $inc -c "$src" -o "$o" || { echo "FAILED $src" >&2; exit 255; }; fi' _
rm -f "$B/libsmlib.a"
$AR rcs "$B/libsmlib.a" "$B"/obj/*.o
ls -la "$B/libsmlib.a"
