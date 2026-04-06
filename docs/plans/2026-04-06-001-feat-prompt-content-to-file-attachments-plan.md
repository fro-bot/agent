---
title: "feat: Move external prompt content to file attachments"
type: feat
status: active
date: 2026-04-06
deepened: 2026-04-06
---

# feat: Move external prompt content to file attachments

## Overview

Extract bulky, user-supplied, and reference content from the inline prompt text into attached text files. The prompt text retains all agent instructions and references attachments with `@filename` syntax. Each `@filename` reference in the prompt has a corresponding `FilePartInput` delivered alongside the prompt to the OpenCode SDK. Attachment files are also saved with the prompt artifact for debugging.

## Problem Frame

The current prompt inlines everything — PR descriptions, hydrated GraphQL context, diff file lists, session excerpts, and review comments — directly into the prompt text. This creates two problems:

1. **Confusion boundary**: User-authored content (PR descriptions, commit messages) sits adjacent to system instructions. Models can mistake user prose for directives, especially when PR descriptions contain imperative language.
2. **Token bloat**: Large PR descriptions and file lists consume prompt budget that could go to the model's reasoning. Attachments are processed as reference context, not instructions.

## Requirements Trace

- R1. Inline prompt text contains only agent instructions, metadata, and `@filename` references — no raw user content
- R2. Each `@filename` reference has a corresponding `FilePartInput` with `mime: 'text/plain'` and a `file://` URL
- R3. The prompt artifact (saved to log directory) includes both the prompt text and all attachment files
- R4. Attachment files survive retries — `fileParts` must not be dropped after attempt 1 when they contain prompt-context files
- R5. Existing image attachment flow (`processAttachments`) continues to work unchanged
- R6. `buildAgentPrompt()` remains pure — no filesystem I/O in the prompt builder

## Scope Boundaries

- **In scope**: trigger comment body, hydrated PR/issue context, diff summary, session context excerpts
- **Out of scope**: custom prompt (already user-supplied instructions, kept inline), environment metadata, non-negotiable rules, task directives, response protocol, agent context, output contract
- **Not changing**: the existing image attachment pipeline in `src/features/attachments/`

## Context & Research

### Relevant Code and Patterns

- `src/features/attachments/injector.ts:14-21` — `toFileParts()` converts validated attachments to `FilePartInput[]` using `pathToFileURL().toString()`. This is the reference pattern for creating file parts.
- `src/features/attachments/injector.ts:24-49` — `modifyBodyForAttachments()` replaces markdown image/link references with `@filename` in the comment body. This is the exact `@filename` convention to follow.
- `src/features/agent/prompt.ts:128-302` — `buildAgentPrompt()` assembles all sections. Returns `string`. Sections that become attachments: lines 171-177 (diff + hydrated), 179-189 (session), 200-208 (trigger comment).
- `src/features/agent/execution.ts:73-87` — Prompt artifact saved as `prompt-{sessionId}-{hash}.txt` to `getOpenCodeLogPath()`.
- `src/features/agent/execution.ts:119` — `const files = attempt === 1 ? promptOptions.fileParts : undefined` — files dropped after first attempt.
- `src/features/agent/prompt-sender.ts:34-44` — `sendPromptToSession()` composes `[TextPartInput, ...FilePartInput[]]` and sends to SDK.
- `src/features/agent/types.ts:80-91` — `PromptOptions` interface with `fileParts?: readonly FilePartInput[]`.

### SDK Types (installed `@opencode-ai/sdk`)

```typescript
type FilePartInput = {
  id?: string
  type: 'file'
  mime: string
  filename?: string
  url: string          // file:// URL for local files
  source?: FilePartSource
}
type TextPartInput = {
  type: 'text'
  text: string
  // ... optional fields
}
```

### Institutional Learnings

