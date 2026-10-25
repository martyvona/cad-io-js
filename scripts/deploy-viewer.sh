#!/usr/bin/env bash

# Deploys the viewer to GitHub Pages from this machine (the user, 2026-10-25; CLAUDE.md, "The viewer"): builds it
# (packages/viewer, with the backends' WebAssembly modules as built here, which git doesn't hold) from a clean commit
# that is already on the remote, so the source the build's licenses.md points to is public, and force-pushes the
# build as the only commit of the gh-pages branch (history doesn't grow by the build's 12 MB each time). .nojekyll
# keeps Pages from dropping files whose names start with "_". Pages must be set to deploy from the gh-pages branch,
# its root (the repository's Settings, Pages), once.
#   scripts/deploy-viewer.sh [--dry-run]   (--dry-run: build and commit, print where, don't push; unpushed allowed)

set -euo pipefail
script_dir="$(cd -P "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
root="$(cd "$script_dir/.." && pwd)"
remote=origin
branch=gh-pages

dry=0
case "${1:-}" in
  --dry-run) dry=1 ;;
  "") ;;
  *) echo "USAGE: deploy-viewer.sh [--dry-run]" >&2; exit 1 ;;
esac
cd "$root"

for f in packages/tess-occt/dist/occt_tess.wasm packages/tess-occt/dist/occt_tess.mjs \
  packages/tess-truck/dist/tess_truck.wasm; do
  [ -f "$f" ] || { echo "deploy-viewer.sh: no $f (packages/tess-occt/build.sh, packages/tess-truck/build.sh)" >&2;
    exit 1; }
done
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "deploy-viewer.sh: uncommitted changes; commit or stash them first" >&2
  exit 1
fi
commit="$(git rev-parse HEAD)"
if [ "$dry" = 0 ]; then
  git fetch --quiet "$remote"
  if ! git branch -r --contains "$commit" | grep -v "$remote/$branch\$" | grep -q .; then
    echo "deploy-viewer.sh: $commit isn't on $remote yet; push it first" >&2
    exit 1
  fi
fi

out="$(mktemp -d "${TMPDIR:-/tmp}/cad-viewer-deploy.XXXXXX")"
site="$out/site"
(cd packages/viewer && node ../../node_modules/vite/bin/vite.js build --outDir "$site" --logLevel warn)
touch "$site/.nojekyll"
git -C "$site" init --quiet -b "$branch"
git -C "$site" add -A
git -C "$site" commit --quiet -m "cad-viewer, built from $commit"
if [ "$dry" = 1 ]; then
  echo "built and committed in $site; not pushed"
  exit 0
fi

url="$(git remote get-url "$remote")"
git -C "$site" push --force --quiet "$url" "$branch"
rm -rf "$out"
# git@github.com:owner/repo.git or https://github.com/owner/repo(.git) -> https://owner.github.io/repo/
slug="$(echo "$url" | sed -E 's#^(git@github\.com:|https://github\.com/)##; s#\.git$##')"
echo "pushed $branch (built from $commit);" \
  "Pages serves it at https://${slug%%/*}.github.io/${slug#*/}/ in a minute or so"
