import {describe, expect, it, vi} from 'vitest'

import {
  createSnapshotLedger,
  DEFAULT_PENDING_LIMITS,
  DEFAULT_SNAPSHOT_LIMITS,
  omittedReason,
  snapshotPrompt,
  snapshotRequest,
  snapshotSize,
  snapshotToolArguments,
  snapshotToolResult,
  type RequestSnapshot,
} from './snapshot.js'

const isFrozen = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null) return true
  return Object.isFrozen(value) && Object.values(value).every(child => isFrozen(child))
}

const requestInput = () => ({
  system: [
    {type: 'text', text: 'You are Fro Bot.', metadata: {experimental: {instructions: [{key: 'k', text: 'dup'}]}}},
  ],
  messages: [
    {id: 'm1', role: 'user', content: [{type: 'text', text: 'first question'}], metadata: {private: 'x'}},
    {
      id: 'm2',
      role: 'assistant',
      content: [
        {type: 'reasoning', text: 'thinking'},
        {type: 'tool-call', id: 'c1', name: 'read', input: {path: 'README.md'}, providerOptions: {apiKey: 'sk-hidden'}},
      ],
    },
    {
      id: 'm3',
      role: 'user',
      content: [
        {type: 'tool-result', id: 'c1', name: 'read', result: {type: 'text', value: 'file body'}},
        {type: 'file', mediaType: 'image/png', data: 'BASE64-IMAGE-BYTES'},
      ],
    },
  ],
  tools: {
    read: {description: 'Read a file', input: {type: 'object', properties: {path: {type: 'string'}}}, execute: () => 1},
  },
  options: {apiKey: 'sk-never-copied', headers: {authorization: 'Bearer nope'}},
})

