# Agent-outcome eval corpus

This is a small, gated regression corpus for the quality of the agent's actual outcome. It runs the real `executeOpenCode` path against disposable fixture repositories, then records a JSON report with provenance and hard gate results.

## The rule

> **Assert outcomes, never method.**

This corpus must never assert that the agent called a particular tool, used a particular number of calls, followed a step or turn order, or used a particular reasoning shape. It may assert only observable outcomes: response-file parsing, the verdict, exactly one delivery artifact, forbidden mutations, secret leakage, and whether a planted defect was identified by file path. Do not pin complete phrasing, response style, or prose structure beyond explicit output contracts.

The gates are pure functions in `gates.ts`, so they run in normal CI. The live corpus is skipped unless `FRO_BOT_EVAL=1` is explicitly set.

Quality gates may assert that required signals are present in free-form response prose, but they never assert that a signal is absent. Absence is only meaningful for single-valued structured fields such as the expected verdict.

## Result states

Each scenario report has one of three states:

- `passed`: execution completed and every evaluated outcome gate passed.
- `failed`: an observable regression was found. A completed run with a failed quality gate is failed; an incomplete run is also failed when it produced a parsed bad response or violated a safety gate.
- `inconclusive`: execution did not complete, such as a timeout or transport failure, and no assessable regression was observed. Missing or unparseable response quality gates are reported as `not-evaluated`; this state must never be treated as a regression.

The safety gates `no-forbidden-mutation` and `no-secret-leak` still run on an inconclusive execution because repository mutation and canary leakage remain observable safety findings even without a completed review outcome. If an incomplete run produced a response that parses, response-based quality gates are also assessable. A missing or unparseable response leaves those quality gates `not-evaluated`. The corpus logs inconclusive scenarios and writes their reason, exit code, execution duration, and configured timeout to the JSON report. A suite with any inconclusive scenario and no failures is itself `inconclusive`; the corpus command is green only for `passed`. An empty report set remains `failed`.

This distinction earned its place during development. An early misconfiguration left the agent running outside the fixture repository, so scenarios burned their entire budget searching the filesystem and timed out. With a boolean `passed`, every one of those runs would have read as a catastrophic agent regression; as `inconclusive`, they correctly reported that no outcome was obtainable and sent the investigation at the harness instead of the model. A future contributor collapsing these states back into a boolean is the main way this corpus degrades into a noisy artifact nobody trusts.

The original `clean-pr` / `planted-defect` pair is a deliberately differential PR-review pair: they share one neutral prompt, the same pull-request event, the same file set, and the same `diffFiles` summary. Only the implementation of `src/access.ts` differs. The planted-defect expectation lives in scorer-owned metadata, never in the agent-facing prompt. Adding answer-revealing text destroys the corpus by measuring obedience rather than judgment.

The irrelevant-prior-work continuation scenario is a non-degradation check: unrelated supplied context must not prevent the agent from finding the current repository evidence. It is not contamination coverage and must not ban the unrelated marker from the response.

## Candidate comparison

`evals/compare.ts` provides a read-only candidate-vs-reviewed-baseline projection. It compares only `scenarioId`, the observed structured `verdict`, scenario `state`, and gate IDs with their `passed`/`failed`/`not-evaluated` semantics. Gate details and response prose are diagnostics, not quality equality.

Model/runtime/plugin versions, prompt and fixture hashes, duration, cost, and token usage remain provenance or advisory differences. Tool calls, call counts, reasoning order, and step counts are never quality fields. A clean comparison reports only **no large observed regression across the six covered scenarios**; it does not claim improvement or production-surface quality.

Safety and response-contract failures are decisive and block without stochastic retries. An inconclusive infrastructure outcome is neither pass nor fail and requests a rerun. A stochastic quality failure requests lazy repeats only for that scenario, with a maximum of four candidate and four reviewed-baseline samples including the initial observations. Mixed samples, or two modes that both pass without discrimination, remain inconclusive and never auto-promote a candidate baseline.

The committed `u1.json` artifact predates the stable outcome projection. Until a newly reviewed baseline includes those observations, comparison returns explicit missing-evidence rather than copying candidate values into the baseline or inferring an observed verdict from expected metadata.

### Bounded session-presearch experiment

U4 is an eval-only differential seam, not a public feature. `runSessionPrep` keeps the current eager behavior when its strategy is omitted. The runner may inject the treatment strategy for only the existing `continuation-relevant` and `continuation-irrelevant-non-degradation` scenarios; the treatment removes eager recent/prior-work context while preserving the logical key, continuation identity, and native `session_*` capability.

