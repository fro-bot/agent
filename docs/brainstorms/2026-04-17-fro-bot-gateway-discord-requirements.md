---
date: 2026-04-17
topic: fro-bot-gateway-discord
status: ready-for-planning
reviewed: 2026-04-17
review_coverage: full (7 reviewers)
decisions_anchored: 10
related:
  - docs/ideation/2026-04-15-autonomous-agent-platform-ideation.md
  - docs/plans/2026-04-15-001-feat-durable-object-storage-plan.md
  - docs/solutions/workflow-issues/delivery-mode-contract-for-manual-triggers-2026-04-17.md
references:
  - https://github.com/remorses/kimaki
  - https://hermes-agent.nousresearch.com/docs/user-guide/messaging/discord
  - https://github.com/sachitv/opencode-omo-sandbox-docker
---

# Fro Bot Gateway — Discord-First Action-Taking Agent

## Problem Statement

Fro Bot today is a stateless GitHub Action: one webhook event in, one comment out, runtime dies. That model has clean operational properties — no infra to run, GitHub Actions handles uptime — but it forecloses an entire category of interaction. The agent cannot:

- Be reached from where Marcus actually sits (Discord), only where webhooks fire (GitHub events)
- Hold a real-time conversation across multiple turns inside a session that already understands the project
- Take action on a repo without first being triggered by a GitHub event
- Respond to ad-hoc questions ("explain why this PR fails CI", "summarize what changed in `src/foo` this week", "review my local branch") without going through the workflow_dispatch ceremony

Idea #1 from the autonomous-agent-platform ideation framed three goals — Discord, persistent runtime, autonomous loops — as one architecture. This document narrows that to the v1 path the user has chosen: **a Discord-first action-taking gateway that talks directly to local repo checkouts and dispatches to the existing GitHub Action when cloud execution is the right fit.**

The gateway does not replace the GitHub Action. The Action keeps handling webhook-triggered PR reviews, cron-based DMR/wiki runs, and any scenario where ephemeral cloud compute is the natural fit. The gateway is the second surface for everything else.

### Why Discord (and not a CLI, IDE plugin, or web UI)

The deeper need is "reach the agent from anywhere I happen to be." Three alternatives were considered before committing to Discord:

- **CLI** — fastest to ship, no infra, no new surface, sessions already persistent in S3. Fails on the core need: a CLI is tied to a terminal, which is tied to a device. Can't start a task on laptop, check results from a phone at dinner, resume on desktop.
- **IDE plugin (Cursor / Continue / Copilot extension)** — rich editor context (cursor position, selected text, inline diffs). Fails for the same reason: tied to one editor open on one device. Also couples to a specific IDE's plugin surface, which limits portability.
- **Web UI** — device-agnostic like Discord, could satisfy the multi-device need. But requires building from scratch: auth, session UX, push notifications, mobile client, approval flows, state sync. Net greenfield work.

**Discord wins on one specific capability: multi-device presence.** Desktop, laptop, mobile, browser — same conversation, same session, approval buttons that work on phone, notifications that actually reach you when you're not at a terminal. Discord is a ready-made multi-device client already installed on every device Marcus uses. The architecture cost (daemon, sandbox, Docker Compose) buys a surface that would otherwise take months of web-UI work to replicate.

This commits Fro Bot to an **agent platform with multiple frontends** trajectory, not "best-in-class GitHub Action with a Discord sidecar." The Action remains a frontend; Discord becomes another frontend; both consume the same runtime. Future surfaces (web UI, Slack, CLI if the multi-device need ever softens) plug into the same runtime layer.

## Goals

The gateway delivers a meaningful agent experience in Discord while preserving the architectural investments already made in the codebase. Each requirement below is intentionally framed at the user-behavior level; implementation choices belong in planning.

**R1. Action-taking from Discord.** A Discord user with appropriate permissions can ask the agent to do real work — read code, edit files, create branches, open PRs, run tests — and see the result in the Discord thread.

**R2. Channel ↔ repo mapping.** Each Discord channel is bound to one or more repo paths the gateway can operate on. The user adds a repo to the gateway (mechanism specified in S8: `/fro-bot add-project`) and the gateway either creates a Discord channel or binds to an existing one. Threads inside the channel are individual sessions scoped to that repo.

**R3. Session context shared across surfaces; resume is within-surface only; session content is untrusted input.** Both surfaces write sessions to the same S3 bucket with per-surface namespacing (`{tenant}/{surface}/{logical-key}`). Session **content is readable across surfaces** — Discord can search and reference Action sessions as context in a prompt (e.g., 'summarize what the agent found when it reviewed PR #42'), and vice versa. Session **resume is within-surface only** — a Discord thread resumes Discord sessions; an Action run resumes Action sessions. Cross-surface resume is explicitly out of scope because workspace state (CWD, branch, uncommitted edits) does not reconcile between a persistent host checkout (Discord) and an ephemeral runner clone (Action); attempting to resume would hallucinate continuity that does not exist.

