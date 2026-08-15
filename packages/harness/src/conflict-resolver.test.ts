import type {ConflictModelTurn, ConflictResolutionRequest, ConflictResolverResult} from './conflict-resolver.js'
import {Buffer} from 'node:buffer'
import {execFileSync} from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {buildConflictResolverConfig, resolveConflict} from './conflict-resolver.js'

interface ConflictRepository {
  readonly workDir: string
  readonly runnerTempDir: string
  readonly preConflictCommit: string
  readonly mergeRef: string
}

function runGit(workDir: string, args: readonly string[]): string {
  return execFileSync('git', args, {cwd: workDir, encoding: 'utf8'}).trim()
}

function runGitMayFail(workDir: string, args: readonly string[]): void {
  try {
    runGit(workDir, args)
  } catch {
    // The conflict-producing merge is expected to return non-zero.
  }
}

async function makeTmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

const temporaryScriptDirectories: string[] = []

async function makeConflictRepository(): Promise<ConflictRepository> {
  const workDir = await makeTmpDir('harness-conflict-test-')
  const runnerTempDir = await makeTmpDir('harness-runner-temp-')
  runGit(workDir, ['init', '--quiet'])
  runGit(workDir, ['config', 'user.name', 'harness-test'])
  runGit(workDir, ['config', 'user.email', 'harness-test@example.invalid'])
  await fs.writeFile(path.join(workDir, '.gitignore'), 'ignored.tmp\n', 'utf8')
  await fs.writeFile(
    path.join(workDir, 'opencode.json'),
    JSON.stringify({
      permission: {'*': 'allow', bash: 'allow', edit: {'*': 'allow'}, external_directory: {'*': 'allow'}},
      plugin: ['hostile-plugin'],
    }),
    'utf8',
  )
  await fs.mkdir(path.join(workDir, '.opencode'))
  await fs.writeFile(
    path.join(workDir, '.opencode', 'opencode.json'),
    JSON.stringify({
      permission: {'*': 'allow', bash: 'allow', edit: {'*': 'allow'}, external_directory: {'*': 'allow'}},
      plugin: ['hostile-project-plugin'],
    }),
    'utf8',
  )
  await fs.writeFile(path.join(workDir, 'conflict.txt'), 'base\n', 'utf8')
  runGit(workDir, ['add', '.gitignore', 'opencode.json', '.opencode/opencode.json', 'conflict.txt'])
  runGit(workDir, ['commit', '--quiet', '-m', 'base'])

  runGit(workDir, ['checkout', '--quiet', '-b', 'source'])
  await fs.writeFile(path.join(workDir, 'conflict.txt'), 'source\n', 'utf8')
  runGit(workDir, ['commit', '--quiet', '-am', 'source'])

  runGit(workDir, ['checkout', '--quiet', '-b', 'integration', 'HEAD~1'])
  await fs.writeFile(path.join(workDir, 'conflict.txt'), 'integration\n', 'utf8')
  runGit(workDir, ['commit', '--quiet', '-am', 'integration'])
  const preConflictCommit = runGit(workDir, ['rev-parse', 'HEAD'])
  runGitMayFail(workDir, ['merge', '--no-ff', '--no-edit', 'refs/heads/source'])

  return {workDir, runnerTempDir, preConflictCommit, mergeRef: 'refs/heads/source'}
}

function makeRequest(
  repo: ConflictRepository,
  overrides: Partial<ConflictResolutionRequest> = {},
): ConflictResolutionRequest {
  return {
    integrationWorkDir: repo.workDir,
    runnerTempDir: repo.runnerTempDir,
    preConflictCommit: repo.preConflictCommit,
    mergeRef: repo.mergeRef,
    sourceLabel: 'source conflict',
    conflictPaths: ['conflict.txt'],
    conflictMessage: 'merge conflict in conflict.txt',
    agent: 'build',
    model: 'test/model',
    opencodeBin: 'opencode',
    brokerAuthJson: JSON.stringify({provider: 'broker-test', credential: 'model-only'}),
    ...overrides,
  }
}

