import {describe, expect, it} from 'vitest'
import {FORMAT_ERROR_MAX_LENGTH, formatPipelineError, redactSecrets} from './format-error.js'

// ---------------------------------------------------------------------------
// redactSecrets
// ---------------------------------------------------------------------------

describe('redactSecrets', () => {
  it('redacts ghp_ token shape', () => {
    // #given
    const input = 'Authorization: ghp_abc123XYZsomeLongToken'

    // #when
    const result = redactSecrets(input)

    // #then
    expect(result).not.toContain('ghp_abc123XYZsomeLongToken')
    expect(result).toContain('[REDACTED]')
  })

  it('redacts gho_ token shape', () => {
    // #given
    const input = 'token=gho_secretOAuthToken99'

    // #when
    const result = redactSecrets(input)

    // #then
    expect(result).not.toContain('gho_secretOAuthToken99')
    expect(result).toContain('[REDACTED]')
  })

  it('redacts ghu_ token shape', () => {
    // #given
    const input = 'Bearer ghu_userAccessToken42'

    // #when
    const result = redactSecrets(input)

    // #then
    expect(result).not.toContain('ghu_userAccessToken42')
    expect(result).toContain('[REDACTED]')
  })

  it('redacts ghs_ token shape', () => {
    // #given
    const input = 'GITHUB_TOKEN=ghs_serverToServerToken77'

    // #when
    const result = redactSecrets(input)

    // #then
    expect(result).not.toContain('ghs_serverToServerToken77')
    expect(result).toContain('[REDACTED]')
  })

  it('redacts github_pat_ token shape', () => {
    // #given
    const input = 'pat=github_pat_11ABCDEF_longPersonalAccessToken'

    // #when
    const result = redactSecrets(input)

    // #then
    expect(result).not.toContain('github_pat_11ABCDEF_longPersonalAccessToken')
    expect(result).toContain('[REDACTED]')
  })

  it('redacts https://user:secret@host URL credentials', () => {
    // #given
    const input = 'Clone failed: https://myuser:supersecret@github.com/org/repo.git'

    // #when
    const result = redactSecrets(input)

    // #then
    expect(result).not.toContain('supersecret')
    expect(result).toContain('[REDACTED]@github.com')
  })

  it('redacts git:// URL credentials', () => {
    // #given
    const input = 'remote: git://user:pass@host.example.com/repo'

    // #when
    const result = redactSecrets(input)

    // #then
    expect(result).not.toContain('pass')
    expect(result).toContain('[REDACTED]@host.example.com')
  })

  it('redacts ghr_ token shape (runner registration token)', () => {
    // #given
    const input = 'ACTIONS_RUNNER_TOKEN=ghr_runnerRegistrationToken99'

    // #when
    const result = redactSecrets(input)

    // #then
    expect(result).not.toContain('ghr_runnerRegistrationToken99')
    expect(result).toContain('[REDACTED]')
  })

  it('redacts URL credentials where password contains @', () => {
    // #given — password itself contains '@', so naive [^@]+ would stop at the wrong '@'
    const input = 'https://user:my@secret@github.com/o/r'

    // #when
    const result = redactSecrets(input)

    // #then — no part of the credential leaks; exactly one [REDACTED] before the host
    expect(result).not.toContain('secret')
    expect(result).not.toContain('my@secret')
    expect(result).toContain('[REDACTED]@github.com')
    // Only one [REDACTED] marker (not two)
    expect(result.split('[REDACTED]').length - 1).toBe(1)
  })

  it('leaves plain text without secrets unchanged', () => {
    // #given
    const input = 'git clone failed: repository not found'

    // #when
    const result = redactSecrets(input)

    // #then
    expect(result).toBe(input)
  })
})

// ---------------------------------------------------------------------------
// redactSecrets — differential equivalence against the frozen legacy implementation
// ---------------------------------------------------------------------------

/**
 * Frozen copy of `redactSecrets` as it shipped before the linear-time rewrite (issue #1766). Do NOT edit or
 * "improve" this function: its only job is to be the byte-for-byte reference the new implementation must match.
 * Its URL-credential regex is quadratic on long scheme-legal runs; that is exactly the bug being fixed, so never
 * feed it inputs larger than a few thousand characters.
 */
