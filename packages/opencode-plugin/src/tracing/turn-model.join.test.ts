import type {Observation} from './observation.js'
import type {ChatRecord, TurnModelLimits} from './turn-model.js'

import {describe, expect, it} from 'vitest'

import {replay} from './turn-model.testing.js'

// Property tests of the step join (turn-model.ts, "Binding steps to requests") with an oracle that is the generator itself.
//
// A generator builds sessions whose requests run one after another, as the server's runner does: hook(k), then its attempt's
// step events, then hook(k+1) later. Each request's step carries its own tag (text, message id, usage), so what a span carries
// can be compared with whose it should be. Then it makes delivery as hostile as the plugin sees it: hooks are delivered at
// once, events through a pull loop that lags by a random amount but keeps its own order, so hook(n+1) is often observed before
// step.ended(n) and step.started(n). In the adversarial run it also refuses spans at a small cap, evicts hook times from a small
// record, and drops observations, each drop replaced by the loss marker the pipeline would send in its place.
//
// Invariant (adversarial): no span ever carries another request's content; a span carries its own content or none.
// Invariant (clean): in addition, every request whose step ran to its end carries exactly its own content.
//
// Every case is reproducible from its seed, which is in the failure message.

type Fate = 'ok' | 'orphan' | 'preout' | 'postfail'

interface HookPlan {
  readonly index: number
  readonly fate: Fate
  readonly at: number
  readonly started: number
  readonly message: string
  readonly tag: string
}

interface Item {
  readonly session: string
  /** `hook` items are delivered when they happen; `event` items later, in their own order. */
  readonly channel: 'hook' | 'event'
  /** Source time: when it happened. */
  readonly t: number
  readonly observation: Observation
  /** The generator may drop it (a loss marker takes its place). Execution start and end are never dropped. */
  readonly droppable: boolean
  /** The tag of the hook this item belongs to. */
  readonly hook: string | undefined
}

/** mulberry32: a small deterministic generator. */
function prng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
type Random = () => number
const int = (random: Random, low: number, high: number): number => low + Math.floor(random() * (high - low + 1))
function pick<T>(random: Random, weighted: readonly (readonly [T, number])[]): T {
  const total = weighted.reduce((sum, [, weight]) => sum + weight, 0)
  let roll = random() * total
  for (const [value, weight] of weighted) {
    roll -= weight
    if (roll < 0) return value
  }
  return (weighted.at(-1) as readonly [T, number])[0]
}

/** One session's hooks, in source order. A pre-output failure is followed by its retry attempt, which reuses the message id. */
function planSession(random: Random, session: string): HookPlan[] {
  const count = int(random, 1, 9)
  const plans: HookPlan[] = []
  let at = int(random, 100, 200)
  let reuse: string | undefined
  for (let index = 0; index < count; index += 1) {
    const last = index === count - 1
    const fate =
      reuse !== undefined && last
        ? 'ok'
        : pick<Fate>(random, [
            ['ok', last ? 1 : 10],
            ['orphan', last ? 0 : 2],
            ['preout', last ? 0 : 2],
            ['postfail', last ? 0 : 2],
          ])
    const message = reuse ?? `${session}-m${String(index)}`
    plans.push({index, fate, at, started: at + int(random, 0, 1), message, tag: `${session}#${String(index)}`})
    reuse = fate === 'preout' ? message : undefined
    // The next hook comes after the step's last event (the runner is sequential): at least 12 ms on, the smallest gap measured
    // on the real binary (`/tmp/step-order/live.md`); a retry waits far longer.
    at += fate === 'preout' ? int(random, 30, 2000) : int(random, 12, 60)
  }
  return plans
}

const usageOf = (index: number) => ({input: index + 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0})

