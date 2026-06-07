/**
 * Tests for `summarizeTool`, `formatToolPart`, and `isEssentialTool`.
 *
 * Mapping contract: each test names the exact input fields consumed so a shape
 * mismatch surfaces as a test failure, not a silent fallback.
 *
 * TDD: these tests were written BEFORE the implementation.
 */

import {describe, expect, it} from 'vitest'

import {formatToolPart, isEssentialTool, summarizeTool} from './format-part.js'

// ---------------------------------------------------------------------------
// Shape helpers
// ---------------------------------------------------------------------------

/** Build a completed tool shape (the canonical input to summarizeTool). */
function completedTool(
  tool: string,
  input: Record<string, unknown> = {},
  title?: string,
): {tool: string; state: {input: Record<string, unknown>; title?: string; status: 'completed'}} {
  return {tool, state: {input, title, status: 'completed'}}
}

/** Build an error-status tool shape. */
function errorTool(
  tool: string,
  input: Record<string, unknown> = {},
  title?: string,
): {tool: string; state: {input: Record<string, unknown>; title?: string; status: 'error'}} {
  return {tool, state: {input, title, status: 'error'}}
}

// ---------------------------------------------------------------------------
// summarizeTool — happy paths
// ---------------------------------------------------------------------------

describe('summarizeTool', () => {
  describe('edit tool', () => {
    it('renders *filename* (+added-removed) from filePath + newString + oldString', () => {
      // #given — edit with 12 new lines and 3 old lines
      const part = completedTool('edit', {
        filePath: 'src/foo.ts',
        newString: 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl', // 12 lines
        oldString: 'x\ny\nz', // 3 lines
      })

      // #when
      const result = summarizeTool(part)

      // #then — fields consumed: state.input.filePath, state.input.newString, state.input.oldString
      expect(result).toBe('*foo.ts* (+12-3)')
    })

    it('uses only the basename of filePath', () => {
      const part = completedTool('edit', {
        filePath: 'packages/gateway/src/execute/run-core.ts',
        newString: 'line1\nline2',
        oldString: 'old',
      })
      expect(summarizeTool(part)).toBe('*run-core.ts* (+2-1)')
    })

    it('falls back to tool name when filePath is absent', () => {
      const part = completedTool('edit', {newString: 'a', oldString: 'b'})
      // No filePath → no filename → fallback to tool name
      expect(summarizeTool(part)).toBe('edit')
    })

    it('escapes markdown special chars in filename', () => {
      const part = completedTool('edit', {
        filePath: 'src/foo_bar.ts',
        newString: 'a',
        oldString: 'b',
      })
      // underscore in filename must be escaped so Discord doesn't italicize
      expect(summarizeTool(part)).toContain(String.raw`foo\_bar.ts`)
    })
  })

  describe('write tool', () => {
    it('renders *filename* (N lines) from filePath + content', () => {
      // #given — write with 40 lines
      const part = completedTool('write', {
        filePath: 'src/output.ts',
        content: Array.from({length: 40}, (_, i) => `line${i}`).join('\n'),
      })

      // #when
      const result = summarizeTool(part)

      // #then — fields consumed: state.input.filePath, state.input.content
      expect(result).toBe('*output.ts* (40 lines)')
    })

    it('uses singular "line" for 1-line content', () => {
      const part = completedTool('write', {filePath: 'src/x.ts', content: 'single'})
      expect(summarizeTool(part)).toBe('*x.ts* (1 line)')
    })

    it('falls back to tool name when filePath is absent', () => {
      const part = completedTool('write', {content: 'hello'})
      expect(summarizeTool(part)).toBe('write')
    })
  })

  describe('apply_patch tool', () => {
    it('renders *filename* (+added-removed) from patchText', () => {
      // #given — a minimal unified diff with 3 additions and 1 deletion
      const patchText = [
        '--- a/src/app.ts',
        '+++ b/src/app.ts',
        '@@ -1,3 +1,5 @@',
        ' context',
        '-removed',
        '+added1',
        '+added2',
        '+added3',
        ' context2',
      ].join('\n')
      const part = completedTool('apply_patch', {patchText})

      // #when
      const result = summarizeTool(part)

      // #then — fields consumed: state.input.patchText
      expect(result).toContain('app.ts')
      expect(result).toContain('+')
      expect(result).toContain('-')
    })

    it('falls back to tool name when patchText is absent', () => {
      const part = completedTool('apply_patch', {})
      expect(summarizeTool(part)).toBe('apply_patch')
    })
  })

  describe('bash tool', () => {
    it('renders inline command when single-line and ≤100 chars', () => {
      // #given — short single-line command
      const part = completedTool('bash', {command: 'pnpm test', description: 'Run tests'})

      // #when
      const result = summarizeTool(part)

      // #then — fields consumed: state.input.command
      expect(result).toBe('`pnpm test`')
    })

    it('renders description when command is multi-line', () => {
      // #given — multi-line command with a description
      const part = completedTool('bash', {
        command: 'echo line1\necho line2\necho line3',
        description: 'Print lines',
      })

      // #when
      const result = summarizeTool(part)

      // #then — fields consumed: state.input.description (fallback from multi-line command)
      expect(result).toBe('Print lines')
    })

    it('renders description when command exceeds 100 chars', () => {
      // #given — command longer than 100 chars
      const longCmd = 'x'.repeat(101)
      const part = completedTool('bash', {command: longCmd, description: 'Long command'})

      // #when
      const result = summarizeTool(part)

      // #then — fields consumed: state.input.description (fallback from long command)
      expect(result).toBe('Long command')
    })

    it('falls back to tool name when command and description are absent', () => {
      const part = completedTool('bash', {})
      expect(summarizeTool(part)).toBe('bash')
    })

    it('falls back to tool name when command is long and description is absent', () => {
      const part = completedTool('bash', {command: 'x'.repeat(101)})
      expect(summarizeTool(part)).toBe('bash')
    })

    it('also accepts cmd field (alias for command)', () => {
      // run-core.ts uses getObjectProperty(stateInput, 'cmd') as a fallback
      const part = completedTool('bash', {cmd: 'git status'})
      expect(summarizeTool(part)).toBe('`git status`')
    })
  })

  describe('skill tool', () => {
    it('renders _name_ from input.name', () => {
      // #given — fields consumed: state.input.name
      const part = completedTool('skill', {name: 'ce:review'})
      expect(summarizeTool(part)).toBe('_ce:review_')
    })

    it('falls back to tool name when name is absent', () => {
      const part = completedTool('skill', {})
      expect(summarizeTool(part)).toBe('skill')
    })
  })

  describe('task (subagent) tool', () => {
    it('renders a labeled summary from input', () => {
      // #given — fields consumed: state.input (any available label)
      const part = completedTool('task', {description: 'Implement feature X'})
      const result = summarizeTool(part)
      // Must contain some reference to the task description
      expect(result).toContain('Implement feature X')
    })

    it('falls back to tool name when no description', () => {
      const part = completedTool('task', {})
      expect(summarizeTool(part)).toBe('task')
    })
  })

  describe('read tool (hidden)', () => {
    it('returns null — read is a hidden (non-essential) tool', () => {
      const part = completedTool('read', {filePath: 'src/foo.ts'})
      expect(summarizeTool(part)).toBeNull()
    })
  })

  describe('grep tool (hidden)', () => {
    it('returns null — grep is a hidden (non-essential) tool', () => {
      const part = completedTool('grep', {pattern: 'TODO'})
      expect(summarizeTool(part)).toBeNull()
    })
  })

  describe('glob tool (hidden)', () => {
    it('returns null — glob is a hidden (non-essential) tool', () => {
      const part = completedTool('glob', {pattern: '**/*.ts'})
      expect(summarizeTool(part)).toBeNull()
    })
  })

  describe('list tool (hidden)', () => {
    it('returns null — list is a hidden (non-essential) tool', () => {
      const part = completedTool('list', {path: 'src/'})
      expect(summarizeTool(part)).toBeNull()
    })
  })

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe('error-status tools', () => {
    it('prefixes with error glyph and still summarizes (not dumped)', () => {
      // #given — edit tool that errored
      const part = errorTool('edit', {filePath: 'src/broken.ts', newString: 'a', oldString: 'b'})

      // #when
      const result = summarizeTool(part)

      // #then — must have error indicator AND still be summarized
      expect(result).not.toBeNull()
      expect(result).toContain('⨯')
      expect(result).toContain('broken.ts')
    })

    it('error-status read tool still returns null (hidden)', () => {
      // Hidden tools stay hidden even on error
      const part = errorTool('read', {filePath: 'src/foo.ts'})
      expect(summarizeTool(part)).toBeNull()
    })

    it('error-status bash tool renders with error glyph', () => {
      const part = errorTool('bash', {command: 'pnpm test'})
      const result = summarizeTool(part)
      expect(result).not.toBeNull()
      expect(result).toContain('⨯')
    })
  })

  describe('unknown / MCP tools', () => {
    it('renders a minimal truncated fallback — never a raw dump', () => {
      // #given — unknown tool with some input
      const part = completedTool('some_mcp_tool', {
        longArg: 'a'.repeat(200),
        anotherArg: 'value',
      })

      // #when
      const result = summarizeTool(part)

      // #then — must not be null (MCP tools are essential), must be truncated
      expect(result).not.toBeNull()
      // Must not contain the full 200-char arg
      expect(typeof result === 'string' && result.length).toBeLessThan(150)
    })

    it('truncates MCP tool args to ~50 chars', () => {
      const part = completedTool('mcp_tool', {query: 'a'.repeat(100)})
      const result = summarizeTool(part)
      expect(result).not.toBeNull()
      // The truncated arg should be ≤50 chars + ellipsis
      expect(result).toContain('…')
    })

    it('renders tool name as fallback when input is empty', () => {
      const part = completedTool('unknown_tool', {})
      expect(summarizeTool(part)).toBe('unknown_tool')
    })
  })

  describe('missing title/input fallbacks', () => {
    it('falls back to tool name when state.input is empty and no title', () => {
      const part = completedTool('edit', {})
      expect(summarizeTool(part)).toBe('edit')
    })

    it('uses state.title as a fallback label when available', () => {
      // For tools without specific field handling, title is used
      const part = completedTool('some_tool', {}, 'My title')
      const result = summarizeTool(part)
      expect(result).not.toBeNull()
      expect(result).toContain('My title')
    })
  })
})

