import type {
  DiscussionCommentEvent,
  IssueCommentEvent,
  IssuesEvent,
  PullRequestEvent,
  PullRequestReviewCommentEvent,
  WorkflowDispatchEvent,
} from '@octokit/webhooks-types'

const BASE_USER = {
  login: 'octocat',
  id: 1,
  node_id: 'MDQ6VXNlcjE=',
  avatar_url: 'https://github.com/images/error/octocat_happy.gif',
  gravatar_id: '',
  url: 'https://api.github.com/users/octocat',
  html_url: 'https://github.com/octocat',
  followers_url: 'https://api.github.com/users/octocat/followers',
  following_url: 'https://api.github.com/users/octocat/following{/other_user}',
  gists_url: 'https://api.github.com/users/octocat/gists{/gist_id}',
  starred_url: 'https://api.github.com/users/octocat/starred{/owner}{/repo}',
  subscriptions_url: 'https://api.github.com/users/octocat/subscriptions',
  organizations_url: 'https://api.github.com/users/octocat/orgs',
  repos_url: 'https://api.github.com/users/octocat/repos',
  events_url: 'https://api.github.com/users/octocat/events{/privacy}',
  received_events_url: 'https://api.github.com/users/octocat/received_events',
  type: 'User' as const,
  site_admin: false,
} as const

const BOT_USER = {
  ...BASE_USER,
  login: 'fro-bot[bot]',
  id: 123456789,
  node_id: 'BOT_MDQ6VXNlcjEyMzQ1Njc4OQ==',
  type: 'Bot' as const,
} as const

const BASE_REPOSITORY = {
  id: 1296269,
  node_id: 'MDEwOlJlcG9zaXRvcnkxMjk2MjY5',
  name: 'Hello-World',
  full_name: 'octocat/Hello-World',
  private: false,
  owner: BASE_USER,
  html_url: 'https://github.com/octocat/Hello-World',
  description: 'This your first repo!',
  fork: false,
  url: 'https://api.github.com/repos/octocat/Hello-World',
  forks_url: 'https://api.github.com/repos/octocat/Hello-World/forks',
  keys_url: 'https://api.github.com/repos/octocat/Hello-World/keys{/key_id}',
  collaborators_url: 'https://api.github.com/repos/octocat/Hello-World/collaborators{/collaborator}',
  teams_url: 'https://api.github.com/repos/octocat/Hello-World/teams',
  hooks_url: 'https://api.github.com/repos/octocat/Hello-World/hooks',
  issue_events_url: 'https://api.github.com/repos/octocat/Hello-World/issues/events{/number}',
  events_url: 'https://api.github.com/repos/octocat/Hello-World/events',
  assignees_url: 'https://api.github.com/repos/octocat/Hello-World/assignees{/user}',
  branches_url: 'https://api.github.com/repos/octocat/Hello-World/branches{/branch}',
  tags_url: 'https://api.github.com/repos/octocat/Hello-World/tags',
  blobs_url: 'https://api.github.com/repos/octocat/Hello-World/git/blobs{/sha}',
  git_tags_url: 'https://api.github.com/repos/octocat/Hello-World/git/tags{/sha}',
  git_refs_url: 'https://api.github.com/repos/octocat/Hello-World/git/refs{/sha}',
  trees_url: 'https://api.github.com/repos/octocat/Hello-World/git/trees{/sha}',
  statuses_url: 'https://api.github.com/repos/octocat/Hello-World/statuses/{sha}',
  languages_url: 'https://api.github.com/repos/octocat/Hello-World/languages',
  stargazers_url: 'https://api.github.com/repos/octocat/Hello-World/stargazers',
  contributors_url: 'https://api.github.com/repos/octocat/Hello-World/contributors',
  subscribers_url: 'https://api.github.com/repos/octocat/Hello-World/subscribers',
  subscription_url: 'https://api.github.com/repos/octocat/Hello-World/subscription',
  commits_url: 'https://api.github.com/repos/octocat/Hello-World/commits{/sha}',
  git_commits_url: 'https://api.github.com/repos/octocat/Hello-World/git/commits{/sha}',
  comments_url: 'https://api.github.com/repos/octocat/Hello-World/comments{/number}',
  issue_comment_url: 'https://api.github.com/repos/octocat/Hello-World/issues/comments{/number}',
  contents_url: 'https://api.github.com/repos/octocat/Hello-World/contents/{+path}',
  compare_url: 'https://api.github.com/repos/octocat/Hello-World/compare/{base}...{head}',
  merges_url: 'https://api.github.com/repos/octocat/Hello-World/merges',
  archive_url: 'https://api.github.com/repos/octocat/Hello-World/{archive_format}{/ref}',
  downloads_url: 'https://api.github.com/repos/octocat/Hello-World/downloads',
  issues_url: 'https://api.github.com/repos/octocat/Hello-World/issues{/number}',
  pulls_url: 'https://api.github.com/repos/octocat/Hello-World/pulls{/number}',
  milestones_url: 'https://api.github.com/repos/octocat/Hello-World/milestones{/number}',
  notifications_url: 'https://api.github.com/repos/octocat/Hello-World/notifications{?since,all,participating}',
  labels_url: 'https://api.github.com/repos/octocat/Hello-World/labels{/name}',
  releases_url: 'https://api.github.com/repos/octocat/Hello-World/releases{/id}',
  deployments_url: 'https://api.github.com/repos/octocat/Hello-World/deployments',
  created_at: '2011-01-26T19:01:12Z',
  updated_at: '2024-01-15T12:00:00Z',
  pushed_at: '2024-01-15T12:00:00Z',
  git_url: 'git://github.com/octocat/Hello-World.git',
  ssh_url: 'git@github.com:octocat/Hello-World.git',
  clone_url: 'https://github.com/octocat/Hello-World.git',
  svn_url: 'https://github.com/octocat/Hello-World',
  homepage: 'https://github.com',
  size: 108,
  stargazers_count: 80,
  watchers_count: 80,
  language: 'TypeScript',
  has_issues: true,
  has_projects: true,
  has_downloads: true,
  has_wiki: true,
  has_pages: false,
  has_discussions: true,
  forks_count: 9,
  mirror_url: null,
  archived: false,
  disabled: false,
  open_issues_count: 0,
  license: null,
  allow_forking: true,
  is_template: false,
  web_commit_signoff_required: false,
  topics: [],
  visibility: 'public' as const,
  forks: 9,
  open_issues: 0,
  watchers: 80,
  default_branch: 'main',
  custom_properties: {},
} as const

