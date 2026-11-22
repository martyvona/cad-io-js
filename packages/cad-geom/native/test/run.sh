# The native test runner the build scripts share (cad-geom, cad-oracle, tess-cadio): sourced, it defines run and
# sets fail. run <name> <command...> runs one test binary, its output as it comes, at most TEST_TIMEOUT seconds
# (default 300), so a hang (a planted bug in an iteration) reports, with the case it was in, instead of running on.
# The limit is timeout's, or coreutils' gtimeout's (older macOS ships neither; Homebrew's coreutils has
# gtimeout); with neither, the tests run without one, said once.

fail=0
# (A command name, not an array: macOS's bash 3.2 under set -u rejects an empty array's expansion.)
if command -v timeout >/dev/null 2>&1; then TIMEOUT=timeout
elif command -v gtimeout >/dev/null 2>&1; then TIMEOUT=gtimeout
else
  TIMEOUT=
  echo "warning: no timeout or gtimeout on PATH, so the tests run without a time limit" >&2
fi

run() {
  local name=$1; shift; echo "== $name"
  local code=0
  if [ -n "$TIMEOUT" ]; then "$TIMEOUT" "${TEST_TIMEOUT:-300}" "$@" || code=$?; else "$@" || code=$?; fi
  [ $code = 0 ] || { echo "== $name: exit $code$([ $code = 124 ] && echo ', timed out')" >&2; fail=1; }
}
