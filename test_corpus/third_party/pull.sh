#!/usr/bin/env bash
# Fetch the third-party test corpus into this directory, or update it if it's already here.
# - Git repositories are shallow-cloned, then fast-forwarded on later runs.
# - NIST packages are zip downloads. Each is extracted into nist-pmi-models/<name>/, and the server's Last-Modified
#   header is kept in nist-pmi-models/.<name>.last-modified; a package is downloaded again only when that changes.
# Usage: test_corpus/third_party/pull.sh (from any directory)
set -euo pipefail
cd "$(dirname "$0")"

git_repo() { # <dir> <url>
  local dir=$1 url=$2
  if [[ -d $dir/.git ]]; then
    echo "== $dir: updating"
    git -C "$dir" pull --ff-only --quiet
  else
    echo "== $dir: cloning $url"
    git clone --quiet --depth 1 "$url" "$dir"
  fi
  echo "   at $(git -C "$dir" log -1 --format='%h %cs')"
}

nist_zip() { # <name> <slug>: https://www.nist.gov/document/<slug> redirects to <name>.zip
  local name=$1 url=https://www.nist.gov/document/$2
  local root=nist-pmi-models
  local stamp=$root/.$name.last-modified
  mkdir -p "$root"
  local remote
  remote=$(curl -fsSIL "$url" | tr -d '\r' | awk 'tolower($1) == "last-modified:" { sub(/^[^:]*: */, ""); lm = $0 } END { print lm }')
  if [[ -d $root/$name && -f $stamp && $(cat "$stamp") == "$remote" ]]; then
    echo "== $root/$name: up to date ($remote)"
    return
  fi
  echo "== $root/$name: downloading ($remote)"
  local tmp
  tmp=$(mktemp -d "$root/.tmp.XXXXXX")
  curl -fsSL -o "$tmp/$name.zip" "$url"
  unzip -q "$tmp/$name.zip" -d "$tmp/$name"
  rm -rf "${root:?}/$name"
  mv "$tmp/$name" "$root/$name"
  rm -rf "$tmp"
  printf '%s\n' "$remote" > "$stamp"
}

git_repo gkv311-opencascade-dataset https://github.com/gkv311/opencascade-dataset.git
git_repo occt-import-js https://github.com/kovacsv/occt-import-js.git

nist_zip NIST-PMI-STEP-Files nist-pmi-step-files
nist_zip NIST_MBE_PMI_FTC_Definitions nist-ftc-test-case-definitions
nist_zip NIST_MBE_PMI_CTC_Definitions nist-ctc-test-case-definitions
nist_zip NIST-STC-PMI-v4 nist-stc-pmi-v4
nist_zip NIST-FTC-CTC-PMI-CAD-models nist-ftc-ctc-pmi-cad-models
nist_zip NIST-HTC-PMI-v2 nist-htc-pmi-cad-models
nist_zip NIST-MTC-Assembly nist-cad-models-mtc-assembly
nist_zip NIST-D2MI-Models nist-d2mi-modelszip
