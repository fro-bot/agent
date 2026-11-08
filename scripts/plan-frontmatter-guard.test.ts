import {readdir, readFile as readFileFromDisk} from 'node:fs/promises'
import {join, relative} from 'node:path'
import {describe, expect, it} from 'vitest'
import {parse} from 'yaml'

/** Closed vocabulary for the `status:` field in docs/plans frontmatter. */
export const PLAN_STATUS_VALUES = ['done', 'active', 'superseded'] as const

/** Closed vocabulary for the `type:` field in docs/plans frontmatter. */
export const PLAN_TYPE_VALUES = ['feat', 'fix', 'refactor', 'docs'] as const

type PlanStatus = (typeof PLAN_STATUS_VALUES)[number]
type PlanType = (typeof PLAN_TYPE_VALUES)[number]

export interface PlanFrontmatterDocument {
  readonly file: string
  readonly content: string
}

const REQUIRED_FIELDS = ['title', 'type', 'status', 'date'] as const

function isPlanStatus(value: string): value is PlanStatus {
  return (PLAN_STATUS_VALUES as readonly string[]).includes(value)
}

function isPlanType(value: string): value is PlanType {
  return (PLAN_TYPE_VALUES as readonly string[]).includes(value)
}

/**
 * Directories Systematic's past-work search reads (`systematic_search` kinds: solution, plan, brainstorm,
 * ideation). A document whose frontmatter is not valid YAML is skipped by that search ("invalid frontmatter"),
 * so every one of them must parse — not only plans.
 */
export const SEARCHED_DOC_DIRECTORIES = ['docs/plans', 'docs/brainstorms', 'docs/ideation', 'docs/solutions'] as const

/**
 * Parses the whole frontmatter block as YAML and requires a mapping. Documents without a frontmatter block are
 * ignored here; plan-specific presence rules live in `validatePlanFrontmatter`.
 */
export function validateFrontmatterYaml(documents: readonly PlanFrontmatterDocument[]): readonly string[] {
  const violations: string[] = []

  for (const document of documents) {
    const opening = /^---\r?\n/.exec(document.content)
    if (opening == null) continue

    const remainder = document.content.slice(opening[0].length)
    const closing = /\r?\n---(?:\r?\n|$)/.exec(remainder)
    if (closing == null) continue

    const problem = describeYamlProblem(remainder.slice(0, closing.index))
    if (problem != null) violations.push(`${document.file}: ${problem}`)
  }

  return violations
}

function describeYamlProblem(block: string): string | null {
  let parsed: unknown
  try {
    parsed = parse(block)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return `frontmatter is not valid YAML: ${message.split('\n')[0]?.replace(/:$/, '')}`
  }

  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return 'frontmatter is valid YAML but not a mapping'
  }
  return null
}

