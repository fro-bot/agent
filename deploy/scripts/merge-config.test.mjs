import assert from 'node:assert/strict'
import {test} from 'node:test'

import {mergeConfig} from './merge-config.mjs'

const BASE = {
  $schema: 'https://opencode.ai/config.json',
  autoupdate: false,
  plugin: ['@fro.bot/systematic@2.24.0'],
}

test('provider overlay applied (baseURL preserved)', () => {
  const overlay = JSON.stringify({
    provider: {anthropic: {options: {baseURL: 'https://cliproxy.fro.bot/v1'}}},
  })
  const result = mergeConfig(BASE, overlay, '')
  assert.ok(result.ok, result.error)
  assert.deepEqual(result.config.provider, {anthropic: {options: {baseURL: 'https://cliproxy.fro.bot/v1'}}})
})

test('plugin preserved when overlay sets plugin:[]', () => {
  const overlay = JSON.stringify({plugin: []})
  const result = mergeConfig(BASE, overlay, '')
  assert.ok(result.ok, result.error)
  assert.ok(result.config.plugin.includes('@fro.bot/systematic@2.24.0'), 'systematic plugin missing')
})

test('autoupdate forced false when overlay sets autoupdate:true', () => {
  const overlay = JSON.stringify({autoupdate: true})
  const result = mergeConfig(BASE, overlay, '')
  assert.ok(result.ok, result.error)
  assert.equal(result.config.autoupdate, false)
})

test('non-string plugin entries in overlay are filtered', () => {
  const overlay = JSON.stringify({plugin: [42, null, 'extra-plugin']})
  const result = mergeConfig(BASE, overlay, '')
  assert.ok(result.ok, result.error)
  assert.equal(result.config.plugin.includes(42), false, 'numeric plugin entry leaked through')
  assert.ok(result.config.plugin.includes('extra-plugin'), 'string plugin entry missing')
  assert.ok(result.config.plugin.includes('@fro.bot/systematic@2.24.0'), 'systematic plugin missing')
})

test('model set when valid provider/model form', () => {
  const result = mergeConfig(BASE, '', 'anthropic/claude-sonnet-4-6')
  assert.ok(result.ok, result.error)
  assert.equal(result.config.model, 'anthropic/claude-sonnet-4-6')
})

test('model rejected when no slash (just model name)', () => {
  const result = mergeConfig(BASE, '', 'claude-sonnet')
  assert.equal(result.ok, false)
  assert.ok(result.error.includes('provider/model form'), `got: ${result.error}`)
})

test('model rejected when leading slash only (/x)', () => {
  const result = mergeConfig(BASE, '', '/x')
  assert.equal(result.ok, false)
  assert.ok(result.error.includes('provider/model form'), `got: ${result.error}`)
})

test('model rejected when trailing slash only (x/)', () => {
  const result = mergeConfig(BASE, '', 'x/')
  assert.equal(result.ok, false)
  assert.ok(result.error.includes('provider/model form'), `got: ${result.error}`)
})

test('overlay not-JSON rejected', () => {
  const result = mergeConfig(BASE, '{not valid json', '')
  assert.equal(result.ok, false)
  assert.ok(result.error.includes('not valid JSON'), `got: ${result.error}`)
})

test('overlay array rejected', () => {
  const result = mergeConfig(BASE, '[]', '')
  assert.equal(result.ok, false)
  assert.ok(result.error.includes('must be a JSON object'), `got: ${result.error}`)
})

test('both empty → base unchanged except autoupdate:false', () => {
  const base = {...BASE, autoupdate: true}
  const result = mergeConfig(base, '', '')
  assert.ok(result.ok, result.error)
  assert.equal(result.config.autoupdate, false)
  assert.deepEqual(result.config.plugin, BASE.plugin)
  assert.equal('model' in result.config, false, 'model should not be present')
})

