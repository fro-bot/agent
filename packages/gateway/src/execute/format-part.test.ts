/**
 * Tests for `summarizeTool`, `formatToolPart`, and `isEssentialTool`.
 *
 * Mapping contract: each test names the exact input fields consumed so a shape
 * mismatch surfaces as a test failure, not a silent fallback.
 *
 * TDD: these tests were written BEFORE the implementation.
 */

import {describe, expect, it} from 'vitest'

import {formatToolPart, isEssentialTool, isReadOnlyBashCommand, summarizeTool} from './format-part.js'

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
      // #given
      const part = completedTool('edit', {
        filePath: 'packages/gateway/src/execute/run-core.ts',
        newString: 'line1\nline2',
        oldString: 'old',
      })

      // #when / #then
      expect(summarizeTool(part)).toBe('*run-core.ts* (+2-1)')
    })

    it('falls back to tool name when filePath is absent', () => {
      // #given
      const part = completedTool('edit', {newString: 'a', oldString: 'b'})

      // #when / #then — No filePath → no filename → fallback to tool name
      expect(summarizeTool(part)).toBe('edit')
    })

    it('escapes markdown special chars in filename', () => {
      // #given
      const part = completedTool('edit', {
        filePath: 'src/foo_bar.ts',
        newString: 'a',
        oldString: 'b',
      })

      // #when / #then — underscore in filename must be escaped so Discord doesn't italicize
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
      // #given / #when / #then
      const part = completedTool('write', {filePath: 'src/x.ts', content: 'single'})
      expect(summarizeTool(part)).toBe('*x.ts* (1 line)')
    })

    it('falls back to tool name when filePath is absent', () => {
      // #given / #when / #then
      const part = completedTool('write', {content: 'hello'})
      expect(summarizeTool(part)).toBe('write')
    })
  })

  describe('apply_patch tool', () => {
    it('renders *filename* (+added-removed) from unified diff patchText', () => {
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
      expect(result).toBe('*app.ts* (+3-1)')
    })

    it('renders *filename* (+added-removed) from OpenCode *** Begin Patch envelope', () => {
      // #given — OpenCode apply_patch envelope format
      const patchText = [
        '*** Begin Patch',
        '*** Update File: src/app.ts',
        '@@ -1,3 +1,5 @@',
        ' context',
        '-removed',
        '+added1',
        '+added2',
        '+added3',
        ' context2',
        '*** End Patch',
      ].join('\n')
      const part = completedTool('apply_patch', {patchText})

      // #when
      const result = summarizeTool(part)

      // #then — OpenCode envelope parsed correctly
      expect(result).toBe('*app.ts* (+3-1)')
    })

    it('renders *filename* (+N-0) from OpenCode *** Add File: envelope', () => {
      // #given — OpenCode apply_patch Add File verb
      const patchText = [
        '*** Begin Patch',
        '*** Add File: src/new-module.ts',
        '+export function hello() {',
        '+  return "world"',
        '+}',
        '*** End Patch',
      ].join('\n')
      const part = completedTool('apply_patch', {patchText})

      // #when
      const result = summarizeTool(part)

      // #then — Add File parsed: 3 additions, 0 deletions
      expect(result).toBe('*new-module.ts* (+3-0)')
    })

    it('renders *filename* (+0-N) from OpenCode *** Delete File: envelope', () => {
      // #given — OpenCode apply_patch Delete File verb (body lines are removals)
      const patchText = [
        '*** Begin Patch',
        '*** Delete File: src/old-module.ts',
        '-export function goodbye() {',
        '-  return "bye"',
        '-}',
        '*** End Patch',
      ].join('\n')
      const part = completedTool('apply_patch', {patchText})

      // #when
      const result = summarizeTool(part)

      // #then — Delete File parsed: 0 additions, 3 deletions
      expect(result).toBe('*old-module.ts* (+0-3)')
    })

    it('renders *filename* (+0-0) from OpenCode *** Delete File: envelope with no body lines', () => {
      // #given — Delete File with no body (pure deletion marker, no diff lines)
      const patchText = ['*** Begin Patch', '*** Delete File: src/empty.ts', '*** End Patch'].join('\n')
      const part = completedTool('apply_patch', {patchText})

      // #when
      const result = summarizeTool(part)

      // #then — Delete File with no body: counts are 0/0 but file is still rendered
      expect(result).toBe('*empty.ts* (+0-0)')
    })

    it('falls back to tool name when patchText is absent', () => {
      // #given / #when / #then
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
      // #given — multi-line side-effecting command with a description
      const part = completedTool('bash', {
        command: 'pnpm build\npnpm test\npnpm lint',
        description: 'Build and test',
      })

      // #when
      const result = summarizeTool(part)

      // #then — fields consumed: state.input.description (fallback from multi-line command)
      expect(result).toBe('Build and test')
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
      // #given / #when / #then
      const part = completedTool('bash', {})
      expect(summarizeTool(part)).toBe('bash')
    })

    it('falls back to tool name when command is long and description is absent', () => {
      // #given / #when / #then
      const part = completedTool('bash', {command: 'x'.repeat(101)})
      expect(summarizeTool(part)).toBe('bash')
    })

    it('also accepts cmd field (alias for command)', () => {
      // #given — run-core.ts uses getObjectProperty(stateInput, 'cmd') as a fallback
      const part = completedTool('bash', {cmd: 'git status'})

      // #when / #then — git status is read-only → hidden
      expect(summarizeTool(part)).toBeNull()
    })

    describe('read-only bash hiding (P2.4)', () => {
      it('git ls-files → hidden (null)', () => {
        // #given / #when / #then
        expect(summarizeTool(completedTool('bash', {command: 'git ls-files'}))).toBeNull()
      })

      it('git status → hidden (null)', () => {
        // #given / #when / #then
        expect(summarizeTool(completedTool('bash', {command: 'git status'}))).toBeNull()
      })

      it('git log → hidden (null)', () => {
        // #given / #when / #then
        expect(summarizeTool(completedTool('bash', {command: 'git log --oneline -5'}))).toBeNull()
      })

      it('git diff → hidden (null)', () => {
        // #given / #when / #then
        expect(summarizeTool(completedTool('bash', {command: 'git diff HEAD'}))).toBeNull()
      })

      it('ls → hidden (null)', () => {
        // #given / #when / #then
        expect(summarizeTool(completedTool('bash', {command: 'ls -la'}))).toBeNull()
      })

      it('cat → hidden (null)', () => {
        // #given / #when / #then
        expect(summarizeTool(completedTool('bash', {command: 'cat src/foo.ts'}))).toBeNull()
      })

      it('find → hidden (null)', () => {
        // #given / #when / #then
        expect(summarizeTool(completedTool('bash', {command: 'find . -name "*.ts"'}))).toBeNull()
      })

      it('grep → hidden (null)', () => {
        // #given / #when / #then
        expect(summarizeTool(completedTool('bash', {command: 'grep -r TODO src/'}))).toBeNull()
      })

      it('rg → hidden (null)', () => {
        // #given / #when / #then
        expect(summarizeTool(completedTool('bash', {command: 'rg "TODO" src/'}))).toBeNull()
      })

      it('pwd → hidden (null)', () => {
        // #given / #when / #then
        expect(summarizeTool(completedTool('bash', {command: 'pwd'}))).toBeNull()
      })

      it('head → hidden (null)', () => {
        // #given / #when / #then
        expect(summarizeTool(completedTool('bash', {command: 'head -20 src/foo.ts'}))).toBeNull()
      })

      it('tail → hidden (null)', () => {
        // #given / #when / #then
        expect(summarizeTool(completedTool('bash', {command: 'tail -f logs/app.log'}))).toBeNull()
      })

      it('wc → hidden (null)', () => {
        // #given / #when / #then
        expect(summarizeTool(completedTool('bash', {command: 'wc -l src/foo.ts'}))).toBeNull()
      })

      it('which → hidden (null)', () => {
        // #given / #when / #then
        expect(summarizeTool(completedTool('bash', {command: 'which node'}))).toBeNull()
      })

      it('echo → hidden (null)', () => {
        // #given / #when / #then
        expect(summarizeTool(completedTool('bash', {command: 'echo hello'}))).toBeNull()
      })

      it('npm test → shown (side-effecting)', () => {
        // #given / #when / #then
        expect(summarizeTool(completedTool('bash', {command: 'npm test'}))).not.toBeNull()
      })

      it('rm → shown (side-effecting)', () => {
        // #given / #when / #then
        expect(summarizeTool(completedTool('bash', {command: 'rm -rf dist/'}))).not.toBeNull()
      })

      it('git commit → shown (side-effecting)', () => {
        // #given / #when / #then
        expect(summarizeTool(completedTool('bash', {command: 'git commit -m "fix"'}))).not.toBeNull()
      })

      it('pnpm build → shown (side-effecting)', () => {
        // #given / #when / #then
        expect(summarizeTool(completedTool('bash', {command: 'pnpm build'}))).not.toBeNull()
      })
    })
  })

  describe('skill tool', () => {
    it('renders _name_ from input.name', () => {
      // #given — fields consumed: state.input.name
      const part = completedTool('skill', {name: 'ce:review'})

      // #when / #then
      expect(summarizeTool(part)).toBe('_ce:review_')
    })

    it('falls back to tool name when name is absent', () => {
      // #given / #when / #then
      const part = completedTool('skill', {})
      expect(summarizeTool(part)).toBe('skill')
    })
  })

  describe('task (subagent) tool', () => {
    it('renders a labeled summary from input', () => {
      // #given — fields consumed: state.input (any available label)
      const part = completedTool('task', {description: 'Implement feature X'})

      // #when
      const result = summarizeTool(part)

      // #then — Must contain some reference to the task description
      expect(result).toContain('Implement feature X')
    })

    it('falls back to tool name when no description', () => {
      // #given / #when / #then
      const part = completedTool('task', {})
      expect(summarizeTool(part)).toBe('task')
    })

    it('truncates a long task description at ~120 chars with an ellipsis', () => {
      // #given — description longer than 120 chars
      const longDescription = 'A'.repeat(150)
      const part = completedTool('task', {description: longDescription})

      // #when
      const result = summarizeTool(part)

      // #then — result must be truncated and end with ellipsis
      expect(result).not.toBeNull()
      expect(typeof result === 'string' && result.endsWith('…')).toBe(true)
      // The full 150-char description must NOT appear verbatim
      expect(result).not.toContain(longDescription)
      // But the prefix should be present
      expect(result).toContain('task: ')
      // Total length should be well under 150
      expect(typeof result === 'string' && result.length).toBeLessThan(140)
    })

    it('does NOT truncate a task description at or below the cap', () => {
      // #given — description exactly at the cap (120 chars)
      const exactDescription = 'B'.repeat(120)
      const part = completedTool('task', {description: exactDescription})

      // #when
      const result = summarizeTool(part)

      // #then — no truncation for descriptions at or below the cap
      expect(result).toBe(`task: ${exactDescription}`)
    })
  })

  describe('read tool (hidden)', () => {
    it('returns null — read is a hidden (non-essential) tool when successful', () => {
      // #given / #when / #then
      const part = completedTool('read', {filePath: 'src/foo.ts'})
      expect(summarizeTool(part)).toBeNull()
    })
  })

  describe('grep tool (hidden)', () => {
    it('returns null — grep is a hidden (non-essential) tool when successful', () => {
      // #given / #when / #then
      const part = completedTool('grep', {pattern: 'TODO'})
      expect(summarizeTool(part)).toBeNull()
    })
  })

  describe('glob tool (hidden)', () => {
    it('returns null — glob is a hidden (non-essential) tool when successful', () => {
      // #given / #when / #then
      const part = completedTool('glob', {pattern: '**/*.ts'})
      expect(summarizeTool(part)).toBeNull()
    })
  })

  describe('list tool (hidden)', () => {
    it('returns null — list is a hidden (non-essential) tool when successful', () => {
      // #given / #when / #then
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

    it('error-status read tool renders terse error line (P2.5 — aids debugging)', () => {
      // #given — hidden tool with error status
      const part = errorTool('read', {filePath: 'src/foo.ts'})

      // #when
      const result = summarizeTool(part)

      // #then — errored hidden tool renders terse error line, not null
      expect(result).not.toBeNull()
      expect(result).toContain('⨯')
      expect(result).toContain('read')
      expect(result).toContain('src/foo.ts')
    })

    it('error-status grep tool renders terse error line with pattern', () => {
      // #given
      const part = errorTool('grep', {pattern: 'TODO'})

      // #when
      const result = summarizeTool(part)

      // #then
      expect(result).not.toBeNull()
      expect(result).toContain('⨯')
      expect(result).toContain('grep')
      expect(result).toContain('TODO')
    })

    it('error-status glob tool renders terse error line with path', () => {
      // #given
      const part = errorTool('glob', {pattern: '**/*.ts'})

      // #when
      const result = summarizeTool(part)

      // #then
      expect(result).not.toBeNull()
      expect(result).toContain('⨯')
      expect(result).toContain('glob')
    })

    it('error-status list tool renders terse error line with path', () => {
      // #given
      const part = errorTool('list', {path: 'src/'})

      // #when
      const result = summarizeTool(part)

      // #then
      expect(result).not.toBeNull()
      expect(result).toContain('⨯')
      expect(result).toContain('list')
      expect(result).toContain('src/')
    })

    it('successful read tool still returns null (P2.5 — only errored hidden tools show)', () => {
      // #given / #when / #then
      const part = completedTool('read', {filePath: 'src/foo.ts'})
      expect(summarizeTool(part)).toBeNull()
    })

    it('error-status bash tool renders with error glyph', () => {
      // #given / #when
      const part = errorTool('bash', {command: 'pnpm test'})
      const result = summarizeTool(part)

      // #then
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
      // #given / #when
      const part = completedTool('mcp_tool', {query: 'a'.repeat(100)})
      const result = summarizeTool(part)

      // #then — The truncated arg should be ≤50 chars + ellipsis
      expect(result).not.toBeNull()
      expect(result).toContain('…')
    })

    it('renders tool name as fallback when input is empty', () => {
      // #given / #when / #then
      const part = completedTool('unknown_tool', {})
      expect(summarizeTool(part)).toBe('unknown_tool')
    })
  })

  describe('missing title/input fallbacks', () => {
    it('falls back to tool name when state.input is empty and no title', () => {
      // #given / #when / #then
      const part = completedTool('edit', {})
      expect(summarizeTool(part)).toBe('edit')
    })

    it('uses state.title as a fallback label when available', () => {
      // #given — For tools without specific field handling, title is used
      const part = completedTool('some_tool', {}, 'My title')

      // #when
      const result = summarizeTool(part)

      // #then
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
      // #given / #when / #then
      expect(isEssentialTool(tool)).toBe(true)
    })

    it('bash is treated as essential (side-effecting by default)', () => {
      // #given — Design choice: bash is always shown at the isEssentialTool level;
      // read-only bash is filtered in summarizeTool based on command content
      expect(isEssentialTool('bash')).toBe(true)
    })

    it('unknown / MCP tools are essential (shown)', () => {
      // #given / #when / #then
      expect(isEssentialTool('some_mcp_tool')).toBe(true)
      expect(isEssentialTool('mcp_search')).toBe(true)
    })
  })

  describe('non-essential (hidden) tools', () => {
    it.each(['read', 'grep', 'glob', 'list'])('%s is non-essential', tool => {
      // #given / #when / #then
      expect(isEssentialTool(tool)).toBe(false)
    })
  })
})

