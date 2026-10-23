#!/usr/bin/env bash
# Fetch the pinned Typst compiler and the Typst packages scripts/md2pdf.sh uses, into third_party/typst/ (git-ignored):
# the official release binary for this platform (bin/typst) and the packages, unpacked as Typst's package cache lays
# them out (packages/preview/<name>/<version>/), so md2pdf.sh never downloads anything itself. Every download is
# checked against its SHA-256. Running it again does nothing if everything is in place; to move to new versions,
# change the pins here (third_party/README.md, "Typst").
#   scripts/fetch-typst.sh
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
dest=$here/../third_party/typst

VERSION=0.15.1
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) target=aarch64-apple-darwin
    sum=48f62ed034aa3a7978309579ac6ca00045e2ef0da73114e8af27cfd8e74dc05a ;;
  Darwin-x86_64) target=x86_64-apple-darwin
    sum=7f9fdd9584866245de9a79e0add8f9236fae6f40a8a45e2c4771ccc14db4e0fa ;;
  Linux-x86_64) target=x86_64-unknown-linux-musl
    sum=a6d077d0a95eed5a2eba715b2dae06be954f624ccbf85758a03f389ded33118c ;;
  Linux-aarch64 | Linux-arm64) target=aarch64-unknown-linux-musl
    sum=5aa8d74a3d906e60ea12a66ac2f37f8eef1b14cbad7182a745e393a10c23dcee ;;
  *) echo "fetch-typst.sh: no pinned Typst build for $(uname -s) $(uname -m)" >&2; exit 1 ;;
esac
# name version sha256 (of packages.typst.org/preview/<name>-<version>.tar.gz)
PACKAGES=(
  "cmarker 0.1.10 7e5d7a0365aa1d32273bddb4511c62e47ab9d63093c905184ba04ca62064aafc"
  "mitex 0.2.7 0159e214845e49cbdc332d9d572da112dae5ad248072e0a7680d38c8307c2e15"
  "merman 0.5.0 9906dafa634d600306349751d9792c4384a4d7d033da39d843873694795326c1"
)

sha256() {
  if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
# fetch <url> <file> <sha256>
fetch() {
  curl -fsSL -o "$2" "$1"
  local got
  got=$(sha256 "$2")
  if [ "$got" != "$3" ]; then echo "fetch-typst.sh: $1: SHA-256 $got, expected $3" >&2; exit 1; fi
}

if [ "$("$dest/bin/typst" --version 2>/dev/null | cut -d' ' -f2)" != "$VERSION" ]; then
  echo "Typst $VERSION ($target)"
  fetch "https://github.com/typst/typst/releases/download/v$VERSION/typst-$target.tar.xz" "$tmp/typst.tar.xz" "$sum"
  tar -xJf "$tmp/typst.tar.xz" -C "$tmp"
  mkdir -p "$dest/bin"
  mv "$tmp/typst-$target/typst" "$dest/bin/typst"
fi
for p in "${PACKAGES[@]}"; do
  read -r name version psum <<< "$p"
  dir=$dest/packages/preview/$name/$version
  [ -f "$dir/typst.toml" ] && continue
  echo "@preview/$name:$version"
  fetch "https://packages.typst.org/preview/$name-$version.tar.gz" "$tmp/$name.tar.gz" "$psum"
  rm -rf "$dir"
  mkdir -p "$dir"
  tar -xzf "$tmp/$name.tar.gz" -C "$dir"
done
"$dest/bin/typst" --version
