import {describe, expect, it} from 'vitest'
import {ERROR_TYPES, type ErrorInfo, type ErrorType, type Thread, type ThreadComment} from './types.js'

describe('comments/types', () => {
  describe('ThreadComment', () => {
    it('accepts numeric id for REST API comments', () => {
      // #given a REST API comment with numeric ID
      const comment: ThreadComment = {
        id: 12345,
        body: 'Test comment',
        author: 'testuser',
        authorAssociation: 'MEMBER',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        isBot: false,
      }

      // #then the id should be a number
      expect(typeof comment.id).toBe('number')
    })

    it('accepts string id for GraphQL comments', () => {
      // #given a GraphQL comment with Node ID
      const comment: ThreadComment = {
        id: 'DC_kwDOABCD1234',
        body: 'Discussion comment',
        author: 'testuser',
        authorAssociation: 'NONE',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        isBot: false,
      }

      // #then the id should be a string
      expect(typeof comment.id).toBe('string')
    })
  })

  describe('Thread', () => {
    it('includes discussionId for discussion threads', () => {
      // #given a discussion thread
      const thread: Thread = {
        type: 'discussion',
        number: 42,
        title: 'Test Discussion',
        body: 'Discussion body',
        author: 'testuser',
        comments: [],
        discussionId: 'D_kwDOABCD1234',
      }

      // #then discussionId should be present
      expect(thread.discussionId).toBe('D_kwDOABCD1234')
    })

    it('omits discussionId for issue threads', () => {
      // #given an issue thread
      const thread: Thread = {
        type: 'issue',
        number: 123,
        title: 'Test Issue',
        body: 'Issue body',
        author: 'testuser',
        comments: [],
      }

      // #then discussionId should be undefined
      expect(thread.discussionId).toBeUndefined()
    })
  })

  describe('ErrorType', () => {
    it('includes all expected error types', () => {
      // #given the ERROR_TYPES constant
      // #then it should contain all expected types
      expect(ERROR_TYPES).toContain('rate_limit')
      expect(ERROR_TYPES).toContain('llm_timeout')
      expect(ERROR_TYPES).toContain('permission')
      expect(ERROR_TYPES).toContain('api_error')
      expect(ERROR_TYPES).toContain('configuration')
      expect(ERROR_TYPES).toContain('validation')
      expect(ERROR_TYPES).toContain('internal')
    })

    it('allows creating typed ErrorInfo', () => {
      // #given an error type
      const errorType: ErrorType = 'rate_limit'

      // #when creating an ErrorInfo
      const error: ErrorInfo = {
        type: errorType,
        message: 'Rate limit exceeded',
        retryable: true,
        resetTime: new Date('2024-01-01T01:00:00Z'),
      }

      // #then it should have the correct structure
      expect(error.type).toBe('rate_limit')
      expect(error.retryable).toBe(true)
      expect(error.resetTime).toBeInstanceOf(Date)
    })
  })
})
