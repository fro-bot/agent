import {describe, expect, it} from 'vitest'

import {
  extractInputMessages,
  extractOutputMessages,
  extractSystemInstructions,
  extractToolArguments,
  extractToolDefinitions,
  extractToolResult,
} from './content.js'

describe('extraction by named field', () => {
  it('reads system instruction text and nothing else from each part', () => {
    // #given parts carrying metadata that holds the same text again
    const parts = [
      {type: 'text', text: 'base prompt', metadata: {experimental: {instructions: [{key: 'k', text: 'duplicate'}]}}},
      {type: 'text', text: 'second', cache: {type: 'ephemeral'}},
      {type: 'image'},
    ]

    // #when / #then
    expect(extractSystemInstructions(parts)).toEqual([
      {type: 'text', content: 'base prompt'},
      {type: 'text', content: 'second'},
    ])
    expect(extractSystemInstructions('nope')).toBeUndefined()
  })

  it('maps messages to the convention: text, reasoning, tool calls and tool responses, dropping media', () => {
    // #given a history with each part kind and an attachment
    const history = [
      {
        id: 'msg_1',
        role: 'user',
        content: [
          {type: 'text', text: 'read it'},
          {type: 'media', media: {source: {type: 'base64', data: 'AAAA'}}},
        ],
      },
      {
        role: 'assistant',
        content: [
          {type: 'reasoning', text: 'hmm'},
          {type: 'tool-call', id: 'call_1', name: 'read', input: {path: 'a.txt'}},
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            id: 'call_1',
            name: 'read',
            result: {
              type: 'content',
              value: [
                {type: 'text', text: 'file body'},
                {type: 'file', uri: 'file:///secret/path', mime: 'text/plain', name: 'a.txt'},
              ],
            },
          },
        ],
      },
      {role: 'assistant', content: 'plain string content'},
    ]

    // #when
    const out = extractInputMessages(history)

    // #then the shapes follow the convention, ids are not carried, the attachment is counted, and no file location appears
    expect(out?.omittedParts).toBe(1)
    expect(out?.messages).toEqual([
      {role: 'user', parts: [{type: 'text', content: 'read it'}]},
      {
        role: 'assistant',
        parts: [
          {type: 'reasoning', content: 'hmm'},
          {type: 'tool_call', id: 'call_1', name: 'read', arguments: {path: 'a.txt'}},
        ],
      },
      {role: 'tool', parts: [{type: 'tool_call_response', id: 'call_1', response: 'file body\n[file: a.txt]'}]},
      {role: 'assistant', parts: [{type: 'text', content: 'plain string content'}]},
    ])
    expect(JSON.stringify(out)).not.toContain('/secret/path')
    expect(JSON.stringify(out)).not.toContain('AAAA')
  })

  it('maps tool definitions to name, description and parameters', () => {
    // #given the hook's tool map
    const tools = {
      read: {description: 'Read a file', input: {type: 'object', properties: {path: {type: 'string'}}}},
      bare: {},
    }

    // #when / #then
    expect(extractToolDefinitions(tools)).toEqual([
      {
        type: 'function',
        name: 'read',
        description: 'Read a file',
        parameters: {type: 'object', properties: {path: {type: 'string'}}},
      },
      {type: 'function', name: 'bare'},
    ])
    expect(extractToolDefinitions({})).toBeUndefined()
  })

  it('makes tool arguments an object: parses a JSON string, wraps anything else', () => {
    // #given
    // #when / #then
    expect(extractToolArguments({a: 1})).toEqual({a: 1})
    expect(extractToolArguments('{"a":1}')).toEqual({a: 1})
    expect(extractToolArguments('not json')).toEqual({value: 'not json'})
    expect(extractToolArguments(5)).toEqual({value: 5})
    expect(extractToolArguments(undefined)).toBeUndefined()
  })

  it('reads the content the model saw as a tool result, files by name and type only, and the tool-cut flag', () => {
    // #given a result with text, a file, structured output and metadata
    const result = {
      content: [
        {type: 'text', text: 'ok'},
        {type: 'file', uri: 'file:///home/u/.env', mime: 'text/plain', name: '.env'},
      ],
      output: {big: 'structured'},
      metadata: {truncated: true, outputPath: '/tmp/out.txt'},
    }

    // #when
    const out = extractToolResult(result)

    // #then
    expect(out).toEqual({
      value: {
        content: [
          {type: 'text', text: 'ok'},
          {type: 'file', mime: 'text/plain', name: '.env'},
        ],
      },
      ownTruncation: true,
    })
    expect(JSON.stringify(out)).not.toContain('/home/u')
    expect(JSON.stringify(out)).not.toContain('/tmp/out.txt')
    expect(extractToolResult({content: 'plain'})?.value).toEqual({content: [{type: 'text', text: 'plain'}]})
    expect(extractToolResult({output: {a: 1}})?.value).toEqual({output: {a: 1}})
    expect(extractToolResult(undefined)).toBeUndefined()
    expect(extractToolResult({metadata: {}})).toBeUndefined()
  })

  it('builds one assistant output message from reasoning, text and requested tool calls', () => {
    // #given
    const out = extractOutputMessages({
      texts: ['hello'],
      reasoning: ['thinking'],
      toolCalls: [{callId: 'c1', tool: 'read', input: {path: 'a'}}],
    })

    // #then
    expect(out).toEqual([
      {
        role: 'assistant',
        parts: [
          {type: 'reasoning', content: 'thinking'},
          {type: 'text', content: 'hello'},
          {type: 'tool_call', id: 'c1', name: 'read', arguments: {path: 'a'}},
        ],
      },
    ])
    expect(extractOutputMessages({texts: [], reasoning: [], toolCalls: []})).toBeUndefined()
  })
})
