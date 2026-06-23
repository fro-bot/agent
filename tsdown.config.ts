import type {Plugin} from 'rolldown'
import {readdir, readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {defineConfig} from 'tsdown'

export type {LicenseEntry} from './scripts/third-party-notices.ts'
export {formatThirdPartyNotices} from './scripts/third-party-notices.ts'

// Guard: the action is code-split, so the OpenCode default version literal can
// land in a shared chunk rather than main.js. A harness default carries a
// `+harness.<sha>` build-metadata suffix that a minifier could strip or collapse
// against the stock fallback; this fails the build if the configured default does
// not survive into the emitted bundle.

/**
 * Pure assertion: throws if `expected` is not present in any of the provided chunk contents.
 * Exported for unit testing; the plugin calls this after reading chunks from disk.
 */
export function assertVersionPresent(expected: string, chunkContents: readonly string[]): void {
  if (!chunkContents.some(c => c.includes(expected))) {
    throw new Error(
      `[default-version-invariant] DEFAULT_OPENCODE_VERSION '${expected}' is absent from every dist chunk — the bundler likely stripped its build metadata. Aborting to prevent shipping a silent stock default.`,
    )
  }
}

function defaultVersionInvariantPlugin(): Plugin {
  return {
    name: 'default-version-invariant',
    async writeBundle() {
      const constantsSource = await readFile('packages/runtime/src/shared/constants.ts', 'utf8')
      const match = /DEFAULT_OPENCODE_VERSION\s*=\s*'([^']+)'/.exec(constantsSource)
      if (match?.[1] == null) {
        throw new Error('[default-version-invariant] could not read DEFAULT_OPENCODE_VERSION from source')
      }
      const expected = match[1]
      const chunks = (await readdir('dist')).filter(name => name.endsWith('.js'))
      const chunkContents = await Promise.all(chunks.map(async name => readFile(join('dist', name), 'utf8')))
      assertVersionPresent(expected, chunkContents)
    },
  }
}

export default defineConfig({
  entry: ['apps/action/src/main.ts', 'apps/action/src/post.ts'],
  fixedExtension: false,
  inlineOnly: false,
  minify: true,
  // Source maps roughly triple committed dist/ size and the action never reads them.
  sourcemap: false,
  // Escape runs post-bundle in scripts/build-action-dist.ts (failure-safe) and
  // at the root build tail (pnpm run dist:escape-hidden-unicode, full dist).
  plugins: [defaultVersionInvariantPlugin()],
  noExternal: id => {
    if (id.startsWith('@bfra.me/es')) return true
    if (id.startsWith('@actions/')) return true
    if (id.startsWith('@octokit/auth-app')) return true
    if (id.startsWith('@opencode-ai/sdk')) return true
    if (id.startsWith('@aws-sdk/')) return true
    if (id.startsWith('@smithy/')) return true
    if (id.startsWith('@fro-bot/runtime')) return true
    return false
  },
})
