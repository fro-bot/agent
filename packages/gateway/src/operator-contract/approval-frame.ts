/**
 * Approval frame contract for the operator run-stream.
 *
 * Carries a pending tool-permission request to an operator subscribed to a
 * run's SSE stream. Two frame modes:
 *
 * - **Open frame** (`settled: false`): emitted when the engine raises a
 *   permission gate. The browser should display an approval prompt.
 * - **Settle/clear frame** (`settled: true`): emitted when the request is
 *   resolved (approved or rejected). The browser should dismiss the prompt.
 *
 * `command` and `filepath` are already bounded (length-capped + control-char
 * stripped) by the caller before the frame is built. The manager does not
 * re-bound them.
 */

// ---------------------------------------------------------------------------
// ApprovalFrameData — operator-facing approval frame payload
// ---------------------------------------------------------------------------

/**
 * Payload for an approval frame delivered over the operator run-stream.
 *
 * Open frames (`settled: false`) carry the full request detail so the browser
 * can render an approval prompt. Settle/clear frames (`settled: true`) carry
 * only `requestID` and `settled: true` so the browser can dismiss the prompt;
 * the other fields are absent on settle frames.
 *
 * `command` and `filepath` are pre-bounded (length-capped + control-char
 * stripped) by the frame-build site before being placed here.
 */
export type ApprovalFrameData =
  | {
      /** The unique request identifier — matches the registry entry. */
      readonly requestID: string
      /** Gate category, e.g. `bash`, `external_directory`, `edit`. */
      readonly permission: string
      /**
       * Bounded command string (for `bash` gates). Present only when the
       * engine supplied it and the value is non-empty after bounding.
       */
      readonly command?: string
      /**
       * Bounded filepath string (for `external_directory`/`edit` gates).
       * Present only when the engine supplied it and the value is non-empty
       * after bounding.
       */
      readonly filepath?: string
      /** Discriminant: false for open (pending) frames. */
      readonly settled: false
    }
  | {
      /** The unique request identifier — matches the registry entry. */
      readonly requestID: string
      /** Discriminant: true for settle/clear frames. */
      readonly settled: true
    }
