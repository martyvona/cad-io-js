#!/usr/bin/env bash
# Fetch the third-party dependencies into this directory at their pinned versions, or bring existing checkouts to
# those versions. To move a dependency to a new version, change its pin below and run this again.
# - Git repositories: shallow fetch of the pinned commit, checked out detached. A checkout with local changes is
#   left alone, with a warning.
# - MBx-IF recommended practices, the JT specifications and the QIF and IGES standards: each file is downloaded if
#   missing. New versions have new URLs. The JT, QIF and IGES PDFs also get a text version (.txt beside each, for
#   searching), extracted with pypdf (pinned, so the output is reproducible) in a local virtual environment, .venv/,
#   which needs python3 with the venv module; without it the PDFs are fetched and the text skipped, with a note.
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
# The 3MF specifications (Markdown), for the 3MF importer and exporter: core 1.4.0, the Materials extension 1.2.1 and
# the Production extension 1.2.0 (their release tags).
git_dep 3mf/spec_core https://github.com/3MFConsortium/spec_core.git 997b385e06f3181cf9aae0c578e0b45ccd48ccb2
git_dep 3mf/spec_materials https://github.com/3MFConsortium/spec_materials.git d4d42dd75ca07da40284dc87e3204b2993d2f862
git_dep 3mf/spec_production https://github.com/3MFConsortium/spec_production.git \
  e7b7a5ab7051d1957789ff849233c1a731f1d38f

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

# QIF (ISO 23952), for a QIF importer. The ANSI QIF 3.0 standard, free from DMSC (the ISO text is the same and
# paywalled): the PDF and its XSD schemas, unzipped into qif/standard/.
QIF_ZIP=QIF3.0-2018-ANSI.zip
if [[ ! -f qif/standard/QIF3.0-2018-ANSI.pdf ]]; then
  download qif/standard "https://qifstandards.org/wp-content/uploads/2014/08/$QIF_ZIP"
  (cd qif/standard && unzip -q -o "$QIF_ZIP" && rm "$QIF_ZIP")
fi
# DMSC's community repository (Boost licence): the same XSDs (bindings/CPP-Kramer/schema/), sample QIF files of the
# NIST test models (samples/NISTmodels/) and test data (bindings/CPP-Kramer/data/).
git_dep qif/qif-community https://github.com/QualityInformationFramework/qif-community.git \
  64268c175a3058d09db29c14869b94b781518709

# IGES 5.3 (1996), the last version, for an IGES importer: US PRO's free download, gone with US PRO (2006), so the
# Internet Archive's copy.
download iges https://web.archive.org/web/20120821190122id_/http://www.uspro.org/documents/IGES5-3_forDownload.pdf

# FreeCAD (.FCStd), for an importer of its assembly tree, shapes and appearance. No specification exists beyond the
# wiki (CC BY 3.0; each page pinned to a revision, saved as wikitext; the wiki rate-limits, hence the retries) and the
# source; sample documents from FreeCAD's repository (LGPL-2.1-or-later) at a pinned commit. OCCT's BREP format,
# which FreeCAD stores each shape in, is specified in OCCT/dox/specification/brep_format.md (ASCII only).
for page in File_Format_FCStd:1850338 Std_Part:1874955 Std_LinkMake:1857884 Assembly_Workbench:1865502; do
  f=freecad/wiki/${page%%:*}.wiki
  [[ -f $f ]] && continue
  echo "== $f: downloading"
  mkdir -p freecad/wiki
  curl -fsSL --retry 5 --retry-delay 10 -o "$f.part" "https://wiki.freecad.org/index.php?oldid=${page#*:}&action=raw"
  mv "$f.part" "$f"
  sleep 2
done
FC=https://raw.githubusercontent.com/FreeCAD/FreeCAD/b64d77b867ebf3a1277f5f8b4235a3b666bc53a2
for f in data/examples/AssemblyExample.FCStd data/examples/EngineBlock.FCStd data/examples/PartDesignExample.FCStd \
  tests/src/Mod/PartDesign/App/TestModels/ModelFromV021.FCStd; do
  download freecad/samples "$FC/$f"
done

# Text versions of the JT, QIF and IGES PDFs (one "=== PAGE n ===" header per page).
PYPDF=6.21.0
PDFS=(jt/*.pdf qif/standard/*.pdf iges/*.pdf)
missing=0
for pdf in "${PDFS[@]}"; do [[ -f ${pdf%.pdf}.txt ]] || missing=1; done
[[ $missing == 1 ]] || exit 0
if ! python3 -c 'import venv' 2>/dev/null; then
  echo "== no python3 with venv; text versions of the PDFs skipped (see env.sh)" >&2
  exit 0
fi
if [[ ! -x .venv/bin/python ]] ||
  ! .venv/bin/python -c "import pypdf, sys; sys.exit(pypdf.__version__ != '$PYPDF')" 2>/dev/null; then
  echo "== .venv: installing pypdf $PYPDF"
  python3 -m venv .venv
  .venv/bin/python -m pip install --quiet --disable-pip-version-check "pypdf==$PYPDF"
fi
for pdf in "${PDFS[@]}"; do
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