function legacyRedactSecrets(text: string): string {
  let result = text.replaceAll(/github_pat_\S+/g, '[REDACTED]')
  result = result.replaceAll(/ghp_\S+/g, '[REDACTED]')
  result = result.replaceAll(/gho_\S+/g, '[REDACTED]')
  result = result.replaceAll(/ghu_\S+/g, '[REDACTED]')
  result = result.replaceAll(/ghs_\S+/g, '[REDACTED]')
  result = result.replaceAll(/ghr_\S+/g, '[REDACTED]')
  result = result.replaceAll(/([a-z][a-z\d+\-.]*:\/\/)(?:[^@\s]+@)+/gi, '$1[REDACTED]@')
  return result
}

/** mulberry32: tiny deterministic PRNG so a failing seed reproduces exactly. */
function createPrng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Returns every input on which the new implementation differs from the frozen reference. */
function findMismatches(
  inputs: Iterable<string>,
): {readonly input: string; readonly legacy: string; readonly actual: string}[] {
  const mismatches: {input: string; legacy: string; actual: string}[] = []
  for (const input of inputs) {
    const legacy = legacyRedactSecrets(input)
    const actual = redactSecrets(input)
    if (legacy !== actual && mismatches.length < 10) mismatches.push({input, legacy, actual})
  }
  return mismatches
}

const HAND_BUILT_CORPUS: readonly string[] = [
  // Every input used by the redactSecrets / formatPipelineError cases above.
  'Authorization: ghp_abc123XYZsomeLongToken',
  'token=gho_secretOAuthToken99',
  'Bearer ghu_userAccessToken42',
  'GITHUB_TOKEN=ghs_serverToServerToken77',
  'pat=github_pat_11ABCDEF_longPersonalAccessToken',
  'Clone failed: https://myuser:supersecret@github.com/org/repo.git',
  'remote: git://user:pass@host.example.com/repo',
  'ACTIONS_RUNNER_TOKEN=ghr_runnerRegistrationToken99',
  'https://user:my@secret@github.com/o/r',
  'git clone failed: repository not found',
  'auth failed with token ghp_abc123secretToken',
  'push rejected: github_pat_11ABCDEF_longPAT',
  'fetch failed: https://bot:ghp_secretToken@github.com/org/repo.git',
  'Command failed: git push --no-verify https://github.com/fro-bot/agent.git',
  'error: failed to push some refs to https://github.com/fro-bot/agent.git',
  `${'a'.repeat(1980)}ghp_secretTokenValueextra text after`,
  'x'.repeat(2100),
  '',
  // Passwords containing @, runs of @, and chains broken by an empty segment.
  'https://user:p@ss@w@rd@host/x',
  'https://user:pass@@host/x',
  'https://@host/x',
  'https://a@',
  'https://a@@',
  'https://a@b@@c@d',
  'https://a@b@ c@d',
  'https://a@b@\nc@d',
  // Tokens glued to preceding characters.
  'xghp_abc',
  'urlhttps://u:ghp_tok@host',
  'prefixgithub_pat_AAAA suffix',
  'https://u:github_pat_AAAA@host',
  'ghp_a ghp_b\tghs_c\nghr_d',
  // Mixed-case and odd-but-legal schemes, including digits/symbols ahead of the first letter.
  'HTTPS://User:Pass@Host/x',
  'HtTp://u:p@h',
  'git+ssh://u:p@h/r',
  'svn+ssh.v2://u:p@h',
  '1http://u:p@h',
  '+-.1http://u:p@h',
  '.a://u:p@h',
  '9://u:p@h',
  '1+2://u:p@h',
  'a1b2c3://u:p@h',
  // Several URLs in one string.
  'a https://u1:p1@h1 b http://u2:p2@h2 c ftp://h3',
  'https://u:p@h/https://v:q@i',
  'https://u:p@h,https://v:q@i;git://w:r@j',
  'x://a@x://b@x://c@',
  'x://a x://b@ x://c@d',
  // @ with no scheme, scheme with no @.
  'user:pass@host.example.com',
  'mailto:someone@example.com',
  'email me at a@b.c',
  '@',
  '@@@',
  'https://github.com/o/r',
  'https://host/path?q=1&r=2#frag',
  'x://',
  '://',
  '://a@b',
  'ftp:/a@b',
  'ftp:///a@b',
  'ftp:////a@b@c',
  ':// @',
  // Whitespace boundaries (ASCII and Unicode `\s`).
  'https://u:p@h\nnext line',
  'https://u: p@h',
  'https://u:p @h',
  'https://u:p\t@h',
  'https://u\u00A0:p@h',
  'https://u:p\u2028@h',
  'https://u:p\uFEFF@h',
  'https://u:p\u3000@h',
  'https://u\u200B:p@h',
  'https://u\u0085:p@h',
  ' https://u:p@h ',
  '\thttps://u:p@h\n',
  // Unicode around scheme and credential boundaries.
  'éhttps://u:p@h',
  'é://u:p@h',
  'https://é:ü@h',
  'https://u:p@hé',
  'ſhttp://u:p@h',
  '\u212Ahttp://u:p@h',
  'httpſ://u:p@h',
  'http\u212A://u:p@h',
  '日本語https://u:p@h',
  'https://日本語:パス@h',
  '\u{1F600}https://u:p@h',
  'https://\u{1F600}:\u{1F600}@h',
  'https://u:\uD800@h',
  '\uDC00https://u:p@h',
]

