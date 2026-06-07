/**
 * Pure tool-part renderer for the Discord mention loop.
 *
 * Turns an extracted tool shape into a clean Discord summary line:
 * - Essential tool → one-line summary string
 * - Non-essential (read-only) tool, successful → null (caller appends nothing)
 * - Non-essential (read-only) tool, errored → terse error line (aids debugging)
 *
 * No SDK imports. No Discord imports. Pure functions only.
 *
 * Rendering logic ported from Kimaki (remorses/kimaki, MIT):
 *   cli/src/message-formatting.ts  — getToolSummaryText, formatPart
 *   cli/src/session-handler/thread-session-runtime.ts — isEssentialToolName
 * Adapted to our extracted tool shape (not Kimaki's Part types).
 */

// ---------------------------------------------------------------------------
// Input shape
// ---------------------------------------------------------------------------

/**
 * The extracted tool shape that run-core.ts pulls from a completed tool part.
 *
 * Fields consumed per tool:
 *   edit        → state.input.filePath, state.input.newString, state.input.oldString
 *   write       → state.input.filePath, state.input.content
 *   apply_patch → state.input.patchText
 *   bash        → state.input.command (or state.input.cmd), state.input.description
 *   skill       → state.input.name
 *   task        → state.input.description
 *   MCP/unknown → all state.input fields (truncated)
 */
