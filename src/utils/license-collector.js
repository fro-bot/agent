export function buildLicenseTypeMap(entries) {
  const map = new Map()

  for (const [licenseKey, items] of Object.entries(entries)) {
    for (const item of items) {
      const versions = item.versions ?? (item.version != null ? [item.version] : [])
      const licenseType = item.license ?? licenseKey

      for (const version of versions) {
        map.set(`${item.name}@${version}`, licenseType)
      }
    }
  }

  return map
}
