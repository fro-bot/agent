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

## Tracing (opt-in, local sessions)

The plugin can export a trace of each turn (model requests, tool calls and subagents) to an OpenTelemetry collector you run. It is **off** unless you turn it on, and it only turns on in a local session: a headless server (`OPENCODE_PASSWORD` or `OPENCODE_CONFIG_CONTENT` set) stays off. Plugin options and project config are never read for tracing, so nothing in a checkout can switch it on.

To turn it on, create `~/.config/fro-bot/opencode-plugin/tracing.json` (under `$XDG_CONFIG_HOME` when that is set to an absolute path):

```json
{
  "version": 1,
  "endpoint": "https://collector.example.com/v1/traces",
  "headers": {"authorization": "Basic <credentials>"},
  "hosts": ["my-laptop"]
}
```

- `endpoint` is the full OTLP/HTTP traces URL. The plugin sends OTLP as **JSON over HTTP, uncompressed** (`Content-Type: application/json`, no `Content-Encoding`), so point it at a collector's OTLP/HTTP receiver that accepts JSON. A remote collector **must be `https`**, and the exporter verifies its certificate and sets that itself on every `https` export, so `NODE_TLS_REJECT_UNAUTHORIZED=0` in the environment does not turn it off (checked in Node and in the compiled OpenCode host): there is no switch to turn that off, and the exporter does not follow a redirect (a `3xx` counts as a failed batch), so the credential in `headers` goes only to the URL you wrote. Plain `http` is accepted only for a loopback IP address, so use `http://127.0.0.1:4318/v1/traces` or `http://[::1]:4318/v1/traces`: `http://localhost:…` is refused, because a name can resolve somewhere else.
- `headers` is optional, at most 16 entries. They carry your collector credential.
- `hosts` is **required**: one to 16 machine names, and tracing is on only on a machine named in it. A name matches the machine's host name exactly (ignoring case and a trailing dot), or, when it has no dot, the part of the host name before its first dot (`my-laptop` matches `my-laptop.local`). There are no wildcards. A copy of this file on any other machine does nothing there, silently.

Every span carries `langfuse.session.id` set to the **root** session's id, so Langfuse's Sessions view groups a subagent's spans with its parent's, while the standard `session.id` stays each span's own session. In the Action, each span also carries the run's repository, run id, attempt, job and trigger as `langfuse.trace.metadata.*` (`repository`, `run_id`, `run_attempt`, `job`, `trigger`), so Langfuse shows and filters by them; a local session has none of these.

The plugin refuses the file, logging one line with a fixed reason and no values, unless it is a regular file you own, private to you (mode `0600`: **no** read, write or execute bit set for group or others, since it can hold a collector credential), under 16 KiB, and not inside the project directory. It is not read on Windows. When tracing turns on, the plugin logs the collector's host name once.

**This file is consent for the whole machine, under your account.** The plugin cannot tell your OpenCode processes apart. Any OpenCode you run here with no launcher variable and no headless marker exports its traces to the collector in this file. That includes an `opencode serve` you start by hand, the background service the interactive app connects to, and an editor integration or script that starts OpenCode for you. The one exception is a server another program embeds with `opencode serve --stdio` (the SDK, the Fro Bot Action, the gateway): it stays off, because the plugin cannot see its password. Name only machines you want traced, and delete the file to turn tracing off everywhere.

**Matching steps to requests.** A model step is matched to its request by time, and the plugin stops matching for a session, until its execution ends, whenever it cannot tell the owner apart (an earlier request still has no step, a clock step-back, a lost event). The requests it could not match export no step data, an incomplete outcome and the gap `step-binding-uncertain`; a request that never gets a step (OpenCode abandoning it after an overflow or transport recovery) costs the rest of that execution's step data.

**Shutdown.** When the server stops, the plugin exports what it has within 3 seconds, then cancels the request that is in flight and counts what was not delivered as dropped. The SDK's retry wait is a timer the plugin cannot cancel, and it keeps a process alive that waits for its event loop to drain: after the plugin has finished, it can outlast it by up to the request timeout (10 seconds) if the collector sent a long `Retry-After`, and by about 1 to 5 seconds otherwise. Nothing is sent when it fires. OpenCode's own server does not wait for such a timer (it left about 3.3 seconds after stdin closed in every measured run, including against a collector that answers `503` with `Retry-After: 9`).

The credential in this file is readable by anything that runs as you, including a local agent. Spans carry prompts, tool arguments and tool results, scrubbed on a best-effort basis for known secret shapes; scrubbing does not find a secret that has no recognizable shape. When the plugin cannot tell where a secret-named value ends, it withholds that whole value (the span carries `[omitted]` and the reason `sensitive-value-unbounded`). OpenCode's own exporter is separate and is not affected.

## Develop

```sh
bun run --filter @fro.bot/opencode-plugin test        # unit tests
bun run --filter @fro.bot/opencode-plugin build       # bundle to dist/
```

`src/integration.test.ts` loads the built bundle into a real OpenCode binary. It is skipped unless `dist/index.mjs` exists and `FRO_BOT_OPENCODE_V2_BIN` points at an OpenCode v2.2.0 executable. Download the release asset for your platform, verify it against the release's `SHA256SUMS`, unpack it into a temporary directory, and delete it afterwards.

## Release

Dispatch `.github/workflows/opencode-plugin-release.yaml` with the version to publish. It publishes with npm trusted publishing (OIDC). See [`BOOTSTRAP.md`](BOOTSTRAP.md) for the one-time setup.
