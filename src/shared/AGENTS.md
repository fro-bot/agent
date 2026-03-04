# SHARED LAYER (Layer 0)

Pure types, utilities, and constants with zero upward dependencies.

## WHERE TO LOOK

| Component       | File            | Responsibility                                                 |
| --------------- | --------------- | -------------------------------------------------------------- |
| **Types**       | `types.ts`      | Core interfaces: ActionInputs, TokenUsage, CacheResult (112 L) |
| **Constants**   | `constants.ts`  | Shared configuration (DEFAULT_AGENT, DEFAULT_MODEL) (37 L)     |
| **Logger**      | `logger.ts`     | JSON logging with auto-redaction (123 L)                       |
| **Environment** | `env.ts`        | GitHub Actions environment variable readers (85 L)             |
| **Errors**      | `errors.ts`     | Error conversion and message extraction (21 L)                 |
| **Validation**  | `validation.ts` | Input validation utilities (32 L)                              |
| **Format**      | `format.ts`     | String formatting helpers (17 L)                               |
| **Async**       | `async.ts`      | Async utilities (sleep) (11 L)                                 |
| **Console**     | `console.ts`    | Console output helpers for CI (36 L)                           |
| **Paths**       | `paths.ts`      | Path resolution utilities (9 L)                                |

## LAYER RULES

- MUST NOT import from `services/`, `features/`, or `harness/`
- Pure functions only — no side effects except logger
- No external dependencies beyond Node.js built-ins and `@actions/core`