function itemsOf(random: Random, session: string, plans: readonly HookPlan[]): Item[] {
  const items: Item[] = []
  const push = (item: Omit<Item, 'session'>): void => {
    items.push({session, ...item})
  }
  const first = plans[0]
  const lastPlan = plans.at(-1)
  if (first === undefined || lastPlan === undefined) return items
  push({
    channel: 'event',
    t: first.at - 5,
    observation: {kind: 'execution.started', at: first.at - 5, sessionId: session},
    droppable: false,
    hook: undefined,
  })
  let end = first.at
  for (const plan of plans) {
    const next = plans[plan.index + 1]
    push({
      channel: 'hook',
      t: plan.at,
      observation: {
        kind: 'request',
        at: plan.at,
        sessionId: session,
        requestKind: 'primary',
        agent: 'build',
        model: 'm',
        provider: 'p',
        content: {messages: []},
      },
      droppable: true,
      hook: plan.tag,
    })
    if (plan.fate === 'orphan') continue
    const start = plan.started + 1 + int(random, 0, 3)
    const started: Observation = {
      kind: 'step.started',
      at: start,
      started: plan.started,
      sessionId: session,
      messageId: plan.message,
      agent: 'build',
      model: 'm',
      provider: 'p',
    }
    if (plan.fate === 'preout') {
      // The retry hook comes first (the decision), then the failed attempt's step.started, which has no end.
      push({
        channel: 'hook',
        t: plan.at + 1,
        observation: {
          kind: 'retry',
          at: plan.at + 1,
          sessionId: session,
          attempt: plan.index + 2,
          willRetry: next !== undefined,
          error: {type: 'provider.internal', message: `ERR ${plan.tag}`},
        },
        droppable: true,
        hook: plan.tag,
      })
      push({channel: 'event', t: start, observation: started, droppable: true, hook: plan.tag})
      end = Math.max(end, start)
      continue
    }
    push({channel: 'event', t: start, observation: started, droppable: true, hook: plan.tag})
    const textAt = start + 1
    push({
      channel: 'event',
      t: textAt,
      observation: {
        kind: 'output',
        at: textAt,
        sessionId: session,
        messageId: plan.message,
        part: 'text',
        text: `text ${plan.tag}`,
      },
      droppable: true,
      hook: plan.tag,
    })
    if (plan.fate === 'ok') {
      const endedAt = textAt + 1
      push({
        channel: 'event',
        t: endedAt,
        observation: {
          kind: 'step.ended',
          at: endedAt,
          sessionId: session,
          messageId: plan.message,
          finish: 'stop',
          rawFinish: 'stop',
          usage: usageOf(plan.index),
          cost: 0,
        },
        droppable: true,
        hook: plan.tag,
      })
      end = Math.max(end, endedAt)
    } else {
      // A failure after output: the retry hook follows the step's output on the source, then the step's own failure.
      const retryAt = textAt + 1
      push({
        channel: 'hook',
        t: retryAt,
        observation: {
          kind: 'retry',
          at: retryAt,
          sessionId: session,
          attempt: plan.index + 2,
          willRetry: next !== undefined,
          error: {type: 'provider.internal', message: `ERR ${plan.tag}`},
        },
        droppable: true,
        hook: plan.tag,
      })
      const failedAt = retryAt + 1
      push({
        channel: 'event',
        t: failedAt,
        observation: {
          kind: 'step.failed',
          at: failedAt,
          sessionId: session,
          messageId: plan.message,
          error: {type: 'provider.internal', message: `ERR ${plan.tag}`},
          usage: usageOf(plan.index),
        },
        droppable: true,
        hook: plan.tag,
      })
      end = Math.max(end, failedAt)
    }
  }
  push({
    channel: 'event',
    t: end + 5,
    observation: {kind: 'execution.ended', at: end + 5, sessionId: session, outcome: 'succeeded'},
    droppable: false,
    hook: undefined,
  })
  return items
}

interface Case {
  readonly seed: number
  readonly plans: ReadonlyMap<string, readonly HookPlan[]>
  readonly observations: readonly Observation[]
  readonly limits: Partial<TurnModelLimits>
  readonly dropped: number
}

function build(seed: number, mode: 'clean' | 'adversarial'): Case {
  const random = prng(seed * 2_654_435_761 + 11)
  const sessions = int(random, 1, 3)
  const plans = new Map<string, readonly HookPlan[]>()
  const all: {item: Item; delivery: number; order: number}[] = []
  let order = 0
  for (let index = 0; index < sessions; index += 1) {
    const session = `s${String(index)}`
    const plan = planSession(random, session)
    plans.set(session, plan)
    const items = itemsOf(random, session, plan)
    // Hooks are delivered when they happen; events lag, but keep the order they happened in.
    let lastEvent = 0
    const lagged = pick(random, [
      [0, 3],
      [3, 3],
      [200, 2],
    ])
    for (const item of [...items].sort((a, b) => a.t - b.t)) {
      let delivery = item.t
      if (item.channel === 'event') {
        const lag = random() < 0.5 ? 0 : int(random, 0, lagged)
        delivery = Math.max(lastEvent, item.t + lag)
        lastEvent = delivery
      }
      all.push({item, delivery, order: (order += 1)})
    }
  }
  all.sort((a, b) => a.delivery - b.delivery || a.order - b.order)

  let maxOpenSpansPerTrace: number | undefined
  let maxHookTimes: number | undefined
  let dropped = 0
  const observations: Observation[] = []
  let dropRate = 0
  if (mode === 'adversarial') {
    maxOpenSpansPerTrace = pick<number | undefined>(random, [
      [undefined, 4],
      [1, 2],
      [2, 2],
      [3, 2],
    ])
    maxHookTimes = pick<number | undefined>(random, [
      [undefined, 5],
      [2, 1],
      [3, 2],
      [5, 1],
    ])
    dropRate = pick<number>(random, [
      [0, 2],
      [0.03, 3],
      [0.1, 1],
    ])
  }
  const limits: Partial<TurnModelLimits> = {
    ...(maxOpenSpansPerTrace === undefined ? {} : {maxOpenSpansPerTrace}),
    ...(maxHookTimes === undefined ? {} : {maxHookTimes}),
  }
  for (const {item} of all) {
    if (item.droppable && dropRate > 0 && random() < dropRate) {
      dropped += 1
      observations.push({
        kind: 'loss',
        at: item.observation.at,
        sessionIds: random() < 0.1 ? undefined : [item.session],
        reason: 'generated',
      })
    } else observations.push(item.observation)
  }
  return {seed, plans, observations, limits, dropped}
}

