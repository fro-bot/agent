/**
 * io.boundary.test.ts — Boundary enforcement for the centralized Discord I/O helper.
 *
 * Boundary enforcement: A boundary check that FAILS if any raw Discord content-send
 * bypasses `src/discord/io.ts` in the gateway source, so the `allowedMentions:{parse:[]}`
 * guard cannot silently drift back out in future code.
 *
 * Approach: grep-in-test (source-scanning). Reads all non-test gateway TypeScript
 * source files and scans for raw Discord content-send method-call patterns. Fails
 * if any such pattern appears outside the explicitly-allowlisted files.
 *
 * Patterns scanned (raw discord.js content-send methods io.ts wraps):
 *   .editReply(  — interaction edit
 *   .reply(      — any .reply call (interaction.reply, message.reply, etc.)
 *   .send(       — Thread/Message send
 *   .edit(       — Message edit
 *
 * Excluded from matching (ACKs/typing, not content sends):
 *   .deferReply(   — acknowledgement, not a content send
 *   .sendTyping(   — typing indicator, not a content send
 *
 * Line comments are excluded from matching (lines whose first non-whitespace
 * characters are `//`).
 *
 * The io.ts helper NAMES (`sendMessage`, `editMessage`, `replyInteraction`,
 * `editInteraction`) do NOT contain the raw method-call substrings being scanned
 * (`.send(`, `.edit(`, `.reply(`, `.editReply(`) so they cannot produce false positives.
 *
 * Second describe block — allowlisted files keep their own mention guards:
 * Pins that each content-sending allowlisted file still carries at least as many
 * `allowedMentions:{parse:[]}` guards as it has raw content-send call sites.
 * A future edit that silently drops a guard would fail this check even though the
 * main boundary test (which only scans non-allowlisted files) would not notice.
 */

import {globSync, readFileSync} from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {describe, expect, it} from 'vitest'

// ---------------------------------------------------------------------------
// Resolve the gateway src root relative to this test file
// ---------------------------------------------------------------------------

const thisDir = path.dirname(fileURLToPath(import.meta.url))
// This file lives at packages/gateway/src/discord/ — go up 1 level to reach src/
const gatewaySrcRoot = path.resolve(thisDir, '..')

// ---------------------------------------------------------------------------
// Allowlist — files that are PERMITTED to contain raw Discord content-send calls.
// Each entry is a path relative to gatewaySrcRoot (i.e. relative to packages/gateway/src/).
// Every exclusion is a deliberate, reviewed decision — add a comment explaining why.
// ---------------------------------------------------------------------------

const ALLOWLISTED_FILES: readonly string[] = [
  // The helper module itself — it IS the centralized wrapper; raw calls here are intentional.
  'discord/io.ts',

  // Reaction API only (react / users.remove) — not a content send/reply/edit.
  // io.ts's surface does not cover the reaction API, so this file is out of scope.
  'discord/reactions.ts',

  // Deliberately-excluded best-effort site: live status message lifecycle.
  // Already sets allowedMentions:{parse:[]} and catches; no duplication to collapse.
  // Firm scope boundary from the plan: do NOT migrate already-correct best-effort sites.
  'discord/status-message.ts',

  // Deliberately-excluded best-effort site: Discord presence/embed posting.
  // Already sets allowedMentions:{parse:[]} and catches; same firm scope boundary.
  'discord/presence.ts',

  // Deliberately-excluded best-effort site: recovery interruption note.
  // Already sets allowedMentions:{parse:[]} and catches; same firm scope boundary.
  'execute/recovery.ts',
]

// ---------------------------------------------------------------------------
// Raw content-send patterns to detect
// ---------------------------------------------------------------------------

/**
 * Patterns that indicate a raw Discord content-send call bypassing io.ts.
 *
 * Precision notes:
 * - `.editReply(` — raw interaction edit; io.ts helper is named `editInteraction`
 * - `.reply(` — bare pattern catches both `interaction.reply(` and `message.reply(`;
 *   io.ts helper names (`replyInteraction`, `replyInteractionAsync`) do not contain `.reply(`
 * - `.send(` — raw Thread/Message send; io.ts helper is named `sendMessage`
 * - `.edit(` — raw Message edit; io.ts helper is named `editMessage`
 *
 * Excluded (not content sends):
 * - `.deferReply(` — ACK, not a content send
 * - `.sendTyping(` — typing indicator, not a content send
 */
