import type {Logger} from '../../shared/logger.js'
import type {ObjectStoreAdapter, ObjectStoreConfig} from './types.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {toErrorMessage} from '../../shared/errors.js'
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
