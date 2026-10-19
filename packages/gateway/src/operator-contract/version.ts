// Operator API contract version — build-time pinned, never negotiated over the wire.
//
// Changelog (latest first):
//   1.13.0 — a new `providerFailureReason` value, `provider-quota-exceeded` (additive): a provider that
//            refused the run for exhausted quota or billing now reports it instead of `unclassified`.
//            The enum is closed per version and may grow in later MINOR versions: consumers must treat a
//            reason they do not recognise as absent detail, never reject the row. The gateway and the
//            dashboard deploy as a pair (the dashboard's contract pin must be 1.13.0 and it must accept
//            the new value).
//   1.12.0 — three additive optional fields, plus two launch BEHAVIOR changes (a client that does not
//            update in lockstep sees them as new status codes):
//            (1) approval push notifications now carry `data.runId` and `route: '/operator#<runId>'`
//            (a deep link to the waiting run; falls back to `/` for a non-conforming ID);
//            (2) `RunSummary.prompt` — the launch prompt of runs started through `POST /operator/runs`
//            (untrusted text; bounded by `OPERATOR_LAUNCH_PROMPT_MAX_LENGTH`, 8,000 UTF-16 code units,
//            raise-only; absent on other surfaces);
//            (3) `providerFailureReason` on `RunSummary` and `OperatorRunStatus` — a closed enum
//            (`provider-auth-unavailable | model-not-available | provider-rejected-request |
//            unclassified`) on FAILED `session-error` runs.
//            Launch behavior changes (`POST /operator/runs`; both checks now run before repo access, so the
//            answer is the same for every repo):
//              - a prompt over 8,000 UTF-16 code units used to return 202 and now returns 400
//                `{error: 'bad request', reason: 'prompt-too-long'}`;
//              - an empty prompt on an unbound or denylisted repo used to return 404 and now returns
//                400 `{error: 'prompt is required'}`.
//   1.11.0 — `RunSummaryStatus` gains `waiting_for_approval` and `waiting_for_question` (additive):
//            `GET /operator/runs` summaries overlay the same registry-derived waiting status as the
//            SSE stream (approval before question, only on a `running` base). Question push
//            notifications now carry `data.runId` and `route: '/operator#<runId>'` (a deep link to the
//            asking run; falls back to `/` for a non-conforming ID).
//   1.10.0 — export `OPERATOR_PUSH_TRIGGER_KINDS` / `OperatorPushTriggerKind` (additive): the closed
//            set of push notification triggers, which is also the wire `data.type`.
//            Also adds the optional `OperatorSessionInfo.push: {status}` (`ready | degraded | unknown`) and
//            `OPERATOR_PUSH_HEALTH_STATUSES` (additive).
//   1.9.0 — pending-question surface: `question` SSE frame, PendingQuestionDTO, answer/skip request
//           types, and the `waiting_for_question` run status (additive). Every question and answer
//           string is untrusted plain text that consumers must render inertly.
//   1.8.0 — checked remote evidence on `checkoutProvenance` and optional `checkoutPreparation`.
//
// Increment policy:
//   MAJOR — breaking change to a frozen type (field removed, renamed, or type narrowed)
//   MINOR — additive change (new optional field, new type added to the surface)
//   PATCH — documentation or typo correction only; no structural change
//
// This constant is the single source of truth. Downstream consumers (e.g. the dashboard)
// pin this value; no second copy should exist. Human-bumped on breaking changes, like
// STORAGE_VERSION in packages/runtime/src/shared/constants.ts.
//
// Security constraint: the version is BUILD-TIME pinned and is never supplied or
// negotiated over the wire. Any endpoint reading a version header must reject
// unrecognized versions fail-closed.
export const OPERATOR_CONTRACT_VERSION = '1.13.0'
