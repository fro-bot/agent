export type PnpmLicenseEntry = {
  readonly name: string
  readonly versions?: readonly string[]
  readonly version?: string
  readonly license?: string | null
}

export type PnpmLicensesJson = Record<string, readonly PnpmLicenseEntry[]>

export function buildLicenseTypeMap(entries: PnpmLicensesJson): Map<string, string>
