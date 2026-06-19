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

export type {DecisionInput, OperatorDecisionState, PermissionReply} from './approval.js'
export {toOperatorDecisionState} from './approval.js'
export type {OperatorIdentity} from './identity.js'
export {parseOperatorCsrfToken, parseOperatorError, parseOperatorOk, parseOperatorSessionInfo} from './parse.js'
export {assertRedactionApplied, AUTHORIZATION_OBLIGATION, REDACTION_OBLIGATION} from './redaction.js'
export type {RedactionContext} from './redaction.js'
export type {OperatorCsrfToken, OperatorError, OperatorOk, OperatorSessionInfo} from './responses.js'
export type {OperatorRunStatus, OperatorWebStatus, RunPhase, RunStatusRepoKey, Surface} from './run-status.js'
export {toOperatorRunStatus} from './run-status.js'
export {OPERATOR_CONTRACT_VERSION} from './version.js'