test('overlay whitespace-only treated as empty (no parse error)', () => {
  const result = mergeConfig(BASE, '   \n  ', '')
  assert.ok(result.ok, result.error)
  // No overlay keys besides what base has
  assert.equal('provider' in result.config, false, 'provider should not be injected from whitespace overlay')
})

test('plugin dedup: overlay adds duplicate systematic — deduped', () => {
  const overlay = JSON.stringify({plugin: ['@fro.bot/systematic@2.24.0', 'other-plugin']})
  const result = mergeConfig(BASE, overlay, '')
  assert.ok(result.ok, result.error)
  const count = result.config.plugin.filter(p => p === '@fro.bot/systematic@2.24.0').length
  assert.equal(count, 1, 'systematic plugin should appear exactly once')
  assert.ok(result.config.plugin.includes('other-plugin'))
})

test('model with spaces around slash normalized (anthropic / claude → anthropic/claude)', () => {
  const result = mergeConfig(BASE, '', 'anthropic / claude')
  assert.ok(result.ok, result.error)
  assert.equal(result.config.model, 'anthropic/claude')
})

test('multi-slash model accepted (openai/gpt-4/turbo → provider=openai, model=gpt-4/turbo)', () => {
  const result = mergeConfig(BASE, '', 'openai/gpt-4/turbo')
  assert.ok(result.ok, result.error)
  assert.equal(result.config.model, 'openai/gpt-4/turbo')
})

test('model rejected when no slash (claudewithnoslash)', () => {
  const result = mergeConfig(BASE, '', 'claudewithnoslash')
  assert.equal(result.ok, false)
  assert.ok(result.error.includes('provider/model form'), `got: ${result.error}`)
})

test('model rejected when leading slash only (/x) — providerID empty', () => {
  const result = mergeConfig(BASE, '', '/x')
  assert.equal(result.ok, false)
  assert.ok(result.error.includes('provider/model form'), `got: ${result.error}`)
})

test('model rejected when trailing slash only (x/) — modelID empty', () => {
  const result = mergeConfig(BASE, '', 'x/')
  assert.equal(result.ok, false)
  assert.ok(result.error.includes('provider/model form'), `got: ${result.error}`)
})

test('model rejected when modelID contains control character', () => {
  const result = mergeConfig(BASE, '', 'anthropic/claude\u0001')
  assert.equal(result.ok, false)
  assert.ok(result.error.includes('control characters'), `got: ${result.error}`)
})

test('non-array plugin overlay (string) cannot replace plugin array', () => {
  const overlay = JSON.stringify({plugin: 'evil-plugin'})
  const result = mergeConfig(BASE, overlay, '')
  assert.equal(result.ok, true)
  assert.ok(Array.isArray(result.config.plugin), 'plugin must remain an array')
  assert.deepEqual(result.config.plugin, ['@fro.bot/systematic@2.24.0'])
})

// ─── Unit 5: Unsafe-fix regression guards ────────────────────────────────────
// These tests prevent the rejected global-pregrant approach from returning.
// The rejected approach would have injected global permission grants for
// high-risk tools (bash, edit, external_directory, etc.) into the merged
// OpenCode config, bypassing the Gateway's explicit approval-mode boundary.
//
// Each test is written to FAIL against an implementation that synthesizes
// permission grants and PASS against the current clean merge-only behavior.

const HIGH_RISK_KEYS = ['bash', 'edit', 'external_directory', 'task', 'write']

test("merge does not synthesize any 'permissions' key when overlay is empty", () => {
  const result = mergeConfig(BASE, '', '')
  assert.ok(result.ok, result.error)
  assert.equal('permissions' in result.config, false, 'permissions must not be injected when overlay is empty')
})

test("merge does not synthesize any 'permissions' key when overlay is whitespace", () => {
  const result = mergeConfig(BASE, '   \n  ', '')
  assert.ok(result.ok, result.error)
  assert.equal('permissions' in result.config, false, 'permissions must not be injected from whitespace overlay')
})

