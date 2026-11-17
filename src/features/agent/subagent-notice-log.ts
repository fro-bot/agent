import type {OwnershipLedger, SubagentNoticeObservation} from '@fro-bot/runtime'
import type {Logger} from '../../shared/logger.js'
import {isShellLedgerKey} from '@fro-bot/runtime'

/**
 * Diagnostic log of the `<subagent>` notices a V2 run observes, so a run that ends with its parent "awaiting the
 * remaining reviewers" can be explained from the log: which notices arrived, what each said in the tag and in
 * `metadata.state`, and whether the Action counted the child settled because of it.
 *
 * Diagnostic only. Nothing here is read back by the event loop, so it cannot change what settles or drains.
 *
 * What is logged is closed on purpose: ids, two short state words, one boolean and the Action's classification. A
 * notice's body and description carry child output and are untrusted, so they never reach this module (the observation
 * is built without them, `subagent-notice-observation.ts`). The logger stamps each line with its own timestamp.
 */

/**
 * What the Action did with a notice.
 * - `settled`: the child was tracked and not yet settled; the notice settled it.
 * - `already-settled`: the child was tracked and already settled (a later report, or reconciliation got there first).
 * - `untracked`: the parent is owned but the ledger does not track the child, so nothing settled now. The notice is
 *   remembered and settles the child if it is adopted later.
 * - `deferred`: the parent session is not known to belong to the run yet; the notice is held and read again on adoption.
 * - `unreadable`: the server marked it a subagent notice but the reader could not take it; nothing was settled.
 */
export type NoticeClassification = 'already-settled' | 'deferred' | 'settled' | 'unreadable' | 'untracked'

export type NoticeLedgerState = 'outstanding' | 'settled' | 'unknown' | 'untracked'

/** The ledger's state for a child, without changing it. `untracked` also covers a run with no ledger. */
export function readLedgerState(ledger: OwnershipLedger | undefined, childSessionId: string): NoticeLedgerState {
  if (ledger === undefined || !ledger.isTracked(childSessionId)) return 'untracked'
  return ledger.snapshot().find(entry => entry.sessionId === childSessionId)?.state ?? 'untracked'
}

/** What a readable notice is about to do to the ledger. Call it BEFORE the notice is applied. */
export function classifyNoticeSettlement(
  ledger: OwnershipLedger | undefined,
  childSessionId: string,
): 'already-settled' | 'settled' | 'untracked' {
  const state = readLedgerState(ledger, childSessionId)
  if (state === 'untracked') return 'untracked'
  return state === 'settled' ? 'already-settled' : 'settled'
}

export interface NoticeLogEntry {
  /** The session the notice was delivered to. `null` when the frame did not name one. */
  readonly parentSessionId: string | null
  /** The child the notice names. `null` when an unreadable notice did not name a readable one. */
  readonly childSessionId: string | null
  readonly observation: SubagentNoticeObservation
  readonly classification: NoticeClassification
}

export interface SubagentNoticeLog {
  /** Log one observed notice. Counts it for the child's summary unless it was only deferred. */
  readonly record: (entry: NoticeLogEntry) => void
  /** A child a notice had named earlier was settled when it was adopted: the notice settled it, late. */
  readonly settledOnAdoption: (childSessionId: string) => void
  /** Log one line with a summary per child. Call it when the run releases or the observation stops. */
  readonly summarize: (ledger: OwnershipLedger | undefined) => void
}

interface ChildTally {
  notices: number
  lastTagState: string | null
  lastMetadataState: string | null
  settledByNotice: boolean
}

/** More children than this are counted in `omitted` instead of listed, so one line stays one line. */
const SUMMARY_CHILD_CAP = 100

export function createSubagentNoticeLog(options: {
  readonly logger: Logger
  /** The run's root session, named on the summary line. */
  readonly rootSessionId: string
}): SubagentNoticeLog {
  const {logger, rootSessionId} = options
  const tallies = new Map<string, ChildTally>()

  return {
    record: entry => {
      const {parentSessionId, childSessionId, observation, classification} = entry
      logger.info('Subagent notice observed', {
        parentSessionId,
        childSessionId,
        tagState: observation.tagState,
        metadataState: observation.metadataState,
        backgroundWorkRunning: observation.backgroundWorkRunning,
        classification,
      })

      // A deferred notice is read again on adoption and counted then.
      if (childSessionId === null || classification === 'deferred') return
      const tally = tallies.get(childSessionId) ?? {
        notices: 0,
        lastTagState: null,
        lastMetadataState: null,
        settledByNotice: false,
      }
      tally.notices += 1
      tally.lastTagState = observation.tagState
      tally.lastMetadataState = observation.metadataState
      if (classification === 'settled') tally.settledByNotice = true
      tallies.set(childSessionId, tally)
    },

    settledOnAdoption: childSessionId => {
      const tally = tallies.get(childSessionId)
      if (tally !== undefined) tally.settledByNotice = true
    },

    summarize: ledger => {
      const ledgerChildren = (ledger?.snapshot() ?? []).filter(entry => !isShellLedgerKey(entry.sessionId))
      const childIds = [...new Set([...ledgerChildren.map(entry => entry.sessionId), ...tallies.keys()])]
      if (childIds.length === 0) return

      const children = childIds.slice(0, SUMMARY_CHILD_CAP).map(childSessionId => {
        const tally = tallies.get(childSessionId)
        return {
          childSessionId,
          notices: tally?.notices ?? 0,
          lastTagState: tally?.lastTagState ?? null,
          lastMetadataState: tally?.lastMetadataState ?? null,
          settledByNotice: tally?.settledByNotice ?? false,
          ledgerState: readLedgerState(ledger, childSessionId),
        }
      })
      logger.info('Subagent notices by child', {
        sessionId: rootSessionId,
        children,
        ...(childIds.length > SUMMARY_CHILD_CAP ? {omitted: childIds.length - SUMMARY_CHILD_CAP} : {}),
      })
    },
  }
}
