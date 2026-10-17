#!/usr/bin/env bash
# Build the OCCT toolkits for one optimization variant:
#   occt_variant_build.sh <name> "<release flags>" ["<extra cxx flags>"] [overlay=1]
# JOBS sets the build parallelism (default: the number of CPUs).
# overlay=1 copies phase0_tessellation_spike/occt_overlay/*.pxx over the generated include stubs after configure.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
command -v em++ >/dev/null || source "${EMSDK:-$HOME/emsdk}/emsdk_env.sh" >/dev/null 2>&1  # as in env.sh at the repo root
NAME=$1; REL=$2; EXTRA=${3:-}; OVERLAY=${4:-0}
D=$HERE/occt-build-$NAME
mkdir -p "$D" && cd "$D"
emcmake cmake "$HERE/../third_party/OCCT" -G "Unix Makefiles" -DCMAKE_BUILD_TYPE=Release -DBUILD_LIBRARY_TYPE=Static \
  -DINSTALL_DIR="$D-install" -DBUILD_MODULE_Draw=OFF -DUSE_FREETYPE=OFF -DUSE_TK=OFF -DUSE_TCL=OFF -DUSE_GLES2=OFF -DUSE_OPENGL=OFF \
  -DBUILD_GTEST=OFF -DBUILD_DOC_Overview=OFF \
  -DCMAKE_CXX_FLAGS="-fwasm-exceptions -UOCC_CONVERT_SIGNALS $EXTRA" -DCMAKE_C_FLAGS="-fwasm-exceptions -UOCC_CONVERT_SIGNALS $EXTRA" \
  -DCMAKE_CXX_FLAGS_RELEASE="$REL -DNDEBUG" -DCMAKE_C_FLAGS_RELEASE="$REL -DNDEBUG" > configure.log 2>&1
if [ "$OVERLAY" = 1 ]; then
  for f in "$HERE"/occt_overlay/*.pxx; do cp "$f" include/opencascade/; done
fi
start=$(date +%s)
cmake --build . --target TKDESTEP TKMesh -j"${JOBS:-$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)}" > build.log 2>&1
echo "$NAME built in $(( $(date +%s) - start )) s"
