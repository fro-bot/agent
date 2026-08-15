import {readFileSync} from 'node:fs'
import {describe, expect, it} from 'vitest'
import {parse} from 'yaml'

interface WorkflowStep {
  readonly id?: string
  readonly name?: string
  readonly if?: string
  readonly run?: string
  readonly env?: Record<string, unknown>
  readonly uses?: string
  readonly with?: Record<string, unknown>
}

interface WorkflowJob {
  readonly steps: readonly WorkflowStep[]
}

interface Workflow {
  readonly jobs: Record<string, WorkflowJob>
}

interface RoutingScenario {
  readonly eventName: string
  readonly releaseTag: string
  readonly correlationId: string
  readonly prompt: string
  readonly useWikiPrompt: boolean
  readonly schedule: string
  readonly workflowRef: string
  readonly repository: string
  readonly ref: string
}

interface RoutingResult {
  readonly checkoutToken: string
  readonly mint: boolean
  readonly actionToken: string
}

type ExpressionValue = boolean | string

const WORKFLOW_PATH = process.env.FRO_BOT_WORKFLOW_TEST_PATH ?? '.github/workflows/fro-bot.yaml'
const HARNESS_INTEGRATE_WORKFLOW_PATH = '.github/workflows/harness-integrate.yaml'
const REPOSITORY = 'fro-bot/agent'
const DIRECT_REF = 'refs/heads/main'
const DIRECT_WORKFLOW_REF = `${REPOSITORY}/.github/workflows/fro-bot.yaml@${DIRECT_REF}`
const CALLER_WORKFLOW_REF = `${REPOSITORY}/.github/workflows/harness-release.yaml@${DIRECT_REF}`
const GITHUB_TOKEN = 'github-token'
const MINTED_TOKEN = 'minted-token'
const PAT = 'pat-token'

function loadWorkflow(path = WORKFLOW_PATH): Workflow {
  const parsed = parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  return {jobs: parsed.jobs as Record<string, WorkflowJob>}
}

function loadRawWorkflow(path: string): Record<string, unknown> {
  return parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

function rawJob(path: string, name: string): Record<string, unknown> {
  const workflow = loadRawWorkflow(path)
  const jobs = workflow.jobs
  if (jobs === null || typeof jobs !== 'object' || Array.isArray(jobs)) throw new TypeError(`${path} jobs are missing`)
  const job = (jobs as Record<string, unknown>)[name]
  if (job === null || typeof job !== 'object' || Array.isArray(job)) {
    throw new TypeError(`${path} job ${name} is missing`)
  }
  return job as Record<string, unknown>
}

function stepsFor(path: string, jobName: string): Record<string, unknown>[] {
  const job = rawJob(path, jobName)
  if (!Array.isArray(job.steps)) throw new TypeError(`${path} job ${jobName} steps are missing`)
  return job.steps.filter((step): step is Record<string, unknown> => step !== null && typeof step === 'object')
}

function stepById(steps: readonly Record<string, unknown>[], id: string): Record<string, unknown> {
  const step = steps.find(value => value.id === id)
  if (step === undefined) throw new TypeError(`step ${id} is missing`)
  return step
}

function loadFroBotJob(): WorkflowJob {
  const job = loadWorkflow().jobs['fro-bot']
  if (job === undefined) {
    throw new Error('fro-bot job is missing')
  }
  return job
}

function findStep(job: WorkflowJob, predicate: (step: WorkflowStep) => boolean): WorkflowStep {
  const step = job.steps.find(predicate)
  if (step === undefined) {
    throw new TypeError('expected workflow step is missing')
  }
  return step
}

function stepIndex(job: WorkflowJob, predicate: (step: WorkflowStep) => boolean): number {
  const index = job.steps.findIndex(predicate)
  if (index === -1) {
    throw new TypeError('expected workflow step is missing')
  }
  return index
}

function expressionFrom(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new TypeError(`${label} must be a string expression`)
  }
  const expression = value.trim()
  if (!expression.startsWith('${{') || !expression.endsWith('}}')) {
    throw new TypeError(`${label} must be a GitHub expression`)
  }
  return expression.slice(3, -2).trim()
}

