import fs from 'node:fs/promises'
import path from 'node:path'
import {describe, expect, it} from 'vitest'

describe('Bun dead code removal', () => {
  const setupDir = path.dirname(import.meta.url).replace('file://', '')

  // #given: bun.ts should not exist
  it('should have deleted bun.ts file', async () => {
    const bunPath = path.join(setupDir, 'bun.ts')
    try {
      await fs.access(bunPath)
      expect.fail('bun.ts file should be deleted')
    } catch (error: unknown) {
      const err = error as NodeJS.ErrnoException
      if (error instanceof Error && 'code' in err && err.code === 'ENOENT') {
        return
      }
      throw error
    }
  })

  // #given: bun.test.ts should not exist
  it('should have deleted bun.test.ts file', async () => {
    const bunTestPath = path.join(setupDir, 'bun.test.ts')
    try {
      await fs.access(bunTestPath)
      expect.fail('bun.test.ts file should be deleted')
    } catch (error: unknown) {
      const err = error as NodeJS.ErrnoException
      if (error instanceof Error && 'code' in err && err.code === 'ENOENT') {
        return
      }
      throw error
    }
  })

  // #when: index.ts is imported
  // #then: no Bun exports should be available
  it('should not export Bun symbols from index.ts', async () => {
    const indexPath = path.join(setupDir, 'index.ts')
    const indexContent = await fs.readFile(indexPath, 'utf-8')

    const bunExports = [
      'buildBunDownloadUrl',
      'getBunPlatformInfo',
      'installBun',
      'isBunAvailable',
      'BunInstallResult',
      'BunPlatformInfo',
    ]

    for (const bunExport of bunExports) {
      expect(indexContent).not.toContain(bunExport)
    }
  })
})
