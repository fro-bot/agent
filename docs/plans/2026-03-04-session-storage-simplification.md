# Session Storage Simplification Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Consolidate the over-fragmented session storage layer from 10+ mapper/utility files down to ~3, eliminating redundant defensive parsing while preserving fields the SDK types omit.

**Architecture:** The session module reads from the OpenCode SDK's HTTP client. The current mapper layer defensively parses `unknown` JSON — a holdover from when the code read raw files from disk. Now that 3 of 5 SDK endpoints return typed responses, we can accept typed inputs. However, local types MUST remain the authoritative interface because the SDK types omit fields the server returns (`agent`, `variant`, `permission`, `reasoning`). Two endpoints (`todos`, `delete`) remain untyped in the SDK client.

**Tech Stack:** TypeScript, ESM, `@opencode-ai/sdk`, Vitest

---

## Pre-Implementation Context

### What NOT to touch

- `search.ts` (220L) — clean, business logic
- `prune.ts` (138L) — clean, dual-condition retention
- `writeback.ts` (78L) — clean, run summary injection
- `version.ts` (34L) — clean, version utils
- `backend.ts` (3L) — SDK type alias

### What to consolidate

- `storage-value-readers.ts` (4L) → inline into mapper file
- `storage-session-mappers.ts` (53L) → merge into `storage-mappers.ts`
- `storage-message-base-mapper.ts` (79L) → merge into `storage-mappers.ts`
- `storage-part-mapper.ts` (94L) → merge into `storage-mappers.ts`
- `storage-todo-mappers.ts` (25L) → merge into `storage-mappers.ts`
- `storage-messages-collection.ts` (17L) → merge into `storage-mappers.ts`
- `session-storage.ts` (9L) → delete (re-export barrel)
- `discovery.ts` (49L) → remove duplicated `isRecord`/`readString`

### SDK type gaps (why we keep local types)

| Field                       | SDK has it?         | Server returns it? | Consumers             |
| --------------------------- | ------------------- | ------------------ | --------------------- |
| `AssistantMessage.agent`    | ❌                  | ✅                 | `search.ts:67,68,161` |
| `UserMessage.variant`       | ❌                  | ✅                 | mapper reads it       |
| `SessionInfo.permission`    | ❌                  | ✅                 | mapper reads it       |
| `SessionInfo.time.archived` | ❌                  | ✅                 | mapper reads it       |
| `ReasoningPart.reasoning`   | ❌ (`text` instead) | ✅                 | `search.ts:178`       |

### External consumers (DO NOT change these type shapes)

- `SessionSummary` → `features/agent/types.ts`, `harness/phases/session-prep.ts`, `features/agent/prompt.test.ts`
- `SessionSearchResult` → same files
- `PruneResult` / `PruningConfig` → `harness/phases/cleanup.ts`

### Mapper call sites (ALL internal to session module)

- `mapSdkSessionToSessionInfo` → `storage-read.ts:20,38,89`
- `mapSdkMessages` → `storage-read.ts:48`
- `mapSdkTodos` → `storage-read.ts:65`
- `mapSdkMessageToMessage` → `storage-messages-collection.ts:11`
- `mapSdkPartToPart` → `storage-messages-collection.ts:13`
- `mapSdkToolState` → `storage-part-mapper.ts:75`
- `mapSdkFileDiffs` → `storage-session-mappers.ts:37` AND `storage-message-base-mapper.ts:28` (DUPLICATED)

### Acceptance criteria (apply after EVERY task)

```bash
pnpm test          # 967/967 tests pass
pnpm check-types   # Zero type errors
pnpm build         # Build succeeds
```

---

## Phase 1: Merge mapper files (highest value, lowest risk)

### Task 1: Create unified `storage-mappers.ts`

**Files:**

- Create: `src/services/session/storage-mappers.ts`
- Keep unchanged: `src/services/session/types.ts`

**Step 1: Create the new file with all mapper functions consolidated**

Combine the contents of these 6 files into one `storage-mappers.ts`:

