import type {SubagentNoticeObservation} from '@fro-bot/runtime'

import {createOwnershipLedger, shellLedgerKey} from '@fro-bot/runtime'
import {describe, expect, it, vi} from 'vitest'

import {createMockLogger, serializeLoggerCalls} from '../../shared/test-helpers.js'
import {classifyNoticeSettlement, createSubagentNoticeLog, readLedgerState} from './subagent-notice-log.js'

const ROOT = 'ses_root'
const CHILD = 'ses_child_a'
const OTHER = 'ses_child_b'

const MID_FLIGHT: SubagentNoticeObservation = {
  tagState: 'running',
  metadataState: 'completed',
  backgroundWorkRunning: true,
}
const TERMINAL: SubagentNoticeObservation = {
  tagState: 'completed',
  metadataState: 'completed',
  backgroundWorkRunning: false,
}

function infoCalls(logger: ReturnType<typeof createMockLogger>) {
  return vi.mocked(logger.info).mock.calls
}

describe('createSubagentNoticeLog: record', () => {
  it('logs one info line per notice with exactly the fields the diagnosis needs', () => {
    // #given
    const logger = createMockLogger()
    const log = createSubagentNoticeLog({logger, rootSessionId: ROOT})

    // #when a mid-flight report arrives: tag running, metadata completed
    log.record({parentSessionId: ROOT, childSessionId: CHILD, observation: MID_FLIGHT, classification: 'settled'})

    // #then
    expect(infoCalls(logger)).toEqual([
      [
        'Subagent notice observed',
        {
          parentSessionId: ROOT,
          childSessionId: CHILD,
          tagState: 'running',
          metadataState: 'completed',
          backgroundWorkRunning: true,
          classification: 'settled',
        },
      ],
    ])
  })

  it('keeps the tag state and the metadata state in their own fields', () => {
    // #given
    const logger = createMockLogger()
    const log = createSubagentNoticeLog({logger, rootSessionId: ROOT})

    // #when
    log.record({parentSessionId: ROOT, childSessionId: CHILD, observation: MID_FLIGHT, classification: 'settled'})

    // #then a tag `running` is never reported as the metadata's `completed`, or the reverse
    const fields = infoCalls(logger)[0]?.[1]
    expect(fields).toMatchObject({tagState: 'running', metadataState: 'completed'})
    expect(fields).not.toMatchObject({tagState: 'completed'})
  })

  it('logs an unreadable notice that names no child, and no parent', () => {
    // #given
    const logger = createMockLogger()
    const log = createSubagentNoticeLog({logger, rootSessionId: ROOT})

    // #when
    log.record({
      parentSessionId: null,
      childSessionId: null,
      observation: {tagState: null, metadataState: 'running', backgroundWorkRunning: false},
      classification: 'unreadable',
    })

    // #then
    expect(infoCalls(logger)[0]?.[1]).toEqual({
      parentSessionId: null,
      childSessionId: null,
      tagState: null,
      metadataState: 'running',
      backgroundWorkRunning: false,
      classification: 'unreadable',
    })
  })
})

