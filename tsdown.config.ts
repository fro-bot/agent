import type {Plugin} from 'rolldown'
import {readdir, readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {defineConfig} from 'tsdown'

export type {LicenseEntry} from './scripts/third-party-notices.ts'
export {formatThirdPartyNotices} from './scripts/third-party-notices.ts'

// Guard: the action is code-split, so the OpenCode default can land in a shared chunk rather than
// main.js. DEFAULT_OPENCODE_VERSION derives from opencode-v2-pin.json, so that file is the source of
// truth: this fails the build if the pinned version or any pinned digest does not survive into the
// emitted bundle. A bare `2.2.5` is too short to prove much on its own; the 64-character digests are
// what show the whole pin was bundled, and a missing digest would fail every V2 install closed at runtime.

/**
 * Pure assertion: throws if `expected` is not present in any of the provided chunk contents.
 * Exported for unit testing; the plugin calls this after reading chunks from disk.
 */
export function assertVersionPresent(expected: string, chunkContents: readonly string[]): void {
  if (!chunkContents.some(c => c.includes(expected))) {
    throw new Error(
      `[default-version-invariant] DEFAULT_OPENCODE_VERSION '${expected}' is absent from every dist chunk — the bundler likely stripped it. Aborting to prevent shipping a silent wrong default.`,
    )
  }
}

/**
 * Pure assertion: throws unless the pinned version and every pinned asset digest are present in some chunk.
 */
export function assertPinPresent(
  pin: {readonly version: string; readonly assets: Readonly<Record<string, string>>},
  chunkContents: readonly string[],
): void {
  assertVersionPresent(pin.version, chunkContents)
  for (const digest of Object.values(pin.assets)) {
    assertVersionPresent(digest, chunkContents)
  }
}

function defaultVersionInvariantPlugin(): Plugin {
  return {
    name: 'default-version-invariant',
    async writeBundle() {
      const pin = JSON.parse(await readFile('packages/runtime/src/shared/opencode-v2-pin.json', 'utf8')) as {
        version?: unknown
        assets?: unknown
      }
      if (typeof pin.version !== 'string' || pin.assets == null || typeof pin.assets !== 'object') {
        throw new Error('[default-version-invariant] could not read the version and assets from opencode-v2-pin.json')
      }
      const chunks = (await readdir('dist')).filter(name => name.endsWith('.js'))
      const chunkContents = await Promise.all(chunks.map(async name => readFile(join('dist', name), 'utf8')))
      assertPinPresent({version: pin.version, assets: pin.assets as Record<string, string>}, chunkContents)
    },
  }
}

const sharedNoExternal = (id: string): boolean => {
  if (id.startsWith('@bfra.me/es')) return true
  if (id.startsWith('@actions/')) return true
  if (id.startsWith('@octokit/auth-app')) return true
  if (id.startsWith('@opencode-ai/sdk')) return true
  if (id.startsWith('@aws-sdk/')) return true
  if (id.startsWith('@smithy/')) return true
  if (id.startsWith('@fro-bot/runtime')) return true
  if (id === 'zod' || id.startsWith('zod/')) return true
  return false
}

export default defineConfig([
  {
    entry: ['apps/action/src/main.ts', 'apps/action/src/post.ts', 'apps/action/src/key-proxy.ts'],
    fixedExtension: false,
    deps: {onlyBundle: false},
    minify: true,
    // Source maps roughly triple committed dist/ size and the action never reads them.
    sourcemap: false,
    // Escape runs post-bundle in scripts/build-action-dist.ts (failure-safe) and
    // at the root build tail (pnpm run dist:escape-hidden-unicode, full dist).
    plugins: [defaultVersionInvariantPlugin()],
    noExternal: sharedNoExternal,
  },
])
