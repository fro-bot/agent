import type {GatewayLogger} from '../discord/client.js'

import {describe, expect, it, vi} from 'vitest'
import {toRuntimeLogger} from './runtime-logger.js'

function createGatewayLoggerSpy() {
  const logger = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()} satisfies GatewayLogger
  return logger
}

describe('toRuntimeLogger', () => {
  it.each([
    {runtimeLevel: 'debug', gatewayLevel: 'debug'},
    {runtimeLevel: 'info', gatewayLevel: 'info'},
    {runtimeLevel: 'warning', gatewayLevel: 'warn'},
    {runtimeLevel: 'error', gatewayLevel: 'error'},
  ] as const)(
    'routes runtime $runtimeLevel to gateway $gatewayLevel with (context, message) argument order',
    ({runtimeLevel, gatewayLevel}) => {
      // #given a gateway logger and its runtime adapter
      const gateway = createGatewayLoggerSpy()
      const runtime = toRuntimeLogger(gateway)

      // #when the runtime logger is called as (message, context)
      runtime[runtimeLevel]('something happened', {runId: 'run-1'})

      // #then only the matching gateway level is called, as (context, message)
      expect(gateway[gatewayLevel]).toHaveBeenCalledExactlyOnceWith({runId: 'run-1'}, 'something happened')
      const otherLevels = (['debug', 'info', 'warn', 'error'] as const).filter(level => level !== gatewayLevel)
      expect(otherLevels.map(level => gateway[level].mock.calls.length)).toEqual([0, 0, 0])
    },
  )

  it.each(['debug', 'info', 'warning', 'error'] as const)(
    'passes an empty context object to gateway when runtime %s omits the context',
    runtimeLevel => {
      // #given a gateway logger and its runtime adapter
      const gateway = createGatewayLoggerSpy()
      const runtime = toRuntimeLogger(gateway)

      // #when the runtime logger is called without a context
      runtime[runtimeLevel]('no context')

      // #then the gateway receives {} rather than undefined
      const gatewayLevel = runtimeLevel === 'warning' ? 'warn' : runtimeLevel
      expect(gateway[gatewayLevel]).toHaveBeenCalledExactlyOnceWith({}, 'no context')
    },
  )
})
