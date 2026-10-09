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
 *   after. It tops up whatever newlines the output already ends with: none → `\n\n`, one → `\n`, two or more → nothing
 *   (a single trailing `\n` is completed to a blank line rather than skipped, because a lone newline does not
 *   separate Markdown paragraphs — the very bug being fixed).
 * - Never at the very start of output: nothing non-whitespace has been appended yet.
 * - Only between DIFFERENT segments, decided on the first non-whitespace text of the new segment, so a whitespace-only
 *   lead-in neither triggers a boundary nor gets doubled up with it.
 * - Never inside a segment: a segment already seen never opens a new boundary, so interleaved deltas of concurrently
 *   streaming parts are not split mid-part.
 * - Deltas that carry no segment identity (`null`) are never separated: anonymous token deltas have no knowable
 *   boundary, and guessing one would split a part.
 * - Tool summaries (which carry their own newlines) are fed through `noteAppended`, so the trailing-newline count
 *   accounts for them and text after a summary is topped up rather than double-separated.
 *
 * The tracker only decides the separator string. It owns no part text: the reply-delivery fence records each part's
 * own text, never the separator.
 */

export interface TextBoundaryTracker {
  /**
   * The separator to append BEFORE `text`, given the segment it belongs to. Returns `''` when none is due. The
   * caller must then append the separator (if any) and `text`, and report both through `noteAppended`.
   */
  readonly separatorBefore: (segmentKey: string | null, text: string) => string
  /** Record anything appended to the sink, so the trailing-newline count and content flag stay accurate. */
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

export function createTextBoundaryTracker(): TextBoundaryTracker {
  const seenSegments = new Set<string>()
  let hasContent = false
  let newlinesAtEnd = 0
  let boundaryPending = false

  return {
    separatorBefore: (segmentKey, text) => {
      if (segmentKey !== null && !seenSegments.has(segmentKey)) {
        seenSegments.add(segmentKey)
        // Only a segment that follows visible text needs a boundary; the first one never does.
        if (hasContent) boundaryPending = true
      }
      if (!boundaryPending || text.trim() === '') return ''
      boundaryPending = false
      return '\n'.repeat(Math.max(0, 2 - newlinesAtEnd))
    },
    noteAppended: text => {
      const trailing = trailingNewlines(text)
      if (trailing === null) {
        newlinesAtEnd += text.split('\n').length - 1
      } else {
        hasContent = true
        newlinesAtEnd = trailing
      }
    },
  }
}
