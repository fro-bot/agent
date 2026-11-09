# SETUP MODULE

**Location:** `src/services/setup/`

Environment bootstrap logic: OpenCode CLI and Systematic plugin installation. Manages authentication state (Git identity, gh CLI) and tool cache persistence.

## WHERE TO LOOK

| Component      | File                   | Responsibility                                          |
| -------------- | ---------------------- | ------------------------------------------------------- |
| **Setup**      | `setup.ts`             | Orchestration entry point (runSetup) (209 L)            |
| **CI Config**  | `ci-config.ts`         | CI config assembly + Systematic plugin injection (43 L) |
| **MCP (V2)**   | `mcp-servers-v2.ts`    | Parses, validates and filters caller `opencode-config` `mcp` servers for `buildCIConfigV2` |
| **Systematic** | `systematic-config.ts` | Systematic config writer (deep-merge) (36 L)            |
| **Reuse guard**| `no-task-reuse-config.ts` | Writes the task-reuse guard plugin; builds its `file://` spec and the server config that carries it |
| **Adapters**   | `adapters.ts`          | Exec/tool-cache adapter factories (20 L)                |
| **OpenCode**   | `opencode.ts`          | CLI resolution & installation (169 L)                   |
| **Deep merge** | `deep-merge.ts`        | Plain-object deep merge used for Systematic config      |
| **GH Auth**    | `gh-auth.ts`           | gh CLI auth & Git user identity (101 L)                 |
| **Auth JSON**  | `auth-json.ts`         | Temporary auth.json generation (70 L)                   |
| **Project ID** | `project-id.ts`        | Deterministic project ID generation (121 L)             |
| **Cache**      | `tools-cache.ts`       | Low-level tool cache operations (142 L)                 |
| **Types**      | `types.ts`             | Setup-specific types & interfaces (152 L)               |

## CODE MAP

| Symbol                  | Type     | Location                  | Role                          |
| ----------------------- | -------- | ------------------------- | ----------------------------- |
| `runSetup`              | Function | `setup.ts:22`             | Main orchestration            |
| `buildCIConfig`         | Function | `ci-config.ts:8`          | Build OPENCODE_CONFIG_CONTENT |
| `writeSystematicConfig` | Function | `systematic-config.ts:12` | Write merged systematic.json  |
| `installOpenCode`       | Function | `opencode.ts:87`          | CLI install + cache           |
| `configureGhAuth`       | Function | `gh-auth.ts:7`            | CLI authentication            |
| `populateAuthJson`      | Function | `auth-json.ts:41`         | Secure credentials write      |
| `ensureProjectId`       | Function | `project-id.ts:35`        | Deterministic ID for OpenCode |

## PATTERNS

