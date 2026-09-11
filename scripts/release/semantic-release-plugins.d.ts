// Narrow, module-scoped type contracts for the two @semantic-release plugin functions
// release-policy.test.ts calls. They ship no TypeScript declarations of their own; these are
// exported interfaces/types, not global `declare module` augmentations, so they only apply where
// explicitly imported via `import type`. They describe this project's configured default plugin
// policy (preset + analyzeCommits.releaseRules), not a general-purpose loader guarantee for every
// plugin option a future .releaserc.yaml override might add.

export interface CommitAnalyzerContext {
  readonly commits: readonly {readonly hash: string; readonly message: string}[]
  readonly cwd: string
  readonly logger: {readonly log: (...args: unknown[]) => void}
}

export interface CommitAnalyzerPluginConfig {
  readonly preset?: string
  readonly presetConfig?: unknown
  readonly releaseRules?: readonly unknown[]
}

export type AnalyzeCommitsFn = (
  pluginConfig: CommitAnalyzerPluginConfig,
  context: CommitAnalyzerContext,
) => Promise<string | null>

export interface ReleaseNotesContext {
  readonly cwd: string
  readonly options: {readonly repositoryUrl: string}
  readonly lastRelease: {readonly gitTag?: string; readonly gitHead?: string}
  readonly nextRelease: {readonly version: string; readonly gitTag?: string; readonly gitHead?: string}
  readonly commits: readonly {readonly hash: string; readonly message: string}[]
}

export interface ReleaseNotesPluginConfig {
  readonly preset?: string
  readonly presetConfig?: unknown
}

export type GenerateNotesFn = (pluginConfig: ReleaseNotesPluginConfig, context: ReleaseNotesContext) => Promise<string>

// `semantic-release`'s own installed `semver` dependency, resolved through the same host require
// context, used as the real-arithmetic oracle for computeNextVersion parity checks.
export type SemverIncFn = (version: string, releaseType: 'patch' | 'minor' | 'major') => string | null
