import type {FileChange} from './types.js'

import {describe, expect, it} from 'vitest'
import {validateBrokeredPushFiles} from './brokered-push-validation.js'

function contentChange(path: string): FileChange {
  return {path, content: 'content'}
}

describe('validateBrokeredPushFiles', () => {
  it('accepts allowlisted product, package, documentation, and top-level documentation paths', () => {
    // #given
    const files = [
      contentChange('src/foo.ts'),
      contentChange('packages/runtime/src/x.ts'),
      contentChange('packages/gateway/src/a/b.ts'),
      contentChange('docs/y.md'),
      contentChange('README.md'),
      contentChange('ARCHITECTURE.md'),
      contentChange('STRUCTURE.md'),
    ]

    // #when
    const result = validateBrokeredPushFiles(files)

    // #then
    expect(result).toEqual({valid: true, errors: []})
  })

  it.each([
    '.github/workflows/ci.yaml',
    'Makefile',
    'Dockerfile',
    'scripts/x.sh',
    '.husky/pre-commit',
    '.npmrc',
    '.mise.toml',
    'deploy/x.ts',
    'package.json',
    'bun.lock',
    'tsconfig.json',
    'foo.md',
  ])('rejects denied path %s', path => {
    // #given
    const files = [contentChange(path)]

    // #when
    const result = validateBrokeredPushFiles(files)

    // #then
    expect(result.valid).toBe(false)
    expect(result.errors).toContain(`${path}: path is not allowed for brokered push`)
  })

  it('rejects a deletion of a denied path', () => {
    // #given
    const files: readonly FileChange[] = [{path: 'package.json', deleted: true}]

    // #when
    const result = validateBrokeredPushFiles(files)

    // #then
    expect(result.valid).toBe(false)
    expect(result.errors).toContain('package.json: path is not allowed for brokered push')
    if (result.valid) throw new Error('Expected validation failure')
    expect(result.paths).toEqual(['package.json'])
  })

  it('accepts a deletion of an allowlisted path', () => {
    // #given
    const files: readonly FileChange[] = [{path: 'src/old.ts', deleted: true}]

    // #when
    const result = validateBrokeredPushFiles(files)

    // #then
    expect(result).toEqual({valid: true, errors: []})
  })

  it.each(['../escape.txt', 'src/.env'])('retains existing validation for %s', path => {
    // #given
    const files = [contentChange(path)]

    // #when
    const result = validateBrokeredPushFiles(files)

    // #then
    expect(result.valid).toBe(false)
    expect(result.errors.length).toBeGreaterThan(0)
    if (result.valid) throw new Error('Expected validation failure')
    expect(result.paths).toContain(path)
  })

  it('returns every offending path with the validation messages', () => {
    // #given several changes outside the brokered allowlist
    const files = [
      contentChange('.github/workflows/ci.yml'),
      contentChange('scripts/release.sh'),
      contentChange('foo.md'),
    ]

    // #when validating the complete change set
    const result = validateBrokeredPushFiles(files)

    // #then all rejected paths are available without parsing the error strings
    expect(result.valid).toBe(false)
    if (result.valid) throw new Error('Expected validation failure')
    expect(result.paths).toEqual(['.github/workflows/ci.yml', 'scripts/release.sh', 'foo.md'])
  })

  it('accepts an empty file list as a no-op', () => {
    // #given
    const files: readonly FileChange[] = []

    // #when
    const result = validateBrokeredPushFiles(files)

    // #then
    expect(result).toEqual({valid: true, errors: []})
  })

  it('accepts a consumer-layout path with an opted-in prefix', () => {
    // #given a consumer application path outside the default allowlist
    const files = [contentChange('apps/web/src/index.ts')]

    // #when the consumer opts into the apps prefix
    const result = validateBrokeredPushFiles(files, ['apps'])

    // #then the segment-boundary prefix admits the change
    expect(result).toEqual({valid: true, errors: []})
  })

  it.each([
    'apps/web/package.json',
    'apps/web/Dockerfile',
    'apps/web/dockerfile',
    'apps/web/Package.json',
    'apps/web/bun.lock',
    'apps/deploy/scripts/release.ts',
    'apps/web/.github/workflows/ci.yml',
    'apps/web/.GitHub/workflows/ci.yml',
    'apps/web/.npmrc',
    'apps/web/.gitmodules',
  ])('rejects protected nested path %s under an opted-in prefix', path => {
    // #given a protected file nested under a consumer prefix
    const result = validateBrokeredPushFiles([contentChange(path)], ['apps'])

    // #then the validation-class error names the offending file
    expect(result.valid).toBe(false)
    if (result.valid) throw new Error('Expected validation failure')
    expect(result.errors.some(error => error.includes(path))).toBe(true)
    expect(result.paths).toContain(path)
  })

  it('rejects the complete protected nested-path repro under an opted-in prefix', () => {
    // #given the reviewer's five-file protected-surface repro
    const files = [
      contentChange('apps/web/package.json'),
      contentChange('apps/web/.github/workflows/ci.yml'),
      contentChange('apps/web/Dockerfile'),
      contentChange('apps/web/bun.lock'),
      contentChange('apps/deploy/scripts/release.ts'),
    ]

    // #when the apps prefix is opted in
    const result = validateBrokeredPushFiles(files, ['apps'])

    // #then no protected nested path is deliverable
    expect(result.valid).toBe(false)
    if (result.valid) throw new Error('Expected validation failure')
    for (const file of files) expect(result.errors.some(error => error.includes(file.path))).toBe(true)
  })

  it('admits non-protected paths nested under an opted-in prefix', () => {
    // #given product source and a scripts-data directory, which is not scripts
    const files = [contentChange('apps/web/src/index.ts'), contentChange('apps/web/scripts-data/x.ts')]

    // #when the apps prefix is opted in
    const result = validateBrokeredPushFiles(files, ['apps'])

    // #then both files remain deliverable
    expect(result).toEqual({valid: true, errors: []})
  })

  it('keeps the default allowlist unchanged when no extra prefixes are supplied', () => {
    // #given a consumer-layout path and no opt-in
    const files = [contentChange('apps/web/src/index.ts')]

    // #when validating with the default configuration
    const result = validateBrokeredPushFiles(files, [])

    // #then the path remains denied
    expect(result.valid).toBe(false)
    expect(result.errors).toContain('apps/web/src/index.ts: path is not allowed for brokered push')
  })

  it.each(['src/dockerfile', 'src/Package.json', 'src/.GitHub/workflows/ci.yml'])(
    'keeps case-variant protected names deliverable on the default axis when %s is allowlisted',
    path => {
      // #given a case-variant protected name under the default source prefix
      const result = validateBrokeredPushFiles([contentChange(path)])

      // #then default-axis admission remains unchanged; protected-surface checks apply to opted-in extras
      expect(result).toEqual({valid: true, errors: []})
    },
  )

  it('matches extra prefixes only at segment boundaries and treats overlaps as a union', () => {
    // #given sibling and nested paths plus overlapping extra prefixes
    const files = [
      contentChange('apps/web/src/index.ts'),
      contentChange('apps/web/tests/index.ts'),
      contentChange('apps-legacy/x.ts'),
      contentChange('src/extra.ts'),
    ]

    // #when validating with overlapping prefixes and a default prefix
    const result = validateBrokeredPushFiles(files, ['apps', 'apps/web', 'src'])

    // #then only the sibling directory remains outside the union
    expect(result.valid).toBe(false)
    expect(result.errors).toContain('apps-legacy/x.ts: path is not allowed for brokered push')
    expect(result.errors).not.toContain('apps/web/src/index.ts: path is not allowed for brokered push')
    expect(result.errors).not.toContain('apps/web/tests/index.ts: path is not allowed for brokered push')
  })

  it.each(['./apps/x.ts', 'apps/./x.ts', 'apps//x.ts'])('rejects non-canonical extra-path file %s', path => {
    // #given a file that matches the extra prefix only after normalization
    const result = validateBrokeredPushFiles([contentChange(path)], ['apps'])

    // #then validation rejects the non-canonical spelling and names it
    expect(result.valid).toBe(false)
    if (result.valid) throw new Error('Expected validation failure')
    expect(result.errors).toContain(`${path}: path is not canonical for brokered push`)
    expect(result.paths).toContain(path)
  })

  it.each(['src//x.ts', 'src/./x.ts'])('rejects non-canonical default-path file %s', path => {
    // #given a file admitted by the default source prefix only after Git normalizes its spelling
    const result = validateBrokeredPushFiles([contentChange(path)])

    // #then validation catches the latent Git tree API failure before delivery
    expect(result.valid).toBe(false)
    if (result.valid) throw new Error('Expected validation failure')
    expect(result.errors).toContain(`${path}: path is not canonical for brokered push`)
    expect(result.paths).toContain(path)
  })

  it('accepts a canonical default-path file', () => {
    // #given a plainly spelled file under the default source prefix
    const result = validateBrokeredPushFiles([contentChange('src/x.ts')])

    // #then the existing default-axis behavior remains unchanged
    expect(result).toEqual({valid: true, errors: []})
  })

  it('names the overlapping protected surface rather than echoing a containing prefix', () => {
    // #given a prefix that contains the protected deploy/scripts surface
    const result = validateBrokeredPushFiles([], ['deploy'])

    // #then the enforcement error identifies the actual protected surface
    expect(result.valid).toBe(false)
    if (result.valid) throw new Error('Expected validation failure')
    expect(result.errors).toContain('deploy: path prefix overlaps protected brokered-push surface deploy/scripts')
  })

  it.each([
    {path: 'apps/.env', content: 'secret'},
    {path: 'apps/large.bin', content: 'x'.repeat(5 * 1024 * 1024 + 1)},
    {path: 'apps/../.github/workflows/ci.yml', content: 'unsafe'},
  ])('never bypasses shared validation for $path', file => {
    // #given a file denied by the shared validation floor
    const files = [file]

    // #when the containing apps prefix is opted in
    const result = validateBrokeredPushFiles(files, ['apps'])

    // #then the shared floor still rejects the change
    expect(result.valid).toBe(false)
    if (result.valid) throw new Error('Expected validation failure')
    expect(result.paths).toContain(file.path)
  })

  it('rechecks protected extra prefixes at enforcement time', () => {
    // #given a caller that bypasses the parser with a protected surface prefix
    const prefix = '.github'

    // #when validating an otherwise empty change set
    const result = validateBrokeredPushFiles([], [prefix])

    // #then enforcement rejects the prefix and names it
    expect(result.valid).toBe(false)
    if (result.valid) throw new Error('Expected validation failure')
    expect(result.errors).toContain(`${prefix}: path prefix overlaps protected brokered-push surface .github`)
  })

  it.each(['', '.'])('fails closed for a direct malformed prefix bypass: %j', prefix => {
    // #given a caller bypassing parse-time prefix validation
    const result = validateBrokeredPushFiles([], [prefix])

    // #then enforcement rejects the malformed prefix
    expect(result.valid).toBe(false)
    if (result.valid) throw new Error('Expected validation failure')
    expect(result.errors.some(error => error.includes(prefix))).toBe(true)
  })

  it('rejects malformed extra prefixes and does not admit protected files through them', () => {
    // #given a caller that bypasses the parser with a traversal-bearing protected prefix
    const prefix = 'docs/../.github/'
    const protectedFile = contentChange('.github/workflows/ci.yml')

    // #when validating an empty change set and a protected file with that prefix
    const emptyResult = validateBrokeredPushFiles([], [prefix])
    const fileResult = validateBrokeredPushFiles([protectedFile], [prefix])

    // #then the malformed entry is named and cannot widen the allowlist
    expect(emptyResult.valid).toBe(false)
    if (emptyResult.valid) throw new Error('Expected validation failure')
    expect(emptyResult.errors.some(error => error.includes(prefix))).toBe(true)
    expect(fileResult.valid).toBe(false)
    if (fileResult.valid) throw new Error('Expected validation failure')
    expect(fileResult.errors).toContain(`${protectedFile.path}: path is not allowed for brokered push`)
    expect(fileResult.paths).toContain(protectedFile.path)
  })

  it('accepts the maximum brokered push file count', () => {
    // #given exactly the configured maximum number of allowlisted changes
    const files = Array.from({length: 100}, (_, index) => contentChange(`src/file-${index}.ts`))

    // #when validating the change set
    const result = validateBrokeredPushFiles(files)

    // #then the boundary is accepted
    expect(result).toEqual({valid: true, errors: []})
  })

  it('rejects a brokered push that exceeds the maximum file count', () => {
    // #given one more file than the configured maximum
    const files = Array.from({length: 101}, (_, index) => contentChange(`src/file-${index}.ts`))

    // #when validating the change set
    const result = validateBrokeredPushFiles(files)

    // #then validation fails before API fanout can begin
    expect(result.valid).toBe(false)
    expect(result.errors).toContain('Brokered push exceeds the maximum of 100 files')
  })
})