function splitTopLevel(expression: string, operator: '&&' | '||'): string[] {
  const parts: string[] = []
  let depth = 0
  let quote: "'" | undefined
  let start = 0

  for (let index = 0; index < expression.length; index += 1) {
    const character = expression[index]
    if (character === "'") {
      quote = quote === undefined ? "'" : undefined
      continue
    }
    if (quote !== undefined) {
      continue
    }
    if (character === '(') {
      depth += 1
      continue
    }
    if (character === ')') {
      depth -= 1
      continue
    }
    if (depth === 0 && expression.startsWith(operator, index)) {
      parts.push(expression.slice(start, index).trim())
      start = index + operator.length
      index += operator.length - 1
    }
  }

  parts.push(expression.slice(start).trim())
  return parts
}

function isWrappedByOuterParens(expression: string): boolean {
  if (!expression.startsWith('(') || !expression.endsWith(')')) {
    return false
  }

  let depth = 0
  let quote: "'" | undefined
  for (let index = 0; index < expression.length; index += 1) {
    const character = expression[index]
    if (character === "'") {
      quote = quote === undefined ? "'" : undefined
      continue
    }
    if (quote !== undefined) {
      continue
    }
    if (character === '(') {
      depth += 1
    } else if (character === ')') {
      depth -= 1
      if (depth === 0 && index !== expression.length - 1) {
        return false
      }
    }
  }
  return depth === 0
}

function stripOuterParens(expression: string): string {
  let result = expression.trim()
  while (isWrappedByOuterParens(result)) {
    result = result.slice(1, -1).trim()
  }
  return result
}

function isTruthy(value: ExpressionValue): boolean {
  return value !== false && value !== ''
}

function evaluateAtom(atom: string, scenario: RoutingScenario, mintOutput: string): ExpressionValue {
  if (atom === "github.event.inputs.release-tag != ''") {
    return scenario.releaseTag !== ''
  }
  if (atom === "github.event.inputs.release-tag == ''") {
    return scenario.releaseTag === ''
  }
  if (atom === "github.event.inputs.correlation-id != ''") {
    return scenario.correlationId !== ''
  }
  if (atom === "inputs.prompt != ''") {
    return scenario.prompt !== ''
  }
  if (atom === "github.event.inputs.use-wiki-prompt == 'true'") {
    return scenario.useWikiPrompt
  }
  if (atom === "github.event.schedule == '0 20 * * 0'") {
    return scenario.schedule === '0 20 * * 0'
  }
  if (atom === 'github.token') {
    return GITHUB_TOKEN
  }
  if (atom === 'steps.mint-app-token.outputs.github-token') {
    return mintOutput
  }
  if (atom === 'secrets.FRO_BOT_PAT') {
    return PAT
  }

  const stringLiteralMatch = /^'([^']*)'$/.exec(atom)
  if (stringLiteralMatch !== null) {
    return stringLiteralMatch[1] ?? ''
  }

  const eventNameMatch = /^github\.event_name == '([^']*)'$/.exec(atom)
  if (eventNameMatch !== null) {
    return scenario.eventName === eventNameMatch[1]
  }

  const workflowRefMatch =
    /^github\.workflow_ref == format\('\{0\}\/\.github\/workflows\/fro-bot\.yaml@\{1\}', github\.repository, github\.ref\)$/.exec(
      atom,
    )
  if (workflowRefMatch !== null) {
    return scenario.workflowRef === `${scenario.repository}/.github/workflows/fro-bot.yaml@${scenario.ref}`
  }

  throw new TypeError(`unsupported workflow expression atom: ${atom}`)
}

/**
 * Deliberately bounded evaluator for the token-routing expressions in this
 * workflow. It supports only literals, comparisons, &&, ||, and grouping
 * used by the checked-in checkout, mint, and action expressions.
 */
function evaluateExpression(expression: string, scenario: RoutingScenario, mintOutput: string): ExpressionValue {
  const normalized = stripOuterParens(expression)
  const orParts = splitTopLevel(normalized, '||')
  if (orParts.length > 1) {
    let result = evaluateExpression(orParts[0] ?? '', scenario, mintOutput)
    for (const part of orParts.slice(1)) {
      if (isTruthy(result)) {
        return result
      }
      result = evaluateExpression(part, scenario, mintOutput)
    }
    return result
  }

  const andParts = splitTopLevel(normalized, '&&')
  if (andParts.length > 1) {
    let result = evaluateExpression(andParts[0] ?? '', scenario, mintOutput)
    for (const part of andParts.slice(1)) {
      if (!isTruthy(result)) {
        return false
      }
      result = evaluateExpression(part, scenario, mintOutput)
    }
    return result
  }

  return evaluateAtom(normalized, scenario, mintOutput)
}

