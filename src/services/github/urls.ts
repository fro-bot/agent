/**
 * Robust GitHub URL validation and extraction utilities.
 *
 * Provides safe parsing and validation for GitHub URLs to prevent
 * spoofing and ensure security boundaries (e.g. for attachments).
 */

/**
 * Validates that a string is a valid GitHub URL.
 * Prevents spoofing via attacker-github.com or similar.
 */
export function isGithubUrl(urlStr: string): boolean {
  try {
    const url = new URL(urlStr)
    // Strict hostname check
    return url.hostname === 'github.com' || url.hostname === 'api.github.com'
  } catch {
    return false
  }
}

/**
 * Validates that a URL is a valid GitHub attachment URL.
 * Only allows github.com/user-attachments/* as per RFC-014.
 */
export function isValidAttachmentUrl(urlStr: string): boolean {
  try {
    const url = new URL(urlStr)
    return (
      url.hostname === 'github.com' &&
      (url.pathname.startsWith('/user-attachments/assets/') || url.pathname.startsWith('/user-attachments/files/'))
    )
  } catch {
    return false
  }
}

/**
 * Robustly extract GitHub PR/Issue URLs from text.
 * Only returns URLs that pass isGithubUrl validation.
 */
export function extractGithubUrls(text: string): string[] {
  // Pattern for common GitHub URLs: PRs, Issues, and Comments
  const pattern = /https:\/\/github\.com\/[a-zA-Z0-9-]+\/[\w.-]+\/(?:pull|issues)\/\d+(?:#issuecomment-\d+)?/g
  const matches = text.match(pattern) ?? []

  // Unique URLs only, filtered by strict hostname check
  return [...new Set(matches)].filter(isGithubUrl)
}

/**
 * Extracts commit SHAs from git command output.
 * Matches standard git commit output: [branch-name abc1234]
 */
export function extractCommitShas(text: string): string[] {
  const pattern = /\[[\w-]+\s+([a-f0-9]{7,40})\]/g
  const shas: string[] = []

  for (const match of text.matchAll(pattern)) {
    if (match[1] != null) {
      shas.push(match[1])
    }
  }

  return [...new Set(shas)]
}
