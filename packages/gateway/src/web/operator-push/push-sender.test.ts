import type {PushSubscription} from 'web-push'
import {afterEach, describe, expect, it, vi} from 'vitest'

const VAPID_CONFIG = {
  subject: 'mailto:ops@example.com',
  publicKey: 'public-key',
  privateKey: 'private-key',
}

const SUBSCRIPTION: PushSubscription = {
  endpoint: 'https://push.example.com/send/abc',
  keys: {p256dh: 'p256dh-value', auth: 'auth-value'},
}

function createLogger() {
  return {warn: vi.fn()}
}

describe('createPushSender', () => {
  afterEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
  })

  // #given webpush resolves with a 2xx status
  // #when sendNotification is called
  // #then the outcome is accepted with the status code
  it('maps a 2xx response to accepted', async () => {
    vi.doMock('web-push', () => ({
      default: {sendNotification: vi.fn(async () => ({statusCode: 201, body: '', headers: {}}))},
      WebPushError: class WebPushError extends Error {},
    }))
    const {createPushSender} = await import('./push-sender.js')
    const sender = createPushSender({logger: createLogger()})
    const result = await sender.sendNotification(SUBSCRIPTION, '{}', VAPID_CONFIG)
    expect(result).toEqual({outcome: 'accepted', statusCode: 201})
  })

  // #given webpush rejects with a 410 WebPushError (gone)
  // #when sendNotification is called
  // #then the outcome is dead-subscription
  it('maps a 410 rejection to dead-subscription', async () => {
    const {createFakeWebPushModule} = buildFakeModule(410)
    vi.doMock('web-push', () => createFakeWebPushModule)
    const {createPushSender} = await import('./push-sender.js')
    const sender = createPushSender({logger: createLogger()})
    const result = await sender.sendNotification(SUBSCRIPTION, '{}', VAPID_CONFIG)
    expect(result).toEqual({outcome: 'dead-subscription', statusCode: 410})
  })

  // #given webpush rejects with a 404 WebPushError (not found)
  // #when sendNotification is called
  // #then the outcome is dead-subscription
  it('maps a 404 rejection to dead-subscription', async () => {
    const {createFakeWebPushModule} = buildFakeModule(404)
    vi.doMock('web-push', () => createFakeWebPushModule)
    const {createPushSender} = await import('./push-sender.js')
    const sender = createPushSender({logger: createLogger()})
    const result = await sender.sendNotification(SUBSCRIPTION, '{}', VAPID_CONFIG)
    expect(result).toEqual({outcome: 'dead-subscription', statusCode: 404})
  })

  // #given webpush rejects with a 429 WebPushError (rate limited)
  // #when sendNotification is called
  // #then the outcome is retryable
  it('maps a 429 rejection to retryable', async () => {
    const {createFakeWebPushModule} = buildFakeModule(429)
    vi.doMock('web-push', () => createFakeWebPushModule)
    const {createPushSender} = await import('./push-sender.js')
    const sender = createPushSender({logger: createLogger()})
    const result = await sender.sendNotification(SUBSCRIPTION, '{}', VAPID_CONFIG)
    expect(result).toEqual({outcome: 'retryable', statusCode: 429})
  })

  // #given webpush rejects with a 500 WebPushError (server error)
  // #when sendNotification is called
  // #then the outcome is retryable
  it('maps a 500 rejection to retryable', async () => {
    const {createFakeWebPushModule} = buildFakeModule(500)
    vi.doMock('web-push', () => createFakeWebPushModule)
    const {createPushSender} = await import('./push-sender.js')
    const sender = createPushSender({logger: createLogger()})
    const result = await sender.sendNotification(SUBSCRIPTION, '{}', VAPID_CONFIG)
    expect(result).toEqual({outcome: 'retryable', statusCode: 500})
  })

  // #given webpush rejects with a 413 WebPushError (payload too large)
  // #when sendNotification is called
  // #then the outcome is payload-too-large with no status code
  it('maps a 413 rejection to payload-too-large', async () => {
    const {createFakeWebPushModule} = buildFakeModule(413)
    vi.doMock('web-push', () => createFakeWebPushModule)
    const {createPushSender} = await import('./push-sender.js')
    const sender = createPushSender({logger: createLogger()})
    const result = await sender.sendNotification(SUBSCRIPTION, '{}', VAPID_CONFIG)
    expect(result).toEqual({outcome: 'payload-too-large'})
  })

  // #given webpush rejects with an unrecognized WebPushError status code
  // #when sendNotification is called
  // #then the outcome is error, and nothing sensitive is logged
  it('maps an unrecognized status code to error', async () => {
    const {createFakeWebPushModule} = buildFakeModule(400)
    vi.doMock('web-push', () => createFakeWebPushModule)
    const {createPushSender} = await import('./push-sender.js')
    const logger = createLogger()
    const sender = createPushSender({logger})
    const result = await sender.sendNotification(SUBSCRIPTION, '{}', VAPID_CONFIG)
    expect(result).toEqual({outcome: 'error'})
    for (const call of logger.warn.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(SUBSCRIPTION.endpoint)
      expect(JSON.stringify(call)).not.toContain('auth-value')
      expect(JSON.stringify(call)).not.toContain('p256dh-value')
    }
  })

  // #given webpush throws a generic (non-WebPushError) error
  // #when sendNotification is called
  // #then the outcome is error and a coarse warning is logged without sensitive detail
  it('maps a thrown generic error to error and coarse-logs it', async () => {
    vi.doMock('web-push', () => ({
      default: {
        sendNotification: vi.fn(async () => {
          throw new Error('network reset')
        }),
      },
      WebPushError: class WebPushError extends Error {},
    }))
    const {createPushSender} = await import('./push-sender.js')
    const logger = createLogger()
    const sender = createPushSender({logger})
    const result = await sender.sendNotification(SUBSCRIPTION, '{}', VAPID_CONFIG)
    expect(result).toEqual({outcome: 'error'})
    expect(logger.warn).toHaveBeenCalledTimes(1)
    const [context, message] = logger.warn.mock.calls[0] as [Record<string, unknown>, string]
    expect(JSON.stringify(context)).not.toContain(SUBSCRIPTION.endpoint)
    expect(message).not.toContain(SUBSCRIPTION.endpoint)
  })

  // #given the underlying web-push call is invoked
  // #when sendNotification is called
  // #then options.agent is set and options.proxy is NEVER set (web-push ignores agent when proxy is set)
  it('always passes an agent and never sets proxy', async () => {
    const sendNotification = vi.fn(async (_sub: unknown, _payload: unknown, _options: unknown) => ({
      statusCode: 201,
      body: '',
      headers: {},
    }))
    vi.doMock('web-push', () => ({
      default: {sendNotification},
      WebPushError: class WebPushError extends Error {},
    }))
    const {createPushSender} = await import('./push-sender.js')
    const sender = createPushSender({logger: createLogger()})
    await sender.sendNotification(SUBSCRIPTION, '{}', VAPID_CONFIG)
    expect(sendNotification).toHaveBeenCalledTimes(1)
    const options = sendNotification.mock.calls[0]?.[2] as Record<string, unknown>
    expect(options.agent).toBeDefined()
    expect(options.proxy).toBeUndefined()
    expect('proxy' in options).toBe(false)
  })

  // #given the connect-time DNS lookup resolves to a blocked (internal) address
  // #when the agent passed to sendNotification is asked to open a connection
  // #then the guarded lookup rejects BEFORE any real socket is opened, using
  //       the exact resolved address — no re-resolution — and the outcome is error
  it('blocks a resolved internal address before connecting and never reaches the relay', async () => {
    vi.doMock('node:dns', () => ({
      default: {
        lookup: (
          _hostname: string,
          _options: unknown,
          callback: (err: Error | null, addresses: readonly {address: string; family: number}[]) => void,
        ) => {
          callback(null, [{address: '169.254.169.254', family: 4}])
        },
      },
    }))
    let realSocketOpened = false
    vi.doMock('node:https', () => {
      class FakeAgent {
        createConnection(
          options: {readonly lookup?: (...args: unknown[]) => void},
          callback?: (error: Error | null) => void,
        ) {
          // Exercise the SAME lookup the real https.Agent would invoke to
          // resolve the connection target before opening any socket.
          options.lookup?.('push.example.com', {family: 0}, (error: Error | null) => {
            if (error !== null) {
              callback?.(error)
              return
            }
            realSocketOpened = true
            callback?.(null)
          })
          return undefined
        }

        destroy(): void {}
      }
      return {default: {Agent: FakeAgent}}
    })
    vi.doMock('web-push', () => ({
      default: {
        sendNotification: vi.fn(async (_sub: unknown, _payload: unknown, options: {readonly agent: FakeAgentLike}) => {
          return new Promise((resolve, reject) => {
            options.agent.createConnection({host: 'push.example.com'}, (error: Error | null) => {
              if (error !== null) {
                reject(error)
                return
              }
              resolve({statusCode: 201, body: '', headers: {}})
            })
          })
        }),
      },
      WebPushError: class WebPushError extends Error {},
    }))
    const {createPushSender} = await import('./push-sender.js')
    const logger = createLogger()
    const sender = createPushSender({logger})
    const result = await sender.sendNotification(SUBSCRIPTION, '{}', VAPID_CONFIG)
    expect(result).toEqual({outcome: 'error'})
    expect(realSocketOpened).toBe(false)
  })

  // #given a successful send that goes through the guarded connect-time lookup
  // #when sendNotification is called
  // #then dns.lookup is invoked exactly once — the validated address is the
  //       connected address, with no re-resolution in between
  it('invokes the DNS lookup exactly once per sendNotification', async () => {
    const lookupSpy = vi.fn(
      (
        _hostname: string,
        _options: unknown,
        callback: (err: Error | null, addresses: readonly {address: string; family: number}[]) => void,
      ) => {
        callback(null, [{address: '142.250.72.196', family: 4}])
      },
    )
    vi.doMock('node:dns', () => ({
      default: {lookup: lookupSpy},
    }))
    vi.doMock('node:https', () => {
      class FakeAgent {
        createConnection(
          options: {readonly lookup?: (...args: unknown[]) => void},
          callback?: (error: Error | null) => void,
        ) {
          options.lookup?.('push.example.com', {family: 0}, (error: Error | null) => {
            callback?.(error)
          })
          return undefined
        }

        destroy(): void {}
      }
      return {default: {Agent: FakeAgent}}
    })
    vi.doMock('web-push', () => ({
      default: {
        sendNotification: vi.fn(async (_sub: unknown, _payload: unknown, options: {readonly agent: FakeAgentLike}) => {
          return new Promise((resolve, reject) => {
            options.agent.createConnection({host: 'push.example.com'}, (error: Error | null) => {
              if (error !== null) {
                reject(error)
                return
              }
              resolve({statusCode: 201, body: '', headers: {}})
            })
          })
        }),
      },
      WebPushError: class WebPushError extends Error {},
    }))
    const {createPushSender} = await import('./push-sender.js')
    const sender = createPushSender({logger: createLogger()})
    const result = await sender.sendNotification(SUBSCRIPTION, '{}', VAPID_CONFIG)
    expect(result).toEqual({outcome: 'accepted', statusCode: 201})
    expect(lookupSpy).toHaveBeenCalledTimes(1)
  })

  // #given the real Node autoSelectFamily shape: the socket connector calls
  //       the guarded lookup with {all: true} and dns.lookup returns an array
  // #when every candidate address is public
  // #then the callback receives an ARRAY (not a string), unchanged, and
  //       dns.lookup itself is invoked with all: true
  it('returns an address array when the caller asks for all:true and every candidate is public', async () => {
    const lookupSpy = vi.fn(
      (
        _hostname: string,
        options: {readonly all?: boolean},
        callback: (err: Error | null, addresses: readonly {address: string; family: number}[]) => void,
      ) => {
        expect(options.all).toBe(true)
        callback(null, [{address: '172.66.147.243', family: 4}])
      },
    )
    vi.doMock('node:dns', () => ({default: {lookup: lookupSpy}}))
    let receivedCallbackArgs: unknown[] = []
    vi.doMock('node:https', () => {
      class FakeAgent {
        createConnection(
          options: {readonly lookup?: (...args: unknown[]) => void},
          callback?: (error: Error | null) => void,
        ) {
          options.lookup?.('push.example.com', {all: true}, (...args: unknown[]) => {
            receivedCallbackArgs = args
            const error = args[0] as Error | null
            callback?.(error)
          })
          return undefined
        }

        destroy(): void {}
      }
      return {default: {Agent: FakeAgent}}
    })
    vi.doMock('web-push', () => ({
      default: {
        sendNotification: vi.fn(async (_sub: unknown, _payload: unknown, options: {readonly agent: FakeAgentLike}) => {
          return new Promise((resolve, reject) => {
            options.agent.createConnection({host: 'push.example.com'}, (error: Error | null) => {
              if (error !== null) {
                reject(error)
                return
              }
              resolve({statusCode: 201, body: '', headers: {}})
            })
          })
        }),
      },
      WebPushError: class WebPushError extends Error {},
    }))
    const {createPushSender} = await import('./push-sender.js')
    const sender = createPushSender({logger: createLogger()})
    const result = await sender.sendNotification(SUBSCRIPTION, '{}', VAPID_CONFIG)
    expect(result).toEqual({outcome: 'accepted', statusCode: 201})
    expect(receivedCallbackArgs[0]).toBeNull()
    expect(receivedCallbackArgs[1]).toEqual([{address: '172.66.147.243', family: 4}])
  })

  // #given the all:true shape returns a MIX of a public address and an
  //       internal (metadata) address
  // #when the guarded lookup classifies every candidate
  // #then it rejects the whole connection — not just when the first entry is blocked
  it('blocks the whole connection when any address in an all:true result is internal', async () => {
    vi.doMock('node:dns', () => ({
      default: {
        lookup: (
          _hostname: string,
          _options: unknown,
          callback: (err: Error | null, addresses: readonly {address: string; family: number}[]) => void,
        ) => {
          callback(null, [
            {address: '172.66.147.243', family: 4},
            {address: '169.254.169.254', family: 4},
          ])
        },
      },
    }))
    let realSocketOpened = false
    vi.doMock('node:https', () => {
      class FakeAgent {
        createConnection(
          options: {readonly lookup?: (...args: unknown[]) => void},
          callback?: (error: Error | null) => void,
        ) {
          options.lookup?.('push.example.com', {all: true}, (error: Error | null) => {
            if (error !== null) {
              callback?.(error)
              return
            }
            realSocketOpened = true
            callback?.(null)
          })
          return undefined
        }

        destroy(): void {}
      }
      return {default: {Agent: FakeAgent}}
    })
    vi.doMock('web-push', () => ({
      default: {
        sendNotification: vi.fn(async (_sub: unknown, _payload: unknown, options: {readonly agent: FakeAgentLike}) => {
          return new Promise((resolve, reject) => {
            options.agent.createConnection({host: 'push.example.com'}, (error: Error | null) => {
              if (error !== null) {
                reject(error)
                return
              }
              resolve({statusCode: 201, body: '', headers: {}})
            })
          })
        }),
      },
      WebPushError: class WebPushError extends Error {},
    }))
    const {createPushSender} = await import('./push-sender.js')
    const sender = createPushSender({logger: createLogger()})
    const result = await sender.sendNotification(SUBSCRIPTION, '{}', VAPID_CONFIG)
    expect(result).toEqual({outcome: 'error'})
    expect(realSocketOpened).toBe(false)
  })

  // #given the all:true shape returns a single internal address
  // #when the guarded lookup classifies it
  // #then it rejects the connection
  it('blocks a single internal address returned via the all:true array shape', async () => {
    vi.doMock('node:dns', () => ({
      default: {
        lookup: (
          _hostname: string,
          _options: unknown,
          callback: (err: Error | null, addresses: readonly {address: string; family: number}[]) => void,
        ) => {
          callback(null, [{address: '127.0.0.1', family: 4}])
        },
      },
    }))
    let realSocketOpened = false
    vi.doMock('node:https', () => {
      class FakeAgent {
        createConnection(
          options: {readonly lookup?: (...args: unknown[]) => void},
          callback?: (error: Error | null) => void,
        ) {
          options.lookup?.('push.example.com', {all: true}, (error: Error | null) => {
            if (error !== null) {
              callback?.(error)
              return
            }
            realSocketOpened = true
            callback?.(null)
          })
          return undefined
        }

        destroy(): void {}
      }
      return {default: {Agent: FakeAgent}}
    })
    vi.doMock('web-push', () => ({
      default: {
        sendNotification: vi.fn(async (_sub: unknown, _payload: unknown, options: {readonly agent: FakeAgentLike}) => {
          return new Promise((resolve, reject) => {
            options.agent.createConnection({host: 'push.example.com'}, (error: Error | null) => {
              if (error !== null) {
                reject(error)
                return
              }
              resolve({statusCode: 201, body: '', headers: {}})
            })
          })
        }),
      },
      WebPushError: class WebPushError extends Error {},
    }))
    const {createPushSender} = await import('./push-sender.js')
    const sender = createPushSender({logger: createLogger()})
    const result = await sender.sendNotification(SUBSCRIPTION, '{}', VAPID_CONFIG)
    expect(result).toEqual({outcome: 'error'})
    expect(realSocketOpened).toBe(false)
  })
})

interface FakeAgentLike {
  createConnection: (options: {readonly host: string}, callback: (error: Error | null) => void) => void
}

function buildFakeModule(statusCode: number) {
  class FakeWebPushError extends Error {
    readonly statusCode: number
    readonly headers = {}
    readonly body = ''
    readonly endpoint = SUBSCRIPTION.endpoint
    constructor(code: number) {
      super('push relay rejected')
      this.statusCode = code
    }
  }
  return {
    createFakeWebPushModule: {
      default: {
        sendNotification: vi.fn(async () => {
          throw new FakeWebPushError(statusCode)
        }),
      },
      WebPushError: FakeWebPushError,
    },
  }
}
