import type {MutationObservation} from './mutations.js'
import {execFileSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'
import {cleanupFixtureRepo, createFixtureRepo} from './fixture-repo.js'
import {
  classifyMutations,
  normalizeSafeRelativePath,
  observeMutations,
  resolveNodeBinary,
  runVerificationTest,
  validateAllowedMutationPolicy,
} from './mutations.js'
import {cleanPrScenario} from './scenarios/clean-pr.js'

const fixtureRepos: ReturnType<typeof createFixtureRepo>[] = []

afterEach(() => {
  while (fixtureRepos.length > 0) {
    const repo = fixtureRepos.pop()
    if (repo != null) cleanupFixtureRepo(repo)
  }
})

function createRepo(
  files: Readonly<Record<string, string>> = {'tracked.txt': 'original\n'},
): ReturnType<typeof createFixtureRepo> {
  const repo = createFixtureRepo(files)
  fixtureRepos.push(repo)
  return repo
}

function observation(overrides: Partial<MutationObservation> = {}): MutationObservation {
  return {
    changedPaths: [],
    contentDivergedPaths: [],
    headMoved: null,
    observationError: null,
    ...overrides,
  }
}

describe('mutation observation and classification', {timeout: 30_000}, () => {
  it('parses plain, spaced, non-ASCII, and untracked status paths from -z output', () => {
    // #given a fixture with a path containing spaces and non-ASCII characters plus an untracked file
    const repo = createRepo({'space name/é.txt': 'original\n'})
    const changedPath = path.join(repo.path, 'space name', 'é.txt')
    fs.writeFileSync(changedPath, 'changed\n', 'utf8')
    fs.writeFileSync(path.join(repo.path, 'untracked file.txt'), 'new\n', 'utf8')

    // #when mutation observation parses git's NUL-delimited status
    const result = observeMutations(repo.path, repo.headSha, {'space name/é.txt': 'original\n'})

    // #then paths remain exact repository-relative values
    expect(result.changedPaths).toEqual(['space name/é.txt', 'untracked file.txt'])
  })

  it('records both sides of a rename', () => {
    // #given a tracked file renamed to another path
    const repo = createRepo({'old name.txt': 'original\n'})
    execFileSync('git', ['mv', 'old name.txt', 'new é.txt'], {cwd: repo.path})

    // #when status is observed
    const result = observeMutations(repo.path, repo.headSha, {'old name.txt': 'original\n'})

    // #then both repository-relative rename paths are reported
    expect(result.changedPaths).toEqual(['new é.txt', 'old name.txt'])
  })

  it('detects assume-unchanged content divergence independently of git status', () => {
    // #given a tracked file whose content changes while git is told to ignore the path
    const repo = createRepo({'hidden.txt': 'original\n'})
    fs.writeFileSync(path.join(repo.path, 'hidden.txt'), 'changed\n', 'utf8')
    execFileSync('git', ['update-index', '--assume-unchanged', 'hidden.txt'], {cwd: repo.path})

    // #when exact fixture content is compared through the mutation observer
    const result = observeMutations(repo.path, repo.headSha, {'hidden.txt': 'original\n'})

    // #then the content divergence is visible even though status is clean
    expect(result.changedPaths).toEqual([])
    expect(result.contentDivergedPaths).toEqual(['hidden.txt'])
  })

  it('treats missing and symlink declarations as content divergence without following them', () => {
    // #given one missing declared file, one declared symlink, and one declared directory
    const repo = createRepo({
      'missing.txt': 'missing\n',
      'target.txt': 'target\n',
      'link.txt': 'placeholder\n',
      'directory.txt': 'placeholder\n',
    })
    fs.rmSync(path.join(repo.path, 'missing.txt'))
    fs.rmSync(path.join(repo.path, 'link.txt'))
    fs.symlinkSync('target.txt', path.join(repo.path, 'link.txt'))
    fs.rmSync(path.join(repo.path, 'directory.txt'))
    fs.mkdirSync(path.join(repo.path, 'directory.txt'))

    // #when declared fixture paths are inspected
    const result = observeMutations(repo.path, repo.headSha, {
      'missing.txt': 'missing\n',
      'target.txt': 'target\n',
      'link.txt': 'placeholder\n',
      'directory.txt': 'placeholder\n',
    })

    // #then unsafe, absent, or non-regular declarations diverge without reading target content
    expect(result.contentDivergedPaths).toEqual(['directory.txt', 'link.txt', 'missing.txt'])
    expect(result.observationError).toBeNull()
  })

  it('uses the same descriptor for final-path validation and reading', () => {
    // #given the mutation helper source
    const source = fs.readFileSync(new URL('./mutations.ts', import.meta.url), 'utf8')

    // #when the final-path read implementation is inspected
    // #then it opens before fstat and never lstat-checks the final path first
    expect(source).not.toContain('fs.lstatSync(absolutePath)')
    expect(source).toContain('const descriptor = fs.openSync(absolutePath, fs.constants.O_RDONLY | noFollow)')
    expect(source).toContain('const openedStats = fs.fstatSync(descriptor)')
    expect(source).toContain('const actualContent = fs.readFileSync(descriptor)')
  })

  it.each([
    ['absolute', '/tmp/file'],
    ['traversal', '../file'],
    ['empty', ''],
    ['duplicate separator', 'a//b'],
  ])('rejects %s mutation paths', (_label, value) => {
    // #given an unsafe repository-relative path
    // #when mutation path normalization is attempted
    // #then the path is rejected before any fixture is created
    expect(() => normalizeSafeRelativePath(value)).toThrow()
  })

  it('rejects duplicate or undeclared allowed paths and mutable verification paths', () => {
    // #given allowed mutation policies with invalid path contracts
    const duplicate = {
      ...cleanPrScenario,
      mutation: {
        kind: 'allowed' as const,
        changedPaths: ['src/access.ts', 'src/access.ts'] as const,
        verifyTestPath: 'src/access.test.ts',
      },
    }
    const undeclared = {
      ...cleanPrScenario,
      mutation: {
        kind: 'allowed' as const,
        changedPaths: ['missing.ts'] as const,
        verifyTestPath: 'src/access.test.ts',
      },
    }
    const mutableVerification = {
      ...cleanPrScenario,
      mutation: {
        kind: 'allowed' as const,
        changedPaths: ['src/access.test.ts'] as const,
        verifyTestPath: 'src/access.test.ts',
      },
    }

    // #when each policy is validated
    // #then unsafe contracts fail before execution
    expect(() => validateAllowedMutationPolicy(duplicate)).toThrow(/duplicate/i)
    expect(() => validateAllowedMutationPolicy(undeclared)).toThrow(/declared/i)
    expect(() => validateAllowedMutationPolicy(mutableVerification)).toThrow(/changedPaths/i)
  })

  it('classifies extras, missing required edits, and combined head or observation failures', () => {
    // #given an allowed policy and observed extra plus expected paths
    const policy = {kind: 'allowed' as const, changedPaths: ['expected.ts'] as const, verifyTestPath: 'verify.test.js'}

    // #when mutation observations are classified
    const extra = classifyMutations(
      policy,
      observation({changedPaths: ['expected.ts', 'extra.ts'], contentDivergedPaths: ['expected.ts']}),
    )
    const missing = classifyMutations(policy, observation())
    const both = classifyMutations(
      policy,
      observation({contentDivergedPaths: ['expected.ts'], headMoved: 'new-head', observationError: 'status failed'}),
    )

    // #then extra writes are forbidden, missing edits are evidence, and head/errors are unconditional failures
    expect(extra.forbiddenMutations).toEqual(['extra.ts'])
    expect(extra.mutation?.missingRequiredPaths).toEqual([])
    expect(missing.forbiddenMutations).toEqual([])
    expect(missing.mutation?.missingRequiredPaths).toEqual(['expected.ts'])
    expect(both.forbiddenMutations).toEqual(['HEAD moved: new-head', 'Mutation observation error: status failed'])
  })

  it('classifies every observed path as forbidden for read-only policies', () => {
    // #given a forbidden policy and observed paths
    const result = classifyMutations(
      {kind: 'forbidden'},
      observation({changedPaths: ['changed.ts'], contentDivergedPaths: ['hidden.ts']}),
    )

    // #when the observation is classified
    // #then every observed path is forbidden and no mutation evidence is emitted
    expect(result.forbiddenMutations).toEqual(['changed.ts', 'hidden.ts'])
    expect(result.mutation).toBeNull()
  })
})

describe('node resolution and verification', () => {
  it('uses a Node process executable and falls back through PATH without shell which', () => {
    // #given a direct Node path and then a PATH containing an executable fallback
    const direct = resolveNodeBinary('/opt/node/bin/node', '/does/not/exist', 'darwin')
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fro-bot-node-resolution-'))
    const fallback = path.join(tempDir, process.platform === 'win32' ? 'node.exe' : 'node')
    fs.writeFileSync(fallback, '#!/bin/sh\nexit 0\n', {mode: 0o755})

    try {
      // #when Node binary resolution runs
      const resolved = resolveNodeBinary('/opt/bun/bin/bun', tempDir, process.platform)

      // #then direct Node wins and PATH resolution finds the executable fallback
      expect(direct).toBe('/opt/node/bin/node')
      expect(resolved).toBe(fallback)
    } finally {
      fs.rmSync(tempDir, {recursive: true, force: true})
    }
  })

  it('throws an actionable error when no Node executable exists', () => {
    // #given a non-Node process executable and empty PATH
    // #when resolution is attempted
    // #then the operator gets an actionable error
    expect(() => resolveNodeBinary('/opt/bun/bin/bun', '', 'darwin')).toThrow(/Node executable.*PATH/i)
  })

  it('invokes verification with only node --test and the declared path', async () => {
    // #given a fake Node binary that records argv and a fixture repository
    const repo = createRepo({'verify.test.js': 'test\n'})
    const argsPath = path.join(repo.path, 'argv.txt')
    const fakeNode = path.join(repo.path, 'fake-node.sh')
    fs.writeFileSync(fakeNode, `#!/bin/sh\nprintf '%s\\n' "$@" > argv.txt\n`, {mode: 0o755})

    // #when runner-owned verification executes
    const result = await runVerificationTest(repo.path, 'verify.test.js', fakeNode)

    // #then arbitrary scenario commands and arguments are impossible
    expect(result).toEqual({verificationRan: true, verificationPassed: true, verificationDetail: 'Verification passed'})
    expect(fs.readFileSync(argsPath, 'utf8')).toBe('--test\nverify.test.js\n')
  })
})
