---
title: An isolated agent needs the runner's environment rebuilt for its own user before real workflows run
date: 2026-11-17
category: best-practices
module: agent-execution
problem_type: best_practice
component: infrastructure
severity: medium
applies_when:
  - A caller workflow starts to run its agent under the isolate-agent input
  - A tool works for the runner but not for the isolated agent
  - A new tool, cache location or state directory has to be usable by the isolated agent
symptoms:
  - A missing command fails with EACCES or exit 126 instead of ENOENT or exit 127
  - opencode is not on PATH, from a skill that runs opencode --version
  - "Failed to create socket directory: Permission denied, from a tool that uses XDG_RUNTIME_DIR"
  - git reports dubious ownership for the checkout or for a repository cloned under it
  - gh works but a plain git push has no credential
tags:
  - isolate-agent
  - sandbox
  - path
  - eacces
  - xdg
  - safe-directory
  - credential-helper
  - runner-home
---

# An isolated agent needs the runner's environment rebuilt for its own user before real workflows run

## Context

Under `isolate-agent` the agent is a different user in a read-only view. It inherits an allowlisted environment (`packages/runtime/src/agent/filter-env.ts`), cannot enter the runner's mode-750 home, and cannot write the runner's directories. The isolation held, and working caller workflows then broke in ordinary ways, one at a time. Each looked like a broken tool, not like an isolation error.

Almost all of the fixes are in the launch environment that `createSandboxLifecycle` builds in `src/harness/phases/sandbox-lifecycle.ts`.

## Guidance

**1. Mirror the runner's `PATH`, then check it as the agent.**

- Capture `process.env.PATH` before setup's `core.addPath`, so the Action's own directories cannot shadow tools from earlier steps (`runBootstrap` in `src/harness/phases/bootstrap.ts`).
- `buildSandboxPath` in `src/services/setup/sandbox-toolchain-path.ts` keeps absolute existing directories in runner order, then the system directories, and puts the Action's OpenCode directory last. When the `opencode` CLI guard's probe passes, the launch puts the guard's directory first (`src/harness/phases/sandbox-lifecycle.ts:1221`). If the probe fails without timing out, the sandbox starts with the original PATH, so a successful launch doesn't prove the guard is active. The guard keeps the agent's shell from starting a second server; see [the agent's opencode CLI can start a second OpenCode server](../integration-issues/agent-opencode-cli-autospawns-second-server-2026-11-27.md).
- After the handoff, one shell run as the agent, with the candidate directories as its arguments, keeps only the entries it can enter:

  ```sh
  sh -c 'for d do if [ -d "$d" ] && [ -x "$d" ]; then printf "%s\n" "$d"; fi; done' sh /first/candidate /second/candidate
  ```

  An entry it cannot enter (`~/.cargo/bin`, `~/.dotnet/tools`) makes a missing command fail with EACCES and exit 126, where tests expect ENOENT and 127.

**2. Tools under the runner home get a narrow read grant.** `resolveToolRoots` in `src/services/setup/sandbox-tool-roots.ts` grants read and execute on `~/.bun` and `~/setup-pnpm` only, and only when the root is a plain runner-owned directory with a `PATH` directory inside it. The home itself gets traverse only. Never open the home.

**3. Give the agent its own XDG roots.** The agent gets `~/.local/share`, `~/.config`, `~/.cache`, `~/.local/state` and `~/.run` (as `XDG_RUNTIME_DIR`) in its own home. The `opencode` entry in each of the first four links to the handed-over runner directory, so session state still lands where the Action saves it. Every other tool's caches and state stay in the agent's home.

**4. Pass tool locations only when the agent can use them.** `PLAYWRIGHT_BROWSERS_PATH`, `UV_PYTHON_INSTALL_DIR` and `MISE_DATA_DIR` (`TOOL_LOCATION_VARIABLES`) reach the agent only when the resolved directory is visible in the view and the agent can enter it. Callers should install these into the hosted tool cache, not `RUNNER_TEMP` or the home. A dropped location is logged.

**5. git needs its own trust and its own credential.**

- `safe.directory` for the checkout and for `<checkout>/*` goes into the agent's `~/.gitconfig` and into `GIT_CONFIG_*` environment variables. The environment copy matters because test helpers set `GIT_CONFIG_NOSYSTEM=1` and `GIT_CONFIG_GLOBAL=/dev/null`. The `/*` form needs git 2.45.3 or later.
- When the agent is provisioned a token, a per-origin helper is written with an empty value first to clear outer helpers:

  ```ts
  await set(helperKey, '')
  await set(helperKey, `!${tools.gh} auth git-credential`)
  ```

  `persist-credentials: false` stays required on the checkout.

**6. State kept in the checkout needs `agent-state-home`.** A caller whose tool keeps state under the checkout and refuses a directory it does not own names that directory in the input. The Action hands it over, points the agent's `XDG_STATE_HOME` at it, and takes it back.

**7. Create the account without a home.** `createSandboxAccount` in `packages/runtime/src/agent/sandbox-identity.ts` uses `useradd --no-create-home` and makes the home itself. Hosted images carry about 833 MB in `/etc/skel`, and `--create-home` copies all of it on every run.

What didn't work:

- **An unfiltered `PATH` mirror.** It kept the unreachable runner-home entries.
- **Per-tool cache variables** (`UV_CACHE_DIR`, `PIP_CACHE_DIR`, pnpm's `npm_config_*`). They cover only the tools someone listed. Agent-owned XDG roots replaced them; only `BUN_INSTALL_CACHE_DIR` stayed, because bun does not follow XDG.
- **Pointing the agent's `XDG_*` at the runner's directories.** The agent could write only their `opencode` subdirectories, and pnpm does not fall back.

## Why This Matters

Each gap surfaced as a false failure in a real workflow. Fixing them tool by tool does not scale; rebuilding the environment classes (PATH, XDG, git trust, credentials, state) does. None of the gaps showed in the Action's own suite until a real caller ran.

## When to Apply

- When enabling `isolate-agent` for a new caller.
- When adding another environment variable, tool root or state directory for the agent. Check it as the agent, not as the runner.

## Examples

A caller that needs Playwright browsers and a uv-managed Python under isolation installs both into the tool cache:

```yaml
env:
  PLAYWRIGHT_BROWSERS_PATH: ${{ runner.tool_cache }}/ms-playwright
  UV_PYTHON_INSTALL_DIR: ${{ runner.tool_cache }}/uv-python
```

## Related

- [An injected permission deny blocked the harness's own response-file delivery path](../logic-errors/injected-deny-blocks-own-delivery-path-2026-07-13.md): a restriction that blocked something the agent needed, fixed with a narrow exception.
- [Harness git calls depended on ambient developer identity](../logic-errors/harness-git-calls-depended-on-ambient-developer-identity-2026-08-14.md): subprocesses must not assume ambient configuration.
- [The OpenCode server bootstraps from the process working directory](../integration-issues/opencode-server-boots-from-cwd-not-session-directory-2026-08-07.md): another environment fact that isolated `HOME` and `XDG_*` did not cover.
- [Prove an Action change on the published install with a real caller](../workflow-issues/published-install-live-check-before-rollout-2026-11-17.md): how these gaps were found.
