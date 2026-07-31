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
  })

  it('accepts an empty file list as a no-op', () => {
    // #given
    const files: readonly FileChange[] = []

    // #when
    const result = validateBrokeredPushFiles(files)

    // #then
    expect(result).toEqual({valid: true, errors: []})
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