describe('a request snapshot', () => {
  it('holds exactly the named fields, pruned of everything else', () => {
    // #given a request with metadata, provider options, an attachment, a function and an options object
    const input = requestInput()

    // #when
    const snapshot = snapshotRequest(input)

    // #then only system text, role and text/reasoning/tool parts, and tool name, description and schema are in it
    expect(snapshot.system).toEqual([{text: 'You are Fro Bot.'}])
    expect(snapshot.tools).toEqual({
      read: {description: 'Read a file', input: {type: 'object', properties: {path: {type: 'string'}}}},
    })
    expect(snapshot.messages).toEqual([
      {role: 'user', content: [{type: 'text', text: 'first question'}]},
      {
        role: 'assistant',
        content: [
          {type: 'reasoning', text: 'thinking'},
          {type: 'tool-call', id: 'c1', name: 'read', input: {path: 'README.md'}},
        ],
      },
      {
        role: 'user',
        content: [{type: 'tool-result', id: 'c1', result: {type: 'text', value: 'file body'}}, {type: 'omitted'}],
      },
    ])
    const text = JSON.stringify(snapshot)
    for (const never of [
      'sk-never-copied',
      'sk-hidden',
      'Bearer nope',
      'BASE64-IMAGE-BYTES',
      'metadata',
      'providerOptions',
    ]) {
      expect(text).not.toContain(never)
    }
  })

  it('is frozen all the way down', () => {
    // #given / #when
    const snapshot = snapshotRequest(requestInput())

    // #then
    expect(isFrozen(snapshot)).toBe(true)
    const [first] = snapshot.messages as {role: string}[]
    expect(() => {
      Object.assign(first as object, {role: 'changed'})
    }).toThrow(TypeError)
  })

  it('is not changed by an edit to the hook input made afterwards, however deep', () => {
    // #given a snapshot, then every kind of edit a host or another plugin could make
    const input = requestInput()
    const snapshot = snapshotRequest(input)
    const before = JSON.stringify(snapshot)

    // #when the input is mutated in place
    const [system] = input.system
    const [firstMessage, secondMessage] = input.messages
    Object.assign(system as object, {text: 'EDITED SYSTEM'})
    Object.assign(firstMessage as object, {role: 'edited'})
    Object.assign((firstMessage?.content as object[])[0] as object, {text: 'EDITED USER TEXT'})
    Object.assign(((secondMessage?.content as {input: object}[])[1] as {input: object}).input, {path: 'EDITED/PATH'})
    input.messages.push({id: 'm4', role: 'user', content: [{type: 'text', text: 'APPENDED'}]})
    input.messages.splice(0, 1)
    input.tools.read.description = 'EDITED DESCRIPTION'
    ;(input.tools.read.input.properties as {path: unknown}).path = 'EDITED SCHEMA'
    ;(input as {tools: unknown}).tools = {}

    // #then the snapshot is the pre-mutation value
    expect(JSON.stringify(snapshot)).toBe(before)
    expect(JSON.stringify(snapshot)).not.toContain('EDITED')
    expect(JSON.stringify(snapshot)).not.toContain('APPENDED')
  })

  it('shares strings rather than copying them, so a very large history costs a walk, not bytes', () => {
    // #given 50 MB of history in 5000 messages
    const messages = Array.from({length: 5_000}, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: [{type: 'text', text: `line ${index} ${'x'.repeat(10_000)}`}],
    }))

    // #when
    const started = performance.now()
    const snapshot = snapshotRequest({system: [], messages, tools: {}})
    const elapsed = performance.now() - started

    // #then it kept only the newest that fit, and it was quick
    expect(snapshot.size).toBeLessThanOrEqual(DEFAULT_SNAPSHOT_LIMITS.requestChars)
    expect((snapshot.messages as unknown[]).length).toBeLessThan(500)
    expect(elapsed).toBeLessThan(250)
  })

  it('drops the oldest history first when over its ceiling, keeps the newest in order, and says how many', () => {
    // #given ten messages of 100 characters and a ceiling for about four
    const messages = Array.from({length: 10}, (_, index) => ({
      role: 'user',
      content: [{type: 'text', text: `m${index}:${'z'.repeat(96)}`}],
    }))

    // #when
    const snapshot = snapshotRequest({messages}, {limits: {requestChars: 430}})

    // #then
    const kept = snapshot.messages as {content: {text: string}[]}[]
    expect(kept.map(message => message.content[0]?.text.slice(0, 2))).toEqual(['m6', 'm7', 'm8', 'm9'])
    expect(snapshot.droppedMessages).toBe(6)
  })

  it('omits system text and tool definitions that exceed their own ceilings, and says why', () => {
    // #given
    const snapshot = snapshotRequest(
      {system: [{text: 'S'.repeat(100)}], tools: {big: {description: 'D'.repeat(100), input: {}}}, messages: []},
      {limits: {systemChars: 50, toolDefinitionChars: 50}},
    )

    // #then
    expect(omittedReason(snapshot.system)).toBe('snapshot-bound')
    expect(omittedReason(snapshot.tools)).toBe('snapshot-bound')
    expect(snapshot.messages).toEqual([])
  })

  it('omits a value that is too deep or that loops, rather than following it', () => {
    // #given a tool schema that contains itself
    const schema: Record<string, unknown> = {type: 'object'}
    schema.self = schema

    // #when
    const snapshot = snapshotRequest({tools: {loop: {description: 'd', input: schema}}})

    // #then the tools field is omitted as over its bound, and nothing hung
    expect(omittedReason(snapshot.tools)).toBe('snapshot-bound')
  })

  it('reads past a getter that throws and a field that is not content', () => {
    // #given a message whose role getter throws, and one with a function-valued text
    const hostile = {
      get role(): string {
        throw new Error('boom')
      },
      content: [],
    }
    const snapshot = snapshotRequest({
      messages: [hostile, {role: 'user', content: [{type: 'text', text: () => 'fn'}]}],
    })

    // #then no throw, the hostile message is skipped and the other keeps a placeholder part
    expect(snapshot.messages).toEqual([{role: 'user', content: [{type: 'omitted'}]}])
  })

  it('reports a field it cannot read as unreadable, never throws', () => {
    // #given an input whose property access throws
    const input = new Proxy(
      {},
      {
        get: () => {
          throw new Error('boom')
        },
      },
    )

    // #when / #then
    const snapshot = snapshotRequest(input)
    expect(omittedReason(snapshot.messages)).toBe('unreadable')
  })

  it('prunes a tool result part to its text and the names of its files', () => {
    // #given a tool-result part with content items including a file that carries data
    const snapshot = snapshotRequest({
      messages: [
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              id: 'c',
              result: {
                type: 'content',
                value: [
                  {type: 'text', text: 'hello'},
                  {type: 'file', name: 'a.png', mime: 'image/png', data: 'BASE64'},
                ],
              },
            },
          ],
        },
      ],
    })

    // #then
    expect(JSON.stringify(snapshot.messages)).not.toContain('BASE64')
    expect(snapshot.messages).toEqual([
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            id: 'c',
            result: {
              type: 'content',
              value: [
                {type: 'text', text: 'hello'},
                {type: 'file', name: 'a.png', mime: 'image/png'},
              ],
            },
          },
        ],
      },
    ])
  })
})

