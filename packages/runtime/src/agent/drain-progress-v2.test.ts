import type {DirectoryActivity, DirectoryObservation} from './directory-quiescence-v2.js'

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {
  BLOCKING_SET_ID_CAP,
  createDrainProgress,
  describeBlockingSet,
  DRAIN_HEARTBEAT_MS,
  DRAIN_UNREADABLE_MESSAGE,
  DRAIN_WAITING_MESSAGE,
} from './drain-progress-v2.js'
import {createRemoteOpenCodeV2Client} from './remote-client-v2.js'

interface Line {
  readonly message: string
  readonly fields: Readonly<Record<string, unknown>>
}

function activity(overrides: Partial<DirectoryActivity> = {}): DirectoryActivity {
  return {activeSessionIds: [], runningShellIds: [], queuedInbox: [], ...overrides}
}

const active = (overrides: Partial<DirectoryActivity> = {}): DirectoryObservation => ({
  kind: 'active',
  activity: activity(overrides),
})
const unreadable = (reason: string, overrides: Partial<DirectoryActivity> = {}): DirectoryObservation => ({
  kind: 'unreadable',
  reason,
  activity: activity(overrides),
})
const quiet: DirectoryObservation = {kind: 'quiescent'}

function makeProgress() {
  const lines: Line[] = []
  const progress = createDrainProgress({emit: (message, fields) => lines.push({message, fields})})
  return {lines, progress}
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-02T00:00:00Z'))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('describeBlockingSet', () => {
  it('caps each list at the id cap and keeps the true count', () => {
    // #given
    const many = Array.from({length: BLOCKING_SET_ID_CAP + 7}, (_, index) => `id_${String(index).padStart(2, '0')}`)

    // #when
    const set = describeBlockingSet(
      activity({
        activeSessionIds: many,
        runningShellIds: many,
        queuedInbox: many.map(sessionId => ({sessionId, queued: 1})),
      }),
    )

    // #then
    expect(set.sessions.count).toBe(many.length)
    expect(set.sessions.ids).toHaveLength(BLOCKING_SET_ID_CAP)
    expect(set.shells.count).toBe(many.length)
    expect(set.shells.ids).toHaveLength(BLOCKING_SET_ID_CAP)
    expect(set.inbox.count).toBe(many.length)
    expect(set.inbox.items).toHaveLength(BLOCKING_SET_ID_CAP)
  })

  it('copies ids and enum-like fields only, never content', () => {
    // #given an inbox entry built the way a careless client could build one: it carries text and a command.
    const rogue = {
      sessionId: 'ses_a',
      queued: 1,
      items: [
        {
          type: 'synthetic',
          delivery: 'steer',
          source: 'shell',
          text: 'SECRET-MESSAGE-TEXT',
          command: 'SECRET-COMMAND',
        },
      ] as const,
      text: 'SECRET-ENTRY-TEXT',
    }

    // #when
    const set = describeBlockingSet(activity({queuedInbox: [rogue]}))

    // #then
    expect(set.inbox.items).toEqual([
      {sessionId: 'ses_a', queued: 1, items: [{type: 'synthetic', delivery: 'steer', source: 'shell'}]},
    ])
    expect(JSON.stringify(set)).not.toContain('SECRET')
  })
})

