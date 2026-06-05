import {spawnSync} from 'node:child_process'
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {describe, expect, it} from 'vitest'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const thisDir = path.dirname(fileURLToPath(import.meta.url))
const PROMPT_PATH = path.resolve(thisDir, '..', 'prompt.txt')

/**
 * Extract fenced ```bash blocks from the prompt template.
 * Preserves EXACT indentation — trimming hides the heredoc-terminator bug.
 */
function extractBashBlocks(content: string): string[] {
  const blocks: string[] = []
  const lines = content.split('\n')
  let inBlock = false
  let current: string[] = []

  for (const line of lines) {
    if (!inBlock && line.trimStart() === '```bash') {
      inBlock = true
      current = []
    } else if (inBlock && line.trimStart() === '```') {
      blocks.push(current.join('\n'))
      inBlock = false
      current = []
    } else if (inBlock) {
      current.push(line)
    }
  }

  return blocks
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('prompt.txt bash snippet syntax', () => {
  // #given
  const promptContent = readFileSync(PROMPT_PATH, 'utf8')
  const bashBlocks = extractBashBlocks(promptContent)

  it('contains at least one bash block', () => {
    // #then
    expect(bashBlocks.length).toBeGreaterThan(0)
  })

  it('push block contains required markers', () => {
    // #given
    const allBlocks = bashBlocks.join('\n')

    // #then
    expect(allBlocks).toContain('GIT_ASKPASS')
    expect(allBlocks).toContain('git push')
    expect(allBlocks).toContain('refs/harness-integrate')
  })

  it.each(bashBlocks.map((block, i) => ({block, index: i})))(
    'bash block $index passes bash -n syntax check (stderr must be empty)',
    ({block}) => {
      // #given
      const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'harness-prompt-test-'))
      const tmpFile = path.join(tmpDir, 'snippet.sh')

      try {
        writeFileSync(tmpFile, block, {encoding: 'utf8'})

        // #when
        // spawnSync (not execFileSync) so we always get stderr even when exit code is 0.
        // bash -n exits 0 on indented-heredoc warnings but still emits stderr — that's
        // the load-bearing check that catches the indented-EOF terminator bug.
        const result = spawnSync('bash', ['-n', tmpFile], {encoding: 'utf8'})

        // #then
        expect(result.status).toBe(0)
        expect((result.stderr ?? '').trim().length).toBe(0)
      } finally {
        rmSync(tmpDir, {recursive: true, force: true})
      }
    },
  )
})
