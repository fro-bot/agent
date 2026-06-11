/**
 * Shared guild-command pipeline factory.
 *
 * Every guild-bound slash command shares the same entry sequence:
 *   optional preDefer hook → guild-null guard → deferReply → auth policy → work
 *
 * The factory owns the failure path: if anything from defer onward throws or
 * fails, the deferred reply is edited with a generic internal-error message
 * before re-failing — so the user is never left at "thinking…" until the
 * interaction token expires.
 *
 * Auth is fail-closed by contract: authorize implementations must return
 * `{authorized: false}` on errors rather than propagating them. An auth
 * error that escapes as an Effect failure will be caught by the catchAll and
 * produce an internal-error reply, which is safe but misleading — callers
 * should handle auth errors internally and deny explicitly.
 */

import type {ChatInputCommandInteraction, Guild} from 'discord.js'

import type {GatewayLogger} from '../client.js'

import {Cause, Effect} from 'effect'
import {withLogContext} from '../client.js'
import {editInteraction, replyInteraction} from '../io.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal context passed to `preDefer`.
 * `guild` is intentionally absent — preDefer runs before the guild-null guard
 * and must not rely on guild being non-null.
 */
export interface PreDeferCtx {
  readonly interaction: ChatInputCommandInteraction
  readonly log: GatewayLogger
}

/**
 * Context threaded through authorize and work.
 * `guild` is non-null — the pipeline guards before passing ctx to any hook.
 */
export interface GuildCommandCtx {
  readonly interaction: ChatInputCommandInteraction
  readonly guild: Guild
  readonly log: GatewayLogger
}

/**
 * Authorization decision returned by `authorize`.
 *
 * Fail-closed contract: authorize implementations must return
 * `{authorized: false}` on errors — never propagate auth errors as Effect
 * failures. An escaped auth failure lands in the catchAll and produces an
 * internal-error reply, which is safe but misleading.
 */
export type AuthDecision = {readonly authorized: true} | {readonly authorized: false; readonly copy?: string}

/**
 * Signal returned by `preDefer` to control pipeline continuation.
 * `{proceed: false}` means the hook already replied and the pipeline should stop.
 */
export type PreDeferSignal = {readonly proceed: true} | {readonly proceed: false}

/**
 * Spec for a guild-bound slash command.
 *
 * - `name` — used to scope the log context (`withLogContext({command: name})`).
 * - `preDefer` — optional hook that runs before the guild-null guard and defer.
 *   Receives a `PreDeferCtx` (no `guild`) because it runs before the guard.
 *   Must reply ephemerally itself when returning `{continue: false}`.
 * - `authorize` — auth policy; runs after defer. Fail-closed: return denial on errors.
 * - `work` — the command body; runs after a successful auth decision.
 * - `denialCopy` — default denial message when `authorize` returns no `copy`.
 * - `serverOnlyCopy` — message for the guild-null guard reply.
 */
export interface GuildCommandSpec {
  readonly name: string
  readonly preDefer?: (ctx: PreDeferCtx) => Effect.Effect<PreDeferSignal, never>
  readonly authorize: (ctx: GuildCommandCtx) => Effect.Effect<AuthDecision, never>
  readonly work: (ctx: GuildCommandCtx) => Effect.Effect<void, Error>
  readonly denialCopy?: string
  readonly serverOnlyCopy?: string
}

/**
 * Dependencies required by the pipeline.
 * Kept minimal — only what the pipeline itself needs.
 */
export interface GuildCommandDeps {
  readonly gatewayLogger: GatewayLogger
}

// ---------------------------------------------------------------------------
// Shared copy constants
// ---------------------------------------------------------------------------

const DEFAULT_SERVER_ONLY_COPY = 'This command must be used in a server.'
const DEFAULT_DENIAL_COPY = 'You do not have permission to use this command.'
export const INTERNAL_ERROR_COPY = 'An internal error occurred. Please try again.'

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a guild-command executor from a spec and deps.
 *
 * Returns a `(interaction) => Effect<void, Error>` that is slot-compatible
 * with the subcommand router in `fro-bot.ts`.
 *
 * Pipeline (in order):
 *   1. `preDefer(ctx)` — optional; may short-circuit with its own reply.
 *   2. Guild-null guard — immediate ephemeral reply, stops before defer.
 *   3. `deferReply({ephemeral: true})` — a failure here fails the Effect.
 *   4. `authorize(ctx)` — denial edits the deferred reply and stops.
 *   5. `work(ctx)` — invoked inside Effect.suspend so sync throws funnel to catchAll.
 *
 * The catchAll covers steps 3–5 only (guard replies at 1–2 are outside it).
 * On any failure it edits the deferred reply with the internal-error copy,
 * then re-fails so dispatchCommand's logger still sees the error.
 */
