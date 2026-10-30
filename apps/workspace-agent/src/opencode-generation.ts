/**
 * Which OpenCode generation this image runs, read from the one value the image bakes.
 *
 * `deploy/workspace.Dockerfile` sets `WORKSPACE_IMAGE_OPENCODE_VERSION` to the OPENCODE_VERSION it installed. A major
 * version of 2 or above selects the V2 supervised runner, proxy and disposer in `main.ts`; anything older, or no
 * value at all, selects the V1 ones. The image pin is the only switch. There is deliberately no operator setting
 * that could disagree with the binary, which is why the name sits outside the operator-facing
 * `WORKSPACE_OPENCODE_*` settings.
 *
 * The same value is reported on `/readyz` so the gateway picks its run loop from the workspace it attaches to,
 * never from a setting of its own.
 */

export const IMAGE_OPENCODE_VERSION_ENV = 'WORKSPACE_IMAGE_OPENCODE_VERSION'

/** A plain result shape: this module needs nothing from a result library. */
export type GenerationResult =
  {readonly success: true; readonly data: OpencodeGeneration} | {readonly success: false; readonly error: string}

export type OpencodeGeneration =
  /** `version` is absent for an image that does not set the variable. */
  {readonly kind: 'v1'; readonly version?: string} | {readonly kind: 'v2'; readonly version: string}

/**
 * `<major>.<minor>.<patch>` with an optional `-prerelease` or `+build` tail (`1.19.4+harness.5bde2635` is the V1
 * harness form). No leading `v` and no leading zeros: the Dockerfile passes OPENCODE_VERSION as is.
 */
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:[-+][0-9A-Z.+-]+)?$/i

export function readOpencodeGeneration(env: NodeJS.ProcessEnv): GenerationResult {
  const raw = env[IMAGE_OPENCODE_VERSION_ENV]?.trim()
  if (raw === undefined || raw === '') return {success: true, data: {kind: 'v1'}}

  const match = VERSION_PATTERN.exec(raw)
  if (match === null) {
    return {
      success: false,
      error: `${IMAGE_OPENCODE_VERSION_ENV} is set but is not an OpenCode version (expected e.g. 2.2.0)`,
    }
  }

  const major = Number(match[1])
  return {success: true, data: major >= 2 ? {kind: 'v2', version: raw} : {kind: 'v1', version: raw}}
}
