// merge-config.mjs — OpenCode config merger for the workspace executor.
// Pure ESM, no build step. Used by workspace-entrypoint.sh.

/**
 * Merge an overlay and optional model into a base OpenCode config object.
 *
 * @param {object} baseObj - Parsed base config object.
 * @param {string} overlayRaw - Raw WORKSPACE_OPENCODE_CONFIG env string (may be empty).
 * @param {string} modelRaw - Raw WORKSPACE_OPENCODE_MODEL env string (may be empty).
 * @returns {{ ok: true, config: object } | { ok: false, error: string }}
 */
export function mergeConfig(baseObj, overlayRaw, modelRaw) {
  const model = (modelRaw || "").trim()

  // Model validation (before building merged).
  if (model !== "") {
    if (!/^[^/]+\/.+$/.test(model)) {
      return {
        ok: false,
        error: "WORKSPACE_OPENCODE_MODEL must be in provider/model form (e.g. anthropic/claude-sonnet-4-6)",
      }
    }
  }

  let overlay = {}
  if ((overlayRaw || "").trim() !== "") {
    try {
      overlay = JSON.parse(overlayRaw)
    } catch {
      return { ok: false, error: "WORKSPACE_OPENCODE_CONFIG is not valid JSON" }
    }
    if (typeof overlay !== "object" || overlay === null || Array.isArray(overlay)) {
      return { ok: false, error: "WORKSPACE_OPENCODE_CONFIG must be a JSON object" }
    }
  }

  const merged = { ...baseObj, ...overlay }

  // Preserve baked Systematic plugin: union, dedup, strings only.
  const basePlugins = Array.isArray(baseObj.plugin) ? baseObj.plugin : []
  const overlayPlugins = Array.isArray(overlay.plugin) ? overlay.plugin.filter((p) => typeof p === "string") : []
  merged.plugin = Array.from(new Set([...basePlugins, ...overlayPlugins]))

  // Never allow autoupdate; version is pinned.
  merged.autoupdate = false

  // Model wins if non-empty.
  if (model !== "") merged.model = model

  return { ok: true, config: merged }
}

// CLI main guard: node merge-config.mjs <config-file-path>
if (import.meta.url === `file://${process.argv[1]}`) {
  const fs = await import("node:fs")
  const path = await import("node:path")

  const cfgPath = process.argv[2]
  let base
  try {
    base = JSON.parse(fs.readFileSync(cfgPath, "utf8"))
  } catch (e) {
    process.stderr.write(`cannot read base opencode config: ${e.message}\n`)
    process.exit(2)
  }

  const overlayRaw = process.env.WORKSPACE_OPENCODE_CONFIG || ""
  const modelRaw = process.env.WORKSPACE_OPENCODE_MODEL || ""

  const result = mergeConfig(base, overlayRaw, modelRaw)
  if (!result.ok) {
    process.stderr.write(result.error + "\n")
    process.exit(2)
  }

  const output = JSON.stringify(result.config, null, 2) + "\n"
  const tmpPath = `${cfgPath}.tmp-${process.pid}`
  try {
    fs.writeFileSync(tmpPath, output, { encoding: "utf8" })
    fs.renameSync(tmpPath, cfgPath)
  } catch (e) {
    process.stderr.write(`cannot write opencode config: ${e.message}\n`)
    // Clean up temp file if it exists
    try { fs.unlinkSync(tmpPath) } catch { /* ignore */ }
    process.exit(2)
  }

  process.exit(0)
}