export function validatePlanFrontmatter(documents: readonly PlanFrontmatterDocument[]): readonly string[] {
  const violations: string[] = []

  for (const document of documents) {
    const opening = /^---\r?\n/.exec(document.content)
    if (opening == null) {
      violations.push(`${document.file}: missing YAML frontmatter; expected opening and closing --- markers`)
      continue
    }

    // Deliberately not a YAML parser: every required field is a simple scalar on its own line.
    // A value containing a line-anchored `---`, or a folded/block scalar, would end the block
    // early or be skipped — reported as a missing field rather than passing silently.
    const remainder = document.content.slice(opening[0].length)
    const closing = /\r?\n---(?:\r?\n|$)/.exec(remainder)
    if (closing == null) {
      violations.push(`${document.file}: missing YAML frontmatter closing marker ---`)
      continue
    }

    const yamlProblem = describeYamlProblem(remainder.slice(0, closing.index))
    if (yamlProblem != null) {
      violations.push(`${document.file}: ${yamlProblem}`)
      continue
    }

    const fields = new Map<string, string>()
    for (const line of remainder.slice(0, closing.index).split(/\r?\n/)) {
      const separator = line.indexOf(':')
      if (separator < 1) continue

      const fieldName = line.slice(0, separator).trim()
      if (/^\w[\w-]*$/.test(fieldName) === false) continue

      const rawValue = line.slice(separator + 1).trim()
      const value =
        rawValue.length >= 2 &&
        ((rawValue.startsWith('"') && rawValue.endsWith('"')) || (rawValue.startsWith("'") && rawValue.endsWith("'")))
          ? rawValue.slice(1, -1)
          : rawValue
      fields.set(fieldName, value)
    }

    for (const requiredField of REQUIRED_FIELDS) {
      const value = fields.get(requiredField)
      if (value == null) {
        violations.push(`${document.file}: missing required frontmatter field '${requiredField}'`)
      } else if (value.length === 0) {
        violations.push(`${document.file}: required frontmatter field '${requiredField}' is empty`)
      }
    }

    const status = fields.get('status')
    if (status != null && status.length > 0 && isPlanStatus(status) === false) {
      violations.push(`${document.file}: invalid status '${status}'; expected one of: ${PLAN_STATUS_VALUES.join(', ')}`)
    }

    const type = fields.get('type')
    if (type != null && type.length > 0 && isPlanType(type) === false) {
      violations.push(`${document.file}: invalid type '${type}'; expected one of: ${PLAN_TYPE_VALUES.join(', ')}`)
    }
  }

  return violations
}

async function collectMarkdownFiles(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, {withFileTypes: true})
  const sorted = [...entries].sort((left, right) => left.name.localeCompare(right.name))
  const nested = await Promise.all(
    sorted.map(async entry => {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) return collectMarkdownFiles(path)
      return entry.isFile() && entry.name.endsWith('.md') ? [path] : []
    }),
  )
  return nested.flat()
}

async function loadDocuments(root: string, directory: string): Promise<readonly PlanFrontmatterDocument[]> {
  const paths = await collectMarkdownFiles(join(root, directory))
  return Promise.all(
    paths.map(async path => ({file: relative(root, path), content: await readFileFromDisk(path, 'utf8')})),
  )
}

function documentWithFrontmatter(frontmatter: string): PlanFrontmatterDocument {
  return {file: 'docs/plans/example.md', content: `---\n${frontmatter}\n---\n`}
}

describe('validatePlanFrontmatter', () => {
  it('reports an invalid status with the offending file and value', () => {
    // #given a plan document that invents a status value
    const violations = validatePlanFrontmatter([
      documentWithFrontmatter('title: Example\ntype: feat\nstatus: completed\ndate: 2026-01-01'),
    ])

    // #when / #then
    expect(violations).toContain(
      "docs/plans/example.md: invalid status 'completed'; expected one of: done, active, superseded",
    )
  })

  it('reports an invalid type with the offending file and value', () => {
    // #given a plan document that invents a type value
    const violations = validatePlanFrontmatter([
      documentWithFrontmatter('title: Example\ntype: chore\nstatus: done\ndate: 2026-01-01'),
    ])

    // #when / #then
    expect(violations).toContain(
      "docs/plans/example.md: invalid type 'chore'; expected one of: feat, fix, refactor, docs",
    )
  })

  it('reports every missing required field for a plan document', () => {
    // #given a plan document without required fields
    const violations = validatePlanFrontmatter([documentWithFrontmatter('title: Example')])

    // #when / #then
    expect(violations).toEqual([
      "docs/plans/example.md: missing required frontmatter field 'type'",
      "docs/plans/example.md: missing required frontmatter field 'status'",
      "docs/plans/example.md: missing required frontmatter field 'date'",
    ])
  })

  it('reports all independent frontmatter violations for one plan document', () => {
    // #given a plan document with invalid status and type values
    const violations = validatePlanFrontmatter([
      documentWithFrontmatter('title: Example\ntype: chore\nstatus: completed\ndate: 2026-01-01'),
    ])

    // #when / #then
    expect(violations).toEqual([
      "docs/plans/example.md: invalid status 'completed'; expected one of: done, active, superseded",
      "docs/plans/example.md: invalid type 'chore'; expected one of: feat, fix, refactor, docs",
    ])
  })

  it('reports a missing YAML frontmatter block with the offending file', () => {
    // #given a plan document without YAML frontmatter
    const violations = validatePlanFrontmatter([{file: 'docs/plans/example.md', content: '# Example\n'}])

    // #when / #then
    expect(violations).toEqual([
      'docs/plans/example.md: missing YAML frontmatter; expected opening and closing --- markers',
    ])
  })
})

