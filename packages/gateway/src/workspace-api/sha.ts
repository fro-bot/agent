const SHA_RE = /^[0-9a-f]{40}$/

export function isValidSha(value: unknown): value is string {
  return typeof value === 'string' && SHA_RE.test(value)
}