describe('createSubagentNoticeLog: summarize', () => {
  it('says nothing when the run had no children and no notices', () => {
    // #given
    const logger = createMockLogger()
    const log = createSubagentNoticeLog({logger, rootSessionId: ROOT})

    // #when
    log.summarize(createOwnershipLedger())

    // #then
    expect(infoCalls(logger)).toEqual([])
  })

  it('reports each child once: notice count, last states, whether a notice settled it, and the ledger state', () => {
    // #given a child that got a mid-flight and then a terminal report, settled by the first
    const logger = createMockLogger()
    const ledger = createOwnershipLedger()
    ledger.adopt(CHILD, 'child')
    ledger.settle(CHILD)
    const log = createSubagentNoticeLog({logger, rootSessionId: ROOT})
    log.record({parentSessionId: ROOT, childSessionId: CHILD, observation: MID_FLIGHT, classification: 'settled'})
    log.record({
      parentSessionId: ROOT,
      childSessionId: CHILD,
      observation: TERMINAL,
      classification: 'already-settled',
    })
    vi.mocked(logger.info).mockClear()

    // #when
    log.summarize(ledger)

    // #then
    expect(infoCalls(logger)).toEqual([
      [
        'Subagent notices by child',
        {
          sessionId: ROOT,
          children: [
            {
              childSessionId: CHILD,
              notices: 2,
              lastTagState: 'completed',
              lastMetadataState: 'completed',
              settledByNotice: true,
              ledgerState: 'settled',
            },
          ],
        },
      ],
    ])
  })

  it('lists a ledger child that never got a notice, so a settlement by other means is visible', () => {
    // #given a child settled without any notice, a still-outstanding one, and a shell entry
    const logger = createMockLogger()
    const ledger = createOwnershipLedger()
    ledger.adopt(CHILD, 'child')
    ledger.settle(CHILD)
    ledger.adopt(OTHER, 'other')
    ledger.adopt(shellLedgerKey('sh_1'), 'background shell')
    const log = createSubagentNoticeLog({logger, rootSessionId: ROOT})

    // #when
    log.summarize(ledger)

    // #then shells are not children; the two sessions are, with zero notices
    expect(infoCalls(logger)[0]?.[1]).toEqual({
      sessionId: ROOT,
      children: [
        {
          childSessionId: CHILD,
          notices: 0,
          lastTagState: null,
          lastMetadataState: null,
          settledByNotice: false,
          ledgerState: 'settled',
        },
        {
          childSessionId: OTHER,
          notices: 0,
          lastTagState: null,
          lastMetadataState: null,
          settledByNotice: false,
          ledgerState: 'outstanding',
        },
      ],
    })
  })

  it('does not count a notice that was only deferred', () => {
    // #given a notice held back because its parent was not owned yet
    const logger = createMockLogger()
    const log = createSubagentNoticeLog({logger, rootSessionId: ROOT})
    log.record({
      parentSessionId: 'ses_unowned',
      childSessionId: CHILD,
      observation: TERMINAL,
      classification: 'deferred',
    })

    // #when
    log.summarize(undefined)

    // #then it has its own line, and the summary has nothing to say about it
    expect(infoCalls(logger)).toHaveLength(1)
  })

  it('reports a child a notice named when there is no ledger', () => {
    // #given
    const logger = createMockLogger()
    const log = createSubagentNoticeLog({logger, rootSessionId: ROOT})
    log.record({parentSessionId: ROOT, childSessionId: CHILD, observation: TERMINAL, classification: 'untracked'})
    vi.mocked(logger.info).mockClear()

    // #when
    log.summarize(undefined)

    // #then
    expect(infoCalls(logger)[0]?.[1]).toMatchObject({
      children: [{childSessionId: CHILD, notices: 1, settledByNotice: false, ledgerState: 'untracked'}],
    })
  })

  it('counts a settlement on adoption as a settlement by the notice that preceded it', () => {
    // #given a notice that arrived before its child was known
    const logger = createMockLogger()
    const ledger = createOwnershipLedger()
    ledger.adopt(CHILD, 'child')
    ledger.settle(CHILD)
    const log = createSubagentNoticeLog({logger, rootSessionId: ROOT})
    log.record({parentSessionId: ROOT, childSessionId: CHILD, observation: TERMINAL, classification: 'untracked'})
    log.settledOnAdoption(CHILD)
    vi.mocked(logger.info).mockClear()

    // #when
    log.summarize(ledger)

    // #then
    expect(infoCalls(logger)[0]?.[1]).toMatchObject({children: [{childSessionId: CHILD, settledByNotice: true}]})
  })

  it('bounds the summary and says how many children it left out', () => {
    // #given more children than a line should carry
    const logger = createMockLogger()
    const ledger = createOwnershipLedger()
    for (let index = 0; index < 120; index += 1) ledger.adopt(`ses_child_${index}`, 'child')
    const log = createSubagentNoticeLog({logger, rootSessionId: ROOT})

    // #when
    log.summarize(ledger)

    // #then
    const fields = infoCalls(logger)[0]?.[1] as {children: unknown[]; omitted: number}
    expect(fields.children).toHaveLength(100)
    expect(fields.omitted).toBe(20)
  })
})

describe('createSubagentNoticeLog: nothing but the allowed fields is ever logged', () => {
  it('never logs a body or a description, whatever the observation was built from', () => {
    // #given
    const logger = createMockLogger()
    const log = createSubagentNoticeLog({logger, rootSessionId: ROOT})

    // #when
    log.record({parentSessionId: ROOT, childSessionId: CHILD, observation: MID_FLIGHT, classification: 'settled'})
    log.summarize(createOwnershipLedger())

    // #then every key of the notice line and of the summary line is on the list
    const [noticeLine, summaryLine] = infoCalls(logger).map(([, fields]) => fields)
    expect(Object.keys(noticeLine ?? {}).sort()).toEqual([
      'backgroundWorkRunning',
      'childSessionId',
      'classification',
      'metadataState',
      'parentSessionId',
      'tagState',
    ])
    expect(Object.keys(summaryLine ?? {}).sort()).toEqual(['children', 'sessionId'])
    const [child] = (summaryLine as {children: object[]}).children
    expect(Object.keys(child ?? {}).sort()).toEqual([
      'childSessionId',
      'lastMetadataState',
      'lastTagState',
      'ledgerState',
      'notices',
      'settledByNotice',
    ])
    expect(serializeLoggerCalls(logger)).not.toMatch(/description|body|"text"/i)
  })
})

describe('ledger reading helpers', () => {
  it('reads the ledger state of a child without changing it', () => {
    // #given
    const ledger = createOwnershipLedger()
    ledger.adopt(CHILD, 'child')

    // #when / #then
    expect(readLedgerState(ledger, CHILD)).toBe('outstanding')
    expect(readLedgerState(ledger, OTHER)).toBe('untracked')
    expect(readLedgerState(undefined, CHILD)).toBe('untracked')
    ledger.markUnknown(CHILD)
    expect(readLedgerState(ledger, CHILD)).toBe('unknown')
    ledger.settle(CHILD)
    expect(readLedgerState(ledger, CHILD)).toBe('settled')
  })

  it('classifies what a notice is about to do to the ledger', () => {
    // #given
    const ledger = createOwnershipLedger()
    ledger.adopt(CHILD, 'child')
    ledger.adopt(OTHER, 'other')
    ledger.settle(OTHER)

    // #when / #then
    expect(classifyNoticeSettlement(ledger, CHILD)).toBe('settled')
    expect(classifyNoticeSettlement(ledger, OTHER)).toBe('already-settled')
    expect(classifyNoticeSettlement(ledger, 'ses_stranger')).toBe('untracked')
    expect(classifyNoticeSettlement(undefined, CHILD)).toBe('untracked')
    // reading changed nothing
    expect(ledger.snapshot().map(entry => entry.state)).toEqual(['outstanding', 'settled'])
  })
})
