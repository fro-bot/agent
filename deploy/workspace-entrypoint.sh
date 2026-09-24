#!/bin/sh
# Workspace executor entrypoint.
#
# The service (this script, and the workspace-agent supervisor it execs)
# always runs as uid 0 with a reduced capability set (see compose.yaml:
# cap_drop ALL, cap_add CHOWN/DAC_OVERRIDE/FOWNER/SETUID/SETGID/KILL). It
# needs those capabilities to create/validate protected directories, install
# the mitmproxy CA into the system trust store, migrate legacy checkout
# ownership, and read root-only secret mounts — none of which the
# unprivileged OpenCode agent uid (10001, account "opencode") may do.
#
# OpenCode itself — and every tool it spawns — never runs as root. Its
# credential/config provisioning (the one step that writes into the agent's
# own home) is the one place this script drops privilege before doing work;
# see step 5 below for why and how.
#
# Order (each step depends on the previous one having succeeded):
#   1. Confirm this process is actually root (setpriv/CAP_* below assume it).
#   2. Create/validate the protected directories, without following symlinks.
#   3. Install the mitmproxy CA into the system trust store.
#   4. Migrate any pre-existing root-owned checkouts to the agent uid.
#   5. Provision OpenCode's auth.json + merged config AS THE AGENT UID.
#   6. exec the workspace-agent supervisor (still uid 0 — see compose.yaml
#      user: "0:0" — the supervisor spawns OpenCode itself as uid 10001;
#      that spawn logic lives in apps/workspace-agent/src, not here).

set -eu

SCRIPTS_DIR="${WORKSPACE_SCRIPTS_DIR:-/usr/local/lib/workspace-scripts}"

AGENT_UID=10001
AGENT_GID=10001
AGENT_HOME="/home/opencode"

# ---------------------------------------------------------------------------
# Step 1: confirm the service identity is root.
#
# Everything below (directory creation with explicit ownership, CA install
# into the system trust store, chown during migration, privilege drop for
# provisioning) requires CAP_CHOWN/CAP_DAC_OVERRIDE/CAP_FOWNER/CAP_SETUID/
# CAP_SETGID, which only apply while running as uid 0. Fail immediately and
# clearly rather than surfacing confusing permission errors mid-boot.
# ---------------------------------------------------------------------------
if [ "$(id -u)" -ne 0 ]; then
  echo "workspace-entrypoint: this container must start as uid 0 (got uid $(id -u)) — the service keeps reduced-capability root; OpenCode itself is dropped to uid ${AGENT_UID} in step 5" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Step 2: create/validate the protected directories, never following a
# symlink at any of these paths. A tmpfs mount resets on every container
# start, so /run/workspace-agent's subdirectories are always (re)created
# here; /workspace/repos/.workspace-agent lives on the persistent
# workspace-repos volume, so across restarts it is validated, not recreated.
# ---------------------------------------------------------------------------
RUNTIME_DIR="/run/workspace-agent"
REPOS_ROOT="/workspace/repos"
STATE_DIR="${REPOS_ROOT}/.workspace-agent"

for dir_spec in \
  "${RUNTIME_DIR}:0:0:700" \
  "${RUNTIME_DIR}/secrets:0:0:700" \
  "${RUNTIME_DIR}/mitmproxy:0:0:700" \
  "${STATE_DIR}:0:0:700"; do
  dir_path="${dir_spec%%:*}"
  rest="${dir_spec#*:}"
  dir_uid="${rest%%:*}"
  rest2="${rest#*:}"
  dir_gid="${rest2%%:*}"
  dir_mode="${rest2#*:}"
  if ! node "$SCRIPTS_DIR/ensure-protected-dir.mjs" "$dir_path" "$dir_uid" "$dir_gid" "$dir_mode"; then
    echo "workspace-entrypoint: refusing to start — ${dir_path} failed its protected-directory check (see message above)" >&2
    exit 1
  fi
done

