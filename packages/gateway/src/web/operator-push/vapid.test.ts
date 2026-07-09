import {describe, expect, it} from 'vitest'

import {
  assertValidVapidKeyMaterial,
  assertValidVapidKeyVersion,
  assertValidVapidPrivateKey,
  assertValidVapidPublicKey,
  assertValidVapidSubject,
  toVapidPublicKeyInfo,
} from './vapid.js'

// ---------------------------------------------------------------------------
// Test fixtures — FAKE VAPID keypair only. Never a real production key.
// Generated locally for this test suite via node:crypto (P-256 keypair,
// uncompressed public point). Not tied to any deployed environment.
// ---------------------------------------------------------------------------

const FAKE_VAPID_PUBLIC_KEY = 'BOb1EqJOpvFSxr2XOPIr82Ktdxl6AibGOAiPmrkjbsv0mpr9In09mLbskqVAgLPIDjb0UIb7mZpU0SJKWWsVazc'
const FAKE_VAPID_PRIVATE_KEY = 'gQIJ6WJacBGGIKNR3-7ev4J95uh8hqQF728243fV_gg'
const FAKE_VAPID_SUBJECT = 'mailto:operator-push-test@example.com'
const FAKE_VAPID_KEY_VERSION = '1'

const FAKE_VAPID_MATERIAL = {
  publicKey: FAKE_VAPID_PUBLIC_KEY,
  privateKey: FAKE_VAPID_PRIVATE_KEY,
  subject: FAKE_VAPID_SUBJECT,
  keyVersion: FAKE_VAPID_KEY_VERSION,
}

describe('assertValidVapidPublicKey', () => {
  it('happy path: accepts a valid uncompressed P-256 public key', () => {
    // #given / #when / #then
    expect(() => assertValidVapidPublicKey(FAKE_VAPID_PUBLIC_KEY)).not.toThrow()
  })

  it('error path: rejects non-base64url characters', () => {
    // #given
    const malformed = `${FAKE_VAPID_PUBLIC_KEY.slice(0, -1)}+`

    // #when / #then
    expect(() => assertValidVapidPublicKey(malformed)).toThrow(/strict base64url/)
  })

  it('error path: rejects wrong decoded byte length', () => {
    // #given
    const tooShort = 'BOb1EqJOpvFSxr2XOPIr82Ktdxl6AibGOAiPmrkjbsv0'

    // #when / #then
    expect(() => assertValidVapidPublicKey(tooShort)).toThrow(/65 bytes/)
  })

  it('error path: rejects a compressed EC point (wrong leading byte)', () => {
    // #given — flip the leading byte away from 0x04
    const compressed = `A${FAKE_VAPID_PUBLIC_KEY.slice(1)}`

    // #when / #then
    expect(() => assertValidVapidPublicKey(compressed)).toThrow(/uncompressed EC point/)
  })

  it('error path: rejects a decoded byte length that is too long', () => {
    // #given — 66 bytes, correctly base64url-encoded but one byte over the required 65
    const tooLong = 'LIx8ZULRHcYeFvp3Hi26Bwno7_BFvZ0Vm00j74G5_WAP5J3Q0ckMDyXylHAAKBZYj6UZyk_CJXNv939PV4Rg9M2R'

    // #when / #then
    expect(() => assertValidVapidPublicKey(tooLong)).toThrow(/65 bytes/)
  })
})

describe('assertValidVapidPrivateKey', () => {
  it('happy path: accepts a valid 32-byte private key', () => {
    // #given / #when / #then
    expect(() => assertValidVapidPrivateKey(FAKE_VAPID_PRIVATE_KEY)).not.toThrow()
  })

  it('error path: rejects malformed private key', () => {
    // #given
    const malformed = 'not-valid-base64url!!!'

    // #when / #then
    expect(() => assertValidVapidPrivateKey(malformed)).toThrow(/strict base64url/)
  })

  it('error path: rejects wrong decoded byte length', () => {
    // #given
    const tooShort = 'gQIJ6WJacBGGIKNR3w'

    // #when / #then
    expect(() => assertValidVapidPrivateKey(tooShort)).toThrow(/32 bytes/)
  })

  it('error path: rejects a decoded byte length that is too long', () => {
    // #given — 33 bytes, correctly base64url-encoded but one byte over the required 32
    const tooLong = 'VQy5DTiVolytPi9WbWlBG5uvalIcuGeMEuVb08abt2nB'

    // #when / #then
    expect(() => assertValidVapidPrivateKey(tooLong)).toThrow(/32 bytes/)
  })

  it('never embeds the private key value in a thrown error message', () => {
    // #given a malformed private key that would fail validation
    const malformed = 'not-valid-base64url!!!'

    // #when
    let thrown: Error | undefined
    try {
      assertValidVapidPrivateKey(malformed)
    } catch (error) {
      thrown = error as Error
    }

    // #then — the error message never echoes the input value
    expect(thrown).toBeDefined()
    expect(thrown?.message).not.toContain(malformed)
    expect(thrown?.message).not.toContain(FAKE_VAPID_PRIVATE_KEY)
  })
})