const RAW_SEND_PATTERNS: readonly RegExp[] = [/\.editReply\(/, /\.reply\(/, /\.send\(/, /\.edit\(/]

/**
 * Patterns to EXCLUDE from matching even when a raw-send pattern fires.
 * These are ACKs/typing indicators that are NOT content sends.
 */
const EXCLUDED_PATTERNS: readonly RegExp[] = [/\.deferReply\(/, /\.sendTyping\(/]

// ---------------------------------------------------------------------------
// Scanner logic
// ---------------------------------------------------------------------------

interface RawSendViolation {
  readonly file: string
  readonly line: number
  readonly text: string
  readonly pattern: string
}

/**
 * Scan a single file's content for raw Discord content-send patterns.
 * Returns violations found (empty array = clean).
 *
 * Skips:
 * - Lines whose first non-whitespace characters are `//` (line comments)
 * - Lines that match an excluded pattern (deferReply, sendTyping)
 */
function scanContent(content: string, filePath: string): RawSendViolation[] {
  const violations: RawSendViolation[] = []
  const lines = content.split('\n')

  for (const [i, line] of lines.entries()) {
    const trimmed = line.trimStart()

    // Skip line comments
    if (trimmed.startsWith('//')) continue

    // Skip lines that are ACKs/typing (not content sends)
    if (EXCLUDED_PATTERNS.some(p => p.test(line))) continue

    // Check for raw content-send patterns
    for (const pattern of RAW_SEND_PATTERNS) {
      if (pattern.test(line)) {
        violations.push({
          file: filePath,
          line: i + 1,
          text: line.trim(),
          pattern: pattern.toString(),
        })
        break // one violation per line is enough
      }
    }
  }

  return violations
}

/**
 * Enumerate all non-test TypeScript source files under gatewaySrcRoot,
 * excluding allowlisted files, and scan each for raw content-send patterns.
 */
function scanGatewaySource(): RawSendViolation[] {
  // globSync with **/*.{ts,mts,cts} will only match files (not directories)
  const allFiles = globSync('**/*.{ts,mts,cts}', {cwd: gatewaySrcRoot})

  const violations: RawSendViolation[] = []

  for (const relPath of allFiles) {
    // Skip test files
    if (relPath.endsWith('.test.ts') || relPath.endsWith('.test.mts') || relPath.endsWith('.test.cts')) continue

    // Skip allowlisted files
    if (ALLOWLISTED_FILES.includes(relPath)) continue

    const absPath = path.join(gatewaySrcRoot, relPath)
    const content = readFileSync(absPath, 'utf8')
    const fileViolations = scanContent(content, relPath)
    violations.push(...fileViolations)
  }

  return violations
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('io.ts boundary enforcement: no raw Discord content-sends bypass io.ts', () => {
  it('gateway source tree is clean — no raw content-send calls outside the allowlist', () => {
    // #given — the fully migrated source tree
    // #when — scan all non-test, non-allowlisted source files
    const violations = scanGatewaySource()

    // #then — zero violations; if this fails, a raw send has bypassed io.ts
    if (violations.length > 0) {
      const report = violations.map(v => `  ${v.file}:${v.line}: ${v.text}  [matched: ${v.pattern}]`).join('\n')
      throw new Error(
        `Raw Discord content-send calls found outside io.ts allowlist.\n` +
          `These bypass the allowedMentions:{parse:[]} guard.\n` +
          `Either route through io.ts or add to the ALLOWLISTED_FILES with a justification comment.\n\n` +
          `Violations:\n${report}`,
      )
    }

    expect(violations).toHaveLength(0)
  })

  it('self-test: scanner WOULD flag a raw interaction.editReply outside the allowlist', () => {
    // #given — a fixture string simulating a non-allowlisted file with a raw editReply call
    const fixtureContent = [
      '// some-command.ts',
      'export async function handleCommand(interaction: SomeInteraction) {',
      "  await interaction.editReply({content: 'hello world'})",
      '}',
    ].join('\n')

    // #when — run the scanner against the fixture
    const violations = scanContent(fixtureContent, 'discord/commands/some-command.ts')

    // #then — the scanner must flag the raw editReply call
    expect(violations.length).toBeGreaterThan(0)
    expect(violations[0]?.text).toContain('.editReply(')
  })

  it('self-test: scanner WOULD flag a raw thread.send outside the allowlist', () => {
    // #given — a fixture string simulating a non-allowlisted file with a raw .send call
    const fixtureContent = [
      '// streaming.ts',
      'async function safeSend(thread: SinkThread, content: string) {',
      '  await thread.send({content, allowedMentions: {parse: []}})',
      '}',
    ].join('\n')

    // #when
    const violations = scanContent(fixtureContent, 'discord/streaming.ts')

    // #then — the scanner must flag the raw .send call
    expect(violations.length).toBeGreaterThan(0)
    expect(violations[0]?.text).toContain('.send(')
  })

  it('self-test: scanner does NOT flag deferReply (ACK, not a content send)', () => {
    // #given — a fixture with only a deferReply call
    const fixtureContent = [
      'async function handle(interaction: SomeInteraction) {',
      '  await interaction.deferReply({ephemeral: true})',
      '}',
    ].join('\n')

    // #when
    const violations = scanContent(fixtureContent, 'discord/commands/some-command.ts')

    // #then — deferReply is excluded; no violation
    expect(violations).toHaveLength(0)
  })

  it('self-test: scanner does NOT flag sendTyping (typing indicator, not a content send)', () => {
    // #given — a fixture with only a sendTyping call
    const fixtureContent = ['async function handle(thread: SomeThread) {', '  await thread.sendTyping()', '}'].join(
      '\n',
    )

    // #when
    const violations = scanContent(fixtureContent, 'discord/status-message.ts')

    // #then — sendTyping is excluded; no violation
    expect(violations).toHaveLength(0)
  })

  it('self-test: scanner does NOT flag io.ts helper names (sendMessage, editMessage, etc.)', () => {
    // #given — a fixture using the io.ts helper names (the CORRECT calls)
    const fixtureContent = [
      'import {sendMessage, editMessage, replyInteraction, editInteraction} from "./io.js"',
      'async function handle(thread: SinkThread, msg: Message, interaction: RepliableInteractionTarget) {',
      '  await sendMessage(thread, {content: "hello"}, logger)',
      '  await editMessage(msg, {content: "updated"}, logger)',
      '  yield* replyInteraction(interaction, {content: "reply"}, logger)',
      '  yield* editInteraction(interaction, {content: "edit"}, logger)',
      '}',
    ].join('\n')

    // #when
    const violations = scanContent(fixtureContent, 'discord/commands/some-command.ts')

    // #then — helper names do not contain raw method-call substrings; no violation
    expect(violations).toHaveLength(0)
  })

  it('self-test: scanner skips line comments containing raw patterns', () => {
    // #given — a fixture where the raw pattern only appears in a line comment
    const fixtureContent = [
      '// Previously used: interaction.editReply({content: "old approach"})',
      '// Also: thread.send({content: "old"})',
      'export function doSomething() { return 42 }',
    ].join('\n')

    // #when
    const violations = scanContent(fixtureContent, 'discord/commands/some-command.ts')

    // #then — comment lines are skipped; no violation
    expect(violations).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Allowlisted-file guard coverage
// ---------------------------------------------------------------------------

/**
 * Count occurrences of `allowedMentions: {parse: []}` (whitespace-tolerant) in a
 * file's content. Skips line comments so a commented-out guard is not counted.
 *
 * Why whitespace-tolerant: formatters may normalise spacing around the colon or
 * inside the braces; the regex must survive those variations without false negatives.
 */
function countMentionGuards(content: string): number {
  // Matches `allowedMentions` followed by optional whitespace, a colon, optional
  // whitespace, `{`, optional whitespace, `parse`, optional whitespace, `:`,
  // optional whitespace, `[`, optional whitespace, `]`.
  const guardPattern = /allowedMentions\s*:\s*\{\s*parse\s*:\s*\[\s*\]/
  let count = 0
  for (const line of content.split('\n')) {
    if (line.trimStart().startsWith('//')) continue
    if (guardPattern.test(line)) count++
  }
  return count
}

/**
 * Read an allowlisted source file and return its content.
 * Path is relative to gatewaySrcRoot (same convention as ALLOWLISTED_FILES).
 */
function readAllowlistedFile(relPath: string): string {
  return readFileSync(path.join(gatewaySrcRoot, relPath), 'utf8')
}

describe('allowlisted files keep their own mention guards', () => {
  // ── Content-sending allowlisted files ──────────────────────────────────────
  //
  // Each of these files was deliberately excluded from the io.ts migration
  // because they already carry their own `allowedMentions:{parse:[]}` guards.
  // These tests pin that the guards are still present and cover every raw send
  // site — so a future edit that silently drops a guard is caught here even
  // though the main boundary test only scans non-allowlisted files.

  it('presence.ts: allowedMentions guards >= raw content-send sites', () => {
    // #given — the presence.ts source (1 raw .send call, 1 guard at time of writing)
    const content = readAllowlistedFile('discord/presence.ts')

    // #when — count raw sends and guards
    const rawSendCount = scanContent(content, 'discord/presence.ts').length
    const guardCount = countMentionGuards(content)

    // #then — every send site must be covered by a guard
    expect(guardCount).toBeGreaterThanOrEqual(rawSendCount)
    // Non-vacuousness: there must be at least one raw send to guard
    expect(rawSendCount).toBeGreaterThan(0)
  })

  it('status-message.ts: allowedMentions guards >= raw content-send sites', () => {
    // #given — status-message.ts (3 raw send/edit calls, 3 guards at time of writing:
    //          safePost → .send, safeEdit → .edit, terminalEdit → .edit)
    const content = readAllowlistedFile('discord/status-message.ts')

    // #when
    const rawSendCount = scanContent(content, 'discord/status-message.ts').length
    const guardCount = countMentionGuards(content)

    // #then
    expect(guardCount).toBeGreaterThanOrEqual(rawSendCount)
    expect(rawSendCount).toBeGreaterThan(0)
  })

  it('execute/recovery.ts: allowedMentions guards >= raw content-send sites', () => {
    // #given — recovery.ts (1 raw .send call, 1 guard at time of writing)
    const content = readAllowlistedFile('execute/recovery.ts')

    // #when
    const rawSendCount = scanContent(content, 'execute/recovery.ts').length
    const guardCount = countMentionGuards(content)

    // #then
    expect(guardCount).toBeGreaterThanOrEqual(rawSendCount)
    expect(rawSendCount).toBeGreaterThan(0)
  })

  // ── Reaction-only allowlisted file ─────────────────────────────────────────
  //
  // reactions.ts is allowlisted because it uses the reaction API (.react /
  // .users.remove), NOT because it sends content. It must contain ZERO raw
  // content-send call sites — if a content send ever appears here it should
  // route through io.ts instead.

  it('reactions.ts: contains ZERO raw content-send call sites (reaction API only)', () => {
    // #given — reactions.ts source
    const content = readAllowlistedFile('discord/reactions.ts')

    // #when — scan for raw content-send patterns
    const violations = scanContent(content, 'discord/reactions.ts')

    // #then — no content sends; this file is allowlisted for the reaction API only
    expect(violations).toHaveLength(0)
  })

  // ── Non-vacuousness self-test ───────────────────────────────────────────────
  //
  // Verifies that the guard-counting logic would actually flag a file that has
  // a raw content send WITHOUT a corresponding allowedMentions guard — i.e. the
  // guard-coverage check is not trivially passing because countMentionGuards
  // always returns a large number.

  it('self-test: guard-coverage check WOULD flag a raw send without allowedMentions', () => {
    // #given — a synthetic file with one raw .send call and NO allowedMentions guard
    const fixtureContent = [
      '// some-allowlisted-file.ts',
      'async function postNote(thread: SomeThread) {',
      "  await thread.send({content: 'The previous task was interrupted.'})",
      '}',
    ].join('\n')

    // #when — count raw sends and guards in the fixture
    const rawSendCount = scanContent(fixtureContent, 'discord/some-allowlisted-file.ts').length
    const guardCount = countMentionGuards(fixtureContent)

    // #then — the fixture has a send but no guard; coverage check would fail
    expect(rawSendCount).toBeGreaterThan(0)
    expect(guardCount).toBeLessThan(rawSendCount)
  })
})
