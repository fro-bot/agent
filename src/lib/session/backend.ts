import type {createOpencode} from '@opencode-ai/sdk'

export type SessionClient = Awaited<ReturnType<typeof createOpencode>>['client']
