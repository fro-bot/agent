import type {LogContext, Logger} from '@fro-bot/runtime'
import * as core from '@actions/core'
import {DEFAULT_SENSITIVE_FIELDS, redactSensitiveFields} from '@fro-bot/runtime'

export type {LogContext, Logger}
export {DEFAULT_SENSITIVE_FIELDS, redactSensitiveFields}

type LogLevel = 'debug' | 'error' | 'info' | 'warning'

function formatLogEntry(level: LogLevel, message: string, baseContext: LogContext, callContext?: LogContext): string {
  const mergedContext = {
    ...baseContext,
    ...callContext,
  }

  const redactedContext = redactSensitiveFields(mergedContext, DEFAULT_SENSITIVE_FIELDS)

  const entry: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...redactedContext,
  }

  if (callContext != null && 'error' in callContext && callContext.error instanceof Error) {
    const errorObj = callContext.error
    entry.error = {
      message: errorObj.message,
      name: errorObj.name,
      stack: errorObj.stack,
    }
  }

  return JSON.stringify(entry)
}

export function createLogger(baseContext: LogContext): Logger {
  return {
    debug: (message: string, context?: LogContext): void => {
      core.debug(formatLogEntry('debug', message, baseContext, context))
    },
    info: (message: string, context?: LogContext): void => {
      core.info(formatLogEntry('info', message, baseContext, context))
    },
    warning: (message: string, context?: LogContext): void => {
      core.warning(formatLogEntry('warning', message, baseContext, context))
    },
    error: (message: string, context?: LogContext): void => {
      core.error(formatLogEntry('error', message, baseContext, context))
    },
  }
}
