/**
 * Protected brokered-push surfaces are stored without a trailing slash. Extra
 * prefixes use the same canonical form: trailing slashes are accepted as
 * input, but removed from the normalized value. This keeps the segment-boundary
 * matcher equivalent to `path === prefix || path.startsWith(prefix + '/')`.
 */
export const BROKERED_PUSH_PROTECTED_SURFACES: ReadonlySet<string> = new Set([
  '.github',
  'scripts',
  'deploy/scripts',
  '.git',
  'package.json',
  'bun.lock',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'Dockerfile',
  '.npmrc',
  '.gitmodules',
  'action.yml',
  'action.yaml',
])

function isDockerfileVariant(prefix: string): boolean {
  // Case-sensitive prefix matching mirrors Docker's own default-filename case sensitivity; this is intentional.
  return prefix === 'Dockerfile' || prefix.startsWith('Dockerfile.')
}

function isProtectedSurfaceOverlap(prefix: string): boolean {
  for (const surface of BROKERED_PUSH_PROTECTED_SURFACES) {
    if (matchesBrokeredPushPrefix(prefix, surface) || matchesBrokeredPushPrefix(surface, prefix)) {
      return true
    }

    if (surface === 'Dockerfile' && isDockerfileVariant(prefix)) {
      return true
    }
  }

  return false
}

/**
 * Normalize one comma-separated brokered-push prefix without checking the
 * protected-surface policy.
 *
 * The order is intentional: trim, strip leading `./` and `/`, collapse
 * repeated separators, NFC-normalize, then reject malformed paths. Absolute
 * inputs are tracked before stripping their leading slash so `/abs` remains
 * invalid rather than becoming `abs`.
 */
export function normalizeBrokeredPushPrefix(input: string): string {
  const trimmed = input.trim()
  const wasAbsolute = trimmed.startsWith('/')
  let normalized = trimmed

  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2)
  }

  while (normalized.startsWith('/')) {
    normalized = normalized.slice(1)
  }

  normalized = normalized.replaceAll(/\/{2,}/g, '/').normalize('NFC')

  if (wasAbsolute || normalized.length === 0 || normalized === '.' || normalized.split('/').includes('..')) {
    throw new Error('path is malformed (absolute paths and traversal are not allowed)')
  }

  return normalized.replace(/\/+$/, '')
}

/**
 * Return true when a normalized path is the prefix itself or is below it at a
 * segment boundary. For convenience, both arguments accept normalizable
 * forms such as `apps/`; malformed values are rejected by the normalizer.
 */
export function matchesBrokeredPushPrefix(path: string, prefix: string): boolean {
  const normalizedPath = normalizeBrokeredPushPrefix(path)
  const normalizedPrefix = normalizeBrokeredPushPrefix(prefix)

  return normalizedPath === normalizedPrefix || normalizedPath.startsWith(`${normalizedPrefix}/`)
}

/**
 * Return true when a normalized extra prefix overlaps a protected surface in
 * either direction (the prefix is protected, nested below it, or contains it).
 */
export function isBrokeredPushProtectedPrefix(prefix: string): boolean {
  const normalized = normalizeBrokeredPushPrefix(prefix)
  return isProtectedSurfaceOverlap(normalized)
}

/**
 * Return true when a path contains a protected directory segment or names a
 * protected manifest, lockfile, Dockerfile variant, or root execution surface.
 * Malformed paths are treated as protected so enforcement callers fail closed.
 */
export function hasProtectedSegment(path: string): boolean {
  let normalized: string
  try {
    normalized = normalizeBrokeredPushPrefix(path)
  } catch {
    return true
  }

  const segments = normalized.split('/')
  const basename = segments.at(-1) ?? ''
  return (
    segments.some(segment => BROKERED_PUSH_PROTECTED_SURFACES.has(segment)) ||
    BROKERED_PUSH_PROTECTED_SURFACES.has(basename) ||
    isDockerfileVariant(basename)
  )
}

/**
 * Return true when a file path is already in the canonical form used for
 * brokered-push delivery. Interior dot segments are not normalized away and
 * therefore remain an explicit non-canonical spelling.
 */
export function isCanonicalBrokeredPushPath(path: string): boolean {
  try {
    return path === normalizeBrokeredPushPrefix(path) && /(?:^|\/)\.(?:\/|$)/.test(path) === false
  } catch {
    return false
  }
}

/**
 * Parse and validate the comma-separated `brokered-push-extra-paths` input.
 * Empty entries are ignored; valid duplicate prefixes are deduplicated after
 * normalization. Errors identify the original offending entry.
 */
export function parseBrokeredPushExtraPaths(input: string): readonly string[] {
  const prefixes = new Set<string>()

  for (const rawEntry of input.split(',')) {
    const entry = rawEntry.trim()
    if (entry.length === 0) {
      continue
    }

    try {
      const normalized = normalizeBrokeredPushPrefix(entry)
      if (isProtectedSurfaceOverlap(normalized)) {
        throw new Error('overlaps a protected brokered-push surface')
      }
      prefixes.add(normalized)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`Invalid brokered-push-extra-paths entry "${entry}": ${reason}`)
    }
  }

  return [...prefixes]
}