const BASE_REACTIONS = {
  url: 'https://api.github.com/repos/octocat/Hello-World/issues/1/reactions',
  total_count: 0,
  '+1': 0,
  '-1': 0,
  laugh: 0,
  hooray: 0,
  confused: 0,
  heart: 0,
  rocket: 0,
  eyes: 0,
} as const

function createUser(overrides: {login?: string} = {}) {
  return {...BASE_USER, login: overrides.login ?? BASE_USER.login}
}

function createRepository(overrides: Partial<typeof BASE_REPOSITORY> = {}) {
  return {...BASE_REPOSITORY, ...overrides} as typeof BASE_REPOSITORY
}

export function createIssueCommentCreatedEvent(
  overrides: {
    action?: 'created' | 'edited' | 'deleted'
    commentBody?: string
    authorLogin?: string
    authorAssociation?: string
    issueNumber?: number
    issueLocked?: boolean
    isPullRequest?: boolean
    isBotComment?: boolean
  } = {},
): IssueCommentEvent {
  const author = overrides.isBotComment === true ? BOT_USER : createUser({login: overrides.authorLogin ?? 'commenter'})

  return {
    action: overrides.action ?? 'created',
    issue: {
      url: 'https://api.github.com/repos/octocat/Hello-World/issues/1',
      repository_url: 'https://api.github.com/repos/octocat/Hello-World',
      labels_url: 'https://api.github.com/repos/octocat/Hello-World/issues/1/labels{/name}',
      comments_url: 'https://api.github.com/repos/octocat/Hello-World/issues/1/comments',
      events_url: 'https://api.github.com/repos/octocat/Hello-World/issues/1/events',
      html_url: 'https://github.com/octocat/Hello-World/issues/1',
      id: 1,
      node_id: 'MDU6SXNzdWUx',
      number: overrides.issueNumber ?? 1,
      title: 'Found a bug',
      user: BASE_USER,
      labels: [],
      state: 'open',
      locked: overrides.issueLocked ?? false,
      assignee: null,
      assignees: [],
      milestone: null,
      comments: 1,
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-15T12:00:00Z',
      closed_at: null,
      author_association: 'OWNER',
      active_lock_reason: null,
      body: 'I found a bug in the code',
      reactions: BASE_REACTIONS,
      timeline_url: 'https://api.github.com/repos/octocat/Hello-World/issues/1/timeline',
      state_reason: null,
      ...(overrides.isPullRequest === true
        ? {
            pull_request: {
              url: 'https://api.github.com/repos/octocat/Hello-World/pulls/1',
              html_url: 'https://github.com/octocat/Hello-World/pull/1',
              diff_url: 'https://github.com/octocat/Hello-World/pull/1.diff',
              patch_url: 'https://github.com/octocat/Hello-World/pull/1.patch',
              merged_at: null,
            },
          }
        : {}),
    },
    comment: {
      url: 'https://api.github.com/repos/octocat/Hello-World/issues/comments/1',
      html_url: 'https://github.com/octocat/Hello-World/issues/1#issuecomment-1',
      issue_url: 'https://api.github.com/repos/octocat/Hello-World/issues/1',
      id: 1,
      node_id: 'MDEyOklzc3VlQ29tbWVudDE=',
      user: author,
      created_at: '2024-01-15T12:00:00Z',
      updated_at: '2024-01-15T12:00:00Z',
      author_association: (overrides.authorAssociation ?? 'MEMBER') as
        | 'COLLABORATOR'
        | 'CONTRIBUTOR'
        | 'FIRST_TIMER'
        | 'FIRST_TIME_CONTRIBUTOR'
        | 'MANNEQUIN'
        | 'MEMBER'
        | 'NONE'
        | 'OWNER',
      body: overrides.commentBody ?? '@fro-bot help me fix this bug',
      reactions: BASE_REACTIONS,
      performed_via_github_app: null,
    },
    repository: createRepository(),
    sender: author,
  } as unknown as IssueCommentEvent
}