describe('assertValidVapidSubject', () => {
  it('happy path: accepts a mailto: subject', () => {
    // #given / #when / #then
    expect(() => assertValidVapidSubject('mailto:ops@example.com')).not.toThrow()
  })

  it('happy path: accepts an https: subject', () => {
    // #given / #when / #then
    expect(() => assertValidVapidSubject('https://example.com/contact')).not.toThrow()
  })

  it('error path: rejects a blank subject', () => {
    // #given / #when / #then
    expect(() => assertValidVapidSubject('   ')).toThrow(/must not be blank/)
  })

  it('error path: rejects a non-mailto/https scheme', () => {
    // #given / #when / #then
    expect(() => assertValidVapidSubject('ftp://example.com')).toThrow(/mailto:.*https:/)
  })

  it('error path: rejects an invalid URL', () => {
    // #given / #when / #then
    expect(() => assertValidVapidSubject('not a url')).toThrow(/valid mailto/)
  })

  it('error path: rejects an addressless mailto: subject', () => {
    // #given / #when / #then
    expect(() => assertValidVapidSubject('mailto:')).toThrow(/non-empty address/)
  })

  it('error path: rejects a mailto: subject with a whitespace-only address', () => {
    // #given / #when / #then
    expect(() => assertValidVapidSubject('mailto:   ')).toThrow(/non-empty address/)
  })

  it('happy path: accepts a mailto: subject with a real address (regression guard)', () => {
    // #given / #when / #then
    expect(() => assertValidVapidSubject('mailto:ops@example.com')).not.toThrow()
  })
})

describe('assertValidVapidKeyVersion', () => {
  it('happy path: accepts a positive integer string', () => {
    // #given / #when / #then
    expect(() => assertValidVapidKeyVersion('1')).not.toThrow()
    expect(() => assertValidVapidKeyVersion('42')).not.toThrow()
  })

  it('error path: rejects zero, negative, non-numeric, and leading-zero values', () => {
    // #given / #when / #then
    expect(() => assertValidVapidKeyVersion('0')).toThrow(/positive integer/)
    expect(() => assertValidVapidKeyVersion('-1')).toThrow(/positive integer/)
    expect(() => assertValidVapidKeyVersion('abc')).toThrow(/positive integer/)
    expect(() => assertValidVapidKeyVersion('01')).toThrow(/positive integer/)
  })
})

describe('assertValidVapidKeyMaterial', () => {
  it('happy path: accepts a complete valid VAPID keypair and returns the safe subset', () => {
    // #given a valid fake keypair
    // #when
    const info = assertValidVapidKeyMaterial(FAKE_VAPID_MATERIAL)

    // #then — only publicKey + keyVersion are returned
    expect(info).toStrictEqual({publicKey: FAKE_VAPID_PUBLIC_KEY, keyVersion: FAKE_VAPID_KEY_VERSION})
  })

  it('error path: rejects when private key is missing/malformed', () => {
    // #given
    const material = {...FAKE_VAPID_MATERIAL, privateKey: ''}

    // #when / #then
    expect(() => assertValidVapidKeyMaterial(material)).toThrow()
  })

  it('error path: rejects a blank subject', () => {
    // #given
    const material = {...FAKE_VAPID_MATERIAL, subject: ''}

    // #when / #then
    expect(() => assertValidVapidKeyMaterial(material)).toThrow(/must not be blank/)
  })

  it('error path: rejects an invalid key version', () => {
    // #given
    const material = {...FAKE_VAPID_MATERIAL, keyVersion: 'not-a-version'}

    // #when / #then
    expect(() => assertValidVapidKeyMaterial(material)).toThrow(/positive integer/)
  })

  it('thrown error on invalid material never contains the private key value', () => {
    // #given a keypair with a bad subject but a real-shaped private key
    const material = {...FAKE_VAPID_MATERIAL, subject: ''}

    // #when
    let thrown: Error | undefined
    try {
      assertValidVapidKeyMaterial(material)
    } catch (error) {
      thrown = error as Error
    }

    // #then
    expect(thrown).toBeDefined()
    expect(thrown?.message).not.toContain(FAKE_VAPID_PRIVATE_KEY)
  })

  it('serializing (JSON.stringify) the returned safe subset never includes the private key', () => {
    // #given
    const info = assertValidVapidKeyMaterial(FAKE_VAPID_MATERIAL)

    // #when
    const serialized = JSON.stringify(info)

    // #then
    expect(serialized).not.toContain(FAKE_VAPID_PRIVATE_KEY)
  })
})

describe('toVapidPublicKeyInfo', () => {
  it('returns only publicKey + keyVersion, never the private key', () => {
    // #given / #when
    const info = toVapidPublicKeyInfo(FAKE_VAPID_MATERIAL)

    // #then
    expect(info).toStrictEqual({publicKey: FAKE_VAPID_PUBLIC_KEY, keyVersion: FAKE_VAPID_KEY_VERSION})
    expect(JSON.stringify(info)).not.toContain(FAKE_VAPID_PRIVATE_KEY)
  })
})
