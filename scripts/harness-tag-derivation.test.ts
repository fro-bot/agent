/* eslint-disable no-template-curly-in-string --
 * This guard asserts on shell and workflow string literals (`${BASE_VERSION}-harness.${SHORT_SHA}`,
 * `${OPENCODE_VERSION//+harness./-harness.}`). They are the data under test, not JS template
 * expressions, and must be compared verbatim against the real files.
 */
import {readFileSync} from 'node:fs'
import {join} from 'node:path'

import {describe, expect, it} from 'vitest'

const HARNESS_RELEASE_WORKFLOW = '.github/workflows/harness-release.yaml'
const WORKSPACE_DOCKERFILE = 'deploy/workspace.Dockerfile'
const OPENCODE_SETUP_MODULE = 'src/services/setup/opencode.ts'
const HARNESS_RELEASE_PREFIX = 'https://github.com/fro-bot/agent/releases/download/'
const EXPECTED_RELEASE_TAG_ASSIGNMENT = 'RELEASE_TAG="${BASE_VERSION}-harness.${SHORT_SHA}"'

export interface HarnessTagSources {
  readonly harnessReleaseWorkflow: string
  readonly workspaceDockerfile: string
  readonly opencodeSetupModule: string
}

function assertWorkflowDerivations(source: string): void {
  const assignments = source
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.startsWith('RELEASE_TAG='))

  if (assignments.length !== 2) {
    throw new Error(
      `${HARNESS_RELEASE_WORKFLOW}: expected exactly two RELEASE_TAG= derivations for ` +
        `${EXPECTED_RELEASE_TAG_ASSIGNMENT}; found ${assignments.length}`,
    )
  }

  const unexpectedAssignment = assignments.find(line => line !== EXPECTED_RELEASE_TAG_ASSIGNMENT)
  if (unexpectedAssignment !== undefined) {
    throw new Error(
      `${HARNESS_RELEASE_WORKFLOW}: expected every RELEASE_TAG= derivation to be ` +
        `${EXPECTED_RELEASE_TAG_ASSIGNMENT}; found ${unexpectedAssignment}`,
    )
  }
}

function assertDockerfileDerivation(source: string): void {
  const lines = source.split(/\r?\n/)
  const releaseUrlLines = lines.filter(line => line.includes(`base_url="${HARNESS_RELEASE_PREFIX}`))
  if (releaseUrlLines.length !== 1) {
    throw new Error(
      `${WORKSPACE_DOCKERFILE}: expected exactly one harness release base_url construction using a ` +
        '-harness.-derived tag; found ' +
        `${releaseUrlLines.length}`,
    )
  }

  const releaseUrlLine = releaseUrlLines[0]
  if (releaseUrlLine === undefined) {
    throw new Error(`${WORKSPACE_DOCKERFILE}: expected a harness release base_url construction`)
  }
  if (releaseUrlLine.includes('%2B')) {
    throw new Error(
      `${WORKSPACE_DOCKERFILE}: expected the harness release URL to use a -harness.-derived tag, ` + 'not %2B encoding',
    )
  }

  const tagDerivationPattern = /&&\s+([A-Za-z_]\w*)="\$\{OPENCODE_VERSION\/\/\+harness\.\/-harness\.\}"/
  let tagVariable: string | undefined
  for (const line of lines.slice(0, lines.indexOf(releaseUrlLine)).reverse()) {
    const match = line.match(tagDerivationPattern)
    if (match !== null && match[1] !== undefined) {
      tagVariable = match[1]
      break
    }
  }

  if (tagVariable === undefined) {
    throw new Error(
      `${WORKSPACE_DOCKERFILE}: expected the harness release tag derivation to replace ` +
        '+harness. with -harness. before building base_url',
    )
  }
  if (releaseUrlLine.includes(`\${${tagVariable}}`) === false) {
    throw new Error(
      `${WORKSPACE_DOCKERFILE}: expected the harness release base_url to use the ` +
        `-harness.-derived tag variable ${tagVariable}`,
    )
  }
}

