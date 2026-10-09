// Unit tests for deploy/plugins/no-task-reuse.mjs — run with `node --test deploy/scripts/*.test.mjs`.
//
// The plugin is the enforcement point for "gateway OpenCode never resumes a session through task_id".
// BDD comments follow the repo convention (#given / #when / #then).

import assert from 'node:assert/strict'
import {test} from 'node:test'

import plugin, {rejectTaskReuse, TASK_REUSE_REJECTION} from '../plugins/no-task-reuse.mjs'

const INPUT = {tool: 'task', sessionID: 'ses_root', callID: 'call_1'}

/** @param {object} args */
function callHook(args, input = INPUT) {
  const output = {args}
  rejectTaskReuse(input, output)
  return output
}

test('a non-empty task_id is rejected for a background call', () => {
  // #given a background task call that names a session to resume
  const args = {description: 'd', prompt: 'p', subagent_type: 'general', task_id: 'ses_abc', background: true}

  // #when/#then the hook throws the fixed error
  assert.throws(() => callHook(args), {message: TASK_REUSE_REJECTION})
})

test('a non-empty task_id is rejected for a foreground call', () => {
  // #given a foreground call (background false or absent) that names a session to resume
  for (const args of [
    {description: 'd', prompt: 'p', subagent_type: 'general', task_id: 'ses_abc', background: false},
    {description: 'd', prompt: 'p', subagent_type: 'general', task_id: 'ses_abc'},
  ]) {
    // #then it is rejected the same way: upstream extends unconditionally, so foreground is not safe either
    assert.throws(() => callHook(args), {message: TASK_REUSE_REJECTION})
  }
})

test('the rejection is the fixed text and leaks nothing from the arguments', () => {
  // #given a task_id and prompt carrying distinctive values
  const args = {description: 'd', prompt: 'SECRET-PROMPT', subagent_type: 'general', task_id: 'ses_DISTINCTIVE'}

  // #when the hook rejects it
  let thrown
  try {
    callHook(args)
  } catch (error) {
    thrown = error
  }

  // #then the message is exactly the constant, with neither the id nor the prompt
  assert.ok(thrown instanceof Error)
  assert.equal(
    thrown.message,
    'Session reuse is disabled in this environment. Start a new task and include the context it needs.',
  )
  assert.ok(!thrown.message.includes('ses_DISTINCTIVE'))
  assert.ok(!thrown.message.includes('SECRET-PROMPT'))
})

test('an absent, empty, or null task_id passes (a fresh task)', () => {
  // #given task calls that do not resume anything (upstream: `params.task_id ? sessions.get(...) : undefined`)
  for (const args of [
    {description: 'd', prompt: 'p', subagent_type: 'general'},
    {description: 'd', prompt: 'p', subagent_type: 'general', task_id: ''},
    {description: 'd', prompt: 'p', subagent_type: 'general', task_id: null},
    {description: 'd', prompt: 'p', subagent_type: 'general', task_id: undefined},
    {description: 'd', prompt: 'p', subagent_type: 'general', background: true},
  ]) {
    // #then none is rejected
    assert.doesNotThrow(() => callHook(args))
  }
})

test('a non-string task_id that upstream would treat as a resume is rejected too', () => {
  // #given a malformed but truthy task_id
  // #then it is rejected: the test mirrors upstream truthiness, whatever the type
  assert.throws(() => callHook({description: 'd', prompt: 'p', subagent_type: 'general', task_id: 1}), {
    message: TASK_REUSE_REJECTION,
  })
  assert.throws(() => callHook({description: 'd', prompt: 'p', subagent_type: 'general', task_id: {id: 'x'}}), {
    message: TASK_REUSE_REJECTION,
  })
})

test('other tools pass, even when their arguments carry a task_id', () => {
  // #given tools other than task whose args happen to include task_id
  for (const tool of ['bash', 'read', 'edit', 'todowrite', 'tasks', 'Task']) {
    // #then none is touched
    assert.doesNotThrow(() => callHook({task_id: 'ses_abc', command: 'ls'}, {...INPUT, tool}))
  }
})

test('malformed hook payloads pass (the hook only ever rejects a recognisable resume)', () => {
  // #given hook calls with missing or non-object args
  assert.doesNotThrow(() => rejectTaskReuse(INPUT, {}))
  assert.doesNotThrow(() => rejectTaskReuse(INPUT, undefined))
  assert.doesNotThrow(() => rejectTaskReuse(INPUT, {args: null}))
  assert.doesNotThrow(() => rejectTaskReuse(undefined, {args: {task_id: 'ses_abc'}}))
})

test('the args object is unchanged on a pass', () => {
  // #given a frozen args object, so any mutation (including stripping task_id) would throw or show up
  const args = Object.freeze({description: 'd', prompt: 'p', subagent_type: 'general', task_id: ''})
  const before = structuredClone(args)

  // #when the hook passes it
  const output = callHook(args)

  // #then the same object, byte-for-byte equal, still carries its fields
  assert.equal(output.args, args)
  assert.deepEqual(output.args, before)
})

test('the args object is unchanged on a rejection (task_id is never silently stripped)', () => {
  // #given a task_id call
  const args = {description: 'd', prompt: 'p', subagent_type: 'general', task_id: 'ses_abc'}
  const before = structuredClone(args)
  const output = {args}

  // #when it is rejected
  assert.throws(() => rejectTaskReuse(INPUT, output), {message: TASK_REUSE_REJECTION})

  // #then the arguments were not mutated
  assert.deepEqual(output.args, before)
})

test('the module is a v1 OpenCode server plugin that registers exactly the tool.execute.before hook', async () => {
  // #given the default export OpenCode's loader reads
  // #then it has an id and a server() returning the hook map
  assert.equal(typeof plugin.id, 'string')
  assert.ok(plugin.id.length > 0)
  assert.equal(typeof plugin.server, 'function')

  // #when it is initialised
  const hooks = await plugin.server()

  // #then the one hook is the exported guard
  assert.deepEqual(Object.keys(hooks), ['tool.execute.before'])
  assert.equal(hooks['tool.execute.before'], rejectTaskReuse)
})
