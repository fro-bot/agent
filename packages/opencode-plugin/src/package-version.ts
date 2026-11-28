/**
 * The plugin's own version, read at run time from the `package.json` that ships beside the built files.
 *
 * Not a build-time constant: the release job builds with a placeholder version and writes the real one into the staged
 * `package.json` afterwards (`npm pkg set version`), so a constant baked in by the build would always be the placeholder.
 * The tarball carries `package.json` at its root and the built files in `dist/`, so `../package.json` from a built module
 * is the manifest; this file sits one directory below the package root in the source tree too, so the same path reads the
 * workspace manifest there. Only `node:fs` is imported: the release import gate allows nothing else.
 */

import {readFileSync} from 'node:fs'

const PLUGIN_PACKAGE_NAME = '@fro.bot/opencode-plugin'

/** A semantic version, prerelease and build metadata allowed, and nothing else: it ends up as an attribute value. */
const VERSION = /^\d+\.\d+\.\d+(?:-[\da-z.-]+)?(?:\+[\da-z.-]+)?$/i
const MAX_VERSION_CHARS = 64

/**
 * The version, or `undefined` when it cannot be read: a missing or unreadable file, text that is not JSON, another
 * package's manifest, or a value that is not a bounded semantic version. Never throws: the version is a label, and a
 * trace without it is still a trace.
 */
export function readPackageVersion(
  manifest: URL = new URL('../package.json', import.meta.url),
  read: (url: URL) => string = url => readFileSync(url, 'utf8'),
): string | undefined {
  try {
    const document: unknown = JSON.parse(read(manifest))
    if (typeof document !== 'object' || document === null || Array.isArray(document)) return undefined
    const {name, version} = document as {readonly name?: unknown; readonly version?: unknown}
    if (name !== PLUGIN_PACKAGE_NAME) return undefined
    if (typeof version !== 'string' || version.length > MAX_VERSION_CHARS || !VERSION.test(version)) return undefined
    return version
  } catch {
    return undefined
  }
}
