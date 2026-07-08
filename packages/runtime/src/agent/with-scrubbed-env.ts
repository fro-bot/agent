// Brackets a synchronous child spawn (createOpencode spreads {...process.env}
// into the child) with a temporary reduction of process.env to the
// allowlisted set produced by filterAgentEnv. This ensures the model's bash
// child never inherits GH_TOKEN / GITHUB_TOKEN / other secrets (#1147).
//
// This is a SCOPED scrub, not a global process.env reduction: the removed
// keys are restored immediately after the spawn (in a `finally`) so the
// harness itself keeps AWS_*/proxy vars it needs afterward (e.g. for the S3
// cache backend, which reads ambient AWS_* env after the spawn returns).

import type {Logger} from '../shared/logger.js'
import process from 'node:process'
import {filterAgentEnv} from './filter-env.js'

export async function withScrubbedEnv<T>(fn: () => Promise<T>, logger: Logger): Promise<T> {
  const removed: [string, string][] = []

  try {
    const filtered = filterAgentEnv(process.env)
    for (const key of Object.keys(process.env)) {
      if (!(key in filtered)) {
        const value = process.env[key]
        if (value !== undefined) {
          removed.push([key, value])
          delete process.env[key]
        }
      }
    }
    logger.info('Scrubbed agent env for spawn', {removedCount: removed.length})
  } catch (error) {
    // Fail-closed: restore anything already removed and do not call fn.
    for (const [key, value] of removed) {
      process.env[key] = value
    }
    throw error
  }

  try {
    return await fn()
  } finally {
    for (const [key, value] of removed) {
      process.env[key] = value
    }
  }
}
