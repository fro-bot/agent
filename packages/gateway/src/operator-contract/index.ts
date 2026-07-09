/**
 * Single public import authority for the operator API contract.
 *
 * The gateway owns this contract. Downstream consumers (e.g. the dashboard) pin
 * OPERATOR_CONTRACT_VERSION and import all operator-surface types from this barrel.
 *
 * Design constraints:
 * - Effect Schema is never part of the exported surface (plain TS + Result only).
 * - All exported types are transport-stable; internal coordination fields are excluded
 *   by construction.
 * - The contract version is build-time pinned and never negotiated over the wire.
 *
 * Later units will grow this barrel as identity, run-status, approval, response, and
 * redaction modules land.
 */

export type {PendingApprovalDTO} from '../approvals/registry.js'
export type {ApprovalFrameData, ApprovalRequestDetail} from './approval-frame.js'
export type {DecisionInput, OperatorDecisionState, PermissionReply} from './approval.js'
export {toOperatorDecisionState} from './approval.js'
export type {OperatorIdentity} from './identity.js'
export type {OperatorOutputFrame} from './output.js'
export {
  parseOperatorCancelResponse,
  parseOperatorCsrfToken,
  parseOperatorError,
  parseOperatorOk,
  parseOperatorPushSubscribeRequest,
  parseOperatorPushVapidKeyResponse,
  parseOperatorSessionInfo,
} from './parse.js'
export {assertRedactionApplied, AUTHORIZATION_OBLIGATION, REDACTION_OBLIGATION} from './redaction.js'
export type {RedactionContext} from './redaction.js'
export type {RepoSummary} from './repo-summary.js'
export {toRepoSummary} from './repo-summary.js'
export type {
  OperatorCancelResponse,
  OperatorCsrfToken,
  OperatorError,
  OperatorOk,
  OperatorPushInactiveReason,
  OperatorPushSubscribeRequest,
  OperatorPushSubscriptionListResponse,
  OperatorPushSubscriptionMetadata,
  OperatorPushUnsubscribeRequest,
  OperatorPushVapidKeyResponse,
  OperatorSessionInfo,
} from './responses.js'
export type {
  OperatorFailureKind,
  OperatorRunStatus,
  OperatorWebStatus,
  RunPhase,
  RunStatusRepoKey,
  Surface,
} from './run-status.js'
export {toOperatorFailureKind, toOperatorRunStatus} from './run-status.js'
export type {RunSummary, RunSummaryStatus} from './run-summary.js'
export {toRunSummary} from './run-summary.js'
export {OPERATOR_CONTRACT_VERSION} from './version.js'