# ---------------------------------------------------------------------------
# Step 3: install the mitmproxy public CA into the system trust store so
# ALL outbound TLS clients in this container work through the egress proxy:
#   - git / libcurl (clone.ts)        — read the SYSTEM CA bundle
#   - opencode (Bun, --use-system-ca) — reads the SYSTEM CA bundle
#   - node fetch/https                — covered by NODE_EXTRA_CA_CERTS
#
# NODE_EXTRA_CA_CERTS alone is insufficient: git and opencode do not consult
# it. The CA must land in the system trust store via update-ca-certificates.
#
# CA_SRC now lives under the protected runtime dir (mitmproxy-certs volume
# mounted read-only at /run/workspace-agent/mitmproxy — see compose.yaml) —
# root-only, so the agent uid never has direct read access to the raw CA
# material, only to the merged system bundle this step produces.
#
# Fail-closed: if an egress proxy is configured (HTTPS_PROXY/HTTP_PROXY) but
# CA trust cannot be installed, the container exits rather than launching
# with broken TLS. CI smoke and proxy-less dev opt out via
# MITMPROXY_CA_WAIT_SECONDS=0 or MITMPROXY_CA_OPTIONAL=true.
# ---------------------------------------------------------------------------
CA_SRC="${MITMPROXY_CA_PATH:-${RUNTIME_DIR}/mitmproxy/mitmproxy-ca-cert.pem}"
CA_DEST="/usr/local/share/ca-certificates/mitmproxy.crt"
SYSTEM_BUNDLE="/etc/ssl/certs/ca-certificates.crt"
WAIT_SECONDS="${MITMPROXY_CA_WAIT_SECONDS:-30}"

# install_ca: 0 = installed, 1 = CA absent after wait, 2 = install command failed.
install_ca() {
  waited=0
  while [ ! -f "$CA_SRC" ]; do
    if [ "$waited" -ge "$WAIT_SECONDS" ]; then
      echo "workspace-entrypoint: no mitmproxy CA at $CA_SRC after ${WAIT_SECONDS}s" >&2
      return 1
    fi
    sleep 1
    waited=$((waited + 1))
  done

  if ! cp "$CA_SRC" "$CA_DEST"; then
    echo "workspace-entrypoint: failed to copy mitmproxy CA to $CA_DEST" >&2
    return 2
  fi
  # Regenerate the merged system bundle (base CAs + mitmproxy). This bundle
  # stays world-readable (the default for update-ca-certificates' output),
  # which is required: OpenCode running as the agent uid must be able to
  # read it to make outbound TLS calls through the proxy.
  if ! update-ca-certificates >/dev/null 2>&1; then
    echo "workspace-entrypoint: update-ca-certificates failed" >&2
    return 2
  fi
  echo "workspace-entrypoint: installed mitmproxy CA into system trust store" >&2
  return 0
}

proxy_configured() {
  [ -n "${HTTPS_PROXY:-}" ] || [ -n "${HTTP_PROXY:-}" ] || [ -n "${https_proxy:-}" ] || [ -n "${http_proxy:-}" ]
}

ca_optional() {
  [ "$WAIT_SECONDS" -eq 0 ] || [ "${MITMPROXY_CA_OPTIONAL:-}" = "true" ]
}

if install_ca; then
  export NODE_EXTRA_CA_CERTS="$SYSTEM_BUNDLE"
elif proxy_configured && ! ca_optional; then
  echo "workspace-entrypoint: egress proxy is configured but the mitmproxy CA could not be trusted — refusing to start with broken TLS. Set MITMPROXY_CA_OPTIONAL=true to override." >&2
  exit 1
else
  echo "workspace-entrypoint: continuing without proxy trust (no proxy configured or CA explicitly optional)" >&2
fi

# ---------------------------------------------------------------------------
# Step 4: migrate any pre-existing root-owned checkouts (from before uid
# isolation) to the agent uid. Filesystem-only, never runs git, never
# touches /workspace/repos or /workspace/repos/<owner> themselves — see
# deploy/scripts/migrate-repo-ownership.mjs for the full algorithm
# (lstat-only walk, no filesystem-boundary crossing, hardlink-safe,
# resumable/idempotent via a per-checkout completion marker, bounded by a
# deadline). On timeout or any other failure this refuses to start rather
# than launching OpenCode against a partially-migrated, mixed-ownership tree.
# ---------------------------------------------------------------------------
MIGRATION_DEADLINE_MS="${WORKSPACE_MIGRATION_DEADLINE_MS:-300000}"
if ! node "$SCRIPTS_DIR/migrate-repo-ownership.mjs" \
    --repos-root "$REPOS_ROOT" \
    --state-dir "$STATE_DIR" \
    --uid "$AGENT_UID" \
    --gid "$AGENT_GID" \
    --deadline-ms "$MIGRATION_DEADLINE_MS"; then
  echo "workspace-entrypoint: repo-ownership migration failed or timed out — refusing to start against a partially-migrated tree. Restart to resume (already-completed checkouts are skipped)." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Step 5: provision OpenCode's auth.json and merged opencode.json AS THE
