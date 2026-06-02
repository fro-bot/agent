import { test } from "node:test"
import assert from "node:assert/strict"
import { mergeConfig } from "./merge-config.mjs"

const BASE = {
  $schema: "https://opencode.ai/config.json",
  autoupdate: false,
  plugin: ["@fro.bot/systematic@2.24.0"],
}

test("provider overlay applied (baseURL preserved)", () => {
  const overlay = JSON.stringify({
    provider: { anthropic: { options: { baseURL: "https://cliproxy.fro.bot/v1" } } },
  })
  const result = mergeConfig(BASE, overlay, "")
  assert.ok(result.ok, result.error)
  assert.deepEqual(result.config.provider, { anthropic: { options: { baseURL: "https://cliproxy.fro.bot/v1" } } })
})

test("plugin preserved when overlay sets plugin:[]", () => {
  const overlay = JSON.stringify({ plugin: [] })
  const result = mergeConfig(BASE, overlay, "")
  assert.ok(result.ok, result.error)
  assert.ok(result.config.plugin.includes("@fro.bot/systematic@2.24.0"), "systematic plugin missing")
})

test("autoupdate forced false when overlay sets autoupdate:true", () => {
  const overlay = JSON.stringify({ autoupdate: true })
  const result = mergeConfig(BASE, overlay, "")
  assert.ok(result.ok, result.error)
  assert.equal(result.config.autoupdate, false)
})

test("non-string plugin entries in overlay are filtered", () => {
  const overlay = JSON.stringify({ plugin: [42, null, "extra-plugin"] })
  const result = mergeConfig(BASE, overlay, "")
  assert.ok(result.ok, result.error)
  assert.ok(!result.config.plugin.includes(42), "numeric plugin entry leaked through")
  assert.ok(result.config.plugin.includes("extra-plugin"), "string plugin entry missing")
  assert.ok(result.config.plugin.includes("@fro.bot/systematic@2.24.0"), "systematic plugin missing")
})

test("model set when valid provider/model form", () => {
  const result = mergeConfig(BASE, "", "anthropic/claude-sonnet-4-6")
  assert.ok(result.ok, result.error)
  assert.equal(result.config.model, "anthropic/claude-sonnet-4-6")
})

test("model rejected when no slash (just model name)", () => {
  const result = mergeConfig(BASE, "", "claude-sonnet")
  assert.equal(result.ok, false)
  assert.ok(result.error.includes("provider/model form"), `got: ${result.error}`)
})

test("model rejected when leading slash only (/x)", () => {
  const result = mergeConfig(BASE, "", "/x")
  assert.equal(result.ok, false)
  assert.ok(result.error.includes("provider/model form"), `got: ${result.error}`)
})

test("model rejected when trailing slash only (x/)", () => {
  const result = mergeConfig(BASE, "", "x/")
  assert.equal(result.ok, false)
  assert.ok(result.error.includes("provider/model form"), `got: ${result.error}`)
})

test("overlay not-JSON rejected", () => {
  const result = mergeConfig(BASE, "{not valid json", "")
  assert.equal(result.ok, false)
  assert.ok(result.error.includes("not valid JSON"), `got: ${result.error}`)
})

test("overlay array rejected", () => {
  const result = mergeConfig(BASE, "[]", "")
  assert.equal(result.ok, false)
  assert.ok(result.error.includes("must be a JSON object"), `got: ${result.error}`)
})

test("both empty → base unchanged except autoupdate:false", () => {
  const base = { ...BASE, autoupdate: true }
  const result = mergeConfig(base, "", "")
  assert.ok(result.ok, result.error)
  assert.equal(result.config.autoupdate, false)
  assert.deepEqual(result.config.plugin, BASE.plugin)
  assert.ok(!("model" in result.config), "model should not be present")
})

test("overlay whitespace-only treated as empty (no parse error)", () => {
  const result = mergeConfig(BASE, "   \n  ", "")
  assert.ok(result.ok, result.error)
  // No overlay keys besides what base has
  assert.ok(!("provider" in result.config), "provider should not be injected from whitespace overlay")
})

test("plugin dedup: overlay adds duplicate systematic — deduped", () => {
  const overlay = JSON.stringify({ plugin: ["@fro.bot/systematic@2.24.0", "other-plugin"] })
  const result = mergeConfig(BASE, overlay, "")
  assert.ok(result.ok, result.error)
  const count = result.config.plugin.filter((p) => p === "@fro.bot/systematic@2.24.0").length
  assert.equal(count, 1, "systematic plugin should appear exactly once")
  assert.ok(result.config.plugin.includes("other-plugin"))
})
