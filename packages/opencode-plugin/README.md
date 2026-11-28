# @fro.bot/opencode-plugin

Fro Bot's plugin for [OpenCode](https://opencode.ai) V2 (v2.2.0 and later in the 2.x line). It gives the agent two things:

- **Session history tools.** `session_list`, `session_read`, `session_search` and `session_info` read the sessions of the current workspace. `session_read` and `session_search` cover a session's active context window: the messages since its last compaction, plus the compaction summary. Todos come from the last completed `todowrite` call in that window.
- **A subagent resume guard.** A `subagent` call that carries a `sessionID` is rejected before it runs, with a fixed message that holds no ids, unless it resumes a child this run dispatched from the same session and the Action started the server.

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

The root span of every trace (a turn's `invoke_agent`, and the root of a late continuation trace) also carries `langfuse.trace.name` set to the fixed string `fro-bot run`, which Langfuse shows as the trace's name. No other span has it, and it holds no content.

### What a trace contains

Spans follow the OpenTelemetry GenAI conventions at the revision named in `genai-attributes.ts`: `invoke_agent <agent>` for a turn (or plain `invoke_agent` when no agent name is known), `chat <model>` for a model request, and `execute_tool <tool>` for a tool call. Identity and markers outside the conventions use the `fro_bot.` prefix. A field the plugin could not capture is left out and named in `fro_bot.span.gaps`; it is never filled with a guess. Every string is scrubbed before it leaves the process, the ones below included.

**Resource.** `service.name` is `fro-bot-opencode-plugin`. `service.version` is the plugin's own version, read when tracing starts from the `package.json` beside the built files (the release job writes the version there after the build, so it cannot be baked in at build time). `langfuse.release` carries the same value on the resource: Langfuse reads a release per observation, from the span and then the resource, so every span, root or child, has it, and no span sets it itself (`service.version` feeds Langfuse's separate `version` field). `fro_bot.opencode.version` is the host's OpenCode version (`Plugin.Context.app.version`). Each is left off when it cannot be read, is not a short version-like string, or the scrub would change it. None is ever sent altered.

**On every span.**

- `langfuse.observation.type`: set explicitly, so Langfuse does not depend on mapping the operation name: `generation` on a model request, `agent` on `invoke_agent` and `tool` on a tool call.
- `fro_bot.outcome`: how the span ended. `ok`, `error` or `interrupted`. The Action's own lifecycle trace (`action.main` and its phases, exported by the Action, not by this plugin) also uses the attribute name `fro_bot.outcome`, with a different set of values: `succeeded`, `incomplete`, `failed`, `skipped` or `cancelled` (`src/shared/lifecycle-tracer.ts`), with `fro_bot.reason` for a stable reason code. A query on `fro_bot.outcome` must say which sender it means, by `service.name`.
- In an Action run, `cicd.pipeline.run.id` (the run id, the same value as `langfuse.trace.metadata.run_id`) and, when the launcher carried `serverUrl`, `cicd.pipeline.run.url.full`. The URL is GitHub's own form: `<server>/<owner>/<repo>/actions/runs/<run id>` for the first attempt (the API's `html_url` for attempt 1 has no `/attempts/` part) and `<server>/<owner>/<repo>/actions/runs/<run id>/attempts/<attempt>` for a re-run. It is left off when the repository, run id or attempt is not a plain `owner/repo` slug and digits, so a URL is never guessed. The `cicd.*` attributes belong to the core OpenTelemetry conventions (release-candidate stability), not to the GenAI revision the plugin pins.

**Model requests (`chat`).**

- `fro_bot.request.kind`: `primary`, `title`, `compaction` or `generate`. A title or compaction request carries **no** `gen_ai.agent.name`: it is the framework's own request, and a framework constant is not an agent name. `fro_bot.request.kind` says what it is.
- `fro_bot.tool_definitions.count` and `fro_bot.tool_definitions.chars`: how many tools the request offered, and the serialized length in characters of the definitions the plugin captured (`gen_ai.tool.definitions` before any bound or scrub; 0 when none were offered). They describe what the plugin captured, not what the provider billed: the capture keeps a tool's name, description and input schema. Both are computed once per request and left off when the request's tool list was not captured.
- `fro_bot.usage.cost_usd`: the cost OpenCode reported, in USD, as a number. `langfuse.observation.cost_details` is the same cost as the JSON string `{"total": <usd>}`, which Langfuse uses **instead of** the cost it works out from usage and its price list. It is set only for a positive cost: OpenCode reports 0 for a model it has no price for, so a zero would switch off Langfuse's own estimate. It is left off when the cost is unknown or zero.

**Tool calls (`execute_tool`).**

