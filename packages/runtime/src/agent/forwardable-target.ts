/** Printable ASCII only: no control character, space, DEL or byte above 0x7e anywhere in the target. */
const PRINTABLE_ASCII = /^[\x21-\x7E]+$/

/** The percent-encodings of `/`, `\`, `.`, `;` and `%`: the characters a router can decode into path structure. */
const STRUCTURAL_ENCODING = /%(?:2f|5c|2e|3b|25)/i

/** Decides whether a method, a canonical path and the raw query (no `?`) are an allowlisted route. */
export type RouteMatcher = (method: string, path: string, query: string) => boolean

/**
 * True when a request may be forwarded: its target is canonical origin-form and its method, path and query are an
 * allowlisted route. The check is strict on purpose, because the forwarded target is what the next router sees:
 *
 * - origin-form only: it starts with exactly one `/`, so absolute-form (`http://host/...`, which a router reduces to its
 *   path), authority-form and `*` are refused;
 * - printable ASCII only, and no `#`;
 * - the path (everything before the first `?`) has no `;` (a router truncates a segment there), no `\`, no empty
 *   segment, no `.` or `..` segment, and no percent-encoding of `/`, `\`, `.`, `;` or `%`;
 * - the matcher decides the route from the exact path segments, with no decoding.
 *
 * The matcher also receives the raw query, for routes that accept one fixed query; the canonical checks never inspect it.
 */
export function isForwardableTarget(
  method: string | undefined,
  target: string | undefined,
  matchesRoute: RouteMatcher,
): boolean {
  if (method === undefined || target === undefined) return false
  if (!PRINTABLE_ASCII.test(target) || target.includes('#')) return false
  if (!target.startsWith('/') || target.startsWith('//')) return false
  const queryStart = target.indexOf('?')
  const path = queryStart === -1 ? target : target.slice(0, queryStart)
  const query = queryStart === -1 ? '' : target.slice(queryStart + 1)
  if (path.includes(';') || path.includes('\\') || STRUCTURAL_ENCODING.test(path)) return false
  if (
    path
      .split('/')
      .slice(1)
      .some(segment => segment === '' || segment === '.' || segment === '..')
  )
    return false
  return matchesRoute(method, path, query)
}
