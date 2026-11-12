# SETUP MODULE

**Location:** `src/services/setup/`

Environment bootstrap logic: OpenCode CLI (stock V2, digest-pinned) and plugin installation. Manages Git identity, gh CLI authentication and tool cache persistence.

## WHERE TO LOOK

| Component      | File                   | Responsibility                                          |
| -------------- | ---------------------- | ------------------------------------------------------- |
| **Setup**      | `setup.ts`             | Orchestration entry point (runSetup) (209 L)            |
| **CI Config**  | `ci-config-v2.ts`      | `buildCIConfigV2`: the server config passed at start, never written to disk |
| **MCP (V2)**   | `mcp-servers-v2.ts`    | Parses, validates and filters caller `opencode-config` `mcp` servers for `buildCIConfigV2` |
| **Systematic** | `systematic-config.ts` | Systematic config writer (deep-merge) (36 L)            |
| **Adapters**   | `adapters.ts`          | Exec/tool-cache adapter factories (20 L)                |
| **OpenCode**   | `opencode.ts`          | CLI resolution & installation (169 L)                   |
| **Deep merge** | `deep-merge.ts`        | Plain-object deep merge used for Systematic config      |
| **GH Auth**    | `gh-auth.ts`           | gh CLI auth & Git user identity (101 L)                 |
| **Auth JSON**  | `auth-json.ts`         | `parseAuthJsonInput` (parse only; V2 never writes `auth.json`) |
| **Project ID** | `project-id.ts`        | Deterministic project ID generation (121 L)             |
| **Cache**      | `tools-cache.ts`       | Low-level tool cache operations (142 L)                 |
| **Types**      | `types.ts`             | Setup-specific types & interfaces (152 L)               |

## CODE MAP

| Symbol                  | Type     | Location                  | Role                          |
| ----------------------- | -------- | ------------------------- | ----------------------------- |
| `runSetup`              | Function | `setup.ts:22`             | Main orchestration            |
| `buildCIConfigV2`       | Function | `ci-config-v2.ts`         | Build the server config       |
| `writeSystematicConfig` | Function | `systematic-config.ts:12` | Write merged systematic.json  |
| `installOpenCode`       | Function | `opencode.ts:87`          | CLI install + cache           |
| `configureGhAuth`       | Function | `gh-auth.ts:7`            | CLI authentication            |
| `ensureProjectId`       | Function | `project-id.ts:35`        | Deterministic ID for OpenCode |

## PATTERNS

- **Tool Cache**: `tc.downloadTool` → `tc.extract` → `tc.cacheDir`.
- **Platform Gate**: `getPlatformInfo()` maps OS/Arch to release assets, and rejects anything outside linux/darwin × x64/arm64 by name. It is the first thing `installOpenCode` calls, before the tool-cache lookup, so an unsupported host fails with a platform error rather than a missing-asset one.
- **Graceful Fail**: Optional components (Systematic config) warn on error, don't crash.
- **Default Version**: `latest` (and an empty input) resolves to the recorded stock V2 pin in `opencode-v2-pin.json` with no network lookup (`resolveRequestedVersion`). `resolveStockV2Policy` accepts only that pin and runs before any cache lookup or download. A V1 value never gets this far: `parseOpenCodeVersion` (`src/harness/config/inputs.ts`) rejects it at input parsing. There is no fallback: a failed install throws.
- **Verification**: Validates binaries (`--version`) BEFORE caching.
- **Plugin install**: `installPluginsV2` installs `@fro.bot/systematic` and `@fro.bot/opencode-plugin` at exact versions before the server starts.

## SECURITY

