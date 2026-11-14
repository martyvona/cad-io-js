# Sourced, with the repository's directory as its argument, by env.sh and the backends' build scripts (bash or zsh):
# puts the project's Emscripten SDK, third_party/emsdk/ (scripts/fetch-emsdk.sh), first on PATH, whatever emcc the
# shell already has (another emsdk activated by a shell profile), so every build uses the pinned version. Returns 1
# with a message on standard error if it isn't fetched or holds another version.
#   . scripts/emsdk-env.sh <repo>
_ee_dir=$1/third_party/emsdk
_ee_want=$(sed -nE 's/^VERSION=//p' "$1/scripts/fetch-emsdk.sh")
_ee_have=$(tr -d '"' 2>/dev/null < "$_ee_dir/upstream/emscripten/emscripten-version.txt" || true)
if [ "$_ee_have" != "$_ee_want" ]; then
  echo "Emscripten $_ee_want isn't in third_party/emsdk${_ee_have:+ (it has $_ee_have)}: run scripts/fetch-emsdk.sh" >&2
  unset _ee_dir _ee_want _ee_have
  return 1
fi
EMSDK_QUIET=1 . "$_ee_dir/emsdk_env.sh" > /dev/null 2>&1
unset _ee_dir _ee_want _ee_have
