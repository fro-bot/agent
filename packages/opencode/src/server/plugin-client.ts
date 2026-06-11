import { Context } from "effect"

export const PLUGIN_CLIENT_HEADER = "x-opencode-plugin-client"

export class PluginClientRuntime extends Context.Service<
  PluginClientRuntime,
  {
    readonly url: () => URL | undefined
    readonly fetch: (request: Request) => Response | Promise<Response>
  }
>()("@opencode/PluginClientRuntime") {}
