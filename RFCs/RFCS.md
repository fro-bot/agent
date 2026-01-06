# Fro Bot Agent - RFC Index

**Generated:** 2026-01-04 **Total RFCs:** 12 **Implementation Strategy:** Sequential (RFC-001 → RFC-012)

---

## Overview

This document indexes all RFCs for the Fro Bot Agent project. RFCs are organized in **strict implementation order** - each RFC should be fully implemented before proceeding to the next.

The agent harness enables OpenCode with oMo "Sisyphus-style" workflow to act as an autonomous collaborator on GitHub Issues, Discussions, and Pull Requests with **persistent memory across runs**.

---

## RFC Summary Table

| RFC ID  | Title                                | Priority | Complexity | Phase | Status    |
| ------- | ------------------------------------ | -------- | ---------- | ----- | --------- |
| RFC-001 | Foundation & Core Types              | MUST     | Medium     | 1     | Completed |
| RFC-002 | Cache Infrastructure                 | MUST     | High       | 1     | Completed |
| RFC-003 | GitHub API Client Layer              | MUST     | Medium     | 1     | Completed |
| RFC-004 | Session Management Integration       | MUST     | Medium     | 2     | Completed |
| RFC-005 | GitHub Triggers & Event Handling     | MUST     | Medium     | 2     | Pending   |
| RFC-006 | Security & Permission Gating         | MUST     | Medium     | 2     | Pending   |
| RFC-007 | Observability & Run Summary          | MUST     | Medium     | 2     | Pending   |
| RFC-008 | GitHub Comment Interactions          | MUST     | Medium     | 3     | Pending   |
| RFC-009 | PR Review Features                   | MUST     | High       | 3     | Pending   |
| RFC-010 | Delegated Work (Push/PR)             | MUST     | High       | 3     | Pending   |
| RFC-011 | Setup Action & Environment Bootstrap | MUST     | High       | 1     | Completed |
| RFC-012 | Agent Execution & Main Action        | MUST     | High       | 1     | Completed |

---

## Dependency Graph

```
RFC-001 (Foundation)
    │
    ├── RFC-011 (Setup Action) ─────────┐
    │       │                           │
    │       └── [OpenCode, oMo, gh]     │
    │               │                   │
    │               └── RFC-012 (Agent Execution)
    │                       │
    │                       └── [Run OpenCode, reactions, context]
    │
    ├── RFC-002 (Cache) ──────────────┐ │
    │       │                         │ │
    │       └── RFC-004 (Sessions) ───┼─┼── RFC-007 (Observability)
    │                                 │ │
    ├── RFC-003 (GitHub Client) ──────┤ │
    │       │                         │ │
    │       ├── RFC-005 (Triggers) ───┤ │
    │       │       │                 │ │
    │       │       └── RFC-006 (Security)
    │       │               │
    │       │               ├── RFC-008 (Comments)
    │       │               │       │
    │       │               │       ├── RFC-009 (Reviews)
    │       │               │       │
    │       │               │       └── RFC-010 (Delegated Work)
    │       │               │
    │       └───────────────┘
    │
    └── [All RFCs depend on RFC-001]
```

---

## Implementation Phases

### Phase 1: Infrastructure (RFC-001 → RFC-003)

**Goal:** Establish foundational infrastructure

| RFC     | Description                              | Estimated Effort |
| ------- | ---------------------------------------- | ---------------- |
| RFC-001 | Types, utilities, logging, action inputs | 6-9 hours        |
| RFC-002 | Cache restore/save, auth.json exclusion  | 9-12 hours       |
| RFC-003 | Octokit client, context parsing          | 6-9 hours        |
| RFC-011 | Setup action, OpenCode/oMo install, gh   | 14-20 hours      |
| RFC-012 | Agent execution, reactions, context      | 16-22 hours      |

**Phase 1 Total:** ~51-72 hours

**Milestone:** Action can restore/save cache, parse GitHub context, and bootstrap OpenCode/oMo environment.

---

### Phase 2: Core Agent Logic (RFC-004 → RFC-007)

**Goal:** Session management, event handling, security, observability

| RFC     | Description                            | Estimated Effort |
| ------- | -------------------------------------- | ---------------- |
| RFC-004 | Session list/search/prune, writeback   | 9-12 hours       |
| RFC-005 | Event routing, trigger classification  | 6-9 hours        |
| RFC-006 | Permission gating, credential handling | 8-11 hours       |
| RFC-007 | Run summary, job summary, metrics      | 6-9 hours        |

**Phase 2 Total:** ~29-41 hours