- `storage-value-readers.ts` (4L) — inline the 4 utility functions at the top
- `storage-session-mappers.ts` (53L) — `mapSdkFileDiffs`, `mapSdkSessionToSessionInfo`
- `storage-message-base-mapper.ts` (79L) — `mapSdkMessageToMessage` (remove its duplicate `mapSdkFileDiffs`, use the single copy)
- `storage-part-mapper.ts` (94L) — `mapSdkToolState`, `mapSdkPartToPart`
- `storage-todo-mappers.ts` (25L) — `mapSdkTodos`
- `storage-messages-collection.ts` (17L) — `mapSdkMessages`

Structure of the new file:

```typescript
import type {Message, Part, SessionInfo, TodoItem, ToolState} from './types.js'

// Value readers (inlined from storage-value-readers.ts)
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v != null
const readString = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const readNumber = (v: unknown): number | null => (typeof v === 'number' ? v : null)
const readBoolean = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null)

// File diffs (ONE copy, deduplicated)
function mapSdkFileDiffs(v: unknown): readonly {file: string; additions: number; deletions: number}[] | undefined { ... }

// Session mapper
export function mapSdkSessionToSessionInfo(s: unknown): SessionInfo { ... }

// Message mapper
export function mapSdkMessageToMessage(m: unknown): Message { ... }

// Part mapper (includes mapSdkToolState as private helper)
export function mapSdkPartToPart(p: unknown): Part { ... }

// Todo mapper
export function mapSdkTodos(v: unknown): readonly TodoItem[] { ... }

// Messages collection (sorts chronologically)
export function mapSdkMessages(v: unknown): readonly Message[] { ... }
```

**Verify:** The file must be under 200 LOC. Based on current content: 4 + 53 + 79 + 94 + 25 + 17 = 272 total, minus ~30 lines of duplicate imports/`mapSdkFileDiffs` = ~242. This is OVER the 200 LOC limit.

**If over 200 LOC:** Split into TWO files:

- `storage-mappers.ts` — value readers (inlined), `mapSdkFileDiffs`, `mapSdkSessionToSessionInfo`, `mapSdkTodos` (~100L)
- `storage-message-mappers.ts` — `mapSdkToolState`, `mapSdkPartToPart`, `mapSdkMessageToMessage`, `mapSdkMessages` (~140L)

Both import value readers from `storage-mappers.ts` (or inline them). `mapSdkFileDiffs` lives in `storage-mappers.ts` and is imported by `storage-message-mappers.ts`.

**Step 2: Run tests to verify no regressions**

```bash
pnpm test
pnpm check-types
```

Expected: All 967 tests pass (the new file isn't wired in yet — this is just a sanity check that creating the file doesn't break anything).

**Step 3: Commit**

```bash
git add src/services/session/storage-mappers.ts src/services/session/storage-message-mappers.ts
git commit -m "refactor(session): create consolidated mapper files"
```

---

### Task 2: Rewire `storage-read.ts` to use consolidated mappers

**Files:**

- Modify: `src/services/session/storage-read.ts`

**Step 1: Update imports**

Replace:

```typescript
import {mapSdkMessageToMessage} from "./storage-message-base-mapper.js"
import {mapSdkMessages} from "./storage-messages-collection.js"
import {mapSdkPartToPart} from "./storage-part-mapper.js"
import {mapSdkSessionToSessionInfo} from "./storage-session-mappers.js"
import {mapSdkTodos} from "./storage-todo-mappers.js"
```

With imports from the new consolidated file(s):

```typescript
import {mapSdkSessionToSessionInfo, mapSdkTodos} from "./storage-mappers.js"
import {mapSdkMessageToMessage, mapSdkMessages, mapSdkPartToPart} from "./storage-message-mappers.js"
```

**Step 2: Remove the re-export line**

Delete line 10: `export {mapSdkMessageToMessage, mapSdkPartToPart, mapSdkSessionToSessionInfo}`

This re-export is not consumed by any external module (verified by explore agent).

**Step 3: Run tests**

```bash
pnpm test
pnpm check-types
```

Expected: All 967 tests pass.

**Step 4: Commit**

```bash
git add src/services/session/storage-read.ts
git commit -m "refactor(session): rewire storage-read to use consolidated mappers"
```

---

### Task 3: Rewire `discovery.ts` — remove duplicated utilities

**Files:**

- Modify: `src/services/session/discovery.ts`

