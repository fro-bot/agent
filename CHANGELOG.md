# Changelog

All notable changes to the PRD and project requirements will be documented in this file.

## [1.2] - 2026-01-14

### Added

#### P0 (must-have) - Additional Triggers & Directives

- **L. Trigger-Specific Prompt Directives**: Context-aware default behaviors per trigger
  - `issues` (opened): Automated triage - summarize, reproduce, propose next steps
  - `issues` (edited with @mention): Respond to specific mention
  - `pull_request` (opened/synchronize/reopened): Default review behavior
  - `pull_request_review_comment` (created): Respond with file/line/diff context
  - `schedule`: Requires `prompt` input (hard fail if empty)
  - `workflow_dispatch`: Requires `prompt` input (hard fail if empty)
  - `getTriggerDirective()` function for thin directive layer

- **M. Post-Action Cache Hook**: Reliable cache saving via `runs.post`
  - New `src/post.ts` entry point bundled to `dist/post.js`
  - Runs even on main action timeout/cancellation
  - Best-effort, never fails the job
  - Independent of setup consolidation

#### New Trigger Events

- **`issues` event**: Support `opened` and `edited` (with @mention) actions
- **`pull_request` event**: Support `opened`, `synchronize`, `reopened` actions
- **`pull_request_review_comment` event**: Elevated from P1 to P0, support `created` action
- **`schedule` event**: Cron-based triggers with required prompt input

### Changed

- **Trigger documentation**: Comprehensive table in section A.1 with actions, prompt requirements, and scope
- **Skip conditions**: Added per-trigger guards (draft PR skip, mention requirement, prompt validation)
- **P1 section**: Added "Setup action consolidation (deferred from v1.2)" as future work item

### Deferred

- **Setup action consolidation**: Architectural change requires separate RFC, user research, and migration plan
- Documented in P1 for future consideration

### Risks Added

- Noisy automated triggers (mitigated by action constraints and @mention requirements)
- Post-action hook reliability (mitigated by best-effort design and S3 backup)

## [1.1] - 2026-01-10

### Added

#### P0 (must-have) - SDK Execution & Enhanced Context

- **F. OpenCode SDK Execution**: Replace CLI execution with `@opencode-ai/sdk` client+server model
  - Automatic server lifecycle via `createOpencode()`
  - Session management via `client.session.create/promptAsync`
  - Event subscription via `client.event.subscribe()`
  - Completion detection with polling
  - Timeout/cancellation via AbortController

- **G. Mock Event Support**: Local development and testing capabilities
  - `MOCK_EVENT` and `MOCK_TOKEN` environment variables
  - Schema validation for mock payloads
  - Security guards for production environments

- **H. File Attachment Processing**: Support for images and files in comments
  - Parse GitHub user-attachment URLs from comment body
  - Download and pass as `type: "file"` parts to SDK
  - Limits: 5 files max, 5MB each, 15MB total

- **I. Model and Agent Configuration**: Explicit model/agent selection
  - Required `model` input (format: `provider/model`)
  - Optional `agent` input with validation
  - Included in run summary for auditability

- **J. Enhanced GitHub Context Hydration**: Full issue/PR context via GraphQL
  - Issue: title, body, comments, labels, assignees
  - PR: commits, files, reviews with inline comments, fork detection
  - Context budgeting (50 comments, 100 files, 10KB truncation)
  - REST API fallback on GraphQL failure

- **K. Agent Prompt Construction**: Multi-section prompt structure
  - Mode instructions, identity, context, user request
  - Mandatory reading instructions for issues and PRs
  - Heredoc guidance for GitHub comment formatting
  - Session tool instructions

#### P1 (should-have) - Enhanced Features

- **Pull request review comment support**: Handle `pull_request_review_comment` event
- **Session sharing**: Public session links with social card images
- **Automatic branch management**: Issue→PR, local PR push, fork PR handling
- **Event streaming**: Color-coded tool call logging

### Changed

- **Execution model**: CLI (`opencode run`) replaced by SDK (`@opencode-ai/sdk`)
- **Timeline**: Added Phase 1 (SDK Foundation) and Phase 2 (Enhanced Context)
- **RFC impact**: RFC-012 superseded; RFC-013 (SDK Execution Mode) to be created

### Risks Added

- `@opencode-ai/sdk` stability (mitigated by version pinning)
- GraphQL rate limits (mitigated by pagination and REST fallback)
- File attachment security (mitigated by URL allowlist and size limits)

## [1.0] - 2026-01-02

### Added

- Initial PRD with core requirements
- GitHub agent interactions (triggers, surfaces, idempotency, security)
- Discord agent interactions (channel=repo, thread=session mapping)
- Shared memory and session management (RFC-004 utilities)
- Setup action specifications (RFC-011)
- Agent execution specifications (RFC-012)
- Cache infrastructure and security requirements