// ---------------------------------------------------------------------------
// isEssentialTool
// ---------------------------------------------------------------------------

describe('isEssentialTool', () => {
  describe('essential (shown) tools', () => {
    it.each(['edit', 'write', 'apply_patch', 'task', 'skill'])('%s is essential', tool => {
      expect(isEssentialTool(tool)).toBe(true)
    })

    it('bash is treated as essential (side-effecting by default)', () => {
      // Design choice: bash is always shown; a follow-up can refine with hasSideEffect
      expect(isEssentialTool('bash')).toBe(true)
    })

    it('unknown / MCP tools are essential (shown)', () => {
      expect(isEssentialTool('some_mcp_tool')).toBe(true)
      expect(isEssentialTool('mcp_search')).toBe(true)
    })
  })

  describe('non-essential (hidden) tools', () => {
    it.each(['read', 'grep', 'glob', 'list'])('%s is non-essential', tool => {
      expect(isEssentialTool(tool)).toBe(false)
    })
  })
})

// ---------------------------------------------------------------------------
// formatToolPart — integration (summarizeTool + isEssentialTool combined)
// ---------------------------------------------------------------------------

describe('formatToolPart', () => {
  it('returns the summary string for an essential tool', () => {
    const part = completedTool('edit', {
      filePath: 'src/app.ts',
      newString: 'a\nb',
      oldString: 'c',
    })
    const result = formatToolPart(part)
    expect(result).toBe('*app.ts* (+2-1)')
  })

  it('returns null for a non-essential (hidden) tool', () => {
    const part = completedTool('read', {filePath: 'src/app.ts'})
    expect(formatToolPart(part)).toBeNull()
  })

  it('returns null for grep (hidden)', () => {
    const part = completedTool('grep', {pattern: 'TODO'})
    expect(formatToolPart(part)).toBeNull()
  })

  it('returns a summary for bash (essential)', () => {
    const part = completedTool('bash', {command: 'git status'})
    expect(formatToolPart(part)).not.toBeNull()
  })

  it('returns null for a non-essential error-status tool', () => {
    const part = errorTool('read', {filePath: 'src/foo.ts'})
    expect(formatToolPart(part)).toBeNull()
  })

  it('returns an error-prefixed summary for an essential error-status tool', () => {
    const part = errorTool('edit', {filePath: 'src/app.ts', newString: 'a', oldString: 'b'})
    const result = formatToolPart(part)
    expect(result).not.toBeNull()
    expect(result).toContain('⨯')
  })
})
