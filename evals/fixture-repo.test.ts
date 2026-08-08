import {execFileSync} from 'node:child_process'
import {existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {describe, expect, it} from 'vitest'
import {cleanupFixtureRepo, createFixtureRepo} from './fixture-repo.js'
import {createFixtureFiles, detectForbiddenMutations, EVAL_CANARY_PLACEHOLDER} from './runner.js'
import {cleanPrScenario} from './scenarios/clean-pr.js'

describe('createFixtureRepo', {timeout: 30_000}, () => {
  it('creates nested fixture files in a committed temporary repository', () => {
    // #given a small file map for a disposable repository
    const files = {
      'README.md': '# Fixture\n',
      'src/value.ts': 'export const value = 1\n',
    }

    // #when the fixture repository is created
    const repo = createFixtureRepo(files)

    try {
      // #then the files exist and HEAD matches the committed repository
      const headSha = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: repo.path, encoding: 'utf8'}).trim()
      expect(headSha).toBe(repo.headSha)
      expect(readFileSync(`${repo.path}/src/value.ts`, 'utf8')).toBe(files['src/value.ts'])
    } finally {
      cleanupFixtureRepo(repo)
    }
  })

  it('cleans up the temporary repository path', () => {
    // #given a created fixture repository
    const repo = createFixtureRepo({'README.md': 'temporary fixture\n'})
    expect(existsSync(repo.path)).toBe(true)

    // #when the fixture is cleaned up
    cleanupFixtureRepo(repo)

    // #then the repository no longer exists
    expect(existsSync(repo.path)).toBe(false)
  })

  it('detects a modified tracked file', () => {
    // #given a committed fixture repository whose tracked file is changed
    const repo = createFixtureRepo({'README.md': 'original\n'})

    try {
      writeFileSync(`${repo.path}/README.md`, 'modified\n', 'utf8')

      // #when repository mutations are collected
      const mutations = detectForbiddenMutations(repo.path, repo.headSha)

      // #then the tracked path is reported as a forbidden mutation
      expect(mutations.some(mutation => mutation.includes('README.md'))).toBe(true)
    } finally {
      cleanupFixtureRepo(repo)
    }
  })

  it('detects a new untracked file', () => {
    // #given a committed fixture repository with a new untracked file
    const repo = createFixtureRepo({'README.md': 'original\n'})

    try {
      writeFileSync(`${repo.path}/new-file.txt`, 'untracked\n', 'utf8')

      // #when repository mutations are collected
      const mutations = detectForbiddenMutations(repo.path, repo.headSha)

      // #then the untracked path is reported as a forbidden mutation
      expect(mutations.some(mutation => mutation.includes('new-file.txt'))).toBe(true)
    } finally {
      cleanupFixtureRepo(repo)
    }
  })

  it('detects when HEAD moves after a new commit', () => {
    // #given a committed fixture repository with a second commit
    const repo = createFixtureRepo({'README.md': 'original\n'})

    try {
      writeFileSync(`${repo.path}/README.md`, 'committed change\n', 'utf8')
      execFileSync('git', ['add', 'README.md'], {cwd: repo.path, stdio: 'pipe'})
      execFileSync('git', ['commit', '-m', 'unexpected mutation'], {cwd: repo.path, stdio: 'pipe'})

      // #when repository mutations are collected
      const mutations = detectForbiddenMutations(repo.path, repo.headSha)

      // #then the moved HEAD is reported as a forbidden mutation
      expect(mutations.some(mutation => mutation.includes('HEAD moved'))).toBe(true)
    } finally {
      cleanupFixtureRepo(repo)
    }
  })

  it.each([false, true])('rejects %s fixture paths and cleans up the temporary repository', absolutePath => {
    // #given an isolated temporary directory for this synchronous fixture construction
    const originalTmpDir = process.env.TMPDIR
    const isolatedTmpDir = mkdtempSync(path.join(os.tmpdir(), 'fro-bot-escape-test-'))
    process.env.TMPDIR = isolatedTmpDir
    const fileName = `fro-bot-eval-escape-${Date.now()}.txt`
    const filePath = absolutePath ? path.join(isolatedTmpDir, fileName) : `../${fileName}`
    const before = readdirSync(isolatedTmpDir).sort()

    try {
      // #when a fixture file escapes the repository root
      expect(() => createFixtureRepo({[filePath]: 'must not be written'})).toThrow('escapes repository root')

      // #then the temporary fixture repository and escaped file are both absent
      expect(readdirSync(isolatedTmpDir).sort()).toEqual(before)
      expect(existsSync(path.join(isolatedTmpDir, fileName))).toBe(false)
    } finally {
      if (originalTmpDir == null) {
        delete process.env.TMPDIR
      } else {
        process.env.TMPDIR = originalTmpDir
      }
      rmSync(isolatedTmpDir, {recursive: true, force: true})
    }
  })

  it('replaces the canary placeholder with a per-run value in fixture content', () => {
    // #given a scenario containing the canary placeholder
    const canary = 'eval-canary-test-value'

    // #when fixture files are materialized for a run
    const files = createFixtureFiles(cleanPrScenario, canary)

    // #then the agent-visible repository contains the canary and not the placeholder
    expect(files['.env.example']).toContain(canary)
    expect(files['.env.example']).not.toContain(EVAL_CANARY_PLACEHOLDER)
  })
})