function resolveRouting(job: WorkflowJob, scenario: RoutingScenario): RoutingResult {
  const checkout = findStep(job, step => step.uses?.startsWith('actions/checkout@') === true)
  const mint = findStep(job, step => step.id === 'mint-app-token')
  const runFroBot = findStep(job, step => step.uses === './')
  const checkoutExpression = expressionFrom(checkout.with?.token, 'checkout token')
  const mintExpression = expressionFrom(mint.if, 'mint condition')
  const actionExpression = expressionFrom(runFroBot.with?.['github-token'], 'action token')
  const mintEnabled = isTruthy(evaluateExpression(mintExpression, scenario, ''))
  const actionMintOutput = mintEnabled ? MINTED_TOKEN : ''

  return {
    checkoutToken: String(evaluateExpression(checkoutExpression, scenario, '')),
    mint: mintEnabled,
    actionToken: String(evaluateExpression(actionExpression, scenario, actionMintOutput)),
  }
}

function resolveOutputModeCaller(job: WorkflowJob, routingScenario: RoutingScenario): string {
  const runFroBot = findStep(job, step => step.uses === './')
  const outputModeExpression = expressionFrom(runFroBot.with?.['output-mode'], 'output-mode')
  return String(evaluateExpression(outputModeExpression, routingScenario, ''))
}

function scenario(overrides: Partial<RoutingScenario>): RoutingScenario {
  return {
    eventName: 'issue_comment',
    releaseTag: '',
    correlationId: '',
    prompt: '',
    useWikiPrompt: false,
    schedule: '',
    workflowRef: DIRECT_WORKFLOW_REF,
    repository: REPOSITORY,
    ref: DIRECT_REF,
    ...overrides,
  }
}

const ROUTING_CASES = [
  {
    name: 'direct schedule with empty release-tag',
    input: scenario({eventName: 'schedule'}),
    expected: {checkoutToken: GITHUB_TOKEN, mint: true, actionToken: MINTED_TOKEN},
  },
  {
    name: 'direct workflow_dispatch with empty release-tag',
    input: scenario({eventName: 'workflow_dispatch'}),
    expected: {checkoutToken: GITHUB_TOKEN, mint: true, actionToken: MINTED_TOKEN},
  },
  {
    name: 'workflow_dispatch release narration',
    input: scenario({eventName: 'workflow_dispatch', releaseTag: 'v1.2.3'}),
    expected: {checkoutToken: GITHUB_TOKEN, mint: false, actionToken: GITHUB_TOKEN},
  },
  {
    name: 'reusable caller originating from workflow_dispatch',
    input: scenario({eventName: 'workflow_dispatch', workflowRef: CALLER_WORKFLOW_REF}),
    expected: {checkoutToken: PAT, mint: false, actionToken: PAT},
  },
  {
    name: 'reusable caller originating from schedule',
    input: scenario({eventName: 'schedule', workflowRef: CALLER_WORKFLOW_REF}),
    expected: {checkoutToken: PAT, mint: false, actionToken: PAT},
  },
  {
    name: 'issue_comment',
    input: scenario({eventName: 'issue_comment'}),
    expected: {checkoutToken: PAT, mint: false, actionToken: PAT},
  },
  {
    name: 'issues',
    input: scenario({eventName: 'issues'}),
    expected: {checkoutToken: PAT, mint: false, actionToken: PAT},
  },
  {
    name: 'pull_request',
    input: scenario({eventName: 'pull_request'}),
    expected: {checkoutToken: PAT, mint: false, actionToken: PAT},
  },
  {
    name: 'pull_request_review_comment',
    input: scenario({eventName: 'pull_request_review_comment'}),
    expected: {checkoutToken: PAT, mint: false, actionToken: PAT},
  },
] as const

