#!/usr/bin/env bash
# Fetch the third-party dependencies into this directory at their pinned versions, or bring existing checkouts to
# those versions. To move a dependency to a new version, change its pin below and run this again.
# - Git repositories: shallow fetch of the pinned commit, checked out detached. A checkout with local changes is
#   left alone, with a warning.
# - MBx-IF recommended practices and the JT specifications: each file is downloaded if missing. New versions have
#   new URLs. The JT PDFs also get a text version (.txt beside each, for searching), extracted with pypdf (pinned, so
#   the output is reproducible) in a local virtual environment, jt/.venv/, which needs python3 with the venv module;
#   without it the PDFs are fetched and the text skipped, with a note.
# Usage: third_party/pull.sh (from any directory)
set -euo pipefail
cd "$(dirname "$0")"

git_dep() { # <dir> <url> <commit>
  local dir=$1 url=$2 commit=$3
  if [[ ! -d $dir/.git ]]; then
    echo "== $dir: cloning $url at ${commit:0:10}"
    git init --quiet "$dir"
    git -C "$dir" remote add origin "$url"
  fi
  if [[ $(git -C "$dir" rev-parse -q --verify HEAD || true) == "$commit" ]]; then
    echo "== $dir: at ${commit:0:10}"
    return
  fi
  if [[ -n $(git -C "$dir" status --porcelain) ]]; then
    echo "== $dir: has local changes, not moved to ${commit:0:10}" >&2
    return
  fi
  echo "== $dir: fetching ${commit:0:10}"
  git -C "$dir" fetch --quiet --depth 1 origin "$commit"
  git -C "$dir" checkout --quiet --detach FETCH_HEAD
}

download() { # <dir> <url>
  local dir=$1 url=$2 file
  file=$dir/$(basename "$url")
  mkdir -p "$dir"
  [[ -f $file ]] && return
  echo "== $file: downloading"
  curl -fsSL -o "$file.part" "$url"
  mv "$file.part" "$file"
}

# Source for the custom Emscripten build of the OCCT tessellation backend.
git_dep OCCT https://github.com/Open-Cascade-SAS/OCCT.git 3d097a0328e71b826377d4814ab05ec3c3d23871
# EXPRESS schemas (data/) for packages/step-schemas (npm run gen -w step-schemas).
git_dep stepcode https://github.com/stepcode/stepcode.git 24783b448511b8f6bce2829286a3f00015430236
# The truck tessellation backend.
git_dep truck https://github.com/ricosjp/truck.git 88ed005249e5e3a6b07f62425399435905cd3ab6

# CAx-IF / MBx-IF recommended practices (https://www.mbx-if.org/home/cax/recpractices/).
U=https://www.mbx-if.org/home/wp-content/uploads
for f in 2024/05/pdmug_release4_3.pdf 2024/05/rec_prac_3dtess_geo_v11.pdf 2024/05/rec_prac_ext_ref_v31.pdf \
  2024/05/rec_prac_file_compression_v13.pdf 2024/05/rec_prac_gvp_v46.pdf 2024/05/rec_prac_polyline_pres_v23.pdf \
  2024/05/rec_prac_unicode_strings_v1_20230425.pdf 2024/05/rec_prac_user_def_attributes_v18.pdf \
  2024/06/gen_guidelines_v21.pdf 2024/06/rec_pracs_pmi_v41.pdf 2025/09/rec_prac_suppl_geo_v13.pdf \
  2025/10/rec_prac_alt_shapes_v1.pdf 2025/10/rec_prac_ap242xml_assy_struct_v4.0.pdf \
  2025/10/rec_prac_ap242xml_kinematics_v1.3.pdf 2026/01/Rec_Pracs_Composites_V4.4.pdf \
  2026/02/PID_trace_TEST8.zip 2026/02/rec_prac_cross-domain_exchange_v10.pdf 2026/03/PID_Trace_TEST7.zip \
  2026/03/rec_pracs_PID_v1.8.pdf 2026/06/rec_prac_val_prop_composite_v10.pdf 2026/08/rec_prac_styling_org_v1.10.pdf; do
  download mbx-if-recpractices "$U/$f"
done

# Siemens JT file format references, for a JT importer (not redistributable: see README.md).
# v9.5 Rev A: Siemens no longer hosts it; this copy is on the cad.de forum. v10 Rev B. V10.6 Rev D (10 Feb 2026), with
# the PMI property strings list, as one zip.
download jt https://ww3.cad.de/foren/ubb/uploads/Rainer+Schulze/JT_v95_File_Format_Reference_Rev-A_tcm73-111987.pdf
download jt https://www.plm.automation.siemens.com/en_us/Images/JT-v10-file-format-reference-rev-B_tcm1023-233786.pdf
JT106_PDF="Siemens JT V10.6 Format Description Rev D 10 Feb 2026.pdf"
JT106_ZIP=siemens-jt-v-10-6-file-format-reference-rev-d-10-feb-2026.zip
if [[ ! -f "jt/$JT106_PDF" || ! -f jt/PMIPropertiesStrings_alphabetic_list-JT_V10_6.xlsx ]]; then
  download jt "https://static.sw.cdn.siemens.com/media/published/4Zc4NsBnmaFlEd0mtssp7f/$JT106_ZIP"
  (cd jt && unzip -q -o "$JT106_ZIP" && rm "$JT106_ZIP")
fi

# Text versions of the JT PDFs (one "=== PAGE n ===" header per page).
PYPDF=6.21.0
missing=0
for pdf in jt/*.pdf; do [[ -f ${pdf%.pdf}.txt ]] || missing=1; done
[[ $missing == 1 ]] || exit 0
if ! python3 -c 'import venv' 2>/dev/null; then
  echo "== jt: no python3 with venv; text versions skipped (see env.sh)" >&2
  exit 0
fi
if [[ ! -x jt/.venv/bin/python ]] ||
  ! jt/.venv/bin/python -c "import pypdf, sys; sys.exit(pypdf.__version__ != '$PYPDF')" 2>/dev/null; then
  echo "== jt/.venv: installing pypdf $PYPDF"
  python3 -m venv jt/.venv
  jt/.venv/bin/python -m pip install --quiet --disable-pip-version-check "pypdf==$PYPDF"
fi
for pdf in jt/*.pdf; do
  txt=${pdf%.pdf}.txt
  [[ -f $txt ]] && continue
  echo "== $txt: extracting"
  jt/.venv/bin/python -I - "$pdf" "$txt.part" <<'PY' 2>/dev/null
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
