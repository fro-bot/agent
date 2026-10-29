---
date: 2026-10-27
topic: opencode-v2-migration
---

# Move Fro Bot to OpenCode V2

## Summary

Fro Bot moves to stock upstream OpenCode V2 binaries, and the patched-binary harness is retired. Each surface gets V2 code written alongside its V1 code. The gateway and workspace switch together first, and the Action follows. V1 code is deleted after the last switch. The Action's session history carries across, and V1 data stays untouched until V1 is cut.

---

## Problem Frame

Upstream shipped OpenCode V2 as v2.2.0 on 2026-10-27. It stopped taking V1 pull requests on 2026-10-10 and now ships V1 patch releases only. All 15 upstream PRs the harness carries were closed unmerged. None of them can be rebased onto V2, because the V1 package they patch no longer exists.

V2 is a rewrite, not a version bump. It changes four things Fro Bot depends on:

- **API and SDK.** The server HTTP API, the event names and the SDK package line are all new. A V2 client cannot talk to a V1 server, and a V1 client cannot talk to a V2 server.
- **Plugins.** V1 plugins do not load. That includes Systematic and our own extensions.
- **Session database.** V2 migrates a V1 session database in place, and only in that direction. Persistent session state in the Action is the product's headline feature.
- **Defaults.** Several defaults that our safety posture relies on change. Access outside the checkout is allowed, the question tool is always registered, and tool calls run through Code Mode.

The code that touches these surfaces totals about 13.7k lines. The heaviest concentration is in the gateway run loop and the Action's event handling, which are also among the most frequently changed files in the repository.

---

## Requirements

A **surface** is a unit we deploy and switch as a whole. There are two:

- the GitHub Action;
- the gateway together with the workspace, because the gateway reaches OpenCode through the workspace proxy and the two images already roll forward and back together.

**Binary**

- R1. Every surface runs a stock upstream V2 release, pinned to an exact version. Every download is verified against upstream's published digest, recorded in the repository, and a failed V2 pin never falls back to another version.
- R2. No upstream patch is carried by default. Bringing one back is a separate decision. It is made only when a live probe shows the defect affecting a Fro Bot surface.
- R3. Once no surface consumes a harness build, the harness package and its build and release pipeline are retired. The V1 harness releases already published stay available, and no new ones are made.
- R4. Our setup installs plugins before the server starts, under the existing install bound. A hung install fails startup instead of hanging it.

**Migration shape**

- R5. V2 support is written as new code alongside the V1 code. Behaviour on main is unchanged until a surface switches.
- R6. Each surface switches, and reverts, as a whole.
- R7. Every behaviour a surface relies on today works the same on V2. That covers stop confirmation and quarantine, approvals, operator cancel, background-task ownership and drain, the stream watchdog, and terminal-state writes. A lost event stream still fails the run, as it does today. Behaviours that depend on an unrun probe are gated on that probe.
- R8. While V1 and V2 copies of a module both exist, a fix to one changes both copies in the same PR. If the other copy doesn't need the fix, the PR says why.
- R9. When the last surface has switched, the V1 code, the V1 SDK dependency and V1-only configuration are deleted.

**Order and gates**

- R10. The gateway and workspace switch first. The Action switches only after they have run on V2 in production. The Action switch ships as a breaking 0.x minor release.
- R11. No surface switches before a V2-compatible Systematic release exists.
- R12. No surface switches before the live probes defined in planning pass against the pinned V2 release.

**Action session continuity**

The gateway and workspace keep no persisted OpenCode session history. Each Discord mention starts a fresh session, and the workspace data directory is not on a volume. So R13-R16 apply to the Action only.

- R13. Restore precedence stays as it is today: the object store first, then the Actions cache. At each step, V2 data is tried before V1 data. The first V2 run for a repo finds no V2 data, restores the existing V1 data once, and V2 imports it.
- R14. V2 session data is saved under its own key name, in both the Actions cache and the object store. That name sits beside the V1 prefixes, not under them. V1 code never reads it, and V2 never writes V1 data, so a revert during the cutover runs V1 on its untouched V1 data.
- R15. V1 session data is deleted when V1 is cut.
- R16. A run sends no prompt until V2 has finished importing the restored V1 history. The wait happens before the prompt and has its own bound, sized from a measured import of the largest real session database. If the import fails or exceeds its bound, the run fails without prompting and saves nothing.

**Safety posture**

- R17. Action runs deny tool access outside the checkout, with the same exceptions as on V1. Gateway runs ask before it, and the ask goes to Discord approval, as on V1. Either way, this holds for the build agent and for dispatched subagents. A run fails if its converted rules allow outside-checkout access.
- R18. In Action runs, the agent cannot leave an interactive question pending, and a probe proves it. The gateway keeps interactive questions.
- R19. Code Mode stays on. Deny rules still block a call made inside Code Mode. Streaming, ownership, approvals and stop confirmation work correctly when tool calls run through it. The tools that move a session or create a worktree are denied, and a run fails if its session is moved.
- R20. The server password V2 requires is random for each spawn and never appears in logs. It is not a boundary against the agent, which already has local server access on V1.

**Fro Bot's own extensions**

- R21. The native session tools and the gateway's task-reuse guard ship as one V2 plugin package. It is built and tested in this repo, published to npm, and installed at an exact pinned version beside Systematic on both surfaces.