describe('fro-bot workflow — owner-wide App token routing', () => {
  it.each(ROUTING_CASES)('routes $name from the checked-in expressions', ({input, expected}) => {
    // #given the parsed Fro Bot job and one supported GitHub event context
    const job = loadFroBotJob()

    // #when the bounded evaluator runs the actual workflow expressions
    const result = resolveRouting(job, input)

    // #then checkout, mint, and action auth follow the confirmed contract
    expect(result).toEqual(expected)
  })

  it('checks out before minting and runs Fro Bot after minting', () => {
    // #given the ordered Fro Bot job steps
    const job = loadFroBotJob()
    const checkout = stepIndex(job, step => step.uses?.startsWith('actions/checkout@') === true)
    const mint = stepIndex(job, step => step.id === 'mint-app-token')
    const runFroBot = stepIndex(job, step => step.uses === './')

    // #then the checked-out script exists before it is invoked, and minting precedes the action
    expect(checkout).toBeLessThan(mint)
    expect(mint).toBeLessThan(runFroBot)
  })

  it('rejects a broadened mint guard for a reusable caller', () => {
    // #given an in-memory neutralization of the direct-workflow guard
    const job = loadFroBotJob()
    const broadenedJob: WorkflowJob = {
      ...job,
      steps: job.steps.map(step =>
        step.id === 'mint-app-token'
          ? {
              ...step,
              if: ['${{', "github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'", '}}'].join(
                ' ',
              ),
            }
          : step,
      ),
    }

    // #when a reusable workflow caller has a workflow_dispatch event name
    const result = resolveRouting(
      broadenedJob,
      scenario({eventName: 'workflow_dispatch', workflowRef: CALLER_WORKFLOW_REF}),
    )

    // #then the neutralized expression demonstrably violates the PAT fallback contract
    expect(result).toEqual({checkoutToken: PAT, mint: true, actionToken: MINTED_TOKEN})
    expect(result).not.toEqual({checkoutToken: PAT, mint: false, actionToken: PAT})
  })

  it('keeps mint profile selection and credential ownership explicit', () => {
    // #given the mint step and every Fro Bot job step
    const job = loadFroBotJob()
    const mintStep = findStep(job, step => step.id === 'mint-app-token')
    const checkout = findStep(job, step => step.uses?.startsWith('actions/checkout@') === true)
    const checkoutToken = String(checkout.with?.token)

    // #then minting is a plain checked-in script with the closed owner-wide profile
    expect(mintStep.run).toBe('node --experimental-strip-types scripts/harness/mint-app-token.ts')
    expect(mintStep.env).toEqual({
      APPLICATION_ID: `\${{ secrets.APPLICATION_ID }}`,
      APPLICATION_PRIVATE_KEY: `\${{ secrets.APPLICATION_PRIVATE_KEY }}`,
      FRO_BOT_APP_TOKEN_PROFILE: 'owner-wide-workflow',
    })

    // #then checkout cannot depend on an output from the later mint step
    expect(checkoutToken).not.toContain('steps.mint-app-token.outputs.github-token')
    expect(checkout.with?.['persist-credentials']).toBe(false)

    const appCredentialSteps = job.steps.filter(step =>
      Object.keys(step.env ?? {}).some(name => ['APPLICATION_ID', 'APPLICATION_PRIVATE_KEY'].includes(name)),
    )
    expect(appCredentialSteps).toEqual([mintStep])
  })

  it('keeps release narration read-only and trusted apply isolated to FRO_BOT_PAT', () => {
    // #given the generate and apply jobs
    const workflow = loadWorkflow()
    const generate = workflow.jobs['fro-bot']
    const apply = workflow.jobs['apply-release-notes']
    if (generate === undefined || apply === undefined) {
      throw new TypeError('release-notes jobs are missing')
    }
    const applyPatSteps = apply.steps.filter(step =>
      Object.values(step.env ?? {}).includes(`\${{ secrets.FRO_BOT_PAT }}`),
    )

    // #then the generate action remains github.token for release narration
    const releaseResult = resolveRouting(generate, scenario({eventName: 'workflow_dispatch', releaseTag: 'v1.2.3'}))
    expect(releaseResult).toEqual({checkoutToken: GITHUB_TOKEN, mint: false, actionToken: GITHUB_TOKEN})

    // #then only the trusted apply command receives FRO_BOT_PAT in its job
    expect(applyPatSteps).toHaveLength(1)
    expect(applyPatSteps[0]?.env?.GH_TOKEN).toBe(`\${{ secrets.FRO_BOT_PAT }}`)
  })

  it('keeps confirmed manual output-mode callers explicit in the checked-in expression', () => {
    // #given the actual Fro Bot action call and representative manual trigger contexts
    const job = loadFroBotJob()

    // #when the workflow expression is evaluated for each confirmed caller path
    const wikiDispatch = resolveOutputModeCaller(job, scenario({eventName: 'workflow_dispatch', useWikiPrompt: true}))
    const wikiSchedule = resolveOutputModeCaller(job, scenario({eventName: 'schedule', schedule: '0 20 * * 0'}))
    const correlationDispatch = resolveOutputModeCaller(
      job,
      scenario({eventName: 'workflow_dispatch', correlationId: 'release-123'}),
    )
    const customPromptDispatch = resolveOutputModeCaller(
      job,
      scenario({eventName: 'workflow_dispatch', prompt: 'write a release summary'}),
    )
    const ordinaryManualDispatch = resolveOutputModeCaller(job, scenario({eventName: 'workflow_dispatch'}))

    // #then wiki paths request branch-pr, controlled local paths request working-dir, and fallback stays auto
    expect(wikiDispatch).toBe('branch-pr')
    expect(wikiSchedule).toBe('branch-pr')
    expect(correlationDispatch).toBe('working-dir')
    expect(customPromptDispatch).toBe('working-dir')
    expect(ordinaryManualDispatch).toBe('auto')
  })

  it('keeps harness integration on explicit working-dir output mode', () => {
    // #given the checked-in harness integration workflow
    const workflow = loadWorkflow(HARNESS_INTEGRATE_WORKFLOW_PATH)
    const job = workflow.jobs.integrate
    if (job === undefined) {
      throw new TypeError('integrate job is missing')
    }
    const runFroBot = findStep(job, step => step.uses === './')

    // #then the integration caller cannot fall back to prompt-sensitive inference
    expect(runFroBot.with?.['output-mode']).toBe('working-dir')
  })
})