**Step 1: Remove local `isRecord` and `readString` declarations**

Delete lines 6-12 (the local redeclarations):

```typescript
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null
}
```

**Step 2: Import from consolidated mapper file**

```typescript
import {isRecord, readString} from "./storage-mappers.js"
```

Note: `isRecord` and `readString` need to be exported from `storage-mappers.ts` for this. Ensure they are `export const` not just `const`.

**Step 3: Run tests**

```bash
pnpm test
pnpm check-types
```

Expected: All 967 tests pass.

**Step 4: Commit**

```bash
git add src/services/session/discovery.ts src/services/session/storage-mappers.ts
git commit -m "refactor(session): deduplicate isRecord/readString in discovery.ts"
```

---

### Task 4: Delete old mapper files and barrel

**Files:**

- Delete: `src/services/session/storage-value-readers.ts`
- Delete: `src/services/session/storage-session-mappers.ts`
- Delete: `src/services/session/storage-message-base-mapper.ts`
- Delete: `src/services/session/storage-part-mapper.ts`
- Delete: `src/services/session/storage-todo-mappers.ts`
- Delete: `src/services/session/storage-messages-collection.ts`
- Delete: `src/services/session/session-storage.ts`
- Modify: `src/services/session/index.ts`

**Step 1: Before deleting, verify no remaining imports**

Search the entire `src/` directory for imports from the files being deleted:

```bash
grep -rn 'storage-value-readers\|storage-session-mappers\|storage-message-base-mapper\|storage-part-mapper\|storage-todo-mappers\|storage-messages-collection\|session-storage' src/services/session/ --include='*.ts' | grep -v '\.test\.'
```

Only `storage-read.ts` (already rewired in Task 2), `discovery.ts` (rewired in Task 3), and `index.ts` (will be updated now) should reference these.

**Step 2: Update `index.ts`**

Replace the `session-storage.ts` re-exports with direct imports from `storage-read.ts` and `storage-write.ts`:

Before:

```typescript
export {
  deleteSession,
  findLatestSession,
  findProjectByWorkspace,
  getSession,
  getSessionMessages,
  getSessionTodos,
  listProjectsViaSDK,
  listSessionsForProject,
} from "./session-storage.js"
```

After:

```typescript
export {
  findLatestSession,
  getSession,
  getSessionMessages,
  getSessionTodos,
  listSessionsForProject,
} from "./storage-read.js"
export {deleteSession} from "./storage-write.js"
export {findProjectByWorkspace, listProjectsViaSDK} from "./discovery.js"
```

**Step 3: Delete the 7 old files**

```bash
rm src/services/session/storage-value-readers.ts
rm src/services/session/storage-session-mappers.ts
rm src/services/session/storage-message-base-mapper.ts
rm src/services/session/storage-part-mapper.ts
rm src/services/session/storage-todo-mappers.ts
rm src/services/session/storage-messages-collection.ts
rm src/services/session/session-storage.ts
```

**Step 4: Run tests**

```bash
pnpm test
pnpm check-types
```

Expected: All 967 tests pass.

**Step 5: Verify acceptance criteria**

```bash
# File count reduction
find src/services/session -name 'storage-*.ts' -not -name '*.test.ts' | wc -l
# Expected: 3-4 (storage-read.ts, storage-write.ts, storage-mappers.ts, optionally storage-message-mappers.ts)

# No session-storage.ts barrel
test ! -f src/services/session/session-storage.ts && echo "PASS" || echo "FAIL"

# No storage-value-readers.ts
test ! -f src/services/session/storage-value-readers.ts && echo "PASS" || echo "FAIL"

# Single mapSdkFileDiffs
grep -rn 'function mapSdkFileDiffs' src/services/session/ | wc -l
# Expected: 1

# No isRecord in discovery.ts
grep -n 'function isRecord' src/services/session/discovery.ts | wc -l
# Expected: 0
```

**Step 6: Commit**

```bash
git add -A src/services/session/
git commit -m "refactor(session): delete old mapper files and session-storage barrel"
```

---

### Task 5: Inline `storage-write.ts` into `storage-read.ts`

`storage-write.ts` is 16 lines with one function. If merging it into `storage-read.ts` keeps the file under 200 LOC, do it. If not, keep separate.

