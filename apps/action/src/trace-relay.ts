import process from 'node:process'
import {runTraceRelayChild} from '../../../packages/runtime/src/agent/trace-relay-child.js'

// The trace relay child: `dist/trace-relay.js`. It reads one framed config on stdin, prints one ready line, serves until stdin
// closes and then prints one report line. A deep import keeps the bundle to the relay and what it needs, not the whole
// runtime barrel.
const child = runTraceRelayChild({
  stdin: process.stdin,
  stdout: process.stdout,
  exit: code => {
    process.exitCode = code
    // Stdin would keep the loop alive; the timer is a bound on a stuck close and does not hold the process open.
    process.stdin.destroy()
    setTimeout(() => process.exit(code), 2000).unref()
  },
})

process.once('SIGTERM', child.requestShutdown)
process.once('SIGINT', child.requestShutdown)
// A bug must not print a stack or leave a half-working relay: say so with a fixed line and stop.
process.on('uncaughtException', () => child.fail('internal'))
process.on('unhandledRejection', () => child.fail('internal'))
