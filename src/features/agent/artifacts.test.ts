import {describe, expect, it, vi} from 'vitest'
import {detectArtifacts} from './streaming.js'

describe('detectArtifacts', () => {
  it('detects PR creation from output', () => {
    const prsCreated: string[] = []
    const command = 'gh pr create --title "Test"'
    const output = 'https://github.com/owner/repo/pull/123'

    detectArtifacts(command, output, prsCreated, [], () => {})

    expect(prsCreated).toEqual(['https://github.com/owner/repo/pull/123'])
  })

  it('prevents spoofed PR URLs', () => {
    const prsCreated: string[] = []
    const command = 'gh pr create'
    const output = 'https://attacker-github.com/owner/repo/pull/123'

    detectArtifacts(command, output, prsCreated, [], () => {})

    expect(prsCreated).toEqual([])
  })

  it('detects commits from git output', () => {
    const commitsCreated: string[] = []
    const command = 'git commit -m "feat: test"'
    const output = '[main abc1234] feat: test'

    detectArtifacts(command, output, [], commitsCreated, () => {})

    expect(commitsCreated).toEqual(['abc1234'])
  })

  it('detects comment posting', () => {
    const onCommentPosted = vi.fn()
    const command = 'gh issue comment 1 --body "hello"'
    const output = 'https://github.com/owner/repo/issues/1#issuecomment-12345'

    detectArtifacts(command, output, [], [], onCommentPosted)

    expect(onCommentPosted).toHaveBeenCalled()
  })

  it('ignores spoofed comment URLs', () => {
    const onCommentPosted = vi.fn()
    const command = 'gh issue comment 1'
    const output = 'https://attacker-github.com/owner/repo/issues/1#issuecomment-12345'

    detectArtifacts(command, output, [], [], onCommentPosted)

    expect(onCommentPosted).not.toHaveBeenCalled()
  })

  it('ignores comments that do not have #issuecomment fragment', () => {
    const onCommentPosted = vi.fn()
    const command = 'gh issue comment 1'
    const output = 'https://github.com/owner/repo/issues/1' // Missing #issuecomment

    detectArtifacts(command, output, [], [], onCommentPosted)

    expect(onCommentPosted).not.toHaveBeenCalled()
  })

  it('increments the comment count when a gh self-post command is scraped from output', () => {
    const onCommentPosted = vi.fn()
    const commentsPostedUrls: string[] = []
    const command = 'gh pr comment 42 --body "review notes"'
    const output = 'https://github.com/owner/repo/pull/42#issuecomment-98765'

    detectArtifacts(command, output, [], [], onCommentPosted, commentsPostedUrls)

    expect(onCommentPosted).toHaveBeenCalledTimes(1)
    expect(commentsPostedUrls).toEqual(['https://github.com/owner/repo/pull/42#issuecomment-98765'])
  })

  it('does not report a posted comment when no gh comment command was run', () => {
    // Response-file-convention flows never run `gh issue comment`/`gh pr comment` —
    // the credential is withheld and the model writes a file instead. The
    // comment count for those runs comes from the finalize post, not this scan.
    const onCommentPosted = vi.fn()
    const commentsPostedUrls: string[] = []
    const command = 'cat response.md'
    const output = 'https://github.com/owner/repo/pull/42#issuecomment-98765'

    detectArtifacts(command, output, [], [], onCommentPosted, commentsPostedUrls)

    expect(onCommentPosted).not.toHaveBeenCalled()
    expect(commentsPostedUrls).toEqual([])
  })
})
