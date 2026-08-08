import type {MutationEvidence, MutationPolicy, Scenario} from './types.js'
import {Buffer} from 'node:buffer'
import {execFile, execFileSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import process from 'node:process'
import {normalizeSafeRelativePath} from './fixture-repo.js'

export {normalizeSafeRelativePath} from './fixture-repo.js'

export interface MutationObservation {
  readonly changedPaths: readonly string[]
  readonly contentDivergedPaths: readonly string[]
  readonly headMoved: string | null
  readonly observationError: string | null
}

const VERIFICATION_TIMEOUT_MS = 30_000

function errorCode(error: unknown): string | null {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    return error.code
  }
  return null
}

function boundedError(error: unknown): string {
  const detail = error instanceof Error ? error.message : 'unknown error'
  return detail.length > 240 ? `${detail.slice(0, 240)}…` : detail
}

function addObservationError(current: string | null, next: string): string {
  if (current == null) return next
  return `${current}; ${next}`
}

function parseStatusPaths(status: string): readonly string[] {
  const records = status.split('\0')
  const paths = new Set<string>()

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (record == null || record.length === 0) continue
    if (record.length < 4 || record[2] !== ' ') {
      throw new Error('git status returned an invalid porcelain record')
    }

    paths.add(normalizeSafeRelativePath(record.slice(3)))
    const statusCode = record.slice(0, 2)
    if (statusCode.includes('R') || statusCode.includes('C')) {
      const relatedPath = records[index + 1]
      if (relatedPath == null || relatedPath.length === 0) {
        throw new Error('git status returned an incomplete rename or copy record')
      }
      paths.add(normalizeSafeRelativePath(relatedPath))
      index += 1
    }
  }

  return [...paths].sort()
}

function isExpectedPathDivergence(error: unknown): boolean {
  const code = errorCode(error)
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP' || code === 'EISDIR'
}

function hasUnsafeAncestor(repoPath: string, relativePath: string): boolean {
  let current = repoPath
  const parts = relativePath.split('/')

  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index]
    if (part == null) throw new Error('Mutation path component is missing')
    current = path.join(current, part)
    try {
      const stats = fs.lstatSync(current)
      if (stats.isSymbolicLink()) return true
      if (index < parts.length - 1 && stats.isDirectory() === false) return true
    } catch (error) {
      if (isExpectedPathDivergence(error)) return false
      throw error
    }
  }

  return false
}

function compareDeclaredFile(
  repoPath: string,
  relativePath: string,
  expectedContent: string,
): {readonly diverged: boolean; readonly error: string | null} {
  const normalizedPath = normalizeSafeRelativePath(relativePath)
  const absolutePath = path.resolve(repoPath, ...normalizedPath.split('/'))

  try {
    if (hasUnsafeAncestor(repoPath, normalizedPath)) {
      return {diverged: true, error: null}
    }

    const noFollow = fs.constants.O_NOFOLLOW ?? 0
    const descriptor = fs.openSync(absolutePath, fs.constants.O_RDONLY | noFollow)
    try {
      const openedStats = fs.fstatSync(descriptor)
      if (openedStats.isFile() === false) {
        return {diverged: true, error: null}
      }
      const actualContent = fs.readFileSync(descriptor)
      const matches = Buffer.from(expectedContent, 'utf8').equals(actualContent)
      return {diverged: matches === false, error: null}
    } finally {
      fs.closeSync(descriptor)
    }
  } catch (error) {
    if (isExpectedPathDivergence(error)) {
      return {diverged: true, error: null}
    }
    return {diverged: true, error: boundedError(error)}
  }
}

export function observeMutations(
  repoPath: string,
  expectedHeadSha: string,
  expectedFiles: Readonly<Record<string, string>>,
): MutationObservation {
  let changedPaths: readonly string[] = []
  let contentDivergedPaths: readonly string[] = []
  let observationError: string | null = null
  let headMoved: string | null = null

  try {
    const status = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    changedPaths = parseStatusPaths(status)
  } catch (error) {
    observationError = addObservationError(observationError, `git status unavailable: ${boundedError(error)}`)
  }

  try {
    const actualHeadSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
    if (actualHeadSha !== expectedHeadSha) {
      headMoved = actualHeadSha
    }
  } catch (error) {
    observationError = addObservationError(observationError, `HEAD unavailable: ${boundedError(error)}`)
  }

  const diverged = new Set<string>()
  for (const [relativePath, expectedContent] of Object.entries(expectedFiles)) {
    try {
      const result = compareDeclaredFile(repoPath, relativePath, expectedContent)
      if (result.diverged) diverged.add(normalizeSafeRelativePath(relativePath))
      if (result.error != null) {
        observationError = addObservationError(observationError, `Declared file unavailable: ${result.error}`)
      }
    } catch (error) {
      observationError = addObservationError(observationError, `Declared path invalid: ${boundedError(error)}`)
    }
  }
  contentDivergedPaths = [...diverged].sort()

  return {changedPaths, contentDivergedPaths, headMoved, observationError}
}