- `fro_bot.tool.outcome`: `success` (the tool ran and returned), `error` (it failed, or OpenCode refused the call), `rejected` (a permission rule or this plugin's subagent resume guard refused it before it ran: `error.type` is `permission.rejected` or `plugin.reuse-guard`) or `interrupted` (the turn was aborted while it ran).
- `fro_bot.tool.offered`: `true` when the called name was in the tool list of the request that asked for the call, `false` when it was not. This covers OpenCode's two refusals (`Tool is not available for this request: <name>` and `No tool named "<name>" is currently available`) and a real tool that ran and failed. It is compared with the list the plugin captured when the request hook fired, not with the failure message. It is **left off** when the plugin cannot say: the call names no step, the step could not be matched to a request, an event was lost, the request's tool list was not captured or is incomplete (the snapshot left out an entry or cut the list at its bound), the provider ran the tool, or the tool's name is unknown. Unset means unknown, never `false`. A name that is not in the list but ran anyway (OpenCode runs a tool the request only offered inside Code Mode when it offered `execute`) is `false`.
- `gen_ai.agent.name`: the agent the `execute.before` hook reported, else the agent of the session that owns the call, so a call refused before any hook still names its agent.

**Joining a turn to its Action run.** The Action's launcher document (`OPENCODE_FROBOT_TRACING`) may carry four optional fields. The plugin accepts the document with or without them, refuses any other key, and turns tracing off, with a fixed reason and no value in the log line (`launcher-run-invalid`), when a field it carries is malformed:

- `sessionId`: the telemetry session the Action computed, `<owner>/<repo>:<logical key>`: 1 to 200 characters, no control characters. The plugin sets `langfuse.session.id` to it **verbatim** on every span, and never derives or alters it. Every exported string is scrubbed, so a session id the scrub would change or withhold (a repository named `password-manager` reads as a name and a value) is never exported redacted, which would merge conversations into one session: that span falls back to the OpenCode root session instead. The Action avoids the fallback by passing the id through `scrubSafeSessionId` (`@fro-bot/runtime/tracing/session-id`) first, which returns the id as is when the scrub leaves it alone, else `sha256:` and 32 hex characters of its SHA-256, else none. Without it, and in every local session, `langfuse.session.id` stays the OpenCode root session as described above. **Upgrading:** turns exported before the Action sent a `sessionId` stay in Langfuse under the OpenCode root session id, and new Action turns use the qualified conversation key, so one conversation shows as two sessions across the upgrade. Every span of both kinds carries `fro_bot.root_session.id` (the OpenCode root session id, whatever `langfuse.session.id` is), so a dashboard or a query can still join the old and the new turns of a conversation on it. `session.id` and `gen_ai.conversation.id` keep each span's own OpenCode session either way.
- `invocationId`: a 1 to 200 character id for the Action step that started the server, with no control characters. Every span carries it as `fro_bot.invocation.id`, mirrored to `langfuse.trace.metadata.invocation_id`. It tells apart two steps of one job, which share `run_id`, `run_attempt` and `job`.
- `rootSpan`: `{"traceId": "<32 hex>", "spanId": "<16 hex>"}`, the run's root span. Lower-case hex only, neither id all zero, no other key. Each turn's root span (the `invoke_agent` span of the turn's root session, standalone compaction turns included) carries one OpenTelemetry **link** to it and no link attributes. Tempo follows links; Langfuse ignores them. The turn stays a trace of its own: nothing is re-parented.
- `serverUrl`: the GitHub server's origin, `GITHUB_SERVER_URL`, for example `https://github.com` or `https://ghe.example.com:8443`. It must be exactly an `https` origin (a host and an optional port, with at most one trailing slash), written the way a URL parser writes it back: a path, query, fragment, credentials, an upper-case host, a spelled-out default port or a non-ASCII host make the plugin refuse the document (`launcher-run-invalid`). It is at most 200 characters. The plugin builds each span's `cicd.pipeline.run.url.full` from it (see below), and sets no URL when the field is absent. **A plugin release older than this field refuses a document that carries it**, because it refuses every key it does not know and turns tracing off. The Action must therefore send `serverUrl` only to a plugin version that reads it.

The plugin refuses a launcher document over 4,096 characters, counted on the serialized value. Fields at their 200-character limits fit when they are ordinary text, but escapes make a document longer than its fields (a lone surrogate is six characters), so the Action's writer measures the serialized value and writes the tracing-off document instead of one the plugin would refuse.

The plugin refuses the file, logging one line with a fixed reason and no values, unless it is a regular file you own, private to you (mode `0600`: **no** read, write or execute bit set for group or others, since it can hold a collector credential), under 16 KiB, and not inside the project directory. It is not read on Windows. When tracing turns on, the plugin logs the collector's host name once.

**This file is consent for the whole machine, under your account.** The plugin cannot tell your OpenCode processes apart. Any OpenCode you run here with no launcher variable and no headless marker exports its traces to the collector in this file. That includes the interactive app (also with `--standalone`, which runs a private `serve --stdio` backend), `opencode run`, an `opencode serve` you start by hand, the background service the interactive app connects to, and an editor integration or script that starts OpenCode for you. It also includes other programs on this machine that embed OpenCode with `serve --stdio` (an SDK client, for one): they trace under your file unless they pass `OPENCODE_CONFIG_CONTENT`. The command line does not matter, only the launcher variable and the headless markers. Name only machines you want traced, and delete the file to turn tracing off everywhere.

`opencode run` and the interactive app with `--standalone` start a private `serve --stdio` server unless a background service is already running. That server traces under a valid file like any other local session. The Fro Bot Action, workspace agent and gateway always set the launcher variable, so this file never applies to them.

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
