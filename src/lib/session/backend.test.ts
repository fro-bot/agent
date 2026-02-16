import type {JsonBackend, SdkBackend, SessionBackend} from './backend.js'
import {describe, expect, it} from 'vitest'

describe('SessionBackend', () => {
  describe('json backend', () => {
    it('has type discriminator "json"', () => {
      // #given
      const backend: JsonBackend = {type: 'json', workspacePath: '/workspace'}

      // #then
      expect(backend.type).toBe('json')
      expect(backend.workspacePath).toBe('/workspace')
    })
  })

  describe('sdk backend', () => {
    it('has type discriminator "sdk" with client', () => {
      // #given
      const mockClient = {} as SdkBackend['client']
      const backend: SdkBackend = {type: 'sdk', workspacePath: '/workspace', client: mockClient}

      // #then
      expect(backend.type).toBe('sdk')
      expect(backend.workspacePath).toBe('/workspace')
      expect(backend.client).toBe(mockClient)
    })
  })

  describe('discriminated union', () => {
    it('narrows to json backend via type check', () => {
      // #given
      const backend: SessionBackend = {type: 'json', workspacePath: '/workspace'}

      // #then
      expect(backend.type).toBe('json')
      expect(backend.workspacePath).toBe('/workspace')
    })

    it('narrows to sdk backend via type check', () => {
      // #given
      const mockClient = {} as SdkBackend['client']
      const backend: SessionBackend = {type: 'sdk', workspacePath: '/workspace', client: mockClient}

      // #then
      expect(backend.type).toBe('sdk')
      expect(backend.client).toBe(mockClient)
    })
  })
})
