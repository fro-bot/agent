import type {FilePartInput} from '@opencode-ai/sdk'
import type {Logger} from '../../shared/logger.js'
import type {ReferenceFile} from './types.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {pathToFileURL} from 'node:url'

export type WriteReferenceFile = (filePath: string, content: string) => Promise<void>

export async function materializeReferenceFiles(
  referenceFiles: readonly ReferenceFile[],
  dir: string,
  logger: Logger,
  writeReferenceFile: WriteReferenceFile = async (filePath, content) => fs.writeFile(filePath, content, 'utf8'),
): Promise<readonly FilePartInput[]> {
  const fileParts: FilePartInput[] = []

  for (const referenceFile of referenceFiles) {
    const filePath = path.join(dir, referenceFile.filename)

    try {
      await writeReferenceFile(filePath, referenceFile.content)
      fileParts.push({
        type: 'file',
        mime: 'text/plain',
        url: pathToFileURL(filePath).toString(),
        filename: referenceFile.filename,
      })
    } catch (error) {
      logger.warning('Failed to materialize reference file', {
        error: error instanceof Error ? error.message : String(error),
        filename: referenceFile.filename,
        path: filePath,
      })
    }
  }

  return fileParts
}
