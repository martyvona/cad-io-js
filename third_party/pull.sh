#!/usr/bin/env bash
# Fetch the third-party dependencies into this directory at their pinned versions, or bring existing checkouts to
# those versions. To move a dependency to a new version, change its pin below and run this again.
# - Git repositories: shallow fetch of the pinned commit, checked out detached. A checkout with local changes is
#   left alone, with a warning.
# - MBx-IF recommended practices: each file is downloaded if missing. New versions have new URLs.
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
# The truck tessellation backend, and the monstertruck fork evaluated in phase 0.
git_dep truck https://github.com/ricosjp/truck.git 88ed005249e5e3a6b07f62425399435905cd3ab6
git_dep monstertruck https://github.com/virtualritz/monstertruck.git d2ad1ed7aa420b7f32cd2c1e3ad319b46d593652

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