**Milestone:** Agent can detect events, check permissions, search prior sessions, and report summaries.

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
| Phase 1   | 51-72 hours       |
| Phase 2   | 29-41 hours       |
| Phase 3   | 33-42 hours       |
| **Total** | **113-155 hours** |

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

| Feature                                | RFC              | Status    |
| -------------------------------------- | ---------------- | --------- |
| F1: GitHub Action Triggers             | RFC-005          | Pending   |
| F2: Issue Comment Interaction          | RFC-008          | Pending   |
| F3: Discussion Comment Interaction     | RFC-008          | Pending   |
| F4: PR Conversation Comments           | RFC-008          | Pending   |
| F5: PR Review Comments                 | RFC-009          | Pending   |
| F6: Delegated Work - Push Commits      | RFC-010          | Pending   |
| F7: Delegated Work - Open PRs          | RFC-010          | Pending   |
| F8: Comment Idempotency                | RFC-008          | Pending   |
| F9: Anti-Loop Protection               | RFC-005          | Pending   |
| F11: Session Search on Startup         | RFC-004          | Pending   |
| F17: OpenCode Storage Cache Restore    | RFC-002          | Pending   |
| F18: OpenCode Storage Cache Save       | RFC-002          | Pending   |
| F20: Run Summary in Comments           | RFC-007          | Pending   |
| F21: Close-the-Loop Session Writeback  | RFC-004          | Pending   |
| F22: Session Pruning                   | RFC-004          | Pending   |
| F25: auth.json Exclusion               | RFC-002, RFC-006 | Pending   |
| F26: Fork PR Permission Gating         | RFC-006          | Pending   |
| F27: Credential Strategy               | RFC-003, RFC-006 | Pending   |
| F28: Branch-Scoped Caching             | RFC-002          | Pending   |
| F30: GitHub Actions Job Summary        | RFC-007          | Pending   |
| F31: Structured Logging                | RFC-001, RFC-007 | Pending   |
| F32: Token Usage Reporting             | RFC-007          | Pending   |
| F33: Error Message Format              | RFC-008          | Pending   |
| F10: Setup Action Entrypoint           | RFC-011          | Pending   |
| F37: Action Inputs Configuration       | RFC-001, RFC-011 | Pending   |
| F41: Agent Prompt Context Injection    | RFC-012          | Completed |
| F42: gh CLI Operation Instructions     | RFC-012          | Completed |
| F43: Reactions & Labels Acknowledgment | RFC-012          | Completed |
| F44: Issue vs PR Context Detection     | RFC-012          | Completed |

### P1 Features (Should-Have) - Future RFCs

| Feature                     | Description                | Notes                |
| --------------------------- | -------------------------- | -------------------- |
| F23: Storage Versioning     | Version marker in storage  | Partially in RFC-002 |
| F24: Corruption Detection   | Detect & handle corruption | Partially in RFC-002 |
| F29: Concurrency Handling   | Last-write-wins + warning  | Future RFC           |
| F34: GitHub API Rate Limit  | Retry with backoff         | Future RFC           |
| F35: LLM API Error Handling | Retry + error comment      | Future RFC           |
| F38: Setup Entrypoint       | Separate action for setup  | Future RFC           |

### P2 Features (Nice-to-Have) - Future RFCs

| Feature                            | Description              | Notes      |
| ---------------------------------- | ------------------------ | ---------- |
| F19: S3 Write-Through Backup       | Cross-runner persistence | Future RFC |
| F39: Org-Level Memory Partitioning | Multi-repo scoping       | Future RFC |

### Discord Features - Future RFCs

| Feature                             | Description          | Notes      |
| ----------------------------------- | -------------------- | ---------- |
| F12: Discord Channel-Repo Mapping   | Channel = project    | Future RFC |
| F13: Discord Thread-Session Mapping | Thread = session     | Future RFC |
| F14: Discord Daemon Architecture    | Long-running bot     | Future RFC |
| F15: Discord-GitHub Shared Memory   | S3 sync              | Future RFC |
| F16: Discord Permission Model       | Role-based access    | Future RFC |
| F36: Discord API Error Handling     | Graceful degradation | Future RFC |

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

The following are explicitly out of scope for the initial 10 RFCs but documented for future development:

1. **Discord Agent** (F12-F16, F36) - Long-running daemon with channel-to-repo mapping
2. **S3 Integration** (F19) - Write-through backup for cross-runner persistence
3. **Advanced Reliability** (F29, F34, F35) - Concurrency handling, comprehensive retry logic
4. **Multi-Entrypoint** (F38) - Separate `setup` action for configuration
5. **Org-Level Partitioning** (F39) - Cross-repo memory sharing within organizations
