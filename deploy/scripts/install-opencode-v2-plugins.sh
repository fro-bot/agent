#!/bin/sh
# Installs OpenCode V2 plugins into the agent's cache at IMAGE BUILD time, so the workspace never installs at boot.
#
# Usage: install-opencode-v2-plugins.sh <spec>...   (each an exact @fro.bot/systematic@x.y.z or
#                                                    @fro.bot/opencode-plugin@x.y.z)
#
# Why this exists (probe P10, v2.2.0):
# - `opencode plugin add` has no timeout. A hung registry hangs it forever, so every install runs under `timeout`.
# - A plugin that is not cached is installed by the server at boot, and a hung boot install leaves `GET /api/agent`
#   answering 503 for as long as it hangs. The image therefore carries every plugin before it ever starts.
# - `plugin add` writes the global config. The workspace entrypoint owns that file and rewrites it at start, so any
#   plugin entry in it would be lost. The plugins are listed in the config content the workspace agent passes at
#   spawn (the server finds them in the cache by spec), and the file `plugin add` wrote is removed here.
#
# The install runs as the agent uid (10001): the cache it fills is the one the server reads as that uid, and the
# service identity (root) never writes into the agent's home. Run on a Linux build as root; the privilege drop is
# `setpriv`, as in deploy/workspace-entrypoint.sh.
#
# Test seams (deploy/scripts/install-opencode-v2-plugins.test.mjs): OPENCODE_BIN, AGENT_HOME, DROP_PRIVILEGES
# (empty means no privilege drop), INSTALL_TIMEOUT_SECONDS and INSTALL_PATH (the PATH the install sees).

set -eu

OPENCODE_BIN="${OPENCODE_BIN:-/usr/local/bin/opencode}"
AGENT_HOME="${AGENT_HOME:-/home/opencode}"
INSTALL_TIMEOUT_SECONDS="${INSTALL_TIMEOUT_SECONDS:-300}"
DROP_PRIVILEGES="${DROP_PRIVILEGES-setpriv --reuid=10001 --regid=10001 --clear-groups}"
INSTALL_PATH="${INSTALL_PATH:-/usr/local/bin:/usr/bin:/bin}"

fail() {
  echo "install-opencode-v2-plugins: $*" >&2
  exit 1
}

case "${INSTALL_TIMEOUT_SECONDS}" in
  '' | *[!0-9]*) fail "INSTALL_TIMEOUT_SECONDS must be a whole number of seconds, got: ${INSTALL_TIMEOUT_SECONDS}" ;;
esac

[ "$#" -gt 0 ] || fail "no plugin specs given"

# Validate every spec before installing any: an exact version of one of the two fro.bot packages, nothing else.
# No range, no tag, no git or file spec: a floating spec would make the image depend on the registry's state.
for spec in "$@"; do
  printf '%s' "${spec}" | grep -Eq '^@fro\.bot/(systematic|opencode-plugin)@[0-9]+\.[0-9]+\.[0-9]+$' ||
    fail "refusing plugin spec: ${spec} (expected @fro.bot/systematic@x.y.z or @fro.bot/opencode-plugin@x.y.z)"
done

for spec in "$@"; do
  echo "install-opencode-v2-plugins: installing ${spec} (bound ${INSTALL_TIMEOUT_SECONDS}s)" >&2
  # `env -i` rebuilds the environment from nothing: the install sees only the agent's home and XDG roots.
  # ${DROP_PRIVILEGES} is intentionally unquoted so it splits into the command and its flags.
  # shellcheck disable=SC2086
  ${DROP_PRIVILEGES} env -i \
    HOME="${AGENT_HOME}" \
    PATH="${INSTALL_PATH}" \
    XDG_CONFIG_HOME="${AGENT_HOME}/.config" \
    XDG_DATA_HOME="${AGENT_HOME}/.local/share" \
    XDG_CACHE_HOME="${AGENT_HOME}/.cache" \
    XDG_STATE_HOME="${AGENT_HOME}/.local/state" \
    timeout -s KILL "${INSTALL_TIMEOUT_SECONDS}" "${OPENCODE_BIN}" plugin add "${spec}" ||
    fail "installing ${spec} failed or exceeded ${INSTALL_TIMEOUT_SECONDS}s"

  # A zero exit that left nothing behind would ship an image that installs at boot.
  cache_dir="${AGENT_HOME}/.cache/opencode/npm/${spec}"
  if [ ! -d "${cache_dir}" ] || [ -z "$(ls -A "${cache_dir}" 2>/dev/null)" ]; then
    fail "${spec} is not in the cache at ${cache_dir} after a successful install"
  fi
done

# The entrypoint owns the global config; see the header.
rm -f "${AGENT_HOME}/.config/opencode/opencode.json"
echo "install-opencode-v2-plugins: done" >&2
