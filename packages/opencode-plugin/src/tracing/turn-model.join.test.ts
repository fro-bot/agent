import type {Observation} from './observation.js'
import type {ChatRecord, TurnModelLimits} from './turn-model.js'

import {describe, expect, it} from 'vitest'

import {replay} from './turn-model.testing.js'

// Property tests of the step join (turn-model.ts, "Binding steps to requests") with an oracle that is the generator itself.
//
// A generator builds sessions whose requests run one after another, as the server's runner does: hook(k), then its attempt's
// step events, then hook(k+1). Every step carries its own tag (text parts, message id, usage), so what a span carries can be
// compared with whose it should be. All times are TRUE times first (monotonic, the source's order) and are turned into the wall
// times the plugin would read by a clock that may be rolled back. Delivery is then as hostile as the plugin sees it: hooks arrive
// when they happen, events through a pull loop that lags by a random amount but keeps its own order, so hook(n+1) is often
// observed before step.ended(n) and step.started(n).
//
// Two generators:
//   - clean: realistic gaps (the smallest measured on the real binary is 12 ms), no orphan hooks, no rollback, no drops.
//     Invariant: every step that ran to its end carries exactly its own content, however delivery lags.
//   - adversarial: no minimum gap (a step can start and end and the next hook arrive in one millisecond), orphan hooks, wall clock
//     rollbacks, up to 90 hooks of lag against a record of 64, a refused span cap, a small hook record, subagents whose whole turn
//     is buffered and replayed when the dispatch link arrives, and dropped observations of any kind (text parts of a running
//     step included), each replaced by the loss marker the pipeline would send. Invariants: no span ever carries another
//     request's content, and a span that shows a finish reason and output has ALL of its request's text.
//
// Rollbacks are generated at least as large as the gap since the previous hook, so the hook lands at or before it: a smaller one,
// that leaves the next hook later than a delayed step's start, is the documented residual (turn-model.ts) and not generated.
//
// Every case is reproducible from its seed, which is in the failure message.

type Fate = 'ok' | 'orphan' | 'preout' | 'postfail'

interface Config {
  readonly mode: 'clean' | 'adversarial'
}

interface HookPlan {
  readonly session: string
  readonly index: number
  readonly fate: Fate
  /** True times. */
  readonly t: number
  readonly tStart: number
  /** Milliseconds between the step's own events: 0 puts the whole step in one millisecond (a zero-length step). */
  readonly inc: number
  readonly message: string
  readonly tag: string
  readonly parts: readonly string[]
}

