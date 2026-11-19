/**
 * The plugin's one log channel. `Plugin.Context` has no logger, and stdout carries the host's protocol in `serve --stdio`,
 * so a line goes to stderr, where the server's own diagnostics go. Never throws, and takes only fixed text: callers pass
 * no setting, header or error message.
 */

import process from 'node:process'

export function logPluginLine(message: string): void {
  try {
    process.stderr.write(`[fro-bot/opencode-plugin] ${message}\n`)
  } catch {
    // A closed stderr must not fail the plugin.
  }
}