---

## Acceptance Examples

- AE1. **Covers R6.** The gateway and workspace switch to V2, run for a day, and are rolled back together to the previous release. Discord mentions work again on V1. No session history is involved.
- AE2. **Covers R13, R14.** A repository has V1 session data in the object store and no V2 data. Its first V2 run restores the V1 data, V2 imports it, and the run saves under the V2 key name. The V1 object is unchanged.
- AE3. **Covers R16.** A large V1 history is restored while the V2 import is still running. The run waits before sending its first prompt. If the import exceeds its bound, the run fails without prompting and saves nothing.
- AE4. **Covers R4.** The Systematic install hangs on the network. Startup fails at the install bound and reports a plugin install failure. The run does not wait for the job timeout.
- AE5. **Covers R18.** In an Action run, the model tries to ask the user a question. The run continues without blocking, whether the question tool is absent or its request is dismissed. The probe records which happened.
- AE6. **Covers R19, R17.** Inside Code Mode, the model runs a shell command and reads a file outside the checkout. In an Action run both are denied, and in a gateway run both ask for Discord approval, the same as a direct tool call.

---

## Success Criteria

- The gateway and workspace, and then the Action, run on stock V2.
- The Action loses no session history in the switch.
- No surface regresses in stop, approval, cancel or background-task behaviour.
- A revert during the cutover runs V1 on its untouched V1 data.
- After the last switch, the repository has no V1 code paths and no harness pipeline.
- Planning can define the probe list, the V2 code units and the cutover steps without inventing any product behaviour.

---

## Scope Boundaries

- Carrying any of the 15 patches forward, or opening V2 PRs for them.
- Running V1 and V2 side by side on one of our surfaces after its switch.
- Building V2 support for Systematic, which is built separately.
- Adding persisted session history to the gateway or workspace.
- V2 harness builds for other consumers. Projects pinned to harness builds, such as Space Bus, stay on the published V1 builds until they move to stock V2.
- Isolating the OpenCode server from the agent's tools (#1970).
- Eval work beyond the minimum needed to run the evals on V2.

---

## Key Decisions

- **Stock binaries over a rebuilt harness.** All 15 carries are dead:
  - six are covered upstream;
  - five are obsolete;
  - one is unknown and low priority;
  - three might still matter, and none of them is proven for us.

  Rebuilding the integrate pipeline for V2 costs more than those three fixes are worth.

- **Write new beside old, with same-PR mirroring.** The alternative was a shared seam: a large behaviour-preserving refactor across the busiest files, which would end with a single implementation once V1 is gone. Duplication is temporary and built to be deleted. Its cost is the mirroring rule (R8) during the window, so the window is kept short.
- **The gateway and workspace go first, as one unit.** They are operator-run, they have their own rollback pin, and they hold no session history. The hardest code, the gateway run loop, gets used on our own infrastructure before the public Action moves.
- **A separate key namespace, not a generation marker.** Released V1 code has no schema-generation check, so a marker would not stop an old Action tag from restoring a V2 database. A sibling key name that V1 never lists does stop it, and a revert during the cutover needs no manual cleanup.
- **Code Mode stays on.** The V2 event and ownership code is written against tool calls that run through Code Mode. We do not switch the V2 default off.
- **The server password is not an agent boundary.** On V1 the workspace server is an unauthenticated loopback service, so the agent's shell can already reach it, and the Action has no human approver. The password V2 adds changes neither fact.
- **Accepted V2 changes.** Todos are off by default and LSP never runs. Fro Bot depends on neither.

---

## Dependencies / Assumptions

- A V2-compatible Systematic release is being built separately, and it gates every switch (R11).
- V1 stays frozen but available: patch releases only, and no announced end of life. If upstream announces an end-of-life date, the timeline may need to compress.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R7, R12, R17-R19][Needs research] The one-off live probes against the pinned V2 release. At minimum they cover:
  - interrupt timing on a cold location;
  - whether a background child appears in the active-session list;
  - whether evicting a location refreshes file search after a checkout swap;
  - how a question-tool deny interacts with agent-level allow rules;
  - the Code Mode tool-call lifecycle, and whether deny rules hold inside it;
  - outside-directory rule conversion for the build agent and for a subagent;
  - V1 import time on the largest real session database;
  - session behaviour while the import runs;
  - directory-scoped quiescence, given that the active-session list is global;
  - the plugin install command under the existing bound.
- [Affects R13, R14][Technical] The exact cache and object-store key names for V2 data.
- [Affects R3][Technical] The order for retiring the harness package, its release workflow, its npm package and its Renovate rules.

---

## Sources / Research

- #1805, including the V2 hand-probe checklist: https://github.com/fro-bot/agent/issues/1805#issuecomment-6450311546
- Upstream migration guides at `anomalyco/opencode@v2.2.0`: `services/www/src/docs/content/migrate-v1.mdx` and `services/www/src/docs/content/build/plugins/migrate-v1.mdx`.
- The V1 history import at `anomalyco/opencode@v2.2.0`: `packages/core/src/database/migration.ts` and `packages/core/src/database/v1-migration.bun.ts`.
- `docs/reference/carry-ledger.md` records the 15 carries and their upstream status.
- The gateway and workspace co-rollback rule is in `deploy/README.md`.
