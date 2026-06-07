/**
 * Effect Schema definitions for the POST /v1/announce webhook payload.
 *
 * Validates and decodes the v1 event types. Unknown event types and
 * malformed shapes produce a Left with a content-free reason string —
 * payload values (context, rendered_text) are never echoed.
 */

import {Either, ParseResult, Schema} from 'effect'

// ISO-8601 pattern: YYYY-MM-DDTHH:MM:SS(.sss)?Z
// Strict enough to reject obvious non-ISO strings like "yesterday".
const ISO8601_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/

const FiredAt = Schema.String.pipe(
  Schema.pattern(ISO8601_PATTERN, {
    message: () => 'fired_at must be ISO-8601 (YYYY-MM-DDTHH:MM:SSZ)',
  }),
)

const InvitationAccepted = Schema.Struct({
  v: Schema.Literal(1),
  event_type: Schema.Literal('invitation_accepted'),
  fired_at: FiredAt,
  context: Schema.Struct({
    count: Schema.Number,
    repos: Schema.Array(
      Schema.Struct({
        owner: Schema.String,
        name: Schema.String,
      }),
    ),
  }),
  rendered_text: Schema.NullOr(Schema.String),
})

const SurveyCompleted = Schema.Struct({
  v: Schema.Literal(1),
  event_type: Schema.Literal('survey_completed'),
  fired_at: FiredAt,
  context: Schema.Struct({
    owner: Schema.String,
    repo: Schema.String,
    slug: Schema.String,
    wiki_pages_changed: Schema.Number,
  }),
  rendered_text: Schema.NullOr(Schema.String),
})

const DailyDigest = Schema.Struct({
  v: Schema.Literal(1),
  event_type: Schema.Literal('daily_digest'),
  fired_at: FiredAt,
  context: Schema.Struct({
    repos_tracked: Schema.Number,
    surveys_today: Schema.Number,
    report_url: Schema.String,
  }),
  rendered_text: Schema.NullOr(Schema.String),
})

const AnnouncePayloadSchema = Schema.Union(InvitationAccepted, SurveyCompleted, DailyDigest)

export type AnnouncePayload = Schema.Schema.Type<typeof AnnouncePayloadSchema>

const decodeUnknownEither = Schema.decodeUnknownEither(AnnouncePayloadSchema)

/**
 * Decode an unknown value into an `AnnouncePayload`.
 *
 * Returns `Right<AnnouncePayload>` on success.
 * Returns `Left<string>` on failure with a SHORT, content-free reason string.
 * Payload values (context, rendered_text) are NEVER included in the reason.
 */
export function decodeAnnounce(input: unknown): Either.Either<AnnouncePayload, string> {
  const result = decodeUnknownEither(input)
  if (Either.isRight(result)) {
    return Either.right(result.right)
  }

  const reason = classifyParseError(result.left)
  return Either.left(reason)
}

/**
 * Map a ParseError to a SHORT, structural reason string.
 * We only inspect schema-structural metadata (the failing key paths), never
 * input values. `ArrayFormatter` yields a typed list of issues whose `path` is
 * an array of property keys — no internal-shape casts required.
 *
 * If every issue points at 'event_type' → unknown_event_type.
 * Everything else → malformed_body.
 */
function classifyParseError(error: ParseResult.ParseError): string {
  const topLevelKeys = ParseResult.ArrayFormatter.formatErrorSync(error).map(issue =>
    issue.path.length > 0 ? String(issue.path[0]) : '',
  )

  if (topLevelKeys.length > 0 && topLevelKeys.every(key => key === 'event_type')) {
    return 'unknown_event_type'
  }

  return 'malformed_body'
}