describe('createDrainProgress', () => {
  it('logs once when the blocking set changes, not on every reading', () => {
    // #given
    const {lines, progress} = makeProgress()

    // #when the same blocker is read many times, then it changes, then it is read again
    for (let reading = 0; reading < 20; reading += 1) {
      progress.observe(active({activeSessionIds: ['ses_a']}))
      vi.advanceTimersByTime(800)
    }
    progress.observe(active({activeSessionIds: ['ses_a'], runningShellIds: ['sh_1']}))
    progress.observe(active({activeSessionIds: ['ses_a'], runningShellIds: ['sh_1']}))

    // #then
    expect(lines.map(line => line.message)).toEqual([DRAIN_WAITING_MESSAGE, DRAIN_WAITING_MESSAGE])
    expect(lines[0]?.fields).toMatchObject({
      sessions: {count: 1, ids: ['ses_a']},
      shells: {count: 0, ids: []},
      inbox: {count: 0, items: []},
      readings: 1,
      elapsedMs: 0,
    })
    expect(lines[1]?.fields).toMatchObject({shells: {count: 1, ids: ['sh_1']}, readings: 21})
  })

  it('does not treat the order of ids as a change', () => {
    // #given
    const {lines, progress} = makeProgress()

    // #when
    progress.observe(active({activeSessionIds: ['ses_a', 'ses_b']}))
    progress.observe(active({activeSessionIds: ['ses_b', 'ses_a']}))

    // #then
    expect(lines).toHaveLength(1)
  })

  it('counts a change beyond the id cap as a change', () => {
    // #given
    const {lines, progress} = makeProgress()
    const base = Array.from({length: BLOCKING_SET_ID_CAP + 3}, (_, index) => `ses_${String(index).padStart(2, '0')}`)

    // #when
    progress.observe(active({activeSessionIds: base}))
    progress.observe(active({activeSessionIds: [...base, 'ses_zz']}))

    // #then
    expect(lines).toHaveLength(2)
    expect(lines[1]?.fields).toMatchObject({sessions: {count: BLOCKING_SET_ID_CAP + 4}})
  })

  it('counts a replaced id beyond the id cap as a change when the count stays the same', () => {
    // #given more ids than the cap, so the last ones are never displayed
    const {lines, progress} = makeProgress()
    const base = Array.from({length: BLOCKING_SET_ID_CAP + 3}, (_, index) => `ses_${String(index).padStart(2, '0')}`)
    const replaced = [...base.slice(0, -1), 'ses_zz']

    // #when the last id is swapped for another, so the count and the displayed ids are the same
    progress.observe(active({activeSessionIds: base}))
    progress.observe(active({activeSessionIds: replaced}))

    // #then
    expect(lines).toHaveLength(2)
    expect(lines[1]?.fields).toMatchObject({sessions: {count: base.length}})
    expect(lines[1]?.fields.sessions).toEqual(lines[0]?.fields.sessions)
  })

  it('starts a new stretch after a gap of a heartbeat between readings, and measures the next heartbeat from it', () => {
    // #given a blocker read once
    const {lines, progress} = makeProgress()
    progress.observe(active({activeSessionIds: ['ses_a']}))

    // #when the next reading of the same blocker comes a full heartbeat later (the gateway reads only while its gate
    // validates)
    vi.advanceTimersByTime(DRAIN_HEARTBEAT_MS)
    progress.observe(active({activeSessionIds: ['ses_a']}))

    // #then it is a new stretch: a line for the change, with the elapsed time restarted, not a heartbeat of the old one
    expect(lines).toHaveLength(2)
    expect(lines[1]?.fields).toMatchObject({elapsedMs: 0, readings: 2})

    // #when the blocker is read again before another heartbeat is due
    vi.advanceTimersByTime(DRAIN_HEARTBEAT_MS - 1_000)
    progress.observe(active({activeSessionIds: ['ses_a']}))

    // #then the heartbeat clock restarted with the new stretch: still silent
    expect(lines).toHaveLength(2)

    // #when it is read once a heartbeat has passed since the new stretch's line
    vi.advanceTimersByTime(1_000)
    progress.observe(active({activeSessionIds: ['ses_a']}))

    // #then the heartbeat counts from the new stretch (one heartbeat), not from the first reading (two)
    expect(lines).toHaveLength(3)
    expect(lines[2]?.fields).toMatchObject({elapsedMs: DRAIN_HEARTBEAT_MS, readings: 4})
  })

  it('keeps one stretch across a gap shorter than a heartbeat', () => {
    // #given
    const {lines, progress} = makeProgress()
    progress.observe(active({activeSessionIds: ['ses_a']}))

    // #when the next reading is one millisecond short of a heartbeat later
    vi.advanceTimersByTime(DRAIN_HEARTBEAT_MS - 1)
    progress.observe(active({activeSessionIds: ['ses_a']}))

    // #then it is the same stretch and the same blocker: no change, and the heartbeat is not due yet
    expect(lines).toHaveLength(1)
  })

  it('logs a heartbeat about every 60 s of continuous non-quiet, with the elapsed time', () => {
    // #given
    const {lines, progress} = makeProgress()
    const observation = active({queuedInbox: [{sessionId: 'ses_root', queued: 1}]})

    // #when a blocker stays for just over three minutes, read every 800 ms
    for (let elapsed = 0; elapsed <= 185_000; elapsed += 800) {
      progress.observe(observation)
      vi.advanceTimersByTime(800)
    }

    // #then one line for the change, then one per minute
    expect(lines).toHaveLength(4)
    const elapsedMs = lines.map(line => line.fields.elapsedMs as number)
    expect(elapsedMs[0]).toBe(0)
    for (const value of elapsedMs.slice(1)) {
      expect(value % 1000).toBeLessThan(800)
    }
    expect(elapsedMs[1]).toBeGreaterThanOrEqual(DRAIN_HEARTBEAT_MS)
    expect(elapsedMs[1]).toBeLessThan(DRAIN_HEARTBEAT_MS + 800)
    expect(elapsedMs[3]).toBeGreaterThanOrEqual(3 * DRAIN_HEARTBEAT_MS)
    expect(lines.every(line => line.message === DRAIN_WAITING_MESSAGE)).toBe(true)
  })

  it('stays silent before the heartbeat is due', () => {
    // #given
    const {lines, progress} = makeProgress()

    // #when
    progress.observe(active({activeSessionIds: ['ses_a']}))
    vi.advanceTimersByTime(DRAIN_HEARTBEAT_MS - 1)
    progress.observe(active({activeSessionIds: ['ses_a']}))

    // #then
    expect(lines).toHaveLength(1)
  })

  it('starts a new stretch after a quiet reading', () => {
    // #given
    const {lines, progress} = makeProgress()
    progress.observe(active({activeSessionIds: ['ses_a']}))
    vi.advanceTimersByTime(30_000)

    // #when the directory reads quiet, then the same blocker comes back
    progress.observe(quiet)
    vi.advanceTimersByTime(1_000)
    progress.observe(active({activeSessionIds: ['ses_a']}))

    // #then it is a new line, and its elapsed time restarts
    expect(lines).toHaveLength(2)
    expect(lines[1]?.fields.elapsedMs).toBe(0)
  })

  it('logs an unreadable directory once per stretch, with the reason, and keeps the heartbeat', () => {
    // #given
    const {lines, progress} = makeProgress()

    // #when the directory is unreadable for two minutes, nothing found
    for (let elapsed = 0; elapsed <= 125_000; elapsed += 800) {
      progress.observe(unreadable('session.inbox: http'))
      vi.advanceTimersByTime(800)
    }

    // #then one transition line, and the heartbeat carries the reason with empty sets
    const unreadableLines = lines.filter(line => line.message === DRAIN_UNREADABLE_MESSAGE)
    expect(unreadableLines).toHaveLength(1)
    expect(unreadableLines[0]?.fields).toMatchObject({reason: 'session.inbox: http', readings: 1, elapsedMs: 0})
    const waiting = lines.filter(line => line.message === DRAIN_WAITING_MESSAGE)
    expect(waiting).toHaveLength(2)
    expect(waiting[0]?.fields).toMatchObject({
      sessions: {count: 0},
      shells: {count: 0},
      inbox: {count: 0},
      unreadable: 'session.inbox: http',
    })
  })

  it('names what an unreadable reading did find, and logs the transition again after a readable one', () => {
    // #given
    const {lines, progress} = makeProgress()

    // #when
    progress.observe(unreadable('timed out', {runningShellIds: ['sh_9']}))
    progress.observe(active({runningShellIds: ['sh_9']}))
    progress.observe(unreadable('timed out', {runningShellIds: ['sh_9']}))

    // #then
    expect(lines.map(line => line.message)).toEqual([
      DRAIN_UNREADABLE_MESSAGE,
      DRAIN_WAITING_MESSAGE,
      DRAIN_UNREADABLE_MESSAGE,
    ])
    expect(lines[1]?.fields).toMatchObject({shells: {ids: ['sh_9']}, unreadable: 'timed out'})
  })

  it('keeps the last non-quiet blocking set after the directory reads quiet', () => {
    // #given
    const {progress} = makeProgress()
    expect(progress.lastBlocking()).toBeNull()

    // #when
    progress.observe(active({activeSessionIds: ['ses_a']}))
    progress.observe(quiet)

    // #then
    expect(progress.lastBlocking()?.sessions).toEqual({count: 1, ids: ['ses_a']})
  })

  it('never logs inbox text, whatever the fixture carries', () => {
    // #given
    const {lines, progress} = makeProgress()
    const rogue = {
      sessionId: 'ses_a',
      queued: 2,
      items: [{type: 'synthetic', source: 'shell', text: 'SECRET-MESSAGE-TEXT', command: 'SECRET-COMMAND'}] as const,
    }

    // #when
    progress.observe(active({queuedInbox: [rogue]}))

    // #then
    expect(lines).toHaveLength(1)
    expect(lines[0]?.fields).toMatchObject({
      inbox: {count: 1, items: [{sessionId: 'ses_a', queued: 2, items: [{type: 'synthetic', source: 'shell'}]}]},
    })
    expect(JSON.stringify(lines)).not.toContain('SECRET')
    expect(JSON.stringify(progress.lastBlocking())).not.toContain('SECRET')
  })
})

