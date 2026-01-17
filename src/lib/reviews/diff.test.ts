import type {Logger} from '../logger.js'
import {Buffer} from 'node:buffer'
import {describe, expect, it, vi} from 'vitest'
import {getFileContent, getPRDiff, parseHunks} from './diff.js'

function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  }
}

describe('parseHunks', () => {
  it('parses single hunk', () => {
    // #given a patch with one hunk
    const patch = `@@ -1,3 +1,4 @@
 line1
+new line
 line2
 line3`

    // #when parsing hunks
    const hunks = parseHunks(patch)

    // #then should return one hunk with correct start line
    expect(hunks).toHaveLength(1)
    expect(hunks[0]!.startLine).toBe(1)
    expect(hunks[0]!.lineCount).toBe(4)
  })

  it('parses multiple hunks', () => {
    // #given a patch with two hunks
    const patch = `@@ -1,3 +1,3 @@
 context
-removed
+added
@@ -10,2 +10,3 @@
 more context
+another addition`

    // #when parsing hunks
    const hunks = parseHunks(patch)

    // #then should return two hunks
    expect(hunks).toHaveLength(2)
    expect(hunks[0]!.startLine).toBe(1)
    expect(hunks[1]!.startLine).toBe(10)
  })

  it('handles hunk without line count (single line change)', () => {
    // #given a patch with single line hunk (no comma in header)
    const patch = `@@ -5 +5 @@
-old
+new`

    // #when parsing hunks
    const hunks = parseHunks(patch)

    // #then should default line count to 1
    expect(hunks).toHaveLength(1)
    expect(hunks[0]!.startLine).toBe(5)
    expect(hunks[0]!.lineCount).toBe(1)
  })

  it('returns empty array for empty patch', () => {
    // #given an empty patch string
    const patch = ''

    // #when parsing hunks
    const hunks = parseHunks(patch)

    // #then should return empty array
    expect(hunks).toHaveLength(0)
  })

  it('returns empty array for patch without hunk headers', () => {
    // #given content without hunk markers
    const patch = `some random text
without any diff markers`

    // #when parsing hunks
    const hunks = parseHunks(patch)

    // #then should return empty array
    expect(hunks).toHaveLength(0)
  })

  it('preserves hunk content including additions and deletions', () => {
    // #given a patch with mixed changes
    const patch = `@@ -1,4 +1,5 @@
 unchanged
-deleted line
+added line
+another addition
 more unchanged`

    // #when parsing hunks
    const hunks = parseHunks(patch)

    // #then content should include all lines
    expect(hunks[0]!.content).toContain('-deleted line')
    expect(hunks[0]!.content).toContain('+added line')
    expect(hunks[0]!.content).toContain('+another addition')
  })
})