describe('frontmatter YAML validity', () => {
  it('reports an unquoted title containing a colon-space as invalid YAML with the file and parser error', () => {
    // #given a plan whose title holds an unquoted `fix: ` (a nested mapping in a plain scalar)
    const document = documentWithFrontmatter('title: fix: Improve timeout\ntype: fix\nstatus: done\ndate: 2026-01-01')

    // #when
    const violations = validatePlanFrontmatter([document])

    // #then only the YAML failure is reported, naming the file and the parser's message
    expect(violations).toEqual([
      'docs/plans/example.md: frontmatter is not valid YAML: Nested mappings are not allowed in compact mappings at line 1, column 8',
    ])
  })

  it('reports an unquoted optional shipped value containing a colon-space as invalid YAML', () => {
    // #given a plan whose optional `shipped` value embeds `fro-bot: {key}` unquoted
    const document = documentWithFrontmatter(
      "title: Example\ntype: feat\nstatus: done\ndate: 2026-01-01\nshipped: 2026-03-22 onward ('fro-bot: {key}' titles)",
    )

    // #when
    const violations = validatePlanFrontmatter([document])

    // #then
    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatch(/^docs\/plans\/example\.md: frontmatter is not valid YAML: /)
  })

  it('accepts the quoted equivalents of the malformed title and shipped values', () => {
    // #given the same values, fully quoted
    const document = documentWithFrontmatter(
      'title: "fix: Improve timeout"\ntype: fix\nstatus: done\ndate: 2026-01-01\nshipped: "2026-03-22 onward (\'fro-bot: {key}\' titles)"',
    )

    // #when / #then
    expect(validatePlanFrontmatter([document])).toEqual([])
  })

  it('reports frontmatter that parses to a non-mapping', () => {
    // #given a frontmatter block that is a YAML sequence
    const violations = validateFrontmatterYaml([documentWithFrontmatter('- a\n- b')])

    // #when / #then
    expect(violations).toEqual(['docs/plans/example.md: frontmatter is valid YAML but not a mapping'])
  })

  it('ignores documents without a complete frontmatter block', () => {
    // #given non-plan docs that carry no frontmatter
    const violations = validateFrontmatterYaml([{file: 'docs/solutions/example.md', content: '# Example\n'}])

    // #when / #then
    expect(violations).toEqual([])
  })
})

describe('docs/plans frontmatter guard', () => {
  it('keeps every plan document inside the required frontmatter contract', async () => {
    // #given every Markdown plan document on disk
    const documents = await loadDocuments(process.cwd(), 'docs/plans')

    // #when
    const violations = validatePlanFrontmatter(documents)

    // #then
    expect(violations.join('\n')).toBe('')
  })
})

describe('searched docs frontmatter YAML guard', () => {
  it.each(SEARCHED_DOC_DIRECTORIES)('keeps every %s frontmatter block parseable as a YAML mapping', async directory => {
    // #given every Markdown document in a directory Systematic past-work search reads
    const documents = await loadDocuments(process.cwd(), directory)

    // #when
    const violations = validateFrontmatterYaml(documents)

    // #then
    expect(violations.join('\n')).toBe('')
  })
})
