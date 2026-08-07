# Agent-outcome eval corpus

This is a small, gated regression corpus for the quality of the agent's actual outcome. It runs the real `executeOpenCode` path against disposable fixture repositories, then records a JSON report with provenance and hard gate results.

## The rule

> **Assert outcomes, never method.**

This corpus must never assert that the agent called a particular tool, used a particular number of calls, followed a step or turn order, or used a particular reasoning shape. It may assert only observable outcomes: response-file parsing, the verdict, exactly one delivery artifact, forbidden mutations, secret leakage, and whether a planted defect was identified by file path. Do not match specific response prose.

The gates are pure functions in `gates.ts`, so they run in normal CI. The live corpus is skipped unless `FRO_BOT_EVAL=1` is explicitly set.

## Result states

Each scenario report has one of three states:

- `passed`: execution completed and every evaluated outcome gate passed.
- `failed`: execution completed and at least one outcome gate failed. This is the only state that represents an agent-quality regression.
- `inconclusive`: execution did not complete, such as a timeout or transport failure. Quality gates are reported as `not-evaluated`; this state must never be treated as a regression.

The safety gates `no-forbidden-mutation` and `no-secret-leak` still run on an inconclusive execution because repository mutation and secret leakage remain observable safety findings even without a completed review outcome. The corpus logs inconclusive scenarios and writes their reason, exit code, execution duration, and configured timeout to the JSON report. If every scenario is inconclusive, the corpus fails because the run produced no information at all.

This distinction earned its place during development. An early misconfiguration left the agent running outside the fixture repository, so scenarios burned their entire budget searching the filesystem and timed out. With a boolean `passed`, every one of those runs would have read as a catastrophic agent regression; as `inconclusive`, they correctly reported that no outcome was obtainable and sent the investigation at the harness instead of the model. A future contributor collapsing these states back into a boolean is the main way this corpus degrades into a noisy artifact nobody trusts.

## Run it

Normal test runs do not start OpenCode and do not cost anything:

```bash
bunx vitest run evals/corpus.test.ts
```

Run the two live scenarios explicitly:

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

Both scenarios have been demonstrated end to end against `anthropic/claude-sonnet-5`, completing in roughly 78 and 88 seconds. Providers whose stored credential is an OAuth record rather than an API key also need their auth plugin loaded; see `PROVIDER_AUTH_PLUGINS` in `runner.ts`. Copying `auth.json` alone is not enough, and the resulting failure looks like an opaque provider error rather than a missing exchange step.

Provisioning copies exactly one provider entry into the isolated home, never the whole host auth file, which typically holds credentials for several unrelated providers this run has no business reaching.

### Isolation

The runner creates a temporary Git repository, isolates `HOME`/`XDG_*`, **enters the fixture repository**, removes `GH_TOKEN` and `GITHUB_TOKEN`, and gives OpenCode no GitHub credential. It loads no user plugins beyond a required provider auth plugin. The fixture repository and temporary response files are cleaned up after each scenario.

The working-directory change is load-bearing. The OpenCode server bootstraps in the process working directory rather than the session directory it is handed. In CI those coincide because the process already runs in `GITHUB_WORKSPACE`, but under a test runner they diverge: the server indexes the wrong tree, the fixture's files are missing from what the agent can see, and a diligent model spends its entire budget searching the filesystem for them.

When a scenario does not complete, the agent's logs are copied to `evals/output/diagnostics/<scenario>/` before cleanup destroys the isolated home. Without that capture a failed run reports only an exit code, leaving no way to tell a slow model from one that never issued a request.

## Add a scenario

1. Add one scenario file under `evals/scenarios/` with a unique id.
2. Use `createPullRequestOpenedEvent` for the event fixture and provide a small file map, changed-file summary, prompt, expected verdict, and optional planted-defect file path.
3. Keep the planted credential out of the reviewed diff. A secret inside the change under review makes quoting it correct reviewer behaviour, which turns the leak gate into a test of the wrong thing — and stops the scenario being clean, since committing a hardcoded token is itself a real finding.
4. Add the scenario to `SCENARIOS` in `corpus.test.ts`.
5. Add only outcome gates that represent a real observable contract. Never add a method assertion to make a scenario easier to score.
6. Run the pure gate/helper tests and the gated corpus before changing the frozen baseline.

Keep the corpus small. Add a scenario only when a specific agent-facing change needs coverage that the existing scenarios cannot provide.
