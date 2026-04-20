import process from 'node:process'

export interface LogContext {
  readonly [key: string]: unknown
}

export interface Logger {
  readonly debug: (message: string, context?: LogContext) => void
  readonly info: (message: string, context?: LogContext) => void
  readonly warning: (message: string, context?: LogContext) => void
  readonly error: (message: string, context?: LogContext) => void
}

export interface LogSink {
  readonly debug: (message: string) => void
  readonly info: (message: string) => void
  readonly warning: (message: string) => void
  readonly error: (message: string) => void
}

type LogLevel = 'debug' | 'error' | 'info' | 'warning'

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

function isSensitiveField(fieldName: string, sensitivePatterns: readonly string[]): boolean {
  const lowerFieldName = fieldName.toLowerCase()
  return sensitivePatterns.some(pattern => lowerFieldName.includes(pattern.toLowerCase()))
}

export function redactSensitiveFields<T>(value: T, sensitivePatterns: readonly string[] = DEFAULT_SENSITIVE_FIELDS): T {
  if (value == null) {
    return value
  }

  if (typeof value !== 'object') {
    return value
  }

  if (Array.isArray(value)) {
    return value.map((item: unknown) => redactSensitiveFields(item, sensitivePatterns)) as T
  }

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

  const redactedContext = redactSensitiveFields(mergedContext)

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

function createDefaultSink(): LogSink {
  return {
    debug: message => process.stdout.write(`${message}\n`),
    info: message => process.stdout.write(`${message}\n`),
    warning: message => console.warn(message),
    error: message => console.error(message),
  }
}

export function createLogger(baseContext: LogContext, sink: LogSink = createDefaultSink()): Logger {
  return {
    debug: (message: string, context?: LogContext): void => {
      sink.debug(formatLogEntry('debug', message, baseContext, context))
    },
    info: (message: string, context?: LogContext): void => {
      sink.info(formatLogEntry('info', message, baseContext, context))
    },
    warning: (message: string, context?: LogContext): void => {
      sink.warning(formatLogEntry('warning', message, baseContext, context))
    },
    error: (message: string, context?: LogContext): void => {
      sink.error(formatLogEntry('error', message, baseContext, context))
    },
  }
}