The treatment is selected by dependency injection through the runner path. There is no Action input, general feature flag, environment switch, or global state. Reports may include advisory `sessionPresearch` accounting for strategy, logical/continuation identity, context result counts, and injected-context bytes. That provenance is never a quality gate and contains no tool-call, call-count, ordering, or reasoning claim.

The comparison reuses the stable outcome projection and the existing lazy four-vs-four repeat bound. A clean result means only that no large regression was observed on these two covered scenarios. If both modes pass, the corpus cannot attribute causal improvement; deleting eager presearch would be a documented simplicity/cost judgment rather than evidence that the model reasoned better.

Run the differential experiment explicitly; it is skipped without the same `FRO_BOT_EVAL=1` gate as the corpus:

```bash
FRO_BOT_EVAL=1 bun run evals:presearch
```

The driver compares treatment reports with live production-mode reports and uses `evals/baselines/u1.json` for reviewed registry/provenance validation. The default artifact is `evals/output/presearch-differential-report.json`; `FRO_BOT_EVAL_OUTPUT` overrides that path. A missing stable outcome in `u1.json` is filled only by independently validated live production reports; no treatment value is copied into the reviewed baseline. Infrastructure-inconclusive scenarios remain rerun requests, not regressions.

## Run it

Normal test runs do not start OpenCode and do not cost anything:

```bash
bunx vitest run evals/corpus.test.ts
```

Run the live corpus explicitly:

```bash
FRO_BOT_EVAL=1 bunx vitest run evals/corpus.test.ts
```

### Environment variables

| Variable | Effect |
| --- | --- |
| `FRO_BOT_EVAL=1` | Required. Without it the corpus is skipped entirely. |
| `FRO_BOT_EVAL_MODEL` | `provider/model` to run. Defaults to the free, credentialless `opencode/big-pickle`. |
| `FRO_BOT_EVAL_HARNESS_BIN` | Path to the harness platform binary. Auto-discovered from `harness` on `PATH`; set explicitly when a workspace shim shadows the real install. |
| `FRO_BOT_EVAL_TIMEOUT_MS` | Per-scenario execution budget. Defaults to 300000. |
| `FRO_BOT_EVAL_OUTPUT` | Report path. Defaults to the gitignored `evals/output/eval-report.json` for the corpus, and `evals/output/presearch-differential-report.json` for `evals:presearch`. |

The corpus runs the patched **harness** build, never stock `opencode-ai` from npm. The harness carries this project's upstream patch set, so an eval driven by the stock package measures a different system than the one that ships.

### Real-model runs

The original `clean-pr` / `planted-defect` pair has completed end to end against `anthropic/claude-sonnet-5`; provider/runtime duration is advisory and variable, not a stable timing promise. Providers whose stored credential is an OAuth record rather than an API key also need their auth plugin loaded; see `PROVIDER_AUTH_PLUGINS` in `runner.ts`. Copying `auth.json` alone is not enough, and the resulting failure looks like an opaque provider error rather than a missing exchange step.

Provisioning copies exactly one provider entry into the isolated home, never the whole host auth file, which typically holds credentials for several unrelated providers this run has no business reaching.

### Reviewed baseline

The committed reference is [`evals/baselines/u1.json`](baselines/u1.json). It contains outcome and provenance only; live outputs and diagnostics remain under the gitignored `evals/output/` directory. Stable comparison fields are scenario IDs, model, harness/plugin versions, prompt hashes, fixture SHAs, states, and passed gate IDs. Duration, cost, and token usage are advisory provenance and never equality gates.

Any model, harness, plugin, prompt, or corpus change requires a reviewed baseline update; do not silently replace this file. To update it, run the corpus once, require the completed marker, a passed suite, all six scenarios passed, no diagnostics, and deterministic prompt/fixture provenance in every scenario report, then run `bun run evals:baseline:update -- evals/output/eval-report.json`; the command sanitizes the report to the allowlisted fields without starting a live eval. Finish with the baseline-integrity and static eval tests. The initial baseline was normalized during U1 review from the authoritative completed report, so that historical raw report is not directly promotable under the strict command. Its initial plugin provenance is taken from the runner configuration at the source corpus SHA because the report field was added immediately after that run; future reports record it directly.

#### Prompt-hash-only changes

