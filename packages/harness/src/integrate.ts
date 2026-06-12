/**
 * Integration engine — orw-embedded LLM merge onto the release tag.
 *
 * Ported from cortexkit/orw src/index.ts check/prep/render/verifyBuild (MIT).
 * Adapted for CI/non-interactive use: no launchd, no desktop, no interactive prompts.
 *
 * The actual opencode run LLM merge is NOT unit-tested here — it requires a live
 * opencode binary + model + network. Unit tests cover the fail-hard/freeze/provenance
 * contract via injected adapters (cloneRepo, fetchRef, runMerge, buildCli, verifyVersion).
 *
 * Fail-hard contract: any failure (merge unresolved, build fail, version mismatch)
 * returns {ok:false, error} and writes NO provenance manifest. The manifest is the
 * single source of truth — it is only written after all steps succeed (freeze).
 */

// IntegrationRefRecord is the canonical type — defined once in provenance.ts.
import type {IntegrationRefRecord} from './provenance.js'
import type {IntegrationSource} from './sources.js'
import {execFile} from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import {promisify} from 'node:util'
import {formatPipelineError} from './format-error.js'
import {resolveSources} from './sources.js'

// Re-export so callers that previously imported from integrate.ts still work.
export type {IntegrationRefRecord} from './provenance.js'

// ---------------------------------------------------------------------------
// Provenance manifest types
// ---------------------------------------------------------------------------

export interface ProvenanceManifest {
  readonly baseVersion: string
  readonly integrationRefs: readonly IntegrationRefRecord[]
  readonly integrationCommit: string
  readonly buildSha: string
}

// ---------------------------------------------------------------------------
// Integration config
// ---------------------------------------------------------------------------

export interface IntegrationConfig {
  readonly baseVersion: string
  readonly releaseRepo: string
  readonly integrationRefs: readonly string[]
  readonly agent: string
  readonly model: string
  readonly opencodeBin: string
  readonly workDir: string
  readonly promptPath: string
}

// ---------------------------------------------------------------------------
// Injectable adapters (dependency injection for testability)
// ---------------------------------------------------------------------------

export interface IntegrationAdapters {
  /** Clone the release repo into workDir. */
  cloneRepo: (repoUrl: string, workDir: string) => Promise<void>
  /** Fetch tags from origin. */
  fetchTags: (workDir: string) => Promise<void>
  /** Fetch a single integration ref into a local tracking ref. */
  fetchRef: (workDir: string, remoteUrl: string, fetchRef: string, localRef: string) => Promise<void>
  /**
   * Capture the resolved upstream SHA of the most recently fetched ref.
   * MUST be called directly after the matching fetchRef and before any further
   * fetch: the real adapter reads FETCH_HEAD, which is overwritten by the next
   * fetch, so reordering or parallelizing the fetch loop would mis-attribute SHAs.
   * Returns null on failure — the caller falls back to integrationCommit for that ref.
   */
  captureRefSha: (workDir: string) => Promise<string | null>
  /** Create/reset the integration branch to the release tag. */
  createBranch: (workDir: string, branch: string, tag: string) => Promise<void>
  /** Run the LLM merge via opencode run. */
  runMerge: (workDir: string, opencodeBin: string, agent: string, model: string, prompt: string) => Promise<void>
  /** Build the native CLI in the work repo. */
  buildCli: (workDir: string, version: string, channel: string) => Promise<void>
  /** Verify the built CLI --version matches the expected version. */
  verifyVersion: (workDir: string, expectedVersion: string) => Promise<void>
  /** Commit the integrated working tree (after LLM merge) so HEAD contains the merge. */
  commitIntegration: (workDir: string, message: string) => Promise<void>
  /** Get the current HEAD commit SHA of the work repo. */
  getCommitSha: (workDir: string) => Promise<string>
}

// ---------------------------------------------------------------------------
// Integration result
// ---------------------------------------------------------------------------

export type IntegrationResult =
  | {readonly ok: true; readonly manifest: ProvenanceManifest}
  | {readonly ok: false; readonly error: string}