test("merge does not synthesize any 'permissions' key when overlay has unrelated keys", () => {
  const overlay = JSON.stringify({provider: {anthropic: {options: {baseURL: 'https://example.com'}}}})
  const result = mergeConfig(BASE, overlay, '')
  assert.ok(result.ok, result.error)
  assert.equal('permissions' in result.config, false, 'permissions must not be injected alongside provider overlay')
})

test("merge does not synthesize any 'permissions' key when model is set", () => {
  const result = mergeConfig(BASE, '', 'anthropic/claude-sonnet-4-6')
  assert.ok(result.ok, result.error)
  assert.equal('permissions' in result.config, false, 'permissions must not be injected when model is set')
})

test('merge does not auto-approve bash in any synthesized permission block', () => {
  // Simulate what the rejected unsafe implementation would have done: inject
  // a permissions block that globally allows bash. The current implementation
  // must not produce this output regardless of inputs.
  const result = mergeConfig(BASE, '', '')
  assert.ok(result.ok, result.error)
  const cfg = result.config
  if (!('permissions' in cfg)) return // clean — no permissions block at all
  // If permissions somehow exists, it must not contain a bash allow.
  const perms = cfg.permissions
  if (!Array.isArray(perms)) return
  const bashAllow = perms.find(
    r => typeof r === 'object' && r !== null && r.permission === 'bash' && r.action === 'allow',
  )
  assert.equal(bashAllow, undefined, 'merge must not synthesize a global bash allow rule')
})

test('merge does not auto-approve edit in any synthesized permission block', () => {
  const result = mergeConfig(BASE, '', '')
  assert.ok(result.ok, result.error)
  const cfg = result.config
  if (!('permissions' in cfg)) return
  const perms = cfg.permissions
  if (!Array.isArray(perms)) return
  const editAllow = perms.find(
    r => typeof r === 'object' && r !== null && r.permission === 'edit' && r.action === 'allow',
  )
  assert.equal(editAllow, undefined, 'merge must not synthesize a global edit allow rule')
})

test('merge does not auto-approve external_directory in any synthesized permission block', () => {
  const result = mergeConfig(BASE, '', '')
  assert.ok(result.ok, result.error)
  const cfg = result.config
  if (!('permissions' in cfg)) return
  const perms = cfg.permissions
  if (!Array.isArray(perms)) return
  const extDirAllow = perms.find(
    r => typeof r === 'object' && r !== null && r.permission === 'external_directory' && r.action === 'allow',
  )
  assert.equal(extDirAllow, undefined, 'merge must not synthesize a global external_directory allow rule')
})

test('merge does not inject wildcard allow rule for any high-risk permission', () => {
  // The rejected approach might have used a wildcard pattern ("*") with action "allow".
  // Verify no such rule appears in the output for any high-risk key.
  const result = mergeConfig(BASE, '', '')
  assert.ok(result.ok, result.error)
  const cfg = result.config
  if (!('permissions' in cfg)) return
  const perms = cfg.permissions
  if (!Array.isArray(perms)) return
  for (const key of HIGH_RISK_KEYS) {
    const wildcardAllow = perms.find(
      r =>
        typeof r === 'object' &&
        r !== null &&
        r.permission === key &&
        r.action === 'allow' &&
        (r.pattern === '*' || r.pattern === '**'),
    )
    assert.equal(wildcardAllow, undefined, `merge must not synthesize a wildcard allow rule for '${key}'`)
  }
})

test('explicit operator permissions in base are preserved unchanged by merge', () => {
  // Operators may supply their own permission config. Merge must pass it through
  // without rewriting it into hidden auto-approval.
  const baseWithPerms = {
    ...BASE,
    permissions: [{permission: 'read', pattern: '/workspace/**', action: 'allow'}],
  }
  const result = mergeConfig(baseWithPerms, '', '')
  assert.ok(result.ok, result.error)
  assert.deepEqual(
    result.config.permissions,
    [{permission: 'read', pattern: '/workspace/**', action: 'allow'}],
    'operator-supplied base permissions must be preserved exactly',
  )
})