# AGENT UID (10001), never as root.
#
# Why this has to drop privilege: both destination files live under
# /home/opencode, which the agent uid owns. If root wrote there directly —
# as the old entrypoint did (auth.json copy) and as merge-config.mjs's
# write-temp-then-rename pattern did — a symlink the agent (or anything it
# ran) planted at either destination path would turn that privileged root
# write into an arbitrary-path write anywhere on the filesystem. Running the
# write as uid 10001 closes that class of attack entirely: the agent can
# only ever redirect its own write into somewhere it could already write as
# itself.
#
# Root's role is therefore reduced to: read the protected secret (which the
# agent uid cannot reach — AUTH_SRC lives under the root-only
# /run/workspace-agent/secrets), and hand the raw secret bytes to the
# agent-uid subprocess over STDIN — never argv, which is visible to every
# user on the host via process listings.
#
# Privilege-drop tool: setpriv (from util-linux; see the Dockerfile for the
# `apk add` and full rationale). `--reuid=10001 --regid=10001 --clear-groups`
# sets both real+effective uid/gid to the agent account's numeric IDs and
# drops every supplementary group the root process could otherwise still
# hold — no root supplementary group survives the switch. setpriv does not
# spawn a shell or a PAM session (unlike `su`), and does not require the
# target account to exist in a mounted /etc/passwd the way some
# `runuser`/`gosu` configurations do since numeric --reuid/--regid work
# directly; the account is created anyway (see Dockerfile) for clarity and so
# process listings show "opencode" instead of a bare uid.
# ---------------------------------------------------------------------------
AUTH_SRC="${WORKSPACE_OPENCODE_AUTH_FILE:-${RUNTIME_DIR}/secrets/workspace_opencode_auth}"
BASE_CONFIG_PATH="/usr/local/share/fro-bot/opencode.base.json"
AUTH_DEST="${AGENT_HOME}/.local/share/opencode/auth.json"
CONFIG_DEST="${AGENT_HOME}/.config/opencode/opencode.json"

# Read (as root) and compact the secret. Absence is fail-soft (clone-only
# deployments boot without it); a read failure or malformed blob is
# fail-fast. Whitespace-only means "unset" (matches readOptionalSecret).
AUTH_RAW=""
if [ -f "$AUTH_SRC" ]; then
  if ! _auth_compact=$(tr -d '[:space:]' < "$AUTH_SRC" 2>/dev/null); then
    echo "workspace-entrypoint: cannot read auth secret at $AUTH_SRC" >&2
    exit 1
  fi
  if [ -n "$_auth_compact" ]; then
    if ! node "$SCRIPTS_DIR/validate-auth.mjs" "$AUTH_SRC"; then
      echo "workspace-entrypoint: auth secret is present but invalid — refusing to start. Fix the credential blob and restart." >&2
      exit 1
    fi
    # Re-read raw (uncompacted) content for the agent-uid subprocess — the
    # provisioning script accepts and preserves whitespace-tolerant JSON.
    AUTH_RAW="$(cat "$AUTH_SRC")"
  fi
fi

# The single write step, dropped to the agent uid. AUTH_RAW travels only over
# this pipe's stdin, never as a CLI argument or in an exported env var.
# `if`-wrapped (rather than a bare assignment) so a non-zero exit does not
# trip `set -e` before provision_rc can be captured.
auth_was_present=false
if [ -n "$AUTH_RAW" ]; then
  auth_was_present=true
fi
if provision_output=$(printf '%s' "$AUTH_RAW" | setpriv --reuid="$AGENT_UID" --regid="$AGENT_GID" --clear-groups \
    node "$SCRIPTS_DIR/provision-agent-config.mjs" "$BASE_CONFIG_PATH" "$AUTH_DEST" "$CONFIG_DEST" 2>&1); then
  provision_rc=0
else
  provision_rc=$?
fi
unset AUTH_RAW _auth_compact

echo "$provision_output" >&2
if [ "$provision_rc" -ne 0 ]; then
  echo "workspace-entrypoint: OpenCode config/auth provisioning failed — refusing to start. Fix the credential blob / WORKSPACE_OPENCODE_CONFIG / WORKSPACE_OPENCODE_MODEL and restart." >&2
  exit 1
fi
if [ "$auth_was_present" = false ]; then
  echo "workspace-entrypoint: auth: absent (mention loop will fail until configured; clone-only deployment is fine)" >&2
fi

# ---------------------------------------------------------------------------
# Step 6: hand off to the supervisor as PID 1 so its SIGTERM drain works.
# The supervisor itself stays uid 0 (compose.yaml user: "0:0") — it spawns
# OpenCode as uid 10001 (apps/workspace-agent/src owns that spawn logic).
# ---------------------------------------------------------------------------
exec node /app/apps/workspace-agent/dist/main.mjs