async function writeExecutableScript(contents: string): Promise<string> {
  const scriptDirectory = await makeTmpDir('harness-resolver-script-')
  temporaryScriptDirectories.push(scriptDirectory)
  const scriptPath = path.join(scriptDirectory, 'model.mjs')
  await fs.writeFile(scriptPath, `#!/usr/bin/env node\n${contents}\n`, {encoding: 'utf8', mode: 0o700})
  await fs.chmod(scriptPath, 0o700)
  return scriptPath
}

async function removeRepository(repo: ConflictRepository): Promise<void> {
  await fs.rm(repo.workDir, {recursive: true, force: true})
  await fs.rm(repo.runnerTempDir, {recursive: true, force: true})
}

describe('resolveConflict', () => {
  let repo: ConflictRepository | undefined

  beforeEach(async () => {
    repo = await makeConflictRepository()
  })

  afterEach(async () => {
    if (repo !== undefined) await removeRepository(repo)
    for (const directory of temporaryScriptDirectories.splice(0)) {
      await fs.rm(directory, {recursive: true, force: true})
    }
  })

  it('emits the pinned v1 singular permission object at top level and on the selected build agent', () => {
    // #given
    const config = buildConflictResolverConfig('/tmp/conflict-worktree', ['conflict.txt'])
    const buildPermission = (config.agent as {build: {permission: unknown}}).build.permission

    // #then
    expect(config.permission).toMatchObject({'*': 'deny', bash: 'deny', external_directory: 'deny'})
    expect(buildPermission).toEqual(config.permission)
    expect(Object.keys(config)).not.toContain('permissions')
  })

  it('fails closed without broker auth and never starts a model turn', async () => {
    // #given
    if (repo === undefined) throw new Error('test repository was not created')
    let modelCalled = false

    // #when
    const result = await resolveConflict(makeRequest(repo, {brokerAuthJson: undefined}), {
      runModel: async () => {
        modelCalled = true
      },
    })

    // #then
    expect(result.ok).toBe(false)
    expect(modelCalled).toBe(false)
    if (result.ok) throw new Error('expected missing broker auth to fail')
    expect(result.attempts).toBe(0)
    expect(result.error).toMatch(/broker|auth/i)
  })

  it('extracts an allowed regular-file repair and leaves no attempt authority behind', async () => {
    // #given
    if (repo === undefined) throw new Error('test repository was not created')
    const turns: ConflictModelTurn[] = []

    // #when
    const result = await resolveConflict(makeRequest(repo), {
      runModel: async turn => {
        turns.push(turn)
        await fs.writeFile(path.join(turn.workDir, 'conflict.txt'), 'resolved in scratch\n', 'utf8')
      },
    })

    // #then
    if (result.ok === false) throw new Error(JSON.stringify(result))
    expect(result.resolvedPaths).toEqual(['conflict.txt'])
    expect(result.resolvedDigests['conflict.txt']).toBe(
      crypto.createHash('sha256').update('resolved in scratch\n').digest('hex'),
    )
    expect(turns).toHaveLength(1)
    expect(await fs.readFile(path.join(repo.workDir, 'conflict.txt'), 'utf8')).toBe('resolved in scratch\n')
    expect(await fs.readdir(repo.runnerTempDir)).toEqual([])
    expect(runGit(repo.workDir, ['diff', '--name-only', '--diff-filter=U'])).toBe('conflict.txt')
  })

  it('ignores out-of-scope attempt files because only allowed blobs become artifact input', async () => {
    // #given
    if (repo === undefined) throw new Error('test repository was not created')

    // #when
    const result = await resolveConflict(makeRequest(repo), {
      runModel: async turn => {
        await fs.writeFile(path.join(turn.workDir, 'README.md'), 'out of scope\n', 'utf8')
        await fs.writeFile(path.join(turn.workDir, 'conflict.txt'), 'accepted\n', 'utf8')
      },
    })

    // #then
    expect(result.ok).toBe(true)
    await expect(fs.access(path.join(repo.workDir, 'README.md'))).rejects.toThrow()
    expect(await fs.readFile(path.join(repo.workDir, 'conflict.txt'), 'utf8')).toBe('accepted\n')
  })

  it('rejects a changed blob that still contains byte-level conflict markers', async () => {
    // #given
    if (repo === undefined) throw new Error('test repository was not created')

    // #when
    const result = await resolveConflict(makeRequest(repo), {
      runModel: async turn => {
        await fs.writeFile(path.join(turn.workDir, 'conflict.txt'), 'accepted\n<<<<<<< residual\n', 'utf8')
      },
    })

    // #then
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected marker remnants to fail')
    expect(result.error).toMatch(/marker/i)
    expect(await fs.readFile(path.join(repo.workDir, 'conflict.txt'), 'utf8')).toContain('<<<<<<<')
  })

  it.each([
    [
      'symlink',
      async (turn: ConflictModelTurn) => {
        await fs.rm(path.join(turn.workDir, 'conflict.txt'))
        await fs.symlink('outside.txt', path.join(turn.workDir, 'conflict.txt'))
      },
    ],
    [
      'directory',
      async (turn: ConflictModelTurn) => {
        await fs.rm(path.join(turn.workDir, 'conflict.txt'))
        await fs.mkdir(path.join(turn.workDir, 'conflict.txt'))
      },
    ],
  ])('rejects %s output without accepting non-regular data', async (_label, mutate) => {
    // #given
    if (repo === undefined) throw new Error('test repository was not created')

    // #when
    const result = await resolveConflict(makeRequest(repo), {runModel: mutate})

    // #then
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected non-regular output to fail')
    expect(result.error).toMatch(/regular|symlink|attempt/i)
    expect(await fs.readFile(path.join(repo.workDir, 'conflict.txt'), 'utf8')).toContain('<<<<<<<')
    expect(await fs.readdir(repo.runnerTempDir)).toEqual([])
  })

  it('rejects a final-component swap between validation and extraction read', async () => {
    // #given
    if (repo === undefined) throw new Error('test repository was not created')
    let scratchWorkDir: string | undefined
    const validatedStats = new Map<string, Awaited<ReturnType<typeof fs.lstat>>>()
    const originalLstat = fs.lstat.bind(fs)
    const lstatSpy = vi.spyOn(fs, 'lstat').mockImplementation(async target => {
      if (scratchWorkDir === undefined || typeof target !== 'string') return originalLstat(target)
      const targetPath = path.resolve(target)
      const conflictPath = path.resolve(scratchWorkDir, 'conflict.txt')
      if (targetPath !== conflictPath) return originalLstat(target)

      const previouslyValidated = validatedStats.get(targetPath)
      if (previouslyValidated !== undefined) return previouslyValidated

      const stat = await originalLstat(target)
      validatedStats.set(targetPath, stat)
      await fs.writeFile(path.join(scratchWorkDir, 'replacement.txt'), 'swapped\n', 'utf8')
      await fs.rm(target)
      await fs.symlink('replacement.txt', target)
      return stat
    })

    // #when
    let result: ConflictResolverResult
    try {
      result = await resolveConflict(makeRequest(repo), {
        runModel: async turn => {
          scratchWorkDir = turn.workDir
          await fs.writeFile(path.join(turn.workDir, 'conflict.txt'), 'accepted\n', 'utf8')
        },
      })
    } finally {
      lstatSpy.mockRestore()
    }

    // #then
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a raced final path to be rejected')
    expect(result.error).toMatch(/symlink|regular|attempt/i)
    expect(await fs.readFile(path.join(repo.workDir, 'conflict.txt'), 'utf8')).toContain('<<<<<<<')
  })

  it('does not treat ignored, untracked, metadata, or mode changes in scratch as artifact authority', async () => {
    // #given
    if (repo === undefined) throw new Error('test repository was not created')
    const targetModeBefore = (await fs.stat(path.join(repo.workDir, 'conflict.txt'))).mode & 0o7777

    // #when
    const result = await resolveConflict(makeRequest(repo), {
      runModel: async turn => {
        await fs.writeFile(path.join(turn.workDir, 'ignored.tmp'), 'ignored\n', 'utf8')
        await fs.writeFile(path.join(turn.workDir, 'untracked.tmp'), 'untracked\n', 'utf8')
        await fs.appendFile(path.join(turn.workDir, '.git', 'config'), '\n# model metadata\n', 'utf8')
        await fs.chmod(path.join(turn.workDir, 'conflict.txt'), 0o755)
        await fs.writeFile(path.join(turn.workDir, 'conflict.txt'), 'accepted\n', 'utf8')
      },
    })

    // #then
    expect(result.ok).toBe(true)
    expect((await fs.stat(path.join(repo.workDir, 'conflict.txt'))).mode & 0o7777).toBe(targetModeBefore)
    expect(await fs.readFile(path.join(repo.workDir, 'conflict.txt'), 'utf8')).toBe('accepted\n')
  })

  it.each([
    ['invalid UTF-8', Buffer.from([0xff, 0xfe, 0xfd])],
    ['UTF-16', Buffer.from([0xff, 0xfe, 0x41, 0x00, 0x0a, 0x00])],
    ['NUL content', Buffer.from('accepted\u0000\n', 'binary')],
    ['oversized content', Buffer.alloc(1_048_577, 0x61)],
  ])('rejects %s conflict blobs', async (_label, content) => {
    // #given
    if (repo === undefined) throw new Error('test repository was not created')

    const before = await fs.readFile(path.join(repo.workDir, 'conflict.txt'))

    // #when
    const result = await resolveConflict(makeRequest(repo), {
      runModel: async turn => {
        await fs.writeFile(path.join(turn.workDir, 'conflict.txt'), content)
      },
    })

    // #then
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected invalid conflict blob to fail')
    expect(result.error).toMatch(/UTF|NUL|binary|size|marker|attempt/i)
    expect(await fs.readFile(path.join(repo.workDir, 'conflict.txt'))).toEqual(before)
    expect(await fs.readdir(repo.runnerTempDir)).toEqual([])
  })

  it.each([
    '/tmp/requested',
    '../requested',
    String.raw`..\requested`,
    '',
    '.git/config',
    '.git',
    'safe/../.git/config',
  ])('rejects unsafe context request %j without trusted reassessment', async requestedPath => {
    // #given
    if (repo === undefined) throw new Error('test repository was not created')
    let reassessed = false

    // #when
    const result = await resolveConflict(makeRequest(repo), {
      runModel: async () => ({contextRequests: [requestedPath]}),
      reassessReadOnlyContext: async () => {
        reassessed = true
        return []
      },
    })

    // #then
    expect(result.ok).toBe(false)
    expect(reassessed).toBe(false)
  })

  it('rejects unsafe context-request files before trusted reassessment', async () => {
    // #given
    if (repo === undefined) throw new Error('test repository was not created')
    let reassessed = false

    // #when
    const result = await resolveConflict(makeRequest(repo), {
      runModel: async turn => {
        await fs.writeFile(path.join(turn.workDir, '.harness-context-request'), '.git/config\n', 'utf8')
        return {}
      },
      reassessReadOnlyContext: async () => {
        reassessed = true
        return []
      },
    })

    // #then
    expect(result.ok).toBe(false)
    expect(reassessed).toBe(false)
  })

  it('recreates a fresh conflict for retry and permits only trusted read-only context widening', async () => {
    // #given
    if (repo === undefined) throw new Error('test repository was not created')
    const initialContents: string[] = []
    const request = makeRequest(repo)

    // #when
    const result = await resolveConflict(request, {
      runModel: async turn => {
        initialContents.push(await fs.readFile(path.join(turn.workDir, 'conflict.txt'), 'utf8'))
        if (turn.attempt === 1) {
          await fs.writeFile(path.join(turn.workDir, 'ignored.tmp'), 'must not survive\n', 'utf8')
          return {contextRequests: ['README.md']}
        }
        await expect(fs.access(path.join(turn.workDir, 'ignored.tmp'))).rejects.toThrow()
        await fs.writeFile(path.join(turn.workDir, 'conflict.txt'), 'retry accepted\n', 'utf8')
        return {}
      },
      reassessReadOnlyContext: async (_request, requests) => {
        expect(requests).toEqual(['README.md'])
        return [{path: 'README.md', content: 'reviewed context\n'}]
      },
    })

    // #then
    if (result.ok === false) throw new Error(JSON.stringify(result))
    expect(result.attempts).toBe(2)
    expect(initialContents[0]).toContain('<<<<<<<')
    expect(initialContents[1]).toContain('<<<<<<<')
    expect(await fs.readdir(repo.runnerTempDir)).toEqual([])
  })

  it('caps failed repairs at two attempts', async () => {
    // #given
    if (repo === undefined) throw new Error('test repository was not created')
    let attempts = 0

    // #when
    const result: ConflictResolverResult = await resolveConflict(makeRequest(repo), {
      runModel: async () => {
        attempts++
      },
    })

    // #then
    expect(result.ok).toBe(false)
    expect(attempts).toBe(2)
    expect(result.attempts).toBe(2)
  })

  it('fails the integration when cleanup fails, even after a valid model edit', async () => {
    // #given
    if (repo === undefined) throw new Error('test repository was not created')

    // #when
    const result = await resolveConflict(makeRequest(repo), {
      runModel: async turn => {
        await fs.writeFile(path.join(turn.workDir, 'conflict.txt'), 'accepted\n', 'utf8')
      },
      removeAttempt: async () => {
        throw new Error('cleanup failure')
      },
    })

    // #then
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('cleanup failure must fail the resolver')
    expect(result.error).toMatch(/cleanup/i)
    expect(await fs.readFile(path.join(repo.workDir, 'conflict.txt'), 'utf8')).toContain('<<<<<<<')
  })

  it('distinguishes subprocess failure and timeout from a no-edit repair', async () => {
    // #given
    if (repo === undefined) throw new Error('test repository was not created')
    const failureScript = await writeExecutableScript('process.exit(17)')
    const timeoutScript = await writeExecutableScript('setTimeout(() => process.exit(0), 1000)')

    // #when
    const failedProcess = await resolveConflict(makeRequest(repo, {opencodeBin: failureScript}), {
      modelTimeoutMs: 500,
    })
    const timedOutProcess = await resolveConflict(makeRequest(repo, {opencodeBin: timeoutScript}), {
      modelTimeoutMs: 20,
    })
    const noEdit = await resolveConflict(makeRequest(repo), {runModel: async () => {}})

    // #then
    expect(failedProcess.ok).toBe(false)
    expect(timedOutProcess.ok).toBe(false)
    expect(noEdit.ok).toBe(false)
    if (failedProcess.ok || timedOutProcess.ok || noEdit.ok) throw new Error('all invalid process outcomes must fail')
    expect(`${failedProcess.error} ${timedOutProcess.error} ${noEdit.error}`).toMatch(
      /process|timeout|edit|marker|attempt/i,
    )
  })

  it('proves the real subprocess receives private broker auth/config without denied credentials', async () => {
    // #given
    if (repo === undefined) throw new Error('test repository was not created')
    const script = await writeExecutableScript(String.raw`
      import fs from 'node:fs'
      import path from 'node:path'
      const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? '{}')
      const authPath = path.join(process.env.XDG_DATA_HOME ?? '', 'opencode', 'auth.json')
      const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'))
      const mode = fs.statSync(authPath).mode & 0o777
      const attemptRoot = path.dirname(process.cwd())
      for (const key of [
        'HOME',
        'XDG_CONFIG_HOME',
        'XDG_DATA_HOME',
        'XDG_STATE_HOME',
        'XDG_CACHE_HOME',
        'RUNNER_TEMP',
        'TMPDIR',
        'TMP',
        'TEMP',
      ]) {
        const directory = process.env[key] ?? ''
        const privatePath = directory === attemptRoot || directory.startsWith(attemptRoot + path.sep)
        if (!privatePath || (fs.statSync(directory).mode & 0o777) !== 0o700) process.exit(30)
      }
      if (mode !== 0o600) process.exit(31)
      if (auth.credential !== 'model-only') process.exit(32)
      if (config.outer === true || config.plugin?.length !== 0 || config.autoupdate !== false) process.exit(33)
      const permissionKeys = Object.keys(config.permission ?? {})
      if (permissionKeys[0] !== '*' || config.permission['*'] !== 'deny') process.exit(38)
      if (config.permission.read?.['conflict.txt'] !== 'allow' || config.permission.edit?.['conflict.txt'] !== 'allow') process.exit(39)
      if (config.agent?.build?.permission?.['*'] !== 'deny') process.exit(41)
      if (process.env.OPENCODE_DISABLE_PROJECT_CONFIG !== '1') process.exit(42)
      if (process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS !== '1' || process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS !== '1') process.exit(45)
      if (process.env.OPENCODE_CONFIG !== undefined || process.env.OPENCODE_CONFIG_DIR !== undefined) process.exit(43)
      if (config.plugin?.length !== 0 || !fs.existsSync(path.join(process.cwd(), 'opencode.json')) || !fs.existsSync(path.join(process.cwd(), '.opencode', 'opencode.json'))) process.exit(44)
      if (config.permission.bash !== 'deny' || config.permission.webfetch !== 'deny' || config.permission.task !== 'deny' || config.permission.skill !== 'deny' || config.permission.question !== 'deny' || config.permission.external_directory !== 'deny') process.exit(40)
      if (process.env.GITHUB_TOKEN !== undefined || process.env.GH_TOKEN !== undefined) process.exit(34)
      if (process.env.AWS_SECRET_ACCESS_KEY !== undefined || process.env.ANTHROPIC_API_KEY !== undefined) process.exit(35)
      if (process.env.GIT_ASKPASS !== undefined || process.env.SSH_ASKPASS !== undefined) process.exit(36)
      if (process.env.HOME === undefined || process.env.XDG_CONFIG_HOME === undefined || process.env.XDG_STATE_HOME === undefined || process.env.XDG_CACHE_HOME === undefined) process.exit(37)
      fs.writeFileSync(path.join(process.cwd(), 'conflict.txt'), 'subprocess accepted\n')
    `)
    const original = {
      github: process.env.GITHUB_TOKEN,
      gh: process.env.GH_TOKEN,
      aws: process.env.AWS_SECRET_ACCESS_KEY,
      provider: process.env.ANTHROPIC_API_KEY,
      askpass: process.env.GIT_ASKPASS,
      outerConfig: process.env.OPENCODE_CONFIG_CONTENT,
    }
    process.env.GITHUB_TOKEN = 'must-not-pass'
    process.env.GH_TOKEN = 'must-not-pass'
    process.env.AWS_SECRET_ACCESS_KEY = 'must-not-pass'
    process.env.ANTHROPIC_API_KEY = 'must-not-pass'
    process.env.GIT_ASKPASS = '/tmp/must-not-pass'
    process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({outer: true})

    // #when
    let result: ConflictResolverResult | undefined
    try {
      result = await resolveConflict(makeRequest(repo, {opencodeBin: script}))
    } finally {
      process.env.GITHUB_TOKEN = original.github
      process.env.GH_TOKEN = original.gh
      process.env.AWS_SECRET_ACCESS_KEY = original.aws
      process.env.ANTHROPIC_API_KEY = original.provider
      process.env.GIT_ASKPASS = original.askpass
      process.env.OPENCODE_CONFIG_CONTENT = original.outerConfig
    }

    // #then
    if (result === undefined) throw new Error('expected resolver result')
    expect(result.ok).toBe(true)
    expect(await fs.readFile(path.join(repo.workDir, 'conflict.txt'), 'utf8')).toBe('subprocess accepted\n')
  })

  it.skipIf(process.env.FRO_BOT_RUN_PINNED_OPENCODE_CONFLICT_TEST !== '1')(
    'gated: runs the pinned OpenCode binary through the broker-auth resolver boundary',
    async () => {
      // #given
      if (repo === undefined) throw new Error('test repository was not created')
      const brokerAuthJson = process.env.FRO_BOT_CONFLICT_AUTH_JSON
      const pinnedBinary = process.env.FRO_BOT_PINNED_OPENCODE_BIN
      const model = process.env.FRO_BOT_CONFLICT_MODEL
      const runnerTempDir = process.env.RUNNER_TEMP
      if (
        brokerAuthJson === undefined ||
        pinnedBinary === undefined ||
        model === undefined ||
        runnerTempDir === undefined
      ) {
        throw new Error('pinned OpenCode conflict test requires broker auth JSON, binary, model, and RUNNER_TEMP')
      }

      // #when
      const result = await resolveConflict(
        makeRequest(repo, {
          brokerAuthJson,
          opencodeBin: pinnedBinary,
          model,
          runnerTempDir,
        }),
        {modelTimeoutMs: 30 * 60 * 1000},
      )

      // #then
      expect(result.ok).toBe(true)
    },
  )
})