- **Tool Cache**: `tc.downloadTool` → `tc.extract` → `tc.cacheDir`.
- **Platform Gate**: `getPlatformInfo()` maps OS/Arch to release assets, and rejects anything outside linux/darwin × x64/arm64 by name. It is the first thing `installOpenCode` calls, before the tool-cache lookup and outside the stock-fallback `try`, so an unsupported platform fails as itself rather than as a download 404 or a binary that cannot execute.
- **Graceful Fail**: Optional components (Systematic config) warn on error, don't crash.
- **Default Version**: `latest` (and an empty input) resolves to the recorded stock V2 pin in `opencode-v2-pin.json` with no network lookup (`resolveRequestedVersion`). There is no fallback: a failed V1 install (stock or harness) throws naming the requested version and is never retried as V2, a failed pin install throws, and a V2 version with no recorded digest fails in `runSetup` before install. A V1 harness build or stock V1 version still installs when pinned explicitly.
- **Verification**: Validates binaries (`--version`) BEFORE caching.
- **Systematic Bundling**: `buildCIConfig()` ensures `@fro.bot/systematic@<version>` exists in OpenCode CI plugins.
- **Task-reuse guard (fail-closed)**: `writeNoTaskReuseFile` copies `dist/no-task-reuse.js` (built from `deploy/plugins/no-task-reuse.mjs`, the same file the gateway image bakes) to `<configDir>/fro-bot/no-task-reuse.mjs`, and `taskReuseGuardServerConfig` builds `{plugin: [file:// URL]}`. Both are used by the Action's server-start choke point (`bootstrapOpenCodeServer`, `src/features/agent/server-adapter.ts`), NOT by setup or `buildCIConfig`: the guard rides the SDK's `OPENCODE_CONFIG_CONTENT` layer, which loads after every user/project/global file and cannot be dropped by them, so no user config file is read or edited and setup never lists the guard (one channel; a preinstalled OpenCode that skips setup is guarded too). It rejects any `task` call with a truthy `task_id`, so a background dispatch can never reuse a settled child session (#1757). If the file cannot be written, no server starts. Keep the file out of `<configDir>/plugin(s)/` (OpenCode auto-scans those). `<configDir>` is `$XDG_CONFIG_HOME/opencode` (else `~/.config/opencode`), the directory the server reads. Boundary on model behavior, not a sandbox: earlier-layer plugins still load before it, and `OPENCODE_PURE` would skip it (denied by `filterAgentEnv`; setup warns).

## SECURITY

- **Permissions**: `auth.json` written with `0o600` (owner-only).
- **Bundled skills directory (#2009)**: the build agent's `external_directory` is `'*': deny` plus the response and attachment dirs, which shadows the allow OpenCode adds for each skill directory (last matching rule wins). Setup re-allows exactly the installed `@fro.bot/systematic@<version>/node_modules/@fro.bot/systematic/skills/*` after the deny, in the build block and the global block (`ci-config.ts`; V1 resolves it after the Systematic install, from `XDG_CACHE_HOME` else `~/.cache`; V2 resolves the newest generation directory in `opencode/npm/<spec>/`, `v2-server.ts`). Not the package, not the cache, not another version, and nothing for `@fro.bot/opencode-plugin` (it ships no skills). Only a spelling ending in `/@fro.bot/systematic/skills` is granted (a symlink to `/` or `/tmp` would otherwise widen the grant to the filesystem): others are dropped with a path-free warning, in the shared resolver for V1, V2 and the workspace. Unresolved: warn and add nothing. `external_directory` is **not read-only**: the agent can also write inside that directory during its run. The `edit` permission is denied for it (V1: one pattern, `*/@fro.bot/systematic/skills/*`, because edit, write and apply_patch ask with a worktree-relative path whose shared prefix with the directory varies, so only the tail is stable; V2: the absolute `<dir>/*` per granted spelling), but `bash` is not an `edit` request, so a shell write still lands. On a hosted runner the tools cache is saved during setup, before the agent runs, so that write does not persist; a persistent or self-hosted runner keeps it. A `systematic` plugin entry in the operator's `opencode-config` at a version other than `systematic-version` gets no allow.
- **Repo skills (V2, #2129)**: opt-in `repo-skills` input (default `false`). `OPENCODE_DISABLE_PROJECT_CONFIG=1` stays; the checkout is **never** a source. After routing, `evaluateRepoSkillsTrust` (`src/features/agent/repo-skills-trust.ts`, an allow list that is NOT the credential disposition) admits `schedule`/`workflow_dispatch`, and `pull_request`/`issue_comment`/`issues` only from an `OWNER`/`MEMBER`/`COLLABORATOR` and, for PR-scoped events, only when `head.repo.full_name` equals the run's repository (`NormalizedPullRequestEvent.headRepoFullName`; for a comment on a PR, one `pulls.get`). Missing association or head repo, forks (including a maintainer commenting on one), review comments, discussion comments and unknown events deny. Every eligible event reads the **default branch, fetched fresh on every run** (`stageDefaultBranchSkills`): `git fetch --depth=1` of the base repository's default branch (token in `GIT_CONFIG_*` env, never argv) into a private ref of a throwaway bare repository under the staging root, `git archive` of that commit, then the throwaway repository is deleted. It never runs git in the checkout and never reads a ref, config or shallow state there (a planted or stale `origin/<branch>`, `insteadOf`, or a dispatched branch cannot change what is read); every git/tar command is bounded; failure skips repo skills. Before `git archive` it lists the fetched ref's subtree (`git ls-tree -r -l -z -t`, output capped) and refuses a tree over the source budget — 1000 entries (files, symlinks and directories alike, rejected ones included), 5 MiB of blobs, 6 directories below a skill, or any submodule — so nothing oversized is extracted. The two GitHub lookups (`pulls.get`, `repos.get`) are bounded to 10 s each and skip repo skills on timeout. `admitRepoSkills` (`repo-skills.ts`) copies only `<id>/SKILL.md` directories into `<RUNNER_TEMP>/fro-bot-repo-skills-*/skills`, each through a sibling `scratch/` directory and a `rename` once complete (a failed copy, even with a failed cleanup, is never under `skills.paths`): any symlink or special file rejects the whole skill, bounded to 500 files and 5 MiB, directory names that collide with a bundled Systematic skill or an OpenCode built-in are skipped (stock OpenCode keys the registry by directory name and lets a `skills.paths` skill replace a bundled one; the frontmatter `name` is display text only and is not read), and it refuses everything when the bundled skills directory cannot be listed. An unreadable or vanishing file skips that skill; an error that escapes admission is caught in `startActionOpenCodeV2`, which discards the partial copy and starts without repo skills. The copy is named in `skills.paths` and gets the bundled-skills treatment (`external_directory` allow, `edit` deny, gate exception) via `repoSkillsDirectory`; the same `external_directory`-is-not-read-only note applies. `run.ts` removes the staging root in its `finally`, after `runCleanup` has stopped the server (warns if it cannot). Logs name skipped ids only. V1 is not extended.
- **Caller MCP servers (V2, #1931)**: `buildCIConfigV2` takes a required `credential` (`resolveResponseDelivery`) and passes the operator config through `applyOperatorMcpV2`. **Only static local servers run on `pull_request`, `issue_comment` and `issues`** (`withhold`): `mcp` is filtered server by server (both spellings, reusing `readMcpLayout`/`parseServer`), keeping a server only when its `type` is the literal `local`, it parses, and no `{file:`/`{env:` opening appears in its original definition or name at any depth. Every other server is dropped (remote, referenced, malformed, colliding tool prefix); the `mcp` key is removed when none is left; kept and dropped servers are logged by sanitized name, never a value. A literal `environment` is allowed, so a kept server's command and `environment` values reach a process the checkout controls: no secrets there. The filter exists because OpenCode substitutes `{file:}`/`{env:}` in `OPENCODE_CONFIG_CONTENT` as text before parsing (`core/src/config/variable.ts`), and the default agent already allows MCP tools (`build`/`general`/`plan` have `allow *`; `explore`/`title`/`summary` deny `*` and stay without them, so the Action adds no allow rule). A top-level key whose name carries a `{file:}` reference is removed on those runs (top-level only, not recursive). **`{env:}` is rejected outright on those runs**: `buildCIConfigV2` fails setup, first, if the operator's `opencode-config` (serialized, case-sensitive) contains `{env:` anywhere, because OpenCode splices env values into the config text raw and only escapes on a parse failure (`variable.ts:27-37`), so an attacker-influenced value (a branch name) could inject structure; the error names the rule and trigger, never a value, and the generated config (`{file:}` key files only) is not inspected. On provisioned runs `mcp` is validated (both spellings V2 2.2.5 reads, `mcp.<name>` and `mcp.servers.<name>`; the legacy schema and `mcp.timeout` in full, native-only fields pass through; a string holding a `{env:}`/`{file:}` reference skips our format checks, a referenced `type` parses as an `unresolved` server, and structure is still checked) and fails setup with a named error that carries no value; two servers that sanitize to one tool prefix (`mcpToolNamespace`) are rejected. The V1 path (`ci-config.ts`) passes `mcp` through unchanged and is deliberately not extended: V1 writes `opencode.json`, which the agent can read.
- **Plugin switches**: `OPENCODE_PURE` makes OpenCode skip every external plugin (the reuse guard and Systematic). `filterAgentEnv` denies it for the server child and setup warns when it is set; keep it in the deny-set.
- **Ephemeral**: Credentials never cached; fresh from secrets each run.
- **Identity**: Git user forced to `${bot}[bot]` for audit trails.
- **Isolation**: Binaries cached by version/arch to prevent pollution.

## ANTI-PATTERNS

- **Hardcoded versions**: Always use input or dynamic resolution.
- **Fatal optionality**: Don't crash on non-critical failures.
- **Global install**: Pollutes system paths; use tool-cache.
- **Log leaks**: Never print `auth.json` or tokens.

## COMMANDS

```bash
bun run test src/services/setup/   # Run setup-specific tests
```