- Oracle consultation (2026-04-05): Keep `buildAgentPrompt()` pure — return content descriptors, let the caller handle file I/O. This preserves the four-layer architecture (features don't do I/O).
- Oracle consultation: Retry path must be fixed — when core context lives in files, dropping them after attempt 1 loses critical reference material.

## Key Technical Decisions

- **Return type change**: `buildAgentPrompt()` returns `PromptResult { text: string, referenceFiles: ReferenceFile[] }` instead of `string`. `ReferenceFile` is `{ filename: string, content: string }` — content descriptors, not SDK types.
- **Materialization in execution.ts**: `executeOpenCode()` writes `referenceFiles` to temp files and converts them to `FilePartInput[]`, then merges with existing image `fileParts`.
- **`@filename` convention**: Each extracted section gets a descriptive filename (e.g., `pr-context.txt`, `diff-summary.txt`). The prompt text includes an `## Attached Reference Files` section listing each file with a one-line description.
- **Retry policy change**: Send all `fileParts` (both image and reference) on every attempt, not just attempt 1. The `CONTINUATION_PROMPT` is a short "please continue where you left off" message with no task context — without files, the model on retry has zero reference material to resume from. This is a correctness fix, not just a convenience change.
- **Artifact format**: Write reference files to `getOpenCodeLogPath()` alongside the prompt `.txt` file. The cleanup phase already uploads the entire log directory via `uploadLogArtifact()`, so reference files are included in the prompt artifact automatically with no extra upload code.
- **No temp file cleanup needed**: Unlike image attachments (which go to `os.tmpdir()/fro-bot-attachments-*` and are cleaned via `AttachmentResult.tempFiles`), reference files live in the persistent log directory and are uploaded as artifacts. They don't need explicit cleanup.

## Open Questions

### Resolved During Planning

- **Q: Should `buildAgentPrompt()` do file I/O?** No — it returns content descriptors. `execution.ts` materializes them. This keeps the features layer pure.
- **Q: What goes into files vs stays inline?** User-authored and reference content → files. Agent instructions, rules, metadata → inline. See scope boundaries above.
- **Q: What if models under-attend text attachments?** Keep a one-line summary inline for each attachment (e.g., "PR description and context attached as @pr-context.txt (5 commits, 18 files changed)"). If A/B testing shows degradation, increase inline summary detail.

### Deferred to Implementation

- **Exact inline summary wording** — depends on what metadata is available at render time
- **Whether session context excerpts are large enough to warrant extraction** — may stay inline if typically under ~200 tokens

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification.*

```
buildAgentPrompt(options) → { text, referenceFiles[] }
     │                              │
     │  text has @filename refs     │  [{filename: 'pr-context.txt', content: '...'}]
     ▼                              ▼
executeOpenCode()
     │
     ├─ write referenceFiles to tempDir as real files
     ├─ convert to FilePartInput[] (file:// URLs, text/plain)
     ├─ merge with image fileParts from session-prep
     ├─ save prompt text + attachment files to artifact dir
     │
     ▼
sendPromptToSession(client, sessionId, text, allFileParts, ...)
     │
     ├─ parts = [TextPartInput(text), ...allFileParts]
     └─ SDK sends to OpenCode → model sees text + files
```

## Implementation Units

- [ ] **Unit 1: Define `PromptResult` and `ReferenceFile` types**

**Goal:** Introduce return types for the refactored `buildAgentPrompt()`

**Requirements:** R1, R6

**Dependencies:** None

**Files:**
- Modify: `src/features/agent/types.ts`
- Test: `src/features/agent/prompt.test.ts`

**Approach:**
- Add `ReferenceFile` interface: `{ readonly filename: string, readonly content: string }`
- Add `PromptResult` interface: `{ readonly text: string, readonly referenceFiles: readonly ReferenceFile[] }`
- These are content descriptors in the features layer — no SDK types, no I/O

**Patterns to follow:**
- Existing readonly interface convention in `types.ts`

**Test scenarios:**
- Type-level — compilation confirms the interfaces exist and are usable

**Verification:**
- `pnpm check-types` passes

---

- [ ] **Unit 2: Refactor `buildAgentPrompt()` to return `PromptResult`**

**Goal:** Extract trigger comment body, hydrated context, diff summary, and session context into `referenceFiles`. Replace inline content with `@filename` references and a summary section.

**Requirements:** R1, R6

**Dependencies:** Unit 1

**Files:**
- Modify: `src/features/agent/prompt.ts`
- Test: `src/features/agent/prompt.test.ts`

**Approach:**
- Change return type from `string` to `PromptResult`
- For each extractable section, push a `ReferenceFile` to the array instead of pushing content to `parts[]`
- Add an `## Attached Reference Files` section to the prompt text listing each file with a one-line description
- Inline sections that stay: critical rules, thread identity, environment, issue/PR context metadata, task, current thread context, custom prompt, output contract, agent context, session management, response protocol, GitHub operations, constraint reminder
- Extracted to files: trigger comment body → `trigger-comment.txt`, hydrated PR/issue context → `pr-context.txt` or `issue-context.txt`, diff file list → `diff-summary.txt`, session excerpts → `session-context.txt` (if large enough)
- Each `@filename` reference accompanied by a brief inline summary (e.g., "See @pr-context.txt — PR #449 by marcusrbrown, 18 files, 5 commits")

**Patterns to follow:**
- Existing `@filename` convention from `modifyBodyForAttachments()` in `src/features/attachments/injector.ts`
- Existing `parts.push()` + `parts.map(p => p.trim()).join('\n\n')` pattern

**Test scenarios:**
- PR review prompt: returns `text` with `@pr-context.txt` reference and `referenceFiles` containing pr-context content
- Issue comment prompt: returns `text` with `@issue-context.txt` reference
- Schedule/dispatch prompt: no hydrated context → no reference files for that section
- No trigger comment (PR event): no `trigger-comment.txt` generated
- Comment event: trigger comment body extracted to `trigger-comment.txt`
- Prompt text still contains all instruction sections inline
- `referenceFiles` content matches what was previously inline
- Empty content sections (e.g., no session context) produce no reference file
- All extractable content absent (schedule/dispatch with no hydrated context, no diff, no session): `referenceFiles` is empty array, prompt text is complete with all inline sections, no `## Attached Reference Files` section rendered

**Verification:**
- All existing prompt tests updated and passing
- New tests verify `referenceFiles` array contents
- `pnpm check-types && pnpm test` clean

---

- [ ] **Unit 3: Materialize reference files and update execution pipeline**

**Goal:** Write `referenceFiles` to the log directory, convert to `FilePartInput[]`, merge with image fileParts, update artifact saving, and fix retry path.

**Requirements:** R2, R3, R4, R5

**Dependencies:** Unit 2

**Files:**
- Create: `src/features/agent/reference-files.ts` (materialization utility)
- Modify: `src/features/agent/execution.ts`
- Test: `src/features/agent/reference-files.test.ts`
- Test: `src/features/agent/execution.test.ts`

**Approach:**

*Materialization utility (`reference-files.ts`):*
- New `materializeReferenceFiles(referenceFiles, dir)` function: writes each `ReferenceFile` to `dir/{filename}`, returns `FilePartInput[]` using `pathToFileURL()` and `mime: 'text/plain'`
- Graceful degradation: if any individual file write fails, log a warning and skip it (don't fail the whole run)

*Execution pipeline changes (`execution.ts`):*
- `buildAgentPrompt()` now returns `PromptResult` — destructure into `{text: initialPrompt, referenceFiles}`
- Call `materializeReferenceFiles(referenceFiles, logPath)` after writing the prompt artifact (reference files go to same directory → uploaded automatically by `uploadLogArtifact()`)
- Merge returned `FilePartInput[]` with `promptOptions.fileParts` (image attachments from session-prep) into `allFileParts`
- Store `allFileParts` outside the retry loop

*Retry fix:*
- Change `execution.ts:119` from `const files = attempt === 1 ? promptOptions.fileParts : undefined` to `const files = allFileParts` on every attempt
- Rationale: `CONTINUATION_PROMPT` is "The previous request was interrupted by a network error. Please continue where you left off." — without files, the model on retry has zero reference material. With files, it has the PR context, diff, and trigger comment to resume from.
- Retries are only triggered by LLM fetch errors (network/timeout, checked via `isLlmFetchError()`), not content errors. `MAX_LLM_RETRIES=3`, `RETRY_DELAY_MS=5000`.

*No temp file cleanup needed:*
- Image attachments live in `os.tmpdir()/fro-bot-attachments-*` and are cleaned by `AttachmentResult.tempFiles` → `cleanupTempFiles()`
- Reference files live in `getOpenCodeLogPath()` (persistent log directory, uploaded as artifact) — no cleanup needed
- These two lifecycles are independent and don't interfere

**Patterns to follow:**
- `toFileParts()` in `src/features/attachments/injector.ts` for `FilePartInput` construction
- `pathToFileURL()` from `node:url` for file:// URLs
- Existing prompt artifact writing at `execution.ts:73-87` for the file write pattern

**Test scenarios:**
- `materializeReferenceFiles` creates files and returns correct `FilePartInput[]`
- Empty `referenceFiles` array returns empty `FilePartInput[]`
- File content matches input content
- `mime` is `'text/plain'` for all reference files
- `url` uses `file://` scheme
- Failed file write logs warning but doesn't throw
- Retry attempt 2+ still includes all `fileParts` in the SDK call
- Image fileParts from session-prep and reference fileParts coexist in merged array
- Continuation prompt text changes but files persist across all 3 retry attempts

**Verification:**
- Reference files appear in log directory alongside prompt `.txt` artifact
- All file parts sent on every retry attempt
- `pnpm check-types && pnpm test && pnpm build` clean

## System-Wide Impact

- **Interaction graph**: `buildAgentPrompt()` return type changes from `string` to `PromptResult`. The only caller is `executeOpenCode()` in `execution.ts`. No other callers exist — `harness/phases/execute.ts` delegates to `executeOpenCode()` and never calls `buildAgentPrompt()` directly.
- **Error propagation**: If `materializeReferenceFiles()` fails for an individual file, it logs a warning and omits that file from the `FilePartInput[]` array. The prompt text still contains the `@filename` reference but the model won't have the file content — acceptable degradation since the inline summary provides minimal context. If the entire materialization fails, the prompt still works (it just references files that aren't attached).
- **State lifecycle — two independent temp file paths**:
  - Image attachments: `os.tmpdir()/fro-bot-attachments-*` → tracked by `AttachmentResult.tempFiles` → cleaned by `cleanupTempFiles()` in cleanup phase
  - Reference files: `getOpenCodeLogPath()` (`~/.local/share/opencode/log`) → persistent, uploaded as artifact by `uploadLogArtifact()` → no cleanup needed
  - These paths don't overlap. No changes to `AttachmentResult` or `cleanupTempFiles()` are needed.
- **API surface parity**: `PromptOptions.fileParts` continues to carry image attachments from session-prep. Reference file parts are a separate set created in `executeOpenCode()` and merged at send time. The `sendPromptToSession()` signature doesn't change — it already accepts `readonly FilePartInput[]`.
- **Retry behavior change**: Currently `fileParts` are dropped after attempt 1. After this change, all file parts persist across all 3 retry attempts. This is strictly better — the `CONTINUATION_PROMPT` says "continue where you left off" but without files the model has no context about the task. Retries only trigger on LLM fetch errors (network/timeout), so the files themselves are not the cause of failure.
- **Integration coverage**: Verify that `sendPromptToSession()` receives `[TextPartInput, ...imageFileParts, ...referenceFileParts]` in the correct order — text first, then all files.

## Risks & Dependencies

- **Model attention to text attachments**: Models may under-attend text file attachments compared to inline text. Mitigated by keeping inline summaries for each attachment (e.g., "See @pr-context.txt — PR #449, 18 files, 5 commits"). If first CI runs show quality degradation, increase inline summary detail or move the most critical content (e.g., trigger comment) back inline. Monitor the first 5-10 runs post-merge.
- **SDK behavior for text/plain files**: The SDK `FilePartInput` type supports arbitrary MIME types. The existing attachment system uses image types (`image/png`, etc.). Text/plain is a standard MIME type and `FilePartInput` makes no distinction. Risk is low but confirm in the first CI run by checking the OpenCode log for successful file loading.
- **`@filename` resolution**: The existing attachment system uses `@filename` in the comment body, and OpenCode resolves these against attached files. Verify that OpenCode also resolves `@filename` references that appear in the prompt text (not just the comment body). If not, the model still sees the files in its context — the `@filename` is just a human-readable pointer.
- **Prompt artifact size**: Reference files add ~2-10KB to the artifact (PR description + diff list + session context). The artifact is already compressed (zstd) and the size increase is negligible.
- **Retry path change**: Sending files on every retry increases retry payload size. With 3 retries max and reference files typically < 10KB total, this is acceptable. The benefit (model has context to resume) far outweighs the cost (slightly larger retry payload).

## Sources & References

- Related PRs: #449 (prompt quality improvements, config fixes)
- Existing pattern: `src/features/attachments/injector.ts` — `toFileParts()`, `modifyBodyForAttachments()`
- SDK types: `node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts`
- Oracle consultation: 2026-04-05 session on prompt architecture
- Prior plan: `docs/plans/2026-02-14-prompt-builder-audit.md` (older, different scope)