export function createIssuesOpenedEvent(
  overrides: {
    issueNumber?: number
    issueTitle?: string
    issueBody?: string
    authorLogin?: string
    authorAssociation?: string
    isLocked?: boolean
  } = {},
): IssuesEvent {
  const author = createUser({login: overrides.authorLogin ?? 'issue-author'})

  return {
    action: 'opened',
    issue: {
      url: 'https://api.github.com/repos/octocat/Hello-World/issues/1',
      repository_url: 'https://api.github.com/repos/octocat/Hello-World',
      labels_url: 'https://api.github.com/repos/octocat/Hello-World/issues/1/labels{/name}',
      comments_url: 'https://api.github.com/repos/octocat/Hello-World/issues/1/comments',
      events_url: 'https://api.github.com/repos/octocat/Hello-World/issues/1/events',
      html_url: 'https://github.com/octocat/Hello-World/issues/1',
      id: 1,
      node_id: 'MDU6SXNzdWUx',
      number: overrides.issueNumber ?? 1,
      title: overrides.issueTitle ?? 'Feature request: Add dark mode',
      user: author,
      labels: [],
      state: 'open',
      locked: overrides.isLocked ?? false,
      assignee: null,
      assignees: [],
      milestone: null,
      comments: 0,
      created_at: '2024-01-15T12:00:00Z',
      updated_at: '2024-01-15T12:00:00Z',
      closed_at: null,
      author_association: (overrides.authorAssociation ?? 'MEMBER') as
        | 'COLLABORATOR'
        | 'CONTRIBUTOR'
        | 'FIRST_TIMER'
        | 'FIRST_TIME_CONTRIBUTOR'
        | 'MANNEQUIN'
        | 'MEMBER'
        | 'NONE'
        | 'OWNER',
      active_lock_reason: null,
      body: overrides.issueBody ?? 'Please add dark mode support to the application.',
      reactions: BASE_REACTIONS,
      timeline_url: 'https://api.github.com/repos/octocat/Hello-World/issues/1/timeline',
      state_reason: null,
    },
    repository: createRepository(),
    sender: author,
  } as unknown as IssuesEvent
}

export function createIssuesEditedEvent(
  overrides: {
    issueNumber?: number
    issueTitle?: string
    issueBody?: string
    authorLogin?: string
    hasMention?: boolean
  } = {},
): IssuesEvent {
  const baseEvent = createIssuesOpenedEvent(overrides)
  const body =
    overrides.hasMention === true
      ? '@fro-bot please review this updated issue'
      : (overrides.issueBody ?? 'Updated issue body without mention')

  return {
    ...baseEvent,
    action: 'edited',
    issue: {
      ...baseEvent.issue,
      body,
    },
    changes: {
      body: {
        from: 'Original issue body',
      },
    },
  } as unknown as IssuesEvent
}

