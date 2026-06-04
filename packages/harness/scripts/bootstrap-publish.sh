#!/usr/bin/env bash
# bootstrap-publish.sh — ONE-TIME manual bootstrap for @fro.bot/harness* package names.
#
# PURPOSE: npm trusted publishing (OIDC) requires a package to already exist before
# a trusted publisher can be attached. This script publishes a throwaway 0.0.0 stub
# for each of the five @fro.bot/harness* names to claim them. After this runs once,
# revoke the token — all subsequent publishes use OIDC via harness-release.yaml.
#
# REQUIREMENTS:
#   - NODE_AUTH_TOKEN must be set to a granular npm token with read+write access
#     scoped to the five @fro.bot/harness* packages (see BOOTSTRAP.md Step 1).
#   - Or: be logged in via `npm login` with a token that has publish rights.
#   - npm must be installed and on PATH.
#
# USAGE:
#   export NODE_AUTH_TOKEN=<your-granular-token>
#   bash packages/harness/scripts/bootstrap-publish.sh
#
# After it completes: REVOKE THE TOKEN on npmjs.com immediately.

set -euo pipefail

# ---------------------------------------------------------------------------
# Package names to claim
# ---------------------------------------------------------------------------
packages=(
  "@fro.bot/harness"
  "@fro.bot/harness-linux-x64"
  "@fro.bot/harness-linux-arm64"
  "@fro.bot/harness-darwin-x64"
  "@fro.bot/harness-darwin-arm64"
)

# ---------------------------------------------------------------------------
# Sanity check: npm must be on PATH
# ---------------------------------------------------------------------------
if ! command -v npm > /dev/null 2>&1; then
  echo "ERROR: npm not found on PATH. Install Node.js >= 24 and try again." >&2
  exit 1
fi

echo "Using npm: $(npm --version) at $(command -v npm)"

# ---------------------------------------------------------------------------
# Temp dir management — cleaned up on exit regardless of success/failure
# ---------------------------------------------------------------------------
WORK_DIR=""
NPM_USERCONFIG_FLAG=()

cleanup() {
  if [ -n "${WORK_DIR}" ] && [ -d "${WORK_DIR}" ]; then
    # WORK_DIR contains the temp .npmrc (which holds the token) — remove it first.
    rm -rf "${WORK_DIR}"
  fi
  # Always remind the operator to revoke the token, whether the script succeeded
  # or failed mid-loop. A live write-scoped token must never be left un-revoked.
  echo ""
  echo "================================================================"
  echo "IMPORTANT: REVOKE the npm token you used — go to:"
  echo "  npmjs.com → Access Tokens → delete the token now."
  echo "It has served its only purpose and must not remain active."
  echo "================================================================"
}

trap cleanup EXIT

WORK_DIR="$(mktemp -d)"
echo "Working in temp dir: ${WORK_DIR}"

# ---------------------------------------------------------------------------
# Auth: write a temp .npmrc if NODE_AUTH_TOKEN is set, else use ambient auth
# ---------------------------------------------------------------------------
if [ -n "${NODE_AUTH_TOKEN:-}" ]; then
  NPMRC_FILE="${WORK_DIR}/.npmrc"
  printf '//registry.npmjs.org/:_authToken=%s\n' "${NODE_AUTH_TOKEN}" > "${NPMRC_FILE}"
  chmod 600 "${NPMRC_FILE}"
  NPM_USERCONFIG_FLAG=(--userconfig "${NPMRC_FILE}")
  echo "NODE_AUTH_TOKEN is set — wrote temp .npmrc (chmod 600) for auth."
else
  echo "NODE_AUTH_TOKEN is not set — using ambient npm auth (npm login)."
  echo "If you are not logged in, npm publish will fail with ENEEDAUTH."
  echo "Either set NODE_AUTH_TOKEN or run \`npm login\` first."
fi

echo ""

# ---------------------------------------------------------------------------
# Publish a 0.0.0 stub for each package name
# ---------------------------------------------------------------------------
for pkg in "${packages[@]}"; do
  echo "--- Publishing stub: ${pkg}@0.0.0 ---"

  pkg_dir="${WORK_DIR}/${pkg//\//__}"
  mkdir -p "${pkg_dir}"

  # Write a minimal package.json — just enough for npm publish to accept it.
  cat > "${pkg_dir}/package.json" <<EOF
{
  "name": "${pkg}",
  "version": "0.0.0",
  "description": "Bootstrap stub — placeholder to claim the npm package name. Real releases use OIDC via harness-release.yaml.",
  "license": "MIT",
  "publishConfig": {
    "access": "public"
  }
}
EOF

  npm publish "${NPM_USERCONFIG_FLAG[@]}" "${pkg_dir}"
  echo "Published: ${pkg}@0.0.0"
  echo ""
done

# ---------------------------------------------------------------------------
# Done — revoke reminder is printed by the EXIT trap (always, on success or failure)
# ---------------------------------------------------------------------------
echo "================================================================"
echo "Bootstrap complete. All 5 package names are now claimed on npm."
echo ""
echo "NEXT STEPS:"
echo "  1. See the revoke reminder below (printed by the exit trap)."
echo "  2. Configure trusted publishing for each package (see BOOTSTRAP.md Step 2)."
echo "  3. Run the dry-run validation (see BOOTSTRAP.md Step 3)."
echo "================================================================"
