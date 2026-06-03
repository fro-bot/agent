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

import type {IntegrationSource} from './sources.js'
import {execFile} from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import {promisify} from 'node:util'
import {resolveSources} from './sources.js'

// ---------------------------------------------------------------------------
// Provenance manifest types
// ---------------------------------------------------------------------------

export interface IntegrationRefRecord {
  readonly ref: string
  readonly resolvedSha: string
  readonly reason?: string
  readonly upstreamStatus?: string
}

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
  /** Create/reset the integration branch to the release tag. */
  createBranch: (workDir: string, branch: string, tag: string) => Promise<void>
  /** Run the LLM merge via opencode run. */
  runMerge: (workDir: string, opencodeBin: string, agent: string, model: string, prompt: string) => Promise<void>
  /** Build the native CLI in the work repo. */
  buildCli: (workDir: string, version: string, channel: string) => Promise<void>
  /** Verify the built CLI --version matches the expected version. */
  verifyVersion: (workDir: string, expectedVersion: string) => Promise<void>
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
 * Reads the provenance manifest from the given directory.
 * Returns null if the manifest does not exist.
 */
export async function readProvenanceManifest(dir: string): Promise<ProvenanceManifest | null> {
  const manifestPath = path.join(dir, MANIFEST_FILENAME)
  try {
    const raw = await fs.readFile(manifestPath, 'utf8')
    return JSON.parse(raw) as ProvenanceManifest
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

  const sources = resolveSources(integrationRefs, `https://github.com/${releaseRepo}.git`)

  // Step 1: Clone the release repo.
  try {
    await adapters.cloneRepo(`https://github.com/${releaseRepo}.git`, workDir)
  } catch (error) {
    return {ok: false, error: `Clone failed: ${errorMessage(error)}`}
  }

  // Step 2: Fetch tags.
  try {
    await adapters.fetchTags(workDir)
  } catch (error) {
    return {ok: false, error: `Fetch tags failed: ${errorMessage(error)}`}
  }

  // Step 3: Fetch each integration ref.
  for (const source of sources) {
    try {
      await adapters.fetchRef(workDir, source.repo, source.fetchRef, source.fetch)
    } catch (error) {
      return {ok: false, error: `Fetch ref ${source.label} failed: ${errorMessage(error)}`}
    }
  }

  // Step 4: Create/reset the integration branch at the release tag.
  try {
    await adapters.createBranch(workDir, branch, tag)
  } catch (error) {
    return {ok: false, error: `Create branch ${branch} at ${tag} failed: ${errorMessage(error)}`}
  }

  // Step 5: Run the LLM merge (only when there are refs to merge).
  if (sources.length > 0) {
    let prompt: string
    try {
      prompt = await renderPrompt(promptPath, workDir, baseVersion, releaseRepo, sources)
    } catch (error) {
      return {ok: false, error: `Render merge prompt failed: ${errorMessage(error)}`}
    }

    try {
      await adapters.runMerge(workDir, opencodeBin, agent, model, prompt)
    } catch (error) {
      return {ok: false, error: `LLM merge failed: ${errorMessage(error)}`}
    }

    // Step 6: Build the native CLI.
    try {
      await adapters.buildCli(workDir, baseVersion, channel)
    } catch (error) {
      return {ok: false, error: `Build CLI failed: ${errorMessage(error)}`}
    }

    // Step 7: Verify --version matches the base.
    try {
      await adapters.verifyVersion(workDir, baseVersion)
    } catch (error) {
      return {ok: false, error: `Version verification failed: ${errorMessage(error)}`}
    }
  }

  // Step 8: Capture the frozen integration commit SHA.
  let integrationCommit: string
  try {
    integrationCommit = await adapters.getCommitSha(workDir)
  } catch (error) {
    return {ok: false, error: `Get commit SHA failed: ${errorMessage(error)}`}
  }

  // Step 9: Build the provenance manifest and freeze it.
  const manifest: ProvenanceManifest = {
    baseVersion,
    integrationRefs: sources.map((s, i) => ({
      ref: integrationRefs[i] ?? s.label,
      resolvedSha: integrationCommit, // per-ref SHA resolution is a Unit 3 enhancement
    })),
    integrationCommit,
    buildSha: 'dev', // replaced by the per-platform build job in Unit 3
  }

  try {
    await writeProvenanceManifest(workDir, manifest)
  } catch (error) {
    return {ok: false, error: `Write provenance manifest failed: ${errorMessage(error)}`}
  }

  return {ok: true, manifest}
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
