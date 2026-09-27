/**
 * Unit 3: checkout admission primitives — layout checks, config inventory, temp-index
 * cleanliness, and the path-obstruction preflight.
 *
 * These are the checks update and recovery run, as AGENT_UID, against an EXISTING agent-owned
 * checkout, before (and, for config inventory, immediately before merging) any mutation. See the
 * plan's "Admission requires a closed configuration profile, not a sanitized one",
 * "Cleanliness is measured against a fresh index built from HEAD", and "Fast-forward with
 * --no-overwrite-ignore, after a path-obstruction preflight" key technical decisions.
 *
 * Every git subprocess spawned here goes through git-safety.ts's shared `gitInvocation` (which
 * bakes in `--no-optional-locks`, hook/fsmonitor/pager/credential-helper neutralization, and an
 * exact `safe.directory`) and the confirmed-termination `runGit` runner — the same neutralized
 * invocation shape `inspect.ts` uses. `checkTempIndexCleanliness` additionally enumerates and
 * neutralizes `filter.<name>.*` drivers before running any command that reads working-tree
 * content, via git-safety.ts's shared `enumerateFilterDrivers`/`buildFilterNeutralizationEnv` —
 * the same helper `inspect.ts` uses for its own `git status` neutralization.
 */

import type {ObstructionPathRunner} from './checkout-layout-child.js'
import type {GitRunnerFn} from './git-safety.js'

