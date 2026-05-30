/**
 * Embed rendering: maps AnnouncePayload event_type → PresenceEmbed.
 *
 * Accent color registry covers v1 event types plus forward-looking stubs for
 * fast-follower types that are not yet emitted by the gateway agent.
 */

import type {PresenceEmbed} from '../discord/presence.js'
import type {AnnouncePayload} from './announce-schema.js'

// ---------------------------------------------------------------------------
// Accent color registry
// ---------------------------------------------------------------------------

/** Discord blurple — invitation_accepted */
const COLOR_BLUE = 0x5865f2
/** Discord green — survey_completed */
const COLOR_GREEN = 0x57f287
// v2 stubs (not yet emitted — colors reserved for when templates are added):
// reconcile_notable  → 0x9b59b6 (purple)
// wiki_lint_findings → 0xfee75c (yellow)

const ACCENT: Record<AnnouncePayload['event_type'], number> = {
  invitation_accepted: COLOR_BLUE,
  survey_completed: COLOR_GREEN,
}

// ---------------------------------------------------------------------------
// Per-event template functions
// ---------------------------------------------------------------------------

type InvitationAcceptedContext = Extract<AnnouncePayload, {event_type: 'invitation_accepted'}>['context']
type SurveyCompletedContext = Extract<AnnouncePayload, {event_type: 'survey_completed'}>['context']

function renderInvitationAccepted(context: InvitationAcceptedContext): string {
  const {count, repos} = context
  if (count === 0 || repos.length === 0) {
    return 'Accepted 0 collaboration invitations.'
  }
  const repoList = repos.map(r => `${r.owner}/${r.name}`).join(', ')
  const noun = count === 1 ? 'invitation' : 'invitations'
  return `Just accepted ${count} collaboration ${noun}: ${repoList}`
}

function renderSurveyCompleted(context: SurveyCompletedContext): string {
  const {owner, repo} = context
  const pagesChanged = context.wiki_pages_changed
  const noun = pagesChanged === 1 ? 'entry' : 'entries'
  return `Surveyed ${owner}/${repo}, added ${pagesChanged} wiki ${noun}`
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Discord embed description hard limit (characters). */
const EMBED_DESCRIPTION_MAX_CHARS = 4096

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render an AnnouncePayload into a PresenceEmbed.
 *
 * If `payload.rendered_text` is non-null AND non-empty after trimming, it is
 * used verbatim as the embed description (forward-compat: v1 emits null;
 * callers may supply overrides). Empty or whitespace-only rendered_text falls
 * through to the per-event template so Discord never receives an empty embed
 * description (which it rejects, causing a 500 cascade).
 * The accent color is always set by event_type regardless of rendered_text.
 *
 * Description is truncated to EMBED_DESCRIPTION_MAX_CHARS (4096) with a '…'
 * suffix so an oversized payload never causes channel.send to throw.
 */
export function renderEmbed(payload: AnnouncePayload): PresenceEmbed {
  const color = ACCENT[payload.event_type]

  let description: string
  if (payload.rendered_text !== null && payload.rendered_text.trim().length > 0) {
    description = payload.rendered_text
  } else if (payload.event_type === 'invitation_accepted') {
    description = renderInvitationAccepted(payload.context)
  } else {
    description = renderSurveyCompleted(payload.context)
  }

  if (description.length > EMBED_DESCRIPTION_MAX_CHARS) {
    description = `${description.slice(0, EMBED_DESCRIPTION_MAX_CHARS - 1)}…`
  }

  return {description, color}
}
