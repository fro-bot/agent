/**
 * The argument shown beside a tool name in the Action's V2 transcript (`| Read       src/index.ts`).
 *
 * V2 tools do not share one field name (`path`, `pattern`, `url`, `command`, ...), so each tool maps to the one input
 * field worth showing (upstream `packages/core/src/tool/plugin/*.ts`, `Input`). The mapping is an allowlist: a tool that
 * is not listed shows nothing, and no listed tool shows content, an edit body, a prompt or code.
 *
 * Redaction matches V1, which printed a bash command as the model wrote it and relied on the runner's secret masking.
 * There is no string-level redaction helper to reuse (`redactSensitiveFields` works on field names, and this is a bare
 * string), so the guards here are the allowlist, credential-free URLs, a length bound and control-character stripping.
 */

export type ToolInputV2 = Readonly<Record<string, unknown>> | null | undefined

export const TOOL_ARGUMENT_MAX_LENGTH = 200

const ELLIPSIS = '...'
// Control characters become a space so a multi-line command stays on one transcript line and cannot start a line of its
// own (a `::add-mask::` workflow command, for example). Invisible formatting characters are dropped.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]+/g
const INVISIBLE_CHARACTERS = /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g

function sanitize(text: string): string {
  return text.replaceAll(CONTROL_CHARACTERS, ' ').replaceAll(INVISIBLE_CHARACTERS, '').replaceAll(/\s+/g, ' ').trim()
}

function bound(text: string): string {
  return text.length > TOOL_ARGUMENT_MAX_LENGTH
    ? `${text.slice(0, TOOL_ARGUMENT_MAX_LENGTH - ELLIPSIS.length)}${ELLIPSIS}`
    : text
}

function stringField(input: ToolInputV2, key: string): string {
  const value = input?.[key]
  return typeof value === 'string' ? value : ''
}

/** Origin and path of an http(s) URL. The query string, fragment and credentials are dropped; anything else shows nothing. */
function safeUrl(raw: string): string {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    return `${url.protocol}//${url.host}${url.pathname}`
  } catch {
    return ''
  }
}

const PATCH_FILE_HEADER = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm

/** The paths in a patch's file headers. The hunks, which are the content, are never read into the result. */
function patchPaths(input: ToolInputV2): string {
  return [...stringField(input, 'patchText').matchAll(PATCH_FILE_HEADER)]
    .map(match => match[1]?.trim() ?? '')
    .join(', ')
}

function patternWithPath(input: ToolInputV2): string {
  const pattern = stringField(input, 'pattern')
  const path = stringField(input, 'path')
  if (pattern.length === 0) return ''
  return path.length > 0 ? `${pattern} in ${path}` : pattern
}

function todoCount(input: ToolInputV2): string {
  const todos = input?.todos
  if (!Array.isArray(todos)) return ''
  return `${todos.length} ${todos.length === 1 ? 'item' : 'items'}`
}

// A Map, not an object: a tool named `constructor` or `__proto__` must not reach the prototype.
const ARGUMENT_BY_TOOL: ReadonlyMap<string, (input: ToolInputV2) => string> = new Map([
  ['shell', input => stringField(input, 'command')],
  ['read', input => stringField(input, 'path')],
  ['edit', input => stringField(input, 'path')],
  ['write', input => stringField(input, 'path')],
  ['patch', patchPaths],
  ['grep', patternWithPath],
  ['glob', patternWithPath],
  ['webfetch', input => safeUrl(stringField(input, 'url'))],
  // The Code Mode `fetch` extension, as it is listed in an `execute` call's inner calls (`{method, url}`).
  ['fetch', input => safeUrl(stringField(input, 'url'))],
  ['subagent', input => stringField(input, 'description') || stringField(input, 'agent')],
  ['skill', input => stringField(input, 'id')],
  ['todo', todoCount],
  // The program text is code the model wrote; the inner calls it makes are shown on their own lines.
  ['execute', () => ''],
])

/** The bounded, single-line argument for a tool call, or an empty string when the tool shows none. */
export function toolArgumentV2(tool: string, input: ToolInputV2): string {
  const extract = ARGUMENT_BY_TOOL.get(tool)
  return extract === undefined ? '' : bound(sanitize(extract(input)))
}
