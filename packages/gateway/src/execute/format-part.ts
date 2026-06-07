/**
 * Pure tool-part renderer for the Discord mention loop.
 *
 * Turns an extracted tool shape into a clean Discord summary line:
 * - Essential tool → one-line summary string
 * - Non-essential (read-only) tool → null (caller appends nothing)
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
 * Field mapping (from run-core.ts lines ~315-340):
 *   tool        ← part.tool (string)
 *   state.title ← getStringProperty(toolState, 'title')
 *   state.input ← getObjectProperty(toolState, 'input')
 *   state.status← getStringProperty(toolState, 'status')
 *
 * Specific input fields consumed per tool:
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
 * Tools that are always hidden (non-essential / read-only).
 * Everything NOT in this set is treated as essential (shown).
 */
const HIDDEN_TOOLS = new Set(['read', 'grep', 'glob', 'list'])

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

// ---------------------------------------------------------------------------
// Patch line-count parser (minimal — counts +/- lines in unified diff)
// ---------------------------------------------------------------------------

/**
 * Count added and removed lines in a unified diff patch text.
 * Returns { additions, deletions } for the first file found.
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
    if (line.startsWith('+++ b/') || line.startsWith('+++ ')) {
      // Flush previous file if any
      if (currentFile !== '') {
        results.push({fileName: basename(currentFile), additions, deletions})
      }
      currentFile = line.replace(/^\+\+\+ (?:b\/)?/, '')
      additions = 0
      deletions = 0
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      additions++
    } else if (line.startsWith('-') && !line.startsWith('---')) {
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
 * Design choice: bash is always treated as essential (shown). A follow-up
 * can refine this with a `hasSideEffect` field check if needed.
 *
 * Hidden tools: read, grep, glob, list.
 * Everything else (edit, write, apply_patch, bash, skill, task, MCP, unknown) → shown.
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
 * - `null`   — tool is non-essential (hidden); caller appends nothing
 * - `string` — one-line summary to append
 *
 * Never throws on unexpected input shapes — unknown/malformed parts degrade
 * to a safe minimal summary or null.
 */
export function summarizeTool(part: ExtractedToolPart): string | null {
  const {tool, state} = part
  const {input, title, status} = state

  // Hidden tools → null regardless of status
  if (!isEssentialTool(tool)) {
    return null
  }

  const isError = status === 'error'

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
    if (!fileName) return tool
    const newString = str(input, 'newString')
    const oldString = str(input, 'oldString')
    const added = newString ? newString.split('\n').length : 0
    const removed = oldString ? oldString.split('\n').length : 0
    return `*${escapeInlineMarkdown(fileName)}* (+${added}-${removed})`
  }

  // --- write ---
  if (tool === 'write') {
    const filePath = str(input, 'filePath')
    const fileName = basename(filePath)
    if (!fileName) return tool
    const content = str(input, 'content')
    const lines = content ? content.split('\n').length : 0
    return `*${escapeInlineMarkdown(fileName)}* (${lines} ${lines === 1 ? 'line' : 'lines'})`
  }

  // --- apply_patch ---
  if (tool === 'apply_patch') {
    const patchText = str(input, 'patchText')
    if (!patchText) return tool
    const files = parsePatchCounts(patchText)
    if (files.length === 0) return tool
    return files
      .map(({fileName, additions, deletions}) =>
        fileName ? `*${escapeInlineMarkdown(fileName)}* (+${additions}-${deletions})` : `(+${additions}-${deletions})`,
      )
      .join(', ')
  }

  // --- bash ---
  if (tool === 'bash') {
    const command = str(input, 'command') || str(input, 'cmd')
    const description = str(input, 'description')
    if (command) {
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
    return name ? `_${escapeInlineMarkdown(name)}_` : tool
  }

  // --- task (subagent) ---
  if (tool === 'task') {
    const description = str(input, 'description') || str(input, 'prompt')
    if (description) return `task: ${description}`
    return title !== undefined && title.length > 0 ? title : tool
  }

  // --- unknown / MCP fallback ---
  // Minimal truncated summary — never a raw dump
  if (title !== undefined && title.length > 0) {
    return title.length > MAX_MCP_ARG_LENGTH ? `${title.slice(0, MAX_MCP_ARG_LENGTH)}…` : title
  }

  if (input && Object.keys(input).length > 0) {
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
 * The primary entry point for the wiring layer (Unit 2).
 *
 * Returns the summary string to append for an essential tool, or null to
 * append nothing (hidden tool or non-essential).
 *
 * This is a pure function — no SDK imports, no Discord imports.
 */
export function formatToolPart(part: ExtractedToolPart): string | null {
  return summarizeTool(part)
}
