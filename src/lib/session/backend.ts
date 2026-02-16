import type {createOpencode} from '@opencode-ai/sdk'

export type SessionClient = Awaited<ReturnType<typeof createOpencode>>['client']

export interface JsonBackend {
  readonly type: 'json'
  readonly workspacePath: string
}

export interface SdkBackend {
  readonly type: 'sdk'
  readonly workspacePath: string
  readonly client: SessionClient
}

export type SessionBackend = JsonBackend | SdkBackend
