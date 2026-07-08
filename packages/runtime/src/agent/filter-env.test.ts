import {describe, expect, it} from 'vitest'
import {filterAgentEnv} from './filter-env.js'

describe('filterAgentEnv', () => {
  it('retains allowlisted keys unchanged', () => {
    // #given
    const env = {
      PATH: '/usr/bin',
      OPENCODE_CONFIG_CONTENT: '{}',
      GITHUB_REPOSITORY: 'fro-bot/agent',
    }

    // #when
    const result = filterAgentEnv(env)

    // #then
    expect(result).toEqual(env)
  })

  it('drops GITHUB_TOKEN and GH_TOKEN', () => {
    // #given
    const env = {GITHUB_TOKEN: 'ghs_secret', GH_TOKEN: 'ghp_secret', PATH: '/usr/bin'}

    // #when
    const result = filterAgentEnv(env)

    // #then
    expect(result).toEqual({PATH: '/usr/bin'})
  })

  it('drops GITHUB_APP_PRIVATE_KEY and GITHUB_OAUTH_TOKEN (no broad GITHUB_ prefix)', () => {
    // #given
    const env = {
      GITHUB_APP_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----',
      GITHUB_OAUTH_TOKEN: 'oauth-secret',
      GITHUB_REPOSITORY: 'fro-bot/agent',
    }

    // #when
    const result = filterAgentEnv(env)

    // #then
    expect(result).toEqual({GITHUB_REPOSITORY: 'fro-bot/agent'})
  })

  it('drops arbitrary secret-shaped vars', () => {
    // #given
    const env = {
      FOO_TOKEN: 'x',
      FOO_API_KEY: 'x',
      FOO_SECRET: 'x',
      AWS_SECRET_ACCESS_KEY: 'x',
      'INPUT_AUTH-JSON': 'x',
      'INPUT_GITHUB-TOKEN': 'x',
    }

    // #when
    const result = filterAgentEnv(env)

    // #then
    expect(result).toEqual({})
  })

  it('retains allowed-prefix keys', () => {
    // #given
    const env = {
      OPENCODE_CONFIG_CONTENT: '{}',
      RUNNER_TEMP: '/tmp/runner',
      XDG_DATA_HOME: '/home/user/.local/share',
    }

    // #when
    const result = filterAgentEnv(env)

    // #then
    expect(result).toEqual(env)
  })

  it('drops an allow-prefix key that hits the deny-set (deny overrides allow)', () => {
    // #given
    const env = {OPENCODE_API_KEY: 'secret', OPENCODE_CONFIG_CONTENT: '{}'}

    // #when
    const result = filterAgentEnv(env)

    // #then
    expect(result).toEqual({OPENCODE_CONFIG_CONTENT: '{}'})
  })

  it('returns an empty object for an empty env', () => {
    // #given
    const env = {}

    // #when
    const result = filterAgentEnv(env)

    // #then
    expect(result).toEqual({})
  })

  it('omits keys with undefined values without throwing', () => {
    // #given
    const env = {PATH: '/usr/bin', HOME: undefined}

    // #when
    const result = filterAgentEnv(env)

    // #then
    expect(result).toEqual({PATH: '/usr/bin'})
  })

  it('does not mutate the input object', () => {
    // #given
    const env = {GITHUB_TOKEN: 'ghs_secret', PATH: '/usr/bin'}
    const envSnapshot = {...env}

    // #when
    filterAgentEnv(env)

    // #then
    expect(env).toEqual(envSnapshot)
  })

  it('drops a newly-invented credential-shaped var (fail-safe default)', () => {
    // #given
    const env = {SOME_NEW_CREDENTIAL: 'secret-value'}

    // #when
    const result = filterAgentEnv(env)

    // #then
    expect(result).toEqual({})
  })
})