function assertOpencodeSetupConversion(source: string): void {
  // Coupling contract: this guard matches source text, so refactoring the matched expression requires updating it.
  const sourceWithoutComments = stripCommentsPreservingStrings(source)
  const functionStart = sourceWithoutComments.indexOf('function toHarnessReleaseTag')
  const functionBodyStart = functionStart === -1 ? -1 : sourceWithoutComments.indexOf('{', functionStart)
  let functionEnd = -1
  if (functionBodyStart !== -1) {
    let braceDepth = 0
    for (let index = functionBodyStart; index < sourceWithoutComments.length; index += 1) {
      const character = sourceWithoutComments[index]
      if (character === '{') braceDepth += 1
      if (character === '}') {
        braceDepth -= 1
        if (braceDepth === 0) {
          functionEnd = index + 1
          break
        }
      }
    }
  }
  const functionSource = functionEnd === -1 ? '' : sourceWithoutComments.slice(functionBodyStart, functionEnd)
  const hasHyphenConversionCall = functionSource.split(/\r?\n/).some(line => {
    const hasReplaceCall = line.includes('.replace(') || line.includes('.replaceAll(')
    const hasHyphenTarget = line.includes("'-harness.'") || line.includes('"-harness."') || line.includes('`-harness.`')
    return hasReplaceCall && hasHyphenTarget
  })
  if (hasHyphenConversionCall === false) {
    throw new Error(
      `${OPENCODE_SETUP_MODULE}: expected toHarnessReleaseTag to replace the harness marker with '-harness.'`,
    )
  }
}

type CommentStripState = 'code' | 'single-quote' | 'double-quote' | 'template' | 'line-comment' | 'block-comment'

function stripCommentsPreservingStrings(source: string): string {
  let state: CommentStripState = 'code'
  let result = ''

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    const nextCharacter = source[index + 1]
    if (character === undefined) continue

    if (state === 'code') {
      if (character === '/' && nextCharacter === '/') {
        state = 'line-comment'
        index += 1
      } else if (character === '/' && nextCharacter === '*') {
        state = 'block-comment'
        index += 1
      } else if (character === "'") {
        state = 'single-quote'
        result += character
      } else if (character === '"') {
        state = 'double-quote'
        result += character
      } else if (character === '`') {
        state = 'template'
        result += character
      } else {
        result += character
      }
    } else if (state === 'line-comment') {
      if (character === '\n') {
        state = 'code'
        result += character
      }
    } else if (state === 'block-comment') {
      if (character === '*' && nextCharacter === '/') {
        state = 'code'
        index += 1
      } else if (character === '\n') {
        result += character
      }
    } else {
      const quote = state === 'single-quote' ? "'" : state === 'double-quote' ? '"' : '`'
      result += character
      if (character === '\\' && nextCharacter !== undefined) {
        result += nextCharacter
        index += 1
      } else if (character === quote) {
        state = 'code'
      }
    }
  }

  return result
}

export function assertHarnessTagDerivations(sources: HarnessTagSources): void {
  assertWorkflowDerivations(sources.harnessReleaseWorkflow)
  assertDockerfileDerivation(sources.workspaceDockerfile)
  assertOpencodeSetupConversion(sources.opencodeSetupModule)
}

function readHarnessTagSources(root: string): HarnessTagSources {
  return {
    harnessReleaseWorkflow: readFileSync(join(root, HARNESS_RELEASE_WORKFLOW), 'utf8'),
    workspaceDockerfile: readFileSync(join(root, WORKSPACE_DOCKERFILE), 'utf8'),
    opencodeSetupModule: readFileSync(join(root, OPENCODE_SETUP_MODULE), 'utf8'),
  }
}

const VALID_WORKFLOW = [
  'RELEASE_TAG="${BASE_VERSION}-harness.${SHORT_SHA}"',
  'RELEASE_TAG="${BASE_VERSION}-harness.${SHORT_SHA}"',
].join('\n')

const VALID_DOCKERFILE = [
  '&& unrelated_url="https://example.test/releases/download/%2B" \\',
  '&& tag_version="${OPENCODE_VERSION//+harness./-harness.}" \\',
  `&& base_url="${HARNESS_RELEASE_PREFIX}\${tag_version}" \\`,
].join('\n')

const VALID_SETUP_MODULE =
  'function toHarnessReleaseTag(version: string): string {\n  return version.replace(HARNESS_MARKER, "-harness.")\n}'

function validSources(): HarnessTagSources {
  return {
    harnessReleaseWorkflow: VALID_WORKFLOW,
    workspaceDockerfile: VALID_DOCKERFILE,
    opencodeSetupModule: VALID_SETUP_MODULE,
  }
}

