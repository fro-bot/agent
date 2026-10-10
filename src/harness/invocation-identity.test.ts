import type {TriggerContext} from '@fro-bot/runtime'
import process from 'node:process'
import {buildLogicalKey} from '@fro-bot/runtime'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {buildLogArtifactName} from '../services/artifact/index.js'
import {buildRestoreKeys, buildSaveCacheKey, type CacheKeyComponents} from '../services/cache/cache-key.js'
import {getGitHubRunAttempt, getGitHubRunId, getInvocationIdentity} from '../shared/env.js'

// End-to-end pin of the invocation identity across the three run-scoped surfaces -- cache save key,
// log artifact name, scheduled session key -- using the real env-derived identity, for the incident
// run fro-bot/.github#38026680860 ("Fro Bot -- Remediate" then "Fro Bot -- Observe", `needs:`-chained,
// same cron).
const RUN_ID = '38026680860'
const components: CacheKeyComponents = {
  agentIdentity: 'github',
  repo: 'fro-bot/.github',
  ref: 'main',
  os: 'Linux',
}

function scheduleContext(): TriggerContext {
  return {
    eventType: 'schedule',
    eventName: 'schedule',
    repo: {owner: 'fro-bot', repo: '.github'},
    ref: 'refs/heads/main',
    sha: 'sha',
    runId: Number(RUN_ID),
    actor: 'fro-bot',
    action: '0 6 * * *',
    author: null,
    target: null,
    commentBody: null,
    commentId: null,
    hasMention: false,
    command: null,
    isBotReviewRequested: false,
    raw: {event: {type: 'schedule', schedule: '0 6 * * *'}},
  } as unknown as TriggerContext
}

interface Surfaces {
  readonly saveKey: string
  readonly artifactName: string
  readonly sessionKey: string
}

function surfacesFor(env: {job: string; attempt: string}): Surfaces {
  process.env.GITHUB_JOB = env.job
  process.env.GITHUB_RUN_ID = RUN_ID
  process.env.GITHUB_RUN_ATTEMPT = env.attempt
  const identity = getInvocationIdentity()
  const runId = getGitHubRunId()
  const runAttempt = getGitHubRunAttempt()
  return {
    saveKey: buildSaveCacheKey(components, runId, runAttempt, identity),
    artifactName: buildLogArtifactName(runId, runAttempt, identity),
    sessionKey: buildLogicalKey(scheduleContext(), identity)?.key ?? '<none>',
  }
}

describe('invocation identity across a multi-job run', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = {...originalEnv}
    delete process.env['INPUT_MATRIX-CONTEXT']
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('two jobs in the same run and attempt get distinct cache keys, artifact names, and schedule session keys', () => {
    // #given Remediate and Observe in run 38026680860, attempt 1
    // #when each derives its run-scoped identifiers
    const remediate = surfacesFor({job: 'fro-bot-remediate', attempt: '1'})
    const observe = surfacesFor({job: 'fro-bot-observe', attempt: '1'})

    // #then no surface collides (before: all three were identical across the two jobs)
    expect(observe.saveKey).not.toBe(remediate.saveKey)
    expect(observe.artifactName).not.toBe(remediate.artifactName)
    expect(observe.sessionKey).not.toBe(remediate.sessionKey)
    expect(remediate.saveKey).toBe('opencode-storage-github-fro-bot-.github-main-Linux-38026680860-1-fro-bot-remediate')
    expect(observe.saveKey).toBe('opencode-storage-github-fro-bot-.github-main-Linux-38026680860-1-fro-bot-observe')
    expect(observe.artifactName).toBe('opencode-logs-38026680860-1-fro-bot-observe')
    expect(observe.sessionKey).toMatch(/^schedule-[0-9a-f]{8}-38026680860-fro-bot-observe$/)
  })

  it('re-running the same job (attempt 2): savable key, same session, distinct artifact name', () => {
    // #given the Observe job and its re-run attempt
    const attempt1 = surfacesFor({job: 'fro-bot-observe', attempt: '1'})
    const attempt2 = surfacesFor({job: 'fro-bot-observe', attempt: '2'})

    // #then the re-run gets a fresh, distinct cache key (so its save cannot hit attempt 1's reservation)
    expect(attempt2.saveKey).not.toBe(attempt1.saveKey)
    // ... keeps continuing the same logical session (the key is run-scoped, NOT attempt-scoped) ...
    expect(attempt2.sessionKey).toBe(attempt1.sessionKey)
    // ... and uploads its logs under a distinct artifact name
    expect(attempt2.artifactName).not.toBe(attempt1.artifactName)
  })

  it('a matrix leg is distinguished from its sibling legs on every surface', () => {
    // #given two legs of one job whose matrix context differs (INPUT_MATRIX-CONTEXT = toJSON(matrix))
    process.env['INPUT_MATRIX-CONTEXT'] = '{"task":"remediate"}'
    const legA = surfacesFor({job: 'fro-bot', attempt: '1'})
    process.env['INPUT_MATRIX-CONTEXT'] = '{"task":"observe"}'
    const legB = surfacesFor({job: 'fro-bot', attempt: '1'})

    // #then
    expect(legA.saveKey).not.toBe(legB.saveKey)
    expect(legA.artifactName).not.toBe(legB.artifactName)
    expect(legA.sessionKey).not.toBe(legB.sessionKey)
  })

  it('old-format entries (no identity suffix) remain restorable by prefix', () => {
    // #given the entry Remediate saved before this change, and the restore prefixes a new Observe run uses
    const oldEntry = 'opencode-storage-github-fro-bot-.github-main-Linux-38026680860-1'
    const [refScoped, repoScoped] = buildRestoreKeys(components)

    // #then it still matches both prefixes (restore keys never include the run ID or identity)
    expect(oldEntry.startsWith(refScoped as string)).toBe(true)
    expect(oldEntry.startsWith(repoScoped as string)).toBe(true)
  })
})
