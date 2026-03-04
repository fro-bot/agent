import {afterEach, beforeEach, describe, expect, it, vi, type MockInstance} from 'vitest'

import {outputTextContent, outputToolExecution} from './console.js'

function getFirstCallArg(spy: MockInstance): string {
  const calls = spy.mock.calls
  if (calls.length === 0 || calls[0] == null || calls[0].length === 0) {
    throw new Error('No calls recorded')
  }
  return calls[0][0] as string
}

describe('outputToolExecution', () => {
  let writeSpy: MockInstance

  beforeEach(() => {
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.NO_COLOR
  })

  it('outputs known tool with correct color and padding', () => {
    // #given
    const toolName = 'bash'
    const title = 'running tests'

    // #when
    outputToolExecution(toolName, title)

    // #then
    expect(writeSpy).toHaveBeenCalledOnce()
    const output = getFirstCallArg(writeSpy)
    expect(output).toContain('Bash')
    expect(output).toContain('running tests')
  })

  it('outputs unknown tool with fallback color', () => {
    // #given
    const toolName = 'customtool'
    const title = 'custom action'

    // #when
    outputToolExecution(toolName, title)

    // #then
    expect(writeSpy).toHaveBeenCalledOnce()
    const output = getFirstCallArg(writeSpy)
    expect(output).toContain('customtool')
    expect(output).toContain('custom action')
  })

  it('handles uppercase tool names', () => {
    // #given
    const toolName = 'EDIT'
    const title = 'modifying file'

    // #when
    outputToolExecution(toolName, title)

    // #then
    expect(writeSpy).toHaveBeenCalledOnce()
    const output = getFirstCallArg(writeSpy)
    expect(output).toContain('Edit')
  })

  it('pads short tool names', () => {
    // #given
    const toolName = 'read'
    const title = 'file.ts'

    // #when
    outputToolExecution(toolName, title)

    // #then
    expect(writeSpy).toHaveBeenCalledOnce()
    const output = getFirstCallArg(writeSpy)
    expect(output).toContain('Read')
  })

  it('handles long unknown tool names', () => {
    // #given
    const toolName = 'verylongtoolname'
    const title = 'action'

    // #when
    outputToolExecution(toolName, title)

    // #then
    expect(writeSpy).toHaveBeenCalledOnce()
    const output = getFirstCallArg(writeSpy)
    expect(output).toContain('verylongtoolname')
  })

  it('respects NO_COLOR environment variable', () => {
    // #given
    process.env.NO_COLOR = '1'
    const toolName = 'bash'
    const title = 'running command'

    // #when
    outputToolExecution(toolName, title)

    // #then
    expect(writeSpy).toHaveBeenCalledOnce()
    const output = getFirstCallArg(writeSpy)
    expect(output).not.toContain('\u001B[')
  })

  it('outputs colors when NO_COLOR is not set', () => {
    // #given
    delete process.env.NO_COLOR
    const toolName = 'bash'
    const title = 'running command'

    // #when
    outputToolExecution(toolName, title)

    // #then
    expect(writeSpy).toHaveBeenCalledOnce()
    const output = getFirstCallArg(writeSpy)
    expect(output).toContain('\u001B[')
  })
})

describe('outputTextContent', () => {
  let writeSpy: MockInstance

  beforeEach(() => {
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('outputs text with newlines', () => {
    // #given
    const text = 'Hello, world!'

    // #when
    outputTextContent(text)

    // #then
    expect(writeSpy).toHaveBeenCalledWith('\nHello, world!\n')
  })

  it('outputs empty string with newlines', () => {
    // #given
    const text = ''

    // #when
    outputTextContent(text)

    // #then
    expect(writeSpy).toHaveBeenCalledWith('\n\n')
  })

  it('outputs multiline text', () => {
    // #given
    const text = 'Line 1\nLine 2\nLine 3'

    // #when
    outputTextContent(text)

    // #then
    expect(writeSpy).toHaveBeenCalledWith('\nLine 1\nLine 2\nLine 3\n')
  })
})
