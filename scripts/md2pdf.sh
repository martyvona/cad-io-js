#!/usr/bin/env bash

# Markdown to PDF with Typst, styled by md2pdf.typ beside this script (which says how documents are written for it).
# The Markdown stays the source: GitHub and browser Markdown viewers (e.g. https://github.com/simov/markdown-viewer,
# with its Mermaid and MathJax options on) render it as it is, and only the PDF is built. Typst and its packages are
# fetched once, pinned, by fetch-typst.sh into third_party/typst/; only Typst's own fonts are used, so the PDF is the
# same on every machine. The input must be inside the repository (Typst reads files only under its root).
#   scripts/md2pdf.sh in.md [out.pdf]   (default: in.pdf beside in.md)

script_dir="$(cd -P "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
root="$(cd "$script_dir/.." && pwd)"
typst_dir="$root/third_party/typst"

if [ $# -lt 1 ]; then
  echo "USAGE: md2pdf.sh in.md [out.pdf]"
  exit 1
fi
in="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
out=${2:-${1%.*}.pdf}
case "$in" in
  "$root"/*) ;;
  *) echo "md2pdf.sh: $1 is outside the repository ($root)" >&2; exit 1 ;;
esac

[ -x "$typst_dir/bin/typst" ] || "$script_dir/fetch-typst.sh" || exit 1
"$typst_dir/bin/typst" compile --root "$root" --package-cache-path "$typst_dir/packages" --ignore-system-fonts \
  --input md="${in#"$root"}" "$script_dir/md2pdf.typ" "$out"