interface Item {
  readonly session: string
  readonly channel: 'hook' | 'event'
  /** True time: when it happened. */
  readonly t: number
  readonly make: (wall: (t: number) => number) => Observation
  /** The generator may drop it (a loss marker takes its place). Execution start and end, and the dispatch link, are never dropped. */
  readonly droppable: boolean
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
function planSession(random: Random, config: Config, session: string, count: number, start: number): HookPlan[] {
  const clean = config.mode === 'clean'
  const plans: HookPlan[] = []
  let t = start
  let reuse: string | undefined
  for (let index = 0; index < count; index += 1) {
    const last = index === count - 1
    const fate: Fate =
      reuse !== undefined && last
        ? 'ok'
        : pick<Fate>(random, [
            ['ok', last ? 1 : 10],
            ['orphan', last || clean ? 0 : 2],
            ['preout', last ? 0 : 2],
            ['postfail', last ? 0 : 2],
          ])
    const message = reuse ?? `${session}-m${String(index)}`
    // The step starts at its hook's time or a millisecond after (the usual case is the same millisecond).
    const tStart = t + (random() < 0.7 ? 0 : 1)
    const tag = `${session}#${String(index)}`
    const parts = Array.from({length: int(random, 1, 3)}, (_, part) => `text ${tag} p${String(part)}`)
    // Clean steps take a millisecond per event; an adversarial one may take none at all.
    const inc = clean || random() < 0.5 ? 1 : 0
    const plan: HookPlan = {session, index, fate, t, tStart, inc, message, tag, parts}
    plans.push(plan)
    reuse = fate === 'preout' ? message : undefined
    // The next hook comes after the step's last event (the runner is sequential). Clean: at least 12 ms after the step's start,
    // the smallest gap measured on the real binary. Adversarial: possibly in the very same millisecond as the step's start.
    const done = eventTimes(plan).last
    t =
      fate === 'preout'
        ? done + int(random, 30, 2000)
        : clean
          ? Math.max(done, tStart + 12) + int(random, 0, 48)
          : done + int(random, 0, 60)
  }
  return plans
}

/** True times of a step's own events, in source order, and the last of them. */
function eventTimes(plan: HookPlan): {
  readonly retry: number
  readonly started: number
  readonly parts: readonly number[]
  readonly ended: number
  readonly failed: number
  readonly last: number
} {
  const at = (n: number): number => plan.tStart + plan.inc * n
  if (plan.fate === 'orphan')
    return {retry: plan.t, started: plan.t, parts: [], ended: plan.t, failed: plan.t, last: plan.t}
  if (plan.fate === 'preout') return {retry: at(1), started: at(2), parts: [], ended: at(2), failed: at(2), last: at(2)}
  const parts = plan.parts.map((_, part) => at(2 + part))
  const after = at(2 + plan.parts.length)
  return {
    retry: after,
    started: at(1),
    parts,
    ended: after,
    failed: at(3 + plan.parts.length),
    last: plan.fate === 'ok' ? after : at(3 + plan.parts.length),
  }
}

const usageOf = (index: number) => ({input: index + 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0})

function itemsOf(plans: readonly HookPlan[]): Item[] {
  const items: Item[] = []
  const first = plans[0]
  if (first === undefined) return items
  const session = first.session
  const push = (item: Omit<Item, 'session'>): void => {
    items.push({session, ...item})
  }
  for (const plan of plans) {
    const next = plans[plan.index + 1]
    const time = eventTimes(plan)
    push({
      channel: 'hook',
      t: plan.t,
      droppable: true,
      make: wall => ({
        kind: 'request',
        at: wall(plan.t),
        sessionId: session,
        requestKind: 'primary',
        agent: 'build',
        model: 'm',
        provider: 'p',
        // The request names its own hook, so a span can be matched to its plan whatever the clock did.
        content: {messages: [], tag: plan.tag},
      }),
    })
    if (plan.fate === 'orphan') continue
    const retry = (at: number): Item => ({
      channel: 'hook',
      t: at,
      droppable: true,
      session,
      make: wall => ({
        kind: 'retry',
        at: wall(at),
        sessionId: session,
        attempt: plan.index + 2,
        willRetry: next !== undefined,
        error: {type: 'provider.internal', message: `ERR ${plan.tag}`},
      }),
    })
    const started = (): Item => ({
      channel: 'event',
      t: time.started,
      droppable: true,
      session,
      make: wall => ({
        kind: 'step.started',
        at: wall(time.started),
        started: wall(plan.tStart),
        sessionId: session,
        messageId: plan.message,
        agent: 'build',
        model: 'm',
        provider: 'p',
      }),
    })
    if (plan.fate === 'preout') {
      // The retry hook comes first (the decision), then the failed attempt's step.started, which has no end.
      items.push(retry(time.retry))
      items.push(started())
      continue
    }
    items.push(started())
    plan.parts.forEach((text, part) => {
      const at = time.parts[part] ?? time.started
      push({
        channel: 'event',
        t: at,
        droppable: true,
        make: wall => ({
          kind: 'output',
          at: wall(at),
          sessionId: session,
          messageId: plan.message,
          part: 'text',
          text,
          ordinal: part,
        }),
      })
    })
    if (plan.fate === 'ok') {
      push({
        channel: 'event',
        t: time.ended,
        droppable: true,
        make: wall => ({
          kind: 'step.ended',
          at: wall(time.ended),
          sessionId: session,
          messageId: plan.message,
          finish: 'stop',
          rawFinish: 'stop',
          usage: usageOf(plan.index),
          cost: 0,
        }),
      })
    } else {
      // A failure after output: the retry hook follows the step's output on the source, then the step's own failure.
      items.push(retry(time.retry))
      push({
        channel: 'event',
        t: time.failed,
        droppable: true,
        make: wall => ({
          kind: 'step.failed',
          at: wall(time.failed),
          sessionId: session,
          messageId: plan.message,
          error: {type: 'provider.internal', message: `ERR ${plan.tag}`},
          usage: usageOf(plan.index),
        }),
      })
    }
  }
  return items
}

interface Case {
  readonly seed: number
  readonly plans: ReadonlyMap<string, readonly HookPlan[]>
  readonly observations: readonly Observation[]
  readonly limits: Partial<TurnModelLimits>
  readonly dropped: number
  readonly rollbacks: number
}

function build(seed: number, config: Config): Case {
  const random = prng(seed * 2_654_435_761 + 11)
  const adversarial = config.mode === 'adversarial'
  const roots = int(random, 1, 3)
  const plans = new Map<string, readonly HookPlan[]>()
  const entries: {item: Item; delivery: number; order: number}[] = []
  let order = 0
  const lagChoice = pick<number>(
    random,
    adversarial
      ? [
          [0, 3],
          [3, 3],
          [200, 2],
          [6000, 1],
        ]
      : [
          [0, 3],
          [3, 3],
          [200, 2],
        ],
  )
  const deliver = (items: readonly Item[]): void => {
    let lastEvent = 0
    for (const item of [...items].sort((a, b) => a.t - b.t)) {
      let delivery = item.t
      if (item.channel === 'event') {
        const lag = random() < 0.5 ? 0 : int(random, 0, lagChoice)
        delivery = Math.max(lastEvent, item.t + lag)
        lastEvent = delivery
      }
      entries.push({item, delivery, order: (order += 1)})
    }
  }
  const sessionItems = (session: string, count: number, start: number): Item[] => {
    const plan = planSession(random, config, session, count, start)
    plans.set(session, plan)
    return itemsOf(plan)
  }
  const hookCount = (): number => (adversarial && random() < 0.08 ? int(random, 66, 90) : int(random, 1, 9))
  const marker = (session: string, t: number, make: (wall: (t: number) => number) => Observation): Item => ({
    session,
    channel: 'event',
    t,
    droppable: false,
    make,
  })

  for (let index = 0; index < roots; index += 1) {
    const session = `s${String(index)}`
    const withChild = random() < 0.3
    const items = sessionItems(session, hookCount(), int(random, 100, 200))
    const firstT = items[0]?.t ?? 100
    const lastT = items.reduce((max, item) => Math.max(max, item.t), 0)
    items.push(
      marker(session, firstT - 5, wall => ({kind: 'execution.started', at: wall(firstT - 5), sessionId: session})),
    )
    items.push(
      marker(session, lastT + 5, wall => ({
        kind: 'execution.ended',
        at: wall(lastT + 5),
        sessionId: session,
        outcome: 'succeeded',
      })),
    )
    deliver(items)
    if (!withChild) continue

    // A subagent whose whole turn is delivered before the dispatch link: it is buffered, then replayed with its own times.
    const child = `k${String(index)}`
    const childItems = sessionItems(child, hookCount(), firstT + 20)
    const childFirst = childItems[0]?.t ?? firstT
    const childLast = childItems.reduce((max, item) => Math.max(max, item.t), 0)
    const parentHook = (plans.get(session) ?? [])[0]
    const tCreate = childFirst - 8
    childItems.push(
      marker(child, tCreate, wall => ({
        kind: 'session.created',
        at: wall(tCreate),
        sessionId: child,
        parentSessionId: session,
        agent: 'general',
      })),
      marker(child, tCreate + 1, wall => ({
        kind: 'prompt',
        at: wall(tCreate + 1),
        sessionId: child,
        messageId: `${child}-u`,
        delivery: 'steer',
        content: 'hi',
      })),
      marker(child, tCreate + 2, wall => ({
        kind: 'inbox.enqueued',
        at: wall(tCreate + 2),
        sessionId: child,
        inboxId: `${child}-u`,
        item: 'user',
      })),
      marker(child, childFirst - 5, wall => ({kind: 'execution.started', at: wall(childFirst - 5), sessionId: child})),
      marker(child, childFirst - 4, wall => ({
        kind: 'inbox.delivered',
        at: wall(childFirst - 4),
        sessionId: child,
        inboxId: `${child}-u`,
      })),
      marker(child, childLast + 5, wall => ({
        kind: 'execution.ended',
        at: wall(childLast + 5),
        sessionId: child,
        outcome: 'succeeded',
      })),
    )
    deliver(childItems)
    // The parent's dispatch call and its link arrive after everything the child did.
    const tLink = childLast + 10_000
    const call = `${session}-dispatch`
    const msg = parentHook?.message ?? `${session}-m0`
    entries.push(
      ...[
        marker(session, tLink, wall => ({
          kind: 'tool.named',
          at: wall(tLink),
          sessionId: session,
          callId: call,
          tool: 'subagent',
        })),
        marker(session, tLink + 1, wall => ({
          kind: 'tool.called',
          at: wall(tLink + 1),
          sessionId: session,
          callId: call,
          executed: false,
          input: {},
          messageId: msg,
        })),
        marker(session, tLink + 2, wall => ({
          kind: 'tool.after',
          at: wall(tLink + 2),
          sessionId: session,
          callId: call,
          tool: 'subagent',
          status: 'completed',
          childSessionId: child,
        })),
        marker(session, tLink + 3, wall => ({
          kind: 'tool.ended',
          at: wall(tLink + 3),
          sessionId: session,
          callId: call,
          succeeded: true,
          childSessionId: child,
        })),
      ].map(item => ({item, delivery: item.t, order: (order += 1)})),
    )
  }
  entries.sort((a, b) => a.delivery - b.delivery || a.order - b.order)

  // The wall clock: true time, minus an offset that grows at each rollback. A rollback is placed just before a hook and is at
  // least as large as the gap since the previous hook of that session, so the hook lands at or before it (detectable).
  const rollbackAt = new Map<number, number>()
  let rollbacks = 0
  if (adversarial && random() < 0.35) {
    for (const [, plan] of plans) {
      for (const hook of plan.slice(1)) {
        const previous = plan[hook.index - 1]
        if (previous !== undefined && random() < 0.12) {
          rollbackAt.set(hook.t - 1, hook.t - previous.t + int(random, 0, 40))
          rollbacks += 1
        }
      }
    }
  }
  const points = [...rollbackAt.entries()].sort((a, b) => a[0] - b[0])
  const wall = (t: number): number => {
    let offset = 0
    for (const [from, size] of points) if (t > from) offset += size
    return t - offset
  }

  let maxOpenSpansPerTrace: number | undefined
  let maxHookTimes: number | undefined
  let dropRate = 0
  if (adversarial) {
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
  let dropped = 0
  const observations: Observation[] = []
  for (const {item} of entries) {
    const observation = item.make(wall)
    if (item.droppable && dropRate > 0 && random() < dropRate) {
      dropped += 1
      // A drop with no session id (malformed) is told to every session. A hook always has its session id, so a lost hook is always
      // named, and carries its time.
      const named = random() < 0.1 && observation.kind !== 'request' ? undefined : [item.session]
      observations.push({
        kind: 'loss',
        at: observation.at,
        sessionIds: named,
        reason: 'generated',
        // A lost hook is told with its time, for its own session only.
        ...(named !== undefined && observation.kind === 'request'
          ? {hookAt: new Map([[item.session, observation.at]])}
          : {}),
      })
    } else observations.push(observation)
  }
  return {seed, plans, observations, limits, dropped, rollbacks}
}

const SEEDS = 20_000

/** The chat spans by the tag their request carries, which names the hook they belong to. */
function chatsByTag(chats: readonly ChatRecord[]): Map<string, ChatRecord[]> {
  const found = new Map<string, ChatRecord[]>()
  for (const chat of chats.filter(candidate => candidate.requestKind === 'primary')) {
    const tag = (chat.request as {tag?: string} | undefined)?.tag ?? '?'
    found.set(tag, [...(found.get(tag) ?? []), chat])
  }
  return found
}

/** Whether `chat` carries anything that is not `plan`'s, or a prefix shown as the whole: the invariants, one request at a time. */
function wrong(chat: ChatRecord, plan: HookPlan): string | undefined {
  if (chat.texts.some(text => !plan.parts.includes(text))) return `foreign text ${JSON.stringify(chat.texts)}`
  if (chat.messageId !== undefined && chat.messageId !== plan.message) return `foreign message ${chat.messageId}`
  if (chat.usage !== undefined && chat.usage.input !== plan.index + 1)
    return `foreign usage ${String(chat.usage.input)}`
  if (chat.error?.message !== undefined && chat.error.message !== `ERR ${plan.tag}`)
    return `foreign error ${chat.error.message}`
  if (chat.status === 'error' && plan.fate === 'ok') return 'error status on a step that succeeded'
  if (chat.finishReason !== undefined && plan.fate !== 'ok')
    return `finish ${chat.finishReason} on a step that did not finish`
  if (
    chat.finishReason !== undefined &&
    chat.texts.length > 0 &&
    JSON.stringify(chat.texts) !== JSON.stringify(plan.parts)
  ) {
    return `partial text shown as complete ${JSON.stringify(chat.texts)}`
  }
  return undefined
}

describe('the step join over generated sessions', () => {
  it(`carries every step that ran to its end on exactly its own request, in ${String(SEEDS)} seeded clean sessions with hostile delivery`, () => {
    let checked = 0
    let exact = 0
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const {plans, observations, limits} = build(seed, {mode: 'clean'})
      const {records} = replay(observations, {limits})
      const byTag = chatsByTag(records.filter((record): record is ChatRecord => record.kind === 'chat'))
      const problems: unknown[] = []
      for (const [session, plan] of plans) {
        for (const hook of plan) {
          const spans = byTag.get(hook.tag) ?? []
          // Every hook has exactly one span (the cap, the record and the clock are untouched).
          if (spans.length !== 1) {
            problems.push({session, hook: hook.index, spans: spans.length})
            continue
          }
          const chat = spans[0] as ChatRecord
          checked += 1
          const other = wrong(chat, hook)
          if (other !== undefined) problems.push({session, hook: hook.index, other})
          // A step that ran to its end carries its own text, message and usage, whole.
          const want = {texts: hook.parts, message: hook.message, input: hook.index + 1}
          const got = {texts: chat.texts, message: chat.messageId, input: chat.usage?.input}
          exact += hook.fate === 'ok' ? 1 : 0
          if (hook.fate === 'ok' && JSON.stringify(got) !== JSON.stringify(want))
            problems.push({session, hook: hook.index, got, want})
          // A failed attempt closed by a retry hook before its step started holds no step data.
          if (hook.fate === 'preout' && (chat.texts.length > 0 || chat.status !== 'error'))
            problems.push({session, hook: hook.index, preout: got, status: chat.status})
          expect(chat.gaps).not.toContain('step-binding-uncertain')
        }
      }
      expect({seed, problems}).toEqual({seed, problems: []})
    }
    expect(checked).toBeGreaterThan(SEEDS * 3)
    expect(exact).toBeGreaterThan(SEEDS * 2)
  }, 120_000)

  it(`never puts another request's content on a span, and never shows a prefix as the whole, in ${String(SEEDS)} seeded adversarial sessions`, () => {
    let checked = 0
    let uncertain = 0
    let kept = 0
    let dropped = 0
    let rollbacks = 0
    let sameMs = 0
    let bigRecord = 0
    let children = 0
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const generated = build(seed, {mode: 'adversarial'})
      const {plans, observations, limits} = generated
      dropped += generated.dropped
      rollbacks += generated.rollbacks
      const {records, model} = replay(observations, {limits})
      const byTag = chatsByTag(records.filter((record): record is ChatRecord => record.kind === 'chat'))
      const problems: unknown[] = []
      for (const [session, plan] of plans) {
        children += session.startsWith('k') ? 1 : 0
        bigRecord += plan.length > 64 ? 1 : 0
        for (const hook of plan) {
          sameMs += plan[hook.index + 1]?.t === hook.tStart ? 1 : 0
          for (const chat of byTag.get(hook.tag) ?? []) {
            checked += 1
            const other = wrong(chat, hook)
            if (other !== undefined) problems.push({session, hook: hook.index, other})
            const unsure = chat.gaps.includes('step-binding-uncertain')
            uncertain += unsure ? 1 : 0
            if (
              unsure &&
              (chat.texts.length > 0 ||
                chat.messageId !== undefined ||
                chat.usage !== undefined ||
                chat.status !== 'interrupted')
            ) {
              problems.push({session, hook: hook.index, uncertainWithData: chat.texts, status: chat.status})
            }
            kept += chat.texts.length > 0 ? 1 : 0
          }
        }
      }
      const held = model.stats().hookTimes
      if (held > (limits.maxHookTimes ?? 64) * 5) problems.push({hookTimes: held})
      expect({seed, limits, problems}).toEqual({seed, limits, problems: []})
    }
    if (process.env.FRO_BOT_JOIN_STATS === '1') {
      process.stdout.write(
        `join stats: ${JSON.stringify({checked, uncertain, kept, dropped, rollbacks, sameMs, bigRecord, children})}\n`,
      )
    }
    // The generator exercises what it claims to.
    expect(checked).toBeGreaterThan(SEEDS)
    expect(uncertain).toBeGreaterThan(SEEDS / 10)
    expect(kept).toBeGreaterThan(SEEDS)
    expect(dropped).toBeGreaterThan(SEEDS / 8)
    expect(rollbacks).toBeGreaterThan(SEEDS / 20)
    expect(sameMs).toBeGreaterThan(SEEDS / 8)
    expect(bigRecord).toBeGreaterThan(SEEDS / 200)
    expect(children).toBeGreaterThan(SEEDS / 10)
  }, 120_000)
})
