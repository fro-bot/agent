/**
 * VAPID key material parsing and validation helpers for the Gateway operator
 * push configuration surface.
 *
 * Security invariant: VAPID private key material must NEVER appear in a
 * thrown error message, a log line, or a serialized/stringified value. Every
 * validator in this module either succeeds silently or throws a fixed reason
 * string that never echoes the input value — mirroring the no-oracle posture
 * used by `operator-contract/parse.ts`.
 *
 * VAPID keys are P-256 (prime256v1) EC keys, base64url-encoded with no
 * padding:
 *   - Public key: an uncompressed EC point — 65 raw bytes, leading byte 0x04.
 *   - Private key: the raw 32-byte scalar.
 */

import {Buffer} from 'node:buffer'

/** Raw byte length of an uncompressed P-256 EC public key point (0x04 || X || Y). */
const VAPID_PUBLIC_KEY_BYTES = 65
/** Leading byte marking an uncompressed EC point. */
const VAPID_PUBLIC_KEY_UNCOMPRESSED_PREFIX = 0x04
/** Raw byte length of a P-256 EC private key scalar. */
const VAPID_PRIVATE_KEY_BYTES = 32

/** Strict base64url alphabet: A-Z, a-z, 0-9, -, _ (no padding, no whitespace). */
const BASE64URL_PATTERN = /^[\w-]+$/

/**
 * Fully validated VAPID key material for one keypair (current or previous).
 * `privateKey` must never be logged, serialized, or embedded in an error.
 */
export interface VapidKeyMaterial {
  readonly publicKey: string
  readonly privateKey: string
  readonly subject: string
  readonly keyVersion: string
}

/** Client-safe VAPID material: public key + key version only. Never carries the private key. */
export interface VapidPublicKeyInfo {
  readonly publicKey: string
  readonly keyVersion: string
}

function isStrictBase64url(value: string): boolean {
  return BASE64URL_PATTERN.test(value)
}

/**
 * Validate a VAPID public key: strict base64url, decodes to 65 bytes,
 * leading byte 0x04 (uncompressed EC point).
 *
 * Throws a fixed reason string on failure — never echoes the input.
 */
export function assertValidVapidPublicKey(value: string): void {
  if (isStrictBase64url(value) === false) {
    throw new Error(
      'Invalid VAPID public key: must be strict base64url encoding (characters A-Z, a-z, 0-9, -, _ only; no padding, no whitespace).',
    )
  }
  const decoded = Buffer.from(value, 'base64url')
  if (decoded.length !== VAPID_PUBLIC_KEY_BYTES) {
    throw new Error(
      `Invalid VAPID public key: decoded to ${decoded.length} bytes but an uncompressed P-256 public key must be exactly ${VAPID_PUBLIC_KEY_BYTES} bytes.`,
    )
  }
  if (decoded[0] !== VAPID_PUBLIC_KEY_UNCOMPRESSED_PREFIX) {
    throw new Error(
      'Invalid VAPID public key: expected an uncompressed EC point (leading byte 0x04). Compressed points are not supported.',
    )
  }
}

/**
 * Validate a VAPID private key: strict base64url, decodes to 32 bytes.
 *
 * Throws a fixed reason string on failure — the private key value is never
 * embedded in the thrown error, even partially.
 */
export function assertValidVapidPrivateKey(value: string): void {
  if (isStrictBase64url(value) === false) {
    throw new Error(
      'Invalid VAPID private key: must be strict base64url encoding (characters A-Z, a-z, 0-9, -, _ only; no padding, no whitespace).',
    )
  }
  const decoded = Buffer.from(value, 'base64url')
  if (decoded.length !== VAPID_PRIVATE_KEY_BYTES) {
    throw new Error(
      `Invalid VAPID private key: decoded to ${decoded.length} bytes but a P-256 private key scalar must be exactly ${VAPID_PRIVATE_KEY_BYTES} bytes.`,
    )
  }
}

/**
 * Validate a VAPID subject claim: must be a non-blank `mailto:` or `https:` URL.
 *
 * Throws a fixed reason string on failure — never echoes the input.
 */
export function assertValidVapidSubject(value: string): void {
  if (value.trim() === '') {
    throw new Error('Invalid VAPID subject: must not be blank. Use a mailto: or https: URL.')
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('Invalid VAPID subject: must be a valid mailto: or https: URL.')
  }
  if (parsed.protocol !== 'mailto:' && parsed.protocol !== 'https:') {
    throw new Error('Invalid VAPID subject: must use the mailto: or https: scheme.')
  }
}

/**
 * Validate a VAPID key version: a non-empty string used verbatim as a
 * rotation discriminant on subscription records. Must be a positive integer
 * string (matches the `keyVersion` used elsewhere in the operator contract).
 *
 * Throws a fixed reason string on failure — never echoes the input.
 */
export function assertValidVapidKeyVersion(value: string): void {
  if (/^[1-9]\d*$/.test(value) === false) {
    throw new Error('Invalid VAPID key version: must be a positive integer string (e.g. "1").')
  }
}

/**
 * Validate a complete VAPID keypair (public key, private key, subject, key
 * version) and return the client-safe portion (public key + key version).
 *
 * Throws a fixed reason string on the first validation failure. Never
 * includes the private key value in any thrown error.
 */
export function assertValidVapidKeyMaterial(material: VapidKeyMaterial): VapidPublicKeyInfo {
  assertValidVapidPublicKey(material.publicKey)
  assertValidVapidPrivateKey(material.privateKey)
  assertValidVapidSubject(material.subject)
  assertValidVapidKeyVersion(material.keyVersion)
  return {publicKey: material.publicKey, keyVersion: material.keyVersion}
}

/**
 * Derive the client-safe portion of VAPID key material (public key + key
 * version only). Never returns or references the private key.
 */
export function toVapidPublicKeyInfo(material: VapidKeyMaterial): VapidPublicKeyInfo {
  return {publicKey: material.publicKey, keyVersion: material.keyVersion}
}
