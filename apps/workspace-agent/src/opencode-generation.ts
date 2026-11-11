/**
 * The OpenCode version this image runs, read from the one value the image bakes.
 *
 * `deploy/workspace-entrypoint.sh` exports `WORKSPACE_IMAGE_OPENCODE_VERSION` from the file the Dockerfile's version gate
 * wrote with the version it installed, and the image refuses to build unless that is the pinned V2 version. The
 * workspace starts only on a V2 version: an unset value, a V1 value or a malformed one is fatal with a named error. The
 * image pin is the only source. There is deliberately no operator setting that could disagree with the binary, which is
 * why the name sits outside the operator-facing `WORKSPACE_OPENCODE_*` settings.
 *
 * The same value is reported on `/readyz`; the gateway admits a run only when it is a V2 version.
 */

export const IMAGE_OPENCODE_VERSION_ENV = 'WORKSPACE_IMAGE_OPENCODE_VERSION'

/** A plain result shape: this module needs nothing from a result library. */
export type ImageVersionResult =
  | {readonly success: true; readonly data: {readonly version: string}}
  | {readonly success: false; readonly error: string}

/**
 * `<major>.<minor>.<patch>` with an optional `-prerelease` or `+build` tail (`1.19.5+harness.bf7f7dfe` is the retired
 * V1 harness form). No leading `v` and no leading zeros: the Dockerfile passes OPENCODE_VERSION as is.
 */
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:[-+][0-9A-Z.+-]+)?$/i

export function readImageOpencodeVersion(env: NodeJS.ProcessEnv): ImageVersionResult {
  const raw = env[IMAGE_OPENCODE_VERSION_ENV]?.trim()
  if (raw === undefined || raw === '') {
    return {
      success: false,
      error: `${IMAGE_OPENCODE_VERSION_ENV} is not set: the image must bake the OpenCode V2 version it installed (see packages/runtime/src/shared/opencode-v2-pin.json)`,
    }
  }

  const match = VERSION_PATTERN.exec(raw)
  if (match === null) {
    return {
      success: false,
      error: `${IMAGE_OPENCODE_VERSION_ENV} is set but is not an OpenCode version (expected e.g. 2.2.6)`,
    }
  }

  if (Number(match[1]) < 2) {
    return {
      success: false,
      error: `${IMAGE_OPENCODE_VERSION_ENV} is ${raw}: the workspace runs OpenCode V2 only (major 2 or higher)`,
    }
  }
  return {success: true, data: {version: raw}}
}
