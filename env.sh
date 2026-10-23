# no shebang, this script is designed only to be sourced

# cad-io-js development environment: checks that the tools this repository expects are installed and recent enough,
# and sets up their environment (Rust's ~/.cargo/env, Emscripten's emsdk_env.sh) in the current shell.
# Prints the commands to install or update anything that's missing or too old, for macOS or Linux.
#
# Usage: source env.sh    (bash or zsh; running it as a script only checks, since it can't change your shell)
#
# Minimum versions are known requirements where there is one (Node 24 from package.json, CMake 3.10 from OCCT, Rust
# 1.85 for edition 2024), and otherwise the versions the builds were validated with (Emscripten 6.0.12, wasm-pack
# 0.15.0).

script_dir="$(cd -P "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  script_name="${BASH_SOURCE[0]##*/}"
  echo "ERROR: you must source $script_name rather than executing it in a subshell"
  echo "e.g. \"source $script_dir/$script_name\""
  echo "aborting"
  exit 1
fi

if [ -n "${ZSH_VERSION:-}" ]; then
  case $ZSH_EVAL_CONTEXT in *:file*) _sj_sourced=1 ;; *) _sj_sourced=0 ;; esac
  eval '_sj_repo=${${(%):-%x}:A:h}'
elif [ -n "${BASH_VERSION:-}" ]; then
  if [ "${BASH_SOURCE[0]}" != "$0" ]; then _sj_sourced=1; else _sj_sourced=0; fi
  _sj_repo=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
else
  _sj_sourced=0
  _sj_repo=$(pwd)
fi

case $(uname -s) in
  Darwin) _sj_os=macos ;;
  Linux) _sj_os=linux ;;
  *) _sj_os=other ;;
esac
_sj_pkg=
if [ $_sj_os = linux ]; then
  if command -v apt-get >/dev/null 2>&1; then _sj_pkg=apt
  elif command -v dnf >/dev/null 2>&1; then _sj_pkg=dnf
  fi
fi

_sj_errors=0
_sj_warnings=0
_sj_fixes=

# First x.y[.z] in a command's output.
_sj_version() {
  "$@" 2>&1 | sed -n 's/^[^0-9]*\([0-9][0-9]*\.[0-9][0-9]*\(\.[0-9][0-9]*\)\{0,1\}\).*/\1/p' | head -n 1
}

# Whether version $1 >= $2.
_sj_ge() {
  awk -v a="$1" -v b="$2" 'BEGIN {
    split(a, x, "."); split(b, y, ".")
    for (i = 1; i <= 3; i++) { if (x[i] + 0 > y[i] + 0) exit 0; if (x[i] + 0 < y[i] + 0) exit 1 }
    exit 0 }'
}

_sj_fix() {
  _sj_fixes="$_sj_fixes$1
"
}

