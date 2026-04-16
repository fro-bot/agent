import type {EnsureOpenCodeResult} from '../../features/agent/types.js'
import type {Logger} from '../../shared/logger.js'
import type {ActionInputs} from '../../shared/types.js'
import * as core from '@actions/core'
import {ensureOpenCodeAvailable} from '../../features/agent/index.js'
import {createLogger} from '../../shared/logger.js'
import {parseActionInputs} from '../config/inputs.js'
import {STATE_KEYS} from '../config/state-keys.js'

export interface BootstrapPhaseResult {
  readonly inputs: ActionInputs
  readonly logger: Logger
  readonly opencodeResult: EnsureOpenCodeResult
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
    agent: inputs.agent,
    hasModelOverride: inputs.model != null,
    timeoutMs: inputs.timeoutMs,
  })

  const opencodeResult = await ensureOpenCodeAvailable({
    logger,
    opencodeVersion: inputs.opencodeVersion,
    githubToken: inputs.githubToken,
    authJson: inputs.authJson,
    omoVersion: inputs.omoVersion,
    systematicVersion: inputs.systematicVersion,
    omoProviders: inputs.omoProviders,
    opencodeConfig: inputs.opencodeConfig,
    systematicConfig: inputs.systematicConfig,
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
  }
}
