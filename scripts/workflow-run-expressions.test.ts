import {readdirSync, readFileSync} from 'node:fs'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'
import {parse} from 'yaml'

// Template expressions in a `run:` body are expanded into shell source before the shell parses
// it, so any attacker-influenced value (step output, ref name, dispatch input) becomes code.
// Values must reach `run:` steps through the step's `env:` and be read as quoted shell variables.
// See https://github.com/fro-bot/agent/issues/2102.

const REPO_ROOT = join(import.meta.dirname, '..')
const TEMPLATE_EXPRESSION = /\$\{\{[\s\S]*?\}\}/g

function listYamlFiles(dir: string, recursive: boolean): readonly string[] {
  return readdirSync(join(REPO_ROOT, dir), {withFileTypes: true}).flatMap(entry => {
    const relative = join(dir, entry.name)
    if (entry.isDirectory()) return recursive ? listYamlFiles(relative, recursive) : []
    return /\.ya?ml$/.test(entry.name) ? [relative] : []
  })
}

function collectRunBodies(node: unknown, found: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) collectRunBodies(item, found)
  } else if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'run' && typeof value === 'string') found.push(value)
      else collectRunBodies(value, found)
    }
  }
  return found
}

const WORKFLOW_FILES = [
  ...listYamlFiles('.github/workflows', false),
  ...listYamlFiles('.github/actions', true).filter(file => /action\.ya?ml$/.test(file)),
]

describe('workflow run steps', () => {
  it('discovers the workflow and composite action files', () => {
    expect(WORKFLOW_FILES.length).toBeGreaterThan(0)
  })

  it.each(WORKFLOW_FILES)('%s has no template expressions inside run: bodies', file => {
    // #given the parsed YAML of a workflow or composite action
    const document: unknown = parse(readFileSync(join(REPO_ROOT, file), 'utf8'))

    // #when collecting every run: body
    const offending = collectRunBodies(document).flatMap(body => body.match(TEMPLATE_EXPRESSION) ?? [])

    // #then none carries an inline expression (pass it through env: instead)
    expect(offending).toEqual([])
  })
})