**Files:**

- Modify: `src/services/session/storage-read.ts` (currently 96L)
- Delete: `src/services/session/storage-write.ts` (16L)
- Modify: `src/services/session/index.ts`

**Step 1: Check combined LOC**

96 + 16 - ~3 (duplicate imports) = ~109. Under 200 LOC. Proceed.

**Step 2: Move `deleteSession` into `storage-read.ts`**

Rename the file to `storage.ts` since it now handles both read and write:

```bash
git mv src/services/session/storage-read.ts src/services/session/storage.ts
```

Add `deleteSession` function from `storage-write.ts` into the renamed file.

**Step 3: Update `index.ts`**

Replace both storage imports with:

```typescript
export {
  deleteSession,
  findLatestSession,
  getSession,
  getSessionMessages,
  getSessionTodos,
  listSessionsForProject,
} from "./storage.js"
```

**Step 4: Update `search.ts` and `prune.ts` imports**

These files import from `session-storage.js` (already deleted in Task 4 and re-pointed). Verify their imports now point to the right place via `index.js` or update to `./storage.js` directly.

Actually — `search.ts` and `prune.ts` import from `./session-storage.js` which was deleted in Task 4. In Task 4, we should have also updated `search.ts` and `prune.ts` to import from the new locations. **Double-check this in Task 4 execution.**

**Step 5: Delete `storage-write.ts`**

```bash
rm src/services/session/storage-write.ts
```

**Step 6: Run tests**

```bash
pnpm test
pnpm check-types
```

**Step 7: Commit**

```bash
git add -A src/services/session/
git commit -m "refactor(session): merge storage-read and storage-write into storage.ts"
```

---

## Phase 2: Type-safe mapper inputs (medium value, medium risk)

### Task 6: Change typed endpoint mappers from `unknown` to SDK types

For the three endpoints with typed SDK responses (`session.list`, `session.get`, `session.messages`), change mapper inputs from `unknown` to the actual SDK types.

**Files:**

- Modify: `src/services/session/storage-mappers.ts`
- Modify: `src/services/session/storage-message-mappers.ts` (if split)

**Step 1: Add SDK type imports**

```typescript
import type {
  Session as SdkSession,
  UserMessage as SdkUserMessage,
  AssistantMessage as SdkAssistantMessage,
  Message as SdkMessage,
  Part as SdkPart,
  ToolState as SdkToolState,
} from "@opencode-ai/sdk"
```

**Step 2: Change `mapSdkSessionToSessionInfo` signature**

From: `(s: unknown): SessionInfo` To: `(s: SdkSession): SessionInfo`

Remove all `isRecord(s)` and `readString(s.xxx)` calls — access fields directly since `s` is now typed. HOWEVER: For fields the SDK type doesn't declare (`permission`, `time.archived`), access them via `(s as Record<string, unknown>).permission` or define an extended type:

```typescript
type SdkSessionWithExtras = SdkSession & {
  readonly permission?: {rules: readonly unknown[]}
  readonly time: SdkSession["time"] & {archived?: number}
}
```

Use this extended type as the mapper input instead.

**Step 3: Change `mapSdkMessageToMessage` signature**

From: `(m: unknown): Message` To: `(m: SdkMessage): Message`

For `agent` field (not on SDK types): access via `(m as Record<string, unknown>).agent` or use extended type.

NOTE: The SDK `AssistantMessage` does NOT have `agent`. But the server returns it. Use:

```typescript
type SdkMessageWithExtras = SdkMessage & {agent?: string}
```

**Step 4: Change `mapSdkPartToPart` signature**

From: `(p: unknown): Part` To: `(p: SdkPart): Part`

The SDK `Part` has 12+ variants; our local `Part` has 4. The mapper must handle the subset and default others to `text`.

For `ReasoningPart`: SDK uses `.text`, server sends `.reasoning`. Need to handle both:

```typescript
if (type === 'reasoning')
  return {
    ...base,
    type: 'reasoning',
    reasoning: (p as {reasoning?: string}).reasoning ?? (p as {text?: string}).text ?? '',
    ...
  }
```

**Step 5: Keep `mapSdkTodos` accepting `unknown`**