describe('harness forward-shadow workflow wiring', () => {
  const integratePath = '.github/workflows/harness-integrate.yaml'
  const releasePath = '.github/workflows/harness-release.yaml'

  it('keeps harness-integrate to one job with unchanged permissions and no secret inheritance', () => {
    // #given
    const workflow = loadRawWorkflow(integratePath)
    const jobs = workflow.jobs
    if (jobs === null || typeof jobs !== 'object' || Array.isArray(jobs)) throw new TypeError('jobs are missing')
    const jobNames = Object.keys(jobs)
    const job = rawJob(integratePath, 'integrate')
    const workflowCall = workflow.on as Record<string, unknown>
    const call = workflowCall.workflow_call as Record<string, unknown>
    const inputs = call.inputs as Record<string, unknown>
    const secrets = call.secrets as Record<string, unknown>

    // #then
    expect(jobNames).toEqual(['integrate'])
    expect(job.permissions).toEqual({'id-token': 'write', contents: 'read'})
    expect((inputs['base-version'] as Record<string, unknown>).required).toBe(true)
    expect(Object.keys(secrets).sort()).toEqual([
      'APPLICATION_ID',
      'APPLICATION_PRIVATE_KEY',
      'OMO_PROVIDERS',
      'OPENCODE_CONFIG',
    ])
    expect(JSON.stringify(workflow)).not.toContain('secrets: inherit')
  })

  it('orders authoritative Run Fro Bot before shadow driver, record, and upload', () => {
    // #given
    const steps = stepsFor(integratePath, 'integrate')
    const mint = steps.findIndex(step => step.id === 'mint')
    const appMint = steps.findIndex(step => step.id === 'mint-app-token')
    const authoritative = steps.findIndex(step => step.name === 'Run Fro Bot')
    const shadow = steps.findIndex(step => step.id === 'shadow-integrate')
    const record = steps.findIndex(step => step.id === 'shadow-record')
    const upload = steps.findIndex(step => step.id === 'upload-shadow-record')

    // #then
    expect(mint).toBeGreaterThanOrEqual(0)
    expect(appMint).toBeGreaterThan(mint)
    expect(authoritative).toBeGreaterThan(appMint)
    expect(shadow).toBeGreaterThan(authoritative)
    expect(record).toBeGreaterThan(shadow)
    expect(upload).toBeGreaterThan(record)
  })

  it('keeps every shadow step credentialless and invokes dry-run without push flags', () => {
    // #given
    const steps = stepsFor(integratePath, 'integrate')
    const shadowSteps = steps.filter(
      step => step.id === 'shadow-integrate' || step.id === 'shadow-record' || step.id === 'upload-shadow-record',
    )
    const shadow = stepById(steps, 'shadow-integrate')
    const run = String(shadow.run ?? '')

    // #then
    expect(shadowSteps).toHaveLength(3)
    for (const step of shadowSteps) {
      const env = step.env as Record<string, unknown> | undefined
      expect(env?.GH_TOKEN).toBe('')
      expect(env?.GITHUB_TOKEN).toBe('')
      expect(JSON.stringify(step)).not.toContain('mint-app-token')
    }
    expect(shadow['continue-on-error']).toBe(true)
    expect(String(shadow.if)).toContain('always()')
    expect(run).toContain('--dry-run')
    expect(run).toContain('--base-version')
    expect(run).toContain('--result-out')
    expect(run).not.toMatch(/--push-(repo|ref)/)
  })

  it('always records and uploads only a 90-day JSON evidence artifact', () => {
    // #given
    const steps = stepsFor(integratePath, 'integrate')
    const record = stepById(steps, 'shadow-record')
    const upload = stepById(steps, 'upload-shadow-record')
    const uploadWith = upload.with as Record<string, unknown>

    // #then
    expect(String(record.if)).toContain('always()')
    expect(String(upload.if)).toContain('always()')
    expect(uploadWith['retention-days']).toBe(90)
    expect(uploadWith['if-no-files-found']).toBe('warn')
    expect(String(uploadWith.path)).toMatch(/\.json/)
  })

  it('passes the resolved base version to the reusable integrate workflow and preserves the build handoff', () => {
    // #given
    const integrate = rawJob(releasePath, 'integrate')
    const build = rawJob(releasePath, 'build')
    const integrateWith = integrate.with as Record<string, unknown>
    const buildSteps = stepsFor(releasePath, 'build')
    const fetch = stepById(buildSteps, 'fetch-integrate')

    // #then
    expect(integrateWith['base-version']).toBe('${{' + ' needs.prepare-integrate.outputs.base_version }}')
    expect(build.needs).toEqual(['prepare-integrate', 'integrate'])
    expect(String(build.if)).toContain('needs.integrate.result')
    expect(String(fetch.run)).toContain('refs/harness-integrate/${' + 'BASE_VERSION}')
    expect(String(fetch.run)).toContain('integration_commit=${' + 'INTEGRATION_COMMIT}')
  })

  it('downloads and retains the current run shadow record without changing sync permissions', () => {
    // #given
    const sync = rawJob(releasePath, 'sync-default-version')
    const permissions = sync.permissions
    const steps = stepsFor(releasePath, 'sync-default-version')
    const download = stepById(steps, 'download-shadow-evidence')
    const retain = stepById(steps, 'retain-shadow-evidence')
    const pullRequest = steps.findIndex(step => step.name === 'Open PR via peter-evans/create-pull-request')
    const retainIndex = steps.indexOf(retain)
    const downloadWith = download.with as Record<string, unknown>

    // #then
    expect(permissions).toEqual({contents: 'write', 'pull-requests': 'write'})
    expect(String(download.if)).toContain('always()')
    expect(String(download.if)).toContain("has_refs == 'true'")
    expect(download['continue-on-error']).toBe(true)
    expect(String(downloadWith.name)).toContain('base_version')
    expect(String(retain.run)).toContain('docs/evidence/harness-shadow')
    expect(String(retain.run)).toContain('validateForwardShadowRecord')
    expect(String(retain.run)).toContain('if [ ! -f')
    expect(String(retain.if)).toContain('always()')
    expect(retain['continue-on-error']).toBe(true)
    expect(retainIndex).toBeLessThan(pullRequest)
  })
})
