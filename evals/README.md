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

This distinction exists because real runs measured substantial infrastructure variance on the free shared endpoint: with `opencode/big-pickle`, `clean-pr` took about 73 seconds and then timed out at 300 seconds in separate runs, while `planted-defect` timed out at 120 seconds and passed in about 41 seconds. A future contributor collapsing these states back into a boolean `passed` is the main way this corpus degrades into a noisy artifact nobody trusts.

## Run it

Normal test runs do not start OpenCode and do not cost anything:

```bash
bunx vitest run evals/corpus.test.ts
```

Run the two live scenarios explicitly:

```bash
FRO_BOT_EVAL=1 bunx vitest run evals/corpus.test.ts
```

The default model is the free, credentialless `opencode/big-pickle`. Pin a different model with `FRO_BOT_EVAL_MODEL=provider/model`. Override the report location with `FRO_BOT_EVAL_OUTPUT=/path/to/report.json`; otherwise the report is written to the gitignored `evals/output/eval-report.json`.

The runner creates a temporary Git repository, isolates `HOME`/`XDG_*`, removes `GH_TOKEN` and `GITHUB_TOKEN`, and gives OpenCode no GitHub credential. It also loads no user plugins in the isolated environment. The fixture repository and temporary response files are cleaned up after each scenario.

## Add a scenario

1. Add one scenario file under `evals/scenarios/` with a unique id.
2. Use `createPullRequestOpenedEvent` for the event fixture and provide a small file map, changed-file summary, prompt, expected verdict, and optional planted-defect file path.
3. Add the scenario to `SCENARIOS` in `corpus.test.ts`.
4. Add only outcome gates that represent a real observable contract. Never add a method assertion to make a scenario easier to score.
5. Run the pure gate/helper tests and the gated corpus before changing the frozen baseline.

Keep the corpus small. Add a scenario only when a specific agent-facing change needs coverage that the existing scenarios cannot provide.
