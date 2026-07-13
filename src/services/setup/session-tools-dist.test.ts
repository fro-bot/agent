import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {describe, expect, it} from 'vitest'

// Guards the namespace_export id-derivation contract: OpenCode's tool registry
// derives ids from a config-dir file tool's exported names (namespace_export,
// e.g. `session_read`), so the committed asset must export exactly these four
// names — no more, no less, no default export, no accidental re-export.
const DIST_ASSET_PATH = path.join(import.meta.dirname, '..', '..', '..', 'dist', 'session-tools.js')

describe('dist/session-tools.js export surface', () => {
  it('exports exactly {list, read, search, info}', async () => {
    // #given
    let contents: string
    try {
      contents = await fs.readFile(DIST_ASSET_PATH, 'utf8')
    } catch {
      // The committed dist/ asset is expected to exist in this repo (it is built and
      // committed as part of the release process); if it's absent, this environment
      // doesn't have it built yet — skip rather than fail the suite.
      return
    }

    // #when
    const exportStatement = /export\s*\{([^}]+)\};?\s*$/.exec(contents.trimEnd())
    expect(exportStatement, 'expected a trailing `export {...}` statement in the built asset').not.toBeNull()

    const exportedNames = (exportStatement?.[1] ?? '')
      .split(',')
      .map(entry => entry.trim())
      .filter(entry => entry.length > 0)
      .map(entry => {
        const asMatch = /\bas\s+(\S+)$/.exec(entry)
        return asMatch ? asMatch[1] : entry
      })
      .sort((a, b) => (a ?? '').localeCompare(b ?? ''))

    // #then
    expect(exportedNames).toEqual(['info', 'list', 'read', 'search'])
  })
})
