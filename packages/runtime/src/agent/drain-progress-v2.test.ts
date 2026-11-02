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
        {type: 'synthetic', delivery: 'steer', source: 'shell', text: 'SECRET-MESSAGE-TEXT', command: 'SECRET-COMMAND'},
      ],
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
      items: [{type: 'synthetic', source: 'shell', text: 'SECRET-MESSAGE-TEXT', command: 'SECRET-COMMAND'}],
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
