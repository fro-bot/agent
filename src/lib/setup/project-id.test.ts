import type {ExecAdapter, ExecOutput} from './types.js'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {ensureProjectId, type ProjectIdOptions} from './project-id.js'

function createTestLogger() {
  return {
    debug: () => {},
    info: () => {},
    warning: () => {},
    error: () => {},
  }
}

function createMockExecAdapter(options: {stdout?: string; exitCode?: number; shouldThrow?: boolean}): ExecAdapter {
  return {
    exec: async () => options.exitCode ?? 0,
    getExecOutput: async (): Promise<ExecOutput> => {
      if (options.shouldThrow === true) {
        throw new Error('git command failed')
      }
      return {
        exitCode: options.exitCode ?? 0,
        stdout: options.stdout ?? '',
        stderr: '',
      }
    },
  }
}

describe('ensureProjectId', () => {
  let tempDir: string
  let workspacePath: string
  let gitDir: string
  let projectIdFile: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'project-id-test-'))
    workspacePath = tempDir
    gitDir = path.join(workspacePath, '.git')
    projectIdFile = path.join(gitDir, 'opencode')
  })

  afterEach(async () => {
    await fs.rm(tempDir, {recursive: true, force: true})
  })

  it('returns cached ID when .git/opencode exists', async () => {
    // #given workspace with .git/opencode containing cached ID
    const cachedId = 'abc123def456'
    await fs.mkdir(gitDir, {recursive: true})
    await fs.writeFile(projectIdFile, cachedId, 'utf8')

    const options: ProjectIdOptions = {
      workspacePath,
      logger: createTestLogger(),
    }

    // #when ensureProjectId is called
    const result = await ensureProjectId(options)

    // #then it returns the cached ID
    expect(result.projectId).toBe(cachedId)
    expect(result.source).toBe('cached')
    expect(result.error).toBeUndefined()
  })

  it('generates ID from root commit when no cache exists', async () => {
    // #given workspace with git repo but no .git/opencode
    await fs.mkdir(gitDir, {recursive: true})

    const rootCommitSha = 'e1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0'
    const execAdapter = createMockExecAdapter({stdout: `${rootCommitSha}\n`})

    const options: ProjectIdOptions = {
      workspacePath,
      logger: createTestLogger(),
      execAdapter,
    }

    // #when ensureProjectId is called
    const result = await ensureProjectId(options)

    // #then it generates and returns the project ID
    expect(result.projectId).toBe(rootCommitSha)
    expect(result.source).toBe('generated')
    expect(result.error).toBeUndefined()
  })

  it('writes generated ID to .git/opencode cache file', async () => {
    // #given workspace with git repo but no .git/opencode
    await fs.mkdir(gitDir, {recursive: true})

    const rootCommitSha = 'f1e2d3c4b5a6978879685746352413021a0b1c2d'
    const execAdapter = createMockExecAdapter({stdout: `${rootCommitSha}\n`})

    const options: ProjectIdOptions = {
      workspacePath,
      logger: createTestLogger(),
      execAdapter,
    }

    // #when ensureProjectId is called
    await ensureProjectId(options)

    // #then the ID is written to .git/opencode
    const cachedContent = await fs.readFile(projectIdFile, 'utf8')
    expect(cachedContent).toBe(rootCommitSha)
  })

  it('sorts multiple root commits and takes first (deterministic)', async () => {
    // #given git repo with multiple root commits (e.g., merge from unrelated history)
    await fs.mkdir(gitDir, {recursive: true})

    const rootCommits = 'cccc\naaaa\nbbbb\n'
    const execAdapter = createMockExecAdapter({stdout: rootCommits})

    const options: ProjectIdOptions = {
      workspacePath,
      logger: createTestLogger(),
      execAdapter,
    }

    // #when ensureProjectId is called
    const result = await ensureProjectId(options)

    // #then it returns alphabetically first root commit
    expect(result.projectId).toBe('aaaa')
    expect(result.source).toBe('generated')
  })

  it('returns error for non-git directory', async () => {
    // #given workspace without .git directory
    const options: ProjectIdOptions = {
      workspacePath,
      logger: createTestLogger(),
    }

    // #when ensureProjectId is called
    const result = await ensureProjectId(options)

    // #then it returns error result
    expect(result.projectId).toBeNull()
    expect(result.source).toBe('error')
    expect(result.error).toBe('Not a git repository')
  })

  it('returns error for empty repo (no commits)', async () => {
    // #given git repo with no commits
    await fs.mkdir(gitDir, {recursive: true})

    const execAdapter = createMockExecAdapter({stdout: '', exitCode: 0})

    const options: ProjectIdOptions = {
      workspacePath,
      logger: createTestLogger(),
      execAdapter,
    }

    // #when ensureProjectId is called
    const result = await ensureProjectId(options)

    // #then it returns error result
    expect(result.projectId).toBeNull()
    expect(result.source).toBe('error')
    expect(result.error).toBe('No commits found in repository')
  })

  it('handles exec failure gracefully', async () => {
    // #given git repo and exec adapter that throws
    await fs.mkdir(gitDir, {recursive: true})

    const execAdapter = createMockExecAdapter({shouldThrow: true})

    const options: ProjectIdOptions = {
      workspacePath,
      logger: createTestLogger(),
      execAdapter,
    }

    // #when ensureProjectId is called
    const result = await ensureProjectId(options)

    // #then it returns error result without throwing
    expect(result.projectId).toBeNull()
    expect(result.source).toBe('error')
    expect(result.error).toBeDefined()
  })

  it('handles non-zero exit code from git', async () => {
    // #given git repo and exec adapter returns non-zero exit code
    await fs.mkdir(gitDir, {recursive: true})

    const execAdapter = createMockExecAdapter({exitCode: 128, stdout: ''})

    const options: ProjectIdOptions = {
      workspacePath,
      logger: createTestLogger(),
      execAdapter,
    }

    // #when ensureProjectId is called
    const result = await ensureProjectId(options)

    // #then it returns error result
    expect(result.projectId).toBeNull()
    expect(result.source).toBe('error')
    expect(result.error).toBe('No commits found in repository')
  })

  it('ignores empty cached ID and regenerates', async () => {
    // #given workspace with .git/opencode containing empty string
    await fs.mkdir(gitDir, {recursive: true})
    await fs.writeFile(projectIdFile, '', 'utf8')

    const rootCommitSha = 'regenerated123'
    const execAdapter = createMockExecAdapter({stdout: `${rootCommitSha}\n`})

    const options: ProjectIdOptions = {
      workspacePath,
      logger: createTestLogger(),
      execAdapter,
    }

    // #when ensureProjectId is called
    const result = await ensureProjectId(options)

    // #then it regenerates the ID
    expect(result.projectId).toBe(rootCommitSha)
    expect(result.source).toBe('generated')
  })

  it('handles whitespace-only cached ID and regenerates', async () => {
    // #given workspace with .git/opencode containing whitespace
    await fs.mkdir(gitDir, {recursive: true})
    await fs.writeFile(projectIdFile, '   \n  ', 'utf8')

    const rootCommitSha = 'regenerated456'
    const execAdapter = createMockExecAdapter({stdout: `${rootCommitSha}\n`})

    const options: ProjectIdOptions = {
      workspacePath,
      logger: createTestLogger(),
      execAdapter,
    }

    // #when ensureProjectId is called
    const result = await ensureProjectId(options)

    // #then it regenerates the ID
    expect(result.projectId).toBe(rootCommitSha)
    expect(result.source).toBe('generated')
  })

  it('handles worktree .git file format', async () => {
    // #given workspace where .git is a file (worktree)
    const actualGitDir = path.join(tempDir, 'actual-git-dir')
    await fs.mkdir(actualGitDir, {recursive: true})
    await fs.writeFile(path.join(workspacePath, '.git'), `gitdir: ${actualGitDir}`, 'utf8')

    const rootCommitSha = 'worktree123'
    const execAdapter = createMockExecAdapter({stdout: `${rootCommitSha}\n`})

    const options: ProjectIdOptions = {
      workspacePath,
      logger: createTestLogger(),
      execAdapter,
    }

    // #when ensureProjectId is called
    const result = await ensureProjectId(options)

    // #then it handles the worktree and returns generated ID
    expect(result.projectId).toBe(rootCommitSha)
    expect(result.source).toBe('generated')
  })
})
