import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'
import {parse} from 'yaml'
import {
  DEFAULT_DEDUP_WINDOW_MS,
  DEFAULT_S3_PREFIX,
  DEFAULT_SERVER_BOOTSTRAP_TIMEOUT_MS,
  DEFAULT_SESSION_RETENTION,
  DEFAULT_TIMEOUT_MS,
} from '../src/shared/constants.js'
import {DEFAULT_OMO_SLIM_PRESET} from '../src/shared/types.js'

// action.yaml declares a literal `default:` for several inputs whose "unset" fallback in
// src/harness/config/inputs.ts is a named constant from src/shared/constants.ts or
// src/shared/types.ts. A literal default in the metadata means core.getInput() never
// returns an empty string for that input in a real Action run, so the TypeScript fallback
// branch is defense-in-depth rather than the live path — but nothing asserts the two
// values actually agree. A drift here silently changes every run's behavior for that
// input while every existing unit test still passes, because those tests exercise the
// TypeScript fallback directly (mocked core.getInput returning ''), never the YAML value.
//
// Every other action.yaml `default:` was checked against inputs.ts and shared/constants.ts
// (and shared/types.ts for the one non-numeric case): boolean flags (s3-backup, enable-omo,
// enable-omo-slim, skip-cache, s3-allow-insecure-endpoint) and string flags with an inline
// literal fallback (response-mode: 'github', review-skip-label -> null when empty,
// brokered-push-extra-paths: '') have no backing named constant to drift against, so they
// are not part of this shape and are intentionally excluded.
const ACTION_YAML_PATH = join(import.meta.dirname, '..', 'action.yaml')
const CONSTANTS_PATH = 'src/shared/constants.ts (re-exports @fro-bot/runtime)'
const TYPES_PATH = 'src/shared/types.ts (re-exports @fro-bot/runtime)'

interface ActionInputSchema {
  readonly default?: unknown
}

interface ActionYamlSchema {
  readonly inputs?: Record<string, ActionInputSchema>
}

interface DuplicatedDefault {
  readonly inputName: string
  readonly constantName: string
  readonly constantSource: string
  readonly constantValue: string | number
}

const DUPLICATED_DEFAULTS: readonly DuplicatedDefault[] = [
  {
    inputName: 'session-retention',
    constantName: 'DEFAULT_SESSION_RETENTION',
    constantSource: CONSTANTS_PATH,
    constantValue: DEFAULT_SESSION_RETENTION,
  },
  {
    inputName: 's3-prefix',
    constantName: 'DEFAULT_S3_PREFIX',
    constantSource: CONSTANTS_PATH,
    constantValue: DEFAULT_S3_PREFIX,
  },
  {
    inputName: 'timeout',
    constantName: 'DEFAULT_TIMEOUT_MS',
    constantSource: CONSTANTS_PATH,
    constantValue: DEFAULT_TIMEOUT_MS,
  },
  {
    inputName: 'server-bootstrap-timeout',
    constantName: 'DEFAULT_SERVER_BOOTSTRAP_TIMEOUT_MS',
    constantSource: CONSTANTS_PATH,
    constantValue: DEFAULT_SERVER_BOOTSTRAP_TIMEOUT_MS,
  },
  {
    inputName: 'dedup-window',
    constantName: 'DEFAULT_DEDUP_WINDOW_MS',
    constantSource: CONSTANTS_PATH,
    constantValue: DEFAULT_DEDUP_WINDOW_MS,
  },
  {
    inputName: 'omo-slim-preset',
    constantName: 'DEFAULT_OMO_SLIM_PRESET',
    constantSource: TYPES_PATH,
    constantValue: DEFAULT_OMO_SLIM_PRESET,
  },
]

function readActionYamlInputs(): Record<string, ActionInputSchema> {
  const parsed = parse(readFileSync(ACTION_YAML_PATH, 'utf8')) as ActionYamlSchema
  if (parsed.inputs == null) {
    throw new Error('action.yaml: expected an `inputs` mapping')
  }
  return parsed.inputs
}

describe('action.yaml literal defaults agree with their TypeScript constants', () => {
  const inputs = readActionYamlInputs()

  it.each(DUPLICATED_DEFAULTS)(
    '$inputName: action.yaml default matches $constantName',
    ({inputName, constantName, constantSource, constantValue}) => {
      // #given the committed action.yaml metadata default for this input
      const input = inputs[inputName]
      if (input == null || input.default === undefined) {
        throw new Error(
          `action.yaml: input "${inputName}" is missing a \`default:\` \u2014 either restore it or remove ` +
            `this input from DUPLICATED_DEFAULTS in scripts/action-input-defaults-guard.test.ts if the two ` +
            `values are no longer meant to agree.`,
        )
      }

      // #when comparing it against the TypeScript constant that governs the same fallback
      // in src/harness/config/inputs.ts. action.yaml values are always strings (YAML
      // scalars under `inputs.*.default` are read as GitHub Actions input strings), so a
      // numeric constant is compared by parsing the YAML string back to a number rather
      // than stringifying the constant \u2014 that keeps '5000.0' or similar variants from
      // silently passing.
      const yamlDefault = String(input.default)
      const matches =
        typeof constantValue === 'number' ? Number(yamlDefault) === constantValue : yamlDefault === constantValue

      // #then a mismatch names both locations and what to change, rather than just failing
      if (!matches) {
        throw new Error(
          `action.yaml input "${inputName}" declares default: '${yamlDefault}', but ${constantName} ` +
            `(${constantSource}) is ${JSON.stringify(constantValue)}. These must agree \u2014 update ` +
            `action.yaml's default or ${constantName} so the metadata default and the TypeScript ` +
            `fallback describe the same behavior.`,
        )
      }
      expect(matches).toBe(true)
    },
  )
})
