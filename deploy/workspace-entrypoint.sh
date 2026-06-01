#!/bin/sh
# Workspace executor entrypoint.
#
# Trusts the mitmproxy CA before launching the workspace-agent supervisor so
# that ALL outbound TLS clients in this container work through the egress proxy:
#   - git / libcurl (clone.ts)        — read the SYSTEM CA bundle
#   - opencode (Bun, --use-system-ca) — reads the SYSTEM CA bundle
#   - node fetch/https                — covered by NODE_EXTRA_CA_CERTS
#
# NODE_EXTRA_CA_CERTS alone is insufficient: git and opencode do not consult it.
# The CA must be installed into the system trust store via update-ca-certificates.
#
# Fail-closed: if an egress proxy is configured (HTTPS_PROXY/HTTP_PROXY) but CA
# trust cannot be installed, the container exits rather than launching with
# broken TLS — every clone and model call would fail anyway, and a half-trusted
# state is worse than a clear startup error. CI smoke and proxy-less dev opt out
# via MITMPROXY_CA_WAIT_SECONDS=0 or MITMPROXY_CA_OPTIONAL=true.

set -eu

CA_SRC="${MITMPROXY_CA_PATH:-/run/mitmproxy-certs/mitmproxy-ca-cert.pem}"
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
  # Regenerate the merged system bundle (base CAs + mitmproxy).
  if ! update-ca-certificates >/dev/null 2>&1; then
    echo "workspace-entrypoint: update-ca-certificates failed" >&2
    return 2
  fi
  echo "workspace-entrypoint: installed mitmproxy CA into system trust store" >&2
  return 0
}

# A proxy is "configured" when either proxy var is set and non-empty.
proxy_configured() {
  [ -n "${HTTPS_PROXY:-}" ] || [ -n "${HTTP_PROXY:-}" ] || [ -n "${https_proxy:-}" ] || [ -n "${http_proxy:-}" ]
}

# Caller opts out of mandatory CA trust (CI smoke, proxy-less dev).
ca_optional() {
  [ "$WAIT_SECONDS" -eq 0 ] || [ "${MITMPROXY_CA_OPTIONAL:-}" = "true" ]
}

if install_ca; then
  # Point Node's fetch/https at the merged bundle too (belt-and-suspenders).
  export NODE_EXTRA_CA_CERTS="$SYSTEM_BUNDLE"
elif proxy_configured && ! ca_optional; then
  echo "workspace-entrypoint: egress proxy is configured but the mitmproxy CA could not be trusted — refusing to start with broken TLS. Set MITMPROXY_CA_OPTIONAL=true to override." >&2
  exit 1
else
  echo "workspace-entrypoint: continuing without proxy trust (no proxy configured or CA explicitly optional)" >&2
fi

# ---------------------------------------------------------------------------
# OpenCode provider credentials (file-based, mirrors populateAuthJson).
#
# Written to OpenCode's data path as auth.json (0600), NOT exported as env —
# a file has a smaller introspection surface than /proc/<pid>/environ, and the
# clone subprocess (explicit env allowlist in clone.ts) never sees it.
#
# Auth-gating rule: clone-only deployments boot without credentials; the
# mention-loop turn fails with OpenCode's own auth error when they are absent.
# A malformed blob fails fast here rather than at turn time.
# ---------------------------------------------------------------------------

AUTH_SRC="${WORKSPACE_OPENCODE_AUTH_FILE:-/run/secrets/workspace_opencode_auth}"
OPENCODE_DATA_DIR="${XDG_DATA_HOME:-/root/.local/share}/opencode"
AUTH_DEST="${OPENCODE_DATA_DIR}/auth.json"

# v1 accepts API-key credentials only (a static blob cannot refresh OAuth).
AUTH_VALIDATOR='
const fs = require("fs")
let raw
try { raw = fs.readFileSync(process.argv[1], "utf8") } catch (e) { console.error("cannot read auth secret: " + e.message); process.exit(2) }
let data
try { data = JSON.parse(raw) } catch (e) { console.error("auth secret is not valid JSON"); process.exit(2) }
if (typeof data !== "object" || data === null || Array.isArray(data)) { console.error("auth secret must be a JSON object of providerID -> {type,key}"); process.exit(2) }
const ids = Object.keys(data)
if (ids.length === 0) { console.error("auth secret has no provider entries"); process.exit(2) }
for (const id of ids) {
  const e = data[id]
  if (typeof e !== "object" || e === null) { console.error("provider " + id + ": entry must be an object"); process.exit(2) }
  if (e.type !== "api") { console.error("provider " + id + ": type must be \"api\" (v1 supports API-key credentials only)"); process.exit(2) }
  if (typeof e.key !== "string" || e.key.trim() === "") { console.error("provider " + id + ": missing non-empty \"key\""); process.exit(2) }
}
process.exit(0)
'

