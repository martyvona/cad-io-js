#!/usr/bin/env bash

# Publishes the demo models (test_corpus/demo/, recursively) without building the viewer: updates the catalog
# (demo-catalog.ts), commits test_corpus/demo/ (only it, if anything there changed: models added, changed or removed)
# and pushes the branch, then force-pushes gh-pages as deploy-viewer.sh made it with content/demo/ replaced by what's
# committed. The deployed app stays as it is (its version too, so the viewer's update badge doesn't show).
#   scripts/deploy-demo.sh [--dry-run]   (--dry-run: update the catalog, build and commit the site in a temporary
#                                        directory from the demo directory as it is; commit and push nothing)

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
  *) echo "USAGE: deploy-demo.sh [--dry-run]" >&2; exit 1 ;;
esac
cd "$root"

git fetch --quiet "$remote"
if ! git rev-parse --verify --quiet "$remote/$branch" > /dev/null; then
  echo "deploy-demo.sh: no $branch on $remote; deploy the viewer first (deploy-viewer.sh)" >&2
  exit 1
fi
# (Commits already on the branch but not on the remote would be pushed with the demo models.)
if [ "$dry" = 0 ] && [ -n "$(git rev-list '@{upstream}..HEAD')" ]; then
  echo "deploy-demo.sh: $(git rev-parse --abbrev-ref HEAD) has unpushed commits; push them first" >&2
  exit 1
fi

node scripts/demo-catalog.ts
if [ "$dry" = 0 ]; then
  git add -A -- "$demo"
  if ! git diff --cached --quiet -- "$demo"; then
    git commit --quiet -m "Demo models updated" -m "$(git diff --cached --name-status -- "$demo")" -- "$demo"
    git push --quiet "$remote" HEAD
    echo "committed and pushed $(git rev-parse --short HEAD)"
  fi
fi

out="$(mktemp -d "${TMPDIR:-/tmp}/cad-viewer-demo.XXXXXX")"
site="$out/site"
mkdir -p "$site" "$out/demo"
git archive "$remote/$branch" | tar -x -C "$site"
rm -rf "$site/content/demo"
mkdir -p "$site/content"
if [ "$dry" = 1 ]; then
  cp -R "$demo" "$site/content/demo"
else
  git archive HEAD "$demo" | tar -x -C "$out/demo"
  mv "$out/demo/$demo" "$site/content/demo"
fi
built="$(git log -1 --format=%s "$remote/$branch" | sed -E 's/;.*//')"
from="$(git rev-parse HEAD)"
git -C "$site" init --quiet -b "$branch"
git -C "$site" add -A
git -C "$site" commit --quiet -m "$built; demo models from $from"
# (The same tree, the same files: a push would only start a Pages run for nothing.)
if [ "$(git -C "$site" rev-parse 'HEAD^{tree}')" = "$(git rev-parse "$remote/$branch^{tree}")" ]; then
  rm -rf "$out"
  echo "$branch already has these demo models; nothing pushed"
  exit 0
fi
if [ "$dry" = 1 ]; then
  echo "built and committed in $site; not pushed"
  exit 0
fi

url="$(git remote get-url "$remote")"
git -C "$site" push --force --quiet "$url" "$branch"
rm -rf "$out"
echo "pushed $branch (the app as deployed, the demo models from $from); Pages serves them in a few minutes"
