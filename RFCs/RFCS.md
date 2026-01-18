# Fro Bot Agent - RFC Index

**Generated:** 2026-01-17
**Total RFCs:** 19
**Implementation Strategy:** Sequential (RFC-001 → RFC-019)

---

## Overview

This document indexes all RFCs for the Fro Bot Agent project. RFCs are organized in **strict implementation order** - each RFC should be fully implemented before proceeding to the next.

The agent harness enables OpenCode with oMo Sisyphus agent workflow to act as an autonomous collaborator on GitHub Issues, Discussions, and Pull Requests with **persistent memory across runs**.

---

## RFC Summary Table

| RFC ID  | Title                                | Priority | Complexity | Phase | Status     |
| ------- | ------------------------------------ | -------- | ---------- | ----- | ---------- |
| RFC-001 | Foundation & Core Types              | MUST     | Medium     | 1     | Completed  |
| RFC-002 | Cache Infrastructure                 | MUST     | High       | 1     | Completed  |
| RFC-003 | GitHub API Client Layer              | MUST     | Medium     | 1     | Completed  |
| RFC-004 | Session Management Integration       | MUST     | Medium     | 2     | Completed  |
| RFC-005 | GitHub Triggers & Event Handling     | MUST     | Medium     | 2     | Completed  |
| RFC-006 | Security & Permission Gating         | MUST     | Medium     | 2     | Completed  |
| RFC-007 | Observability & Run Summary          | MUST     | Medium     | 2     | Completed  |
| RFC-008 | GitHub Comment Interactions          | MUST     | Medium     | 3     | Completed  |
| RFC-009 | PR Review Features                   | MUST     | High       | 3     | Completed  |
| RFC-010 | Delegated Work (Push/PR)             | MUST     | High       | 3     | Completed  |
| RFC-011 | Setup Action & Environment Bootstrap | MUST     | High       | 1     | Completed  |
| RFC-012 | Agent Execution & Main Action        | MUST     | High       | 1     | Superseded |
| RFC-013 | SDK Execution Mode                   | MUST     | High       | 1     | Completed  |
| RFC-014 | File Attachment Processing           | MUST     | Medium     | 2     | Completed  |
| RFC-015 | GraphQL Context Hydration            | MUST     | High       | 2     | Pending    |
| RFC-016 | Additional Triggers & Directives     | MUST     | Medium     | 2     | Completed  |
| RFC-017 | Post-Action Cache Hook               | MUST     | Medium     | 2     | Completed  |
| RFC-018 | Agent-Invokable Delegated Work Tools | MUST     | Medium     | 3     | Pending    |
| RFC-019 | S3 Storage Backend                   | MUST     | High       | 4     | Pending    |

---

## Dependency Graph

```
RFC-001 (Foundation)
    │
    ├── RFC-011 (Setup Action) ─────────┐
    │       │                           │
    │       └── [OpenCode, oMo, gh]     │
    │               │                   │
    │               └── RFC-012 (Agent Execution) ──[SUPERSEDED: execution layer]
    │                       │
    │                       └── RFC-013 (SDK Execution Mode)
    │                               │
    │                               └── [@opencode-ai/sdk, sessions, events]
    │
    ├── RFC-002 (Cache) ──────────────┐ │
    │       │                         │ │
    │       ├── RFC-004 (Sessions) ───┼─┼── RFC-007 (Observability)
    │       │                         │ │
    │       └── RFC-017 (Post-Action Cache Hook) ─── [Reliable cache save]
    │               │
    │               └── RFC-019 (S3 Storage) ─── [Cross-runner persistence, Discord support]
    │                                 │ │
    ├── RFC-003 (GitHub Client) ──────┤ │
    │       │                         │ │
    │       ├── RFC-005 (Triggers) ───┤ │
    │       │       │                 │ │
    │       │       ├── RFC-016 (Additional Triggers) ─── [issues, PR, schedule]
    │       │       │                 │ │
    │       │       └── RFC-006 (Security)
    │       │               │
    │       │               ├── RFC-008 (Comments)
    │       │               │       │
    │       │               │       ├── RFC-009 (Reviews)
    │       │               │       │
    │       │               │       ├── RFC-010 (Delegated Work)
    │       │               │       │
    │       │               │       └── RFC-018 (Agent-Invokable Tools) ◄── exposes RFC-010 as OpenCode plugin
    │       │               │
    │       ├── RFC-014 (File Attachments) ─────────────────────┐
    │       │       │                                           │
    │       │       └── [Detection, download, MIME, SDK inject] │
    │       │                                                   │
    │       └── RFC-015 (GraphQL Context) ──────────────────────┤
    │               │                                           │
    │               └── [Issue/PR hydration, budgeting, fallback]
    │       │               │
    │       └───────────────┘
    │
    └── [All RFCs depend on RFC-001]
```

