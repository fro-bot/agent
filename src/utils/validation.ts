export function validateJsonString(value: string, fieldName: string): void {
  try {
    JSON.parse(value)
  } catch {
    throw new Error(`${fieldName} must be valid JSON`)
  }
}

export function validatePositiveInteger(value: string, fieldName: string): number {
  const trimmed = value.trim()
  // Reject non-numeric strings (decimals, signs, letters)
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`${fieldName} must be a positive integer, received: ${value}`)
  }

  const parsed = Number.parseInt(trimmed, 10)
  // Reject zero (regex already ensures parsed is finite and non-negative)
  if (parsed === 0) {
    throw new Error(`${fieldName} must be a positive integer, received: ${value}`)
  }
  return parsed
}

export function validateNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new TypeError(`${fieldName} must be a string, received ${typeof value}`)
  }
  if (value.trim().length === 0) {
    throw new Error(`${fieldName} cannot be empty`)
  }
  return value
}
