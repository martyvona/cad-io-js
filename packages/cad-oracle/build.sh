#!/usr/bin/env bash
# Build cad-oracle's C++ (native/src/*.cpp), the oracle of exact measures, against cad-geom's library
# (packages/cad-geom/build.sh): build/cad-oracle-<target>/libcadoracle.a, headers in native/include/ (include as
# <cad_oracle/...>).
#   ./build.sh            the library; T=wasm (default: the project's Emscripten, -Os, WebAssembly exceptions) or
#                         T=native (the host's compiler, -O2)
#   ./build.sh module     the WebAssembly module src/index.ts loads: dist/cad_oracle.{mjs,wasm}, the C API of
#                         native/src/cad_oracle_api.cpp linked with cad-geom's wasm library
#   ./build.sh test       builds and runs native/test/*_test.cpp (one binary each, cad-geom's harness check.h)
#                         natively with AddressSanitizer and UBSan (cad-geom's sources compiled again with them) and
#                         as WebAssembly against cad-geom's wasm library, run by node
#   J=<parallel jobs> (default 4)
# Reproducible as cad-geom's, and the same results on every target (no fused multiply-adds): C collation, objects
# archived in sorted order without dates, no absolute paths compiled in, the pinned Emscripten. Every object is
# rebuilt each run.
set -euo pipefail
export LC_ALL=C ZERO_AR_DATE=1
cd "$(dirname "$0")"
ROOT=$(cd ../.. && pwd)
G=../cad-geom
E=$ROOT/third_party/eigen
J=${J:-4}
MODE=${1:-lib}
case $MODE in
  lib | module | test) ;;
  *) echo "usage: build.sh [module | test]" >&2; exit 2 ;;
esac
NODE=$(command -v node || true)
# -ffp-contract=off: no fused multiply-adds (clang fuses by default on arm64, WebAssembly can't), so every target
# computes the same.
COMMON=(-std=c++20 -Wall -Wextra -ffp-contract=off -Inative/include -I$G/native/include -I../cad-brep/include
  -isystem "$E" "-ffile-prefix-map=$ROOT/=cad-io-js/")
emsdk() { . ../../scripts/emsdk-env.sh "$ROOT"; }

