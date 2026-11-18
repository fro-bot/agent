---
title: Keep provider API keys out of the agent sandbox with a local key-injecting proxy
date: 2026-11-17
category: best-practices
module: agent-execution
problem_type: architecture_pattern
component: authentication
severity: high
applies_when:
  - An agent and its tools run as a separate user but the server must still read a provider key
  - A model-visible tool, such as an in-process file read, can reach any file the server user owns
  - A provider key has no per-route scoping, so a leaked key can be spent anywhere until rotated
  - Operator config can set a provider endpoint or carry a literal key
tags:
  - key-proxy
  - isolate-agent
  - provider-keys
  - credential-isolation
  - prompt-injection
  - loopback-proxy
  - sandbox
  - auth-json
---

# Keep provider API keys out of the agent sandbox with a local key-injecting proxy

## Context

`isolate-agent` runs the OpenCode server and every tool it starts as one throwaway user. That alone does not hide a provider API key. The server has to read each `auth-json` key, so the key sat in a `0600` file owned by that user. A shell and the server's in-process `read` tool both run as that user, so the model could read the file. A gateway key with no per-route scoping can then be spent anywhere until it is rotated, and prompt injection through issue, PR and comment text is the realistic way to get a model to leak one.

Another user or another file mode does not fix this. The agent needs authenticated access to the provider. It does not need the key.

## Guidance

1. **Never write the real key where the agent can read it.** A separate child process holds the keys. `startKeyProxyProcess` in `src/harness/phases/key-proxy-process.ts` spawns it as the runner with an empty environment, `cwd: '/'` and its stderr ignored. The keys arrive as one framed config on stdin. The child binds `127.0.0.1` on an ephemeral port and prints one ready line. The agent's server gets a loopback base URL per provider.
2. **Forward a fixed route table and nothing else.** `packages/runtime/src/agent/key-proxy-routes.ts` lists the Anthropic Messages, OpenAI Responses and OpenAI Chat routes, plus each provider's models route. Matching is on the exact method, path and raw query. Anything else is answered locally.
3. **Ignore client credentials.** Only an allowlist of client headers is copied, and the real key is set last (`x-api-key` for Anthropic routes, `Bearer` for OpenAI routes). The proxy does not check a placeholder credential. Nothing the client sends as a credential is forwarded, so a check would guard nothing.
4. **Use `https.request`, not `fetch`.** undici keeps custom auth headers across a cross-origin redirect. A 3xx gets a local 502 and is never followed. An upstream 101 arrives on the `upgrade` event, not `response`; it gets the same 502.
5. **Make error bodies redactable.** Always send `accept-encoding: identity` upstream, so an error body can be read and every raw and JSON-escaped occurrence of the key replaced. A compressed or oversized error body becomes a fixed generic error. Success responses pass a short fixed list of headers.
6. **Attach the socket error handler before rejecting CONNECT and Upgrade.** Node detaches its own handler before those events fire, so a client reset on a rejected socket is otherwise an uncaught exception that kills the proxy. Destroy rejected sockets after a short linger so a half-open client cannot hold a connection slot.
7. **Validate config by structure, not by a list of field names.** The provider's own base URL is the one endpoint setting that is accepted: the resolver validates it and uses it as the proxy's upstream, so the operator-selected upstream must be trusted with the real key. `findProviderBypass` in `src/services/setup/key-proxy-providers.ts` refuses every other endpoint or query override (`baseURL`, `endpoint`, `api`, `queryParams`) in nested scopes such as models and variants, which would route requests around the proxy. `checkConfigForKeys` scans the final config text for every `auth-json` key value, raw and JSON-escaped, before the agent sees it. Credentials are not judged by field name.
8. **Fail on 401 only at start-up.** `probeKeyProxy` in `src/harness/phases/key-proxy-probe.ts` does one bounded GET on the selected provider's models route. A 401 fails the run. A 403 only warns, because it can be a scope, project or organisation limit on that one route.

What didn't work:

- **A walk over provider config that refused known credential and endpoint fields.** Each new place a literal key could sit (native and legacy shapes, models, variants, settings objects) needed another rule, and a harmless field named `token` was refused. The two structural rules above replaced it.
- **Checking the placeholder in the proxy.** A model-level `apiKey` override reached the proxy with a different credential and got a local 401, while the start-up probe, which sends the placeholder, passed.
- **Failing the run on 403.** It blocked providers that restrict the models route.

## Why This Matters

A file the agent's user can read is a file the model can read, so a uid boundary is not a secrecy boundary. With the proxy, no copy of the key exists in the agent's files, environment or arguments.

What the agent can still reach is stated, not hidden: model spend through the proxy during the run, and any credential a trigger provisions on purpose. The proxy is not an egress control, and it trusts the upstream not to echo the key in a successful response. A literal secret that an operator puts in `opencode-config` under a name the scan does not know is not hidden by isolation.

## When to Apply

- When an untrusted-input agent must call an authenticated API and a separate process can hold the secret.
- When the provider operations are known. An exact-match route table fails closed on any new route, method or query string a provider SDK starts to use, so someone has to update and test it with provider and SDK changes. It is the wrong design for arbitrary or fast-changing API access.
- When adding a provider or a route, or touching `opencode-config` handling under `isolate-agent`.

## Examples

The real credential goes on last, so nothing copied from the client can override it (`packages/runtime/src/agent/key-proxy.ts`):

```ts
headers["accept-encoding"] = "identity"
if (matched.route.auth === "x-api-key") {
  headers["x-api-key"] = matched.provider.key
  headers["anthropic-version"] ??= "2023-06-01"
} else {
  headers.authorization = `Bearer ${matched.provider.key}`
}
```

A good run logs `Key proxy started`, `Key proxy probe passed` and, at the end, `Key proxy stopped` with `exitConfirmed: true`.

## Related

- [Isolate a CI credential via an OIDC broker](../workflow-issues/isolate-ci-credential-via-oidc-broker-2026-07-01.md): credential minimization, for a child that must hold a credential. The proxy is the other option, for a child that needs authenticated access but not the key.
- [Sequential steps in one GitHub Actions job are not a security boundary](./same-job-phase-split-not-a-security-boundary-2026-07-04.md): why file modes and step order do not isolate credentials.
- [Workspace OpenCode provisioning on V2](./workspace-opencode-provisioning-on-v2-2026-11-17.md): the workspace container's key path, where tools run as the server's user and can read the spawn database that holds the key.