export function createPullRequestOpenedEvent(
  overrides: {
    prNumber?: number
    prTitle?: string
    prBody?: string
    authorLogin?: string
    authorAssociation?: string
    isDraft?: boolean
    isLocked?: boolean
  } = {},
): PullRequestEvent {
  const author = createUser({login: overrides.authorLogin ?? 'pr-author'})

  return {
    action: 'opened',
    number: overrides.prNumber ?? 1,
    pull_request: {
      url: 'https://api.github.com/repos/octocat/Hello-World/pulls/1',
      id: 1,
      node_id: 'MDExOlB1bGxSZXF1ZXN0MQ==',
      html_url: 'https://github.com/octocat/Hello-World/pull/1',
      diff_url: 'https://github.com/octocat/Hello-World/pull/1.diff',
      patch_url: 'https://github.com/octocat/Hello-World/pull/1.patch',
      issue_url: 'https://api.github.com/repos/octocat/Hello-World/issues/1',
      number: overrides.prNumber ?? 1,
      state: 'open',
      locked: overrides.isLocked ?? false,
      title: overrides.prTitle ?? 'Add new feature',
      user: author,
      body: overrides.prBody ?? 'This PR adds a new feature to the application.',
      created_at: '2024-01-15T12:00:00Z',
      updated_at: '2024-01-15T12:00:00Z',
      closed_at: null,
      merged_at: null,
      merge_commit_sha: null,
      assignee: null,
      assignees: [],
      requested_reviewers: [],
      requested_teams: [],
      labels: [],
      milestone: null,
      draft: overrides.isDraft ?? false,
      commits_url: 'https://api.github.com/repos/octocat/Hello-World/pulls/1/commits',
      review_comments_url: 'https://api.github.com/repos/octocat/Hello-World/pulls/1/comments',
      review_comment_url: 'https://api.github.com/repos/octocat/Hello-World/pulls/comments{/number}',
      comments_url: 'https://api.github.com/repos/octocat/Hello-World/issues/1/comments',
      statuses_url: 'https://api.github.com/repos/octocat/Hello-World/statuses/abc123',
      head: {
        label: 'octocat:feature-branch',
        ref: 'feature-branch',
        sha: 'abc123def456',
        user: author,
        repo: createRepository(),
      },
      base: {
        label: 'octocat:main',
        ref: 'main',
        sha: '789xyz',
        user: BASE_USER,
        repo: createRepository(),
      },
      _links: {
        self: {href: 'https://api.github.com/repos/octocat/Hello-World/pulls/1'},
        html: {href: 'https://github.com/octocat/Hello-World/pull/1'},
        issue: {href: 'https://api.github.com/repos/octocat/Hello-World/issues/1'},
        comments: {href: 'https://api.github.com/repos/octocat/Hello-World/issues/1/comments'},
        review_comments: {href: 'https://api.github.com/repos/octocat/Hello-World/pulls/1/comments'},
        review_comment: {href: 'https://api.github.com/repos/octocat/Hello-World/pulls/comments{/number}'},
        commits: {href: 'https://api.github.com/repos/octocat/Hello-World/pulls/1/commits'},
        statuses: {href: 'https://api.github.com/repos/octocat/Hello-World/statuses/abc123'},
      },
      author_association: (overrides.authorAssociation ?? 'MEMBER') as
        | 'COLLABORATOR'
        | 'CONTRIBUTOR'
        | 'FIRST_TIMER'
        | 'FIRST_TIME_CONTRIBUTOR'
        | 'MANNEQUIN'
        | 'MEMBER'
        | 'NONE'
        | 'OWNER',
      auto_merge: null,
      active_lock_reason: null,
      merged: false,
      mergeable: true,
      rebaseable: true,
      mergeable_state: 'clean',
      merged_by: null,
      comments: 0,
      review_comments: 0,
      maintainer_can_modify: true,
      commits: 1,
      additions: 10,
      deletions: 2,
      changed_files: 1,
    },
    repository: createRepository(),
    sender: author,
  } as unknown as PullRequestEvent
}

export function createPullRequestSynchronizeEvent(
  overrides: {
    prNumber?: number
    authorLogin?: string
  } = {},
): PullRequestEvent {
  const baseEvent = createPullRequestOpenedEvent(overrides)
  return {
    ...baseEvent,
    action: 'synchronize',
    before: 'old_sha_123',
    after: 'new_sha_456',
  } as unknown as PullRequestEvent
}

