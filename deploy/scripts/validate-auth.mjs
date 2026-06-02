// validate-auth.mjs — Auth secret validator for the workspace executor.
// Pure ESM, no build step. Used by workspace-entrypoint.sh.

/**
 * Validate a raw auth secret string.
 * @param {string} raw - Raw file content of the auth secret.
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function validateAuth(raw) {
  let data
  try {
    data = JSON.parse(raw)
  } catch {
    return { ok: false, error: "auth secret is not valid JSON" }
  }

  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { ok: false, error: "auth secret must be a JSON object of providerID -> {type,key}" }
  }

  const ids = Object.keys(data)
  if (ids.length === 0) {
    return { ok: false, error: "auth secret has no provider entries" }
  }

  for (const id of ids) {
    if (!/^[A-Za-z0-9._-]+$/.test(id)) {
      return { ok: false, error: "provider id is invalid (allowed: letters, digits, . _ -)" }
    }
    const e = data[id]
    if (typeof e !== "object" || e === null) {
      return { ok: false, error: `provider ${id}: entry must be an object` }
    }
    if (e.type !== "api") {
      return { ok: false, error: `provider ${id}: type must be "api" (v1 supports API-key credentials only)` }
    }
    if (typeof e.key !== "string" || e.key.trim() === "") {
      return { ok: false, error: `provider ${id}: missing non-empty "key"` }
    }
  }

  return { ok: true }
}

// CLI main guard: node validate-auth.mjs <auth-file-path>
if (import.meta.url === `file://${process.argv[1]}`) {
  const { readFileSync } = await import("node:fs")
  const filePath = process.argv[2]
  let raw
  try {
    raw = readFileSync(filePath, "utf8")
  } catch (e) {
    process.stderr.write(`cannot read auth secret: ${e.message}\n`)
    process.exit(2)
  }
  const result = validateAuth(raw)
  if (!result.ok) {
    process.stderr.write(result.error + "\n")
    process.exit(2)
  }
  process.exit(0)
}
