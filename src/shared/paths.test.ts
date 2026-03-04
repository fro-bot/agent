import * as path from 'node:path'
import {describe, expect, it} from 'vitest'
import {normalizeWorkspacePath} from './paths.js'

describe('normalizeWorkspacePath', () => {
  // #given an absolute path
  // #when normalizeWorkspacePath is called
  // #then it returns the same absolute path
  it('should return absolute path unchanged', () => {
    const result = normalizeWorkspacePath('/foo/bar')
    expect(result).toBe('/foo/bar')
  })

  // #given an absolute path with trailing slash
  // #when normalizeWorkspacePath is called
  // #then it removes the trailing slash
  it('should remove trailing slash from absolute path', () => {
    const result = normalizeWorkspacePath('/foo/bar/')
    expect(result).toBe('/foo/bar')
  })

  // #given a relative path
  // #when normalizeWorkspacePath is called
  // #then it resolves to absolute path
  it('should resolve relative path to absolute', () => {
    const result = normalizeWorkspacePath('relative/path')
    const expected = path.resolve('relative/path')
    expect(result).toBe(expected)
  })

  // #given an empty string
  // #when normalizeWorkspacePath is called
  // #then it resolves to current working directory
  it('should resolve empty string to current working directory', () => {
    const result = normalizeWorkspacePath('')
    const expected = path.resolve('')
    expect(result).toBe(expected)
  })
})
