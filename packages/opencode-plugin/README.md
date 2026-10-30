# @fro.bot/opencode-plugin

Fro Bot's plugin for [OpenCode](https://opencode.ai) V2 (v2.2.0 and later in the 2.x line). It gives the agent two things:

- **Session history tools.** `session_list`, `session_read`, `session_search` and `session_info` read the sessions of the current workspace. `session_read` and `session_search` cover a session's active context window: the messages since its last compaction, plus the compaction summary. Todos come from the last completed `todowrite` call in that window.
- **A subagent reuse guard.** A `subagent` call that carries a `sessionID` is rejected before it runs, with a fixed message that holds no ids. Every subagent starts a fresh child session.

The plugin id is `fro-bot.opencode-plugin`. OpenCode V2 skips a plugin that fails to load and keeps serving, so anything that depends on this plugin should check `GET /api/plugin` for that id with status `active`.

## Use

Install with an exact version, then list the package in the OpenCode config:

```sh
opencode plugin add @fro.bot/opencode-plugin@<version>
```

```json
{"plugins": ["@fro.bot/opencode-plugin@<version>"]}
```

`effect` and `@opencode/plugin` are peer dependencies. OpenCode supplies both at load time, so the bundle never carries its own copy.

## Develop

```sh
bun run --filter @fro.bot/opencode-plugin test        # unit tests
bun run --filter @fro.bot/opencode-plugin build       # bundle to dist/
```

`src/integration.test.ts` loads the built bundle into a real OpenCode binary. It is skipped unless `dist/index.mjs` exists and `FRO_BOT_OPENCODE_V2_BIN` points at an OpenCode v2.2.0 executable. Download the release asset for your platform, verify it against the release's `SHA256SUMS`, unpack it into a temporary directory, and delete it afterwards.

## Release

Dispatch `.github/workflows/opencode-plugin-release.yaml` with the version to publish. It publishes with npm trusted publishing (OIDC). See [`BOOTSTRAP.md`](BOOTSTRAP.md) for the one-time setup.
