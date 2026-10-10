import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {pathToFileURL} from 'node:url'
import {describe, expect, it} from 'vitest'
// The single source of truth. The gateway image COPYs this file as-is; the Action's tsdown build relocates it
// to dist/no-task-reuse.js. Same logic, one file, so these cases are the contract for both surfaces.
import sourcePlugin, {rejectTaskReuse, TASK_REUSE_REJECTION} from '../../../deploy/plugins/no-task-reuse.mjs'

type Plugin = typeof sourcePlugin
interface PluginModule {
  readonly default: Plugin
  readonly rejectTaskReuse: typeof rejectTaskReuse
  readonly TASK_REUSE_REJECTION: string
}

const DIST_ASSET_PATH = path.join(import.meta.dirname, '..', '..', '..', 'dist', 'no-task-reuse.js')

const base = {description: 'd', prompt: 'p', subagent_type: 'general'}
const INPUT = {tool: 'task', sessionID: 'ses_root', callID: 'call_1'}

const REJECTED = [
  {name: 'background resume', args: {...base, task_id: 'ses_abc', background: true}},
  {name: 'foreground resume', args: {...base, task_id: 'ses_abc', background: false}},
  {name: 'resume without a background flag', args: {...base, task_id: 'ses_abc'}},
  {name: 'non-string truthy task_id', args: {...base, task_id: 1}},
  {name: 'object task_id', args: {...base, task_id: {id: 'x'}}},
] as const

const PASSED = [
  {name: 'no task_id', args: {...base}},
  {name: 'background without task_id', args: {...base, background: true}},
  {name: 'empty task_id', args: {...base, task_id: ''}},
  {name: 'null task_id', args: {...base, task_id: null}},
  {name: 'undefined task_id', args: {...base, task_id: undefined}},
] as const

function exercise(mod: PluginModule): void {
  describe.each(REJECTED)('rejects $name', ({args}) => {
    it('throws the fixed error and leaves the arguments untouched', () => {
      // #given a task call that resumes a session
      const before = structuredClone(args)
      const output = {args}

      // #when the hook runs
      // #then it throws the exact constant, and does not mutate (strip) task_id
      expect(() => mod.rejectTaskReuse(INPUT, output)).toThrow(new Error(mod.TASK_REUSE_REJECTION))
      expect(output.args).toEqual(before)
    })
  })

  describe.each(PASSED)('passes $name', ({args}) => {
    it('returns without throwing and leaves the arguments untouched', () => {
      // #given a task call that starts a fresh session
      const before = structuredClone(args)
      const output = {args}

      // #when/#then
      expect(() => mod.rejectTaskReuse(INPUT, output)).not.toThrow()
      expect(output.args).toEqual(before)
    })
  })

  it('ignores other tools even when their arguments carry a task_id', () => {
    // #given tools other than `task` (including near-miss names)
    for (const tool of ['bash', 'read', 'edit', 'tasks', 'Task']) {
      // #then none is touched
      expect(() => mod.rejectTaskReuse({...INPUT, tool}, {args: {task_id: 'ses_abc'}})).not.toThrow()
    }
  })

  it('passes malformed hook payloads', () => {
    // #given/#then it only ever rejects a recognisable resume
    expect(() => mod.rejectTaskReuse(INPUT, {})).not.toThrow()
    expect(() => mod.rejectTaskReuse(INPUT, undefined)).not.toThrow()
    expect(() => mod.rejectTaskReuse(INPUT, {args: null})).not.toThrow()
    expect(() => mod.rejectTaskReuse(undefined, {args: {task_id: 'ses_abc'}})).not.toThrow()
  })

  it('uses a fixed rejection that leaks neither the session id nor the prompt', () => {
    // #given a resume carrying distinctive values
    let thrown: unknown
    try {
      mod.rejectTaskReuse(INPUT, {args: {...base, prompt: 'SECRET-PROMPT', task_id: 'ses_DISTINCTIVE'}})
    } catch (error) {
      thrown = error
    }

    // #then
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toBe(
      'Session reuse is disabled in this environment. Start a new task and include the context it needs.',
    )
  })

  it('is a v1 server plugin registering exactly the tool.execute.before hook', async () => {
    // #given the default export OpenCode's loader reads
    // #when initialised
    const hooks = await mod.default.server()

    // #then
    expect(typeof mod.default.id).toBe('string')
    expect(Object.keys(hooks)).toEqual(['tool.execute.before'])
    expect(hooks['tool.execute.before']).toBe(mod.rejectTaskReuse)
  })
}

describe('deploy/plugins/no-task-reuse.mjs (source of truth)', () => {
  exercise({default: sourcePlugin, rejectTaskReuse, TASK_REUSE_REJECTION})
})

describe('dist/no-task-reuse.js (the bundle the Action ships)', () => {
  it('behaves exactly as the source, case for case', async () => {
    // #given the committed bundle (skipped when this checkout has not built dist/)
    const present = await fs.access(DIST_ASSET_PATH).then(
      () => true,
      () => false,
    )
    if (!present) return
    const built = (await import(pathToFileURL(DIST_ASSET_PATH).href)) as PluginModule

    // #then the exports and the model-visible rejection are identical to the source
    expect(built.TASK_REUSE_REJECTION).toBe(TASK_REUSE_REJECTION)
    expect(built.default.id).toBe(sourcePlugin.id)

    // #then and every accept/reject decision matches
    for (const {args} of [...REJECTED, ...PASSED]) {
      const sourceOutcome = outcome(() => rejectTaskReuse(INPUT, {args}))
      const builtOutcome = outcome(() => built.rejectTaskReuse(INPUT, {args}))
      expect(builtOutcome).toEqual(sourceOutcome)
    }
    expect(outcome(() => built.rejectTaskReuse({...INPUT, tool: 'bash'}, {args: {task_id: 'x'}}))).toBe('pass')
    expect(Object.keys(await built.default.server())).toEqual(['tool.execute.before'])
  })
})

function outcome(fn: () => void): string {
  try {
    fn()
    return 'pass'
  } catch (error) {
    return error instanceof Error ? `throw:${error.message}` : 'throw:?'
  }
}
