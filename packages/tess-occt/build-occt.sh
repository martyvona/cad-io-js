#!/usr/bin/env bash
# Build OCCT's static toolkits (TKDESTEP, TKMesh and their dependencies) for Emscripten, from ../../third_party/OCCT
# (third_party/pull.sh), into build/occt-<name>/, for build.sh to link against. About 6–12 minutes on 10 cores.
#   build-occt.sh [<name> "<release flags>" ["<extra cxx flags>"] [overlay=1]]   default: Os "-Os"
# JOBS sets the build parallelism (default: the number of CPUs).
# overlay=1 copies occt_overlay/*.pxx over the generated include stubs after configure (the VBernstein table
# computed instead of stored: 1.71 instead of 2.18 MB brotli; not used (CLAUDE.md, "Decisions"); see
# occt_overlay/README.md).
# Gotchas (CLAUDE.md, "OCCT"):
#   - -UOCC_CONVERT_SIGNALS, or the link produces invalid WASM;
#   - CMAKE_CXX_FLAGS_RELEASE set, or OCCT forces -O3; -Os it is, as -O2, -O3 and LTO buy no speed;
#   - a build directory can't be moved (CMake keeps absolute paths): delete it and build again.
# Grown from phase 0's occt_variant_build.sh (phase0_tessellation_spike/ at tag V0.1.0).
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
# Emscripten's environment, as in env.sh at the repo root.
command -v em++ >/dev/null || source "${EMSDK:-$HOME/emsdk}/emsdk_env.sh" >/dev/null 2>&1
NAME=${1:-Os}; REL=${2:--Os}; EXTRA=${3:-}; OVERLAY=${4:-0}
D=$HERE/build/occt-$NAME
mkdir -p "$D" && cd "$D"
emcmake cmake "$HERE/../../third_party/OCCT" -G "Unix Makefiles" -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_LIBRARY_TYPE=Static -DINSTALL_DIR="$D-install" -DBUILD_MODULE_Draw=OFF \
  -DUSE_FREETYPE=OFF -DUSE_TK=OFF -DUSE_TCL=OFF -DUSE_GLES2=OFF -DUSE_OPENGL=OFF \
  -DBUILD_GTEST=OFF -DBUILD_DOC_Overview=OFF \
  -DCMAKE_CXX_FLAGS="-fwasm-exceptions -UOCC_CONVERT_SIGNALS $EXTRA" \
  -DCMAKE_C_FLAGS="-fwasm-exceptions -UOCC_CONVERT_SIGNALS $EXTRA" \
  -DCMAKE_CXX_FLAGS_RELEASE="$REL -DNDEBUG" -DCMAKE_C_FLAGS_RELEASE="$REL -DNDEBUG" > configure.log 2>&1
if [ "$OVERLAY" = 1 ]; then
  for f in "$HERE"/occt_overlay/*.pxx; do cp "$f" include/opencascade/; done
fi
start=$(date +%s)
cmake --build . --target TKDESTEP TKMesh -j"${JOBS:-$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)}" \
  > build.log 2>&1
echo "$NAME built in $(( $(date +%s) - start )) s"
