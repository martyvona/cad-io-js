#!/usr/bin/env bash
# usage: run.sh <occt build dir> <out name>; writes <out name>.txt
set -e
# Emscripten's environment, as in env.sh at the repo root.
command -v em++ >/dev/null || source "${EMSDK:-$HOME/emsdk}/emsdk_env.sh" >/dev/null 2>&1
cd "$(dirname "$0")"
B=$1; OUT=$2
em++ -Os -fwasm-exceptions -std=c++17 -I"$B/include/opencascade" appcont_test.cpp \
  -Wl,--start-group "$B"/lin32/clang/lib/lib*.a -Wl,--end-group \
  -sALLOW_MEMORY_GROWTH=1 -sSTACK_SIZE=4MB -o "$OUT.mjs"
node -e "import(\"./$OUT.mjs\").then((m) => m.default())" > "$OUT.txt" 2> "$OUT.err"