describe('the other snapshots', () => {
  it('takes a prompt’s text and nothing else', () => {
    // #given a prompt with an attachment
    const prompt = {text: 'please read it', files: [{uri: 'file:///secret', data: 'BYTES'}]}

    // #when
    const snapshot = snapshotPrompt(prompt)
    prompt.text = 'EDITED'

    // #then
    expect(snapshot).toEqual({text: 'please read it', size: 14})
    expect(JSON.stringify(snapshot)).not.toContain('secret')
  })

  it('has no text for an attachment-only prompt, and no attribute follows', () => {
    // #given / #when / #then
    expect(snapshotPrompt({files: []}).text).toBeUndefined()
    expect(snapshotPrompt(undefined).text).toBeUndefined()
  })

  it('omits a prompt over the value ceiling', () => {
    // #given / #when
    const snapshot = snapshotPrompt({text: 'x'.repeat(100)}, {limits: {valueChars: 50}})

    // #then
    expect(omittedReason(snapshot.text)).toBe('snapshot-bound')
  })

  it('copies tool arguments, deeply and frozen', () => {
    // #given
    const input = {path: 'a', options: {depth: [1, 2, {x: 'y'}]}}

    // #when
    const snapshot = snapshotToolArguments(input)
    input.options.depth[2] = {x: 'EDITED'}
    input.path = 'EDITED'

    // #then
    expect(snapshot).toEqual({path: 'a', options: {depth: [1, 2, {x: 'y'}]}})
    expect(isFrozen(snapshot)).toBe(true)
  })

  it('parses JSON-string arguments and wraps anything else, as the span carries them', () => {
    // #given / #when / #then
    expect(snapshotToolArguments('{"a":1}')).toEqual({a: 1})
    expect(snapshotToolArguments('not json')).toEqual({value: 'not json'})
    expect(snapshotToolArguments(42)).toEqual({value: 42})
    expect(snapshotToolArguments(undefined)).toBeUndefined()
  })

  it('takes a tool result as text and file names, notes the tool’s own truncation, and is not changed by a later edit', () => {
    // #given a result with metadata and a file
    const result = {
      content: [
        {type: 'text', text: 'body'},
        {type: 'file', name: 'x.png', mime: 'image/png', data: 'BASE64'},
      ],
      metadata: {truncated: true, path: '/private/location'},
    }

    // #when
    const snapshot = snapshotToolResult(result)
    ;(result.content[0] as {text: string}).text = 'EDITED'
    result.metadata.truncated = false

    // #then
    expect(snapshot).toMatchObject({
      content: [
        {type: 'text', text: 'body'},
        {type: 'file', name: 'x.png', mime: 'image/png'},
      ],
      metadata: {truncated: true},
    })
    expect(JSON.stringify(snapshot)).not.toMatch(/BASE64|private|EDITED/)
  })

  it('takes a result that has only structured output', () => {
    // #given / #when / #then
    expect(snapshotToolResult({output: {rows: [1, 2]}})).toMatchObject({output: {rows: [1, 2]}})
    expect(snapshotToolResult('plain string')).toBeUndefined()
    expect(snapshotToolResult({})).toBeUndefined()
  })

  it('omits a result over the value ceiling and says why', () => {
    // #given / #when
    const snapshot = snapshotToolResult({content: 'x'.repeat(1_000)}, {limits: {valueChars: 100}})

    // #then
    expect(omittedReason(snapshot)).toBe('snapshot-bound')
  })

  it('reports the size a snapshot holds', () => {
    // #given / #when / #then
    expect(snapshotSize(snapshotPrompt({text: 'abcd'}))).toBe(4)
    expect(snapshotSize(undefined)).toBe(0)
    expect(snapshotSize('text')).toBe(0)
  })
})

