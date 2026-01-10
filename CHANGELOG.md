# Changelog

All notable changes to the PRD and project requirements will be documented in this file.

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