describe('harness tag derivation guard', () => {
  it('accepts matching workflow, Dockerfile, and setup-module producers', () => {
    // #given synthetic producers that all use the public -harness. release-tag form
    // #when the pure guard checks their file contents
    // #then the producers agree without inspecting the filesystem
    expect(() => assertHarnessTagDerivations(validSources())).not.toThrow()
  })

  it('requires exactly two workflow RELEASE_TAG= derivations', () => {
    // #given a workflow with an additional release-tag assignment
    const sources = validSources()
    const workflow = `${sources.harnessReleaseWorkflow}\n${EXPECTED_RELEASE_TAG_ASSIGNMENT}`

    // #when / #then the extra producer is rejected loudly
    expect(() => assertHarnessTagDerivations({...sources, harnessReleaseWorkflow: workflow})).toThrow(
      `${HARNESS_RELEASE_WORKFLOW}: expected exactly two RELEASE_TAG= derivations`,
    )
  })

  it('rejects a legacy +harness. workflow derivation', () => {
    // #given a workflow that still constructs the old build-metadata tag
    const sources = validSources()
    const workflow = sources.harnessReleaseWorkflow.replaceAll('-harness.', '+harness.')

    // #when / #then the failure names the workflow and expected form
    expect(() => assertHarnessTagDerivations({...sources, harnessReleaseWorkflow: workflow})).toThrow(
      `${HARNESS_RELEASE_WORKFLOW}: expected every RELEASE_TAG= derivation to be ${EXPECTED_RELEASE_TAG_ASSIGNMENT}`,
    )
  })

  it('rejects a legacy %2B Dockerfile derivation', () => {
    // #given a Dockerfile that percent-encodes + for the harness release URL
    const sources = validSources()
    const dockerfile = sources.workspaceDockerfile
      .replace(
        '&& tag_version="${OPENCODE_VERSION//+harness./-harness.}"',
        '&& encoded_version="${OPENCODE_VERSION//+/%2B}"',
      )
      .replace('${tag_version}', '${encoded_version}')

    // #when / #then the failure names the Dockerfile and expected form
    expect(() => assertHarnessTagDerivations({...sources, workspaceDockerfile: dockerfile})).toThrow(
      `${WORKSPACE_DOCKERFILE}: expected the harness release tag derivation to replace +harness. with -harness.`,
    )
  })

  it('does not confuse unrelated %2B URLs with the harness release URL', () => {
    // #given an unrelated URL containing percent-encoded + alongside a valid harness URL
    // #when / #then only the scoped harness URL construction is checked
    expect(() => assertDockerfileDerivation(VALID_DOCKERFILE)).not.toThrow()
  })

  it('rejects a setup conversion reverted to +harness. despite an unrelated hyphen literal', () => {
    // #given a setup module whose conversion emits +harness. while another string retains -harness.
    const sources = validSources()
    const setupModule =
      'function toHarnessReleaseTag(version: string): string {\n  return version.replace(HARNESS_MARKER, "+harness.")\n}\n' +
      'const publicTag = "-harness."'

    // #when / #then the conversion call site, not the unrelated literal, determines the result
    expect(() => assertHarnessTagDerivations({...sources, opencodeSetupModule: setupModule})).toThrow(
      `${OPENCODE_SETUP_MODULE}: expected toHarnessReleaseTag to replace the harness marker with '-harness.'`,
    )
  })

  it('rejects a setup conversion rescued only by a trailing comment', () => {
    // #given a reverted conversion whose expected target appears only in a trailing comment
    const sources = validSources()
    const setupModule = `function toHarnessReleaseTag(version: string): string {
  return version.replace(HARNESS_MARKER, "+harness.") // version.replace(HARNESS_MARKER, '-harness.')
}`

    // #when / #then the trailing comment cannot satisfy the conversion guard
    expect(() => assertHarnessTagDerivations({...sources, opencodeSetupModule: setupModule})).toThrow(
      `${OPENCODE_SETUP_MODULE}: expected toHarnessReleaseTag to replace the harness marker with '-harness.'`,
    )
  })
})

describe('checked-in harness tag producers', () => {
  it('keep the workflow, Dockerfile, and setup module aligned', () => {
    // #given the checked-in producer files
    const sources = readHarnessTagSources(process.cwd())

    // #when / #then all three producers must agree on the public release-tag form
    expect(() => assertHarnessTagDerivations(sources)).not.toThrow()
  })
})
