// Operator API contract version — build-time pinned, never negotiated over the wire.
//
// Changelog (latest first):
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
export const OPERATOR_CONTRACT_VERSION = '1.9.0'