---

## Implementation Phases

### Phase 1: Infrastructure (RFC-001 → RFC-003)

**Goal:** Establish foundational infrastructure

| RFC     | Description                              | Estimated Effort                          |
| ------- | ---------------------------------------- | ----------------------------------------- |
| RFC-001 | Types, utilities, logging, action inputs | 6-9 hours                                 |
| RFC-002 | Cache restore/save, auth.json exclusion  | 9-12 hours                                |
| RFC-003 | Octokit client, context parsing          | 6-9 hours                                 |
| RFC-011 | Setup action, OpenCode/oMo install, gh   | 14-20 hours                               |
| RFC-012 | Agent execution, reactions, context      | 16-22 hours (SUPERSEDED: execution layer) |
| RFC-013 | SDK Execution Mode                       | 18-26 hours                               |

**Phase 1 Total:** ~69-92 hours

**Milestone:** Action can restore/save cache, parse GitHub context, bootstrap OpenCode/oMo environment, and execute agent via `@opencode-ai/sdk` with session tracking and event subscription.

---

### Phase 2: Core Agent Logic (RFC-004 → RFC-007, RFC-014, RFC-015)

**Goal:** Session management, event handling, security, observability, context hydration

| RFC     | Description                                        | Estimated Effort |
| ------- | -------------------------------------------------- | ---------------- |
| RFC-004 | Session list/search/prune, writeback               | 9-12 hours       |
| RFC-005 | Event routing, trigger classification, mock events | 6-9 hours        |
| RFC-006 | Permission gating, credential handling             | 8-11 hours       |
| RFC-007 | Run summary, job summary, metrics                  | 6-9 hours        |
| RFC-014 | File attachment processing                         | 9-12 hours       |
| RFC-015 | GraphQL context hydration                          | 14-20 hours      |
| RFC-016 | Additional triggers, directives                    | 12-18 hours      |
| RFC-017 | Post-action cache hook                             | 6-9 hours        |

**Phase 2 Total:** ~70-100 hours

**Milestone:** Agent can detect events, check permissions, search prior sessions, report summaries, process file attachments, and hydrate full issue/PR context via GraphQL.

---

### Phase 3: GitHub Interactions (RFC-008 → RFC-010)

**Goal:** Full GitHub interaction capability

| RFC     | Description                                          | Estimated Effort |
| ------- | ---------------------------------------------------- | ---------------- |
| RFC-008 | Read threads, post/update comments, error formatting | 9-12 hours       |
| RFC-009 | PR diff parsing, review comments, submit reviews     | 12-15 hours      |
| RFC-010 | Create branches, commit files, open PRs              | 12-15 hours      |

**Phase 3 Total:** ~33-42 hours

**Milestone:** Agent can comment on issues/PRs, post review comments, and create PRs with code changes.

---

## Total Estimated Effort

| Phase     | Effort Range      |
| --------- | ----------------- |
| Phase 1   | 69-92 hours       |
| Phase 2   | 70-100 hours      |
| Phase 3   | 33-42 hours       |
| **Total** | **172-234 hours** |

---

## Implementation Workflow

### For Each RFC:

1. **Use the `/prd/implement` command:**

   ```
   /prd/implement RFCs/RFC-001-Foundation-Core-Types.md
   ```

2. **The implementation command will:**
   - Validate prerequisites (check previous RFCs are completed)
   - Support resuming partial implementations
   - Follow TDD: write tests first, then implementation
   - Run project-adaptive validation (tests, build, lint)
   - Update this document's Status column to "Completed"

3. **Implement RFCs strictly in numerical order** (001 → 002 → ... → 012)