describe('redactSecrets — differential equivalence with the frozen legacy implementation', () => {
  it('matches the legacy output on every hand-built corpus entry', () => {
    // #given the hand-built corpus
    // #when each entry is redacted by both implementations
    const mismatches = findMismatches(HAND_BUILT_CORPUS)

    // #then there is no divergence
    expect(HAND_BUILT_CORPUS.length).toBeGreaterThanOrEqual(80)
    expect(mismatches).toEqual([])
  })

  it('still redacts the credential shapes the legacy implementation redacted', () => {
    // #given inputs whose legacy output is known to contain redactions
    // #when / #then the new implementation produces the same, non-trivial output
    expect(redactSecrets('https://user:my@secret@github.com/o/r')).toBe('https://[REDACTED]@github.com/o/r')
    expect(redactSecrets('1http://u:p@h')).toBe('1http://[REDACTED]@h')
    expect(redactSecrets('HTTPS://User:Pass@Host/x')).toBe('HTTPS://[REDACTED]@Host/x')
    expect(redactSecrets('a https://u1:p1@h1 b http://u2:p2@h2')).toBe('a https://[REDACTED]@h1 b http://[REDACTED]@h2')
    expect(redactSecrets('https://a@b@@c@d')).toBe('https://[REDACTED]@@c@d')
  })

  it('matches the legacy output on 20,000 seeded pseudo-random strings', () => {
    // #given strings over an alphabet weighted toward the characters that matter to the URL-credential pattern
    // (scheme letters, digits, + - . : / @, whitespace), spiced with token prefixes and non-ASCII look-alikes
    const alphabet = [
      ...'aaaabbxxyzAHT',
      ...'0129',
      ...'+-.',
      ...':::///',
      ...'@@@',
      ...'  \n\t',
      ...'_',
      '\u00A0',
      '\u2028',
      '\uFEFF',
      'é',
      'ſ',
      '\u212A',
      '\u{1F600}',
      '://',
      '://',
      'x://',
      'https://',
      'ghp_',
      'github_pat_',
      'a@',
      '@b',
    ]
    const random = createPrng(0x1766)
    const inputs: string[] = []
    for (let index = 0; index < 20_000; index += 1) {
      const length = Math.floor(random() * 41)
      let input = ''
      for (let position = 0; position < length; position += 1) {
        input += alphabet[Math.floor(random() * alphabet.length)] ?? ''
      }
      inputs.push(input)
    }

    // #when / #then
    expect(findMismatches(inputs)).toEqual([])
  })

  it('matches the legacy output on every string up to length 7 over a six-symbol alphabet', () => {
    // #given an exhaustive enumeration over {letter, digit, ':', '/', '@', ' '}: 6^0 + … + 6^7 = 335,923 strings
    const symbols = ['a', '1', ':', '/', '@', ' ']
    const mismatches: {input: string; legacy: string; actual: string}[] = []
    let checked = 0
    const extend = (prefix: string, remaining: number): void => {
      checked += 1
      const legacy = legacyRedactSecrets(prefix)
      const actual = redactSecrets(prefix)
      if (legacy !== actual && mismatches.length < 10) mismatches.push({input: prefix, legacy, actual})
      if (remaining === 0) return
      for (const symbol of symbols) extend(prefix + symbol, remaining - 1)
    }

    // #when
    extend('', 7)

    // #then
    expect(checked).toBe(335_923)
    expect(mismatches).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// redactSecrets — linear time (issue #1766)
// ---------------------------------------------------------------------------

function timeRedaction(input: string): {readonly output: string; readonly elapsedMs: number} {
  const startedAt = performance.now()
  const output = redactSecrets(input)
  return {output, elapsedMs: performance.now() - startedAt}
}

describe('redactSecrets — runs in linear time on adversarial input', () => {
  // The former URL-credential regex was quadratic: 100,000 scheme-legal characters took ~17s on V8 (~2.4s on Bun),
  // while the linear implementation takes a few milliseconds. The bound below is deliberately generous (1s) so a
  // heavily loaded host cannot trip it, yet the quadratic version misses it by more than an order of magnitude.
  const ADVERSARIAL_LENGTH = 100_000
  const LINEAR_BOUND_MS = 1_000
  // 50,000 prefixes (200,000 characters): enough that re-scanning each prefix's tail costs seconds even on a fast host.
  const PREFIX_COUNT = 50_000

  it('handles one long run of scheme-legal characters with no "://"', () => {
    // #given a run where every letter is a candidate scheme start
    const input = 'a'.repeat(ADVERSARIAL_LENGTH)

    // #when
    const {output, elapsedMs} = timeRedaction(input)

    // #then
    expect(output).toBe(input)
    expect(elapsedMs).toBeLessThan(LINEAR_BOUND_MS)
  })

  it('handles a long alternating letter / symbol scheme-legal run', () => {
    // #given letters interleaved with the non-letter scheme characters
    const input = 'a-1.+'.repeat(ADVERSARIAL_LENGTH / 5)

    // #when
    const {output, elapsedMs} = timeRedaction(input)

    // #then
    expect(output).toBe(input)
    expect(elapsedMs).toBeLessThan(LINEAR_BOUND_MS)
  })

  it('handles many "x://" prefixes with no "@" (each would re-scan the same tail)', () => {
    // #given 50,000 consecutive scheme prefixes and no credential anywhere
    const input = 'x://'.repeat(PREFIX_COUNT)

    // #when
    const {output, elapsedMs} = timeRedaction(input)

    // #then
    expect(output).toBe(input)
    expect(elapsedMs).toBeLessThan(LINEAR_BOUND_MS)
  })

  it('handles many "x://" prefixes whose only "@" is separated from them by whitespace', () => {
    // #given the tail scan must stop at the space, so the later "@" can never belong to any of these prefixes
    const input = `${'x://'.repeat(PREFIX_COUNT)} user@host`

    // #when
    const {output, elapsedMs} = timeRedaction(input)

    // #then
    expect(output).toBe(input)
    expect(elapsedMs).toBeLessThan(LINEAR_BOUND_MS)
  })

  it('still redacts a very long credential chain in linear time', () => {
    // #given a scheme followed by 50,000 "@"-separated segments
    const input = `see https://${'u@'.repeat(ADVERSARIAL_LENGTH / 2)}host/path`

    // #when
    const {output, elapsedMs} = timeRedaction(input)

    // #then
    expect(output).toBe('see https://[REDACTED]@host/path')
    expect(elapsedMs).toBeLessThan(LINEAR_BOUND_MS)
  })

  it('redacts a credential hidden at the end of a long scheme-legal run', () => {
    // #given 100,000 scheme characters, then a real credential URL
    const input = `${'a'.repeat(ADVERSARIAL_LENGTH)}://user:pw@host`

    // #when
    const {output, elapsedMs} = timeRedaction(input)

    // #then the whole run is the scheme (leftmost letter), exactly as before
    expect(output).toBe(`${'a'.repeat(ADVERSARIAL_LENGTH)}://[REDACTED]@host`)
    expect(elapsedMs).toBeLessThan(LINEAR_BOUND_MS)
  })
})

// ---------------------------------------------------------------------------
// formatPipelineError
// ---------------------------------------------------------------------------

describe('formatPipelineError', () => {
  it('collapses multi-line error to single line', () => {
    // #given
    const err = new Error('line one\nline two\nline three')

    // #when
    const result = formatPipelineError(err)

    // #then
    expect(result).not.toContain('\n')
    expect(result).toContain('line one')
    expect(result).toContain('line two')
    expect(result).toContain('line three')
  })

  it('collapses carriage-return newlines', () => {
    // #given
    const err = new Error('first\r\nsecond\r\nthird')

    // #when
    const result = formatPipelineError(err)

    // #then
    expect(result).not.toContain('\r')
    expect(result).not.toContain('\n')
    expect(result).toContain('first')
  })

  it('redacts ghp_ token in error message', () => {
    // #given
    const err = new Error('auth failed with token ghp_abc123secretToken')

    // #when
    const result = formatPipelineError(err)

    // #then
    expect(result).not.toContain('ghp_abc123secretToken')
    expect(result).toContain('[REDACTED]')
  })

  it('redacts github_pat_ token in error message', () => {
    // #given
    const err = new Error('push rejected: github_pat_11ABCDEF_longPAT')

    // #when
    const result = formatPipelineError(err)

    // #then
    expect(result).not.toContain('github_pat_11ABCDEF_longPAT')
    expect(result).toContain('[REDACTED]')
  })

  it('redacts URL credentials in error message', () => {
    // #given
    const err = new Error('fetch failed: https://bot:ghp_secretToken@github.com/org/repo.git')

    // #when
    const result = formatPipelineError(err)

    // #then
    expect(result).not.toContain('ghp_secretToken')
    expect(result).toContain('[REDACTED]')
  })

  it('truncates over-cap message with ellipsis', () => {
    // #given — message longer than FORMAT_ERROR_MAX_LENGTH
    const longMsg = 'x'.repeat(FORMAT_ERROR_MAX_LENGTH + 100)
    const err = new Error(longMsg)

    // #when
    const result = formatPipelineError(err)

    // #then
    expect(result.length).toBeLessThanOrEqual(FORMAT_ERROR_MAX_LENGTH)
    expect(result.endsWith('...')).toBe(true)
  })

  it('short message passes through unchanged (no truncation)', () => {
    // #given
    const err = new Error('short error')

    // #when
    const result = formatPipelineError(err)

    // #then
    expect(result).toBe('short error')
  })

  it('keeps useful multi-line git rejection details visible', () => {
    // #given
    const err = new Error(
      [
        'Command failed: git push --no-verify https://github.com/fro-bot/agent.git',
        '! [rejected] c9fda554:refs/harness-integrate/1.18.18 (stale info)',
        'error: failed to push some refs to https://github.com/fro-bot/agent.git',
        'hint: Updates were rejected because the remote ref moved underneath this run.',
        'hint: Verify the integration ref before retrying the release.',
      ].join('\n'),
    )

    // #when
    const result = formatPipelineError(err)

    // #then
    expect(result).toContain('stale info')
    expect(result).toContain('remote ref moved underneath this run')
    expect(result.length).toBeGreaterThan(300)
    expect(result.endsWith('...')).toBe(false)
  })

  it('handles null safely', () => {
    // #given / #when
    const result = formatPipelineError(null)

    // #then
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
  })

  it('handles undefined safely', () => {
    // #given / #when
    const result = formatPipelineError(undefined)

    // #then
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
  })

  it('handles empty string safely', () => {
    // #given / #when
    const result = formatPipelineError('')

    // #then
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
  })

  it('handles non-Error objects', () => {
    // #given
    const obj = {code: 'ENOENT', message: 'file not found'}

    // #when
    const result = formatPipelineError(obj)

    // #then
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
  })

  it('secret does not straddle the truncation cut', () => {
    // #given — secret placed near the cap boundary
    const prefix = 'a'.repeat(FORMAT_ERROR_MAX_LENGTH - 20)
    const secret = 'ghp_secretTokenValue'
    const err = new Error(`${prefix}${secret}extra text after`)

    // #when
    const result = formatPipelineError(err)

    // #then — the raw secret must not appear in the output
    expect(result).not.toContain('ghp_secretTokenValue')
    expect(result.length).toBeLessThanOrEqual(FORMAT_ERROR_MAX_LENGTH)
  })
})
