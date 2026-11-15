#!/usr/bin/env bash
# Build cad-geom's C++ (native/src/**/*.cpp) as a static library that other packages compile into their own modules:
# build/cad-geom-<target>/libcadgeom.a, with its headers in native/include/ (include as <cad_geom/...>) and Eigen's
# from third_party/eigen (third_party/pull.sh).
#   ./build.sh            the library; T=wasm (default: the project's Emscripten, -Os, WebAssembly exceptions, as
#                         tess-smlib links) or T=native (the host's compiler, -O2)
#   ./build.sh test       builds and runs native/test/*_test.cpp (one binary each, harness native/test/check.h)
#                         twice: natively with AddressSanitizer and UBSan (build/test/native/<name>, the sources
#                         compiled again with them), and as WebAssembly against the wasm library, run by node
#                         (build/test/wasm/<name>.js); then checks that the Eigen guard trips on planted includes
#   ./build.sh guard <dependency file>...   the Eigen guard alone (test/native.test.ts runs it)
#   J=<parallel jobs> (default 4)
# The Eigen guard: every compile writes its dependencies (-MD), and any Eigen header outside the allowed modules
# fails the build, naming it. Eigen 5 has no EIGEN_MPL2_ONLY any more; the allowed modules are MPL-2.0 (BFloat16.h in
# Core is Apache-2.0, AlignedBox::transform BSD), unsupported/ and the *Support bridges to outside libraries are not.
# Reproducible: C collation (a glob's order is the archive's), objects archived in sorted order without dates, no
# absolute paths compiled in (-ffile-prefix-map), the pinned Emscripten. Every object is rebuilt each run.
set -euo pipefail
export LC_ALL=C ZERO_AR_DATE=1
cd "$(dirname "$0")"
ROOT=$(cd ../.. && pwd)
E=$ROOT/third_party/eigen
J=${J:-4}
MODE=${1:-lib}
# The Eigen modules (Eigen/<name>, their sources Eigen/src/<name>/) sources may include; Core's own includes
# (Version, src/misc, src/plugins) are allowed with it.
ALLOW="Core Dense LU Cholesky QR SVD Eigenvalues Geometry Householder Jacobi"

guard() { # <dependency file>...: fails naming the first header of each module outside $ALLOW, per file
  awk -v E="$E/" -v D="$PWD/" -v allow="$ALLOW" '
    BEGIN { n = split(allow " Version misc plugins", a, " "); for (i = 1; i <= n; i++) ok[a[i]] = 1 }
    FNR == 1 { delete seen }
    {
      for (f = 1; f <= NF; f++) {
        t = $f
        if (t == "\\" || t ~ /:$/) continue
        # Absolute and normalized: compilers keep a path as it was reached ("src/Core/../plugins/", relative).
        if (substr(t, 1, 1) != "/") t = D t
        m = split(t, p, "/"); k = 0
        for (i = 1; i <= m; i++) {
          if (p[i] == "..") { if (k > 0) k-- } else if (p[i] != "." && p[i] != "") r[++k] = p[i]
        }
        t = ""; for (i = 1; i <= k; i++) t = t "/" r[i]
        if (index(t, E) != 1) continue
        k = split(substr(t, length(E) + 1), q, "/")
        rel = substr(t, length(E) + 1)
        good = q[1] == "Eigen" && ((k == 2 && ok[q[2]]) || (k >= 4 && q[2] == "src" && ok[q[3]]))
        mod = q[1] != "Eigen" ? q[1] "/" q[2] : q[2] == "src" ? "Eigen/" q[3] : "Eigen/" q[2]
        if (!good && !(mod in seen)) {
          seen[mod] = 1; bad = 1
          printf "Eigen guard: %s includes %s, outside the allowed modules (Eigen/ %s)\n", FILENAME, rel, allow \
            > "/dev/stderr"
        }
      }
    }
    END { exit bad }' "$@"
}

case $MODE in
  guard) shift; [ $# -gt 0 ] || { echo "usage: build.sh guard <dependency file>..." >&2; exit 2; }; guard "$@"; exit ;;
  lib | test) ;;
  *) echo "usage: build.sh [test | guard <dependency file>...]" >&2; exit 2 ;;
esac
[ -f "$E/Eigen/Core" ] || { echo "no Eigen at $E: run third_party/pull.sh" >&2; exit 1; }
NODE=$(command -v node || true)

# cad_brep.h, which the headers include, from cad-brep (its layout.ts generates it).
COMMON=(-std=c++20 -Wall -Wextra -Inative/include -I../cad-brep/include -isystem "$E"
  "-ffile-prefix-map=$ROOT/=cad-io-js/")
emsdk() {
  # The project's Emscripten (scripts/emsdk-env.sh), whatever emcc the shell has.
  . ../../scripts/emsdk-env.sh "$ROOT"
}

