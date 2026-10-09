/**
 * What the event stream actually delivered to the reply sink, kept so the drain-completion gate can refuse to admit
 * success until the follow-up turn's persisted reply text has been delivered in full.
 *
 * The sink is append-only and may already be on screen, so nothing here ever repairs or appends: a run whose
 * stream missed (or only partly delivered) the follow-up reply simply is not admitted until the stream catches up,
 * and otherwise reaches its deadline as incomplete.
 *
 * Delivery semantics mirror base `run-core.ts` exactly: the sink receives text from `message.part.delta` and
 * `session.next.text.delta` only. A text part that arrives as a whole `message.part.updated` with no deltas was
 * never appended on base (that handler only acts on `reasoning` and `tool` parts), so it is recorded separately
 * and treated as "not on base's delivery channel" rather than as a delivery gap.
 */

/** A persisted reply text part, as REST shows it. */
export interface ReplyTextPart {
  readonly id: string
  readonly text: string
}

export interface ReplyDeliveryTracker {
  /** A root text delta appended to the sink. `partId` is null for deltas that carry no part id. */
  readonly recordDelta: (partId: string | null, text: string) => void
  /** A root, non-synthetic text part observed whole on `message.part.updated` (never appended to the sink). */
  readonly recordWholePart: (partId: string, text: string) => void
  /**
   * Whether every persisted reply part has been delivered to the sink in full.
   *
   * Rule, for the follow-up turns' persisted parts P1..Pn (already scoped: non-synthetic, non-ignored, non-empty,
   * in message order):
   * - PART-ID DELTAS: a part that received deltas with its part id needs `delivered(part) === persisted(part)`;
   *   delivered may differ only by trailing whitespace that REST trimmed (`delivered` starts with `persisted` and
   *   the remainder is whitespace). A partial delivery, or a later part without an earlier one, is NOT covered.
   *   No ordering is demanded among these: the sink is append-only, so what already streamed in whatever order
   *   cannot be changed, and the gate's job is completeness, not repair.
   * - UNATTRIBUTED (no part id) DELTAS: such text cannot be matched by id. The parts that have no part-id
   *   delivery, taken in persisted order, must be spelled out by the END of the root's part-id-less delivered
   *   text: walking from the last part backwards, each part (allowing trailing whitespace the persisted text lost)
   *   must end exactly where the next one starts. That is the turn's total unattributed text, in persisted order,
   *   equal to the parts joined — anchored at the end because the run's earlier turns may have delivered
   *   unattributed text too, so the turn cannot be delimited from the front. A PREFIX of a part, or a part
   *   missing from the middle, never matches.
   * - WHOLE-PART EXCEPTION: a part the stream carried ONLY as a whole `message.part.updated` (no deltas of either
   *   kind attributed to it, the whole text equal to the persisted text, and no part-id-less delivery in the run
   *   that could be it) is not on base's delivery channel, so it is skipped rather than stalling the run forever.
   */
  readonly covers: (parts: readonly ReplyTextPart[]) => boolean
}

/** `delivered` is `persisted` plus, at most, trailing whitespace that REST trimmed. */
function equalModuloTrailingWhitespace(delivered: string, persisted: string): boolean {
  return delivered === persisted || (delivered.startsWith(persisted) && delivered.slice(persisted.length).trim() === '')
}

/**
 * Match `text` as the segment of `log` that ends at `end` (allowing trailing whitespace the persisted text lost),
 * returning where that segment starts, or -1.
 */
function matchEndingAt(log: string, end: number, text: string): number {
  const exactStart = end - text.length
  if (exactStart >= 0 && log.startsWith(text, exactStart)) return exactStart
  const trimmed = text.trimEnd()
  if (trimmed.length === 0) return end
  let trimmedEnd = end
  while (trimmedEnd > 0 && log.charAt(trimmedEnd - 1).trim() === '') trimmedEnd -= 1
  const start = trimmedEnd - trimmed.length
  return start >= 0 && log.startsWith(trimmed, start) ? start : -1
}

export function createReplyDeliveryTracker(): ReplyDeliveryTracker {
  const byPart = new Map<string, string>()
  const wholeParts = new Map<string, string>()
  let unattributedText = ''

  return {
    recordDelta: (partId, text) => {
      if (partId === null) {
        unattributedText += text
        return
      }
      byPart.set(partId, (byPart.get(partId) ?? '') + text)
    },
    recordWholePart: (partId, text) => {
      wholeParts.set(partId, text)
    },
    covers: parts => {
      const needUnattributed: ReplyTextPart[] = []
      for (const part of parts) {
        const attributed = byPart.get(part.id)
        if (attributed !== undefined) {
          if (!equalModuloTrailingWhitespace(attributed, part.text)) return false
          continue
        }
        const whole = wholeParts.get(part.id)
        if (unattributedText.length === 0 && whole !== undefined && equalModuloTrailingWhitespace(whole, part.text)) {
          continue
        }
        needUnattributed.push(part)
      }
      let end = unattributedText.length
      for (let index = needUnattributed.length - 1; index >= 0; index -= 1) {
        const part = needUnattributed[index]
        if (part === undefined) continue
        const start = matchEndingAt(unattributedText, end, part.text)
        if (start < 0) return false
        end = start
      }
      return true
    },
  }
}