provision_auth() {
  # 0 = provisioned, 1 = absent (fail-soft), 2 = invalid (fail-fast)
  [ -f "$AUTH_SRC" ] || return 1
  # Whitespace-only file means "unset" (matches the readOptionalSecret convention).
  if [ -z "$(tr -d '[:space:]' < "$AUTH_SRC")" ]; then return 1; fi

  if ! node -e "$AUTH_VALIDATOR" "$AUTH_SRC"; then
    return 2
  fi

  mkdir -p "$OPENCODE_DATA_DIR"
  if ! (umask 077; cp "$AUTH_SRC" "$AUTH_DEST"); then
    echo "workspace-entrypoint: failed to write $AUTH_DEST" >&2
    return 2
  fi
  chmod 600 "$AUTH_DEST"
  return 0
}

# `if`-wrapped so a non-zero return (absent/invalid) does not trip `set -e`.
if provision_auth; then
  auth_rc=0
else
  auth_rc=$?
fi
if [ "$auth_rc" -eq 0 ]; then
  echo "workspace-entrypoint: auth: provisioned" >&2
elif [ "$auth_rc" -eq 2 ]; then
  echo "workspace-entrypoint: auth secret is present but invalid — refusing to start. Fix the credential blob and restart." >&2
  exit 1
else
  echo "workspace-entrypoint: auth: absent (mention loop will fail until configured; clone-only deployment is fine)" >&2
fi

# ---------------------------------------------------------------------------
# OpenCode model + provider config overlay (mirrors the action's `model` and
# `opencode-config` inputs).
#
# WORKSPACE_OPENCODE_CONFIG is a JSON object shallow-merged over the baked base
# config — the deployer supplies the `provider` block (e.g. cliproxyapi:
# {"provider":{"anthropic":{"options":{"baseURL":"https://cliproxy.fro.bot/v1"}}}}).
# WORKSPACE_OPENCODE_MODEL is the `provider/model` string and always wins.
# The baked Systematic plugin is preserved regardless of the overlay.
#
# Fail-soft: both unset → base config stands (clone-only boots; the mention-loop
# turn picks OpenCode's own default/error). Malformed config → fail fast.
# ---------------------------------------------------------------------------

OPENCODE_CONFIG_FILE="${XDG_CONFIG_HOME:-/root/.config}/opencode/opencode.json"

if [ -n "${WORKSPACE_OPENCODE_CONFIG:-}" ] || [ -n "${WORKSPACE_OPENCODE_MODEL:-}" ]; then
  CONFIG_MERGER='
const fs = require("fs")
const cfgPath = process.argv[1]
const overlayRaw = process.env.WORKSPACE_OPENCODE_CONFIG || ""
const model = (process.env.WORKSPACE_OPENCODE_MODEL || "").trim()
let base
try { base = JSON.parse(fs.readFileSync(cfgPath, "utf8")) } catch (e) { console.error("cannot read base opencode config: " + e.message); process.exit(2) }
let overlay = {}
if (overlayRaw.trim() !== "") {
  try { overlay = JSON.parse(overlayRaw) } catch (e) { console.error("WORKSPACE_OPENCODE_CONFIG is not valid JSON"); process.exit(2) }
  if (typeof overlay !== "object" || overlay === null || Array.isArray(overlay)) { console.error("WORKSPACE_OPENCODE_CONFIG must be a JSON object"); process.exit(2) }
}
const merged = {...base, ...overlay}
// Preserve the baked Systematic plugin (union, dedup) so an overlay cannot drop it.
const basePlugins = Array.isArray(base.plugin) ? base.plugin : []
const overlayPlugins = Array.isArray(overlay.plugin) ? overlay.plugin : []
merged.plugin = Array.from(new Set([...basePlugins, ...overlayPlugins]))
if (model !== "") merged.model = model
fs.writeFileSync(cfgPath, JSON.stringify(merged, null, 2) + "\n")
process.exit(0)
'
  if ! node -e "$CONFIG_MERGER" "$OPENCODE_CONFIG_FILE"; then
    echo "workspace-entrypoint: opencode config overlay is invalid — refusing to start. Fix WORKSPACE_OPENCODE_CONFIG / WORKSPACE_OPENCODE_MODEL and restart." >&2
    exit 1
  fi
  echo "workspace-entrypoint: opencode config: model=$([ -n "${WORKSPACE_OPENCODE_MODEL:-}" ] && echo set || echo default), provider-overlay=$([ -n "${WORKSPACE_OPENCODE_CONFIG:-}" ] && echo applied || echo none)" >&2
else
  echo "workspace-entrypoint: opencode config: model=default, provider-overlay=none (mention loop needs a model + provider to run)" >&2
fi

# Hand off to the supervisor as PID 1 so its SIGTERM drain works.
exec node /app/apps/workspace-agent/dist/main.mjs
