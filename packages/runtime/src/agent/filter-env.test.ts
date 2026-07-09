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
      FOO_APIKEY: 'x',
      FOO_PASSWORD: 'x',
      FOO_PASSWD: 'x',
      FOO_CREDENTIALS: 'x',
      FOO_CREDENTIAL: 'x',
    }

    // #when
    const result = filterAgentEnv(env)

    // #then
    expect(result).toEqual({})
  })

  it('retains proxy and CA-bundle vars for egress/TLS (regression guard)', () => {
    // #given
    const env = {
      HTTP_PROXY: 'http://proxy.example.com:8080',
      HTTPS_PROXY: 'http://proxy.example.com:8080',
      NO_PROXY: 'localhost,127.0.0.1',
      https_proxy: 'http://proxy.example.com:8080',
      GIT_SSL_CAINFO: '/etc/ssl/certs/ca-bundle.crt',
    }

    // #when
    const result = filterAgentEnv(env)

    // #then
    expect(result).toEqual(env)
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

  it('retains GH_CONFIG_DIR (load-bearing: off-env gh auth relies on this reaching the child)', () => {
    // #given
    const env = {GH_CONFIG_DIR: '/tmp/gh-config-xyz', PATH: '/usr/bin'}

    // #when
    const result = filterAgentEnv(env)

    // #then
    expect(result).toEqual(env)
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
