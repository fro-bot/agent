---
title: Make non-LLM traces readable in Langfuse with root-span Markdown, metadata and a trace name
date: 2026-11-27
category: best-practices
module: setup
problem_type: best_practice
component: tooling
severity: medium
applies_when:
  - Sending CI or harness lifecycle spans, not model calls, to Langfuse over OTLP
  - A trace looks complete in Tempo but empty or unreadable in Langfuse
  - Adding or changing langfuse.* attributes on the Action's or the plugin's spans
tags:
  - tracing
  - langfuse
  - opentelemetry
  - lifecycle-tracer
  - observability
---

# Make non-LLM traces readable in Langfuse with root-span Markdown, metadata and a trace name

## Context

To make non-LLM traces readable in Langfuse, put Markdown input and output on the root span only, send typed fields as metadata, and name the trace; then verify the render live. The Action's lifecycle trace (`action.main` plus one span per phase) reached the collector intact and Tempo showed the whole tree, yet Langfuse showed an empty root (no input or output, #2350), then a JSON summary collapsed into a key-value table ("JSON-only message detected", #2359), and a trace list with no names (#2368).

Tempo and Langfuse read different attributes from the same spans. The collector keeps only an allowlist of attributes for Tempo, so a complete Tempo tree says nothing about what Langfuse will show.

## Guidance

1. **Put the summary on the root span only.** Use the observation-level keys (`SUMMARY_ATTRIBUTE`, `src/shared/lifecycle-tracer.ts:116-121`):

   ```ts
   export const SUMMARY_ATTRIBUTE = {
     input: 'langfuse.observation.input',
     output: 'langfuse.observation.output',
     level: 'langfuse.observation.level',
     statusMessage: 'langfuse.observation.status_message',
   } as const
   ```

   `levelOf` (`lifecycle-tracer.ts:459`) sets the level to `ERROR` for a failed run, `WARNING` for a cancelled, skipped, incomplete or unfinished one, and `DEFAULT` otherwise. Phase spans carry none of these keys.
2. **Send Markdown strings, not JSON objects.** Langfuse renders a string as Markdown. Use a one-line input (event, repository, ref and isolation) and an output of a bold outcome line followed by a phase table. Escape interpolated values so they can't break out: `escapeMarkdown` (`lifecycle-tracer.ts:414`) covers table cells and output text, while the input's code spans use `codeSpan`, which replaces backticks with apostrophes because a backslash escapes nothing inside one (`lifecycle-tracer.ts:409-427`, `781-790`).
3. **Put structured fields in metadata.** Each `langfuse.observation.metadata.<key>` attribute becomes one metadata field (`SUMMARY_METADATA_PREFIX`, `lifecycle-tracer.ts:130`). A number stays a number and a boolean stays a boolean, so the fields can be filtered. The root carries these fields, but each is conditional: an unknown or empty value (the `reason` of a run that succeeded, say) is omitted (`lifecycle-tracer.ts:759-774`, `835-845`):
   - `trigger`
   - `event`
   - `repository`
   - `ref`
   - `isolate_agent`
   - `outcome`
   - `reason`
   - `duration_ms`
   - `phase_count`
   - `failed_phases`
4. **Name the trace on root spans only, after scrubbing.** The Action and the plugin use the same rule (`withTraceName`, `lifecycle-tracer.ts:589` and `packages/opencode-plugin/src/tracing/genai-attributes.ts:319`):

   ```ts
   function withTraceName(span: ScrubbedSpan): ScrubbedSpan {
     if (span.parentSpanId !== undefined) return span
     return {...span, attributes: {...span.attributes, [TRACE_NAME_ATTRIBUTE]: TRACE_NAME}}
   }
   ```

   A root is any span with no parent, so continuation roots are covered. The Action names its traces `fro-bot action` and the plugin names its turn traces `fro-bot run`. Adding the name after scrubbing means a redaction can't rewrite it.
5. **Scrub each field, then build, then cap at whole units.** The first version scrubbed the finished JSON as one string. A redaction that overlapped JSON punctuation could break the document or push it past 4 KiB. The order that works:
   1. Scrub each field.
   2. Escape it for Markdown.
   3. Build the text.
   4. Cut the table at whole rows to fit `SUMMARY_MAX_BYTES` (4,096 UTF-8 bytes, `lifecycle-tracer.ts:136`).
   5. Run one final check (`admitSummary`, `lifecycle-tracer.ts:748-752`): the text must be within `SUMMARY_MAX_BYTES` and unchanged by the scrubber. If it isn't, omit the attribute rather than rewrite it.

6. **Check the render live.** Receiver tests prove what the payload carries, not what Langfuse shows. #2359 was approved only after a run from a throwaway branch pinned to the PR head was opened in Langfuse Sessions. That run showed the one-line input, the phase table and the Metadata tab.

## Why This Matters

The Sessions list is where a reader starts. An empty root, or a summary rendered as a collapsed JSON table, reads as a broken integration even when every span arrived. A missing trace name makes the trace list impossible to filter.

A summary that crosses a trust boundary needs a fixed order of work. If the same text is scrubbed after it is serialized, it can come out invalid, truncated mid-row, or with a secret's tail left behind.

## When to Apply

- When you send non-model spans (CI, harness, lifecycle) to Langfuse.
- When Langfuse looks empty or unnamed while Tempo shows the whole tree.
- When you add free text to a root attribute.
- When you add a trace name or summary in the plugin. It appears only after the plugin is published and the Action's pin moves, so docs must say which side ships when. `fro-bot run` needed plugin 0.3.2 (#2372).

## Examples

- **Before:** the root had no `langfuse.observation.*`, so Sessions showed an empty row. A JSON object then rendered as "JSON-only message detected".
- **After:** the input is one line, built by `summarizeInput` (`lifecycle-tracer.ts:781`):

  ```text
  `issue_comment` on `owner/repo` @ `refs/heads/main`, isolated
  ```

  The output is a bold outcome, the run's duration and its phase count, then one table row per phase. Metadata holds the typed fields, and the trace list shows `fro-bot action`.

## Related

- [Check run tracing end to end, locally and on the published Action](../workflow-issues/run-tracing-live-check-2026-11-23.md): delivery checks. This doc covers how Langfuse renders what was delivered.
- #2310: putting a turn's final answer on the plugin's root span. That work was dropped; this doc is about the Action's own summary.
