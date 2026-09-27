/**
 * Unit-level shape assertions for `buildNetworkGitProfile` and `buildLocalUpdateGitProfile`
 * (git-safety.ts, Unit 3) that don't need a real git subprocess to verify. The adversarial
 * real-git behavior these two builders are actually protecting against is covered by
 * `update-fixtures/transport.test.ts` and `update-fixtures/filters-hooks.test.ts` — this file
 * only pins down structural details those fixtures don't directly assert on: exact env-var
 * propagation rules, that the token never lands in argv, and the identity a profile carries.
 */

import {describe, expect, it} from 'vitest'
import {buildLocalUpdateGitProfile, buildNetworkGitProfile} from './git-safety.js'
import {AGENT_GID, AGENT_UID} from './identity.js'

describe('buildNetworkGitProfile', () => {
  const baseOptions = {
    bareRepoPath: '/workspace/repos/.workspace-agent/fetch/owner__repo.git',
    serviceHome: '/root',
    askpassPath: '/tmp/askpass.sh',
    token: 'ghs_super-secret-token',
    parentEnv: {} as NodeJS.ProcessEnv,
  }

  it('never places the token in argv', () => {
    const profile = buildNetworkGitProfile(baseOptions)
    expect(profile.args.some(arg => arg.includes(baseOptions.token))).toBe(false)
    expect(profile.env.GITHUB_TOKEN).toBe(baseOptions.token)
  })

  it('sets cwd to serviceHome and --git-dir to bareRepoPath, never a checkout path', () => {
    const profile = buildNetworkGitProfile(baseOptions)
    expect(profile.cwd).toBe(baseOptions.serviceHome)
    const gitDirIndex = profile.args.indexOf('--git-dir')
    expect(gitDirIndex).toBeGreaterThanOrEqual(0)
    expect(profile.args[gitDirIndex + 1]).toBe(baseOptions.bareRepoPath)
  })

  it('carries no uid/gid override (runs as the caller\u2019s own root identity)', () => {
    const profile = buildNetworkGitProfile(baseOptions)
    expect(profile.uid).toBeUndefined()
    expect(profile.gid).toBeUndefined()
  })

  it('omits GIT_SSL_CAINFO and every proxy var when neither is given', () => {
    const profile = buildNetworkGitProfile(baseOptions)
    expect(profile.env.GIT_SSL_CAINFO).toBeUndefined()
    for (const key of ['HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy']) {
      expect(profile.env[key]).toBeUndefined()
    }
  })

  it('sets GIT_SSL_CAINFO from caBundlePath when given', () => {
    const profile = buildNetworkGitProfile({...baseOptions, caBundlePath: '/etc/ssl/certs/ca.pem'})
    expect(profile.env.GIT_SSL_CAINFO).toBe('/etc/ssl/certs/ca.pem')
  })

  it('sets both HTTPS_PROXY and https_proxy from the explicit proxy option, and nothing for NO_PROXY when omitted', () => {
    const profile = buildNetworkGitProfile({...baseOptions, proxy: {https: 'http://proxy.internal:3128'}})
    expect(profile.env.HTTPS_PROXY).toBe('http://proxy.internal:3128')
    expect(profile.env.https_proxy).toBe('http://proxy.internal:3128')
    expect(profile.env.NO_PROXY).toBeUndefined()
    expect(profile.env.no_proxy).toBeUndefined()
  })

  it('sets both NO_PROXY and no_proxy when noProxy is given alongside https', () => {
    const profile = buildNetworkGitProfile({
      ...baseOptions,
      proxy: {https: 'http://proxy.internal:3128', noProxy: '10.0.0.0/8'},
    })
    expect(profile.env.NO_PROXY).toBe('10.0.0.0/8')
    expect(profile.env.no_proxy).toBe('10.0.0.0/8')
  })

  it('never derives PATH, HOME, or GIT_CONFIG_* from parentEnv, even when parentEnv is contaminated', () => {
    const hostileParentEnv: NodeJS.ProcessEnv = {
      PATH: '/tmp/evil-bin',
      HOME: '/tmp/evil-home',
      GIT_CONFIG_GLOBAL: '/tmp/evil.gitconfig',
      GIT_CONFIG_NOSYSTEM: '0',
      GIT_SSH_COMMAND: '/tmp/evil-ssh',
      GIT_PROXY_COMMAND: '/tmp/evil-proxy',
      GIT_SSL_NO_VERIFY: 'true',
      HTTPS_PROXY: 'http://evil-proxy:1',
      GIT_ASKPASS: '/tmp/evil-askpass',
    }
    const profile = buildNetworkGitProfile({...baseOptions, parentEnv: hostileParentEnv})
    expect(profile.env.PATH).not.toBe('/tmp/evil-bin')
    expect(profile.env.HOME).toBe(baseOptions.serviceHome)
    expect(profile.env.GIT_CONFIG_GLOBAL).toBe('/dev/null')
    expect(profile.env.GIT_CONFIG_NOSYSTEM).toBe('1')
    expect(profile.env.GIT_SSH_COMMAND).toBeUndefined()
    expect(profile.env.GIT_PROXY_COMMAND).toBeUndefined()
    expect(profile.env.GIT_SSL_NO_VERIFY).toBeUndefined()
    expect(profile.env.HTTPS_PROXY).toBeUndefined()
    expect(profile.env.GIT_ASKPASS).toBe(baseOptions.askpassPath)
  })

  it('forces GIT_ALLOW_PROTOCOL=https, GIT_TERMINAL_PROMPT=0, redirects off, hooks off, and credential helper cleared', () => {
    const profile = buildNetworkGitProfile(baseOptions)
    expect(profile.env.GIT_ALLOW_PROTOCOL).toBe('https')
    expect(profile.env.GIT_TERMINAL_PROMPT).toBe('0')
    expect(profile.args).toContain('-c')
    expect(profile.args).toEqual(
      expect.arrayContaining(['-c', 'http.followRedirects=false', 'core.hooksPath=/dev/null', 'credential.helper=']),
    )
  })
})

