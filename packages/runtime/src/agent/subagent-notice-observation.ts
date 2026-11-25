import {getObjectProperty, getStringProperty} from './payload-accessors.js'

/**
 * What a subagent notice (`<subagent>` on OpenCode 2.3.2, `<background-result kind="subagent">` on 2.4.1) looked like
 * when it arrived, reduced to values that are safe to log.
 *
 * This is DIAGNOSTIC ONLY. `subagent-notice.ts` never parses the model-visible text, and nothing here feeds it: the
 * observation records what the server said in two places that can disagree (the tag's `state` attribute and
 * `metadata.state`), so a run log can explain why a child was, or was not, counted settled. A 2.3.0 server reports a
 * child that finished a round but still has background work as `state="running"` in the tag with `metadata.state:
 * "completed"`, and the body then lists "Background work still running:".
 *
 * The body and the description are untrusted (a child's output reaches both) and are never carried: only a short
 * lowercase word for each state, and one boolean.
 */
export interface SubagentNoticeObservation {
  /** The `state` attribute of the opening subagent tag (either form), or `null` when the text does not open with one. */
  readonly tagState: string | null
  /** `metadata.state`, or `null` when absent. */
  readonly metadataState: string | null
  /** The text carries the marker the server writes when the child still has background work. */
  readonly backgroundWorkRunning: boolean
}

/** What a state that is not a short lowercase word is reported as. The value itself is never logged. */
const UNRECOGNIZED_STATE = 'other'

const STATE_WORD = /^[a-z][a-z-]{0,15}$/
/**
 * The opening tag, anchored at the start of the text and ending at `state`: the attributes after it (the description)
 * can hold child-controlled text, so they are never searched. Two forms, same attributes in the same order:
 * 2.3.2 `<subagent sessionID=… state=… description=…>` and 2.4.1 (upstream #64971)
 * `<background-result kind="subagent" sessionID=… state=… description=…>`. Other `<background-result>` kinds
 * (`shell`, `image`, `codemode`) are not subagent notices and do not match.
 */
const OPENING_TAG_STATE = /^\s*<(?:subagent|background-result\s+kind="subagent")\s+sessionID="[^"]*"\s+state="([^"]*)"/
const BACKGROUND_WORK_MARKER = 'Background work still running'

function loggableState(value: string | null): string | null {
  if (value === null) return null
  return STATE_WORD.test(value) ? value : UNRECOGNIZED_STATE
}

/** Observe a persisted synthetic message or a `session.synthetic` event's `data`. Total: never throws. */
export function observeSubagentNotice(value: unknown): SubagentNoticeObservation {
  const text = getStringProperty(value, 'text')
  const tagState = text === null ? null : (OPENING_TAG_STATE.exec(text)?.[1] ?? null)
  return {
    tagState: loggableState(tagState),
    metadataState: loggableState(getStringProperty(getObjectProperty(value, 'metadata'), 'state')),
    backgroundWorkRunning: text?.includes(BACKGROUND_WORK_MARKER) === true,
  }
}

/** Observe a `session.inbox.enqueued` item, through its `payload`. */
export function observeSubagentNoticeItem(item: unknown): SubagentNoticeObservation {
  return observeSubagentNotice(getObjectProperty(item, 'payload'))
}