export function validateAllowedMutationPolicy(scenario: Scenario): void {
  if (scenario.mutation.kind === 'forbidden') return

  if (scenario.mutation.changedPaths.length === 0) {
    throw new Error(`Scenario ${scenario.id} mutation changedPaths must not be empty`)
  }
  const changedPaths = scenario.mutation.changedPaths.map(normalizeSafeRelativePath)
  if (new Set(changedPaths).size !== changedPaths.length) {
    throw new Error(`Scenario ${scenario.id} mutation changedPaths contains a duplicate path`)
  }

  for (const changedPath of changedPaths) {
    if (Object.prototype.hasOwnProperty.call(scenario.files, changedPath) === false) {
      throw new Error(`Scenario ${scenario.id} mutation path is not declared in files: ${changedPath}`)
    }
  }

  const verifyTestPath = normalizeSafeRelativePath(scenario.mutation.verifyTestPath)
  if (Object.prototype.hasOwnProperty.call(scenario.files, verifyTestPath) === false) {
    throw new Error(`Scenario ${scenario.id} verification path is not declared in files: ${verifyTestPath}`)
  }
  if (changedPaths.includes(verifyTestPath)) {
    throw new Error(`Scenario ${scenario.id} verifyTestPath must not be in changedPaths`)
  }
}

export function classifyMutations(
  policy: MutationPolicy,
  observation: MutationObservation,
): {readonly forbiddenMutations: readonly string[]; readonly mutation: MutationEvidence | null} {
  const observedPaths = new Set(
    [...observation.changedPaths, ...observation.contentDivergedPaths].map(normalizeSafeRelativePath),
  )
  const forbidden = new Set<string>()

  if (policy.kind === 'forbidden') {
    for (const observedPath of observedPaths) forbidden.add(observedPath)
  } else {
    const allowedPaths = new Set(policy.changedPaths.map(normalizeSafeRelativePath))
    for (const observedPath of observedPaths) {
      if (allowedPaths.has(observedPath) === false) forbidden.add(observedPath)
    }
  }

  if (observation.headMoved != null) forbidden.add(`HEAD moved: ${observation.headMoved}`)
  if (observation.observationError != null) forbidden.add(`Mutation observation error: ${observation.observationError}`)

  if (policy.kind === 'forbidden') {
    return {forbiddenMutations: [...forbidden].sort(), mutation: null}
  }

  const divergedPaths = new Set(observation.contentDivergedPaths.map(normalizeSafeRelativePath))
  const missingRequiredPaths = policy.changedPaths
    .map(normalizeSafeRelativePath)
    .filter(requiredPath => divergedPaths.has(requiredPath) === false)
    .sort()

  return {
    forbiddenMutations: [...forbidden].sort(),
    mutation: {
      missingRequiredPaths,
      verificationRan: false,
      verificationPassed: false,
      verificationDetail: 'Verification was not run',
    },
  }
}

function isNodeExecutable(filePath: string): boolean {
  const basename = path.basename(filePath).toLowerCase()
  return basename === 'node' || basename === 'node.exe'
}

export function resolveNodeBinary(
  execPath: string = process.execPath,
  pathValue: string = process.env.PATH ?? '',
  platform: NodeJS.Platform = process.platform,
): string {
  if (isNodeExecutable(execPath)) return execPath

  const names = platform === 'win32' ? ['node.exe', 'node.cmd', 'node'] : ['node']
  for (const directory of pathValue.split(path.delimiter)) {
    if (directory.length === 0) continue
    for (const name of names) {
      const candidate = path.join(directory, name)
      try {
        fs.accessSync(candidate, fs.constants.X_OK)
        return candidate
      } catch {
        // Continue through PATH without invoking a shell lookup.
      }
    }
  }

  throw new Error('Node executable was not found: process.execPath is not Node and PATH has no executable node')
}

export async function runVerificationTest(
  repoPath: string,
  verifyTestPath: string,
  nodeBinary?: string,
): Promise<{
  readonly verificationRan: boolean
  readonly verificationPassed: boolean
  readonly verificationDetail: string
}> {
  const normalizedPath = normalizeSafeRelativePath(verifyTestPath)
  let executable: string
  try {
    executable = nodeBinary ?? resolveNodeBinary()
  } catch (error) {
    return {
      verificationRan: false,
      verificationPassed: false,
      verificationDetail: boundedError(error),
    }
  }

  return new Promise(resolve => {
    execFile(
      executable,
      ['--test', normalizedPath],
      {cwd: repoPath, timeout: VERIFICATION_TIMEOUT_MS, maxBuffer: 64 * 1024, windowsHide: true},
      error => {
        if (error == null) {
          resolve({verificationRan: true, verificationPassed: true, verificationDetail: 'Verification passed'})
          return
        }

        const code = errorCode(error)
        resolve({
          verificationRan: code !== 'ENOENT',
          verificationPassed: false,
          verificationDetail: code === 'ETIMEDOUT' ? 'Verification timed out after 30000ms' : 'Verification failed',
        })
      },
    )
  })
}
