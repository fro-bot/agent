import type {FileHandle} from 'node:fs/promises'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

/**
 * Reads of paths a less-trusted writer could have shaped.
 *
 * With `isolate-agent` the sandbox user can plant a symlink, a FIFO or a directory where the runner expects a regular
 * file (the response file and its fallbacks, the session database an upload reads). A plain `fs.readFile` follows the
 * link and would read, or post, a runner-owned secret. These helpers open with `O_NOFOLLOW | O_NONBLOCK`, `fstat` the
 * handle (not the path, so nothing can be swapped between the check and the read) and require a regular file within a
 * size bound. They apply to every run, isolated or not: for a regular file the result is identical.
 *
 * Failures are `Error`s whose `code` mirrors the OS where one exists (`ENOENT`, `ELOOP`) so existing `ENOENT`
 * handling keeps working, and use `ENOTREG`, `EFBIG` and `EOUTSIDE` for the refusals the OS does not report.
 */

export const DEFAULT_MAX_SAFE_READ_BYTES = 8 * 1024 * 1024

export interface SafeReadOptions {
  readonly maxBytes?: number
  /**
   * A directory the file must resolve inside. `O_NOFOLLOW` protects only the final path component; this also rejects a
   * symlinked directory in the middle of a path the writer controls.
   */
  readonly within?: string
}

function refusal(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), {code})
}

async function assertWithin(file: string, within: string): Promise<void> {
  const [realParent, realRoot] = await Promise.all([fs.realpath(path.dirname(file)), fs.realpath(within)])
  const relative = path.relative(realRoot, realParent)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw refusal('EOUTSIDE', `Refusing to read ${file}: it resolves outside ${within}`)
  }
}

/** Opens `file` read-only without following a final symlink, requiring a regular file. The caller closes the handle. */
export async function openRegularFileNoFollow(file: string, options: SafeReadOptions = {}): Promise<FileHandle> {
  if (options.within !== undefined) await assertWithin(file, options.within)
  const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
  let handle: FileHandle
  try {
    handle = await fs.open(file, flags)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ELOOP') throw refusal('ELOOP', `Refusing to read ${file}: it is a symlink`)
    throw error
  }
  try {
    const stats = await handle.stat()
    if (!stats.isFile()) throw refusal('ENOTREG', `Refusing to read ${file}: it is not a regular file`)
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_SAFE_READ_BYTES
    if (stats.size > maxBytes) throw refusal('EFBIG', `Refusing to read ${file}: it is larger than ${maxBytes} bytes`)
  } catch (error) {
    await handle.close()
    throw error
  }
  return handle
}

/** The UTF-8 text of a regular file, read through {@link openRegularFileNoFollow}. */
export async function readTextNoFollow(file: string, options: SafeReadOptions = {}): Promise<string> {
  const handle = await openRegularFileNoFollow(file, options)
  try {
    return await handle.readFile('utf8')
  } finally {
    await handle.close()
  }
}
