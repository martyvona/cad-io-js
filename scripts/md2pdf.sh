#!/usr/bin/env bash

script_dir="$(cd -P "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"

# on OS X:
# brew install --cask basictex
# brew install pandoc
# brew install skim # optional; skim is a PDF viewer with good support for editing workflow

# the input document is written in github-flavored markdown
# it's intended to be viewable in the following ways
# * when served by github
# * as a local file in a web browser with a markdown extension, e.g. https://github.com/simov/markdown-viewer
# * when converted to PDF via pandoc with this script
# this script pre-processes the file to handle directives like PDFOFF, PDFON, etc

if [ $# -lt 1 ]; then
  echo "USAGE: md2pdf.sh in.md [out.pdf]"
  exit 1
fi

if [ $# -lt 2 ]; then
  out=${1%.*}.pdf 
else
  out=$2
fi

tmp=${1%.*}.tmp.md

rm -f $tmp

pdfon=true
while IFS= read -r line || [ "$line" ]; do # https://unix.stackexchange.com/a/7012
  if [[ "$line" =~ "PDFOFF" ]]; then pdfon=false; continue; 
  elif [[ "$line" =~ "PDFON" ]]; then pdfon=true; continue;
  elif [[ "$line" =~ "PDFBREAK" ]]; then printf '\pagebreak\n' >> $tmp; continue;
  elif [[ "$line" =~ "PDFTOC" ]]; then printf '\\tableofcontents\n' >> $tmp; continue;
  fi
  #https://unix.stackexchange.com/a/65819
  if [ "$pdfon" == "true" ]; then printf '%s\n' "$line" >> $tmp; fi
done < "$1"

pandoc -o $out -H $script_dir/md2pdf_preamble.tex -V geometry:margin=1in --number-sections --syntax-highlighting=idiomatic --variable colorlinks=true -V linkcolor=blue -V urlcolor=red -V toccolor=gray $tmp

rm -f $tmp