describe('the pending ledger', () => {
  it('has room until its count or its characters run out, and then refuses and counts the refusals', () => {
    // #given a ledger of two snapshots and 100 characters
    const ledger = createSnapshotLedger({maxPending: 2, maxPendingChars: 100})
    const context = {ledger}

    // #when
    const first = snapshotPrompt({text: 'a'.repeat(30)}, context)
    const second = snapshotPrompt({text: 'b'.repeat(30)}, context)
    const third = snapshotPrompt({text: 'c'.repeat(30)}, context)

    // #then the third found no room by count and was omitted, with the content marked
    expect(first.text).toBe('a'.repeat(30))
    expect(second.text).toBe('b'.repeat(30))
    expect(omittedReason(third.text)).toBe('pending-bound')
    expect(ledger.stats()).toEqual({pending: 2, pendingChars: 60, refused: 1})
  })

  it('limits one snapshot to the characters that remain', () => {
    // #given 100 characters of room, 80 of them taken
    const ledger = createSnapshotLedger({maxPending: 10, maxPendingChars: 100})
    snapshotPrompt({text: 'a'.repeat(80)}, {ledger})

    // #when a 40-character prompt arrives
    const next = snapshotPrompt({text: 'b'.repeat(40)}, {ledger})

    // #then it did not fit the 20 that remain: omitted for this snapshot's bound, and nothing more is held
    expect(omittedReason(next.text)).toBe('snapshot-bound')
    expect(ledger.stats().pendingChars).toBe(80)
  })

  it('frees a snapshot when it is released, and ignores one it does not hold', () => {
    // #given two held snapshots
    const ledger = createSnapshotLedger()
    const prompt = snapshotPrompt({text: 'hello'}, {ledger})
    const request = snapshotRequest(requestInput(), {ledger})
    expect(ledger.stats().pending).toBe(2)

    // #when each is released, twice, and unrelated values too
    ledger.release(prompt)
    ledger.release(prompt)
    ledger.release(request)
    ledger.release(undefined)
    ledger.release('text')
    ledger.release({})

    // #then the books are empty and never negative
    expect(ledger.stats()).toEqual({pending: 0, pendingChars: 0, refused: 0})
  })

  it('refuses a whole request when full, which comes back with every field marked omitted', () => {
    // #given a full ledger
    const ledger = createSnapshotLedger({maxPending: 1, maxPendingChars: DEFAULT_PENDING_LIMITS.maxPendingChars})
    snapshotPrompt({text: 'x'}, {ledger})

    // #when
    const snapshot: RequestSnapshot = snapshotRequest(requestInput(), {ledger})

    // #then the structure is there, the content is not
    expect([omittedReason(snapshot.system), omittedReason(snapshot.messages), omittedReason(snapshot.tools)]).toEqual([
      'pending-bound',
      'pending-bound',
      'pending-bound',
    ])
    expect(snapshot.size).toBe(0)
  })

  it('counts what a request holds against the characters, and a request never takes more than the room', () => {
    // #given 1,000 characters of room and a history far over it
    const ledger = createSnapshotLedger({maxPending: 10, maxPendingChars: 1_000})
    const messages = Array.from({length: 50}, () => ({role: 'user', content: [{type: 'text', text: 'y'.repeat(200)}]}))

    // #when
    const snapshot = snapshotRequest({messages}, {ledger})

    // #then
    expect(snapshot.size).toBeLessThanOrEqual(1_000)
    expect(ledger.stats().pendingChars).toBe(snapshot.size)
    expect(snapshot.droppedMessages).toBeGreaterThan(40)
  })
})

/** An array that counts how many of its elements were read: the walk's real size, not a guess from its time. */
function counting<T>(items: T[]): {array: T[]; visited: () => number} {
  let visited = 0
  const array = new Proxy(items, {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) visited += 1
      return Reflect.get(target, key, receiver) as unknown
    },
  })
  return {array, visited: () => visited}
}