export function createPullRequestReviewCommentCreatedEvent(
  overrides: {
    prNumber?: number
    commentBody?: string
    authorLogin?: string
    authorAssociation?: string
    filePath?: string
    line?: number
    diffHunk?: string
    commitId?: string
  } = {},
): PullRequestReviewCommentEvent {
  const author = createUser({login: overrides.authorLogin ?? 'reviewer'})

  return {
    action: 'created',
    comment: {
      url: 'https://api.github.com/repos/octocat/Hello-World/pulls/comments/1',
      pull_request_review_id: 1,
      id: 1,
      node_id: 'MDI0OlB1bGxSZXF1ZXN0UmV2aWV3Q29tbWVudDE=',
      diff_hunk: overrides.diffHunk ?? '@@ -16,33 +16,40 @@ public class Connection {\n     private String password;',
      path: overrides.filePath ?? 'src/main.ts',
      position: null,
      original_position: 4,
      commit_id: overrides.commitId ?? 'abc123def456',
      original_commit_id: 'abc123def456',
      user: author,
      body: overrides.commentBody ?? '@fro-bot explain this code change',
      created_at: '2024-01-15T12:00:00Z',
      updated_at: '2024-01-15T12:00:00Z',
      html_url: 'https://github.com/octocat/Hello-World/pull/1#discussion_r1',
      pull_request_url: 'https://api.github.com/repos/octocat/Hello-World/pulls/1',
      author_association: (overrides.authorAssociation ?? 'MEMBER') as
        | 'COLLABORATOR'
        | 'CONTRIBUTOR'
        | 'FIRST_TIMER'
        | 'FIRST_TIME_CONTRIBUTOR'
        | 'MANNEQUIN'
        | 'MEMBER'
        | 'NONE'
        | 'OWNER',
      _links: {
        self: {href: 'https://api.github.com/repos/octocat/Hello-World/pulls/comments/1'},
        html: {href: 'https://github.com/octocat/Hello-World/pull/1#discussion_r1'},
        pull_request: {href: 'https://api.github.com/repos/octocat/Hello-World/pulls/1'},
      },
      line: overrides.line ?? 16,
      original_line: 16,
      start_line: null,
      original_start_line: null,
      start_side: null,
      side: 'RIGHT',
      reactions: BASE_REACTIONS,
      subject_type: 'line',
    },
    pull_request: {
      url: 'https://api.github.com/repos/octocat/Hello-World/pulls/1',
      id: 1,
      node_id: 'MDExOlB1bGxSZXF1ZXN0MQ==',
      html_url: 'https://github.com/octocat/Hello-World/pull/1',
      diff_url: 'https://github.com/octocat/Hello-World/pull/1.diff',
      patch_url: 'https://github.com/octocat/Hello-World/pull/1.patch',
      issue_url: 'https://api.github.com/repos/octocat/Hello-World/issues/1',
      number: overrides.prNumber ?? 1,
      state: 'open',
      locked: false,
      title: 'Add new feature',
      user: BASE_USER,
      body: 'This PR adds a new feature.',
      created_at: '2024-01-15T12:00:00Z',
      updated_at: '2024-01-15T12:00:00Z',
      closed_at: null,
      merged_at: null,
      merge_commit_sha: null,
      assignee: null,
      assignees: [],
      requested_reviewers: [],
      requested_teams: [],
      labels: [],
      milestone: null,
      draft: false,
      commits_url: 'https://api.github.com/repos/octocat/Hello-World/pulls/1/commits',
      review_comments_url: 'https://api.github.com/repos/octocat/Hello-World/pulls/1/comments',
      review_comment_url: 'https://api.github.com/repos/octocat/Hello-World/pulls/comments{/number}',
      comments_url: 'https://api.github.com/repos/octocat/Hello-World/issues/1/comments',
      statuses_url: 'https://api.github.com/repos/octocat/Hello-World/statuses/abc123',
      head: {
        label: 'octocat:feature-branch',
        ref: 'feature-branch',
        sha: 'abc123def456',
        user: BASE_USER,
        repo: createRepository(),
      },
      base: {
        label: 'octocat:main',
        ref: 'main',
        sha: '789xyz',
        user: BASE_USER,
        repo: createRepository(),
      },
      _links: {
        self: {href: 'https://api.github.com/repos/octocat/Hello-World/pulls/1'},
        html: {href: 'https://github.com/octocat/Hello-World/pull/1'},
        issue: {href: 'https://api.github.com/repos/octocat/Hello-World/issues/1'},
        comments: {href: 'https://api.github.com/repos/octocat/Hello-World/issues/1/comments'},
        review_comments: {href: 'https://api.github.com/repos/octocat/Hello-World/pulls/1/comments'},
        review_comment: {href: 'https://api.github.com/repos/octocat/Hello-World/pulls/comments{/number}'},
        commits: {href: 'https://api.github.com/repos/octocat/Hello-World/pulls/1/commits'},
        statuses: {href: 'https://api.github.com/repos/octocat/Hello-World/statuses/abc123'},
      },
      author_association: 'OWNER',
      auto_merge: null,
      active_lock_reason: null,
    },
    repository: createRepository(),
    sender: author,
  } as unknown as PullRequestReviewCommentEvent
}

