/**
 * Tests for the Discord cancellation-notice dispatcher factory.
 *
 * BDD `// #given/#when/#then` per repo convention.
 */

import type {Client} from 'discord.js'
import type {CancelActorContext} from '../execute/cancel.js'
import type {GatewayLogger} from './client.js'
import {describe, expect, it, vi} from 'vitest'
import {createCancelNoticeDispatcher, formatCancelNotice} from './cancel-notice.js'

type FakeClient = Pick<Client, 'channels'>

const webActor: CancelActorContext = {
  kind: 'web-operator',
  githubUserId: 42,
  login: 'octocat',
  sessionCorrelationId: 'sess-1',
}
const discordActor: CancelActorContext = {kind: 'discord-user', discordUserId: '111222333444555666'}

describe('formatCancelNotice', () => {
  it('names a Discord actor with a user mention', () => {
    // #when / #then
    expect(formatCancelNotice(discordActor)).toBe('Run cancelled by <@111222333444555666>.')
  })

  it('names a web operator by GitHub login, with no Discord mention', () => {
    // #when / #then
    expect(formatCancelNotice(webActor)).toBe('Run cancelled by operator octocat.')
  })
})

function makeLogger(): GatewayLogger {
  return {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
}

function makeClient(sendMock = vi.fn().mockResolvedValue(undefined)): FakeClient {
  const channel = {
    isTextBased: (): boolean => true,
    send: sendMock,
  }
  return {
    channels: {
      fetch: vi.fn().mockResolvedValue(channel),
    } as unknown as FakeClient['channels'],
  }
}

describe('createCancelNoticeDispatcher', () => {
  it('skips (logs) when threadId is empty', async () => {
    // #given
    const client = makeClient()
    const logger = makeLogger()
    const dispatch = createCancelNoticeDispatcher(client, logger)

    // #when
    await dispatch('', 'run-1', webActor)

    // #then

    expect(client.channels.fetch).not.toHaveBeenCalled()
    expect(logger.info).toHaveBeenCalledWith(
      {runId: 'run-1'},
      'cancelRun: no thread_id on run-state — skipping cancellation notice',
    )
  })

  it('sends the cancellation notice for a resolved text-sendable channel', async () => {
    // #given
    const sendMock = vi.fn().mockResolvedValue(undefined)
    const client = makeClient(sendMock)
    const logger = makeLogger()
    const dispatch = createCancelNoticeDispatcher(client, logger)

    // #when
    await dispatch('thread-1', 'run-1', webActor)

    // #then

    expect(client.channels.fetch).toHaveBeenCalledWith('thread-1')
    expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({content: 'Run cancelled by operator octocat.'}))
  })

  it('announces a Discord actor by mention without pinging them', async () => {
    // #given
    const sendMock = vi.fn().mockResolvedValue(undefined)
    const client = makeClient(sendMock)
    const dispatch = createCancelNoticeDispatcher(client, makeLogger())

    // #when
    await dispatch('thread-1', 'run-1', discordActor)

    // #then — mention text present; io.sendMessage always injects allowedMentions {parse: []}
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({content: 'Run cancelled by <@111222333444555666>.', allowedMentions: {parse: []}}),
    )
  })

  it('skips (logs) when the channel cannot be resolved', async () => {
    // #given
    const client = {channels: {fetch: vi.fn().mockResolvedValue(null)}} as unknown as FakeClient
    const logger = makeLogger()
    const dispatch = createCancelNoticeDispatcher(client, logger)

    // #when
    await dispatch('thread-1', 'run-1', webActor)

    // #then
    expect(logger.warn).toHaveBeenCalledWith(
      {runId: 'run-1', threadId: 'thread-1'},
      'cancelRun: thread channel not found — skipping cancellation notice',
    )
  })

  it('skips (logs) when the resolved channel is not text-sendable', async () => {
    // #given
    const channel = {isTextBased: () => false}
    const client = {channels: {fetch: vi.fn().mockResolvedValue(channel)}} as unknown as FakeClient
    const logger = makeLogger()
    const dispatch = createCancelNoticeDispatcher(client, logger)

    // #when
    await dispatch('thread-1', 'run-1', webActor)

    // #then
    expect(logger.warn).toHaveBeenCalledWith(
      {runId: 'run-1', threadId: 'thread-1'},
      'cancelRun: resolved channel is not text-sendable — skipping cancellation notice',
    )
  })

  it('logs (does not throw) when sendMessage returns a failure result', async () => {
    // #given
    const sendMock = vi.fn().mockRejectedValue(new Error('discord send failed'))
    const client = makeClient(sendMock)
    const logger = makeLogger()
    const dispatch = createCancelNoticeDispatcher(client, logger)

    // #when
    await expect(dispatch('thread-1', 'run-1', webActor)).resolves.toBeUndefined()

    // #then — io.ts's sendMessage catches the throw and returns err(...); logged, not thrown
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({runId: 'run-1', threadId: 'thread-1'}),
      'cancelRun: cancellation notice send failed',
    )
  })

  it('logs (does not throw) when channels.fetch itself throws', async () => {
    // #given
    const client = {
      channels: {fetch: vi.fn().mockRejectedValue(new Error('discord unreachable'))},
    } as unknown as FakeClient
    const logger = makeLogger()
    const dispatch = createCancelNoticeDispatcher(client, logger)

    // #when
    await expect(dispatch('thread-1', 'run-1', webActor)).resolves.toBeUndefined()

    // #then
    expect(logger.warn).toHaveBeenCalledWith(
      {runId: 'run-1', threadId: 'thread-1', err: 'discord unreachable'},
      'cancelRun: cancellation notice threw — continuing',
    )
  })
})
