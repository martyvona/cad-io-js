#!/usr/bin/env bash
# Build the truck tessellation backend: native/ (a Rust crate over ../../third_party/truck, fetched by
# ../../third_party/pull.sh) for wasm32-unknown-unknown, then wasm-opt. Output: dist/tess_truck.wasm.
# Rust is the version rust-toolchain.toml at the repository's root pins (rustup installs it), wasm-opt the project's
# Emscripten SDK's (third_party/emsdk, scripts/fetch-emsdk.sh), so every host builds the same module.
set -e
[ -f "$HOME/.cargo/env" ] && source "$HOME/.cargo/env"
cd "$(dirname "$0")"
[ -d ../../third_party/truck/truck-stepio ] || { echo "no truck checkout: run third_party/pull.sh" >&2; exit 1; }
mkdir -p dist build
# The sources' hash, taken before compiling and recorded beside the module once it is built, for
# scripts/check-dist.ts (npm test refuses a module older than its sources).
INPUTS=$(node ../../scripts/check-dist.ts --hash tess_truck.wasm)
rm -f dist/tess_truck.wasm.inputs
ROOT=$(cd ../.. && pwd)
WASM_OPT=$ROOT/third_party/emsdk/upstream/bin/wasm-opt
[ -x "$WASM_OPT" ] || { echo "no $WASM_OPT: run scripts/fetch-emsdk.sh" >&2; exit 1; }
# Panic locations name source files: mapped to fixed prefixes, so the module doesn't depend on where the repository
# and cargo's home are.
(cd native && CARGO_TARGET_DIR=../build/target RUSTFLAGS="--remap-path-prefix=$ROOT=/cad-io-js \
  --remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/cargo" \
  cargo build --release --locked --target wasm32-unknown-unknown)
OUT=build/target/wasm32-unknown-unknown/release/tess_truck.wasm
"$WASM_OPT" -O "$OUT" -o dist/tess_truck.wasm
ls -la dist/tess_truck.wasm
echo "$INPUTS" > dist/tess_truck.wasm.inputs
