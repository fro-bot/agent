// Gateway entry point.
//
// v1 sub-unit 4a establishes the package scaffold. Subsequent sub-units fill in:
//   - 4b: runtime-effect.ts (Effect adapter for @fro-bot/runtime)
//   - 4c: config.ts (env + secret reading)
//   - 4d: Discord client + slash command skeleton
//   - 4e: shutdown handler
//   - 4f: deploy/ (Docker Compose stack + mitmproxy)
//
// See packages/gateway/AGENTS.md for the Effect / Result<> boundary contract.

export const GATEWAY_VERSION = '0.0.0-development'