describe('the work a snapshot does does not scale with the history', () => {
  const message = (index: number) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: [{type: 'text', text: `m${index}`}],
  })

  it('charges every unknown part to one request-wide node budget, so a huge array of them is not copied', () => {
    // #given one message of 50,000 media parts and a budget of 1,000 nodes
    const parts = Array.from({length: 50_000}, () => ({type: 'image', data: 'BASE64'}))
    const {array, visited} = counting(parts)

    // #when
    const snapshot = snapshotRequest({messages: [{role: 'user', content: array}]}, {limits: {maxNodes: 1_000}})

    // #then the walk stopped near the budget, the message was not kept, and the snapshot says one was left out
    expect(visited()).toBeLessThanOrEqual(1_100)
    expect(snapshot.messages).toEqual([])
    expect(snapshot.droppedMessages).toBe(1)
    expect(JSON.stringify(snapshot)).not.toContain('BASE64')
  })

  it('keeps a message whose placeholders fit exactly in the budget, and drops one that is a node over', () => {
    // #given the budget is spent by the entry, the role and N placeholders (one node each), and the same message with one more part
    const build = (count: number) => ({role: 'user', content: Array.from({length: count}, () => ({type: 'file'}))})
    const limits = {maxNodes: 12}

    // #when
    const fits = snapshotRequest({messages: [build(10)]}, {limits})
    const over = snapshotRequest({messages: [build(11)]}, {limits})

    // #then
    expect((fits.messages as unknown[]).length).toBe(1)
    expect(over.messages).toEqual([])
  })

  it('shares the budget across messages: ten thousand small ones stop the walk, and it does not visit the rest', () => {
    // #given a million tiny messages, newest last, and a budget of 4,000 nodes
    const {array, visited} = counting(Array.from({length: 1_000_000}, (_, index) => message(index)))

    // #when
    const snapshot = snapshotRequest({messages: array}, {limits: {maxNodes: 4_000}})

    // #then it read about a budget's worth of entries, kept the newest, and counted the rest by arithmetic
    expect(visited()).toBeLessThan(4_100)
    const kept = (snapshot.messages as {content: {text: string}[]}[]).length
    expect(kept).toBeGreaterThan(0)
    expect((snapshot.messages as {content: {text: string}[]}[]).at(-1)?.content[0]?.text).toBe('m999999')
    expect(kept + (snapshot.droppedMessages ?? 0)).toBe(1_000_000)
  })

  it('reads the same number of entries for a million messages as for a hundred thousand', () => {
    // #given
    const small = counting(Array.from({length: 100_000}, (_, index) => message(index)))
    const large = counting(Array.from({length: 1_000_000}, (_, index) => message(index)))

    // #when
    snapshotRequest({messages: small.array})
    snapshotRequest({messages: large.array})

    // #then the cost is the budget's, not the history's
    expect(large.visited()).toBe(small.visited())
  })

  it('charges entries that are not messages, so a million nulls cost the budget and no more', () => {
    // #given
    const {array, visited} = counting(Array.from({length: 1_000_000}, () => null))

    // #when
    const snapshot = snapshotRequest({messages: array}, {limits: {maxNodes: 2_000}})

    // #then
    expect(visited()).toBeLessThan(2_100)
    expect(snapshot.messages).toEqual([])
  })

  it('charges the non-record items of a tool result, and of a content array in a message', () => {
    // #given a million non-record items in a tool result, and in a message's tool-result part
    const first = counting(Array.from({length: 1_000_000}, () => 7))
    const second = counting(Array.from({length: 1_000_000}, () => 7))

    // #when
    snapshotToolResult({content: first.array}, {limits: {maxNodes: 1_000}})
    snapshotRequest(
      {messages: [{role: 'tool', content: [{type: 'tool-result', result: {type: 'content', value: second.array}}]}]},
      {limits: {maxNodes: 1_000}},
    )

    // #then
    expect(first.visited()).toBeLessThan(1_100)
    expect(second.visited()).toBeLessThan(1_100)
  })

  it('charges the system parts and the tools it skips', () => {
    // #given
    const parts = counting(Array.from({length: 1_000_000}, () => ({type: 'image'})))

    // #when
    snapshotRequest({system: parts.array}, {limits: {maxNodes: 500}})

    // #then
    expect(parts.visited()).toBeLessThan(600)
  })

  it('does not parse an argument string that is over its bound, or over the parse ceiling', () => {
    // #given a spy on JSON.parse, a 300,000-character JSON string and a 20,000-character one with a 10,000 bound
    const parse = vi.spyOn(JSON, 'parse')
    const big = JSON.stringify({a: 'x'.repeat(300_000)})
    const mid = JSON.stringify({a: 'x'.repeat(20_000)})

    // #when
    const over = snapshotToolArguments(mid, {limits: {valueChars: 10_000}})
    const huge = snapshotToolArguments(big)
    const calls = parse.mock.calls.map(call => String(call[0]).length)
    parse.mockRestore()

    // #then neither was parsed; the first is omitted for its bound, the second is carried as the text it is
    expect(calls.filter(length => length > 10_000)).toEqual([])
    expect(omittedReason(over)).toBe('snapshot-bound')
    expect(huge).toEqual({value: big})
  })

  it('still parses an ordinary JSON-string argument', () => {
    // #given / #when / #then
    expect(snapshotToolArguments('{"path":"a"}')).toEqual({path: 'a'})
  })

  it('counts what it left out as the entries it did not keep', () => {
    // #given ten messages and a budget that keeps about four
    const messages = Array.from({length: 10}, (_, index) => message(index))

    // #when
    const snapshot = snapshotRequest({messages}, {limits: {maxNodes: 12}})

    // #then kept plus dropped is the whole history
    const kept = (snapshot.messages as unknown[]).length
    expect(kept).toBeGreaterThan(0)
    expect(kept + (snapshot.droppedMessages ?? 0)).toBe(10)
  })
})

