import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { Effect, Exit, Layer } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { WorkspaceRouteContext } from "./workspace-routing"

export class InstanceContextMiddleware extends HttpApiMiddleware.Service<
  InstanceContextMiddleware,
  {
    requires: WorkspaceRouteContext
  }
>()("@opencode/ExperimentalHttpApiInstanceContext") {}

function decode(input: string): string {
  try {
    return decodeURIComponent(input)
  } catch {
    return input
  }
}

function provideInstanceContext<E>(
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E>,
  store: InstanceStore.Interface,
): Effect.Effect<HttpServerResponse.HttpServerResponse, E, WorkspaceRouteContext> {
  return Effect.gen(function* () {
    const route = yield* WorkspaceRouteContext
    const input = { directory: decode(route.directory) }
    if (route.pluginClient) {
      const exit = yield* store.loadPluginClient(input).pipe(Effect.exit)
      if (Exit.isFailure(exit)) {
        return HttpServerResponse.text(
          `Plugin client request cannot enter instance ${input.directory} while its plugins are still loading`,
          { status: 409, contentType: "text/plain; charset=utf-8" },
        )
      }
      return yield* effect.pipe(
        Effect.provideService(InstanceRef, exit.value),
        Effect.provideService(WorkspaceRef, route.workspaceID),
      )
    }
    const ctx = yield* store.load(input)
    return yield* effect.pipe(Effect.provideService(InstanceRef, ctx), Effect.provideService(WorkspaceRef, route.workspaceID))
  })
}

export const instanceContextLayer = Layer.effect(
  InstanceContextMiddleware,
  Effect.gen(function* () {
    const store = yield* InstanceStore.Service
    return InstanceContextMiddleware.of((effect) => provideInstanceContext(effect, store))
  }),
)
