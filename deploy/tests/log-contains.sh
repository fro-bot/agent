# shellcheck shell=bash
# Sourced by isolation-harness.sh and validate-stack.test.sh (no side effects).
#
# log_contains <haystack> <needle>: fixed-string substring match.
# A here-string, NOT `printf | grep -q`: under pipefail, grep -q exits on the
# first match and printf dies of SIGPIPE (141) once the haystack exceeds the
# pipe buffer, turning a present line into a false failure.
log_contains() {
  grep -qF -- "$2" <<<"$1"
}