test('explicit operator permissions in overlay are preserved unchanged by merge', () => {
  // An operator may supply permissions via overlay. Merge must pass them through
  // without injecting additional auto-approval rules.
  const overlay = JSON.stringify({
    permissions: [{permission: 'glob', pattern: '/workspace/**', action: 'allow'}],
  })
  const result = mergeConfig(BASE, overlay, '')
  assert.ok(result.ok, result.error)
  assert.deepEqual(
    result.config.permissions,
    [{permission: 'glob', pattern: '/workspace/**', action: 'allow'}],
    'operator-supplied overlay permissions must be preserved exactly',
  )
})

test('overlay permissions do not get merged with synthesized high-risk grants', () => {
  // If an operator supplies a restrictive permission list, merge must not append
  // any synthesized high-risk allows to it.
  const overlay = JSON.stringify({
    permissions: [{permission: 'read', pattern: '/workspace/**', action: 'allow'}],
  })
  const result = mergeConfig(BASE, overlay, '')
  assert.ok(result.ok, result.error)
  const perms = result.config.permissions
  assert.ok(Array.isArray(perms), 'permissions should be an array when operator supplies one')
  for (const key of HIGH_RISK_KEYS) {
    const highRiskAllow = perms.find(
      r => typeof r === 'object' && r !== null && r.permission === key && r.action === 'allow',
    )
    assert.equal(highRiskAllow, undefined, `merge must not append a synthesized '${key}' allow to operator permissions`)
  }
})

test('model/plugin/autoupdate behavior unchanged when permissions are present in base', () => {
  // Regression guard: adding permissions to base must not break existing merge behavior.
  const baseWithPerms = {
    ...BASE,
    autoupdate: true,
    permissions: [{permission: 'read', pattern: '**', action: 'allow'}],
  }
  const overlay = JSON.stringify({plugin: ['extra-plugin']})
  const result = mergeConfig(baseWithPerms, overlay, 'anthropic/claude-sonnet-4-6')
  assert.ok(result.ok, result.error)
  assert.equal(result.config.autoupdate, false, 'autoupdate must remain forced false')
  assert.ok(result.config.plugin.includes('@fro.bot/systematic@2.24.0'), 'systematic plugin must be preserved')
  assert.ok(result.config.plugin.includes('extra-plugin'), 'overlay plugin must be included')
  assert.equal(result.config.model, 'anthropic/claude-sonnet-4-6', 'model must be set')
  assert.deepEqual(
    result.config.permissions,
    [{permission: 'read', pattern: '**', action: 'allow'}],
    'base permissions must be preserved',
  )
})

test('merge output contains no unexpected top-level keys beyond known safe set', () => {
  // Guard against future code accidentally adding new top-level keys that could
  // carry hidden policy (e.g., 'approvals', 'policy', 'grants', 'allow').
  const result = mergeConfig(BASE, '', '')
  assert.ok(result.ok, result.error)
  const KNOWN_SAFE_KEYS = new Set([
    '$schema',
    'autoupdate',
    'plugin',
    'model',
    'provider',
    'permissions',
    'theme',
    'keybinds',
    'mcp',
    'subagent_depth',
  ])
  const outputKeys = Object.keys(result.config)
  const unexpectedKeys = outputKeys.filter(k => !KNOWN_SAFE_KEYS.has(k) && !Object.keys(BASE).includes(k))
  assert.deepEqual(unexpectedKeys, [], `merge introduced unexpected top-level keys: ${unexpectedKeys.join(', ')}`)
})

// ─── Unit 6: subagent_depth pin (workspace-layer mirror of ci-config.ts R12) ─

test('subagent_depth: no depth anywhere → forced to numeric 1, no warning', () => {
  const result = mergeConfig(BASE, '', '')
  assert.ok(result.ok, result.error)
  assert.equal(result.config.subagent_depth, 1)
  assert.deepEqual(result.warnings, [])
})