export function makeGuildCommand(
  spec: GuildCommandSpec,
  deps: GuildCommandDeps,
): (interaction: ChatInputCommandInteraction) => Effect.Effect<void, Error> {
  return (interaction: ChatInputCommandInteraction): Effect.Effect<void, Error> => {
    return Effect.gen(function* () {
      // Build a scoped logger once — threaded to all hooks so every log line
      // carries the command name without manual threading at each call site.
      const log = withLogContext(deps.gatewayLogger, {command: spec.name})

      // Step 1: optional preDefer hook (e.g. rate-limit check).
      // Runs before the guild-null guard and defer. If it signals stop, the
      // hook has already replied and we exit cleanly.
      if (spec.preDefer !== undefined) {
        const preDeferCtx: PreDeferCtx = {interaction, log}
        const signal = yield* spec.preDefer(preDeferCtx)
        if (signal.proceed === false) {
          return
        }
      }

      // Step 2: guild-null guard — immediate ephemeral reply, no defer.
      // This reply is OUTSIDE the catchAll below — no double-reply risk.
      const guild = interaction.guild
      if (guild === null) {
        yield* replyInteraction(
          interaction,
          {content: spec.serverOnlyCopy ?? DEFAULT_SERVER_ONLY_COPY, ephemeral: true},
          log,
        )
        return
      }

      // ctx is now safe to pass to authorize and work — guild is non-null.
      const ctx: GuildCommandCtx = {interaction, guild, log}

      // Steps 3–5 are wrapped in the catchAll so any failure edits the deferred
      // reply before re-failing. The guard reply above is intentionally outside
      // this scope to prevent double-reply.
      yield* Effect.gen(function* () {
        // Step 3: defer — acks the interaction before any async work.
        // A failure here means we cannot edit the reply, so we re-fail immediately
        // (the catchAll will attempt editReply, which will fail silently via io.ts,
        // and then re-fail with the original error).
        yield* Effect.tryPromise({
          try: async () => interaction.deferReply({ephemeral: true}),
          catch: error => (error instanceof Error ? error : new Error(String(error))),
        })

        // Step 4: auth policy — runs after defer so REST calls inside authorize
        // don't race the 3 s interaction-token window.
        const decision = yield* spec.authorize(ctx)
        if (decision.authorized === false) {
          const copy = decision.copy ?? spec.denialCopy ?? DEFAULT_DENIAL_COPY
          yield* editInteraction(interaction, {content: copy}, log)
          return
        }

        // Step 5: work — invoked inside Effect.suspend so synchronous throws
        // during Effect construction funnel into the catchAll alongside async
        // failures and Effect.fail calls. Effect.suspend converts sync throws
        // to defects (Die cause); catchAllCause normalizes them to typed Error
        // failures so the outer catchAll sees them uniformly.
        //
        // Interrupt guard: if the cause is interrupt-only, re-fail with the
        // original cause so the interrupt propagates past Effect.catchAll
        // (catchAll only catches typed failures, so failCause with an interrupt
        // cause skips the reply-edit path — the fiber is interrupted cleanly).
        yield* Effect.suspend(() => spec.work(ctx)).pipe(
          Effect.catchAllCause(cause => {
            if (Cause.isInterruptedOnly(cause)) {
              return Effect.failCause(cause)
            }
            const squashed = Cause.squash(cause)
            return Effect.fail(squashed instanceof Error ? squashed : new Error(String(squashed)))
          }),
        )
      }).pipe(
        // Shared failure path (defer-onward scope only).
        // Edits the deferred reply so the user is not left at "thinking…",
        // then re-fails so dispatchCommand's logger still sees the error.
        //
        // editInteraction returns a Result — capture it so operators can
        // distinguish "user saw internal error" from "user saw nothing".
        Effect.catchAll(error =>
          Effect.gen(function* () {
            const editResult = yield* editInteraction(interaction, {content: INTERNAL_ERROR_COPY}, log)
            if (editResult.success === false) {
              log.error({err: editResult.error.message}, 'guild-command: failed to deliver internal-error reply')
            }
            return yield* Effect.fail(error)
          }),
        ),
      )
    })
  }
}