**Session content is treated as user-authored, untrusted input.** A Discord user shapes session content by chatting with the agent; the Action then may read that session as context. The agent's system prompt (the `<harness_rules>` block from PR #465) must explicitly treat session history as conversation, not trusted instructions. This matches the existing posture for PR bodies, comments, and webhook payloads — session content enters the same untrusted-input pipeline, no new integrity machinery (no signing, no append-only enforcement, no write-prefix isolation). If session content later proves adversarial in practice, v1.1 adds the integrity layer then.

**Read-only summaries bridge.** When the Action completes a run, it writes a condensed summary to a shared `summaries/` namespace (not raw session content). The gateway can surface these summaries in slash-command autocomplete and in prompts (e.g., `/fro-bot review <pr>` can show 'Fro Bot already reviewed this in Action run <id>, summary attached'). The Action can write to this namespace from its finalize phase; the gateway reads but does not write to it. Summaries are agent-authored distillations, not session excerpts — cheaper to include in prompts and safer to cross-surface.

**R4. Local execution by default; cloud dispatch when warranted.** The gateway runs OpenCode against a local checkout in its sandboxed workspace. When the user explicitly asks for cloud execution (slash command), or when policy says so (bigger jobs, work that needs the GitHub Action's specific environment, work that should produce a PR via the existing delivery contract), the gateway dispatches a `workflow_dispatch` into the GitHub Action and reports progress back to Discord.

**R5. Sandboxed agent execution (middle-path containment).** Local agent execution runs inside a containment-oriented sandbox. The workspace cannot make arbitrary outbound HTTPS to non-allowlisted hosts. Network egress flows through a build-time HTTP(S) allowlist implemented by `mitmproxy`, the single pattern adopted from sachitv/opencode-omo-sandbox-docker. The sandbox is a developer-grade containment, not a hardened VM boundary, and the threat model assumes a non-malicious model that should still not be able to exfiltrate unintentionally.

Explicitly **not** included in v1 containment:

- **DNS allowlist (CoreDNS):** DNS exfiltration is a theoretical concern for a non-malicious model; deferred until the threat model upgrades.
- **Git credential broker:** deploy keys and GitHub App credentials are bind-mounted read-only into the workspace (`chmod 400`, owned by a non-root agent user). This is an **accepted risk**: an actively adversarial model with shell access could exfiltrate the mounted credentials. The mitigation for v1 is trusting the model's non-malicious posture; v1.1 can add the broker if needed.

Acknowledged scope limits (same as under the full stack): the sandbox does not prevent (a) covert channels through allowlisted endpoints (e.g., encoding data in prompt/response bodies to the LLM provider), (b) CA-bypass in scripted clients that override TLS verification, or (c) prompt-injection-induced misbehavior inside the agent's allowed tool surface. Defense for those classes is a separate concern (per-tool approval flows, output review, and operator vigilance).

**R6. Role-based access control.** The gateway uses Discord's role system for authorization, following the Kimaki pattern. A specific Discord role (default name: `fro-bot`, distinct from the `@fro-bot` bot mention) gates who can interact. A separate block role (default name: `no-fro-bot`) overrides that grant. Bots are ignored unless they have the access role. Single-tenant for v1 (one gateway instance per user, no Discord-user-to-GitHub-identity mapping), but the design must not foreclose multi-tenancy.

**R7. Self-hostable Docker delivery.** The gateway ships as a `docker compose` stack with three services (gateway, workspace, mitmproxy). A user clones a small bootstrap repo, populates secrets and config, and runs `docker compose up`. No SaaS layer. Marcus runs an instance for himself; other users can self-host.

**Credential storage split:**

- **Docker secrets** (mounted read-only at `/run/secrets/<name>`, read as files): Discord bot token, GitHub App private key, GitHub App ID, LLM provider API keys, S3 access credentials.
- **`.env` file** (plaintext, `.gitignored`, `chmod 600`): non-sensitive config like S3 bucket name, S3 region, S3 endpoint, log level, Discord server ID, mitmproxy allowlist overrides.

Docker secrets close the 'leaked via git/shell history' class of incident because they live outside the repo and outside the process environment. Rotation in v1 requires restarting the gateway container (planning may add a `reload-credentials` hook); v1 documents this as a known operational characteristic, not a gap. This matches the open-source/privacy-minded posture and lets the same artifact serve "personal Fro Bot" and (eventually) "team Fro Bot" deployments.

**R8. Conservative reuse of existing architectural assets.** The gateway must not reimplement agent execution, session storage, prompt assembly, or object-store logic. The work is to extract a **narrow shared runtime package** covering only those four layers (`features/agent/`, `services/session/`, relevant parts of `features/agent/prompt.ts`, and `services/object-store/`). Both frontends consume this package.

Explicitly out of the shared package: the harness phases (`bootstrap`, `routing`, `dedup`, `acknowledge`, `cache-restore`, `session-prep`, `execute`, `finalize`, `cleanup`), event routing, `NormalizedEvent` normalization, `@actions/*`-coupled code, and the output-mode resolver. Each frontend writes its own harness. The Action keeps its existing harness. The gateway writes a new one that composes the same shared runtime differently (long-running Discord event loop instead of per-invocation phase pipeline). The two harnesses will look different because they serve different runtimes, and that's expected.

The XML prompt architecture and Delivery Mode contract (PR #517) are part of the shared runtime — both surfaces need them. Event routing and context normalization are not — Discord and GitHub produce fundamentally different event shapes that do not generalize cleanly.

**R9. Discord-native ergonomics.** The Discord experience must feel like Discord, not like a CLI bolted into Discord. Specific behaviors:

- **Thread-per-session.** Each `@fro-bot` mention in a channel auto-creates a thread; subsequent messages in that thread don't need a mention. Matches Hermes's auto-thread pattern.
- **Rich responses.** Embeds, code blocks, and file attachments. Long responses (>2000 chars) are split at logical breaks (section boundaries, between code blocks) or attached as a file with a short summary message; a code block is never split mid-block.
- **Reactions for progress states.** `👀` added when the bot starts processing, `🎉` on success, `😕` on failure.
- **Long-run progress in the working message.** For runs longer than ~90 seconds, the gateway edits the initial working message every 60-90 seconds to reflect elapsed time and current phase (e.g., `[2m 15s] reading files...`, `[5m 03s] running tests...`). Single in-place edit, no channel noise, always-current state.
- **Inline approval buttons for sensitive operations** (see S5 for contents).
- **Slash commands** that auto-complete in Discord's native UI; the agent's registered skills surface as `/fro-bot <skill>` commands where applicable.
- **File attachments** on incoming messages (images, code, docs) are included in the session context.
- **Mention safety by default.** All outgoing messages set `allowed_mentions: { parse: ['users'] }`. The agent cannot emit `@everyone`, `@here`, or role pings even if the model's text output contains those strings. Individual user mentions by ID remain allowed but are rare in practice. This is a hard default, not user-configurable in v1.

**R10. Observable execution.** Every Discord-triggered run produces the same observability the existing GitHub Action does: structured logs, a run summary visible in Discord (and posted back to GitHub when relevant), session-id traceability, metrics (token usage, duration, tool calls). A user looking at a Discord thread should be able to identify exactly which session ran and inspect its full trace.

**R11. Run lifecycle, queueing, and cross-instance coordination.** v1 correctness contracts:

- **Run-state lifecycle.** Every Discord-triggered run has an S3-persisted lifecycle record: `PENDING → ACKNOWLEDGED → EXECUTING → COMPLETED | FAILED`. Gateway heartbeats while EXECUTING. On restart, gateway scans for EXECUTING records older than 2× heartbeat interval and marks them FAILED ('gateway restarted during execution'), editing the working message in Discord to reflect the failure. Handles gateway crashes, host reboots, and Discord WS drops without leaving users staring at a dead 'thinking...' indicator.
- **Same-thread queueing.** Within a Discord thread, tasks execute serially. If task B is fired while task A is still executing, B posts 'queued (position 1), waiting for current task to finish' and starts when A completes. `/fro-bot clear-queue` cancels pending tasks. `/fro-bot abort` stops the currently executing task. Matches the Kimaki `/queue` pattern and aligns with a single-conversation-at-a-time mental model.
- **Per-repo single-writer lock.** Only one execution runs against a given repo at a time, across all surfaces (Discord channels, Action runs, cron triggers). Lock record in S3 with TTL. When any instance wants to run, it attempts to acquire the lock; if held, it queues and surfaces the current holder ('Action run #24601 is currently reviewing PR #42 — queued, 3 min elapsed'). Resolves both the multi-channel-same-repo collision and the Discord-vs-Action concurrent-execution scenarios with the same mechanism. Sequential execution is accepted as the cost; v1 does not attempt optimistic concurrency or per-file locking.

## Non-Goals (Scope Boundaries)

**Out of scope for v1:**
- **Multi-tenant SaaS hosting.** No hosted Fro Bot service. Self-hosted only. Multi-tenancy is a design consideration, not a deliverable.
- **Slack, Telegram, email, or other messaging surfaces.** Discord only. The gateway architecture must not foreclose adding more (the Hermes "messaging gateway" pattern is the long-term shape), but only Discord ships in v1.
- **Voice messages, voice channels, screen sharing.** Kimaki and Hermes both ship these; we explicitly defer them. Text + file attachments + reactions only.
- **Autonomous loops without a human trigger.** No self-initiated work in v1. Every run starts from a Discord message, slash command, or `workflow_dispatch` from existing scheduled workflows. Long-term, the gateway can host autonomous loops, but that's a separate slice.
- **Replacing the GitHub Action.** The Action keeps handling webhook-triggered PR reviews, the DMR cron, and the wiki cron. The gateway is additive.
- **Per-user GitHub identity mapping.** v1 acts as the configured GitHub App identity (`fro-bot[bot]`) regardless of which Discord user triggered the work. Bridging Discord users to GitHub identities is a future concern.
- **Per-channel ephemeral system prompts** (Hermes's `channel_prompts`), forum channels, voice STT/TTS, and home-channel proactive notifications. All deferred.
- **A new agent execution engine.** The agent runs OpenCode (via the existing SDK integration), inside the sandbox. We do not build a new agent runtime — we wrap the existing one.

**Permanent non-goals:**
- **Hardened VM-grade isolation.** The sandbox is containment, not isolation. A determined adversary could escape it. The threat model is "well-meaning model that should not exfiltrate or escape unintentionally," not "actively hostile model with capability to break out."
- **Replacing the project's git/PR conventions.** Branches, commits, and PRs created by the agent through Discord must follow the same conventions (commit message style, PR description style, AGENTS.md compliance) the Action follows.

## Success Criteria for v1

The v1 release is successful when all of the following hold:

1. Marcus can self-host the gateway from a Docker Compose stack on a host of his choice with under 30 minutes of setup, given pre-existing GitHub App credentials and a Discord bot token.
2. From Discord, Marcus can `@fro-bot` in a channel mapped to a repo and the agent reads/edits files in that repo's checkout, with reactions showing progress and a final message containing the run summary.
3. From Discord, Marcus can `/fro-bot review <pr-url>` and the agent reviews the PR — same quality bar as the existing Action's PR reviews — with results posted to both Discord and the PR (single comment per invocation, per the existing Response Protocol).
4. Session context is shared across surfaces (read-only). A Discord user can ask 'what did Fro Bot find when it reviewed PR #42?' and the gateway can surface the Action's summary and optionally pull the full session into the prompt as context. Cross-surface *resume* is explicitly not a v1 behavior — workspace state does not reconcile between surfaces.
5. The agent's local execution cannot make HTTP requests to hosts not on the build-time allowlist, cannot do DNS lookups for non-allowlisted domains, and cannot read git credentials directly. Verified by `mitmproxy` logs showing all egress + by negative tests confirming blocked traffic.
6. The existing GitHub Action's behavior is unchanged on the same trigger surface (webhook PR reviews, DMR cron, wiki cron). No regressions in CI quality, latency, or cache behavior.
7. The conservative shared runtime is extracted: both frontends import agent execution, session storage, prompt assembly, and object-store logic from the same package. Duplication is limited to the harness layers, which are intentionally separate because the Action and gateway serve fundamentally different runtimes.

## Architectural Decisions Made During Brainstorming

These decisions are settled and feed into planning. They are not open questions.

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **Approach A with conservative extraction scope**: `@fro-bot/runtime` covers agent execution, session storage, prompt assembly, and object-store only. Harness phases, routing, and `@actions/*`-coupled code stay in the Action. Gateway writes its own harness. | The Action's harness phases were designed for ephemeral runners with a per-invocation pipeline; that shape does not match a long-running Discord gateway. Extracting only the genuinely shared layer narrows the blast radius on the Action during the refactor, keeps each frontend's harness appropriate to its runtime, and avoids speculative generalization of event routing across two fundamentally different event shapes. The shared layer can grow later if a third surface appears and the real shared surface becomes visible. |
| D2 | **Discord-first**, not Slack/Telegram/email/etc. for v1 | Discord is where the user actually sits. Other surfaces add scope without sharpening the v1 use case. Architecture must not foreclose adding them later. |
| D3 | **Action-taking agent**, not read-only companion or observer-only | The user explicitly chose this. Lower-stakes alternatives don't justify the architecture cost. |
| D4 | **Local execution by default + cloud dispatch as opt-in** | Borrows from Kimaki (channel = local project) and adds GitHub Actions dispatch for work that benefits from cloud compute. Both paths share session storage. |
| D5 | **Self-hosted via Docker Compose**, not VPS-specific or SaaS | Matches the open-source/privacy-minded posture. Any host can run it. Easier to test locally. Multi-tenancy deferred. |
| D6 | **Middle-path sandbox**: mitmproxy HTTP allowlist + non-root agent user + default-deny network policy + bind-mounted credentials (accepted risk). No CoreDNS, no git-broker in v1. | The sachitv pattern is the reference but v1 adopts only the single highest-leverage piece (mitmproxy). DNS allowlist and credential brokering add operational complexity that does not match the stated non-malicious-model threat. Both can be added in v1.1 if the threat model upgrades. |
| D7 | **S3 storage** as session-of-record (already shipped in PR #514) | The gateway and Action both read/write the same sessions. No duplicate storage. |
| D8 | **Single-tenant for v1**, multi-tenancy as a design constraint not a deliverable | Avoids premature complexity. Discord role-based access provides first-pass authz; multi-tenancy bridges Discord ↔ GitHub identity (future). |
| D9 | **Channel ↔ repo, thread ↔ session** | Kimaki's mental model. Maps cleanly to how Discord users already think about scope. |
| D10 | **GitHub App credentials**, not per-user PATs | All v1 actions attribute to `fro-bot[bot]`. Per-user attribution is multi-tenancy work. |
| D11 | **No autonomous loops in v1.** Every run is triggered by a Discord message, slash command, or webhook | Removes a major dimension of design and operational risk. Loops are a future slice on top. |

## User Stories

The v1 gateway delivers these concrete user stories. Each one corresponds to one or more requirements above.

**S1. Reach the agent from Discord.** *Given* the gateway is running and I'm a member of the configured Discord server with the `fro-bot` role, *when* I `@fro-bot` in a channel mapped to a repo with a question or task, *then* the agent creates a thread, posts a working reaction, and responds in the thread with the result.

**S2. Discuss a PR review in real time.** *Given* the gateway is running and the existing Action just posted a PR review, *when* I `@fro-bot` in Discord asking "explain finding #3 in your last review of PR #N", *then* the agent loads the relevant session, answers in Discord, and updates the run summary.

**S3. Have the agent edit files locally.** *Given* a Discord channel mapped to a repo, *when* I ask `@fro-bot` to make a code change, *then* the agent edits files in the local checkout (inside the sandbox), commits to a branch, and either pushes that branch + opens a PR (if the channel is configured for `branch-pr` delivery) or leaves the working directory for me to review (if configured for `working-dir` delivery). The gateway reuses the existing Delivery Mode contract shipped in PR #517 — it does not introduce a new one.

**S4. Dispatch heavy work to cloud.** *Given* a Discord channel and a task that benefits from the GitHub Action's environment (matrix CI, secrets-heavy operations, long-running work), *when* I run `/fro-bot cloud <task>`, *then* the gateway triggers a `workflow_dispatch` on the existing Action and posts back the run URL + status updates as the Action progresses.

**S5. Approve a sensitive action.** *Given* the agent is about to run a tool that needs approval (commit, push, merge, tool outside its standard set), *when* the approval moment arrives, *then* the gateway posts an inline Discord embed in the thread with the following fields:

- **Action** — tool name in human-readable form (e.g., `commit`, `push`, `open-pull-request`)
- **Target** — what the action operates on (branch name, file paths, PR number, etc.)
- **Summary** — 1-2 lines describing the effect (e.g., '42 lines added, 8 removed across 3 files')
- **Why** — the agent's 1-sentence reasoning for proposing the action

Below the embed, a button row: `Accept` / `Accept Always` / `Deny`. `Accept Always` persists a per-channel approval for that tool. A separate `/fro-bot approvals` command lists and revokes persisted approvals. Arguments shown in the embed are redacted for anything matching credential/secret patterns before rendering (belt-and-suspenders with the output sanitization from S1-S3 security work).

**S6. Resume a prior session.** *Given* I had a session yesterday on a specific question, *when* I run `/fro-bot resume` and pick the session from autocomplete, *then* the gateway opens a thread continuing that session with full context loaded.

**S7. Self-host the gateway.** *Given* I have Docker installed, a Discord bot token, GitHub App credentials, and an S3 bucket, *when* I clone the gateway repo, fill out `.env`, and run `docker compose up -d`, *then* the gateway connects to Discord, registers slash commands, and is ready to handle messages.

**S8. Add a repo to the gateway.** *Given* the gateway is running, *when* I run `/fro-bot add-project url:<git-url> [channel:<optional>]`, *then* the gateway:

1. Authenticates to GitHub using its configured GitHub App credentials (same token the Action uses; no per-user PAT).
2. Creates a new Discord channel (or reuses a named one if `channel:` is specified).
3. Starts a thread in the new channel to show setup progress, with phase messages: `authenticating...` → `cloning...` → `binding channel to repo...` → `ready`.
4. Clones the repo into the sandboxed workspace at a stable path.
5. Binds the Discord channel to the repo path; subsequent `@fro-bot` messages in that channel operate on the cloned workspace.

**Errors surface as red-sidebar embeds in the setup thread**, with actionable text: if the GitHub App lacks access to the repo, the error message includes a link to the App's installation settings. v1 accepts URLs only (HTTPS or SSH); local path support is deferred to v1.1 unless it proves necessary.

## Reference Architectures and What We Adopt

### From Kimaki (heavy adoption)

- Channel = project, thread = session mental model
- Slash command surface (`/session`, `/resume`, `/abort`, `/add-project`, `/new-worktree`, `/model`, `/agent`, `/share`, `/fork`, `/queue`, `/clear-queue`, `/undo`, `/redo`, `/upgrade-and-restart`)
- Tool permission UX (Accept / Accept Always / Deny buttons in-thread)
- Role-based access (`fro-bot` role + `no-fro-bot` block role)
- Memory file at session start (`MEMORY.md` from project root, mirrors current Fro Bot AGENTS.md hydration pattern)
- Message queue for follow-ups
- File attachment as message-as-file for long prompts

### From Hermes Discord (selective adoption)

- Auto-thread-per-`@mention` in regular text channels (cleaner scoping)
- Per-user session isolation in shared channels (`group_sessions_per_user: true` default)
- Mention safety defaults (no `@everyone`/`@here` even if the model emits them)
- Reactions for progress (`👀` start, `✅` success, `❌` failure)
- DMs always respond, channels require mention by default
- Home channel concept (deferred from v1, reserved for autonomous loops later)
- Slash command registration alongside skills

### From sachitv/opencode-omo-sandbox-docker (architectural backbone)

- Devcontainer-style workspace, not bare host execution
- mitmproxy as single egress chokepoint, network-namespace shared
- CoreDNS for DNS allowlist (same source-of-truth as HTTP allowlist)
- `git-broker` MCP for git ops (workspace never holds raw deploy keys/PATs)
- Build-time policy (allowlist baked into image, agent cannot modify at runtime)
- Default-deny network: HTTP non-allowlisted → block, DNS non-allowlisted → REFUSED, UDP 80/443 → reject (kills QUIC/HTTP3), DoT/encrypted DNS → reject, IPv6 off, IP-based connections blocked
- Workspace runs as non-root `agent` user, no passwordless sudo, SSH agent forwarding disabled
- Threat model: well-meaning model, not actively hostile

### What we don't take from the references

- Voice messages, voice channels, screen sharing (Kimaki) — out of v1 scope
- Twelve other messaging surfaces (Hermes) — Discord only
- VS Code Dev Containers as the run-mode (sachitv) — we run server-side, not editor-side
- Per-channel ephemeral prompts (Hermes `channel_prompts`) — defer to a later iteration once the v1 surface settles

## Open Questions (for Planning)

These are questions the brainstorm intentionally does not answer because they are implementation choices best made during planning. They are not gaps in product clarity.

**Q1. Local checkout strategy.** Per-channel persistent checkout (one clone per channel)? Per-session ephemeral worktree (clean slate per session)? Persistent main checkout + per-session worktrees (Kimaki's `/new-worktree`)? All three are viable; choice depends on disk usage, session-isolation requirements, and how often the agent needs to switch branches.

**Q2. Compose stack composition.** Which services are separate containers vs combined? Gateway (Discord daemon + dispatch + session storage adapter) is one container. Workspace + mitmproxy + CoreDNS + git-broker are sandboxed cluster. MCP services (Brave, Perplexity, Context7) are optional add-ons. Exact split is planning work.

**Q3. Cloud dispatch protocol.** Settled: gateway calls `workflow_dispatch` with a **strict typed schema**. Fixed input shape:

```
{
  task_type: 'pr-review' | 'issue-triage' | 'custom',
  repo: string,               // owner/name
  pr_number?: number,
  issue_number?: number,
  branch?: string,
  prompt: string              // the only field carrying user-authored content
}
```

The gateway validates every field before dispatch (types, lengths, allowed-character regex on `repo`, `branch`). The Action re-validates on receipt as defense-in-depth; `prompt` is treated the same way user-supplied prompts already are (XML-wrapped, subordinated to `<harness_rules>`). Discord user input can only reach the Action via the `prompt` field. Job-status streaming back to Discord remains an open sub-question: polling `workflow_run` every 10-15s vs subscribing to GitHub's `workflow_run` webhook. Planning decides based on latency budget.

**Q4. Shared runtime package layout.** The conservative extraction scope from R8 is settled: agent execution + session storage + prompt assembly + object-store. The open question for planning is the package layout. Options:

- **Monorepo directory** (`src/runtime/` inside `fro-bot/agent`): Action imports from `./runtime`, gateway imports from a sibling package in the same workspace. Simplest, no versioning complexity, no npm publishing.
- **Separate npm package** (`@fro-bot/runtime`): Published to npm, gateway installs it as a dependency. Clean boundary, independently versionable, but adds publish/release overhead and forces a public API contract early.
- **Workspace package** (pnpm workspace): A package inside the monorepo but resolved via workspace protocol. Compromise between the two.

The choice depends on whether the gateway lives in the same repo as the Action or in its own. Answer that first, then the packaging falls out.

**Q5. Session ID format and summaries-bridge schema.** Under R3, each surface uses its own logical keys (Action: `issue-42`, `dispatch-12345`; Discord: `thread-{channel-id}-{thread-id}` or similar). The key-space namespace is `{tenant}/{surface}/{logical-key}` where tenant is `default` in v1 and reserved for multi-tenancy later. Open sub-questions for planning:

- What goes in a summary record? Minimum: run timestamp, triggering entity (PR#, issue#, cron name), 2-3 sentence outcome, link to the full session, key file paths touched. Maximum: depends on how much the cross-surface UX wants inline.
- How does each surface discover the other's summaries? Prefix-listing on S3? Materialized index? Per-entity lookup? Answer affects latency of `/fro-bot review <pr>` showing prior Action context.
- Retention: summaries are cheaper than full sessions, could live longer. Planning decides.

**Q6. Run-state record schema and heartbeat cadence.** Settled under R11: explicit lifecycle with S3-persisted records and heartbeats. Open sub-questions for planning:

- Record schema (minimum: run ID, triggering surface, Discord thread + message IDs, current phase, last-heartbeat timestamp, start time, entity refs for the read-only summaries bridge from R3).
- Heartbeat cadence (every 30s? 60s? Affects time-to-detect-failure after crash).
- Where on S3: `lifecycle/` prefix? Colocated with sessions? Affects IAM policy scope.

**Q7. mitmproxy allowlist source.** The allowlist needs to cover OpenCode's npm install, GitHub API, the LLM provider(s), oh-my-openagent's registry, S3 endpoint, Discord API, and any MCP services we ship. Some of these (LLM provider, S3 endpoint) are configurable per deployment, so the allowlist either needs templating or a generation step at container start. Planning decides: bake-at-build-time (more secure, requires rebuild to change) vs generate-at-start (more flexible, attack surface if compromised). Given the bind-mounted-credentials accepted risk already, build-time is probably not meaningfully more secure.

**Q8. Per-repo lock implementation details.** Settled under R11: single-writer lock per repo across all surfaces. Open sub-questions for planning:

- Lock record format (repo owner/name as key, lock holder identity, acquired-at, TTL).
- Lock-acquisition semantics when held: block (queue with visible status) vs return-immediately with a 'busy' signal. Probably block with an inline progress indicator in Discord.
- Interaction with the existing Action's dedup phase — does the Action still run its own dedup, or does the lock supersede? Likely supersede: R11's lock is the authoritative coordination mechanism, and the Action's dedup logic becomes redundant for repo-level coordination (though it may still be useful for within-surface bucket-of-work dedup).

**Q9. Tool MCP plugin** (RFC-018) integration. RFC-018 specs OpenCode plugin tools (`create_branch`, `commit_files`, `create_pull_request`) that run inside the agent process. In the gateway's sandboxed workspace, these tools route through the `git-broker` MCP to honor the credential boundary. Planning needs to design how the existing RFC-018 tool surface maps onto the broker.

## Risks

**RISK-1. mitmproxy CA injection + network namespace coordination still requires polish.** Even the middle-path sandbox (3 services) needs careful setup: mitmproxy CA injected into the workspace's system trust store, shared network namespace so the workspace's egress flows through mitmproxy, transparent HTTPS interception. Translating this to "user runs `docker compose up` and it just works" still requires operational polish — less than the full sachitv stack, but non-trivial. *Mitigation:* fork sachitv's mitmproxy + workspace layout specifically (drop the CoreDNS and git-broker services); document the threat model + setup requirements; provide a one-command setup script that validates the CA trust chain before declaring success.

**RISK-2. Runtime extraction breaks the Action.** The Action is in production. Pulling the runtime out into a shared package while the Action still works correctly is delicate. *Mitigation:* extract incrementally with the Action as the first consumer, gated by full test coverage; gateway frontend ships only after the Action runs cleanly on the extracted runtime in CI for several days.

**RISK-3. Discord WS reliability under network partitions.** Marcus's host might lose internet. Discord might rate-limit. The gateway must reconnect cleanly, replay missed events where possible, and not lose user prompts. *Mitigation:* well-tested Discord library (discord.js or a stable alternative), explicit reconnect/backoff logic. In-flight prompts are protected by the R11 run-state lifecycle — a crashed gateway resumes with EXECUTING runs visible, marks them FAILED with a clear reason, and the user can retry. No work is silently lost; the worst case is 'your run failed, please retry' rather than 'the agent forgot about you'.

**RISK-4. Cross-surface context access — session discovery fidelity.** R3 narrowed the risk substantially by ruling out cross-surface resume. What remains: the read-only summaries bridge and cross-surface context access need reliable discovery. Current `searchSessions()` is substring-based against session titles; the gateway's use case (pull the Action's summary for a specific PR when the user asks about it) is entity-based lookup, not full-text search. *Mitigation:* design the summaries record schema with entity-indexed keys (PR#, issue#, cron name) so surface-to-surface discovery is O(1) lookup, not O(N) search. Full-text search remains available for ad-hoc 'what do you know about X' queries but is not on the critical path.

**RISK-5. Cost and complexity of self-hosting.** Marcus is willing to self-host. Other early users might not be. If we want adoption beyond Marcus, the self-host UX has to be excellent — probably better than Kimaki's "npx kimaki" by being closer to "docker compose up" with a sane default config. *Mitigation:* aim for a "happy path setup in <30 min" success criterion (S1); accept that complex deployments are an explicit non-goal for v1.

**RISK-6. Soft-control prompt guidance is the same soft-control limitation as PR #517.** The agent is told not to do things; that's not the same as it being unable to. The sandbox closes the network egress hole. The git-broker closes the credential hole. But the agent can still misbehave inside its allowed surface — see R5 acknowledged scope limits for the full enumeration (covert channels through allowed endpoints, CA-bypass in scripted clients, prompt-injection-induced misbehavior). *Mitigation:* combine the network/credential boundaries with explicit per-tool approval flows (S5); accept that soft control + sandbox together is the design ceiling, not the model behaving perfectly.

**RISK-7. Multi-tenancy retrofit cost.** The brainstorm decided single-tenant for v1. If we get six months in and want multi-tenant, will the design absorb that or require rewriting? *Mitigation:* document multi-tenancy as a design constraint (D8); resist single-tenant shortcuts that break the path (e.g., hardcoding "the user", hardcoding GitHub identity, sharing global state across implicit tenants).

**RISK-8. Operational maturity gap.** The Action's "operations" is GitHub's responsibility. The gateway's "operations" is Marcus's. Logs, metrics, alerts, restart, upgrade — all become real concerns. *Mitigation:* default to structured logs to stdout (host captures), expose minimal metrics endpoint, document upgrade paths from day one. Don't ship an admin UI in v1 — CLI-via-Docker-exec is fine.

## Recommended v1 Slice

The brainstorm narrows to this concrete v1 slice for the planning phase to chew on:

**v1 ships when:**
- Conservative `@fro-bot/runtime` extracted (agent exec + session storage + prompt assembly + object-store); existing GitHub Action runs on it cleanly in CI
- Docker Compose stack: `gateway` + `workspace` + `mitmproxy` (**3 services**, middle-path sandbox)
- Gateway speaks Discord — connects, joins channels, listens for `@mentions` and slash commands, posts back
- Sessions stored in S3 (existing backend). Discord and Action write to same bucket with per-surface namespacing. Resume is within-surface only; cross-surface context access via read-only summaries bridge
- Channel ↔ repo binding via `/fro-bot add-project`
- Local execution via OpenCode in workspace, inside sandbox, against a checkout
- Cloud dispatch via `/fro-bot cloud <task>` triggering `workflow_dispatch`
- Tool approval buttons for sensitive operations
- Reactions, working/done emoji, run summary in thread
- Role-based access (`fro-bot` role required, `no-fro-bot` blocks)
- Documentation: setup guide, threat model, known limits, upgrade path

**v1 explicitly does NOT ship:**
- Voice anything
- Forum channels
- Multi-tenancy
- Per-user GitHub identity mapping
- Autonomous loops
- Hosted SaaS
- Slack / Telegram / any other surface
- Per-channel ephemeral prompts
- Replay/eval harness (idea #6 — independent)
- Memory router (idea #4 — compounds later)
- Self-improving skill distillation (idea #5 — compounds later)

## Source

- Ideation: `docs/ideation/2026-04-15-autonomous-agent-platform-ideation.md` (idea #1)
- Foundation: PR #514 (S3 storage backend), PR #517 (delivery contract), PR #465 (XML prompt architecture, harness_rules authority)
- References: [remorses/kimaki](https://github.com/remorses/kimaki), [Hermes Discord docs](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/discord), [sachitv/opencode-omo-sandbox-docker](https://github.com/sachitv/opencode-omo-sandbox-docker)
- Brainstorm session: 2026-04-17 — DEEP scope, single-select dialogue across motivator → use case → approach → hosting model → sandbox adoption

## Session Log

- 2026-04-17: Initial brainstorm. Resolved: Discord as primary surface (not autonomous loops or persistent runtime), full action-taking agent (not read-only or observer), Approach A (extract runtime + new Discord surface, not fork Kimaki or hybrid), Docker image deliverable (not VPS-specific or SaaS), adopt sachitv sandbox patterns (mitmproxy + CoreDNS + git-broker + namespace sharing). Drafted v1 scope and 7 success criteria. 11 architectural decisions captured. 9 open questions deferred to planning. 8 risks identified with mitigations.
