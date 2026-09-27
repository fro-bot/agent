import {Buffer} from 'node:buffer'
import {constants} from 'node:fs'
import {open} from 'node:fs/promises'

/** Opens and reads a regular file through one descriptor, refusing symlinks and special files. */
export async function readFileNoFollow(filePath: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw new Error('path is not a regular file')
    if (stat.size > maxBytes) throw new Error(`file exceeds ${maxBytes} byte limit`)

    const buffer = Buffer.alloc(maxBytes + 1)
    let offset = 0
    while (offset < buffer.length) {
      const {bytesRead} = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset > maxBytes) throw new Error(`file exceeds ${maxBytes} byte limit`)
    return buffer.subarray(0, offset)
  } finally {
    await handle.close()
  }
}
