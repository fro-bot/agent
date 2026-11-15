import {describe, expect, it} from 'vitest'
import {buildSandboxPath, SANDBOX_SYSTEM_DIRECTORIES} from './sandbox-toolchain-path.js'

const everyDirectory = (): boolean => true

/** The PATH measured on a hosted ubuntu-24.04 runner after `setup-node` and `setup-uv`, abridged. */
const MEASURED =
  '/opt/hostedtoolcache/uv/0.9.2/x86_64:/opt/hostedtoolcache/node/24.22.3/x64/bin:/home/runner/.bun/bin:' +
  '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin'

describe('buildSandboxPath', () => {
  it('keeps the runner entries in order and appends the system directories that are not already there', () => {
    // #given the measured runner PATH
    // #when mirrored
    const result = buildSandboxPath(MEASURED, everyDirectory)

    // #then the tool-cache entries come first, in the runner's order; the runner's own system entries keep their places;
    // and no system directory is repeated
    expect(result).toBe(
      '/opt/hostedtoolcache/uv/0.9.2/x86_64:/opt/hostedtoolcache/node/24.22.3/x64/bin:/home/runner/.bun/bin:' +
        '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin',
    )
  })

  it('appends the system directories, in their fixed order, after entries that do not contain them', () => {
    // #given a PATH of tool directories only
    const result = buildSandboxPath(
      '/opt/hostedtoolcache/node/24/x64/bin:/opt/hostedtoolcache/python/3.13/x64/bin',
      everyDirectory,
    )

    // #then the system directories are last
    expect(result).toBe(
      '/opt/hostedtoolcache/node/24/x64/bin:/opt/hostedtoolcache/python/3.13/x64/bin:/usr/local/bin:/usr/bin:/bin',
    )
  })

  it('falls back to the system directories alone when the runner PATH is missing or empty', () => {
    // #given nothing usable
    // #then the fixed value
    expect(buildSandboxPath(undefined, everyDirectory)).toBe('/usr/local/bin:/usr/bin:/bin')
    expect(buildSandboxPath('', everyDirectory)).toBe('/usr/local/bin:/usr/bin:/bin')
    expect(SANDBOX_SYSTEM_DIRECTORIES).toEqual(['/usr/local/bin', '/usr/bin', '/bin'])
  })

  it.each([
    ['empty entries', '::/opt/a::/opt/b:', '/opt/a:/opt/b'],
    ['relative entries', 'bin:./node_modules/.bin:../x:/opt/a:~/tools', '/opt/a'],
    ['entries with control characters', '/opt/a\nb:/opt/c\td:/opt/e\u0000f:/opt/ok', '/opt/ok'],
  ])('leaves out %s', (_label, input, kept) => {
    // #given a PATH with entries that can never be a tool directory
    // #then only the good absolute entries remain, before the system directories
    expect(buildSandboxPath(input, everyDirectory)).toBe(`${kept}:/usr/local/bin:/usr/bin:/bin`)
  })

  it('leaves out entries that are not existing directories', () => {
    // #given a check that knows two directories
    const known = new Set(['/opt/there', '/usr/bin'])

    // #when mirrored
    const result = buildSandboxPath('/opt/missing:/opt/there:/opt/also-missing', dir => known.has(dir))

    // #then only the existing entry, then the system directories (which are appended as they are, existing or not)
    expect(result).toBe('/opt/there:/usr/local/bin:/usr/bin:/bin')
  })

  it('keeps a duplicate once, at its first position', () => {
    // #given the same directory three times, once with a trailing slash
    const result = buildSandboxPath('/opt/a:/opt/b:/opt/a:/opt/b/:/opt/a/', everyDirectory)

    // #then
    expect(result).toBe('/opt/a:/opt/b:/usr/local/bin:/usr/bin:/bin')
  })

  it('keeps an entry under the runner home: it resolves nothing until it is granted', () => {
    // #given a bun directory
    const result = buildSandboxPath('/home/runner/.bun/bin:/opt/a', everyDirectory)

    // #then it stays, in place
    expect(result.startsWith('/home/runner/.bun/bin:/opt/a:')).toBe(true)
  })

  it('does not filter by writability: a shared directory is read-only in the view', () => {
    // #given a check that only answers "is a directory"
    // #then a world-writable-looking entry such as /tmp is kept like any other
    expect(buildSandboxPath('/tmp:/opt/a', everyDirectory)).toBe('/tmp:/opt/a:/usr/local/bin:/usr/bin:/bin')
  })

  it('drops an entry whose check throws', () => {
    // #given a check that fails for one entry
    const result = buildSandboxPath('/opt/boom:/opt/a', dir => {
      if (dir === '/opt/boom') throw new Error('EACCES')
      return true
    })

    // #then it is treated as not a directory
    expect(result).toBe('/opt/a:/usr/local/bin:/usr/bin:/bin')
  })

  it('keeps the whole value free of separators other than the colon between entries, and never empty', () => {
    // #given hostile input
    const result = buildSandboxPath('\n:\u0000:/opt/a b:', everyDirectory)

    // #then a space is fine in a path, and the value never starts or ends with a colon
    expect(result).toBe('/opt/a b:/usr/local/bin:/usr/bin:/bin')
  })
})
