import * as core from '@actions/core'

export interface LogContext {
  readonly [key: string]: unknown
}

export interface Logger {
  readonly debug: (message: string, context?: LogContext) => void
  readonly info: (message: string, context?: LogContext) => void
  readonly warning: (message: string, context?: LogContext) => void
  readonly error: (message: string, context?: LogContext) => void
}

type LogLevel = 'debug' | 'error' | 'info' | 'warning'

/**
 * Default patterns for sensitive field names (case-insensitive, partial match)
 */
export const DEFAULT_SENSITIVE_FIELDS: readonly string[] = [
  'token',
  'password',
  'secret',
  'key',
  'auth',
  'credential',
  'bearer',
  'apikey',
  'api_key',
  'access_token',
  'refresh_token',
  'private',
] as const

const REDACTED = '[REDACTED]'

/**
 * Check if a field name matches any sensitive pattern (case-insensitive, partial match)
 */
function isSensitiveField(fieldName: string, sensitivePatterns: readonly string[]): boolean {
  const lowerFieldName = fieldName.toLowerCase()
  return sensitivePatterns.some(pattern => lowerFieldName.includes(pattern.toLowerCase()))
}

/**
 * Recursively redact sensitive fields from an object
 * Returns a new object with sensitive string values replaced by [REDACTED]
 */
export function redactSensitiveFields<T>(value: T, sensitivePatterns: readonly string[] = DEFAULT_SENSITIVE_FIELDS): T {
  // Handle null/undefined
  if (value == null) {
    return value
  }

  // Handle primitives (string, number, boolean)
  if (typeof value !== 'object') {
    return value
  }

  // Handle arrays
  if (Array.isArray(value)) {
    return value.map((item: unknown) => redactSensitiveFields(item, sensitivePatterns)) as T
  }

  // Handle objects
  const result: Record<string, unknown> = {}
  for (const [fieldName, fieldValue] of Object.entries(value)) {
    if (isSensitiveField(fieldName, sensitivePatterns) && typeof fieldValue === 'string') {
      result[fieldName] = REDACTED
    } else if (fieldValue != null && typeof fieldValue === 'object') {
      result[fieldName] = redactSensitiveFields(fieldValue, sensitivePatterns)
    } else {
      result[fieldName] = fieldValue
    }
  }

  return result as T
}

function formatLogEntry(level: LogLevel, message: string, baseContext: LogContext, callContext?: LogContext): string {
  const mergedContext = {
    ...baseContext,
    ...callContext,
  }

  // Redact sensitive fields before logging
  const redactedContext = redactSensitiveFields(mergedContext)

  const entry: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...redactedContext,
  }

  // Serialize Error objects properly (after redaction to preserve error structure)
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
