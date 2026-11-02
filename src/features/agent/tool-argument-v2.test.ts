import {describe, expect, it} from 'vitest'
import {TOOL_ARGUMENT_MAX_LENGTH, toolArgumentV2} from './tool-argument-v2.js'

describe('toolArgumentV2', () => {
  describe('per-tool field', () => {
    it('shows the shell command', () => {
      // #given / #when / #then
      expect(toolArgumentV2('shell', {command: 'gh pr create --title t', workdir: '/x', timeout: 5})).toBe(
        'gh pr create --title t',
      )
    })

    it.each(['read', 'edit', 'write'])('shows the path of %s', tool => {
      // #given / #when / #then
      expect(toolArgumentV2(tool, {path: 'src/index.ts', offset: 1})).toBe('src/index.ts')
    })

    it('does not read the V1 filePath key', () => {
      // #given / #when / #then
      expect(toolArgumentV2('read', {filePath: 'src/index.ts'})).toBe('')
    })

    it.each(['grep', 'glob'])('shows the pattern of %s, and the path when present', tool => {
      // #given / #when / #then
      expect(toolArgumentV2(tool, {pattern: 'TODO'})).toBe('TODO')
      expect(toolArgumentV2(tool, {pattern: 'TODO', path: 'src'})).toBe('TODO in src')
    })

    it('shows the subagent description, falling back to the agent, and never the prompt', () => {
      // #given / #when / #then
      expect(
        toolArgumentV2('subagent', {agent: 'explore', description: 'Find the router', prompt: 'SECRET PROMPT'}),
      ).toBe('Find the router')
      expect(toolArgumentV2('subagent', {agent: 'explore', prompt: 'SECRET PROMPT'})).toBe('explore')
      expect(toolArgumentV2('subagent', {prompt: 'SECRET PROMPT'})).toBe('')
    })

    it('shows the skill id', () => {
      // #given / #when / #then
      expect(toolArgumentV2('skill', {id: 'ce-review'})).toBe('ce-review')
    })

    it('shows a count for todo and nothing for execute', () => {
      // #given / #when / #then
      expect(toolArgumentV2('todo', {todos: [{content: 'a', status: 'pending'}]})).toBe('1 item')
      expect(toolArgumentV2('todo', {todos: [{content: 'a'}, {content: 'b'}]})).toBe('2 items')
      expect(toolArgumentV2('todo', {todos: 'not a list'})).toBe('')
      expect(toolArgumentV2('execute', {code: 'await tools.x()'})).toBe('')
    })

    it('lists the files a patch touches from its headers only', () => {
      // #given
      const patchText = [
        '*** Begin Patch',
        '*** Add File: src/new.ts',
        '+const SECRET_BODY = 1',
        '*** Update File: src/old.ts',
        '@@',
        '-removed SECRET_BODY',
        '+added SECRET_BODY',
        '*** Delete File: src/gone.ts',
        '*** End Patch',
      ].join('\n')

      // #when
      const shown = toolArgumentV2('patch', {patchText})

      // #then
      expect(shown).toBe('src/new.ts, src/old.ts, src/gone.ts')
      expect(shown).not.toContain('SECRET_BODY')
    })

    it('shows nothing for a tool it does not know', () => {
      // #given / #when / #then
      expect(toolArgumentV2('mystery', {command: 'x', path: 'y', description: 'z', url: 'https://a.test'})).toBe('')
    })

    it('shows nothing when the input is missing or malformed', () => {
      // #given / #when / #then
      expect(toolArgumentV2('shell', null)).toBe('')
      expect(toolArgumentV2('shell', undefined)).toBe('')
      expect(toolArgumentV2('shell', {command: 42})).toBe('')
      expect(toolArgumentV2('read', {path: ['a']})).toBe('')
    })
  })

  describe('webfetch URL', () => {
    it('strips the query string and the fragment', () => {
      // #given / #when
      const shown = toolArgumentV2('webfetch', {
        url: 'https://example.com/docs/page?token=abc123&x=1#section',
        format: 'text',
      })

      // #then
      expect(shown).toBe('https://example.com/docs/page')
    })

    it('strips credentials in the authority', () => {
      // #given / #when
      const shown = toolArgumentV2('webfetch', {url: 'https://user:hunter2@example.com:8443/a?b=c'})

      // #then
      expect(shown).toBe('https://example.com:8443/a')
      expect(shown).not.toContain('hunter2')
    })

    it('shows nothing for a URL that does not parse or is not http(s)', () => {
      // #given / #when / #then
      expect(toolArgumentV2('webfetch', {url: 'not a url?token=abc'})).toBe('')
      expect(toolArgumentV2('webfetch', {url: 'data:text/plain,hello-secret'})).toBe('')
      expect(toolArgumentV2('webfetch', {url: 'file:///etc/passwd'})).toBe('')
    })

    it('shows the fetch URL of a nested Code Mode call without its query string', () => {
      // #given / #when / #then
      expect(toolArgumentV2('fetch', {method: 'POST', url: 'https://api.test/v1/x?key=k#f'})).toBe(
        'https://api.test/v1/x',
      )
    })
  })

  describe('no content leaks', () => {
    it('never prints write or edit bodies', () => {
      // #given
      const body = 'BODY-TEXT-THAT-MUST-NOT-APPEAR'

      // #when
      const shown = [
        toolArgumentV2('write', {path: 'a.ts', content: body}),
        toolArgumentV2('edit', {path: 'a.ts', oldString: body, newString: body}),
        toolArgumentV2('execute', {code: body}),
        toolArgumentV2('todo', {todos: [{content: body, status: 'pending'}]}),
        toolArgumentV2('subagent', {description: 'd', prompt: body}),
      ].join('|')

      // #then
      expect(shown).not.toContain(body)
    })
  })

  describe('bounds and control characters', () => {
    it('bounds an argument at the maximum and marks the cut', () => {
      // #given
      const command = 'x'.repeat(TOOL_ARGUMENT_MAX_LENGTH * 3)

      // #when
      const shown = toolArgumentV2('shell', {command})

      // #then
      expect(shown).toHaveLength(TOOL_ARGUMENT_MAX_LENGTH)
      expect(shown.endsWith('...')).toBe(true)
    })

    it('leaves an argument at exactly the maximum untouched', () => {
      // #given
      const command = 'y'.repeat(TOOL_ARGUMENT_MAX_LENGTH)

      // #when / #then
      expect(toolArgumentV2('shell', {command})).toBe(command)
    })

    it('collapses newlines so a multi-line command stays on one transcript line', () => {
      // #given / #when
      const shown = toolArgumentV2('shell', {command: 'echo a\n::add-mask::x\r\necho b\t\tc'})

      // #then
      expect(shown).toBe('echo a ::add-mask::x echo b c')
    })

    it('strips terminal escapes, other control characters and invisible formatting characters', () => {
      // #given
      const command = 'ls \u001B[31mred\u001B[0m\u0000\u0007 a\u200Bb \u202Ec\u2028d\uFEFFe'

      // #when
      const shown = toolArgumentV2('shell', {command})

      // #then
      expect(shown).toBe('ls [31mred [0m ab c de')
      // eslint-disable-next-line no-control-regex
      expect(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF]/.test(shown)).toBe(false)
    })

    it('bounds the combined pattern and path of a grep', () => {
      // #given / #when
      const shown = toolArgumentV2('grep', {pattern: 'p'.repeat(150), path: 'q'.repeat(150)})

      // #then
      expect(shown).toHaveLength(TOOL_ARGUMENT_MAX_LENGTH)
    })

    it('bounds the list of patch files', () => {
      // #given
      const patchText = [
        '*** Begin Patch',
        ...Array.from({length: 50}, (_, i) => `*** Add File: src/file-${i}.ts`),
      ].join('\n')

      // #when
      const shown = toolArgumentV2('patch', {patchText})

      // #then
      expect(shown.length).toBeLessThanOrEqual(TOOL_ARGUMENT_MAX_LENGTH)
    })
  })
})
