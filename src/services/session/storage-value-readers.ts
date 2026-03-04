export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v != null
export const readString = (v: unknown): string | null => (typeof v === 'string' ? v : null)
export const readNumber = (v: unknown): number | null => (typeof v === 'number' ? v : null)
export const readBoolean = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null)
