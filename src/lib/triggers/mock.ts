import type {GitHubContext} from '../github/types.js'
import type {Logger} from '../logger.js'
import process from 'node:process'
import {toErrorMessage} from '../../utils/errors.js'
import {classifyEventType, normalizeEvent} from '../github/context.js'

export interface MockEventConfig {
  readonly enabled: boolean
  readonly token: string | null
  readonly context: GitHubContext | null
}

export function isMockEventEnabled(): boolean {
  const mockEvent = process.env.MOCK_EVENT
  return mockEvent != null && mockEvent !== ''
}

export function isInCI(): boolean {
  return process.env.CI === 'true'
}

export function getMockToken(): string | null {
  const token = process.env.MOCK_TOKEN
  if (token == null || token.length === 0) {
    return null
  }
  return token
}

export function parseMockEvent(logger: Logger): GitHubContext | null {
  const mockEventJson = process.env.MOCK_EVENT
  if (mockEventJson == null || mockEventJson.length === 0) {
    return null
  }

  try {
    const parsed = JSON.parse(mockEventJson) as unknown

    if (typeof parsed !== 'object' || parsed == null) {
      logger.warning('MOCK_EVENT is not a valid object')
      return null
    }

    const ctx = parsed as Record<string, unknown>

    if (typeof ctx.eventName !== 'string') {
      logger.warning('MOCK_EVENT missing eventName')
      return null
    }

    const eventName = ctx.eventName
    const eventType = classifyEventType(eventName)
    const payload = ctx.payload ?? {}
    const event = normalizeEvent(eventType, payload)

    return {
      eventName,
      eventType,
      repo: {
        owner: typeof ctx.owner === 'string' ? ctx.owner : 'mock-owner',
        repo: typeof ctx.repo === 'string' ? ctx.repo : 'mock-repo',
      },
      ref: typeof ctx.ref === 'string' ? ctx.ref : 'refs/heads/main',
      sha: typeof ctx.sha === 'string' ? ctx.sha : 'mock-sha',
      runId: typeof ctx.runId === 'number' ? ctx.runId : 0,
      actor: typeof ctx.actor === 'string' ? ctx.actor : 'mock-actor',
      payload,
      event,
    }
  } catch (error) {
    logger.warning('Failed to parse MOCK_EVENT', {error: toErrorMessage(error)})
    return null
  }
}

export function getMockEventConfig(logger: Logger): MockEventConfig {
  if (!isMockEventEnabled()) {
    return {enabled: false, token: null, context: null}
  }

  if (isInCI()) {
    logger.debug('MOCK_EVENT ignored in CI environment (local testing only)')
    return {enabled: false, token: null, context: null}
  }

  const context = parseMockEvent(logger)
  if (context == null) {
    return {enabled: false, token: null, context: null}
  }

  const token = getMockToken()

  logger.info('Mock event enabled', {
    eventName: context.eventName,
    hasToken: token != null,
  })

  return {enabled: true, token, context}
}
