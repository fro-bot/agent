import {Buffer} from 'node:buffer'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {redactSecrets} from '../packages/harness/src/format-error.js'

const MAX_DIAGNOSTIC_SCAN_BYTES = 65_536
const MAX_RESPONSE_DIAGNOSTIC_BYTES = 65_536
const RESPONSE_DIAGNOSTIC_TRUNCATION_MARKER = '\n\n[response truncated at 65536 bytes]\n'
const DIAGNOSTIC_TRUNCATION_MARKER = '\n\n[diagnostic truncated at 65536 bytes]\n'
const DIAGNOSTIC_OVERSIZED_MARKER = '[diagnostic omitted: source exceeded the safe read budget]\n'
const MAX_DIAGNOSTIC_ENTRIES = 64
const EXPECTED_DIAGNOSTIC_EXTENSIONS = ['.jsonl', '.log'] as const
const REDACTED = '[REDACTED]'

interface SafeDiagnosticRead {
  readonly text: string | null
  readonly oversized: boolean
}

function diagnosticsDirectory(originalCwd: string, scenarioId: string): string {
  return path.join(originalCwd, 'evals', 'output', 'diagnostics', scenarioId)
}

function isExpectedDiagnosticFile(filePath: string): boolean {
  return EXPECTED_DIAGNOSTIC_EXTENSIONS.some(extension => filePath.endsWith(extension))
}

function redactDiagnosticSecrets(text: string, secretValues: readonly string[]): string {
  let result = text
  for (const secret of [...secretValues].sort((left, right) => right.length - left.length)) {
    if (secret.length > 0) {
      result = result.replaceAll(secret, REDACTED)
    }
  }

  result = redactSecrets(result)
  result = result.replaceAll(/(?:sk|rk)-[\w-]{8,}/g, REDACTED)
  result = result.replaceAll(/Bearer\s+[\w.~+/=-]{8,}/gi, `Bearer ${REDACTED}`)
  return result
}

function restrictDiagnosticsDirectory(directory: string): void {
  try {
    fs.chmodSync(directory, 0o700)
  } catch {
    // Diagnostics are fail-soft evidence; preserve best-effort behavior on unsupported filesystems.
  }

  visitImmediateEntries(directory, entry => {
    if (entry.isFile() === true) {
      try {
        fs.chmodSync(path.join(directory, entry.name), 0o600)
      } catch {
        // Diagnostics are fail-soft evidence; preserve best-effort behavior on unsupported filesystems.
      }
    }
  })
}

function visitImmediateEntries(directory: string, visit: (entry: fs.Dirent) => void): void {
  let directoryHandle: fs.Dir
  try {
    directoryHandle = fs.opendirSync(directory)
  } catch {
    return
  }

  try {
    for (let inspected = 0; inspected < MAX_DIAGNOSTIC_ENTRIES; inspected += 1) {
      const entry = directoryHandle.readSync()
      if (entry == null) {
        return
      }
      visit(entry)
    }
  } finally {
    try {
      directoryHandle.closeSync()
    } catch {
      // Diagnostics are fail-soft evidence and must never change the eval result.
    }
  }
}

function readSafeDiagnosticFile(filePath: string): SafeDiagnosticRead {
  let fileDescriptor: number | null = null
  try {
    fileDescriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    const initialStats = fs.fstatSync(fileDescriptor)
    if (initialStats.size > MAX_DIAGNOSTIC_SCAN_BYTES) {
      return {text: null, oversized: true}
    }

    const buffer = Buffer.alloc(initialStats.size)
    let bytesRead = 0
    while (bytesRead < initialStats.size) {
      const count = fs.readSync(fileDescriptor, buffer, bytesRead, initialStats.size - bytesRead, bytesRead)
      if (count === 0) {
        return {text: null, oversized: true}
      }
      bytesRead += count
    }

    const finalStats = fs.fstatSync(fileDescriptor)
    if (finalStats.size !== initialStats.size) {
      return {text: null, oversized: true}
    }
    return {text: buffer.toString('utf8'), oversized: false}
  } catch {
    return {text: null, oversized: false}
  } finally {
    if (fileDescriptor != null) {
      try {
        fs.closeSync(fileDescriptor)
      } catch {
        // Diagnostics are fail-soft evidence and must never change the eval result.
      }
    }
  }
}

function boundDiagnostic(text: string, maxBytes: number, marker: string): string {
  if (maxBytes <= 0) {
    return ''
  }

  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= maxBytes) {
    return text
  }

  const markerBytes = Buffer.byteLength(marker, 'utf8')
  if (markerBytes > maxBytes) {
    return ''
  }

  let suffix = bytes.subarray(bytes.length - (maxBytes - markerBytes)).toString('utf8')
  while (Buffer.byteLength(suffix, 'utf8') + markerBytes > maxBytes) {
    suffix = suffix.slice(1)
  }
  return `${marker}${suffix}`
}

