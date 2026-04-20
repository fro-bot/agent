import type {Logger} from '../../../../src/shared/logger.js'
import type {ObjectStoreAdapter, ObjectStoreConfig} from './types.js'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {toErrorMessage} from '../../../../src/shared/errors.js'
import {buildObjectStoreKey} from './key-builder.js'
import {validateDownloadPath} from './validation.js'

const SESSION_DB_FILENAMES = ['opencode.db', 'opencode.db-wal', 'opencode.db-shm'] as const
const MAIN_DB_FILENAME = 'opencode.db' as const

function getSessionDbDirectory(sessionStoragePath: string): string {
  return path.dirname(sessionStoragePath)
}

function getSessionDbPath(sessionStoragePath: string, fileName: (typeof SESSION_DB_FILENAMES)[number]): string {
  return path.join(getSessionDbDirectory(sessionStoragePath), fileName)
}

function buildSessionsPrefix(config: ObjectStoreConfig, identity: string, repo: string): string | null {
  const result = buildObjectStoreKey(config, identity, repo, 'sessions')
  return result.success ? result.data : null
}

async function listFilesRecursively(rootPath: string): Promise<string[]> {
  const entries = await fs.readdir(rootPath, {withFileTypes: true})
  const files = await Promise.all(
    entries.map(async entry => {
      const entryPath = path.join(rootPath, entry.name)
      if (entry.isDirectory()) {
        return listFilesRecursively(entryPath)
      }
      if (entry.isFile()) {
        return [entryPath]
      }
      return []
    }),
  )

  return files.flat().sort((left, right) => left.localeCompare(right))
}

function toArtifactKey(prefix: string, runId: string, relativePath: string): string {
  const normalizedRelativePath = relativePath.split(path.sep).join('/')
  return `${prefix}${runId}/${normalizedRelativePath}`
}

export async function syncSessionsToStore(
  adapter: ObjectStoreAdapter,
  config: ObjectStoreConfig,
  identity: string,
  repo: string,
  sessionStoragePath: string,
  logger: Logger,
): Promise<{uploaded: number; failed: number}> {
  const prefix = buildSessionsPrefix(config, identity, repo)
  if (prefix == null) {
    logger.warning('Failed to build object store sessions prefix for upload', {identity, repo})
    return {uploaded: 0, failed: 0}
  }

  let uploaded = 0
  let failed = 0

  for (const fileName of SESSION_DB_FILENAMES) {
    const localPath = getSessionDbPath(sessionStoragePath, fileName)
    try {
      await fs.access(localPath)
    } catch {
      continue
    }

    const result = await adapter.upload(`${prefix}${fileName}`, localPath)
    if (result.success) {
      uploaded++
      continue
    }

    failed++
    logger.warning('Failed to upload session database file to object store', {
      key: `${prefix}${fileName}`,
      localPath,
      error: toErrorMessage(result.error),
    })
  }

  return {uploaded, failed}
}

export async function syncSessionsFromStore(
  adapter: ObjectStoreAdapter,
  config: ObjectStoreConfig,
  identity: string,
  repo: string,
  sessionStoragePath: string,
  logger: Logger,
): Promise<{downloaded: number; failed: number; mainDbRestored: boolean}> {
  const prefix = buildSessionsPrefix(config, identity, repo)
  if (prefix == null) {
    logger.warning('Failed to build object store sessions prefix for download', {identity, repo})
    return {downloaded: 0, failed: 0, mainDbRestored: false}
  }

  const listedKeys = await adapter.list(prefix)
  if (listedKeys.success === false) {
    logger.warning('Failed to list object store session files', {
      prefix,
      error: toErrorMessage(listedKeys.error),
    })
    return {downloaded: 0, failed: 1, mainDbRestored: false}
  }

  if (listedKeys.data.length === 0) {
    return {downloaded: 0, failed: 0, mainDbRestored: false}
  }

  const dbDirectory = getSessionDbDirectory(sessionStoragePath)
  let downloaded = 0
  let failed = 0
  let mainDbRestored = false

  for (const key of listedKeys.data) {
    const relativePath = key.startsWith(prefix) ? key.slice(prefix.length) : key
    const localPathResult = validateDownloadPath(dbDirectory, relativePath)

    if (localPathResult.success === false) {
      failed++
      logger.warning('Rejected object store session key during download', {
        key,
        error: toErrorMessage(localPathResult.error),
      })
      continue
    }

    await fs.mkdir(path.dirname(localPathResult.data), {recursive: true})
    const downloadResult = await adapter.download(key, localPathResult.data)
    if (downloadResult.success) {
      downloaded++
      if (path.basename(localPathResult.data) === MAIN_DB_FILENAME) {
        mainDbRestored = true
      }
      continue
    }

    failed++
    logger.warning('Failed to download session database file from object store', {
      key,
      localPath: localPathResult.data,
      error: toErrorMessage(downloadResult.error),
    })
  }

  return {downloaded, failed, mainDbRestored}
}

export async function syncArtifactsToStore(
  adapter: ObjectStoreAdapter,
  config: ObjectStoreConfig,
  identity: string,
  repo: string,
  runId: string,
  logPath: string,
  logger: Logger,
): Promise<{uploaded: number; failed: number}> {
  try {
    await fs.access(logPath)
  } catch {
    return {uploaded: 0, failed: 0}
  }

  let uploaded = 0
  let failed = 0
  const files = await listFilesRecursively(logPath)
  const prefixResult = buildObjectStoreKey(config, identity, repo, 'artifacts')

  if (prefixResult.success === false) {
    logger.warning('Failed to build object store artifact prefix for upload', {
      runId,
      error: toErrorMessage(prefixResult.error),
    })
    return {uploaded: 0, failed: 0}
  }

  for (const filePath of files) {
    const relativePath = path.relative(logPath, filePath)
    const key = toArtifactKey(prefixResult.data, runId, relativePath)

    const uploadResult = await adapter.upload(key, filePath)
    if (uploadResult.success) {
      uploaded++
      continue
    }

    failed++
    logger.warning('Failed to upload artifact file to object store', {
      key,
      filePath,
      error: toErrorMessage(uploadResult.error),
    })
  }

  return {uploaded, failed}
}

export async function syncMetadataToStore(
  adapter: ObjectStoreAdapter,
  config: ObjectStoreConfig,
  identity: string,
  repo: string,
  runId: string,
  metadata: unknown,
  logger: Logger,
): Promise<{success: boolean}> {
  const keyResult = buildObjectStoreKey(config, identity, repo, 'metadata', `${runId}.json`)
  if (keyResult.success === false) {
    logger.warning('Failed to build object store metadata key for upload', {
      runId,
      error: toErrorMessage(keyResult.error),
    })
    return {success: false}
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fro-bot-metadata-'))
  const tempFilePath = path.join(tempDir, `${runId}.json`)

  try {
    await fs.writeFile(tempFilePath, JSON.stringify(metadata, null, 2), 'utf8')
    const uploadResult = await adapter.upload(keyResult.data, tempFilePath)
    if (uploadResult.success === false) {
      logger.warning('Failed to upload run metadata to object store', {
        key: keyResult.data,
        runId,
        error: toErrorMessage(uploadResult.error),
      })
      return {success: false}
    }

    return {success: true}
  } catch (error) {
    logger.warning('Failed to upload run metadata to object store', {
      key: keyResult.data,
      runId,
      error: toErrorMessage(error),
    })
    return {success: false}
  } finally {
    await fs.rm(tempDir, {recursive: true, force: true})
  }
}