// ---------------------------------------------------------------------------
// isReadOnlyBashCommand
// ---------------------------------------------------------------------------

describe('isReadOnlyBashCommand', () => {
  describe('read-only commands → true', () => {
    it.each([
      'git ls-files',
      'git ls-files --others',
      'git status',
      'git status --short',
      'git log',
      'git log --oneline -5',
      'git diff',
      'git diff HEAD',
      'ls',
      'ls -la',
      'cat src/foo.ts',
      'find . -name "*.ts"',
      'grep -r TODO src/',
      'rg "TODO" src/',
      'pwd',
      'head -20 src/foo.ts',
      'tail -f logs/app.log',
      'wc -l src/foo.ts',
      'which node',
      'echo hello',
    ])('%s → true', command => {
      // #given / #when / #then
      expect(isReadOnlyBashCommand(command)).toBe(true)
    })
  })

  describe('side-effecting commands → false', () => {
    it.each([
      'npm test',
      'rm -rf dist/',
      'git commit -m "fix"',
      'git push',
      'pnpm build',
      'pnpm install',
      'mkdir -p dist',
      'cp src/foo.ts dist/',
      'mv old.ts new.ts',
      'chmod +x script.sh',
    ])('%s → false', command => {
      // #given / #when / #then
      expect(isReadOnlyBashCommand(command)).toBe(false)
    })
  })
})

