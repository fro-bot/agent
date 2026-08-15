---
title: Cross-provider server-tool IDs break Anthropic session replay
date: 2026-08-14
category: integration-issues
module: agent-execution
problem_type: integration_issue
component: assistant
symptoms:
  - "Anthropic rejects the request with `server_tool_use.id: String should match pattern '^srvtoolu_[a-zA-Z0-9_]+$'`"
  - "Rewriting the IDs to the required prefix produces a different failure about a missing result block"
  - "A session that worked under one provider fails on replay after switching models"
root_cause: wrong_api
resolution_type: code_fix
severity: high
related_components:
  - runtime
  - agent-execution
tags:
  - anthropic
  - openai
  - provider-interop
  - tool-call-id
  - session-replay
  - server-tools
---

## Problem

A session whose history contains `web_search` parts written by an OpenAI model cannot be replayed to Anthropic. Anthropic rejects the request during validation, because those parts are translated into its server-tool wire format regardless of which provider produced them.

## Symptoms

```
messages.7283.content.0.server_tool_use.id:
  String should match pattern '^srvtoolu_[a-zA-Z0-9_]+$'
```

The failing parts were written by `openai/gpt-5.6-sol` with `ws_*` call IDs, in a session whose active model is `anthropic/claude-opus-5`.

## What Didn't Work

Rewriting the eight offending call IDs to `srvtoolu_*` satisfied the pattern and immediately failed differently: Anthropic expects a `server_tool_use` block to be paired with a matching `web_search_tool_result` block. Making the ID look native committed to a contract the stored history could not satisfy.

## Solution

Demote the parts to ordinary tool calls instead of trying to satisfy the server-tool contract. Two changes are required together:

- rewrite `callID` to an ordinary `toolu_*` value
- delete `metadata.providerExecuted`

Either alone is insufficient. The metadata flag is what routes the part down the server-tool path; the ID pattern is only the first thing that path validates.

The 1,961 OpenAI-style `call_*` IDs elsewhere in the same session needed no change. Anthropic accepts them as ordinary `tool_use.id` values. The problem is specific to provider-executed server tools, not to cross-provider IDs in general.

## Why This Works

The translation layer dispatches on **tool name**, not on originating provider:

```ts
const serverToolResultType = (name: string): AnthropicServerToolResultType | undefined => {
  if (name === "web_search") return "web_search_tool_result"
  if (name === "code_execution") return "code_execution_tool_result"
  if (name === "web_fetch") return "web_fetch_tool_result"
  return undefined
}
```

Any part named `web_search` is mapped onto Anthropic's `server_tool_use` / `web_search_tool_result` pair. Nothing in that decision consults which model actually produced the part, so a part authored by OpenAI's provider-executed search is replayed as though Anthropic had executed it — including the strict ID pattern and the paired-result requirement.

Removing `providerExecuted` takes the part off that path entirely. It then replays as a normal tool call with a normal tool result, which has no prefix constraint and no pairing requirement.

## Prevention

- Never infer provider compatibility from an ID prefix alone. The prefix is a symptom; the routing decision is made by tool name plus the `providerExecuted` metadata, and both have to be considered together.
- Server-tool metadata is provider-specific state, not portable history. Any code that migrates or rewrites stored parts across providers must clear it rather than translate it.
- Mixed-provider sessions are a real configuration, not a corner case — a session's model can change between turns while its history persists. Replay tests should construct a history where `tool_use` and `server_tool_use` parts coexist and assert the conversion is schema-valid.
- When a provider rejects a payload, read the next constraint before assuming the first fix is sufficient. Satisfying the ID pattern here moved the failure rather than removing it.
