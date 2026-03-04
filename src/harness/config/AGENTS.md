# HARNESS CONFIGURATION

**Location:** `src/harness/config/`

Action input parsing, output definitions, and oMo provider configuration.

## WHERE TO LOOK

| Component         | File               | Responsibility                               |
| ----------------- | ------------------ | -------------------------------------------- |
| **Inputs**        | `inputs.ts`        | Action input parsing and validation (224 L)  |
| **oMo Providers** | `omo-providers.ts` | oMo provider JSON generation (62 L)          |
| **Outputs**       | `outputs.ts`       | Action output definitions and writers (13 L) |
| **State Keys**    | `state-keys.ts`    | Harness state key constants (19 L)           |

## KEY EXPORTS

- `parseActionInputs(logger)`: Reads and validates all action inputs from `core.getInput`.
- `parseOmoProviders(authJson, logger)`: Converts `auth-json` input into oMo provider config.
- `setOutput(name, value, logger)`: Writes to GitHub Actions outputs (`core.setOutput`).

## PATTERNS

- **Strict Validation**: Fails early if required inputs (e.g., `github-token`, `auth-json`) are missing.
- **Result Pattern**: Returns `Result<ActionInputs>` for clean error handling.
- **Environment Mapping**: Translates GitHub Actions environment to `ActionInputs` interface.
- **Provider Resolution**: Auto-detects LLM providers from `auth-json` (RFC-012).

## ANTI-PATTERNS

- **Hardcoded Default Models**: Use `DEFAULT_MODEL` from `shared/constants.ts`.
- **Side Effects during Parse**: Input parsing should be pure (except logger).
- **Silent Validation Fail**: Always return descriptive errors for invalid inputs.
