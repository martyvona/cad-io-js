#!/usr/bin/env bash

# Deploys the viewer to GitHub Pages from this machine (docs/claude/viewer.md): builds it (packages/viewer, with the
# backends' WebAssembly modules as built here, which git doesn't hold) from a clean commit that is already on the
# remote, so the source the build's licenses.md points to is public, and force-pushes the build as the only commit of
# the gh-pages branch (history doesn't grow by the build's 12 MB each time). .nojekyll keeps Pages from dropping files
# whose names start with "_". The demo models (test_corpus/demo/, the user's own) go in content/demo/, the build's
# content root, so ?model=demo/<file> and Load URL... with demo/<file> work there as on the dev server; the service
# worker doesn't precache them (they're fetched when asked for). The first deploy creates the branch; then, once, set
# Pages to deploy from it, its root (the repository's Settings, Pages), which can't be chosen before it exists. The demo
# models must be committed (deploy-demo.sh commits and publishes them alone); their catalog (demo-catalog.ts) is updated
# first, and committed and pushed if it changed.
#   scripts/deploy-viewer.sh [--dry-run]   (--dry-run: build and commit, print where, don't push; unpushed allowed; the
#                                          catalog updated but not committed)

set -euo pipefail
script_dir="$(cd -P "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
root="$(cd "$script_dir/.." && pwd)"
remote=origin
branch=gh-pages
demo=test_corpus/demo

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
if [ -n "$(git status --porcelain --untracked-files=no -- . ":!$demo/catalog.json")" ]; then
  echo "deploy-viewer.sh: uncommitted changes; commit or stash them first" >&2
  exit 1
fi
# (The catalog lists the directory as it is, and the build gets what's committed: they must agree.)
if [ -n "$(git status --porcelain -- "$demo" ":!$demo/catalog.json")" ]; then
  echo "deploy-viewer.sh: uncommitted demo models in $demo; commit them, or publish them with deploy-demo.sh" >&2
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
node scripts/demo-catalog.ts
if [ "$dry" = 0 ] && [ -n "$(git status --porcelain -- "$demo/catalog.json")" ]; then
  git add -- "$demo/catalog.json"
  git commit --quiet -m "Demo catalog updated" -- "$demo/catalog.json"
  git push --quiet "$remote" HEAD
  echo "committed and pushed $(git rev-parse --short HEAD) (the demo catalog)"
  commit="$(git rev-parse HEAD)"
fi

out="$(mktemp -d "${TMPDIR:-/tmp}/cad-viewer-deploy.XXXXXX")"
site="$out/site"
(cd packages/viewer && node ../../node_modules/vite/bin/vite.js build --outDir "$site" --logLevel warn)
touch "$site/.nojekyll"
mkdir -p "$site/content"
if [ "$dry" = 1 ]; then
  cp -R "$demo" "$site/content/demo"
else
  mkdir -p "$out/demo"
  git archive HEAD "$demo" | tar -x -C "$out/demo"
  mv "$out/demo/$demo" "$site/content/demo"
fi
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
  "Pages serves it at https://${slug%%/*}.github.io/${slug#*/}/ in a minute or so" \
  "(the first time: Settings, Pages, deploy from the $branch branch, its root)"