describe('the ledger’s counted ownership', () => {
  it('holds a retained snapshot until every owner has released it', () => {
    // #given a snapshot with a second owner
    const ledger = createSnapshotLedger()
    const prompt = snapshotPrompt({text: 'shared'}, {ledger})
    ledger.retain(prompt)

    // #when one owner releases
    ledger.release(prompt)

    // #then it is still held; the second release frees it, and a third is ignored
    expect(ledger.stats().pending).toBe(1)
    ledger.release(prompt)
    expect(ledger.stats()).toMatchObject({pending: 0, pendingChars: 0})
    ledger.release(prompt)
    expect(ledger.stats().pending).toBe(0)
  })

  it('ignores a retain on something the ledger does not hold', () => {
    // #given / #when / #then
    const ledger = createSnapshotLedger()
    ledger.retain({})
    ledger.retain(undefined)
    expect(ledger.stats().pending).toBe(0)
  })
})

describe('slots that hold nothing still cost something', () => {
  const limits = {maxNodes: 1_000}
  const isOmitted = (value: unknown): boolean => omittedReason(value) === 'snapshot-bound'

  it('stops a null-filled array at the node budget, and allocates only what it charged', () => {
    // #given a million nulls and a budget of a thousand nodes, with a proxy that counts the slots read
    let reads = 0
    const nulls = new Proxy(
      Array.from({length: 1_000_000}, () => null),
      {
        get(target, key, receiver) {
          if (typeof key === 'string' && /^\d+$/.test(key)) reads += 1
          return Reflect.get(target, key, receiver) as unknown
        },
      },
    )

    // #when
    const snapshot = snapshotToolArguments({list: nulls}, {limits})

    // #then it is omitted, and no more than the budget's worth of slots were read
    expect(isOmitted(snapshot)).toBe(true)
    expect(reads).toBeLessThanOrEqual(1_100)
  })

  it('stops a sparse array of a hundred million holes, without visiting them', () => {
    // #given
    const holes: unknown[] = []
    holes.length = 100_000_000

    // #when
    const started = performance.now()
    const snapshot = snapshotToolArguments({list: holes}, {limits})
    const elapsed = performance.now() - started

    // #then it is omitted, quickly
    expect(isOmitted(snapshot)).toBe(true)
    expect(elapsed).toBeLessThan(250)
  })

  it('charges a null that is a value in an object, and an undefined slot in an array', () => {
    // #given an object of ten thousand null-valued keys and an array of ten thousand undefined slots
    const object = Object.fromEntries(Array.from({length: 10_000}, (_, index) => [`k${index}`, null]))
    const undefinedSlots = Array.from({length: 10_000}, () => undefined)

    // #when / #then both exceed a budget of a thousand nodes
    expect(isOmitted(snapshotToolArguments({object}, {limits}))).toBe(true)
    expect(isOmitted(snapshotToolArguments({list: undefinedSlots}, {limits}))).toBe(true)
  })

  it('still copies a small array with nulls and holes whole, null in place of a hole', () => {
    // #given
    const small: unknown[] = [1, null]
    small.length = 3
    small.push('x')

    // #when
    const snapshot = snapshotToolArguments({list: small}, {limits}) as {list: unknown[]}

    // #then
    expect(snapshot.list).toEqual([1, null, null, 'x'])
  })

  it('charges the slots of a result and of a request’s tool schema the same way', () => {
    // #given nulls in a tool result's content and in a request's message parts
    const result = snapshotToolResult({content: Array.from({length: 100_000}, () => null)}, {limits})
    const request = snapshotRequest(
      {system: [], tools: {}, messages: [{role: 'user', content: Array.from({length: 100_000}, () => null)}]},
      {limits},
    )

    // #then neither walked the whole array
    expect(JSON.stringify(result).length).toBeLessThan(5_000)
    expect(JSON.stringify(request).length).toBeLessThan(5_000)
  })
})
