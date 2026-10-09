/**
 * What the event stream actually delivered to the reply sink, kept so the drain-completion gate can refuse to admit
 * success until the follow-up turn's persisted reply text has been delivered in full.
 *
 * The sink is append-only and may already be on screen, so nothing here ever repairs or appends: a run whose
 * stream missed (or only partly delivered) the follow-up reply simply is not admitted until the stream catches up,
 * and otherwise reaches its deadline as incomplete.
 *
 * Delivery semantics mirror base `run-core.ts` exactly: the sink receives text from `message.part.delta` and
 * `session.next.text.delta` only. A text part that arrives as a whole `message.part.updated` was never appended on
 * base (that handler only acts on `reasoning` and `tool` parts) and is NOT delivery evidence here: it cannot be
 * told apart from deltas that were lost, so a reply that only ever arrived whole keeps the run incomplete.
 */

/** A persisted reply text part, as REST shows it. */
export interface ReplyTextPart {
  readonly id: string
  readonly text: string
}

export interface ReplyDeliveryTracker {
  /** A root text delta appended to the sink. `partId` is null for deltas that carry no part id. */
  readonly recordDelta: (partId: string | null, text: string) => void
  /**
   * Whether every persisted reply part has been delivered to the sink in full.
   *
   * Rule, for the follow-up turns' persisted parts P1..Pn (already scoped: non-synthetic, non-ignored, non-empty,
   * in message order). The complete persisted text is always required — the persisted side is never trimmed, so
   * a missing separator or a missing trailing space is a missing part of the reply. The only slack is EXTRA
   * whitespace the stream delivered after the text:
   * - PART-ID DELTAS: a part that received deltas with its part id needs `delivered(part)` to START WITH the
   *   persisted text, with whitespace only after it. A partial delivery, or a later part without an earlier one,
   *   is NOT covered. No ordering is demanded among these: the sink is append-only, so what already streamed in
   *   whatever order cannot be changed, and the gate's job is completeness, not repair.
   * - UNATTRIBUTED (no part id) DELTAS: such text cannot be matched by id. The parts that have no part-id
   *   delivery, concatenated exactly in persisted order (nothing trimmed, separators included), must END the
   *   root's part-id-less delivered text, followed by nothing but extra whitespace: covered iff some
   *   whitespace-only suffix of the delivered text can be dropped so that what remains ends with the
   *   concatenation. That is the turn's total unattributed text, in persisted order, equal to the parts joined —
   *   anchored at the end because the run's earlier turns may have delivered unattributed text too, so the turn
   *   cannot be delimited from the front. Aligning the concatenation, not each part, keeps a whitespace-only
   *   final part from being mis-split. A PREFIX of a part, a part missing from the middle, a missing separator,
   *   or a foreign separator between parts never matches.
   * - A text part seen only as a whole `message.part.updated` is not delivery evidence and is never counted.
   */
  readonly covers: (parts: readonly ReplyTextPart[]) => boolean
}

/** `delivered` is the complete `persisted` text, followed by nothing but extra whitespace. */
function coversPersisted(delivered: string, persisted: string): boolean {
  return delivered.startsWith(persisted) && delivered.slice(persisted.length).trim() === ''
}

/**
 * Whether `delivered` ends with `expected`, allowing a whitespace-only suffix of `delivered` after it. Tries every
 * suffix length from none up to the whole trailing-whitespace run, so a `expected` that itself ends in whitespace
 * (or is whitespace only) aligns exactly where it is delivered, and any whitespace beyond it is the extra.
 */
function endsWithAllowingTrailingWhitespace(delivered: string, expected: string): boolean {
  for (let end = delivered.length; end >= expected.length; end -= 1) {
    if (delivered.startsWith(expected, end - expected.length)) return true
    if (end === 0 || delivered.charAt(end - 1).trim() !== '') return false
  }
  return false
}

export function createReplyDeliveryTracker(): ReplyDeliveryTracker {
  const byPart = new Map<string, string>()
  let unattributedText = ''

  return {
    recordDelta: (partId, text) => {
      if (partId === null) {
        unattributedText += text
        return
      }
      byPart.set(partId, (byPart.get(partId) ?? '') + text)
    },
    covers: parts => {
      const needUnattributed: ReplyTextPart[] = []
      for (const part of parts) {
        const attributed = byPart.get(part.id)
        if (attributed === undefined) {
          needUnattributed.push(part)
        } else if (!coversPersisted(attributed, part.text)) {
          return false
        }
      }
      // The part-id-less parts, concatenated exactly in persisted order (nothing trimmed, separators included),
      // must END the part-id-less delivered text, followed by nothing but extra whitespace. Aligning the whole
      // concatenation (rather than part by part) cannot mis-split a whitespace-only part at the end.
      const expected = needUnattributed.map(part => part.text).join('')
      if (expected.length > 0 && !endsWithAllowingTrailingWhitespace(unattributedText, expected)) return false
      return true
    },
  }
}