# compile <out dir> <compiler> <flags...> -- <source>...: objects named by the source's path.
compile() {
  local out=$1 cxx=$2; shift 2
  local flags=(); while [ "$1" != -- ]; do flags+=("$1"); shift; done; shift
  rm -rf "$out"; mkdir -p "$out"
  [ $# -gt 0 ] || return 0
  printf '%s\n' "$@" | xargs -P "$J" -I{} sh -c '
    src=$1; shift; out=$1; shift; cxx=$1; shift
    o=$out/$(printf %s "$src" | tr / _ | sed "s/\.\.//g; s/\.cpp$//").o
    "$cxx" "$@" -c "$src" -o "$o" || { echo "FAILED $src" >&2; exit 255; }' _ {} "$out" "$cxx" "${flags[@]}"
}
srcs() { find native/src -name '*.cpp' | sort; }
gsrcs() { find $G/native/src -name '*.cpp' | sort; }

library() { # <target> <compiler> <archiver> <flags...>
  local t=$1 cxx=$2 ar=$3; shift 3
  local b=build/cad-oracle-$t
  compile "$b/obj" "$cxx" "$@" -- $(srcs)
  rm -f "$b/libcadoracle.a"
  local objs=("$b"/obj/*.o)
  if "$ar" --version 2>/dev/null | grep -qE 'GNU|LLVM'; then "$ar" rcsD "$b/libcadoracle.a" "${objs[@]}"
  else "$ar" rcs "$b/libcadoracle.a" "${objs[@]}"; fi
  echo "$PWD/$b/libcadoracle.a"
}

if [ "$MODE" = module ]; then
  # The sources' hash, taken before compiling and recorded beside the module once it is built, for
  # scripts/check-dist.ts (npm test refuses a module older than its sources).
  inputs=$(node ../../scripts/check-dist.ts --hash cad_oracle.wasm)
  rm -f dist/cad_oracle.wasm.inputs
  $G/build.sh > /dev/null
  names=$(grep -oE '^[a-z0-9_ ]*[ *]+co_[a-z0-9_]+\(' native/src/cad_oracle_api.cpp | grep -oE 'co_[a-z0-9_]+' |
    sort -u | sed 's/^/"_/; s/$/"/' | paste -sd, -)
  [ -n "$names" ] || { echo "no co_ functions in native/src/cad_oracle_api.cpp" >&2; exit 1; }
  mkdir -p dist
  (
    emsdk
    library wasm em++ emar -Os -fwasm-exceptions -DNDEBUG "${COMMON[@]}" > /dev/null
    em++ -Os -fwasm-exceptions build/cad-oracle-wasm/libcadoracle.a $G/build/cad-geom-wasm/libcadgeom.a \
      -o dist/cad_oracle.mjs -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=cadOracle -sENVIRONMENT=web,worker,node \
      -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=16MB -sMAXIMUM_MEMORY=4GB -sSTACK_SIZE=1MB \
      -sEXPORTED_FUNCTIONS="[$names,\"_malloc\",\"_free\"]" \
      -sEXPORTED_RUNTIME_METHODS='["HEAPU8","HEAP32","HEAPF64","UTF8ToString"]'
  )
  echo "$inputs" > dist/cad_oracle.wasm.inputs
  echo "$PWD/dist/cad_oracle.mjs"
  exit
fi

if [ "$MODE" = lib ]; then
  case ${T:-wasm} in
    wasm) (emsdk; library wasm em++ emar -Os -fwasm-exceptions -DNDEBUG "${COMMON[@]}") ;;
    native) library native c++ ar -O2 -DNDEBUG "${COMMON[@]}" ;;
    *) echo "T must be wasm or native" >&2; exit 1 ;;
  esac
  exit
fi

# test
[ -n "$NODE" ] || { echo "no node on PATH, needed to run the WebAssembly tests" >&2; exit 1; }
tests=$(find native/test -name '*_test.cpp' | sort)
[ -n "$tests" ] || { echo "no tests in native/test" >&2; exit 1; }
# cad-brep's test models (and the reference shapes) as a header, by cad-geom's generator, for the tests only.
"$NODE" $G/native/test/fixtures.ts build/test/fixtures/brep_models.h
TI=(-I$G/native/test -Ibuild/test/fixtures)
. $G/native/test/run.sh

SAN=(-O1 -g -fno-omit-frame-pointer -fsanitize=address,undefined -fno-sanitize-recover=all)
compile build/test/native/obj c++ "${SAN[@]}" "${COMMON[@]}" "${TI[@]}" -- $(gsrcs) $(srcs) $tests
# cad-geom's vendored C as its build.sh compiles it: as C (cad-geom's native/third_party/README.md), sanitized alike.
CSAN=(-O1 -g -fno-omit-frame-pointer -fsanitize=address,undefined -fno-sanitize-recover=all -std=gnu11 -w
  -ffp-contract=off "-ffile-prefix-map=$ROOT/=cad-io-js/")
rm -rf build/test/native/obj-c; mkdir -p build/test/native/obj-c
for c in $(find $G/native/third_party -name '*.c' | sort); do
  cc "${CSAN[@]}" -c "$c" -o "build/test/native/obj-c/$(basename "$c" .c).o"
done
for t in $tests; do
  n=$(basename "$t" .cpp)
  objs="$(ls build/test/native/obj/*.o | grep -v '_test\.o$') $(ls build/test/native/obj-c/*.o 2> /dev/null)"
  c++ "${SAN[@]}" $objs "build/test/native/obj/$(printf %s "$t" | tr / _ | sed 's/\.cpp$//').o" \
    -o "build/test/native/$n"
  run "native $n" "build/test/native/$n"
done

$G/build.sh > /dev/null
(
  emsdk
  compile build/test/wasm/obj em++ -Os -fwasm-exceptions "${COMMON[@]}" "${TI[@]}" -- $(srcs) $tests
  echo '{"type": "commonjs"}' > build/test/wasm/package.json
  for t in $tests; do
    n=$(basename "$t" .cpp)
    objs=$(ls build/test/wasm/obj/*.o | grep -v '_test\.o$')
    em++ -Os -fwasm-exceptions $objs "build/test/wasm/obj/$(printf %s "$t" | tr / _ | sed 's/\.cpp$//').o" \
      $G/build/cad-geom-wasm/libcadgeom.a -o "build/test/wasm/$n.js" -sENVIRONMENT=node -sEXIT_RUNTIME=1 \
      -sALLOW_MEMORY_GROWTH=1 -sSTACK_SIZE=1MB
  done
)
for t in $tests; do
  n=$(basename "$t" .cpp)
  run "wasm $n" "$NODE" "build/test/wasm/$n.js"
done
[ $fail = 0 ] && echo "== all passed" || { echo "== FAILED" >&2; exit 1; }
