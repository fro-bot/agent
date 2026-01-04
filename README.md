# Fro Bot Agent

A work-in-progress GitHub + Discord “agent harness” intended to run [OpenCode](https://opencode.ai/) with an [Oh My OpenCode (oMo)](https://github.com/code-yeongyu/oh-my-opencode) style workflow (think “Sisyphus”) and keep long-lived agent state across runs.

## What this project is for

The end goal is two interchangeable entrypoints that share the same brain and memory:

- **GitHub agent**: a reusable workflow/action that can “chat” on issues, discussions, and pull requests.
- **Discord agent**: a Discord bot connected to OpenCode through a reverse proxy.

The Discord bot functionality will either leverage shared code from this repo or be based on [Kimaki](https://github.com/remorses/kimaki) (a Discord bot/CLI for controlling OpenCode sessions).

In both cases, **Fro Bot** should have access to the relevant context (PR diff, issue thread, repo files, Discord conversation) _and_ preserve what it learned from prior runs.

## Key differentiator: persistent sessions

Most “agent in CI” implementations run statelessly: they boot, do a thing, and throw away everything they learned.

This project is explicitly designed to **persist OpenCode + oMo state between runs**, so the agent can:

- recall prior investigations and fixes,
- avoid repeating the same expensive exploration,
- build up repo-specific and org-specific operational knowledge.

### What gets persisted

OpenCode stores session and application data under its XDG data directory:

- `$XDG_DATA_HOME/opencode/` (typically `~/.local/share/opencode/`)

This directory can include:

- `storage/` (primary persisted data for sessions, plugins, and other runtime state)
- `log/` (logs)
- `auth.json` (authentication data such as API keys and OAuth tokens)

The intent is to persist only what is safe and useful for continuity (the `storage/` subtree), and avoid caching secrets.

> [!WARNING]
>
> Be careful what you cache. GitHub warns not to store sensitive information (tokens, credentials) inside cache paths, because caches can be accessible to pull request workflows depending on repository settings and cache scoping. See the GitHub docs on dependency caching: [Caching dependencies to speed up workflows](https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/caching-dependencies-to-speed-up-workflows)

### How persistence works (planned)

1. **Restore** the OpenCode state directory at the start of each run using GitHub Actions cache.
2. Run the agent.
3. **Save** the updated state directory at the end of the run.
4. Optionally, do a write-through backup to object storage (S3-compatible) to survive cache eviction and enable cross-runner portability.

#### Example: cache the OpenCode state directory

```yaml
- name: Restore OpenCode state
  uses: actions/cache/restore@v4
  with:
    path: |
      ~/.local/share/opencode/storage
    key: opencode-state-${{ runner.os }}-${{ github.repository }}
    restore-keys: |
      opencode-state-${{ runner.os }}-

# ... run the agent here ...

- name: Save OpenCode state
  if: always()
  uses: actions/cache/save@v4
  with:
    path: |
      ~/.local/share/opencode/storage
    key: opencode-state-${{ runner.os }}-${{ github.repository }}-${{ github.run_id }}
```

> [!NOTE]
>
> The cache key strategy above is intentionally simple. In practice you’ll likely want keys that include an “agent identity” (GitHub vs Discord), plus optional scoping (repo-only vs repo+PR) depending on how much cross-thread memory you want.

#### Optional: write-through to S3-compatible storage

If you back state with object storage, keep the workflow generic and store credentials in GitHub Secrets.

```yaml
- name: Backup OpenCode state (optional)
  if: always()
  run: |
    aws s3 sync ~/.local/share/opencode/storage "s3://${S3_BUCKET}/opencode-state/${GITHUB_REPOSITORY}/" --delete
  env:
    S3_BUCKET: ${{ vars.S3_BUCKET }}
    AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
    AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
    AWS_REGION: ${{ vars.AWS_REGION }}
```

## Required behavior: use `session_*` tools

When running under oMo, the agent should explicitly use the **session management tool family** (`session_*`) to recover and reuse prior work.

Concrete expectations for the agent:

- **On startup**: list and restore the most relevant prior session for the current repo/context.
- **Before re-investigating**: search session history for similar errors or past fixes.
- **When closing a loop**: record the key decision/fix so it can be found later.

oMo documents these tools (names and exact behavior may evolve):

- `session_list`: enumerate sessions
- `session_read`: read a session’s history
- `session_search`: full-text search across sessions
- `session_info`: metadata/stats about a session

Reference: [code-yeongyu/oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode) (see “Session Management” in the README)

## Development

### Prerequisites

- Node.js `24.12.0` (see `.node-version`)
- pnpm (recommended; repo uses a pnpm workspace)

### Common commands

- Install dependencies: `pnpm bootstrap`
- Build: `pnpm build`
- Typecheck: `pnpm check-types`
- Lint: `pnpm lint`
- Test: `pnpm test`

## References

- OpenCode tool configuration: [opencode.ai/docs/tools](https://opencode.ai/docs/tools/)
- GitHub Actions cache action: [actions/cache](https://github.com/actions/cache)