test('subagent_depth: base depth greater than one → forced to 1, warning emitted', () => {
  const base = {...BASE, subagent_depth: 3}
  const result = mergeConfig(base, '', '')
  assert.ok(result.ok, result.error)
  assert.equal(result.config.subagent_depth, 1)
  assert.equal(result.warnings.length, 1)
  assert.ok(result.warnings[0].includes('subagent_depth'), `got: ${result.warnings[0]}`)
})

test('subagent_depth: overlay 0 forced to numeric 1, warning emitted', () => {
  const overlay = JSON.stringify({subagent_depth: 0})
  const result = mergeConfig(BASE, overlay, '')
  assert.ok(result.ok, result.error)
  assert.equal(result.config.subagent_depth, 1)
  assert.equal(result.warnings.length, 1)
})

test('subagent_depth: overlay 2 forced to numeric 1, warning emitted', () => {
  const overlay = JSON.stringify({subagent_depth: 2})
  const result = mergeConfig(BASE, overlay, '')
  assert.ok(result.ok, result.error)
  assert.equal(result.config.subagent_depth, 1)
  assert.equal(result.warnings.length, 1)
})

test('subagent_depth: overlay "1" (string) forced to numeric 1, warning emitted', () => {
  const overlay = JSON.stringify({subagent_depth: '1'})
  const result = mergeConfig(BASE, overlay, '')
  assert.ok(result.ok, result.error)
  assert.equal(result.config.subagent_depth, 1)
  assert.strictEqual(result.config.subagent_depth, 1)
  assert.equal(result.warnings.length, 1)
})

test('subagent_depth: overlay null forced to numeric 1, warning emitted', () => {
  const overlay = JSON.stringify({subagent_depth: null})
  const result = mergeConfig(BASE, overlay, '')
  assert.ok(result.ok, result.error)
  assert.equal(result.config.subagent_depth, 1)
  assert.equal(result.warnings.length, 1)
})

test('subagent_depth: overlay numeric 1 → no warning', () => {
  const overlay = JSON.stringify({subagent_depth: 1})
  const result = mergeConfig(BASE, overlay, '')
  assert.ok(result.ok, result.error)
  assert.equal(result.config.subagent_depth, 1)
  assert.deepEqual(result.warnings, [])
})

test('subagent_depth: hostile overlay changes an unrelated field but not depth', () => {
  // Load-bearing complement: proves the pin enforces depth specifically,
  // rather than the merger rejecting overlays wholesale.
  const overlay = JSON.stringify({subagent_depth: 99, theme: 'hostile-theme'})
  const result = mergeConfig(BASE, overlay, '')
  assert.ok(result.ok, result.error)
  assert.equal(result.config.subagent_depth, 1, 'subagent_depth must stay pinned to 1')
  assert.equal(result.config.theme, 'hostile-theme', 'unrelated overlay field must still merge')
  assert.equal(result.warnings.length, 1)
})

test('subagent_depth: permission config preserved, no injected pre-grants', () => {
  const overlay = JSON.stringify({
    subagent_depth: 5,
    permissions: [{permission: 'read', pattern: '/workspace/**', action: 'allow'}],
  })
  const result = mergeConfig(BASE, overlay, '')
  assert.ok(result.ok, result.error)
  assert.equal(result.config.subagent_depth, 1)
  assert.deepEqual(result.config.permissions, [{permission: 'read', pattern: '/workspace/**', action: 'allow'}])
})

test('subagent_depth: neither base nor overlay object is mutated', () => {
  const base = {...BASE, subagent_depth: 4}
  const baseSnapshot = JSON.parse(JSON.stringify(base))
  const overlayObj = {subagent_depth: 7}
  const overlaySnapshot = JSON.parse(JSON.stringify(overlayObj))
  const result = mergeConfig(base, JSON.stringify(overlayObj), '')
  assert.ok(result.ok, result.error)
  assert.equal(result.config.subagent_depth, 1)
  assert.deepEqual(base, baseSnapshot, 'base object must not be mutated')
  assert.deepEqual(overlayObj, overlaySnapshot, 'overlay object must not be mutated')
})