import {lchown, lstat, mkdtemp, realpath, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {runCheckoutLayoutChild, runCheckoutObstructionChild} from './checkout-layout-child.js'
import {
  buildFilterNeutralizationEnv,
  buildNeutralGitEnv,
  enumerateFilterDrivers,
  gitInvocation,
  runGit,
} from './git-safety.js'

// ---------------------------------------------------------------------------
// Shared small helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Config inventory
// ---------------------------------------------------------------------------

export interface ConfigInventoryOptions {
  readonly checkoutPath: string
  readonly gitRunner?: GitRunnerFn
  readonly timeoutMs: number
  readonly uid?: number
  readonly gid?: number
}

export type ConfigInventoryOutcome =
  | {readonly kind: 'allowed'}
  /** Every disallowed key actually found, named so a refusal reply and log line can be specific. */
  | {readonly kind: 'refused'; readonly disallowedKeys: readonly string[]}
  | {readonly kind: 'inspection-failed'}

/**
 * Closed allowlist of `.git/config` keys an ordinary, unmodified `git clone` writes — derived by
 * actually running `git clone` (this module's own fixture, `update-fixtures/policy-profile.test.ts`,
 * clones with the real git binary under test and feeds the exact resulting key set through this
 * function) rather than copied from documentation. `core.ignorecase` and `core.precomposeunicode`
 * are platform-conditional (macOS/HFS-family filesystems only; a case-sensitive Linux filesystem
 * never writes them) — harmless to allow unconditionally since this is a closed ALLOWLIST, not a
 * required-keys list. `remote.<name>` and `branch.<name>` subsections are matched by pattern since
 * the remote/branch name is caller-chosen, never fixed to `origin`/`main`.
 */
const CONFIG_ALLOWLIST_PATTERNS: readonly RegExp[] = [
  /^core\.repositoryformatversion$/,
  /^core\.filemode$/,
  /^core\.bare$/,
  /^core\.logallrefupdates$/,
  /^core\.ignorecase$/,
  /^core\.precomposeunicode$/,
  /^remote\.[^.]+\.url$/,
  /^remote\.[^.]+\.fetch$/,
  /^branch\.[^.]+\.remote$/,
  /^branch\.[^.]+\.merge$/,
]

function isAllowedConfigKey(key: string): boolean {
  return CONFIG_ALLOWLIST_PATTERNS.some(pattern => pattern.test(key))
}

/** Parses `git config --list -z` output (`key\nvalue` records, NUL-terminated) into the ordered list of keys present (values are irrelevant to the allowlist decision, which is key-set-only). */
function parseConfigListKeys(stdout: string): readonly string[] {
  const keys: string[] = []
  for (const record of stdout.split('\0')) {
    if (record.length === 0) continue
    const newlineIndex = record.indexOf('\n')
    const key = newlineIndex === -1 ? record : record.slice(0, newlineIndex)
    if (key.length > 0) keys.push(key)
  }
  return keys
}

/**
 * Inventories `.git/config` with `git config --local --list -z --no-includes` (never following
 * `include.path`/`includeIf` — those keys are themselves refused, not resolved: `--no-includes`
 * means git never expands them, but the key itself still appears literally in this listing,
 * confirmed against real git 2.55.0) and refuses unless every key present is a member of the
 * closed allowlist of ordinary-fresh-clone keys above.
 *
 * Refuses (non-exhaustively — the allowlist is closed, so anything not on it refuses): any
 * `include.*`/`includeIf.*`, any `filter.*`, any `http.*`, any `url.*.insteadOf`, `core.hooksPath`,
 * `core.fsmonitor`, `core.sshCommand`, `core.askPass`, `credential.*`, `protocol.*.allow`, any
 * `extensions.*`, and any sparse-checkout setting.
 */
export async function inventoryCheckoutConfig(options: ConfigInventoryOptions): Promise<ConfigInventoryOutcome> {
  const {checkoutPath, gitRunner = runGit, timeoutMs, uid, gid} = options

  let canonical: string
  try {
    canonical = await realpath(checkoutPath)
  } catch {
    return {kind: 'inspection-failed'}
  }

  const env = buildNeutralGitEnv()
  const outcome = await gitRunner(
    gitInvocation(canonical, canonical, ['config', '--local', '--no-includes', '--list', '-z']),
    {cwd: canonical, env, timeoutMs, uid, gid},
  )

  // `--list` on a repo with no local config at all would be unusual for an existing checkout, but
  // mirror inspect.ts's fail-open-on-empty-match convention for a clean "exit 1, no output" shape
  // rather than treating it as inspection failure.
  if (outcome.kind === 'failed' && outcome.code === 1 && outcome.stdout.length === 0) {
    return {kind: 'allowed'}
  }
  if (outcome.kind !== 'ok') return {kind: 'inspection-failed'}

  const keys = parseConfigListKeys(outcome.stdout)
  const disallowedKeys: string[] = []
  const seen = new Set<string>()
  for (const key of keys) {
    if (isAllowedConfigKey(key)) continue
    if (seen.has(key)) continue
    seen.add(key)
    disallowedKeys.push(key)
  }

  if (disallowedKeys.length > 0) return {kind: 'refused', disallowedKeys}
  return {kind: 'allowed'}
}

// ---------------------------------------------------------------------------
// Layout checks (metadata attacks)
// ---------------------------------------------------------------------------

export type LayoutRefusalReason =
  | 'core-worktree'
  | 'gitfile'
  | 'symlinked-git-dir'
  | 'symlinked-config'
  | 'alternates'
  | 'replace-refs'
  | 'grafts'
  | 'shallow'
  | 'partial-clone'
  | 'linked-worktree'
  | 'unsupported-index-flag'
  | 'bare-repository'

export type LayoutCheckOutcome =
  | {readonly kind: 'ok'}
  | {readonly kind: 'refused'; readonly reason: LayoutRefusalReason}
  | {readonly kind: 'inspection-failed'}
  | {readonly kind: 'termination-unconfirmed'}

export type CheckoutLayoutRunner = (options: {
  readonly checkoutPath: string
  readonly timeoutMs: number
  readonly uid: number | undefined
  readonly gid: number | undefined
}) => Promise<
  | {readonly kind: 'ok'; readonly stdout: string}
  | {readonly kind: 'failed'}
  | {readonly kind: 'termination-unconfirmed'}
>

export interface LayoutCheckOptions {
  readonly checkoutPath: string
  readonly timeoutMs: number
  readonly uid?: number
  readonly gid?: number
  readonly runner?: CheckoutLayoutRunner
}

/**
 * Refuses a checkout whose on-disk layout deviates from an ordinary non-bare, non-worktree-linked
 * clone with a real (non-symlinked) `.git` directory and `.git/config` file, no `core.worktree`
 * relocation, no `objects/info/alternates` (or `http-alternates`), no replace refs (loose under
 * `refs/replace/`, or packed in `packed-refs`), no grafts (`info/grafts`), no shallow
 * (`.git/shallow`), no partial clone (`extensions.partialClone`/promisor remotes), no linked
 * worktrees (`.git/worktrees/*`), and no unsupported index flags (split index, sparse index, or
 * any other `extensions.*` beyond a fresh clone).
 *
 * Every check inspects the filesystem and repository metadata directly — NEVER by trusting
 * anything the checkout's own (agent-writable) `.git/config` claims about itself. The entire
 * pathname inspection runs as the agent uid in a bounded child; config and packed-refs are opened
 * with no-follow/nonblocking descriptor flags before their bytes are read.
 */
export async function checkCheckoutLayout(options: LayoutCheckOptions): Promise<LayoutCheckOutcome> {
  const outcome = await (options.runner ?? runCheckoutLayoutChild)({
    checkoutPath: options.checkoutPath,
    timeoutMs: options.timeoutMs,
    uid: options.uid,
    gid: options.gid,
  })
  if (outcome.kind === 'termination-unconfirmed') return outcome
  if (outcome.kind !== 'ok') return {kind: 'inspection-failed'}
  let parsed: unknown
  try {
    parsed = JSON.parse(outcome.stdout)
  } catch {
    return {kind: 'inspection-failed'}
  }
  if (typeof parsed !== 'object' || parsed === null || !('kind' in parsed)) return {kind: 'inspection-failed'}
  const result = parsed as {readonly kind: unknown; readonly reason?: unknown}
  if (result.kind === 'ok') return {kind: 'ok'}
  if (result.kind === 'inspection-failed') return {kind: 'inspection-failed'}
  if (
    result.kind === 'refused' &&
    typeof result.reason === 'string' &&
    [
      'core-worktree',
      'gitfile',
      'symlinked-git-dir',
      'symlinked-config',
      'alternates',
      'replace-refs',
      'grafts',
      'shallow',
      'partial-clone',
      'linked-worktree',
      'unsupported-index-flag',
      'bare-repository',
    ].includes(result.reason)
  )
    return {kind: 'refused', reason: result.reason as LayoutRefusalReason}
  return {kind: 'inspection-failed'}
}

// ---------------------------------------------------------------------------
// Temp-index cleanliness
// ---------------------------------------------------------------------------

export type CleanlinessOutcome =
  | {readonly kind: 'clean'}
  | {readonly kind: 'dirty'; readonly changedPaths: readonly string[]}
  | {readonly kind: 'inspection-failed'}

export interface CleanlinessCheckOptions {
  readonly checkoutPath: string
  readonly headSha: string
  readonly gitRunner?: GitRunnerFn
  readonly timeoutMs: number
  readonly uid?: number
  readonly gid?: number
}

/** Parses `git status --porcelain=v2 -z` output (NUL-terminated records, `--no-renames` assumed so type-'2' rename records never occur) into the repo-relative paths of every changed/untracked entry. Ignored entries are never listed since `--ignored` is never passed. */
function parseStatusPorcelainPaths(stdout: string): readonly string[] {
  const paths: string[] = []
  for (const record of stdout.split('\0')) {
    if (record.length === 0) continue
    const marker = record.charAt(0)
    if (marker === '?' || marker === '!') {
      paths.push(record.slice(2))
      continue
    }
    // Ordinary changed entry: `1 XY sub mH mI mW hH hI path` — 8 space-separated fields precede path.
    if (marker === '1') {
      const path = pathAfterFields(record, 8)
      if (path !== null) paths.push(path)
      continue
    }
    // Unmerged entry: `u XY sub m1 m2 m3 mW h1 h2 h3 path` — 10 fields precede path. Shouldn't
    // occur (a temp index built from a single tree has no merge state), handled defensively.
    if (marker === 'u') {
      const path = pathAfterFields(record, 10)
      if (path !== null) paths.push(path)
      continue
    }
    // Renamed/copied ('2') records are suppressed by --no-renames and never expected here.
  }
  return paths
}

function pathAfterFields(record: string, fieldCount: number): string | null {
  let idx = 0
  for (let seen = 0; seen < fieldCount; seen += 1) {
    const nextSpace = record.indexOf(' ', idx)
    if (nextSpace === -1) return null
    idx = nextSpace + 1
  }
  return record.slice(idx)
}

/**
 * Builds a TEMPORARY index — `GIT_INDEX_FILE` pointed at a freshly created path under the
 * service's own temp directory (`os.tmpdir()`), never `.git/index` — populated from `headSha` via
 * `git read-tree`, refreshed against the worktree (`git update-index --refresh`), then compared
 * against the real working tree (tracked-file content and untracked presence; ignored files are
 * excluded since `--ignored` is never passed) via `git status`.
 *
 * The checkout's own (agent-writable) `.git/index` — including any assume-unchanged,
 * skip-worktree, split-index, sparse-index, or manipulated stat-cache bits it carries — is NEVER
 * consulted for this decision; only the temporary index built fresh from `headSha` is. Every
 * configured `filter.<name>.*` driver is enumerated and neutralized before `update-index --refresh`
 * or `status` run (mirroring `inspect.ts`'s own filter neutralization for the same reason: a
 * planted clean/smudge/process driver must never execute during this comparison). The temp index
 * (and its containing directory) is removed on every return path, success or failure.
 */
export async function checkTempIndexCleanliness(options: CleanlinessCheckOptions): Promise<CleanlinessOutcome> {
  const {checkoutPath, headSha, gitRunner = runGit, timeoutMs, uid, gid} = options

  let canonical: string
  try {
    canonical = await realpath(checkoutPath)
  } catch {
    return {kind: 'inspection-failed'}
  }

  let tempIndexDir: string
  try {
    tempIndexDir = await mkdtemp(join(tmpdir(), 'checkout-profile-tmpindex-'))
  } catch {
    return {kind: 'inspection-failed'}
  }

  try {
    // `mkdtemp` creates this directory owned by the CURRENT (service) process, mode 0700 --
    // production wiring runs git here as AGENT_UID/AGENT_GID, which could never write an index
    // into a directory the root-owned service just created. Hand ownership over before ANY git
    // subprocess runs (including filter-driver enumeration below), so nothing ever hits a
    // permission error against this directory. Skipped when uid/gid are both omitted -- the local
    // test/dev shape, where git already runs as the current process's own identity and the
    // directory is already usable as-is.
    if (uid !== undefined || gid !== undefined) {
      try {
        await lchown(tempIndexDir, uid ?? -1, gid ?? -1)
      } catch {
        return {kind: 'inspection-failed'}
      }
    }

    const baseEnv = buildNeutralGitEnv()

    // Fail closed: enumerate every configured filter driver before anything that reads working-tree
    // content runs. If this fails, times out, or returns something unparseable, neither
    // `update-index --refresh` nor `status` may run.
    const filterEnumeration = await enumerateFilterDrivers(canonical, baseEnv, gitRunner, timeoutMs, uid, gid)
    if (filterEnumeration.kind === 'failed') return {kind: 'inspection-failed'}

    const tempIndexPath = join(tempIndexDir, 'index')
    const env: Record<string, string> = {
      ...baseEnv,
      ...buildFilterNeutralizationEnv(filterEnumeration.drivers),
      GIT_INDEX_FILE: tempIndexPath,
    }

    const readTreeOutcome = await gitRunner(gitInvocation(canonical, canonical, ['read-tree', headSha]), {
      cwd: canonical,
      env,
      timeoutMs,
      uid,
      gid,
    })
    if (readTreeOutcome.kind !== 'ok') return {kind: 'inspection-failed'}

    const refreshOutcome = await gitRunner(gitInvocation(canonical, canonical, ['update-index', '--refresh', '-q']), {
      cwd: canonical,
      env,
      timeoutMs,
      uid,
      gid,
    })
    // A non-zero exit here means "some paths need updating" — exactly what a genuinely dirty
    // checkout looks like — not a failure of this check. Only an unconfirmed/timed-out subprocess
    // fails closed; a `failed` (non-zero exit, confirmed) outcome is expected and informational.
    if (refreshOutcome.kind === 'timeout' || refreshOutcome.kind === 'termination-unconfirmed') {
      return {kind: 'inspection-failed'}
    }

    const statusOutcome = await gitRunner(
      gitInvocation(canonical, canonical, [
        'status',
        '--porcelain=v2',
        '-z',
        '--untracked-files=all',
        '--no-renames',
        '--ignore-submodules=all',
      ]),
      {cwd: canonical, env, timeoutMs, uid, gid},
    )
    if (statusOutcome.kind !== 'ok') return {kind: 'inspection-failed'}

    const changedPaths = parseStatusPorcelainPaths(statusOutcome.stdout)
    if (changedPaths.length === 0) return {kind: 'clean'}
    return {kind: 'dirty', changedPaths}
  } finally {
    await rm(tempIndexDir, {recursive: true, force: true}).catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// Path-obstruction preflight
// ---------------------------------------------------------------------------

export type ObstructionKind = 'exact-conflict' | 'prefix-conflict' | 'identical-content' | 'symlink-ancestor'

export interface Obstruction {
  /** Repo-relative (never absolute, never checkout-path-prefixed), matching git's own path conventions (e.g. as reported by `git status`/`git ls-tree`). */
  readonly path: string
  readonly kind: ObstructionKind
}

export type ObstructionPreflightOutcome =
  | {readonly kind: 'clear'}
  | {readonly kind: 'obstructed'; readonly obstructions: readonly Obstruction[]}
  | {readonly kind: 'inspection-failed'}
  | {readonly kind: 'termination-unconfirmed'}

export const MAX_OBSTRUCTION_CONTENT_BYTES = 1024 * 1024

export interface ObstructionPreflightOptions {
  readonly checkoutPath: string
  readonly fromSha: string
  readonly toSha: string
  readonly gitRunner?: GitRunnerFn
  readonly timeoutMs: number
  readonly uid?: number
  readonly gid?: number
  readonly obstructionRunner?: ObstructionPathRunner
}

interface TreeEntry {
  readonly mode: string
  readonly type: string
  readonly sha: string
  readonly path: string
}

/** Parses `git ls-tree -r --full-tree -z <sha>` output (`<mode> <type> <sha>\t<path>` records, NUL-terminated) into structured entries. */
function parseLsTreeEntries(stdout: string): readonly TreeEntry[] {
  const entries: TreeEntry[] = []
  for (const record of stdout.split('\0')) {
    if (record.length === 0) continue
    const tabIndex = record.indexOf('\t')
    if (tabIndex === -1) continue
    const meta = record.slice(0, tabIndex).split(' ')
    const [mode, type, sha] = meta
    const path = record.slice(tabIndex + 1)
    if (mode === undefined || type === undefined || sha === undefined || path.length === 0) continue
    entries.push({mode, type, sha, path})
  }
  return entries
}

/**
 * Compares the `fromSha` and `toSha` trees against the live filesystem in BOTH prefix directions —
 * an incoming file `a` against an existing directory `a/b`, and an incoming directory `a/b`
 * against an existing file `a` — and reports every untracked/ignored obstruction, exact-path
 * conflict, identical-content obstruction, and symlink ancestor found.
 *
 * Operates purely on git's OBJECT DATABASE (`ls-tree`, `cat-file`) for both trees — never on the
 * working tree via `status`/`diff` — so no filter driver ever runs here (clean/smudge only fire
 * on index<->worktree operations, never on tree-to-tree object reads).
 *
 * Precondition (enforced by the caller's admission ordering, not re-verified here): the working
 * tree already equals `fromSha` exactly for every path `fromSha` tracks (established by a prior
 * `checkTempIndexCleanliness` pass). Under that precondition, any on-disk entry NOT tracked in
 * `fromSha` is necessarily untracked or ignored — never a legitimately-tracked file this merge
 * would update through the ordinary fast-forward machinery.
 *
 * Must run, and refuse on any obstruction, BEFORE any mutation — never delegated to `git merge
 * --ff-only`'s own overwrite behaviour, which silently overwrites ignored files that obstruct
 * incoming paths (the exact gap `--no-overwrite-ignore` alone does not close for every obstruction
 * shape — see Unit 2's collisions fixtures).
 */
export async function preflightObstructions(
  options: ObstructionPreflightOptions,
): Promise<ObstructionPreflightOutcome> {
  const {
    checkoutPath,
    fromSha,
    toSha,
    gitRunner = runGit,
    timeoutMs,
    uid,
    gid,
    obstructionRunner = runCheckoutObstructionChild,
  } = options

  let canonical: string
  try {
    canonical = await realpath(checkoutPath)
  } catch {
    return {kind: 'inspection-failed'}
  }

  const env = buildNeutralGitEnv()
  const run = async (args: readonly string[]) =>
    gitRunner(gitInvocation(canonical, canonical, args), {cwd: canonical, env, timeoutMs, uid, gid})

  const hNamesOutcome = await run(['ls-tree', '-r', '--full-tree', '--name-only', '-z', fromSha])
  if (hNamesOutcome.kind !== 'ok') return {kind: 'inspection-failed'}
  const trackedInFrom = new Set(hNamesOutcome.stdout.split('\0').filter(entry => entry.length > 0))

  const tEntriesOutcome = await run(['ls-tree', '-r', '--full-tree', '-z', toSha])
  if (tEntriesOutcome.kind !== 'ok') return {kind: 'inspection-failed'}
  const toEntries = parseLsTreeEntries(tEntriesOutcome.stdout)

  const obstructions: Obstruction[] = []
  const reportedPaths = new Set<string>()

  for (const entry of toEntries) {
    if (trackedInFrom.has(entry.path)) continue

    const ancestorOutcome = await findAncestorObstruction(canonical, entry.path, trackedInFrom)
    if (ancestorOutcome !== null) {
      if (reportedPaths.has(ancestorOutcome.path) === false) {
        reportedPaths.add(ancestorOutcome.path)
        obstructions.push(ancestorOutcome)
      }
      continue
    }

    if (reportedPaths.has(entry.path)) continue

    const absPath = join(canonical, entry.path)
    let entryStat: Awaited<ReturnType<typeof lstat>>
    try {
      entryStat = await lstat(absPath)
    } catch {
      continue // doesn't exist on disk -- nothing to obstruct
    }

    if (entryStat.isDirectory()) {
      reportedPaths.add(entry.path)
      obstructions.push({path: entry.path, kind: 'prefix-conflict'})
      continue
    }

    const kind = await classifyExactObstruction({
      canonical,
      entry,
      entryStat,
      run,
      obstructionRunner,
      timeoutMs,
      uid,
      gid,
    })
    if (kind === 'termination-unconfirmed') return {kind}
    if (kind === 'inspection-failed') return {kind: 'inspection-failed'}
    reportedPaths.add(entry.path)
    obstructions.push({path: entry.path, kind})
  }

  if (obstructions.length === 0) return {kind: 'clear'}
  return {kind: 'obstructed', obstructions}
}

/**
 * Walks `path`'s ancestor directory chain (shallowest first) looking for an on-disk entry that
 * blocks git from materializing the directory structure the incoming path needs: a symlink (any
 * write through it could land outside the checkout entirely) or a plain file where a directory
 * must exist. An ancestor already tracked in `fromSha` is never reported — the ordinary
 * fast-forward machinery is trusted to replace a tracked entry with a tracked directory (or vice
 * versa) safely; only an UNTRACKED ancestor blocking a NEW path is this preflight's concern.
 * Returns null when no ancestor obstruction is found (the caller then checks the exact path).
 */
async function findAncestorObstruction(
  canonical: string,
  path: string,
  trackedInFrom: ReadonlySet<string>,
): Promise<Obstruction | null> {
  const segments = path.split('/')
  let ancestorRel = ''
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i]
    if (segment === undefined) break
    ancestorRel = ancestorRel.length === 0 ? segment : `${ancestorRel}/${segment}`

    let ancestorStat: Awaited<ReturnType<typeof lstat>>
    try {
      ancestorStat = await lstat(join(canonical, ancestorRel))
    } catch {
      return null // ancestor doesn't exist yet -- nothing blocking, and none deeper can exist either
    }

    if (ancestorStat.isDirectory()) continue
    if (trackedInFrom.has(ancestorRel)) continue

    return {path: ancestorRel, kind: ancestorStat.isSymbolicLink() ? 'symlink-ancestor' : 'prefix-conflict'}
  }
  return null
}

/** Classifies an exact-path collision (on-disk entry exists, untracked in `fromSha`, not a directory) as `identical-content` when its bytes/target match what `toSha` introduces, `exact-conflict` otherwise. A type mismatch (file vs symlink) is never `identical-content`. */
async function classifyExactObstruction(params: {
  readonly canonical: string
  readonly entry: TreeEntry
  readonly entryStat: Awaited<ReturnType<typeof lstat>>
  readonly run: (args: readonly string[]) => Promise<Awaited<ReturnType<GitRunnerFn>>>
  readonly obstructionRunner: ObstructionPathRunner
  readonly timeoutMs: number
  readonly uid: number | undefined
  readonly gid: number | undefined
}): Promise<ObstructionKind | 'inspection-failed' | 'termination-unconfirmed'> {
  const {canonical, entry, entryStat, run, obstructionRunner, timeoutMs, uid, gid} = params
  const incomingIsSymlink = entry.mode === '120000'
  const onDiskIsSymlink = entryStat.isSymbolicLink()

  if (incomingIsSymlink !== onDiskIsSymlink) return 'exact-conflict'

  const observed = await obstructionRunner({
    checkoutPath: canonical,
    relativePath: entry.path,
    maxBytes: MAX_OBSTRUCTION_CONTENT_BYTES,
    timeoutMs,
    uid,
    gid,
  })
  if (observed.kind === 'termination-unconfirmed') return observed.kind
  if (observed.kind === 'special' || observed.kind === 'too-large' || observed.kind === 'failed')
    return 'exact-conflict'
  if (onDiskIsSymlink && observed.kind !== 'symlink') return 'exact-conflict'
  if (!onDiskIsSymlink && observed.kind !== 'file') return 'exact-conflict'
  const onDiskContent = observed.kind === 'symlink' ? observed.target : observed.text

  const blobOutcome = await run(['cat-file', '-p', entry.sha])
  if (blobOutcome.kind !== 'ok') return 'inspection-failed'

  return blobOutcome.stdout === onDiskContent ? 'identical-content' : 'exact-conflict'
}