# A system package: <name> <macOS install> <apt package> <dnf package>.
_sj_fix_pkg() {
  case $_sj_os/$_sj_pkg in
    macos/*) _sj_fix "$2" ;;
    linux/apt) _sj_fix "sudo apt-get update && sudo apt-get install -y $3" ;;
    linux/dnf) _sj_fix "sudo dnf install -y $4" ;;
    *) _sj_fix "# install $1 with your system's package manager" ;;
  esac
}

# Report one tool: <error|warning> <name> <found version or empty> <minimum or empty> <what it's for>.
# Returns 0 if it's present and recent enough.
_sj_report() {
  if [ -z "$3" ]; then
    printf '  %-8s %-12s %s\n' "$(if [ $1 = error ]; then echo MISSING; else echo missing; fi)" "$2" "($5)"
  elif [ -n "$4" ] && ! _sj_ge "$3" "$4"; then
    printf '  %-8s %-12s %s\n' "$(if [ $1 = error ]; then echo TOO-OLD; else echo too-old; fi)" "$2" \
      "$3, need >= $4 ($5)"
  else
    printf '  %-8s %-12s %s\n' ok "$2" "$3"
    return 0
  fi
  if [ $1 = error ]; then _sj_errors=$((_sj_errors + 1)); else _sj_warnings=$((_sj_warnings + 1)); fi
  return 1
}

# Version of a command if it's on PATH, else empty.
_sj_have() {
  command -v "$1" >/dev/null 2>&1 && _sj_version "$@"
}

# --- Environment setup -------------------------------------------------------------------------------------------

# Rust: rustup's installer puts the tools in ~/.cargo/bin, added to PATH by ~/.cargo/env.
if ! command -v cargo >/dev/null 2>&1 && [ -f "${CARGO_HOME:-$HOME/.cargo}/env" ]; then
  . "${CARGO_HOME:-$HOME/.cargo}/env"
fi

# Node through nvm, if node isn't on PATH yet.
if ! command -v node >/dev/null 2>&1 && [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
  . "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
fi

# Emscripten: use the emsdk named by $EMSDK, else ~/emsdk, unless emcc is already set up.
_sj_emsdk=
if [ -n "${EMSDK:-}" ] && command -v emcc >/dev/null 2>&1; then
  _sj_emsdk=$EMSDK
elif [ -n "${EMSDK:-}" ] && [ -f "$EMSDK/emsdk_env.sh" ]; then
  _sj_emsdk=$EMSDK
elif ! command -v emcc >/dev/null 2>&1 && [ -f "$HOME/emsdk/emsdk_env.sh" ]; then
  _sj_emsdk=$HOME/emsdk
fi
if [ -n "$_sj_emsdk" ] && ! command -v emcc >/dev/null 2>&1; then
  EMSDK_QUIET=1 . "$_sj_emsdk/emsdk_env.sh" >/dev/null 2>&1
fi

# The workspace's tools (stepconv, step2json), which npm install links into node_modules/.bin. Appended, so the dev
# dependencies' tools there (tsc, ...) don't shadow ones already installed; added once however often this is sourced.
case ":$PATH:" in
  *":$_sj_repo/node_modules/.bin:"*) ;;
  *) PATH=$PATH:$_sj_repo/node_modules/.bin ;;
esac

# --- Checks ------------------------------------------------------------------------------------------------------

echo "cad-io-js environment ($_sj_os):"

# Core: needed for the packages, their tests and the fetch scripts.
_sj_report error node "$(_sj_have node --version)" 24.0.0 "runs the TypeScript sources and tests" || {
  case $_sj_os in
    macos) _sj_fix "brew install node    # or: brew upgrade node" ;;
    *) _sj_fix "curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash"\
" && . ~/.nvm/nvm.sh && nvm install 24" ;;
  esac
}
_sj_report error npm "$(_sj_have npm --version)" "" "workspaces, dev dependencies" ||
  _sj_fix "# npm comes with Node; reinstall Node (see above)"
_sj_report error git "$(_sj_have git --version)" 2.25.0 "third_party/pull.sh, test_corpus/third_party/pull.sh" ||
  _sj_fix_pkg git "xcode-select --install    # or: brew install git" git git
_sj_report error curl "$(_sj_have curl --version)" "" "downloads in the pull scripts" ||
  _sj_fix_pkg curl "brew install curl" curl curl
_sj_report error unzip "$(_sj_have unzip -v)" "" "NIST packages in test_corpus/third_party/pull.sh" ||
  _sj_fix_pkg unzip "brew install unzip" unzip unzip

# Native builds: the OCCT WebAssembly build and the Rust backends.
_sj_report error cmake "$(_sj_have cmake --version)" 3.10.0 "configures the OCCT build" ||
  _sj_fix_pkg cmake "brew install cmake    # or: brew upgrade cmake" cmake cmake
_sj_report error make "$(_sj_have make --version)" "" "builds OCCT (Unix Makefiles generator)" ||
  _sj_fix_pkg make "xcode-select --install" make make

_sj_emcc=$(_sj_have emcc --version)
_sj_report error emscripten "$_sj_emcc" 6.0.12 "compiles OCCT to WebAssembly${EMSDK:+; emsdk at $EMSDK}" || {
  _sj_d=${_sj_emsdk:-${EMSDK:-$HOME/emsdk}}
  if [ -f "$_sj_d/emsdk" ]; then
    _sj_fix "cd \"$_sj_d\" && git pull && ./emsdk install 6.0.12 && ./emsdk activate 6.0.12 && cd - && source env.sh"
  elif [ -n "$_sj_emcc" ]; then
    _sj_fix "# emcc $(command -v emcc) isn't from an emsdk; install one at ~/emsdk (below), then re-run: source env.sh"
    _sj_fix "git clone https://github.com/emscripten-core/emsdk.git ~/emsdk"\
" && (cd ~/emsdk && ./emsdk install 6.0.12 && ./emsdk activate 6.0.12) && source env.sh"
  else
    _sj_fix "git clone https://github.com/emscripten-core/emsdk.git ~/emsdk"\
" && (cd ~/emsdk && ./emsdk install 6.0.12 && ./emsdk activate 6.0.12) && source env.sh"
  fi
}

_sj_rust_fix() {
  if command -v rustup >/dev/null 2>&1; then
    _sj_fix "rustup update stable"
  else
    _sj_fix "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y && . \"\$HOME/.cargo/env\""
  fi
}
_sj_report error rustc "$(_sj_have rustc --version)" 1.85.0 "builds the truck backends; edition 2024" || _sj_rust_fix
_sj_report error cargo "$(_sj_have cargo --version)" 1.85.0 "Rust package manager" || _sj_rust_fix
if command -v rustup >/dev/null 2>&1; then
  if rustup target list --installed 2>/dev/null | grep -qx wasm32-unknown-unknown; then
    printf '  %-8s %-12s %s\n' ok wasm32 "rustup target wasm32-unknown-unknown"
  else
    printf '  %-8s %-12s %s\n' MISSING wasm32 "(rustup target wasm32-unknown-unknown, for wasm-pack builds)"
    _sj_errors=$((_sj_errors + 1))
    _sj_fix "rustup target add wasm32-unknown-unknown"
  fi
elif command -v rustc >/dev/null 2>&1; then
  printf '  %-8s %-12s %s\n' missing rustup "(rustc isn't managed by rustup; can't check the wasm32 target)"
  _sj_warnings=$((_sj_warnings + 1))
  _sj_fix "# replace the system Rust with rustup: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
fi
_sj_report error wasm-pack "$(_sj_have wasm-pack --version)" 0.15.0 "builds the Rust backends as WebAssembly" ||
  _sj_fix "cargo install wasm-pack --locked"

# Optional tools.
# Python: third_party/pull.sh installs pypdf into a local venv (third_party/jt/.venv) to extract the JT documents'
# text (pypdf isn't an npm package); packages/tess-occt/occt_overlay/test/compare.py also uses it.
_sj_py=$(_sj_have python3 --version)
if _sj_report warning python3 "$_sj_py" 3.8.0 "optional: JT text extraction in third_party/pull.sh, overlay tests"; then
  if python3 -c 'import venv, ensurepip' >/dev/null 2>&1; then
    printf '  %-8s %-12s %s\n' ok py-venv "python3 -m venv"
  else
    printf '  %-8s %-12s %s\n' missing py-venv \
      "(python3 can't create virtual environments; needed for the JT text in third_party/pull.sh)"
    _sj_warnings=$((_sj_warnings + 1))
    _sj_fix_pkg python3-venv "brew install python" python3-venv python3
  fi
else
  _sj_fix_pkg python3 "brew install python" "python3 python3-venv" python3
fi
_sj_report warning c++ "$(_sj_have c++ --version)" "" "optional: native occt_overlay/test/table_test.cpp" ||
  _sj_fix_pkg c++ "xcode-select --install" g++ gcc-c++

# Documents: scripts/md2pdf.sh converts Markdown to PDF with Typst, which scripts/fetch-typst.sh fetches (pinned,
# with the Typst packages it uses) into third_party/typst/; md2pdf.sh fetches it on first use.
_sj_typst=$("$_sj_repo/third_party/typst/bin/typst" --version 2>/dev/null | cut -d' ' -f2)
_sj_report warning typst "$_sj_typst" "" "optional: scripts/md2pdf.sh, Markdown to PDF" ||
  _sj_fix "\"$_sj_repo/scripts/fetch-typst.sh\""

# Repository state: the npm install and the third-party checkouts.
if [ ! -d "$_sj_repo/node_modules/typescript" ]; then
  printf '  %-8s %-12s %s\n' missing npm-deps "(run npm install for type checking)"
  _sj_warnings=$((_sj_warnings + 1))
  _sj_fix "(cd \"$_sj_repo\" && npm install)"
fi
if [ ! -d "$_sj_repo/third_party/OCCT/.git" ] || [ ! -d "$_sj_repo/third_party/stepcode/.git" ]; then
  printf '  %-8s %-12s %s\n' missing third_party "(OCCT, stepcode, truck, … checkouts)"
  _sj_warnings=$((_sj_warnings + 1))
  _sj_fix "\"$_sj_repo/third_party/pull.sh\""
fi
if [ ! -f "$_sj_repo/third_party/jt/JT-v10-file-format-reference-rev-B_tcm1023-233786.txt" ]; then
  printf '  %-8s %-12s %s\n' missing jt-docs "(only needed for JT work)"
  _sj_warnings=$((_sj_warnings + 1))
  _sj_fix "\"$_sj_repo/third_party/pull.sh\""
fi
if [ ! -d "$_sj_repo/test_corpus/third_party/gkv311-opencascade-dataset" ]; then
  printf '  %-8s %-12s %s\n' missing test-corpus "(only needed for corpus_checks/)"
  _sj_warnings=$((_sj_warnings + 1))
  _sj_fix "\"$_sj_repo/test_corpus/third_party/pull.sh\""
fi

if [ $_sj_errors -gt 0 ] || [ $_sj_warnings -gt 0 ]; then
  echo
  [ $_sj_errors -gt 0 ] && echo "env.sh: ERROR: $_sj_errors required tool(s) missing or too old." >&2
  [ $_sj_warnings -gt 0 ] && echo "env.sh: $_sj_warnings optional item(s) missing."
  echo "Suggested commands ($_sj_os${_sj_pkg:+, $_sj_pkg}):"
  printf '%s' "$_sj_fixes" | awk 'NF && !seen[$0]++ { print "  " $0 }'
else
  echo "All set."
fi
[ $_sj_sourced = 1 ] ||
  echo "(env.sh was run, not sourced: the environment changes above don't persist. Use: source env.sh)"

_sj_status=$((_sj_errors > 0))
unset -f _sj_version _sj_ge _sj_fix _sj_fix_pkg _sj_report _sj_have _sj_rust_fix
unset _sj_os _sj_pkg _sj_errors _sj_warnings _sj_fixes _sj_emsdk _sj_emcc _sj_d _sj_repo _sj_py _sj_typst
if [ $_sj_sourced = 1 ]; then
  unset _sj_sourced
  return $_sj_status 2>/dev/null || true
else
  unset _sj_sourced
  exit $_sj_status
fi
