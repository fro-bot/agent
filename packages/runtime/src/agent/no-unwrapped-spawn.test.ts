import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {fileURLToPath} from 'node:url'
import {describe, expect, it} from 'vitest'

// Guards the #1147 env-scrub invariant: every production call site that spawns
// an OpenCode server via `createOpencode(...)` must be wrapped by
// `withScrubbedEnv`, so the model's bash child never inherits unscrubbed
// secrets. This test scans server.ts as plain text (not via the type checker
// or eslint) so it fails loudly if a future edit adds a raw, unwrapped
// `createOpencode(...)` call — the enforcement previously done by an eslint
// rule that has since been dropped.
describe('no-unwrapped-spawn (runtime)', () => {
  it('every createOpencode(...) call in server.ts is wrapped by withScrubbedEnv', async () => {
    const currentDir = path.dirname(fileURLToPath(import.meta.url))
    const serverPath = path.join(currentDir, 'server.ts')
    const source = await fs.readFile(serverPath, 'utf8')

    const callLines = source
      .split('\n')
      .filter(line => /createOpencode\s*\(/.test(line))
      .filter(line => !/^\s*import\b/.test(line))
      .filter(line => !/typeof\s+createOpencode/.test(line))

    expect(callLines.length).toBeGreaterThan(0)
    for (const line of callLines) {
      expect(line).toContain('withScrubbedEnv')
    }
  })
})
