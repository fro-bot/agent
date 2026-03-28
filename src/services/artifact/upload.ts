import type {Logger} from '../../shared/logger.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {DefaultArtifactClient} from '@actions/artifact'

export interface ArtifactUploadOptions {
  readonly logPath: string
  readonly runId: number
  readonly runAttempt: number
  readonly retentionDays?: number
  readonly compressionLevel?: number
  readonly logger: Logger
}

export async function uploadLogArtifact(options: ArtifactUploadOptions): Promise<boolean> {
  const {logPath, runId, runAttempt, retentionDays = 7, compressionLevel = 9, logger} = options

  try {
    await fs.access(logPath)
  } catch {
    logger.info('Log directory does not exist, skipping artifact upload', {logPath})
    return false
  }

  const files = await collectFiles(logPath)
  if (files.length === 0) {
    logger.info('No log files found, skipping artifact upload', {logPath})
    return false
  }

  const artifactName = `opencode-logs-${runId}-${runAttempt}`
  const client = new DefaultArtifactClient()

  try {
    const result = await client.uploadArtifact(artifactName, files, logPath, {
      retentionDays,
      compressionLevel,
    })

    logger.info('Artifact uploaded', {
      name: artifactName,
      size: result.size ?? null,
      id: result.id ?? null,
      fileCount: files.length,
    })
    return true
  } catch (error) {
    logger.warning('Artifact upload failed (non-fatal)', {
      error: error instanceof Error ? error.message : String(error),
      name: artifactName,
    })
    return false
  }
}

async function collectFiles(directory: string): Promise<string[]> {
  const files: string[] = []
  const entries = await fs.readdir(directory, {recursive: true, withFileTypes: true})
  for (const entry of entries) {
    if (entry.isFile()) {
      files.push(path.join(entry.parentPath, entry.name))
    }
  }
  return files
}
