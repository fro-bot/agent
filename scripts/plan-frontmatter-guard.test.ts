import {readdir, readFile as readFileFromDisk} from 'node:fs/promises'
import {join, relative} from 'node:path'
import {describe, expect, it} from 'vitest'

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

export function validatePlanFrontmatter(documents: readonly PlanFrontmatterDocument[]): readonly string[] {
  const violations: string[] = []

  for (const document of documents) {
    const opening = /^---\r?\n/.exec(document.content)
    if (opening == null) {
      violations.push(`${document.file}: missing YAML frontmatter; expected opening and closing --- markers`)
      continue
    }

    const remainder = document.content.slice(opening[0].length)
    const closing = /\r?\n---(?:\r?\n|$)/.exec(remainder)
    if (closing == null) {
      violations.push(`${document.file}: missing YAML frontmatter closing marker ---`)
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

async function collectPlanFiles(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, {withFileTypes: true})
  return entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(entry => join(directory, entry.name))
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

describe('docs/plans frontmatter guard', () => {
  it('keeps every plan document inside the required frontmatter contract', async () => {
    // #given every Markdown plan document on disk
    const root = process.cwd()
    const paths = await collectPlanFiles(join(root, 'docs/plans'))
    const documents = await Promise.all(
      paths.map(async path => ({
        file: relative(root, path),
        content: await readFileFromDisk(path, 'utf8'),
      })),
    )

    // #when
    const violations = validatePlanFrontmatter(documents)

    // #then
    expect(violations.join('\n')).toBe('')
  })
})