// ---------------------------------------------------------------------------
// Provenance manifest I/O (single source of truth)
// ---------------------------------------------------------------------------

const MANIFEST_FILENAME = 'provenance.json'

/**
 * Writes the provenance manifest to the given directory.
 * This is the freeze step — called only after all integration steps succeed.
 */
export async function writeProvenanceManifest(dir: string, manifest: ProvenanceManifest): Promise<void> {
  await fs.mkdir(dir, {recursive: true})
  await fs.writeFile(path.join(dir, MANIFEST_FILENAME), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

/**
 * Type guard: validates that an unknown value has the shape of a ProvenanceManifest.
 * Treats malformed/partial JSON as invalid rather than silently returning partial data.
 */
function isValidProvenanceManifest(value: unknown): value is ProvenanceManifest {
  if (value === null || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (typeof v.baseVersion !== 'string' || v.baseVersion.length === 0) return false
  if (!Array.isArray(v.integrationRefs)) return false
  if (typeof v.integrationCommit !== 'string' || v.integrationCommit.length === 0) return false
  if (typeof v.buildSha !== 'string') return false
  return true
}

/**
 * Reads the provenance manifest from the given directory.
 * Returns null if the manifest does not exist or has an invalid shape.
 * Uses isValidProvenanceManifest to guard against malformed/partial manifests.
 */
export async function readProvenanceManifest(dir: string): Promise<ProvenanceManifest | null> {
  const manifestPath = path.join(dir, MANIFEST_FILENAME)
  try {
    const raw = await fs.readFile(manifestPath, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!isValidProvenanceManifest(parsed)) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Prompt rendering (adapted from orw render())
// ---------------------------------------------------------------------------

function integrationBranch(version: string): string {
  return `integrate/v${version}`
}

async function renderPrompt(
  promptPath: string,
  workDir: string,
  baseVersion: string,
  releaseRepo: string,
  sources: IntegrationSource[],
): Promise<string> {
  const tag = `v${baseVersion}`
  const branch = integrationBranch(baseVersion)
  const channel = 'latest'
  const tpl = await fs.readFile(promptPath, 'utf8')
  const vars: Record<string, string> = {
    repo: workDir,
    tag,
    version: baseVersion,
    channel,
    branches: sources.map(s => s.label).join(', '),
    branch,
    merges: sources.map(s => s.merge).join(', then '),
    sources: sources.map(s => `${s.label} -> ${s.merge}`).join('\n- '),
    release_repo: releaseRepo,
    base: 'dev',
    release_url: `https://github.com/${releaseRepo}/releases/tag/${tag}`,
  }
  return Object.entries(vars).reduce((text, [key, value]) => text.replaceAll(`{{${key}}}`, value), tpl)
}

const execFileAsync = promisify(execFile)

async function gitExec(args: string[], cwd?: string): Promise<string> {
  const {stdout} = await execFileAsync('git', args, {cwd, encoding: 'utf8'})
  return stdout.trim()
}

export function makeRealAdapters(): IntegrationAdapters {
  return {
    cloneRepo: async (repoUrl, workDir) => {
      await fs.rm(workDir, {recursive: true, force: true})
      await fs.mkdir(path.dirname(workDir), {recursive: true})
      await gitExec(['clone', repoUrl, workDir])
    },

    fetchTags: async workDir => {
      await gitExec(['fetch', 'origin', '--tags'], workDir)
    },

    fetchRef: async (workDir, remoteUrl, fetchRef, localRef) => {
      await gitExec(['fetch', remoteUrl, `${fetchRef}:${localRef}`], workDir)
    },

    captureRefSha: async workDir => {
      try {
        return await gitExec(['rev-parse', 'FETCH_HEAD'], workDir)
      } catch {
        return null
      }
    },

    createBranch: async (workDir, branch, tag) => {
      // Reset or create the integration branch at the release tag.
      try {
        await gitExec(['checkout', '-B', branch, `refs/tags/${tag}`], workDir)
      } catch {
        await gitExec(['checkout', '-b', branch, `refs/tags/${tag}`], workDir)
      }
    },

    runMerge: async (workDir, opencodeBin, agent, model, prompt) => {
      // Run opencode run synchronously — do NOT use background:true.
      // Poll to terminal state; the non-interactive tool exits when done.
      await execFileAsync(opencodeBin, ['run', '--agent', agent, '--model', model, prompt], {
        cwd: workDir,
        encoding: 'utf8',
        timeout: 30 * 60 * 1000, // 30-minute hard timeout
      })
    },

    buildCli: async (workDir, version, channel) => {
      await execFileAsync('bun', ['run', 'build', '--', '--single'], {
        cwd: path.join(workDir, 'packages', 'opencode'),
        encoding: 'utf8',
        env: {
          ...process.env,
          OPENCODE_CHANNEL: channel,
          OPENCODE_VERSION: version,
        },
        timeout: 20 * 60 * 1000, // 20-minute hard timeout
      })
    },

    verifyVersion: async (workDir, expectedVersion) => {
      const cliPath = resolveCliPath(workDir)
      const {stdout} = await execFileAsync(cliPath, ['--version'], {
        encoding: 'utf8',
        timeout: 30_000,
      })
      const actual = stdout.trim()
      if (actual !== expectedVersion) {
        throw new Error(`Built CLI reported version ${actual}, expected ${expectedVersion}`)
      }
    },

    commitIntegration: async (workDir, message) => {
      // Stage all changes (new, modified, deleted) from the LLM merge.
      await gitExec(
        [
          '-c',
          'user.name=fro-bot harness integrate',
          '-c',
          'user.email=github-actions[bot]@users.noreply.github.com',
          'add',
          '-A',
        ],
        workDir,
      )
      // Commit with --no-verify to skip any hooks in the cloned upstream repo.
      await gitExec(
        [
          '-c',
          'user.name=fro-bot harness integrate',
          '-c',
          'user.email=github-actions[bot]@users.noreply.github.com',
          'commit',
          '--no-verify',
          '-m',
          message,
        ],
        workDir,
      )
    },

    getCommitSha: async workDir => {
      return gitExec(['rev-parse', 'HEAD'], workDir)
    },
  }
}

function resolveCliPath(workDir: string): string {
  const os = process.platform === 'win32' ? 'windows' : process.platform
  const arch = process.arch
  const name = `opencode-${os}-${arch}`
  const binary = process.platform === 'win32' ? 'opencode.exe' : 'opencode'
  return path.join(workDir, 'packages', 'opencode', 'dist', name, 'bin', binary)
}

// ---------------------------------------------------------------------------
// Core integration orchestration
// ---------------------------------------------------------------------------

/**
 * Runs the full integration pipeline:
 *   clone → fetch tags → fetch refs → create branch → LLM merge → build → verify → freeze
 *
 * On any failure: returns {ok:false, error} and writes NO manifest (fail-hard contract).
 * On success: writes the provenance manifest to workDir and returns {ok:true, manifest}.
 *
 * @param config   - Integration configuration (base version, refs, model, etc.)
 * @param adapters - Injectable adapters for each step (real or stubbed for tests).
 */
export async function runIntegration(
  config: IntegrationConfig,
  adapters: IntegrationAdapters,
): Promise<IntegrationResult> {
  const {baseVersion, releaseRepo, integrationRefs, agent, model, opencodeBin, workDir, promptPath} = config
  const tag = `v${baseVersion}`
  const branch = integrationBranch(baseVersion)
  const channel = 'latest'

  // Resolve sources — wrap in try/catch so invalid refs return {ok:false} instead of throwing.
  let sources: IntegrationSource[]
  try {
    sources = resolveSources(integrationRefs, `https://github.com/${releaseRepo}.git`)
  } catch (error) {
    return {ok: false, error: `Resolve sources failed: ${formatPipelineError(error)}`}
  }

  // Step 1: Clone the release repo.
  try {
    await adapters.cloneRepo(`https://github.com/${releaseRepo}.git`, workDir)
  } catch (error) {
    return {ok: false, error: `Clone failed: ${formatPipelineError(error)}`}
  }

  // Step 2: Fetch tags.
  try {
    await adapters.fetchTags(workDir)
  } catch (error) {
    return {ok: false, error: `Fetch tags failed: ${formatPipelineError(error)}`}
  }

  // Step 3: Fetch each integration ref and capture its resolved upstream SHA.
  // resolvedShas[i] holds the tip SHA for sources[i]; null means capture failed (fallback to integrationCommit).
  const resolvedShas: (string | null)[] = []
  for (const source of sources) {
    try {
      await adapters.fetchRef(workDir, source.repo, source.fetchRef, source.fetch)
    } catch (error) {
      return {ok: false, error: `Fetch ref ${source.label} failed: ${formatPipelineError(error)}`}
    }
    // Capture the resolved SHA immediately after fetch while FETCH_HEAD is fresh.
    // Failure is non-fatal: we fall back to integrationCommit for this ref in the manifest.
    const sha = await adapters.captureRefSha(workDir)
    resolvedShas.push(sha)
  }

  // Step 4: Create/reset the integration branch at the release tag.
  try {
    await adapters.createBranch(workDir, branch, tag)
  } catch (error) {
    return {ok: false, error: `Create branch ${branch} at ${tag} failed: ${formatPipelineError(error)}`}
  }

  // Step 5: Run the LLM merge (only when there are refs to merge).
  if (sources.length > 0) {
    let prompt: string
    try {
      prompt = await renderPrompt(promptPath, workDir, baseVersion, releaseRepo, sources)
    } catch (error) {
      return {ok: false, error: `Render merge prompt failed: ${formatPipelineError(error)}`}
    }

    try {
      await adapters.runMerge(workDir, opencodeBin, agent, model, prompt)
    } catch (error) {
      return {ok: false, error: `LLM merge failed: ${formatPipelineError(error)}`}
    }

    // Step 5.5: Commit the integrated working tree so HEAD contains the merge.
    // Without this, getCommitSha (Step 8) returns the bare tag SHA and
    // git archive would ship the pre-merge tree.
    try {
      await adapters.commitIntegration(workDir, `integrate: apply LLM merge onto v${baseVersion}`)
    } catch (error) {
      return {ok: false, error: `Commit integration failed: ${formatPipelineError(error)}`}
    }

    // Step 6: Build the native CLI.
    try {
      await adapters.buildCli(workDir, baseVersion, channel)
    } catch (error) {
      return {ok: false, error: `Build CLI failed: ${formatPipelineError(error)}`}
    }

    // Step 7: Verify --version matches the base.
    try {
      await adapters.verifyVersion(workDir, baseVersion)
    } catch (error) {
      return {ok: false, error: `Version verification failed: ${formatPipelineError(error)}`}
    }
  }

  // Step 8: Capture the frozen integration commit SHA.
  let integrationCommit: string
  try {
    integrationCommit = await adapters.getCommitSha(workDir)
  } catch (error) {
    return {ok: false, error: `Get commit SHA failed: ${formatPipelineError(error)}`}
  }

  // Step 9: Build the provenance manifest and freeze it.
  // Each ref's resolvedSha is its actual upstream tip captured during the fetch loop.
  // Falls back to integrationCommit only when capture failed for that ref.
  const manifest: ProvenanceManifest = {
    baseVersion,
    integrationRefs: sources.map((s, i) => ({
      ref: integrationRefs[i] ?? s.label,
      resolvedSha:
        resolvedShas[i] !== null && resolvedShas[i] !== undefined && resolvedShas[i].length > 0
          ? resolvedShas[i]
          : integrationCommit,
    })),
    integrationCommit,
    buildSha: 'dev', // replaced by the per-platform build job at publish time
  }

  try {
    await writeProvenanceManifest(workDir, manifest)
  } catch (error) {
    return {ok: false, error: `Write provenance manifest failed: ${formatPipelineError(error)}`}
  }

  return {ok: true, manifest}
}
