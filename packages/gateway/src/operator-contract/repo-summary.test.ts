/**
 * Tests for the RepoSummary DTO and its pure builder from a RepoBinding.
 */

import type {RepoBinding} from '../bindings/types.js'
import {describe, expect, it} from 'vitest'
import {toRepoSummary} from './repo-summary.js'

describe('toRepoSummary', () => {
  it('copies owner and repo from the binding', () => {
    // #given a binding with owner and repo
    const binding: RepoBinding = {
      owner: 'acme',
      repo: 'widget',
      channelId: 'chan-123',
      channelName: 'widget-releases',
      workspacePath: '/workspace/widget',
      createdAt: '2024-01-01T00:00:00Z',
      createdByDiscordId: '999888777',
      databaseId: 42,
      nodeId: 'R_kgDOABC123',
    }

    // #when projecting to RepoSummary
    const summary = toRepoSummary(binding)

    // #then only owner and repo are present
    expect(summary.owner).toBe('acme')
    expect(summary.repo).toBe('widget')
  })

  it('copies channelName as the optional display field', () => {
    // #given a binding with a channelName
    const binding: RepoBinding = {
      owner: 'acme',
      repo: 'widget',
      channelId: 'chan-123',
      channelName: 'widget-releases',
      workspacePath: '/workspace/widget',
      createdAt: '2024-01-01T00:00:00Z',
      createdByDiscordId: '999888777',
    }

    // #when projecting
    const summary = toRepoSummary(binding)

    // #then channelName is present
    expect(summary.channelName).toBe('widget-releases')
  })

  it('omits channelName when the binding channelName is empty string', () => {
    // #given a binding with an empty channelName
    const binding: RepoBinding = {
      owner: 'acme',
      repo: 'widget',
      channelId: 'chan-123',
      channelName: '',
      workspacePath: '/workspace/widget',
      createdAt: '2024-01-01T00:00:00Z',
      createdByDiscordId: '999888777',
    }

    // #when projecting
    const summary = toRepoSummary(binding)

    // #then channelName is absent (undefined)
    expect(summary.channelName).toBeUndefined()
  })

  it('never exposes deny-keys, workspacePath, channelId, createdByDiscordId, or createdAt', () => {
    // #given a fully-populated binding
    const binding: RepoBinding = {
      owner: 'acme',
      repo: 'widget',
      channelId: 'chan-123',
      channelName: 'widget-releases',
      workspacePath: '/workspace/widget',
      createdAt: '2024-01-01T00:00:00Z',
      createdByDiscordId: '999888777',
      databaseId: 42,
      nodeId: 'R_kgDOABC123',
    }

    // #when projecting
    const summary = toRepoSummary(binding)

    // #then the serialized shape contains ONLY the safe fields
    const serialized = JSON.parse(JSON.stringify(summary)) as Record<string, unknown>
    const allowedKeys = new Set(['owner', 'repo', 'channelName'])
    const forbiddenKeys = Object.keys(serialized).filter(k => !allowedKeys.has(k))
    expect(forbiddenKeys).toEqual([])

    // Explicitly assert the deny-keys and internal fields are absent
    expect('databaseId' in summary).toBe(false)
    expect('nodeId' in summary).toBe(false)
    expect('channelId' in summary).toBe(false)
    expect('workspacePath' in summary).toBe(false)
    expect('createdByDiscordId' in summary).toBe(false)
    expect('createdAt' in summary).toBe(false)
  })

  it('does not spread the binding — only copies declared fields', () => {
    // #given a binding with extra fields (simulating future schema additions)
    const binding = {
      owner: 'acme',
      repo: 'widget',
      channelId: 'chan-123',
      channelName: 'widget-releases',
      workspacePath: '/workspace/widget',
      createdAt: '2024-01-01T00:00:00Z',
      createdByDiscordId: '999888777',
      databaseId: 42,
      nodeId: 'R_kgDOABC123',
      // Hypothetical future field — must not leak
      internalSecret: 'should-not-appear',
    } as unknown as RepoBinding

    // #when projecting
    const summary = toRepoSummary(binding)

    // #then the extra field is absent
    expect('internalSecret' in summary).toBe(false)
  })
})
