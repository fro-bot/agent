/**
 * Extract error message from unknown error.
 * @param error - Unknown value from catch block
 */
export function toErrorMessage(error: unknown): string {
  // A payload-owned coercion path (non-callable `toString`, a null prototype, or a throwing
  // getter) can make extraction itself throw; never let that escape an error-reporting helper.
  try {
    if (error instanceof Error) {
      return error.message
    }
    return String(error)
  } catch {
    return '[unprintable error]'
  }
}

/**
 * Wrap unknown error as Error instance.
 * @param error - Unknown value from catch block
 */
export function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error
  }
  return new Error(toErrorMessage(error))
}

/** Longest string `formatSdkError` returns; longer messages and JSON are cut with a trailing `...`. */
export const SDK_ERROR_MAX_LENGTH = 500

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function bounded(text: string): string {
  return text.length > SDK_ERROR_MAX_LENGTH ? `${text.slice(0, SDK_ERROR_MAX_LENGTH - 3)}...` : text
}

/**
 * Describe the `error` of an OpenCode SDK result for a log line or an error message.
 *
 * The SDK client does not throw on an HTTP error; it returns `{error}` where `error` is the parsed response body:
 * a plain object for a JSON body (`{name: 'NotFoundError', data: {message}}`), a string for a text body. `String()`
 * of the object is `[object Object]`, which hides the cause.
 *
 * Picks, in order: `data.message`, `message`, `name`, `type`; an Error gives its message; a string is returned as
 * is. Any other object is serialised as JSON. The result is cut at `SDK_ERROR_MAX_LENGTH`. Only the value it is
 * given is read, so no request header or body can appear. Never throws: anything unreadable or unserialisable
 * (circular, BigInt, a throwing getter) is `[unprintable error]`.
 */
export function formatSdkError(error: unknown): string {
  try {
    if (typeof error !== 'object' || error === null || error instanceof Error) return bounded(toErrorMessage(error))

    const envelope = error as {
      readonly data?: unknown
      readonly message?: unknown
      readonly name?: unknown
      readonly type?: unknown
    }
    const data =
      typeof envelope.data === 'object' && envelope.data !== null
        ? (envelope.data as {readonly message?: unknown})
        : undefined
    const described =
      nonEmptyString(data?.message) ??
      nonEmptyString(envelope.message) ??
      nonEmptyString(envelope.name) ??
      nonEmptyString(envelope.type)
    return bounded(described ?? JSON.stringify(error))
  } catch {
    return '[unprintable error]'
  }
}
