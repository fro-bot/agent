/**
 * Segment-boundary tracker for the reply stream.
 *
 * OpenCode streams an assistant's visible text as deltas of distinct text parts (one or more per assistant
 * message). The sinks are append-only and see only strings, so when one part ends and the next begins with no
 * separator, the output reads "...can do.The README..." — in the live deltas AND in the authoritative final answer,
 * because both are the same accumulated buffer. Segment identity exists only here, in `run-core`, so this is the one
 * place a boundary can be inserted for every consumer at once (Discord sink, web sink, final output).
 *
 * Rules:
 * - A boundary is a Markdown paragraph break: exactly one blank line (`\n\n`) between the visible text before and
 *   after. It tops up whatever newlines the output already ends with PLUS the newlines the new segment itself leads
 *   with: none → `\n\n`, one → `\n`, two or more → nothing (a single newline is completed to a blank line rather than
 *   skipped, because a lone newline does not separate Markdown paragraphs — the very bug being fixed).
 * - The separator goes BEFORE the segment's leading whitespace, never after it. Whitespace is semantic in Markdown
 *   (`"\n    code"` is an indented code block; `"\n\n    code"` too, but `"\n    \ncode"` is plain text), and the sink
 *   is append-only, so a separator can not be repaired in after indentation was already emitted. Hence the HOLD below.
 * - Never at the very start of output: nothing non-whitespace has been appended yet. Until then whitespace passes
 *   straight through, because no boundary is possible.
 * - A segment is REGISTERED, and its boundary decided, only on its first non-whitespace delta.
 * - HOLD: while the output has visible content and a segment is not yet registered, that segment's whitespace-only
 *   deltas are held per segment instead of emitted. On the segment's first visible delta ONE string is emitted:
 *   `separator + held + text`, where the separator is computed over `held + text` (its leading newlines). The result
 *   is byte-identical however the segment's leading whitespace is chunked, and the indentation stays attached to
 *   the text it indents. A segment that becomes visible later is still judged against what precedes it at that
 *   moment (not at the moment it was first mentioned).
 * - Held text belongs to its segment alone: another segment's continuation (or an anonymous delta) neither emits nor
 *   consumes it. `flush` releases whatever is still held, as-is and with no separator (a segment that never became
 *   visible has no boundary to open). The caller must flush at the end of the stream so no text is lost.
 * - Never inside a segment: a registered (already visible) segment never opens a boundary, and its whitespace passes
 *   straight through, so interleaved deltas of concurrently streaming parts are not split mid-part. A boundary is
 *   decided per segment at registration and consumed there — it is never parked globally.
 * - Deltas that carry no segment identity (`null`) never register, are never held and never separated: anonymous
 *   token deltas have no knowable boundary, and guessing one would split a part.
 * - Tool summaries (which carry their own newlines) are fed through `noteAppended`, so the trailing-newline count
 *   accounts for them and text after a summary is topped up rather than double-separated.
 *
 * The tracker returns the exact string to append; it owns no delivery evidence. The reply-delivery fence records
 * each part's own text (never the separator) as the delta is accepted — see `run-core.ts` for why that is safe with
 * hold-and-flush.
 */

export interface TextBoundaryTracker {
  /**
   * Accept a text delta of `segmentKey` and return the string to append to the sink NOW: possibly empty (a held
   * lead-in or an empty delta), possibly `separator + held + text`. The tracker has already accounted for the
   * returned string; the caller must append it verbatim and not report it again.
   */
  readonly append: (segmentKey: string | null, text: string) => string
  /** Release all held text, in the order its segments were first held. Returns `''` when nothing is held. */
  readonly flush: () => string
  /** Record text appended to the sink outside the tracker (tool summaries), so the newline count stays accurate. */
  readonly noteAppended: (text: string) => void
}

/** Newlines in the trailing whitespace run of `text`, or null when `text` is entirely whitespace. */
function trailingNewlines(text: string): number | null {
  let count = 0
  for (let index = text.length - 1; index >= 0; index -= 1) {
    const char = text.charAt(index)
    if (char === '\n') count += 1
    else if (char.trim() !== '') return count
  }
  return null
}

/** Newlines in the leading whitespace run of `text` (the text is known to hold a non-whitespace character). */
function leadingNewlines(text: string): number {
  let count = 0
  for (const char of text) {
    if (char === '\n') count += 1
    else if (char.trim() !== '') break
  }
  return count
}

export function createTextBoundaryTracker(): TextBoundaryTracker {
  // Segments that have emitted visible text. Registration happens on the first non-whitespace delta only.
  const visibleSegments = new Set<string>()
  // Whitespace-only lead-ins of segments that are not visible yet, per segment (Map keeps first-held order).
  const held = new Map<string, string>()
  let hasContent = false
  let newlinesAtEnd = 0

  function noteAppended(text: string): void {
    const trailing = trailingNewlines(text)
    if (trailing === null) {
      newlinesAtEnd += text.split('\n').length - 1
    } else {
      hasContent = true
      newlinesAtEnd = trailing
    }
  }

  function commit(text: string): string {
    noteAppended(text)
    return text
  }

  return {
    append: (segmentKey, text) => {
      if (segmentKey === null || visibleSegments.has(segmentKey) || text === '') return commit(text)
      const lead = held.get(segmentKey) ?? ''
      if (text.trim() === '') {
        // No boundary is possible before any visible output, so there is nothing to hold for.
        if (!hasContent) return commit(text)
        held.set(segmentKey, lead + text)
        return ''
      }
      held.delete(segmentKey)
      visibleSegments.add(segmentKey)
      const segmentText = lead + text
      // Only a segment that follows visible text needs a boundary; the first one never does.
      if (!hasContent) return commit(segmentText)
      const separator = '\n'.repeat(Math.max(0, 2 - newlinesAtEnd - leadingNewlines(segmentText)))
      return commit(separator + segmentText)
    },
    flush: () => {
      const text = [...held.values()].join('')
      held.clear()
      return commit(text)
    },
    noteAppended,
  }
}