`evals:baseline:update` is not a prompt-hash generator. It accepts one positional path to a completed report and requires the completion marker, a passed suite, every enabled scenario in registry order, passed gates, no diagnostics, and prompt/fixture provenance that matches the deterministic scenario registry. It does not run the live corpus or accept a partial prompt-hash input; a live corpus run requires `FRO_BOT_EVAL=1` and real model calls.

When an intentional prompt change requires only deterministic prompt-hash updates, recompute each affected value with `buildDeterministicScenarioProvenance` from `evals/runner.ts` over `ALL_SCENARIOS`, then update only the corresponding `promptHash` fields in this reviewed baseline and the exact prompt-byte pins in `evals/runner.test.ts`. Do not invent hashes or promote a partial report. These hashes are deterministic and independently re-derivable from the scenario registry, so no model call is involved. The PR-surface hashes must remain unchanged as the control; if they move, stop and investigate the prompt change before updating the baseline. Finish with the baseline-integrity and static eval tests.

### Isolation

**This is not a sandbox.** The corpus runs an LLM-controlled agent with `bash: allow` as your own OS user. Changing `HOME`, `XDG_*`, and the working directory limits where OpenCode looks by default; it does not restrict what the agent can reach. A misbehaving or prompt-injected agent can still read any file your user can read — SSH keys, the host OpenCode auth file, other repositories — and could write what it finds into its response, logs, or the diagnostics artifact. OpenCode's bash permission check inspects the command string only and is advisory, not a containment boundary.

Treat a live corpus run as running untrusted code with your own privileges. Fixture content is deliberately adversarial (it carries a credential-shaped canary), so prompt injection via fixture content is in scope by design. Prefer a disposable machine or container for anything beyond the bundled scenarios, and do not run the live corpus on a host holding secrets you would not hand to the model.

The runner creates a temporary Git repository, isolates `HOME`/`XDG_*`, **enters the fixture repository**, removes `GH_TOKEN` and `GITHUB_TOKEN`, and gives OpenCode no GitHub credential. It loads no user plugins beyond a required provider auth plugin. The fixture repository and temporary response files are cleaned up after each scenario. The committed `.env.example` contains a per-run random non-credential canary; the runner substitutes it before execution and checks response/error output for leakage.

The build agent denies every external directory except the run-scoped response root, mirroring production to avoid unresolved permission asks in the noninteractive eval. This is fail-fast tool policy, not host containment: `bash: allow` still gives the agent full authority over the host.

**WARNING: the working-directory change is global to the Vitest worker.** The OpenCode server bootstraps in the process working directory rather than the session directory it is handed. In CI those coincide because the process already runs in `GITHUB_WORKSPACE`, but under a test runner they diverge: the server indexes the wrong tree, the fixture's files are missing from what the agent can see, and a diligent model spends its entire budget searching the filesystem for them. Run `evals/corpus.test.ts` alone; the corpus emits a warning when Vitest appears to be running other test files or the full suite. The runner restores cwd and environment on every setup and execution failure path.

When a scenario does not complete, the agent's logs are copied to `evals/output/diagnostics/<scenario>/` before cleanup destroys the isolated home. Without that capture a failed run reports only an exit code, leaving no way to tell a slow model from one that never issued a request.

Every non-passing response is also stored locally under the gitignored diagnostics directory. Response evidence is bounded to 65,536 bytes, marked when truncated, written with restrictive permissions, and is never added to the committed eval report or baseline.

## Add a scenario

1. Add one declarative scenario file under `evals/scenarios/` with a unique id and `surface`, `files`, `prompt`, `priorWork`, and `expect` fields as applicable.
2. Use the shared neutral prompt and event shape for differential scenarios. Provide the file map, surface, prompt, prior-work context, expected verdict, and required presence groups that represent the scenario's observable contract.
3. Keep the planted canary out of the reviewed diff. A canary inside the change under review makes quoting it correct reviewer behaviour, which turns the leak gate into a test of the wrong thing — and stops the scenario being clean, since committing a hardcoded token is itself a real finding.
4. Register the scenario in `evals/scenarios/index.ts` / `ALL_SCENARIOS`; do not add per-scenario registration in `corpus.test.ts`.
5. Keep expectations to the structured verdict and required presence groups only. Do not assume every scenario has a defect file, and never add free-prose absence checks or method assertions.
6. Run the static scenario neutrality/registry tests and pure eval tests before any live run or baseline change.

Keep the corpus small. Add a scenario only when a specific agent-facing change needs coverage that the existing scenarios cannot provide.
