import { test } from "node:test"
import assert from "node:assert/strict"
import { validateAuth } from "./validate-auth.mjs"

test("valid single provider", () => {
  const raw = JSON.stringify({ anthropic: { type: "api", key: "sk-test" } })
  assert.deepEqual(validateAuth(raw), { ok: true })
})

test("valid multi provider", () => {
  const raw = JSON.stringify({
    anthropic: { type: "api", key: "sk-a" },
    "openai.com": { type: "api", key: "sk-b" },
    "my-provider_1": { type: "api", key: "sk-c" },
  })
  assert.deepEqual(validateAuth(raw), { ok: true })
})

test("not JSON", () => {
  const result = validateAuth("not json at all")
  assert.equal(result.ok, false)
  assert.ok(result.error.includes("not valid JSON"), `got: ${result.error}`)
})

test("JSON array rejected", () => {
  const result = validateAuth(JSON.stringify([{ type: "api", key: "sk-x" }]))
  assert.equal(result.ok, false)
  assert.ok(result.error.includes("must be a JSON object"), `got: ${result.error}`)
})

test("null rejected", () => {
  const result = validateAuth("null")
  assert.equal(result.ok, false)
  assert.ok(result.error.includes("must be a JSON object"), `got: ${result.error}`)
})

test("empty object (no provider entries)", () => {
  const result = validateAuth("{}")
  assert.equal(result.ok, false)
  assert.ok(result.error.includes("no provider entries"), `got: ${result.error}`)
})

test("bad provider id with slash (path traversal shape)", () => {
  const result = validateAuth(JSON.stringify({ "../x": { type: "api", key: "sk-x" } }))
  assert.equal(result.ok, false)
  assert.ok(result.error.includes("provider id is invalid"), `got: ${result.error}`)
})

test("bad provider id with space", () => {
  const result = validateAuth(JSON.stringify({ "a b": { type: "api", key: "sk-x" } }))
  assert.equal(result.ok, false)
  assert.ok(result.error.includes("provider id is invalid"), `got: ${result.error}`)
})

test("entry not an object (string)", () => {
  const result = validateAuth(JSON.stringify({ anthropic: "sk-x" }))
  assert.equal(result.ok, false)
  assert.ok(result.error.includes("entry must be an object"), `got: ${result.error}`)
})

test("entry not an object (null)", () => {
  const result = validateAuth(JSON.stringify({ anthropic: null }))
  assert.equal(result.ok, false)
  assert.ok(result.error.includes("entry must be an object"), `got: ${result.error}`)
})

test("type !== 'api' (oauth rejected)", () => {
  const result = validateAuth(JSON.stringify({ anthropic: { type: "oauth" } }))
  assert.equal(result.ok, false)
  assert.ok(result.error.includes('type must be "api"'), `got: ${result.error}`)
})

test("empty key string rejected", () => {
  const result = validateAuth(JSON.stringify({ anthropic: { type: "api", key: "" } }))
  assert.equal(result.ok, false)
  assert.ok(result.error.includes('missing non-empty "key"'), `got: ${result.error}`)
})

test("whitespace-only key rejected", () => {
  const result = validateAuth(JSON.stringify({ anthropic: { type: "api", key: "   " } }))
  assert.equal(result.ok, false)
  assert.ok(result.error.includes('missing non-empty "key"'), `got: ${result.error}`)
})

test("missing key field rejected", () => {
  const result = validateAuth(JSON.stringify({ anthropic: { type: "api" } }))
  assert.equal(result.ok, false)
  assert.ok(result.error.includes('missing non-empty "key"'), `got: ${result.error}`)
})
