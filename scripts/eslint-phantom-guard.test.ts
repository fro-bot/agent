import type {Linter} from 'eslint'
import {resolve} from 'node:path'
import {ESLint} from 'eslint'
import {describe, expect, it} from 'vitest'

// Resolve the repo root relative to this file's location so the ESLint config
// and packageDir paths are correct regardless of where vitest is invoked from.
const repoRoot = resolve(import.meta.dirname, '..')

// Virtual file path inside scripts/ (devDependencies allow-glob) so the
// phantom-dependency guard applies but devDep imports are also allowed.
// The file does NOT need to exist on disk — lintText supplies the content.
// We pass allowDefaultProject so the TS project service accepts virtual paths.
const VIRTUAL_FILE = resolve(repoRoot, 'scripts', '__phantom_probe__.ts')

const PHANTOM_RULE = 'import-x/no-extraneous-dependencies'

async function lintSnippet(code: string): Promise<Linter.LintMessage[]> {
  const eslint = new ESLint({
    overrideConfigFile: resolve(repoRoot, 'eslint.config.ts'),
    warnIgnored: false,
    overrideConfig: [
      {
        // Allow the virtual probe path through the TS project service without
        // requiring the file to exist on disk.
        languageOptions: {
          parserOptions: {
            projectService: {
              allowDefaultProject: ['scripts/__phantom_probe__.ts'],
            },
          },
        },
      },
    ],
  })
  const [result] = await eslint.lintText(code, {filePath: VIRTUAL_FILE})
  return result?.messages ?? []
}

describe('phantom-dependency lint guard — non-vacuousness proof', () => {
  it('fires import-x/no-extraneous-dependencies for a phantom import (semver: installed but declared nowhere)', async () => {
    // #given — semver is resolvable via hoisting but declared in no workspace manifest
    const phantomCode = `import semver from 'semver'\nexport const x = semver.valid('1.0.0')\n`

    // #when
    const messages = await lintSnippet(phantomCode)

    // #then — the guard must fire
    const phantomMessages = messages.filter(m => m.ruleId === PHANTOM_RULE)
    expect(phantomMessages, `Expected ${PHANTOM_RULE} to fire on phantom import of 'semver'`).toHaveLength(1)
    expect(phantomMessages[0]?.message).toMatch(/semver/)
  }, 30_000) // ESLint with TS project service can be slow on first run

  it('stays silent for a declared dependency (@actions/core: listed in root package.json)', async () => {
    // #given — @actions/core is declared in the root package.json dependencies
    const cleanCode = `import core from '@actions/core'\nexport const x = core.getInput('test')\n`

    // #when
    const messages = await lintSnippet(cleanCode)

    // #then — the guard must NOT fire
    const phantomMessages = messages.filter(m => m.ruleId === PHANTOM_RULE)
    expect(
      phantomMessages,
      `Expected ${PHANTOM_RULE} to be silent for declared dep '@actions/core', got: ${JSON.stringify(phantomMessages)}`,
    ).toHaveLength(0)
  }, 30_000)
})
