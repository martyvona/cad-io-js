#!/usr/bin/env bash
# Build OCCT's static toolkits (TKDESTEP, TKMesh and their dependencies) for Emscripten, from ../../third_party/OCCT
# (third_party/pull.sh) with our patches (occt_patches/*.patch, in name order), into build/occt-<name>/, for build.sh
# to link against. About 6-12 minutes on 10 cores; after a patch changes, minutes (only the files it touches).
# The patched source is build/occt-src/, a git worktree of the pinned checkout, reset to it and patched afresh on
# every run, so third_party/OCCT stays as fetched; a patch that no longer applies stops the build. The patches applied
# are listed in build/occt-<name>/patches.txt, which build.sh compiles into the module (its version names them).
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
OCCT=$(cd "$HERE/../../third_party/OCCT" && pwd)
SRC=$HERE/build/occt-src
# Emscripten's environment, as in env.sh at the repo root.
command -v em++ >/dev/null || source "${EMSDK:-$HOME/emsdk}/emsdk_env.sh" >/dev/null 2>&1
NAME=${1:-Os}; REL=${2:--Os}; EXTRA=${3:-}; OVERLAY=${4:-0}
D=$HERE/build/occt-$NAME

# The patched source: reset to the pinned commit (rewriting only files that differ, so make rebuilds only those),
# then each patch applied, or the build stops.
[ -e "$SRC/.git" ] || git -C "$OCCT" worktree add --detach "$SRC" HEAD >/dev/null
git -C "$SRC" reset --quiet --hard "$(git -C "$OCCT" rev-parse HEAD)"
git -C "$SRC" clean -fdq
mkdir -p "$D"
: > "$D/patches.txt"
for p in "$HERE"/occt_patches/*.patch; do
  [ -e "$p" ] || continue
  git -C "$SRC" apply "$p" || { echo "$(basename "$p") no longer applies to OCCT $(git -C "$OCCT" rev-parse \
    --short HEAD)" >&2; exit 1; }
  basename "$p" .patch >> "$D/patches.txt"
done

# A build directory configured from another source (as before build/occt-src existed) can't be reused.
if [ -f "$D/CMakeCache.txt" ] && ! grep -q "^CMAKE_HOME_DIRECTORY:INTERNAL=$SRC\$" "$D/CMakeCache.txt"; then
  echo "$D was configured from another source: building it afresh" >&2
  find "$D" -mindepth 1 ! -name patches.txt -delete
fi
cd "$D"
emcmake cmake "$SRC" -G "Unix Makefiles" -DCMAKE_BUILD_TYPE=Release \
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