// ---------------------------------------------------------------------------
// formatToolPart — integration (summarizeTool + isEssentialTool combined)
// ---------------------------------------------------------------------------

describe('formatToolPart', () => {
  it('returns the summary string for an essential tool', () => {
    // #given
    const part = completedTool('edit', {
      filePath: 'src/app.ts',
      newString: 'a\nb',
      oldString: 'c',
    })

    // #when / #then
    const result = formatToolPart(part)
    expect(result).toBe('*app.ts* (+2-1)')
  })

  it('returns null for a non-essential (hidden) successful tool', () => {
    // #given / #when / #then
    const part = completedTool('read', {filePath: 'src/app.ts'})
    expect(formatToolPart(part)).toBeNull()
  })

  it('returns null for grep (hidden, successful)', () => {
    // #given / #when / #then
    const part = completedTool('grep', {pattern: 'TODO'})
    expect(formatToolPart(part)).toBeNull()
  })

  it('returns a summary for bash (essential, side-effecting)', () => {
    // #given / #when / #then
    const part = completedTool('bash', {command: 'pnpm build'})
    expect(formatToolPart(part)).not.toBeNull()
  })

  it('returns null for read-only bash (git status)', () => {
    // #given / #when / #then
    const part = completedTool('bash', {command: 'git status'})
    expect(formatToolPart(part)).toBeNull()
  })

  it('returns terse error line for errored hidden tool (P2.5)', () => {
    // #given
    const part = errorTool('read', {filePath: 'src/foo.ts'})

    // #when
    const result = formatToolPart(part)

    // #then — errored hidden tool renders terse error line
    expect(result).not.toBeNull()
    expect(result).toContain('⨯')
    expect(result).toContain('read')
  })

  it('returns an error-prefixed summary for an essential error-status tool', () => {
    // #given
    const part = errorTool('edit', {filePath: 'src/app.ts', newString: 'a', oldString: 'b'})

    // #when
    const result = formatToolPart(part)

    // #then
    expect(result).not.toBeNull()
    expect(result).toContain('⨯')
  })
})