describe('getPRDiff', () => {
  it('fetches all changed files with pagination', async () => {
    // #given mock octokit returning files
    const mockOctokit = {
      rest: {
        pulls: {
          listFiles: vi.fn().mockResolvedValue({
            data: [
              {
                filename: 'src/main.ts',
                status: 'modified',
                additions: 10,
                deletions: 5,
                patch: '@@ -1 +1 @@\n-old\n+new',
              },
              {
                filename: 'src/utils.ts',
                status: 'added',
                additions: 20,
                deletions: 0,
                patch: '@@ -0,0 +1,20 @@\n+code',
              },
            ],
          }),
        },
      },
    }
    const logger = createMockLogger()

    // #when fetching PR diff
    const diff = await getPRDiff(mockOctokit as never, 'owner', 'repo', 1, logger)

    // #then should return all files with totals
    expect(diff.files).toHaveLength(2)
    expect(diff.changedFiles).toBe(2)
    expect(diff.additions).toBe(30)
    expect(diff.deletions).toBe(5)
    expect(diff.truncated).toBe(false)
  })

  it('handles pagination when more files exist', async () => {
    // #given mock octokit returning full page (100 files)
    const page1Files = Array.from({length: 100}, (_, i) => ({
      filename: `file${i}.ts`,
      status: 'modified',
      additions: 1,
      deletions: 0,
      patch: '@@ -1 +1 @@\n+x',
    }))
    const page2Files = Array.from({length: 50}, (_, i) => ({
      filename: `file${100 + i}.ts`,
      status: 'modified',
      additions: 1,
      deletions: 0,
      patch: '@@ -1 +1 @@\n+x',
    }))

    const mockOctokit = {
      rest: {
        pulls: {
          listFiles: vi.fn().mockResolvedValueOnce({data: page1Files}).mockResolvedValueOnce({data: page2Files}),
        },
      },
    }
    const logger = createMockLogger()

    // #when fetching PR diff
    const diff = await getPRDiff(mockOctokit as never, 'owner', 'repo', 1, logger)

    // #then should fetch multiple pages
    expect(diff.files).toHaveLength(150)
    expect(diff.changedFiles).toBe(150)
    expect(mockOctokit.rest.pulls.listFiles).toHaveBeenCalledTimes(2)
  })

  it('handles files without patch (binary files)', async () => {
    // #given mock octokit with binary file (no patch)
    const mockOctokit = {
      rest: {
        pulls: {
          listFiles: vi.fn().mockResolvedValue({
            data: [{filename: 'image.png', status: 'added', additions: 0, deletions: 0, patch: undefined}],
          }),
        },
      },
    }
    const logger = createMockLogger()

    // #when fetching PR diff
    const diff = await getPRDiff(mockOctokit as never, 'owner', 'repo', 1, logger)

    // #then file should have null patch
    expect(diff.files[0]!.patch).toBeNull()
  })

  it('handles renamed files with previous filename', async () => {
    // #given mock octokit with renamed file
    const mockOctokit = {
      rest: {
        pulls: {
          listFiles: vi.fn().mockResolvedValue({
            data: [
              {
                filename: 'new-name.ts',
                previous_filename: 'old-name.ts',
                status: 'renamed',
                additions: 0,
                deletions: 0,
                patch: '',
              },
            ],
          }),
        },
      },
    }
    const logger = createMockLogger()

    // #when fetching PR diff
    const diff = await getPRDiff(mockOctokit as never, 'owner', 'repo', 1, logger)

    // #then should include previous filename
    expect(diff.files[0]!.previousFilename).toBe('old-name.ts')
  })
})

describe('getFileContent', () => {
  it('fetches file content successfully', async () => {
    // #given mock octokit with base64 content
    const content = 'console.log("hello")'
    const mockOctokit = {
      rest: {
        repos: {
          getContent: vi.fn().mockResolvedValue({
            data: {
              content: Buffer.from(content).toString('base64'),
              encoding: 'base64',
            },
          }),
        },
      },
    }
    const logger = createMockLogger()

    // #when fetching file content
    const result = await getFileContent(mockOctokit as never, 'owner', 'repo', 'src/main.ts', 'abc123', logger)

    // #then should return decoded content
    expect(result).toBe(content)
  })

  it('returns null for directory response', async () => {
    // #given mock octokit returning directory (array)
    const mockOctokit = {
      rest: {
        repos: {
          getContent: vi.fn().mockResolvedValue({
            data: [{name: 'file.ts', type: 'file'}],
          }),
        },
      },
    }
    const logger = createMockLogger()

    // #when fetching directory path
    const result = await getFileContent(mockOctokit as never, 'owner', 'repo', 'src/', 'abc123', logger)

    // #then should return null
    expect(result).toBeNull()
  })

  it('returns null when file not found', async () => {
    // #given mock octokit throwing 404
    const mockOctokit = {
      rest: {
        repos: {
          getContent: vi.fn().mockRejectedValue(new Error('Not Found')),
        },
      },
    }
    const logger = createMockLogger()

    // #when fetching non-existent file
    const result = await getFileContent(mockOctokit as never, 'owner', 'repo', 'nonexistent.ts', 'abc123', logger)

    // #then should return null and log debug
    expect(result).toBeNull()
    expect(logger.debug).toHaveBeenCalled()
  })
})
