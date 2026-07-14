<div align="center">

<img src="./assets/banner.svg" alt="Fro Bot Agent Banner" width="100%" />

# Fro Bot Agent

> AI-powered GitHub automation with persistent memory

[![Build Status](https://img.shields.io/github/actions/workflow/status/fro-bot/agent/ci.yaml?style=for-the-badge&label=Build&labelColor=0D0216&color=00BCD4)](https://github.com/fro-bot/agent/actions) [![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/fro-bot/agent/badge?style=for-the-badge&labelColor=0D0216&color=E91E63)](https://securityscorecards.dev/viewer/?uri=github.com/fro-bot/agent) [![License](https://img.shields.io/badge/License-MIT-FFC107?style=for-the-badge&labelColor=0D0216&color=FFC107)](LICENSE)

[Overview](#overview) · [Getting Started](#getting-started) · [Usage](#usage) · [Configuration](#configuration) · [Development](#development)

</div>

---

## Overview

Fro Bot Agent is a Bun monorepo that runs an [OpenCode](https://opencode.ai/) agent across several surfaces: a **GitHub Action** that responds to repository events (issues, pull requests, comments, reviews, and scheduled runs), a **Discord-first Gateway** daemon with an authenticated operator web/API surface for launching and observing runs outside of CI, a **sandboxed workspace executor** that clones and runs the agent in an isolated container, a **patched OpenCode harness** build/publish pipeline, and shared **runtime/session primitives** used across all of the above. The GitHub Action **preserves OpenCode session state across runs**, while the Gateway starts a fresh OpenCode session per run but persists coordination and run state through its S3-backed control plane.

Traditional CI-based AI agents are stateless: each run starts from scratch, repeating investigations and burning tokens. The GitHub Action persists its session state across runs (GitHub Actions cache, with optional S3 backup), so it builds context over time, references prior work instead of redoing it, and resumes interrupted tasks.

### Key Features

- **Persistent memory** — session state survives workflow runs via cache, with optional S3 write-through backup that outlives cache eviction.
- **Multiple triggers** — responds to comments, issues, pull requests, review threads, and scheduled or manually dispatched runs.
- **Discord Gateway** — a daemon that runs OpenCode work from authorized `@fro-bot` mentions and exposes slash commands for setup and operator controls (e.g. adding a project, clearing the queue).
- **Operator web surface** — an authenticated HTTP/SSE control surface for launching, observing, and approving gateway agent runs from a browser.
- **Sandboxed workspace executor** — a workspace-agent container that clones repositories and runs the agent behind an egress-allowlisted proxy, deployable via the `deploy/` Compose stack.
- **Auto-setup** — installs OpenCode on first run; no manual toolchain setup.
- **Security-first** — author-association gating, credential hygiene, and fork-PR protection are enforced, not optional.
- **Observability** — every run writes a summary with metrics and error context.
- **Extensible orchestration** — opt in to [Oh My OpenAgent](https://github.com/code-yeongyu/oh-my-openagent) or [OMO Slim](https://github.com/alvinunreal/oh-my-opencode-slim) when you need extended provider and agent workflows.

## Getting Started

### 1. Configure credentials

Add an `OPENCODE_AUTH_JSON` secret (Settings → Secrets and variables → Actions) mapping your LLM providers to credentials:

```json
{
  "anthropic": {"apiKey": "sk-ant-api-..."},
  "openai": {"apiKey": "sk-..."}
}
```

Any provider OpenCode supports works here — see the [OpenCode docs](https://opencode.ai/docs/).

### 2. Add the workflow

Create `.github/workflows/fro-bot.yaml`:

```yaml
name: Fro Bot Agent
on:
  issue_comment:
    types: [created]

jobs:
  agent:
    # Only run when @fro-bot is mentioned
    if: contains(github.event.comment.body, '@fro-bot')
    runs-on: ubuntu-latest
    permissions:
      contents: write
      issues: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
      - uses: fro-bot/agent@v0
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          auth-json: ${{ secrets.OPENCODE_AUTH_JSON }}
```

### 3. Mention the agent

Comment `@fro-bot` on any issue or pull request. The agent acknowledges with a reaction, restores its memory, runs the task, and posts a single response with a run summary.

> [!TIP]
>
> The snippet above wires a single trigger. For the complete workflow — every supported trigger, conditional token selection, scheduled tasks, and PR reviews — copy [`docs/examples/fro-bot.yaml`](docs/examples/fro-bot.yaml). To have an agent set it up for you, point it at that file with the prompt below.

```txt
Fetch `https://raw.githubusercontent.com/fro-bot/agent/refs/heads/main/docs/examples/fro-bot.yaml` and follow the instructions at the top of the file to set up the Fro Bot agent workflow for this repository.
```

> [!NOTE]
>
> `@fro-bot` mention triggers require a token whose login matches the mention. `GITHUB_TOKEN` posts as `@github-actions`, so responding to `@fro-bot` needs a PAT or GitHub App token.

## How It Works

Each run moves through a multi-phase pipeline: restore cached session state, discover relevant prior sessions, acknowledge the request, execute the OpenCode agent with full history, publish exactly one comment or review, then persist and prune session state back to the cache (and S3, if configured). Session state is cached under a branch-scoped key so branches stay isolated while continuity is preserved within a feature branch.

For the full execution model, invariants, and the three data flows, see **[ARCHITECTURE.md](ARCHITECTURE.md)** or the [Execution Lifecycle](docs/wiki/Execution%20Lifecycle.md) deep dive.

## Usage

### Triggers

The agent supports seven event types:

- **`issue_comment`** / **`pull_request_review_comment`** / **`discussion_comment`** — respond to `@fro-bot` mentions in comments and review or discussion threads.
- **`issues`** — auto-triage on open; respond to `@fro-bot` on edit.
- **`pull_request`** — AI code review on open, sync, reopen, ready-for-review, and review-requested (an AI review, not CI).
- **`schedule`** / **`workflow_dispatch`** — run a supplied `prompt` on a cron schedule or manual dispatch.

Comment and issue triggers are gated by author association — only `OWNER`, `MEMBER`, and `COLLABORATOR` are processed. Bot accounts are ignored to prevent loops, and fork pull requests are skipped. The full guard expressions, per-trigger behavior, and minimum permissions live in [`docs/examples/fro-bot.yaml`](docs/examples/fro-bot.yaml).

### Comment examples

```markdown
@fro-bot Can you investigate why the CI tests are failing?
```

```markdown
@fro-bot What did we decide about error handling in the last discussion?
```

### Scheduled maintenance

Run the agent on a schedule to maintain a rolling report:

```yaml
name: Daily Maintenance Report
on:
  schedule:
    - cron: "30 15 * * *"

jobs:
  maintenance:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      issues: write
    steps:
      - uses: actions/checkout@v4
      - uses: fro-bot/agent@v0
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          auth-json: ${{ secrets.OPENCODE_AUTH_JSON }}
          prompt: |
            Perform daily repository maintenance and update a SINGLE rolling
            issue titled "Daily Maintenance Report". Append a dated section with
            summary metrics, stale issues and PRs, and recommended actions.
```

## Configuration

Provide inputs via the `with:` block. Only `github-token` and `auth-json` are required; everything else is optional. [`action.yaml`](action.yaml) is the authoritative, always-current source.

A few inputs most workflows touch:

- **`prompt`** — custom prompt; required for `schedule` and `workflow_dispatch`.
- **`agent`** / **`model`** — override the agent (a primary agent, not a subagent) or the model (`provider/model`).
- **`timeout`** — execution timeout in milliseconds. Default `1800000` (30 minutes); `0` disables it.
- **`response-mode`** — `github` (default) posts exactly one comment or review; `none` suppresses all GitHub writes and uses the run log as the response surface.
- **`enable-omo`** / **`enable-omo-slim`** — opt into extended orchestration (mutually exclusive).

<details>
<summary><strong>All inputs</strong></summary>

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `github-token` | Yes | — | GitHub token (App installation token or PAT) with write permissions |
| `auth-json` | Yes | — | JSON object mapping provider IDs to auth configs |
| `prompt` | No | — | Custom prompt for the agent |
| `output-mode` | No | `auto` | Requested delivery mode for `schedule`/`workflow_dispatch` runs (`auto`, `working-dir`, `branch-pr`) |
| `session-retention` | No | `50` | Number of sessions to retain before pruning |
| `s3-backup` | No | `false` | Enable S3 write-through backup |
| `s3-bucket` | No | — | S3 bucket for backup (required if `s3-backup` is true) |
| `aws-region` | No | — | AWS region for the S3 bucket (`auto` for R2) |
| `s3-endpoint` | No | — | Custom S3-compatible endpoint URL (R2, B2, MinIO) |
| `s3-prefix` | No | `fro-bot-state` | Prefix for all S3 keys |
| `s3-expected-bucket-owner` | No | — | AWS account ID of the expected bucket owner |
| `s3-allow-insecure-endpoint` | No | `false` | Allow HTTP (non-HTTPS) endpoints; local MinIO dev only |
| `s3-sse-kms-key-id` | No | — | Customer-managed KMS key ID for SSE-KMS |
| `s3-sse-encryption` | No | Endpoint-dependent | `aws:kms` (AWS S3) or `AES256` (custom endpoints) |
| `agent` | No | — | Agent to use (a primary agent, not a subagent). Defaults to OpenCode's built-in `build` agent |
| `enable-omo` | No | `false` | Enable Oh My OpenAgent for extended provider and agent support |
| `enable-omo-slim` | No | `false` | Enable OMO Slim orchestration (mutually exclusive with `enable-omo`) |
| `model` | No | — | Model override in `provider/model` format |
| `timeout` | No | `1800000` | Execution timeout in milliseconds (`0` = no timeout) |
| `opencode-version` | No | Source-pinned | OpenCode CLI version to install |
| `omo-version` | No | Source-pinned | oMo version to install |
| `systematic-version` | No | Source-pinned | Systematic plugin version to register |
| `skip-cache` | No | `false` | Skip session cache restore |
| `omo-providers` | No | — | Comma-separated oMo providers to enable |
| `omo-slim-preset` | No | `openai` | OMO Slim preset (`openai`, `opencode-go`); only when `enable-omo-slim` is true |
| `opencode-config` | No | — | JSON deep-merged into the OpenCode config |
| `systematic-config` | No | — | JSON deep-merged into the Systematic plugin config |
| `dedup-window` | No | `600000` | Skip a run if the agent already ran for the same PR/issue within this window (ms); `0` disables |
| `response-mode` | No | `github` | `github` posts one comment/review; `none` suppresses all GitHub writes |

**Outputs**

| Output                 | Description                                                   |
| ---------------------- | ------------------------------------------------------------- |
| `session-id`           | OpenCode session ID used for this run                         |
| `resolved-output-mode` | Resolved delivery mode (`working-dir`, `branch-pr`, or empty) |
| `cache-status`         | Cache restore status (`hit`, `miss`, `corrupted`)             |
| `duration`             | Run duration in seconds                                       |

</details>

### Durable object storage (S3)

Set `s3-backup: true` to use S3-compatible storage as the canonical backend. The Actions cache stays a hot accelerator; S3 is the source of truth and survives cache eviction. Restore tries cache first and falls back to S3 on miss or corruption; S3 failures are logged but never fail the run.

```yaml
- uses: fro-bot/agent@v0
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    auth-json: ${{ secrets.OPENCODE_AUTH_JSON }}
    s3-backup: true
    s3-bucket: my-agent-sessions
    aws-region: us-east-1
    s3-expected-bucket-owner: "123456789012"
  env:
    AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
    AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
```

For Cloudflare R2, Backblaze B2, or MinIO, set `s3-endpoint` and `s3-sse-encryption: AES256` (see the S3 inputs above and [`action.yaml`](action.yaml)). Credentials must come from env vars or IAM roles, never action inputs; the principal needs `s3:GetObject`, `s3:PutObject`, and `s3:ListBucket`. The [Setup and Configuration](docs/wiki/Setup%20and%20Configuration.md) deep dive covers the cache and storage strategy in full.

## Repository Structure

The repository is a Bun monorepo: the Action's logic lives in the layered root `src/`, alongside the `apps/workspace-agent` sandboxed executor and the gateway, harness, and runtime packages under `packages/`; the `deploy/` directory holds the Docker Compose stack that runs the gateway and workspace executor behind a mitmproxy egress proxy enforcing an allowlist of permitted outbound hosts. See **[STRUCTURE.md](STRUCTURE.md)** for the directory layout, key file locations, and where to add new code, and **[deploy/README.md](deploy/README.md)** / **[apps/workspace-agent/README.md](apps/workspace-agent/README.md)** for running the gateway and workspace stack.

## Development

For the full contributor workflow — setup, the command surface, testing standards, commit conventions, and the git hooks — see **[CONTRIBUTING.md](CONTRIBUTING.md)**. A quick glance:

```bash
bun install       # Install dependencies
bun run test      # Run the test suites
bun run build     # Type-check + bundle to committed dist/
bun run lint      # Lint (includes the committed-dist/ check)
```

- **Node.js 24** (see `.node-version`) and **Bun** (see `package.json` `packageManager`).
- Tests are Vitest, colocated as `*.test.ts`. Run one with `bunx vitest run packages/runtime/src/agent/prompt.test.ts`.

## Documentation

- **[ARCHITECTURE.md](ARCHITECTURE.md)** — system design, invariants, the three execution flows, and cross-cutting concerns.
- **[STRUCTURE.md](STRUCTURE.md)** — directory layout, key file locations, and where to add new code.
- **[CONTRIBUTING.md](CONTRIBUTING.md)** — setup, the command surface, testing standards, and commit conventions.
- **[SECURITY.md](SECURITY.md)** — vulnerability reporting and the security posture.
- **[AGENTS.md](AGENTS.md)** — conventions, anti-patterns, and commands in one operational page.
- **[docs/wiki/](docs/wiki/index.md)** — deep dives on the architecture, execution lifecycle, prompt design, operator surface, and [troubleshooting](docs/wiki/Troubleshooting.md).

## Resources

- [OpenCode Documentation](https://opencode.ai/docs/) — the OpenCode platform.
- [Oh My OpenAgent](https://github.com/code-yeongyu/oh-my-openagent) — extended agent workflows.
- [GitHub Actions Documentation](https://docs.github.com/en/actions) — Actions reference.

## License

[MIT](LICENSE) © Marcus R. Brown
