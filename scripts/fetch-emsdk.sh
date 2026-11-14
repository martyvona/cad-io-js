#!/usr/bin/env bash
# Fetch the pinned Emscripten SDK into third_party/emsdk/ (git-ignored): emsdk at a pinned commit, then Emscripten
# VERSION installed and activated inside it. emsdk's config there names its tools relative to itself, so nothing goes
# outside the directory and no shell profile is touched. env.sh and the OCCT, truck and SMLib build scripts use this SDK
# (scripts/emsdk-env.sh), whatever emcc a shell already has, so every host compiles with the same Emscripten, clang
# and binaryen (whose wasm-opt also optimizes truck's module). Running it again does nothing if VERSION is in place;
# to move to a new version, change the pins here (third_party/README.md).
#   scripts/fetch-emsdk.sh
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
dest=$here/../third_party/emsdk

# emsdk's commit pins its manifest, so the archives it downloads for VERSION.
COMMIT=708dcbcc9ee23bc7d2dad44fc90db377e38b771c
VERSION=6.0.12

if [ "$(tr -d '"' 2>/dev/null < "$dest/upstream/emscripten/emscripten-version.txt")" = "$VERSION" ] &&
  [ "$(git -C "$dest" rev-parse -q --verify HEAD 2>/dev/null)" = "$COMMIT" ]; then
  exit 0
fi
if [ ! -d "$dest/.git" ]; then
  git init --quiet "$dest"
  git -C "$dest" remote add origin https://github.com/emscripten-core/emsdk.git
fi
if [ "$(git -C "$dest" rev-parse -q --verify HEAD || true)" != "$COMMIT" ]; then
  echo "emsdk ${COMMIT:0:10}"
  git -C "$dest" fetch --quiet --depth 1 origin "$COMMIT"
  git -C "$dest" checkout --quiet --detach FETCH_HEAD
fi
echo "Emscripten $VERSION (about 1.7 GB)"
cd "$dest"
./emsdk install "$VERSION"
./emsdk activate "$VERSION" > /dev/null