export function createDiscussionCommentCreatedEvent(
  overrides: {
    discussionNumber?: number
    discussionTitle?: string
    commentBody?: string
    authorLogin?: string
    authorAssociation?: string
    isLocked?: boolean
  } = {},
): DiscussionCommentEvent {
  const author = createUser({login: overrides.authorLogin ?? 'discussant'})

  return {
    action: 'created',
    comment: {
      id: 1,
      node_id: 'DC_kwDOABCD12MZM',
      html_url: 'https://github.com/octocat/Hello-World/discussions/1#discussioncomment-1',
      parent_id: null,
      child_comment_count: 0,
      repository_url: 'https://api.github.com/repos/octocat/Hello-World',
      discussion_id: 1,
      author_association: (overrides.authorAssociation ?? 'MEMBER') as
        | 'COLLABORATOR'
        | 'CONTRIBUTOR'
        | 'FIRST_TIMER'
        | 'FIRST_TIME_CONTRIBUTOR'
        | 'MANNEQUIN'
        | 'MEMBER'
        | 'NONE'
        | 'OWNER',
      user: author,
      created_at: '2024-01-15T12:00:00Z',
      updated_at: '2024-01-15T12:00:00Z',
      body: overrides.commentBody ?? '@fro-bot what do you think about this?',
      reactions: BASE_REACTIONS,
    },
    discussion: {
      repository_url: 'https://api.github.com/repos/octocat/Hello-World',
      category: {
        id: 1,
        node_id: 'DIC_kwDOABCD12YC',
        repository_id: 1296269,
        emoji: ':speech_balloon:',
        name: 'General',
        description: 'Chat about anything and everything here',
        created_at: '2021-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
        slug: 'general',
        is_answerable: false,
      },
      answer_html_url: null,
      answer_chosen_at: null,
      answer_chosen_by: null,
      html_url: 'https://github.com/octocat/Hello-World/discussions/1',
      id: 1,
      node_id: 'D_kwDOABCD12M',
      number: overrides.discussionNumber ?? 1,
      title: overrides.discussionTitle ?? 'Discussion about new features',
      user: BASE_USER,
      state: 'open',
      state_reason: null,
      locked: overrides.isLocked ?? false,
      comments: 1,
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-15T12:00:00Z',
      author_association: 'OWNER',
      active_lock_reason: null,
      body: 'Let us discuss new features for the project.',
      reactions: BASE_REACTIONS,
      timeline_url: 'https://api.github.com/repos/octocat/Hello-World/discussions/1/timeline',
    },
    repository: createRepository(),
    sender: author,
    installation: {
      id: 1,
      node_id: 'MDIzOkludGVncmF0aW9uSW5zdGFsbGF0aW9uMQ==',
    },
  } as unknown as DiscussionCommentEvent
}

export function createWorkflowDispatchEvent(
  overrides: {
    promptInput?: string
    ref?: string
    actorLogin?: string
  } = {},
): WorkflowDispatchEvent {
  const actor = createUser({login: overrides.actorLogin ?? 'workflow-runner'})

  return {
    inputs: overrides.promptInput == null ? null : {prompt: overrides.promptInput},
    ref: overrides.ref ?? 'refs/heads/main',
    repository: createRepository(),
    sender: actor,
    workflow: '.github/workflows/agent.yaml',
  } as unknown as WorkflowDispatchEvent
}

export interface ScheduleEventPayload {
  schedule: string
}

export function createScheduleEvent(
  overrides: {
    schedule?: string
  } = {},
): ScheduleEventPayload {
  return {
    schedule: overrides.schedule ?? '0 0 * * *',
  }
}

export {BASE_REPOSITORY, BASE_USER, BOT_USER, createRepository, createUser}