const SEEDS = 20_000

/** The chat span of a session's request hook, found by the hook's own time. */
function chatsByHook(chats: readonly ChatRecord[]): Map<string, ChatRecord> {
  return new Map(
    chats.filter(chat => chat.requestKind === 'primary').map(chat => [`${chat.sessionId}@${String(chat.start)}`, chat]),
  )
}

/** Whether `chat` carries anything that is not `plan`'s: the invariant, one request at a time. */
function foreign(chat: ChatRecord, plan: HookPlan): string | undefined {
  const own = `text ${plan.tag}`
  if (chat.texts.some(text => text !== own)) return `text ${JSON.stringify(chat.texts)}`
  if (chat.messageId !== undefined && chat.messageId !== plan.message) return `message ${chat.messageId}`
  if (chat.usage !== undefined && chat.usage.input !== plan.index + 1) return `usage ${String(chat.usage.input)}`
  if (chat.error?.message !== undefined && chat.error.message !== `ERR ${plan.tag}`)
    return `error ${chat.error.message}`
  if (chat.status === 'error' && plan.fate === 'ok') return 'error status on a step that succeeded'
  if (chat.finishReason !== undefined && plan.fate !== 'ok') return `finish ${chat.finishReason}`
  return undefined
}

describe('the step join over generated sessions', () => {
  it(`carries every step that ran to its end on exactly its own request, in ${String(SEEDS)} seeded sessions with hostile delivery`, () => {
    let checked = 0
    let exact = 0
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const {plans, observations, limits} = build(seed, 'clean')
      const {records} = replay(observations, {limits})
      const byHook = chatsByHook(records.filter((record): record is ChatRecord => record.kind === 'chat'))
      const wrong: unknown[] = []
      for (const [session, plan] of plans) {
        for (const hook of plan) {
          const chat = byHook.get(`${session}@${String(hook.at)}`)
          // Every hook has a span (the cap and the record are untouched here).
          if (chat === undefined) {
            wrong.push({session, hook: hook.index, span: 'missing'})
            continue
          }
          checked += 1
          const other = foreign(chat, hook)
          if (other !== undefined) wrong.push({session, hook: hook.index, foreign: other})
          // A step that ran to its end carries its own text, message and usage.
          const own = {texts: [`text ${hook.tag}`], message: hook.message, input: hook.index + 1}
          const got = {texts: chat.texts, message: chat.messageId, input: chat.usage?.input}
          exact += hook.fate === 'ok' ? 1 : 0
          if (hook.fate === 'ok' && JSON.stringify(got) !== JSON.stringify(own))
            wrong.push({session, hook: hook.index, got, want: own})
          // A failed attempt closed by a retry hook before its step started, and an orphan hook, hold no step data.
          if (hook.fate === 'preout' && (chat.texts.length > 0 || chat.status !== 'error'))
            wrong.push({session, hook: hook.index, preout: got, status: chat.status})
          if (hook.fate === 'orphan' && (chat.texts.length > 0 || chat.messageId !== undefined))
            wrong.push({session, hook: hook.index, orphan: got})
        }
      }
      expect({seed, wrong}).toEqual({seed, wrong: []})
    }
    // The generator exercises what it claims to.
    expect(checked).toBeGreaterThan(SEEDS * 3)
    expect(exact).toBeGreaterThan(SEEDS * 2)
  })

  it(`never puts another request's content on a span, whatever is refused, evicted or dropped, in ${String(SEEDS)} seeded sessions`, () => {
    let checked = 0
    let uncertain = 0
    let kept = 0
    let dropped = 0
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const {plans, observations, limits, dropped: lost} = build(seed, 'adversarial')
      dropped += lost
      const {records, model} = replay(observations, {limits})
      const byHook = chatsByHook(records.filter((record): record is ChatRecord => record.kind === 'chat'))
      const wrong: unknown[] = []
      for (const [session, plan] of plans) {
        for (const hook of plan) {
          const chat = byHook.get(`${session}@${String(hook.at)}`)
          if (chat === undefined) continue
          checked += 1
          const other = foreign(chat, hook)
          if (other !== undefined) wrong.push({session, hook: hook.index, foreign: other})
          const unsure = chat.gaps.includes('step-binding-uncertain')
          uncertain += unsure ? 1 : 0
          if (unsure && (chat.texts.length > 0 || chat.messageId !== undefined))
            wrong.push({session, hook: hook.index, uncertainWithData: chat.texts})
          kept += chat.texts.length > 0 ? 1 : 0
        }
      }
      const held = model.stats().hookTimes
      if (held > (limits.maxHookTimes ?? 64) * 3) wrong.push({hookTimes: held})
      expect({seed, limits, wrong}).toEqual({seed, limits, wrong: []})
    }
    expect(checked).toBeGreaterThan(SEEDS)
    expect(uncertain).toBeGreaterThan(SEEDS / 10)
    expect(kept).toBeGreaterThan(SEEDS)
    expect(dropped).toBeGreaterThan(SEEDS / 4)
  })
})
