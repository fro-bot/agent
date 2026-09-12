import {readFileSync} from 'node:fs'
import {describe, expect, it} from 'vitest'
import {parse} from 'yaml'

import {resolveResponseDelivery} from '../packages/runtime/src/agent/response-delivery.js'

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
const CI_WORKFLOW_PATH = '.github/workflows/ci.yaml'
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

function stepIndexByName(steps: readonly Record<string, unknown>[], name: string): number {
  const index = steps.findIndex(step => step.name === name)
  if (index === -1) throw new TypeError(`step ${name} is missing`)
  return index
}

function workflowStepRecords(): Record<string, unknown>[] {
  const jobs = loadRawWorkflow(WORKFLOW_PATH).jobs as Record<string, Record<string, unknown>>
  return Object.values(jobs).flatMap(job => {
    const steps = job.steps
    return Array.isArray(steps) ? (steps as Record<string, unknown>[]) : []
  })
}

function froBotSteps(): Record<string, unknown>[] {
  return stepsFor(WORKFLOW_PATH, 'fro-bot')
}

function schedulePrompt(): string {
  const env = loadRawWorkflow(WORKFLOW_PATH).env as Record<string, unknown>
  return String(env.SCHEDULE_PROMPT)
}

function promptExpression(): string {
  const runFroBot = froBotSteps().find(step => step.uses === './')
  if (runFroBot === undefined) throw new TypeError('Run Fro Bot step is missing')
  const envBlock = (runFroBot.env ?? {}) as Record<string, unknown>
  return String(envBlock.PROMPT)
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

describe('harness integration workflow wiring', () => {
  const integratePath = '.github/workflows/harness-integrate.yaml'
  const releasePath = '.github/workflows/harness-release.yaml'

  it('bounds the integrate job so a wedged run cannot consume the default six hours', () => {
    // #given the checked-in reusable integration workflow
    const job = rawJob(integratePath, 'integrate')

    // #then
    expect(job['timeout-minutes']).toBe(120)
  })

  it('creates the integration workdir before the model step that must clone into it', () => {
    // #given
    // The model is granted `<workdir>/*`, which covers paths inside the workdir but not
    // creation of the workdir itself, so `git clone` cannot create its own target.
    const job = rawJob(integratePath, 'integrate')
    const steps = job.steps as {readonly name?: string; readonly run?: string}[]
    const createIndex = steps.findIndex(step => step.name === 'Create the integration workdir')
    const modelIndex = steps.findIndex(step => step.name === 'Run Fro Bot')

    // #then
    expect(createIndex).toBeGreaterThanOrEqual(0)
    expect(modelIndex).toBeGreaterThanOrEqual(0)
    expect(createIndex).toBeLessThan(modelIndex)
    expect(String(steps[createIndex]?.run)).toContain('harness-integrate-work')
  })

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

  it('allows only the pinned OpenCode preview dependency host in the blocked egress list', () => {
    // #given the checked-in runner hardening step
    const job = rawJob(integratePath, 'integrate')
    const harden = stepsFor(integratePath, 'integrate').find(step => step.name === 'Harden runner egress')
    if (harden === undefined) throw new TypeError('Harden runner egress step is missing')
    const hardenWith = harden.with as Record<string, unknown>

    // #then the policy remains blocked and the allowlist changes only by adding pkg.pr.new
    expect(hardenWith['egress-policy']).toBe('block')
    expect(hardenWith['allowed-endpoints']).toBe(
      [
        'api.github.com:443',
        'broker.fro.bot:443',
        'bun.sh:443',
        'codeload.github.com:443',
        'cliproxy.fro.bot:443',
        'github.com:443',
        'models.dev:443',
        'nodejs.org:443',
        'pkg.pr.new:443',
        'registry.npmjs.org:443',
        '*.actions.githubusercontent.com:443',
        '*.githubusercontent.com:443',
      ].join(' '),
    )

    const raw = readFileSync(integratePath, 'utf8')
    expect(raw).toContain('# Upstream OpenCode pins @solidjs/start to a pkg.pr.new preview build in its root')
    expect(raw).toContain('# package.json, so bun install --frozen-lockfile cannot complete without it.')
    expect(job.permissions).toEqual({'id-token': 'write', contents: 'read'})
  })

  it('mints the write-capable token only after the model step and before trusted freeze', () => {
    // #given
    const steps = stepsFor(integratePath, 'integrate')
    const mint = steps.findIndex(step => step.id === 'mint')
    const appMint = steps.findIndex(step => step.id === 'mint-app-token')
    const authoritative = steps.findIndex(step => step.name === 'Run Fro Bot')
    const trustedFreeze = steps.findIndex(step => step.id === 'trusted-integrate')

    // #then the model runs before any write-capable credential exists
    expect(mint).toBeGreaterThanOrEqual(0)
    expect(authoritative).toBeGreaterThan(mint)
    expect(appMint).toBeGreaterThan(authoritative)
    expect(trustedFreeze).toBeGreaterThan(appMint)
  })

  it('gives the model only the read-only workflow token and reserves the App token for trusted push', () => {
    // #given
    const steps = stepsFor(integratePath, 'integrate')
    const runFroBot = steps.find(step => step.name === 'Run Fro Bot')
    const trusted = stepById(steps, 'trusted-integrate')
    if (runFroBot === undefined) throw new TypeError('Run Fro Bot step is missing')
    const runWith = runFroBot.with as Record<string, unknown>
    const runEnv = runFroBot.env as Record<string, unknown>
    const trustedEnv = trusted.env as Record<string, unknown>
    const trustedRun = String(trusted.run ?? '')

    // #then
    const githubTokenExpression = '${' + '{ github.token }}'
    const appTokenExpression = '${' + '{ steps.mint-app-token.outputs.github-token }}'
    expect(runWith['github-token']).toBe(githubTokenExpression)
    expect(runEnv.GH_TOKEN).toBe('')
    expect(runEnv.GITHUB_TOKEN).toBe('')
    expect(trustedEnv.GH_TOKEN).toBe(appTokenExpression)
    expect(trustedEnv.GITHUB_TOKEN).toBe('')
    expect(trustedRun).toContain('--candidate')
    expect(trustedRun).toContain('--push-repo')
    expect(trustedRun).toContain('--push-ref')
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

  it('cuts sync-default-version from current main, not the dispatch SHA', () => {
    // #given the sync-default-version job's checkout step
    const steps = stepsFor(releasePath, 'sync-default-version')
    const checkout = steps.find(step => String(step.uses ?? '').startsWith('actions/checkout@'))
    if (checkout === undefined) throw new TypeError('sync-default-version checkout step is missing')
    const checkoutWith = checkout.with as Record<string, unknown>

    // #then it must track main, not github.sha, or the sync PR opens behind-base
    expect(checkoutWith.ref, 'sync-default-version checkout must set ref: main').toBe('main')
  })

  it('keeps prepare-integrate, build, and publish pinned to the dispatch SHA (no ref override)', () => {
    // #given the jobs that must reproduce the dispatched commit exactly
    const pinnedJobs = ['prepare-integrate', 'build', 'publish']

    for (const jobName of pinnedJobs) {
      const steps = stepsFor(releasePath, jobName)
      const checkout = steps.find(step => String(step.uses ?? '').startsWith('actions/checkout@'))
      if (checkout === undefined) throw new TypeError(`${jobName} checkout step is missing`)
      const checkoutWith = (checkout.with ?? {}) as Record<string, unknown>

      // #then no ref key: these jobs must build/publish the exact dispatched commit,
      // not whatever main has drifted to. A stray ref: main here would silently
      // break release reproducibility.
      expect('ref' in checkoutWith, `${jobName} checkout must not set a ref (would break dispatch-SHA pinning)`).toBe(
        false,
      )
    }
  })
})

// Bounded to this one known expression form; not a general GHA expression evaluator.
function parseNotEqualsEventName(expression: string): string {
  const match = /^github\.event_name != '([^']*)'$/.exec(expression)
  if (match === null) {
    throw new TypeError(`unsupported persist-credentials expression: ${expression}`)
  }
  return match[1] ?? ''
}

// The oracle for which triggers this workflow can actually fire under is the workflow's own
// declared `on:` map, never a list re-typed by hand here (which would silently drift from it).
function declaredTriggers(workflowPath: string): readonly string[] {
  const on = loadRawWorkflow(workflowPath).on
  if (on === null || typeof on !== 'object' || Array.isArray(on)) {
    throw new TypeError(`${workflowPath} 'on' triggers must be a mapping`)
  }
  return Object.keys(on)
}

describe('CI workflow: Test GitHub Action checkout', () => {
  it('disables persisted checkout credentials only for pull_request, preserving other triggers', () => {
    // #given the checkout step in the test-action job's own PAT-authenticated checkout
    const steps = stepsFor(CI_WORKFLOW_PATH, 'test-action')
    const checkout = steps.find(step => step.name === 'Checkout repository')
    if (checkout === undefined) throw new TypeError('test-action Checkout repository step is missing')
    const checkoutWith = checkout.with as Record<string, unknown>
    const persistCredentialsExpression = expressionFrom(
      checkoutWith['persist-credentials'],
      'test-action persist-credentials',
    )

    // #then the expression withholds persistence for exactly one event
    const excludedEvent = parseNotEqualsEventName(persistCredentialsExpression)
    expect(excludedEvent).toBe('pull_request')

    // #then for every trigger this workflow actually declares, the YAML expression's persist
    // decision must match the real credential policy in response-delivery.ts -- not a literal
    // re-assertion of the same expression, and not a hand-maintained trigger list as the oracle.
    for (const eventName of declaredTriggers(CI_WORKFLOW_PATH)) {
      const yamlPersists = eventName !== excludedEvent
      const policyProvisions = resolveResponseDelivery(eventName, 'github').credential === 'provision'
      expect(yamlPersists, `persist-credentials for ${eventName} must match the response-delivery policy`).toBe(
        policyProvisions,
      )
    }

    // #then the existing ref/token wiring for this checkout is unchanged
    expect(checkoutWith.token).toBe('${' + '{ secrets.FRO_BOT_PAT }}')
    expect(checkoutWith.ref).toBe('${' + "{ github.event.pull_request.head.sha || '' }}")
  })
})

// The daily runtime-verification collector is a temporary trusted boundary around issue #1598.
// These assertions pin the job gate, credential isolation, artifact handoff, and fail-soft
// preservation of the existing fro-bot trigger matrix. Schema/shape validation of the evidence
// file itself lives in scripts/collect-dmr-runtime-verification.test.ts (U1).
describe('fro-bot workflow — daily runtime-verification collector', () => {
  const COLLECTOR_JOB = 'collect-dmr-runtime-verification'
  const UPLOAD_ARTIFACT_PIN = 'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a'
  const DOWNLOAD_ARTIFACT_PIN = 'actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c'
  const ARTIFACT_NAME = 'dmr-runtime-verification-${' + '{ github.run_id }}-${' + '{ github.run_attempt }}'
  const DOWNLOAD_PATH = '.context/dmr-runtime-verification/'
  const PAT_EXPRESSION = '${' + '{ secrets.FRO_BOT_PAT }}'
  const PRIVATE_INVENTORY_NAME = 'DMR_RUNTIME_VERIFICATION_PRIVATE_INVENTORY'
  const PRIVATE_INVENTORY_EXPRESSION = '${' + '{ secrets.DMR_RUNTIME_VERIFICATION_PRIVATE_INVENTORY }}'
  const GITHUB_TOKEN_EXPRESSION = '${' + '{ secrets.GITHUB_TOKEN }}'
  const COLLECT_STEP = 'Collect sanitized runtime-verification evidence'

  function collectorSteps(): Record<string, unknown>[] {
    return stepsFor(WORKFLOW_PATH, COLLECTOR_JOB)
  }

  it('gates the collector job to the exact daily cron and repo enablement variable only', () => {
    // #given the collector job
    const job = rawJob(WORKFLOW_PATH, COLLECTOR_JOB)

    // #then only the exact daily DMR schedule with the repo-scoped variable can start it
    const condition = String(job.if)
    expect(condition).toContain("github.event_name == 'schedule'")
    expect(condition).toContain("github.event.schedule == '30 15 * * *'")
    expect(condition).toContain("vars.DMR_RUNTIME_VERIFICATION_ENABLED == 'true'")
    for (const excluded of [
      'workflow_dispatch',
      'workflow_call',
      'issue_comment',
      'pull_request',
      'issues',
      'discussion_comment',
      '0 20 * * 0',
    ]) {
      expect(condition).not.toContain(excluded)
    }

    // #then the job holds only the checkout + issue-read authority it needs
    expect(job.permissions).toEqual({contents: 'read', issues: 'read'})
  })

  it('reads tracker state with the workflow token before either cross-owner secret is injected', () => {
    // #given the collector steps
    const steps = collectorSteps()
    const tracker = stepById(steps, 'tracker')
    const collect = stepById(steps, 'collect')
    const trackerEnv = (tracker.env ?? {}) as Record<string, unknown>

    // #then the tracker read uses the workflow token and cannot see either secret
    expect(trackerEnv.GH_TOKEN).toBe(GITHUB_TOKEN_EXPRESSION)
    expect(JSON.stringify(tracker)).not.toContain('FRO_BOT_PAT')
    expect(JSON.stringify(tracker)).not.toContain(PRIVATE_INVENTORY_NAME)

    // #then the credential-bearing collector runs only after the tracker read and only when open
    expect(steps.indexOf(tracker)).toBeLessThan(steps.indexOf(collect))
    expect(String(collect.if)).toContain('steps.tracker.outputs.state')
    expect(String(collect.if)).toContain("'open'")
  })

  it('injects both cross-owner secrets only on the single collector step', () => {
    // #given every step in the workflow
    const allSteps = workflowStepRecords()
    const withPrivateInventory = allSteps.filter(step => JSON.stringify(step).includes(PRIVATE_INVENTORY_NAME))

    // #then exactly one step sees the private inventory, and it is the collector step
    expect(withPrivateInventory).toHaveLength(1)
    expect(withPrivateInventory[0]?.name).toBe(COLLECT_STEP)
    expect(withPrivateInventory[0]?.env).toEqual({
      GH_TOKEN: PAT_EXPRESSION,
      DMR_RUNTIME_VERIFICATION_PRIVATE_INVENTORY: PRIVATE_INVENTORY_EXPRESSION,
    })

    // #then neither secret reaches collector job-level env or outputs
    const collector = rawJob(WORKFLOW_PATH, COLLECTOR_JOB)
    expect(collector.env).toBeUndefined()
    expect(collector.outputs).toBeUndefined()
  })

  it('uploads the fixed sanitized artifact after collection with the pinned action and one-day retention', () => {
    // #given the collector steps
    const steps = collectorSteps()
    const collect = stepById(steps, 'collect')
    const upload = steps.find(step => String(step.uses ?? '').startsWith('actions/upload-artifact@'))
    if (upload === undefined) throw new TypeError('collector upload step is missing')
    const uploadWith = (upload.with ?? {}) as Record<string, unknown>

    // #then it uses the pinned action, run-scoped name, fixed file, and fail-soft retention
    expect(upload.uses).toBe(UPLOAD_ARTIFACT_PIN)
    expect(uploadWith.name).toBe(ARTIFACT_NAME)
    expect(String(uploadWith.path)).toContain('runtime-verification-evidence.json')
    expect(uploadWith['if-no-files-found']).toBe('warn')
    expect(uploadWith['retention-days']).toBe(1)

    // #then upload runs after collection and carries no secret-derived metadata
    expect(steps.indexOf(upload)).toBeGreaterThan(steps.indexOf(collect))
    expect(JSON.stringify(upload)).not.toContain('secrets.')
  })

  it('waits for the collector and preserves every original trigger filter under always() + !cancelled()', () => {
    // #given the fro-bot job after the change
    const job = rawJob(WORKFLOW_PATH, 'fro-bot')

    // #then it depends on the collector job
    expect(job.needs).toBe(COLLECTOR_JOB)

    // #then the original filters are preserved inside the fail-soft wrapper
    const condition = String(job.if)
    expect(condition).toContain('always()')
    expect(condition).toContain('!cancelled()')
    expect(condition).toContain('github.event.pull_request.head.repo.full_name == github.repository')
    expect(condition).toContain("'[bot]'")
    expect(condition).toContain("github.event_name == 'issues'")
    expect(condition).toContain("'@fro-bot'")
    expect(condition).toContain('"OWNER"')
    expect(condition).toContain('"MEMBER"')
    expect(condition).toContain('"COLLABORATOR"')
    expect(condition).toContain('author_association')
    expect(condition).toContain("github.event_name == 'schedule'")
    expect(condition).toContain("github.event_name == 'workflow_dispatch'")
  })

  it('downloads the daily evidence before the action step, fail-soft, into the ignored context path', () => {
    // #given the fro-bot steps
    const steps = froBotSteps()
    const download = steps.find(step => String(step.uses ?? '').startsWith('actions/download-artifact@'))
    if (download === undefined) throw new TypeError('fro-bot download step is missing')
    const downloadWith = (download.with ?? {}) as Record<string, unknown>
    const runIndex = stepIndexByName(steps, 'Run Fro Bot')

    // #then the handoff targets the fixed artifact and the ignored local path
    expect(download.uses).toBe(DOWNLOAD_ARTIFACT_PIN)
    expect(downloadWith.name).toBe(ARTIFACT_NAME)
    expect(String(downloadWith.path)).toBe(DOWNLOAD_PATH)
    expect(download['continue-on-error']).toBe(true)

    // #then it is exact-daily-schedule + enablement only, runs before the action, and carries no credential
    expect(String(download.if)).toContain("github.event.schedule == '30 15 * * *'")
    expect(String(download.if)).toContain("vars.DMR_RUNTIME_VERIFICATION_ENABLED == 'true'")
    expect(steps.indexOf(download)).toBeLessThan(runIndex)
    expect(JSON.stringify(download)).not.toContain('secrets.')
  })

  it('keeps the private inventory secret out of fro-bot, outputs, artifact names, and download paths', () => {
    // #given the collector and fro-bot surfaces
    const collector = rawJob(WORKFLOW_PATH, COLLECTOR_JOB)
    const froBot = rawJob(WORKFLOW_PATH, 'fro-bot')
    const upload = collectorSteps().find(step => String(step.uses ?? '').startsWith('actions/upload-artifact@'))
    const download = froBotSteps().find(step => String(step.uses ?? '').startsWith('actions/download-artifact@'))

    // #then the private inventory never appears in a non-collector-step surface
    expect(JSON.stringify(froBot)).not.toContain(PRIVATE_INVENTORY_NAME)
    expect(JSON.stringify(collector.outputs ?? {})).not.toContain(PRIVATE_INVENTORY_NAME)
    expect(JSON.stringify(upload?.with ?? {})).not.toContain(PRIVATE_INVENTORY_NAME)
    expect(JSON.stringify(download?.with ?? {})).not.toContain(PRIVATE_INVENTORY_NAME)

    // #then the collector PAT is step-scoped only
    expect(JSON.stringify(collector.env ?? {})).not.toContain('FRO_BOT_PAT')
    expect(JSON.stringify(collector.outputs ?? {})).not.toContain('FRO_BOT_PAT')
    const patSteps = collectorSteps().filter(step => JSON.stringify(step).includes('FRO_BOT_PAT'))
    expect(patSteps).toHaveLength(1)
    expect((patSteps[0]?.env ?? {}) as Record<string, unknown>).toMatchObject({GH_TOKEN: PAT_EXPRESSION})

    // #then fro-bot keeps its pre-existing PAT steps and gains no new credential surface
    const froBotPatStepNames = froBotSteps()
      .filter(step => JSON.stringify(step).includes('FRO_BOT_PAT'))
      .map(step => step.name)
    expect(froBotPatStepNames).toEqual(['Checkout repository', 'Run Fro Bot'])
  })

  it('preserves every existing trigger and the release-notes handoff', () => {
    // #given the parsed workflow
    const workflow = loadRawWorkflow(WORKFLOW_PATH)
    const on = workflow.on as Record<string, unknown>
    const schedule = on.schedule as {cron: string}[]

    // #then both schedules remain and the collector adds no third trigger
    expect(schedule.map(entry => entry.cron)).toEqual(['30 15 * * *', '0 20 * * 0'])

    // #then the job graph is unchanged apart from the added collector
    const jobs = workflow.jobs as Record<string, unknown>
    expect(Object.keys(jobs).sort()).toEqual(['apply-release-notes', 'collect-dmr-runtime-verification', 'fro-bot'])

    // #then the trusted release-notes apply job still owns its PAT step
    const apply = rawJob(WORKFLOW_PATH, 'apply-release-notes')
    expect(apply.needs).toBe('fro-bot')
    expect(String(apply.if)).toContain("github.event.inputs.release-tag != ''")
    const applyPatSteps = stepsFor(WORKFLOW_PATH, 'apply-release-notes').filter(step =>
      JSON.stringify(step).includes('FRO_BOT_PAT'),
    )
    expect(applyPatSteps).toHaveLength(1)
    expect(((applyPatSteps[0]?.env ?? {}) as Record<string, unknown>).GH_TOKEN).toBe(PAT_EXPRESSION)
  })
})

// The temporary #1598 runtime-verification protocol is carried entirely by SCHEDULE_PROMPT.
// These are static contract assertions only: no executable issue-mutation script is added here.
describe('fro-bot workflow — temporary #1598 runtime-verification prompt protocol', () => {
  const START_MARKER = '<!-- fro-bot-runtime-verification:start -->'
  const END_MARKER = '<!-- fro-bot-runtime-verification:end -->'
  const EVIDENCE_PATH = '.context/dmr-runtime-verification/runtime-verification-evidence.json'

  it('pins the fixed evidence path, fixed target, and exact unique ordered markers', () => {
    // #given the checked-in daily schedule prompt
    const prompt = schedulePrompt()

    // #then the evidence path and the one extra target are fixed
    expect(prompt).toContain(EVIDENCE_PATH)
    expect(prompt).toContain('fro-bot/agent#1598')

    // #then exactly one ordered marker pair bounds the mutable region
    expect(prompt).toContain(START_MARKER)
    expect(prompt).toContain(END_MARKER)
    expect(prompt.indexOf(START_MARKER)).toBeLessThan(prompt.indexOf(END_MARKER))
    expect(prompt.split(START_MARKER).length - 1).toBe(1)
    expect(prompt.split(END_MARKER).length - 1).toBe(1)
  })

  it('grants only the rolling DMR plus #1598 and forbids every other mutation', () => {
    // #given the daily schedule prompt
    const prompt = schedulePrompt()

    // #then the rolling report and the single temporary exception are the only mutable targets
    expect(prompt).toContain('Daily Maintenance Report')
    expect(prompt).toContain('fro-bot/agent#1598')
    expect(prompt).toContain('Do NOT create')
    expect(prompt).toContain('or mutate any other issue, PR, comment, label, review, branch, dispatch, or rerun')
  })

  it('treats the artifact as untrusted data that cannot choose target, operation, credential, path, or marker text', () => {
    // #given the daily schedule prompt
    const prompt = schedulePrompt()

    // #then the artifact is evidence only, never a command channel
    expect(prompt).toContain('untrusted')
    expect(prompt).toContain('It cannot choose')
    expect(prompt).toContain('target issue/repository, operation, credential, path, or marker text')
  })

  it('validates schema, producer identity, baseline, and cardinality before any mutation', () => {
    // #given the daily schedule prompt
    const prompt = schedulePrompt()

    // #then every required identity/baseline check is explicit
    expect(prompt).toContain('schema version is 1')
    expect(prompt).toContain('GITHUB_RUN_ID')
    expect(prompt).toContain('GITHUB_RUN_ATTEMPT')
    expect(prompt).toContain('30 15 * * *')
    expect(prompt).toContain('minimum release tag is v0.111.0')
    expect(prompt).toContain('required ancestor commit is 9d971b4cc5d1e47cbbb4ea5cb60e2d703ceabf97')
    expect(prompt).not.toContain('v0.111.0 at commit')
    expect(prompt).toContain('public entries are 24')
    expect(prompt).toContain('private total is 3')
  })

  it('self-gates the temporary protocol to the exact daily schedule and otherwise skips silently', () => {
    // #given the daily schedule prompt
    const prompt = schedulePrompt()

    // #then a non-daily invocation must not touch the artifact, tracker, or DMR
    expect(prompt).toContain('GITHUB_EVENT_NAME')
    expect(prompt).toContain('skip this entire protocol silently')
    expect(prompt).toContain('do not read the artifact')
    expect(prompt).toContain('do not query or update #1598')
    expect(prompt).toContain('unavailable or cleanup note')

    // #then the gate is stated before any evidence step in the section
    expect(prompt.indexOf('skip this entire protocol silently')).toBeLessThan(prompt.indexOf(EVIDENCE_PATH))
  })

  it('requires a deterministic current-run generatedAt check and run-scoped metadata', () => {
    // #given the daily schedule prompt
    const prompt = schedulePrompt()

    // #then generatedAt is validated against the current run, not loosely "plausible"
    expect(prompt).toContain('generatedAt parses as UTC')
    expect(prompt).toContain('not later than current time')
    expect(prompt).toContain('created_at')
    expect(prompt).toContain('GITHUB_RUN_ID')
    expect(prompt).toContain('metadata cannot be read')
    expect(prompt).toContain('evidence is unavailable')
    expect(prompt).not.toContain('plausible for the current run')
  })

  it('uses artifact/tracker wording for an already-closed tracker and leaves the skip to the collector gate', () => {
    // #given the daily schedule prompt
    const prompt = schedulePrompt()

    // #then a closed tracker means no artifact use or update, delegated to the collector gate
    expect(prompt).toContain('do not use the artifact or update #1598')
    expect(prompt).toContain('tracker gate')
    expect(prompt).toContain('secret-bearing scan')
    expect(prompt).not.toContain('do not collect or update it')
  })

  it('fails closed on missing, invalid, unavailable, or stale evidence', () => {
    // #given the daily schedule prompt
    const prompt = schedulePrompt()

    // #then every non-usable evidence state is a no-mutation state
    expect(prompt).toContain('data unavailable')
    expect(prompt).toContain('NO #1598 mutation')
    expect(prompt).toContain('operator-visible DMR warning')
    expect(prompt).toContain('stale')
    expect(prompt).toContain('replayed')
    expect(prompt).toContain('mismatched')
    expect(prompt).toContain('yields no usable file')
  })

  it('keeps private data aggregate-only and forbids identity or per-repository evidence', () => {
    // #given the daily schedule prompt
    const prompt = schedulePrompt()

    // #then private identity and per-repository evidence are prohibited; only aggregates are used
    expect(prompt).toContain('never print, infer, query, store, or publish private repository')
    expect(prompt).toContain('names, aliases, URLs, or per-repository evidence')
    expect(prompt).toContain('aggregate private')
  })

  it('requires monotonic progress and the canonical 24+3 closure rule', () => {
    // #given the daily schedule prompt
    const prompt = schedulePrompt()

    // #then public progress unions upward and closure needs current private terminal evidence
    expect(prompt).toContain('union newly resolved public dispositions')
    expect(prompt).toContain('never demote an existing resolution')
    expect(prompt).toContain('all 24 public entries resolve')
    expect(prompt).toContain('all 3 private')
    expect(prompt).toContain('positively terminal')
    expect(prompt).toContain('operator-backed')
  })

  it('writes the final managed block before closing and posts no comment', () => {
    // #given the daily schedule prompt
    const prompt = schedulePrompt()

    // #then the body is re-read and the final block is written before a comment-free close
    expect(prompt).toContain('read the full #1598 body')
    expect(prompt).toContain('re-read immediately before mutating')
    expect(prompt).toContain('abort if any byte outside')
    expect(prompt).toContain('rebuild from the final body')
    expect(prompt).toContain('Write the final managed block first, then close with no comment.')
  })

  it('leaves #1598 byte-for-byte unchanged on no-change runs and updates only the DMR', () => {
    // #given the daily schedule prompt
    const prompt = schedulePrompt()

    // #then no material progress means the tracker is untouched
    expect(prompt).toContain('byte-for-byte unchanged')
    expect(prompt).toContain('update only the DMR')
  })

  it('emits a closed-tracker cleanup reminder without opening the cleanup PR', () => {
    // #given the daily schedule prompt
    const prompt = schedulePrompt()

    // #then a closed tracker stops collection and only reminds the operator
    expect(prompt).toContain('already closed')
    expect(prompt).toContain('DMR_RUNTIME_VERIFICATION_ENABLED')
    expect(prompt).toContain('private-inventory secret')
    expect(prompt).toContain('separately approved cleanup PR')
    expect(prompt).toContain('Do not open that PR.')
  })

  it('uses the action-supplied token and forbids credential switching', () => {
    // #given the daily schedule prompt
    const prompt = schedulePrompt()

    // #then issue mutation reuses the action token; no credential work is instructed
    expect(prompt).toContain('token already supplied to this action')
    expect(prompt).toContain('read, switch, or configure any other credential')
  })

  it('preserves DMR section order, bounded history, and existing prompt selection', () => {
    // #given the daily schedule prompt and the action prompt expression
    const prompt = schedulePrompt()

    // #then the existing DMR section order is intact
    let cursor = -1
    for (const section of [
      'Summary metrics',
      'Stale issues',
      'Stale PRs',
      'Unassigned bugs',
      'Recommended actions',
      'Notes',
    ]) {
      const index = prompt.indexOf(section)
      expect(index, `${section} must appear after the previous section`).toBeGreaterThan(cursor)
      cursor = index
    }
    expect(prompt).toContain('Historical Summary')
    expect(prompt).toContain('14 days')

    // #then weekly, manual, and reusable prompt selection is untouched
    const expression = promptExpression()
    expect(expression).toContain('env.WIKI_PROMPT')
    expect(expression).toContain('env.SCHEDULE_PROMPT')
    expect(expression).toContain("github.event.schedule == '0 20 * * 0'")
  })
})