export interface ExtractedToolPart {
  readonly tool: string
  readonly state: {
    readonly input?: Record<string, unknown>
    readonly title?: string
    readonly status: 'completed' | 'error'
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_BASH_COMMAND_INLINE_LENGTH = 100
const MAX_MCP_ARG_LENGTH = 50
const ERROR_GLYPH = '⨯'

/**
 * Tools that are always hidden (non-essential / read-only) when successful.
 * Everything NOT in this set is treated as essential (shown).
 * Errored hidden tools still render a terse error line for debugging.
 */
const HIDDEN_TOOLS = new Set(['read', 'grep', 'glob', 'list'])

/**
 * Read-only bash command prefixes that are hidden like other read-only tools.
 * Matched against the first command token (leading word) of the bash command.
 * If uncertain or compound, treat as essential (shown) — conservative default.
 */
const READ_ONLY_BASH_PREFIXES = new Set([
  'git ls-files',
  'git status',
  'git log',
  'git diff',
  'ls',
  'cat',
  'find',
  'grep',
  'rg',
  'pwd',
  'head',
  'tail',
  'wc',
  'which',
  'echo',
])

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Escape Discord inline markdown special characters so dynamic content
 * doesn't break formatting when wrapped in *, _, **, etc.
 */
function escapeInlineMarkdown(text: string): string {
  return text.replaceAll(/([*_~|`\\])/g, String.raw`\$1`)
}

/**
 * Normalize whitespace: convert newlines to spaces and collapse consecutive spaces.
 */
function normalizeWhitespace(text: string): string {
  return text.replaceAll(/[\r\n]+/g, ' ').replaceAll(/\s+/g, ' ')
}

/**
 * Extract the basename from a file path (last path segment).
 */
function basename(filePath: string): string {
  return filePath.split('/').pop() ?? ''
}

/**
 * Safely read a string property from an unknown input object.
 */
function str(input: Record<string, unknown> | undefined, key: string): string {
  const val = input?.[key]
  return typeof val === 'string' ? val : ''
}

/**
 * Returns true if the bash command is read-only (should be hidden like other read-only tools).
 * Matches on the first command token or known multi-word read-only prefixes.
 * Conservative: if uncertain, returns false (treat as essential = shown).
 */
function isReadOnlyBashCommand(command: string): boolean {
  const trimmed = command.trim()
  // Check multi-word prefixes first (e.g. "git ls-files", "git status")
  for (const prefix of READ_ONLY_BASH_PREFIXES) {
    if (trimmed === prefix || trimmed.startsWith(`${prefix} `) || trimmed.startsWith(`${prefix}\t`)) {
      return true
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// Patch line-count parser
// ---------------------------------------------------------------------------

/**
 * Count added and removed lines in a patch text.
 *
 * Supports two formats:
 * 1. Unified diff (`+++ b/file` headers) — standard git/diff output
 * 2. OpenCode `*** Begin Patch` / `*** Update File:` envelope — OpenCode's apply_patch format
 *
 * Falls back to { additions: 0, deletions: 0 } if unparseable.
 */
function parsePatchCounts(patchText: string): {
  fileName: string
  additions: number
  deletions: number
}[] {
  const results: {fileName: string; additions: number; deletions: number}[] = []
  let currentFile = ''
  let additions = 0
  let deletions = 0

  for (const line of patchText.split('\n')) {
    // OpenCode envelope: *** Update File: path/to/file
    if (line.startsWith('*** Update File:')) {
      if (currentFile !== '') {
        results.push({fileName: basename(currentFile), additions, deletions})
      }
      currentFile = line.replace(/^\*\*\* Update File:\s*/, '').trim()
      additions = 0
      deletions = 0
    } else if (line.startsWith('+++ b/') || line.startsWith('+++ ')) {
      // Unified diff header
      if (currentFile !== '') {
        results.push({fileName: basename(currentFile), additions, deletions})
      }
      currentFile = line.replace(/^\+\+\+ (?:b\/)?/, '')
      additions = 0
      deletions = 0
    } else if (line.startsWith('+') && !line.startsWith('+++') && !line.startsWith('*** ')) {
      additions++
    } else if (line.startsWith('-') && !line.startsWith('---') && !line.startsWith('*** ')) {
      deletions++
    }
  }

  // Flush last file
  if (currentFile !== '') {
    results.push({fileName: basename(currentFile), additions, deletions})
  }

  return results
}

// ---------------------------------------------------------------------------
// isEssentialTool
// ---------------------------------------------------------------------------

/**
 * Returns true if the tool should be shown in the Discord output.
 *
 * Hidden tools: read, grep, glob, list.
 * Read-only bash commands are also hidden (see isReadOnlyBashCommand).
 * Everything else (edit, write, apply_patch, side-effecting bash, skill, task, MCP, unknown) → shown.
 */
export function isEssentialTool(tool: string): boolean {
  return !HIDDEN_TOOLS.has(tool)
}

// ---------------------------------------------------------------------------
// summarizeTool
// ---------------------------------------------------------------------------

/**
 * Summarize a completed (or errored) tool part into a single Discord line.
 *
 * Returns:
 * - `null`   — tool is non-essential (hidden) AND successful; caller appends nothing
 * - `string` — one-line summary to append (essential tools, or errored hidden tools)
 *
 * Never throws on unexpected input shapes — unknown/malformed parts degrade
 * to a safe minimal summary or null.
 */
export function summarizeTool(part: ExtractedToolPart): string | null {
  const {tool, state} = part
  const {input, title, status} = state

  const isError = status === 'error'

  // Hidden tools (read, grep, glob, list): successful → null; errored → terse error line
  if (!isEssentialTool(tool)) {
    if (isError) {
      // Terse error line: ⨯ <tool>: <target> (no raw content)
      const target = str(input, 'filePath') || str(input, 'pattern') || str(input, 'path') || str(input, 'query')
      return target.length > 0 ? `${ERROR_GLYPH} ${tool}: ${target}` : `${ERROR_GLYPH} ${tool}`
    }
    return null
  }

  // Read-only bash: hide successful invocations (same as hidden tools).
  // Side-effecting bash stays shown. Errored read-only bash still shows (debugging aid).
  if (tool === 'bash' && !isError) {
    const command = str(input, 'command') || str(input, 'cmd')
    if (command.length > 0 && isReadOnlyBashCommand(command)) {
      return null
    }
  }

  // Compute the core summary text (without error prefix)
  const summary = computeSummary(tool, input, title)

  if (isError) {
    // Error: prefix with glyph, still summarized
    return `${ERROR_GLYPH} ${summary}`
  }

  return summary
}

/**
 * Compute the core summary string for a tool (no error prefix).
 * Falls back to the tool name if no meaningful summary can be produced.
 */
function computeSummary(tool: string, input: Record<string, unknown> | undefined, title: string | undefined): string {
  // --- edit ---
  if (tool === 'edit') {
    const filePath = str(input, 'filePath')
    const fileName = basename(filePath)
    if (fileName.length === 0) return tool
    const newString = str(input, 'newString')
    const oldString = str(input, 'oldString')
    const added = newString.length > 0 ? newString.split('\n').length : 0
    const removed = oldString.length > 0 ? oldString.split('\n').length : 0
    return `*${escapeInlineMarkdown(fileName)}* (+${added}-${removed})`
  }

  // --- write ---
  if (tool === 'write') {
    const filePath = str(input, 'filePath')
    const fileName = basename(filePath)
    if (fileName.length === 0) return tool
    const content = str(input, 'content')
    const lines = content.length > 0 ? content.split('\n').length : 0
    return `*${escapeInlineMarkdown(fileName)}* (${lines} ${lines === 1 ? 'line' : 'lines'})`
  }

  // --- apply_patch ---
  if (tool === 'apply_patch') {
    const patchText = str(input, 'patchText')
    if (patchText.length === 0) return tool
    const files = parsePatchCounts(patchText)
    if (files.length === 0) return tool
    return files
      .map(({fileName, additions, deletions}) =>
        fileName.length > 0
          ? `*${escapeInlineMarkdown(fileName)}* (+${additions}-${deletions})`
          : `(+${additions}-${deletions})`,
      )
      .join(', ')
  }

  // --- bash ---
  if (tool === 'bash') {
    const command = str(input, 'command') || str(input, 'cmd')
    const description = str(input, 'description')
    if (command.length > 0) {
      // Read-only bash commands are hidden (return tool name as minimal fallback;
      // caller checks isEssentialTool separately — this path is only reached for essential tools)
      const isSingleLine = !command.includes('\n')
      if (isSingleLine && command.length <= MAX_BASH_COMMAND_INLINE_LENGTH) {
        return `\`${command}\``
      }
      return description.length > 0 ? description : (title ?? tool)
    }
    return description.length > 0 ? description : (title ?? tool)
  }

  // --- skill ---
  if (tool === 'skill') {
    const name = str(input, 'name')
    return name.length > 0 ? `_${escapeInlineMarkdown(name)}_` : tool
  }

  // --- task (subagent) ---
  if (tool === 'task') {
    const description = str(input, 'description') || str(input, 'prompt')
    if (description.length > 0) return `task: ${description}`
    return title !== undefined && title.length > 0 ? title : tool
  }

  // --- unknown / MCP fallback ---
  // Minimal truncated summary — never a raw dump
  if (title !== undefined && title.length > 0) {
    return title.length > MAX_MCP_ARG_LENGTH ? `${title.slice(0, MAX_MCP_ARG_LENGTH)}…` : title
  }

  if (input !== undefined && Object.keys(input).length > 0) {
    const fields = Object.entries(input)
      .map(([key, value]) => {
        if (value === null || value === undefined) return null
        const stringValue = typeof value === 'string' ? value : JSON.stringify(value)
        const normalized = normalizeWhitespace(stringValue)
        const truncated =
          normalized.length > MAX_MCP_ARG_LENGTH ? `${normalized.slice(0, MAX_MCP_ARG_LENGTH)}…` : normalized
        return `${key}: ${truncated}`
      })
      .filter((f): f is string => f !== null)

    if (fields.length > 0) {
      return `(${fields.join(', ')})`
    }
  }

  return tool
}

// ---------------------------------------------------------------------------
// formatToolPart — combined entry point
// ---------------------------------------------------------------------------

/**
 * The primary entry point for the wiring layer.
 *
 * Returns the summary string to append for an essential tool, or null to
 * append nothing (successful hidden tool).
 * Errored hidden tools return a terse error line for debugging.
 *
 * This is a pure function — no SDK imports, no Discord imports.
 */
export function formatToolPart(part: ExtractedToolPart): string | null {
  return summarizeTool(part)
}

// ---------------------------------------------------------------------------
// isReadOnlyBash — exported for testing
// ---------------------------------------------------------------------------

/**
 * Returns true if the bash command is read-only (should be hidden).
 * Exported for testing; run-core.ts uses this via formatToolPart indirectly.
 */
export {isReadOnlyBashCommand}