function diagnosticContent(
  sourcePath: string,
  remainingBytes: number,
  secretValues: readonly string[],
): {readonly content: string; readonly bytesWritten: number} {
  const diagnostic = readSafeDiagnosticFile(sourcePath)
  const redacted =
    diagnostic.oversized === true
      ? DIAGNOSTIC_OVERSIZED_MARKER
      : diagnostic.text == null
        ? ''
        : redactDiagnosticSecrets(diagnostic.text, secretValues)
  const content = boundDiagnostic(redacted, remainingBytes, DIAGNOSTIC_TRUNCATION_MARKER)
  return {content, bytesWritten: Buffer.byteLength(content, 'utf8')}
}

export function clearScenarioDiagnostics(originalCwd: string, scenarioId: string): void {
  try {
    fs.rmSync(diagnosticsDirectory(originalCwd, scenarioId), {recursive: true, force: true})
  } catch {
    // Diagnostics are fail-soft evidence and must never block the evaluation itself.
  }
}

export function captureDiagnostics(
  sourceLogDirectory: string,
  originalCwd: string,
  scenarioId: string,
  secretValues: readonly string[],
): string | null {
  if (fs.existsSync(sourceLogDirectory) === false) {
    return null
  }

  const targetDirectory = diagnosticsDirectory(originalCwd, scenarioId)
  try {
    fs.mkdirSync(targetDirectory, {recursive: true, mode: 0o700})
    restrictDiagnosticsDirectory(targetDirectory)
    let remainingBytes = MAX_DIAGNOSTIC_SCAN_BYTES

    visitImmediateEntries(sourceLogDirectory, entry => {
      if (remainingBytes === 0) {
        return
      }

      const sourcePath = path.join(sourceLogDirectory, entry.name)
      const targetPath = path.join(targetDirectory, entry.name)
      if (entry.isSymbolicLink() === true || entry.isDirectory() === true) {
        return
      }
      if (entry.isFile() !== true || isExpectedDiagnosticFile(entry.name) === false) {
        return
      }

      const diagnostic = diagnosticContent(sourcePath, remainingBytes, secretValues)
      if (diagnostic.bytesWritten === 0) {
        return
      }
      fs.writeFileSync(targetPath, diagnostic.content, {encoding: 'utf8', mode: 0o600})
      fs.chmodSync(targetPath, 0o600)
      remainingBytes -= diagnostic.bytesWritten
    })
    restrictDiagnosticsDirectory(targetDirectory)
    return targetDirectory
  } catch {
    return null
  }
}

export function persistResponseDiagnostics(
  originalCwd: string,
  scenarioId: string,
  rawResponse: string,
  secretValues: readonly string[],
): string | null {
  const targetDirectory = diagnosticsDirectory(originalCwd, scenarioId)
  try {
    fs.mkdirSync(targetDirectory, {recursive: true, mode: 0o700})
    restrictDiagnosticsDirectory(targetDirectory)
    const responsePath = path.join(targetDirectory, 'response.md')
    const redactedResponse = redactDiagnosticSecrets(rawResponse, secretValues)
    const boundedResponse = boundDiagnostic(
      redactedResponse,
      MAX_RESPONSE_DIAGNOSTIC_BYTES,
      RESPONSE_DIAGNOSTIC_TRUNCATION_MARKER,
    )
    fs.writeFileSync(responsePath, boundedResponse, {encoding: 'utf8', mode: 0o600})
    fs.chmodSync(responsePath, 0o600)
    return targetDirectory
  } catch {
    return null
  }
}

export function readCapturedDiagnostics(diagnosticsPath: string | null, secretValues: readonly string[] = []): string {
  if (diagnosticsPath == null) {
    return ''
  }

  const chunks: string[] = []
  let remainingBytes = MAX_DIAGNOSTIC_SCAN_BYTES
  visitImmediateEntries(diagnosticsPath, entry => {
    if (remainingBytes === 0) {
      return
    }
    const entryPath = path.join(diagnosticsPath, entry.name)
    if (entry.isSymbolicLink() === true || entry.isDirectory() === true) {
      return
    }
    if (entry.isFile() === true && isExpectedDiagnosticFile(entry.name)) {
      const diagnostic = readSafeDiagnosticFile(entryPath)
      const sourceText = diagnostic.oversized === true ? DIAGNOSTIC_OVERSIZED_MARKER : (diagnostic.text ?? '')
      const content = boundDiagnostic(
        redactDiagnosticSecrets(sourceText, secretValues),
        remainingBytes,
        DIAGNOSTIC_TRUNCATION_MARKER,
      )
      const bytesRead = Buffer.byteLength(content, 'utf8')
      if (bytesRead > 0) {
        chunks.push(content)
        remainingBytes -= bytesRead
      }
    }
  })
  return chunks.join('\n')
}
