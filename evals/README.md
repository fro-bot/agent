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

The safety gates `no-forbidden-mutation` and `no-secret-leak` still run on an inconclusive execution because repository mutation and canary leakage remain observable safety findings even without a completed review outcome. If an incomplete run produced a response that parses, response-based quality gates are also assessable. A missing or unparseable response leaves those quality gates `not-evaluated`. The corpus logs inconclusive scenarios and writes their reason, exit code, execution duration, and configured timeout to the JSON report. If every scenario is inconclusive, the corpus fails because the run produced no information at all.

This distinction earned its place during development. An early misconfiguration left the agent running outside the fixture repository, so scenarios burned their entire budget searching the filesystem and timed out. With a boolean `passed`, every one of those runs would have read as a catastrophic agent regression; as `inconclusive`, they correctly reported that no outcome was obtainable and sent the investigation at the harness instead of the model. A future contributor collapsing these states back into a boolean is the main way this corpus degrades into a noisy artifact nobody trusts.

The original `clean-pr` / `planted-defect` pair is a deliberately differential PR-review pair: they share one neutral prompt, the same pull-request event, the same file set, and the same `diffFiles` summary. Only the implementation of `src/access.ts` differs. The planted-defect expectation lives in scorer-owned metadata, never in the agent-facing prompt. Adding answer-revealing text destroys the corpus by measuring obedience rather than judgment.

The irrelevant-prior-work continuation scenario is a non-degradation check: unrelated supplied context must not prevent the agent from finding the current repository evidence. It is not contamination coverage and must not ban the unrelated marker from the response.

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
| `FRO_BOT_EVAL_OUTPUT` | Report path. Defaults to the gitignored `evals/output/eval-report.json`. |

The corpus runs the patched **harness** build, never stock `opencode-ai` from npm. The harness carries this project's upstream patch set, so an eval driven by the stock package measures a different system than the one that ships.

### Real-model runs

The original `clean-pr` / `planted-defect` pair has completed end to end against `anthropic/claude-sonnet-5`; provider/runtime duration is advisory and variable, not a stable timing promise. Providers whose stored credential is an OAuth record rather than an API key also need their auth plugin loaded; see `PROVIDER_AUTH_PLUGINS` in `runner.ts`. Copying `auth.json` alone is not enough, and the resulting failure looks like an opaque provider error rather than a missing exchange step.

Provisioning copies exactly one provider entry into the isolated home, never the whole host auth file, which typically holds credentials for several unrelated providers this run has no business reaching.

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