# compile <out dir> <compiler> <flags...> -- <source>...: objects named by the source's path, then the guard on their
# dependency files.
compile() {
  local out=$1 cxx=$2; shift 2
  local flags=(); while [ "$1" != -- ]; do flags+=("$1"); shift; done; shift
  rm -rf "$out"; mkdir -p "$out"
  [ $# -gt 0 ] || return 0
  printf '%s\n' "$@" | xargs -P "$J" -I{} sh -c '
    src=$1; shift; out=$1; shift; cxx=$1; shift
    o=$out/$(printf %s "$src" | tr / _ | sed "s/\.cpp$//").o
    "$cxx" "$@" -MD -MF "${o%.o}.d" -c "$src" -o "$o" || { echo "FAILED $src" >&2; exit 255; }' \
    _ {} "$out" "$cxx" "${flags[@]}"
  guard "$out"/*.d
}

# library <target> <compiler> <archiver> <flags...>: build/cad-geom-<target>/libcadgeom.a
library() {
  local t=$1 cxx=$2 ar=$3; shift 3
  local b=build/cad-geom-$t
  mkdir -p "$b"
  compile "$b/obj" "$cxx" "$@" -- $(find native/src -name '*.cpp' | sort)
  rm -f "$b/libcadgeom.a"
  local objs=("$b"/obj/*.o)
  [ -e "${objs[0]}" ] || { echo "no sources in native/src" >&2; exit 1; }
  # D: no dates or owners in the archive (GNU ar's and llvm-ar's flag; ZERO_AR_DATE for macOS's ar).
  if "$ar" --version 2>/dev/null | grep -qE 'GNU|LLVM'; then "$ar" rcsD "$b/libcadgeom.a" "${objs[@]}"
  else "$ar" rcs "$b/libcadgeom.a" "${objs[@]}"; fi
  echo "$PWD/$b/libcadgeom.a"
}

wasm_lib() { (emsdk; library wasm em++ emar -Os -fwasm-exceptions -DNDEBUG "${COMMON[@]}"); }
native_lib() { library native c++ ar -O2 -DNDEBUG "${COMMON[@]}"; }

if [ "$MODE" = lib ]; then
  case ${T:-wasm} in
    wasm) wasm_lib ;;
    native) native_lib ;;
    *) echo "T must be wasm or native" >&2; exit 1 ;;
  esac
  exit
fi

# test
[ -n "$NODE" ] || { echo "no node on PATH, needed to run the WebAssembly tests" >&2; exit 1; }
tests=$(find native/test -name '*_test.cpp' | sort)
# cad-brep's test models as buffers in a header (native/test/fixtures.ts), for the tests only.
"$NODE" native/test/fixtures.ts build/test/fixtures/brep_models.h
FIX=(-Ibuild/test/fixtures)
[ -n "$tests" ] || { echo "no tests in native/test" >&2; exit 1; }
fail=0
run() { # <name> <command...>: runs one test binary, its output as it comes
  local name=$1; shift
  echo "== $name"
  "$@" || { echo "== $name: exit $?" >&2; fail=1; }
}

# Natively, the library's sources compiled again with the sanitizers; -fno-sanitize-recover makes UB exit nonzero.
SAN=(-O1 -g -fno-omit-frame-pointer -fsanitize=address,undefined -fno-sanitize-recover=all)
compile build/test/native/obj c++ "${SAN[@]}" "${COMMON[@]}" "${FIX[@]}" -- $(find native/src -name '*.cpp' | sort) \
  $tests
srcobjs=$(find native/src -name '*.cpp' | sort | tr / _ | sed 's/\.cpp$/.o/; s|^|build/test/native/obj/|')
for t in $tests; do
  n=$(basename "$t" .cpp)
  c++ "${SAN[@]}" $srcobjs "build/test/native/obj/$(printf %s "$t" | tr / _ | sed 's/\.cpp$//').o" \
    -o "build/test/native/$n"
  run "native $n" "build/test/native/$n"
done

# As WebAssembly, against the library as other packages link it.
wasm_lib > /dev/null
(
  emsdk
  compile build/test/wasm/obj em++ -Os -fwasm-exceptions "${COMMON[@]}" "${FIX[@]}" -- $tests
  # Plain scripts that run main (Emscripten makes an .mjs a module factory), CommonJS in an ES module package.
  echo '{"type": "commonjs"}' > build/test/wasm/package.json
  for t in $tests; do
    n=$(basename "$t" .cpp)
    em++ -Os -fwasm-exceptions "build/test/wasm/obj/$(printf %s "$t" | tr / _ | sed 's/\.cpp$//').o" \
      build/cad-geom-wasm/libcadgeom.a -o "build/test/wasm/$n.js" -sENVIRONMENT=node -sEXIT_RUNTIME=1 \
      -sALLOW_MEMORY_GROWTH=1 -sSTACK_SIZE=1MB
  done
)
for t in $tests; do
  n=$(basename "$t" .cpp)
  run "wasm $n" "$NODE" "build/test/wasm/$n.js"
done

# The guard on planted includes: each must trip it, and the allowed modules must not.
g=build/test/guard
rm -rf "$g"; mkdir -p "$g"
probe() { # <name> <header>: the dependencies of a file including <header> (-MG: its outside libraries are absent)
  printf '#include <%s>\n' "$2" > "$g/$1.cpp"
  c++ -std=c++20 -isystem "$E" -M -MG "$g/$1.cpp" > "$g/$1.d"
}
probe allowed Eigen/Dense
guard "$g/allowed.d" || { echo "== guard: Eigen/Dense refused" >&2; fail=1; }
for h in unsupported/Eigen/AutoDiff Eigen/MetisSupport Eigen/Sparse; do
  probe planted "$h"
  if guard "$g/planted.d" 2> /dev/null; then echo "== guard: $h not refused" >&2; fail=1
  else echo "== guard: refuses $h"; fi
done

[ $fail = 0 ] && echo "== all passed" || { echo "== FAILED" >&2; exit 1; }
