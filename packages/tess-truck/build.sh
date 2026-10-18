#!/usr/bin/env bash
# Build the truck tessellation backend: native/ (a Rust crate over ../../third_party/truck, fetched by
# ../../third_party/pull.sh) for wasm32-unknown-unknown, then wasm-opt. Output: dist/tess_truck.wasm.
#   WASM_OPT=<path>  default: wasm-opt on PATH, else the one wasm-pack downloaded; skipped (with a note) if none
set -e
[ -f "$HOME/.cargo/env" ] && source "$HOME/.cargo/env"
cd "$(dirname "$0")"
[ -d ../../third_party/truck/truck-stepio ] || { echo "no truck checkout: run third_party/pull.sh" >&2; exit 1; }
mkdir -p dist build
(cd native && CARGO_TARGET_DIR=../build/target cargo build --release --locked --target wasm32-unknown-unknown)
OUT=build/target/wasm32-unknown-unknown/release/tess_truck.wasm
WASM_OPT=${WASM_OPT:-$(command -v wasm-opt || ls "$HOME"/Library/Caches/.wasm-pack/wasm-opt-*/bin/wasm-opt "$HOME"/.cache/.wasm-pack/wasm-opt-*/bin/wasm-opt 2>/dev/null | head -1 || true)}
if [ -n "$WASM_OPT" ]; then
  "$WASM_OPT" -O "$OUT" -o dist/tess_truck.wasm
else
  echo "note: no wasm-opt found; dist/tess_truck.wasm is unoptimized" >&2
  cp "$OUT" dist/tess_truck.wasm
fi
ls -la dist/tess_truck.wasm