describe('buildLocalUpdateGitProfile', () => {
  const checkoutPath = '/workspace/repos/owner/repo'

  it('runs as AGENT_UID/AGENT_GID (uid 10001), in the checkout', () => {
    const profile = buildLocalUpdateGitProfile({checkoutPath})
    expect(profile.uid).toBe(AGENT_UID)
    expect(profile.gid).toBe(AGENT_GID)
    expect(profile.cwd).toBe(checkoutPath)
  })

  it('sets an empty GIT_ALLOW_PROTOCOL, disables replace refs, and disables lazy fetch', () => {
    const profile = buildLocalUpdateGitProfile({checkoutPath})
    expect(profile.env.GIT_ALLOW_PROTOCOL).toBe('')
    expect(profile.env.GIT_NO_REPLACE_OBJECTS).toBe('1')
    expect(profile.env.GIT_NO_LAZY_FETCH).toBe('1')
  })

  it('carries no askpass or proxy environment variable at all', () => {
    const profile = buildLocalUpdateGitProfile({checkoutPath})
    expect(profile.env.GIT_ASKPASS).toBeUndefined()
    for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY']) {
      expect(profile.env[key]).toBeUndefined()
    }
  })

  it('forces the attributes file, sparse checkout, and submodule recursion off via -c overrides', () => {
    const profile = buildLocalUpdateGitProfile({checkoutPath})
    expect(profile.args).toEqual(
      expect.arrayContaining([
        '-c',
        'core.attributesFile=/dev/null',
        'core.sparseCheckout=false',
        'submodule.recurse=false',
      ]),
    )
  })

  it('reuses the shared hooks/fsmonitor/credential-helper safety args and exact safe.directory grant', () => {
    const profile = buildLocalUpdateGitProfile({checkoutPath})
    expect(profile.args).toEqual(
      expect.arrayContaining(['-c', 'core.fsmonitor=false', 'core.hooksPath=/dev/null', 'credential.helper=']),
    )
    const safeDirIndex = profile.args.lastIndexOf('safe.directory=')
    expect(safeDirIndex).toBeGreaterThanOrEqual(0)
    // The grant entry immediately follows the reset entry, and grants EXACTLY the checkout path —
    // never `*` and never a parent path.
    expect(profile.args[safeDirIndex + 2]).toBe(`safe.directory=${checkoutPath}`)
  })
})