---

## Feature Coverage

### P0 Features (Must-Have)

| Feature                                    | RFC              | Status    |
| ------------------------------------------ | ---------------- | --------- |
| F1: GitHub Action Triggers                 | RFC-005, RFC-016 | Completed |
| F2: Issue Comment Interaction              | RFC-008          | Pending   |
| F3: Discussion Comment Interaction         | RFC-008          | Pending   |
| F4: PR Conversation Comments               | RFC-008          | Pending   |
| F5: PR Review Comments                     | RFC-009          | Completed |
| F6: Delegated Work - Push Commits          | RFC-010          | Completed |
| F7: Delegated Work - Open PRs              | RFC-010          | Completed |
| F8: Comment Idempotency                    | RFC-008          | Pending   |
| F9: Anti-Loop Protection                   | RFC-005          | Completed |
| F10: Reactions & Labels Acknowledgment     | RFC-013          | Completed |
| F11: Issue vs PR Context Detection         | RFC-013          | Completed |
| F17: OpenCode Storage Cache Restore        | RFC-002          | Pending   |
| F18: OpenCode Storage Cache Save           | RFC-002          | Pending   |
| F19: Session Search on Startup             | RFC-004          | Pending   |
| F21: Close-the-Loop Session Writeback      | RFC-004          | Pending   |
| F22: Session Pruning                       | RFC-004          | Pending   |
| F25: Setup Action Entrypoint               | RFC-011          | Pending   |
| F26: OpenCode CLI Installation             | RFC-011          | Pending   |
| F27: oMo Plugin Installation               | RFC-011          | Pending   |
| F28: GitHub CLI Authentication             | RFC-011          | Pending   |
| F29: Git Identity Configuration            | RFC-011          | Pending   |
| F30: auth.json Population                  | RFC-011          | Pending   |
| F31: Cache Restoration in Setup            | RFC-011          | Pending   |
| F32: SDK-Based Agent Execution             | RFC-013          | Completed |
| F33: Event Subscription and Processing     | RFC-013          | Completed |
| F34: Completion Detection                  | RFC-013          | Completed |
| F35: Timeout and Cancellation              | RFC-013          | Completed |
| F36: SDK Cleanup                           | RFC-013          | Completed |
| F37: Model and Agent Configuration         | RFC-013          | Completed |
| F38: Mock Event Support                    | RFC-005          | Completed |
| F39: File Attachment Detection             | RFC-014          | Completed |
| F40: File Attachment Download              | RFC-014          | Completed |
| F41: File Attachment Prompt Injection      | RFC-014          | Completed |
| F42: GraphQL Issue Context Hydration       | RFC-015          | Pending   |
| F43: GraphQL PR Context Hydration          | RFC-015          | Pending   |
| F44: Context Budgeting                     | RFC-015          | Pending   |
| F45: Agent Prompt Construction             | RFC-013          | Completed |
| F46: auth.json Exclusion                   | RFC-002, RFC-006 | Pending   |
| F47: Fork PR Permission Gating             | RFC-006          | Pending   |
| F48: Credential Strategy                   | RFC-003, RFC-006 | Pending   |
| F49: Branch-Scoped Caching                 | RFC-002          | Pending   |
| F51: Run Summary in Comments               | RFC-007          | Completed |
| F52: GitHub Actions Job Summary            | RFC-007          | Completed |
| F53: Structured Logging                    | RFC-001, RFC-007 | Completed |
| F54: Token Usage Reporting                 | RFC-007          | Completed |
| F55: Error Message Format                  | RFC-008          | Pending   |
| F56: GitHub API Rate Limit Handling        | RFC-007          | Pending   |
| F57: LLM API Error Handling                | RFC-007          | Pending   |
| F59: Action Inputs Configuration           | RFC-001, RFC-011 | Pending   |
| F69: Trigger-Specific Prompt Directives    | RFC-016          | Completed |
| F70: Issues Event Trigger                  | RFC-016          | Completed |
| F71: Pull Request Event Trigger            | RFC-016          | Completed |
| F72: Schedule Event Trigger                | RFC-016          | Completed |
| F73: Pull Request Review Comment           | RFC-016          | Completed |
| F74: Post-Action Cache Hook                | RFC-017          | Completed |
| F75: Prompt Input Required Validation      | RFC-016          | Completed |
| F76: Draft PR Skip                         | RFC-016          | Completed |
| F77: Agent Tool: create_branch             | RFC-018          | Pending   |
| F78: Agent Tool: commit_files              | RFC-018          | Pending   |
| F79: Agent Tool: create_pull_request       | RFC-018          | Pending   |
| F80: Agent Tool: update_pull_request       | RFC-018          | Pending   |
| F81: Delegated Work Plugin Distribution    | RFC-018          | Pending   |
| F82: Delegated Work Tool Context Injection | RFC-018          | Pending   |