The `session.todos()` endpoint is not typed in the SDK client — response is genuinely `unknown`. Keep defensive parsing for this function.

**Step 6: Remove `readString`/`readNumber`/`readBoolean`/`isRecord` calls from typed paths**

For the mappers that now accept SDK types, replace:

- `readString(s.id) ?? ''` → `s.id`
- `readNumber(s.time?.created) ?? 0` → `s.time.created`
- `isRecord(s.time) ? ... : ...` → direct access

Keep these utilities only for `mapSdkTodos` (untyped endpoint) and for accessing extra fields not on SDK types.

**Step 7: Run tests**

```bash
pnpm test
pnpm check-types
```

Many tests create mock SDK responses as plain objects. The mappers are called indirectly via `storage.ts` functions which receive SDK client responses. Tests mock the SDK client return values, so the mapper type change should be transparent. If tests fail, it's because mock data doesn't match SDK types — fix the mocks.

**Step 8: Commit**

```bash
git add -A src/services/session/
git commit -m "refactor(session): type-safe mapper inputs from SDK types"
```

---

## Phase 3: Slim down `types.ts` (evaluate after Phase 2)

### Task 7: Evaluate SDK type re-export feasibility

**This task is exploratory — DO before deciding to execute.**

**Step 1: Check if local types can extend SDK types**

For types where the SDK is a strict subset:

```typescript
import type {Session as SdkSession} from "@opencode-ai/sdk"

// Extend with local-only fields
export interface SessionInfo extends SdkSession {
  readonly permission?: PermissionRuleset
  readonly time: SdkSession["time"] & {readonly archived?: number}
}
```

Test this approach for `SessionInfo`, `Message`, `Part`, `ToolState`. If TypeScript accepts it without errors across all consumers, proceed.

**Step 2: If feasible, replace redeclared types**

Replace the full interface redeclarations in `types.ts` with extension types. This should cut `types.ts` from 291L to ~100L.

Types to keep as-is (no SDK equivalent):

- `SessionSummary`, `SessionSearchResult`, `SessionMatch`
- `PruneResult`, `PruningConfig`
- `MessageError`, `PermissionRuleset`
- `TodoItem` (stricter than SDK's `Todo`)

**Step 3: If NOT feasible (likely due to `readonly` conflicts, field name mismatches)**

Keep `types.ts` as the authoritative source. The value from Phase 1+2 is already significant — file consolidation and type-safe mappers. Don't force SDK type extensions if they create type gymnastics.

**Step 4: Run tests**

```bash
pnpm test
pnpm check-types
```

**Step 5: Commit (if changes made)**

```bash
git add src/services/session/types.ts
git commit -m "refactor(session): slim types.ts using SDK type extensions"
```

---

## Phase 4: Final cleanup

### Task 8: Update module documentation

**Files:**

- Modify: `src/services/session/AGENTS.md`

Update the module AGENTS.md to reflect the new file structure after consolidation:

- Remove references to deleted files
- Add entries for new consolidated files
- Update the file inventory table

**Step 1: Update AGENTS.md**

**Step 2: Rebuild dist/**

```bash
pnpm build
```

**Step 3: Final verification**

```bash
pnpm test
pnpm check-types
pnpm build
```

**Step 4: Commit**

```bash
git add -A
git commit -m "docs: update session module AGENTS.md and rebuild dist"
```

---

## Summary

| Phase   | Tasks     | Files Deleted | Files Created | Risk                    |
| ------- | --------- | ------------- | ------------- | ----------------------- |
| Phase 1 | Tasks 1-5 | 8 files       | 1-2 files     | Low                     |
| Phase 2 | Task 6    | 0             | 0             | Medium                  |
| Phase 3 | Task 7    | 0             | 0             | Medium (evaluate first) |
| Phase 4 | Task 8    | 0             | 0             | None                    |

**Expected outcome:**

- Session module shrinks from 17 source files to ~11
- Mapper code consolidated from 6 files to 1-2
- Duplicated `mapSdkFileDiffs` eliminated
- Duplicated `isRecord`/`readString` in `discovery.ts` eliminated
- `session-storage.ts` 9-line barrel eliminated
- Type-safe mapper inputs for typed SDK endpoints
- All 967 tests passing