- **No credentials on disk at setup**: `auth.json` is never written. Provider keys become `0600` key files referenced from the config at spawn time.
- **Agent UID isolation (V2, #2135)**: opt-in `isolate-agent` input (default `false`). `sandbox-preflight.ts` fails the run before setup unless the runner is GitHub-hosted Linux with passwordless sudo and the required tools (`runSandboxPreflight`); `sandbox-handoff.ts` (`handOff`/`takeBack`) grants the sandbox user ACLs on a minimal path set and takes ownership back after the stop. The lifecycle and ordering live in `src/harness/phases/sandbox-lifecycle.ts`; the provider key and server password stay readable by the agent (Phase 4). `bootstrap` returns `sandboxTools` (null when off).
- **Repo skills (V2, #2129)**: opt-in `repo-skills` input (default `false`). `OPENCODE_DISABLE_PROJECT_CONFIG=1` stays; the checkout is **never** a source. After routing, `evaluateRepoSkillsTrust` (`src/features/agent/repo-skills-trust.ts`, an allow list that is NOT the credential disposition) admits `schedule`/`workflow_dispatch`, and `pull_request`/`issue_comment`/`issues` only from an `OWNER`/`MEMBER`/`COLLABORATOR` and, for PR-scoped events, only when `head.repo.full_name` equals the run's repository (`NormalizedPullRequestEvent.headRepoFullName`; for a comment on a PR, one `pulls.get`). Missing association or head repo, forks (including a maintainer commenting on one), review comments, discussion comments and unknown events deny. Every eligible event reads the **default branch, fetched fresh on every run** (`stageDefaultBranchSkills`): `git fetch --depth=1` of the base repository's default branch (token in `GIT_CONFIG_*` env, never argv) into a private ref of a throwaway bare repository under the staging root, its blobs written raw, then the throwaway repository is deleted. It never runs git in the checkout and never reads a ref, config or shallow state there (a planted or stale `origin/<branch>`, `insteadOf`, or a dispatched branch cannot change what is read); every git/tar command is bounded; failure skips repo skills. It lists the fetched ref's subtree first (`git ls-tree -r -l -z -t`, output capped) and refuses a tree over the source budget — 1000 entries (files, symlinks and directories alike, rejected ones included), 5 MiB of blobs, 6 directories below a skill, or any submodule — before writing anything. Blobs are then written **raw** from that same listing with `git cat-file --batch` (object ids on stdin, framing and sizes checked against the listing, a running byte counter, output capped): never `git archive`/`tar`, because archive honours committed `.gitattributes` (`export-subst`, `ident`, `eol`) and can expand a few KiB of blobs into megabytes past the budget. The `-z` listing is decoded from raw bytes with a strict UTF-8 decoder (two git names with different invalid bytes would otherwise collapse into one string through U+FFFD and alias), and the source is refused if any path is invalid UTF-8, appears twice (folded for case and Unicode normalization), or is both a file/symlink and the directory of another entry. **Symlinks (mode 120000) are never written to disk**: staging returns `symlinkedSkillIds` (the first path component of each) and admission rejects exactly those skills with the `symlink` reason, so no link exists for a later entry to be written through. Directories are made one segment at a time (`lstat` must show a real directory whose `realpath` is exactly where it should be under the extract root's realpath; no `recursive` mkdir across untrusted segments), files are created exclusively without following symlinks (0600, 0700 if executable), directories 0700, and paths are validated (no `..`, `.`, empty or absolute segments). The two GitHub lookups (`pulls.get`, `repos.get`) are bounded to 10 s each and skip repo skills on timeout. `admitRepoSkills` (`repo-skills.ts`) copies only `<id>/SKILL.md` directories into `<RUNNER_TEMP>/fro-bot-repo-skills-*/skills`, each through a sibling `scratch/` directory and a `rename` once complete (a failed copy, even with a failed cleanup, is never under `skills.paths`): any symlink or special file rejects the whole skill, bounded to 500 files and 5 MiB, directory names that collide with a bundled Systematic skill or an OpenCode built-in are skipped (stock OpenCode keys the registry by directory name and lets a `skills.paths` skill replace a bundled one; the frontmatter `name` is display text only and is not read), and it refuses everything when the bundled skills directory cannot be listed. An unreadable or vanishing file skips that skill; an error that escapes admission is caught in `startActionOpenCodeV2`, which discards the partial copy and starts without repo skills. The copy is named in `skills.paths` and gets the bundled-skills treatment (`external_directory` allow, `edit` deny, gate exception) via `repoSkillsDirectory`; the same `external_directory`-is-not-read-only note applies. `run.ts` removes the staging root in its `finally`, after `runCleanup` has stopped the server (warns if it cannot). Logs name skipped ids only. V1 is not extended.
- **Caller MCP servers (V2, #1931)**: `buildCIConfigV2` takes a required `credential` (`resolveResponseDelivery`) and passes the operator config through `applyOperatorMcpV2`. **Only static local servers run on `pull_request`, `issue_comment` and `issues`** (`withhold`): `mcp` is filtered server by server (both spellings, reusing `readMcpLayout`/`parseServer`), keeping a server only when its `type` is the literal `local`, it parses, and no `{file:`/`{env:` opening appears in its original definition or name at any depth. Every other server is dropped (remote, referenced, malformed, colliding tool prefix); the `mcp` key is removed when none is left; kept and dropped servers are logged by sanitized name, never a value. A literal `environment` is allowed, so a kept server's command and `environment` values reach a process the checkout controls: no secrets there. The filter exists because OpenCode substitutes `{file:}`/`{env:}` in `OPENCODE_CONFIG_CONTENT` as text before parsing (`core/src/config/variable.ts`), and the default agent already allows MCP tools (`build`/`general`/`plan` have `allow *`; `explore`/`title`/`summary` deny `*` and stay without them, so the Action adds no allow rule). A top-level key whose name carries a `{file:}` reference is removed on those runs (top-level only, not recursive). **`{env:}` is rejected outright on those runs**: `buildCIConfigV2` fails setup, first, if the operator's `opencode-config` (serialized, case-sensitive) contains `{env:` anywhere, because OpenCode splices env values into the config text raw and only escapes on a parse failure (`variable.ts:27-37`), so an attacker-influenced value (a branch name) could inject structure; the error names the rule and trigger, never a value, and the generated config (`{file:}` key files only) is not inspected. On provisioned runs `mcp` is validated (both spellings V2 2.2.5 reads, `mcp.<name>` and `mcp.servers.<name>`; the legacy schema and `mcp.timeout` in full, native-only fields pass through; a string holding a `{env:}`/`{file:}` reference skips our format checks, a referenced `type` parses as an `unresolved` server, and structure is still checked) and fails setup with a named error that carries no value; two servers that sanitize to one tool prefix (`mcpToolNamespace`) are rejected.
- **Plugin switches**: `OPENCODE_PURE` makes OpenCode skip every external plugin (Systematic and the fro.bot plugin). `filterAgentEnv` denies it for the server child and setup warns when it is set; keep it in the deny-set.
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