### P1 Features (Should-Have) - Future RFCs

| Feature                                | Description                      | Notes                            |
| -------------------------------------- | -------------------------------- | -------------------------------- |
| F20: S3 Write-Through Backup           | Cross-runner persistence         | **RFC-019**                      |
| F23: Storage Versioning                | Version marker in storage        | **Amended in RFC-002**           |
| F24: Corruption Detection              | Detect & handle corruption       | **Amended in RFC-002**           |
| F50: Concurrency Handling              | Last-write-wins + warning        | **Amended in RFC-002**           |
| ~~F63: Pull Request Review Comment~~   | ~~Handle inline review comment~~ | **ELEVATED to P0 as F73 (v1.2)** |
| F64: Session Sharing                   | Public session share links       | Future RFC                       |
| F65: Automatic Branch Management       | Branch creation workflows        | Future RFC                       |
| F66: Event Streaming and Progress Logs | Real-time agent progress logging | Future RFC                       |
| F83: Telemetry Policy Enforcement      | Privacy-first telemetry          | **Amended in RFC-007**           |

### P2 Features (Nice-to-Have) - Future RFCs

| Feature                            | Description              | Notes      |
| ---------------------------------- | ------------------------ | ---------- |
| F67: Cross-Runner Portability      | S3 backup cross-platform | Future RFC |
| F68: Org-Level Memory Partitioning | Multi-repo scoping       | Future RFC |

### Discord Features - Future RFCs

| Feature                             | Description          | Notes      |
| ----------------------------------- | -------------------- | ---------- |
| F12: Discord Channel-Repo Mapping   | Channel = project    | Future RFC |
| F13: Discord Thread-Session Mapping | Thread = session     | Future RFC |
| F14: Discord Daemon Architecture    | Long-running bot     | Future RFC |
| F15: Discord-GitHub Shared Memory   | S3 sync              | Future RFC |
| F16: Discord Permission Model       | Role-based access    | Future RFC |
| F58: Discord API Error Handling     | Graceful degradation | Future RFC |

---

## Success Criteria

After all RFCs are implemented:

- [ ] Agent runs on `issue_comment` events
- [ ] Agent runs on `workflow_dispatch` events
- [ ] Cache restore/save works correctly
- [ ] `auth.json` is never persisted to cache
- [ ] Agent uses `session_search` on startup
- [ ] Every comment includes collapsed run summary
- [ ] Fork PRs handled securely (OWNER/MEMBER/COLLABORATOR only)
- [ ] Session pruning runs at end of each run
- [ ] Agent can post review comments on PRs
- [ ] Agent can push commits and open PRs

---

## Notes

1. **TDD Required**: Each RFC implementation should follow RED-GREEN-REFACTOR
2. **Build Verification**: Run `pnpm build && pnpm check-types && pnpm lint && pnpm test` after each RFC
3. **dist/ Sync**: The `dist/` folder must be rebuilt and committed after implementation changes
4. **No Parallel Implementation**: RFCs must be implemented sequentially in numerical order

---

## Future Work (Post-MVP)

The following are explicitly out of scope for the current RFCs but documented for future development:

1. **Discord Agent** (F12-F16, F58) - Long-running daemon with channel-to-repo mapping (RFCs 020+)
2. **Session Sharing** (F64) - Public session share links
3. **Automatic Branch Management** (F65) - Branch creation workflows
4. **Event Streaming** (F66) - Real-time agent progress logging
5. **Org-Level Partitioning** (F68) - Cross-repo memory sharing within organizations
