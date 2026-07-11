import type {ResponseDelivery} from '@fro-bot/runtime'
import type {EnsureOpenCodeResult} from '../../features/agent/types.js'
import type {Logger} from '../../shared/logger.js'
import type {ActionInputs} from '../../shared/types.js'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs/promises'
import process from 'node:process'
import * as core from '@actions/core'
import * as github from '@actions/github'
import {buildResponseFileDir, buildResponseFilePath, resolveResponseDelivery} from '@fro-bot/runtime'
import {ensureOpenCodeAvailable} from '../../features/agent/index.js'
import {DEFAULT_OMO_SLIM_VERSION} from '../../shared/constants.js'
import {getGitHubRunAttempt, getGitHubRunId} from '../../shared/env.js'
import {createLogger} from '../../shared/logger.js'
import {parseActionInputs} from '../config/inputs.js'
import {STATE_KEYS} from '../config/state-keys.js'

export interface BootstrapPhaseResult {
  readonly inputs: ActionInputs
  readonly logger: Logger
  readonly opencodeResult: EnsureOpenCodeResult
  /**
   * The two-axis response-delivery classification for this run's event,
   * resolved once here from the raw `eventName` (see `resolveResponseDelivery`).
   * Threaded to the prompt builder (which posting instructions the model sees)
   * and to the finalize phase (whether to read `responseFilePath` and post on
   * the model's behalf). Routing later asserts its own event classification
   * agrees with this value and fails loudly on divergence.
   */
  readonly delivery: ResponseDelivery
  /**
   * The exact run+attempt+nonce scoped path (outside the checkout, under
   * `RUNNER_TEMP`) the model must write its response to, generated once here
   * and shared verbatim with the prompt and the finalize reader. Non-null iff
   * `delivery === 'file-convention'`. The run-scoped directory is created (and
   * asserted not to already contain this nonce file) before the model ever
   * runs, closing the workspace-preseed and stale-file-replay attacks.
   */
  readonly responseFilePath: string | null
}

export async function runBootstrap(bootstrapLogger: Logger): Promise<BootstrapPhaseResult | null> {
  const inputsResult = parseActionInputs()

  if (!inputsResult.success) {
    core.setFailed(`Invalid inputs: ${inputsResult.error.message}`)
    return null
  }

  const inputs = inputsResult.data
  const logger = createLogger({phase: 'main'})

  logger.info('Action inputs parsed', {
    sessionRetention: inputs.sessionRetention,
    s3Backup: inputs.storeConfig.enabled,
    hasGithubToken: inputs.githubToken.length > 0,
    hasPrompt: inputs.prompt != null,
    outputMode: inputs.outputMode,
    agent: inputs.agent,
    hasModelOverride: inputs.model != null,
    timeoutMs: inputs.timeoutMs,
  })

  // Resolved once, from the raw event name, before setup runs any credential
  // provisioning — routing later asserts its own classification agrees.
  const {credential, delivery} = resolveResponseDelivery(github.context.eventName, inputs.responseMode)

  const responseFilePath = await resolveResponseFilePath(delivery, logger)

  const opencodeResult = await ensureOpenCodeAvailable({
    logger,
    opencodeVersion: inputs.opencodeVersion,
    githubToken: inputs.githubToken,
    authJson: inputs.authJson,
    enableOmo: inputs.enableOmo,
    omoVersion: inputs.omoVersion,
    systematicVersion: inputs.systematicVersion,
    omoProviders: inputs.omoProviders,
    opencodeConfig: inputs.opencodeConfig,
    systematicConfig: inputs.systematicConfig,
    enableOmoSlim: inputs.enableOmoSlim,
    omoSlimVersion: DEFAULT_OMO_SLIM_VERSION,
    omoSlimPreset: inputs.omoSlimPreset,
    credential,
  })

  if (opencodeResult.didSetup) {
    logger.info('OpenCode auto-setup completed', {version: opencodeResult.version})
  } else {
    logger.info('OpenCode already available', {version: opencodeResult.version})
  }

  core.saveState(STATE_KEYS.OPENCODE_VERSION, opencodeResult.version)
  core.saveState(STATE_KEYS.S3_ENABLED, String(inputs.storeConfig.enabled))
  core.saveState(STATE_KEYS.S3_BUCKET, inputs.storeConfig.bucket)
  core.saveState(STATE_KEYS.S3_REGION, inputs.storeConfig.region)
  core.saveState(STATE_KEYS.S3_PREFIX, inputs.storeConfig.prefix)
  core.saveState(STATE_KEYS.S3_ENDPOINT, inputs.storeConfig.endpoint ?? '')
  core.saveState(STATE_KEYS.S3_EXPECTED_BUCKET_OWNER, inputs.storeConfig.expectedBucketOwner ?? '')
  core.saveState(STATE_KEYS.S3_ALLOW_INSECURE_ENDPOINT, String(inputs.storeConfig.allowInsecureEndpoint === true))
  core.saveState(STATE_KEYS.S3_SSE_ENCRYPTION, inputs.storeConfig.sseEncryption ?? '')
  core.saveState(STATE_KEYS.S3_SSE_KMS_KEY_ID, inputs.storeConfig.sseKmsKeyId ?? '')
  bootstrapLogger.debug('Bootstrap phase completed', {opencodeVersion: opencodeResult.version})

  return {
    inputs,
    logger,
    opencodeResult,
    delivery,
    responseFilePath,
  }
}

/**
 * For `file-convention` delivery, generates a nonce, builds the run-scoped
 * response-file path/dir (outside the checkout, under `RUNNER_TEMP`), and
 * creates the directory. Asserts the nonce file does not already exist —
 * defense-in-depth against a preexisting file even though `RUNNER_TEMP` is
 * outside the checkout and therefore not attacker-controlled. Returns `null`
 * for every other delivery mode.
 */
async function resolveResponseFilePath(delivery: ResponseDelivery, logger: Logger): Promise<string | null> {
  if (delivery !== 'file-convention') {
    return null
  }

  const runnerTemp = process.env.RUNNER_TEMP
  if (runnerTemp == null || runnerTemp.trim().length === 0) {
    throw new Error('RUNNER_TEMP is required for file-convention response delivery but was not set')
  }

  const runId = getGitHubRunId()
  const runAttempt = getGitHubRunAttempt()
  const nonce = crypto.randomUUID()

  const dir = buildResponseFileDir({runnerTemp, runId, runAttempt})
  const filePath = buildResponseFilePath({runnerTemp, runId, runAttempt, nonce})

  await fs.mkdir(dir, {recursive: true})

  const alreadyExists = await fs
    .access(filePath)
    .then(() => true)
    .catch(() => false)
  if (alreadyExists) {
    throw new Error(`Response file already exists before execution (preseed guard tripped): ${filePath}`)
  }

  logger.debug('Resolved response file path', {path: filePath})
  return filePath
}
