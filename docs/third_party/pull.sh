#!/usr/bin/env bash
# Fetch the third-party reference documents into this directory, and extract their text for searching.
# Files already present are kept. The text is extracted with pypdf (pinned, so the output is reproducible), installed
# into a local virtual environment, .venv/, which needs python3 with the venv module (see env.sh at the repo root).
# Usage: docs/third_party/pull.sh (from any directory)
set -euo pipefail
cd "$(dirname "$0")"
PYPDF=6.21.0

fetch() { # <url> [file name]
  local url=$1 file=${2:-$(basename "$1")}
  [[ -f $file ]] && return
  echo "== $file: downloading"
  curl -fsSL -o "$file.part" "$url"
  mv "$file.part" "$file"
}

# JT File Format Reference v9.5 Rev A. Siemens no longer hosts it; this copy is on the cad.de forum.
fetch "https://ww3.cad.de/foren/ubb/uploads/Rainer+Schulze/JT_v95_File_Format_Reference_Rev-A_tcm73-111987.pdf"
# JT File Format Reference v10 Rev B.
fetch "https://www.plm.automation.siemens.com/en_us/Images/JT-v10-file-format-reference-rev-B_tcm1023-233786.pdf"
# JT V10.6 Format Description Rev D (10 Feb 2026), with the PMI property strings list, as one zip.
V106="Siemens JT V10.6 Format Description Rev D 10 Feb 2026.pdf"
if [[ ! -f $V106 || ! -f PMIPropertiesStrings_alphabetic_list-JT_V10_6.xlsx ]]; then
  fetch "https://static.sw.cdn.siemens.com/media/published/4Zc4NsBnmaFlEd0mtssp7f/siemens-jt-v-10-6-file-format-reference-rev-d-10-feb-2026.zip" jt-v10.6.zip
  unzip -q -o jt-v10.6.zip
  rm jt-v10.6.zip
fi

# Text versions (one "=== PAGE n ===" header per page).
missing=0
for pdf in *.pdf; do [[ -f ${pdf%.pdf}.txt ]] || missing=1; done
[[ $missing == 1 ]] || exit 0
if [[ ! -x .venv/bin/python ]] || ! .venv/bin/python -c "import pypdf, sys; sys.exit(pypdf.__version__ != '$PYPDF')" 2>/dev/null; then
  echo "== .venv: installing pypdf $PYPDF"
  python3 -m venv .venv
  .venv/bin/python -m pip install --quiet --disable-pip-version-check "pypdf==$PYPDF"
fi
for pdf in *.pdf; do
  txt=${pdf%.pdf}.txt
  [[ -f $txt ]] && continue
  echo "== $txt: extracting"
  .venv/bin/python -I - "$pdf" "$txt.part" <<'PY' 2>/dev/null
import sys
from pypdf import PdfReader
r = PdfReader(sys.argv[1])
with open(sys.argv[2], "w") as out:
    for i, p in enumerate(r.pages):
        out.write(f"\n=== PAGE {i+1} ===\n")
        try: out.write(p.extract_text() or "")
        except Exception as e: out.write(f"[extract error {e}]")
PY
  mv "$txt.part" "$txt"
done