/** A client reading an inbox whose items carry caller-chosen metadata, the way a user item or a synthetic one can. */
async function readInbox(items: readonly unknown[]) {
  const client = createRemoteOpenCodeV2Client({
    baseUrl: 'http://example.invalid',
    fetch: async () =>
      new Response(JSON.stringify({data: items}), {status: 200, headers: {'content-type': 'application/json'}}),
  })
  const result = await client.listSessionInbox({sessionId: 'ses_probe'})
  if (!result.success) throw new Error(JSON.stringify(result))
  return result.data
}

describe('what a queued inbox item can put in a log', () => {
  const hostileItems = [
    {type: 'user', delivery: 'queue', payload: {text: 'SECRET-TEXT', metadata: {source: 'PrivateCustomer'}}},
    {type: 'synthetic', delivery: 'steer', payload: {text: 'SECRET-TEXT', metadata: {source: 'PrivateCustomer'}}},
    {type: 'TenantAcme', delivery: 'AcmeDelivery', payload: {text: 'SECRET-TEXT'}},
  ]

  it('never reaches the progress log or the last blocking set, whatever the metadata says', async () => {
    // #given
    const {lines, progress} = makeProgress()
    const summary = await readInbox(hostileItems)

    // #when
    progress.observe(active({queuedInbox: [{sessionId: 'ses_probe', ...summary}]}))

    // #then the item kinds are named, the caller's strings are not
    expect(lines).toHaveLength(1)
    expect(lines[0]?.fields).toMatchObject({
      inbox: {
        items: [
          {
            sessionId: 'ses_probe',
            queued: 3,
            items: [
              {type: 'user', delivery: 'queue'},
              {type: 'synthetic', delivery: 'steer', source: 'other'},
              {type: 'other', delivery: 'other'},
            ],
          },
        ],
      },
    })
    for (const text of [JSON.stringify(lines), JSON.stringify(progress.lastBlocking())]) {
      expect(text).not.toMatch(/PrivateCustomer|TenantAcme|AcmeDelivery|SECRET/)
    }
  })

  it('never reaches the log of an unreadable reading either', async () => {
    // #given
    const {lines, progress} = makeProgress()
    const summary = await readInbox(hostileItems)

    // #when
    progress.observe(unreadable('session.inbox: http', {queuedInbox: [{sessionId: 'ses_probe', ...summary}]}))

    // #then
    expect(lines.map(line => line.message)).toEqual([DRAIN_UNREADABLE_MESSAGE, DRAIN_WAITING_MESSAGE])
    expect(JSON.stringify(lines)).not.toMatch(/PrivateCustomer|TenantAcme|AcmeDelivery|SECRET/)
  })
})
