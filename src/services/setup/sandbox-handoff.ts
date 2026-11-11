import type {Result} from '@bfra.me/es/result'
import type {PrivilegedRun} from '@fro-bot/runtime'
import type {Logger} from '../../shared/logger.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {err, ok} from '@bfra.me/es/result'
import {toErrorMessage} from '../../shared/errors.js'

/**
 * Handoff and take-back of the paths `isolate-agent` shares with the sandbox user (fro-bot/agent#2135).
 *
 * One {@link HandoffManifest} drives both directions. The sandbox gets exactly what the model needs:
 * - the checkout, through an ACL (`rwX` plus default entries), so the files stay the runner's;
 * - a few directories handed over by `chown` (the four OpenCode XDG dirs, the key dir, the response dir, the gh config);
 * - read access to the admitted repo-skills tree and the attachment dir.
 *
 * Everything else runner-private is default-deny. Along the traverse chain to each root, every sibling the sandbox does
 * not need gets a `u:<uid>:---` ACL entry, and the temp tree is tightened to 0700. The spike found that uid separation
 * alone leaves `GITHUB_ENV` world-readable and `~/.docker/config.json` reachable once `/home/runner` is traversable.
 *
 * Take-back runs only after the sandbox is verified dead. It never follows a link: roots and ancestors are checked
 * first, `find -P -xdev -user <sandbox uid> -exec chown -h` moves back only inodes the sandbox owns (a hardlink to a
 * runner-owned file keeps its owner), and the trusted `.git` metadata copy is written over whatever the model left.
 */

export interface HandoffIds {
  readonly runnerUid: number
  readonly runnerGid: number
  readonly sandboxUid: number
  readonly sandboxGid: number
}

export interface HandoffTools {
  readonly setfacl: string
  readonly getfacl: string
  readonly find: string
  readonly chown: string
  readonly chmod: string
}

export interface HandoffManifest {
  readonly ids: HandoffIds
  readonly runnerHome: string
  readonly runnerTemp: string
  /** The checkout: ACL `rwX` plus default entries. */
  readonly workspace: string
  /** Directories handed over by chown. Created first when missing. */
  readonly handedOver: readonly string[]
  /** Runner-owned directories the sandbox reads: recursive `rX` plus a default entry for files written later. */
  readonly readable: readonly string[]
  /** Runner-owned directories the sandbox only has to traverse (they sit on the chain to a `readable` root). */
  readonly traverseOnly: readonly string[]
  /** Directories tightened to 0700 (the traverse grant keeps the path reachable). */
  readonly tighten: readonly string[]
}

export interface HandoffDeps {
  readonly run: PrivilegedRun
  readonly tools: HandoffTools
  readonly logger: Logger
}

interface TouchedPath {
  readonly path: string
  readonly mode: number
  /** The ACL as `getfacl` printed it before this run changed anything, stored in the private snapshot dir. */
  readonly aclFile: string
  readonly extended: boolean
}

interface GitSnapshot {
  readonly dir: string
  readonly config: boolean
  readonly configWorktree: boolean
  readonly hooks: boolean
  readonly info: boolean
}

/** What handoff changed, so take-back reverses exactly that. */
export interface HandoffJournal {
  readonly snapshotDir: string
  readonly touched: TouchedPath[]
  /** Roots whose runner-owned inodes were chowned to the sandbox. */
  readonly chowned: string[]
  /** Roots a recursive ACL was applied to; `setfacl -R -P -b` clears them. */
  readonly aclTrees: string[]
  git: GitSnapshot | null
  /** True when `.git` existed at handoff. A `.git` that appears during the run is unsafe. */
  gitPresent: boolean
}

export type TakeBackOutcome = {readonly status: 'restored'} | {readonly status: 'unsafe'; readonly reason: string}

class HandoffError extends Error {}

const GIT_METADATA = ['config', 'config.worktree', 'hooks', 'info'] as const

function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function ancestorsOf(target: string): string[] {
  const result: string[] = []
  let current = path.dirname(target)
  while (current !== path.dirname(current)) {
    result.push(current)
    current = path.dirname(current)
  }
  return result
}

async function must(run: PrivilegedRun, argv: readonly string[], what: string): Promise<string> {
  const result = await run(argv)
  if (result.exitCode !== 0) throw new HandoffError(`${what} failed (exit ${result.exitCode})`)
  return result.stdout
}

function everyRoot(manifest: HandoffManifest): string[] {
  return [manifest.workspace, ...manifest.handedOver, ...manifest.readable]
}

/**
 * Root and ancestor safety, checked before handoff and again before take-back. A root must be a real directory owned by
 * the runner (or, for a handed-over one at take-back, the sandbox). Every ancestor must be a real directory owned by the
 * runner or root, not world-writable without the sticky bit, and carry no sandbox write grant. A swapped link or a
 * writable parent would let the sandbox redirect a privileged walk.
 */
export async function verifyRoots(
  manifest: HandoffManifest,
  deps: HandoffDeps,
  phase: 'handoff' | 'take-back',
): Promise<string | null> {
  const {runnerUid, sandboxUid} = manifest.ids
  const ancestors = new Set<string>()
  const check = async (
    target: string,
    kind: 'ancestor' | 'root',
    allowed: ReadonlySet<number>,
  ): Promise<string | null> => {
    let stats
    try {
      stats = await fs.lstat(target)
    } catch {
      return `${kind} ${target} is missing`
    }
    if (stats.isSymbolicLink()) return `${kind} ${target} is a symlink`
    if (!stats.isDirectory()) return `${kind} ${target} is not a directory`
    if (!allowed.has(stats.uid)) return `${kind} ${target} is owned by uid ${stats.uid}`
    if (kind === 'ancestor' && (stats.mode & 0o002) !== 0 && (stats.mode & 0o1000) === 0) {
      return `ancestor ${target} is world-writable without the sticky bit`
    }
    return null
  }

  for (const root of everyRoot(manifest)) {
    const handedOver = manifest.handedOver.includes(root)
    const allowed = new Set([runnerUid, 0, ...(phase === 'take-back' && handedOver ? [sandboxUid] : [])])
    const problem = await check(root, 'root', allowed)
    if (problem !== null) return problem
    for (const ancestor of ancestorsOf(root)) ancestors.add(ancestor)
  }
  for (const ancestor of ancestors) {
    const problem = await check(ancestor, 'ancestor', new Set([runnerUid, 0]))
    if (problem !== null) return problem
    const stats = await fs.lstat(ancestor)
    if (stats.uid !== runnerUid) continue
    const acl = await deps.run([deps.tools.getfacl, '-p', '-c', ancestor])
    if (acl.exitCode !== 0) return `could not read the ACL of ${ancestor}`
    if (grantsSandboxWrite(acl.stdout, sandboxUid)) return `ancestor ${ancestor} grants the sandbox write access`
  }
  return null
}

/** True when an ACL names the sandbox uid with a write bit. */
export function grantsSandboxWrite(aclText: string, sandboxUid: number): boolean {
  return aclText.split('\n').some(line => new RegExp(`^(default:)?user:${sandboxUid}:[r-]w`).test(line.trim()))
}

interface LockPlan {
  readonly traverse: string[]
  readonly deny: string[]
  readonly tighten: string[]
}

/**
 * Default-deny plan. The chain is every ancestor of every root. In each runner-owned chain dir the sandbox gets
 * traverse-only, and every entry that is not itself on the chain or a root gets a deny entry (inside the runner home
 * and the temp tree). Both are scanned even when no root sits under them. Symlinks are never ACL'd, and root-owned entries are left
 * alone.
 */
export async function planLocks(manifest: HandoffManifest): Promise<LockPlan> {
  const roots = new Set(everyRoot(manifest))
  const chain = new Set<string>()
  for (const root of [...roots, ...manifest.traverseOnly]) {
    for (const ancestor of ancestorsOf(root)) chain.add(ancestor)
  }
  for (const dir of manifest.traverseOnly) chain.add(dir)
  const scan = new Set([...chain, manifest.runnerHome, manifest.runnerTemp])

  const traverse: string[] = []
  const deny = new Set<string>()
  for (const dir of [...scan].sort()) {
    let stats
    try {
      stats = await fs.lstat(dir)
    } catch {
      continue
    }
    if (stats.isSymbolicLink() || !stats.isDirectory() || stats.uid !== manifest.ids.runnerUid) continue
    if (chain.has(dir)) traverse.push(dir)
    // Siblings are denied only inside the runner home and the temp tree: those hold the runner's secrets. A runner-owned
    // ancestor elsewhere (a checkout under /srv, say) is traversed but its other contents are not this run's business.
    if (
      !inside(manifest.runnerHome, dir) &&
      dir !== manifest.runnerHome &&
      !inside(manifest.runnerTemp, dir) &&
      dir !== manifest.runnerTemp
    ) {
      continue
    }
    for (const entry of await fs.readdir(dir)) {
      const candidate = path.join(dir, entry)
      if (chain.has(candidate) || roots.has(candidate)) continue
      if ([...roots].some(root => inside(root, candidate))) continue
      let entryStats
      try {
        entryStats = await fs.lstat(candidate)
      } catch {
        continue
      }
      if (entryStats.isSymbolicLink() || entryStats.uid !== manifest.ids.runnerUid) continue
      deny.add(candidate)
    }
  }
  const tighten: string[] = []
  for (const dir of manifest.tighten) {
    try {
      const stats = await fs.lstat(dir)
      if (stats.isDirectory() && !stats.isSymbolicLink() && stats.uid === manifest.ids.runnerUid) tighten.push(dir)
    } catch {
      // Absent (for example no `_runner_file_commands` outside a runner): nothing to tighten.
    }
  }
  return {traverse, deny: [...deny], tighten}
}

/** Applies every change with sudo and records each so take-back can reverse it. Rolls back on any failure. */
export async function handOff(manifest: HandoffManifest, deps: HandoffDeps): Promise<Result<HandoffJournal, string>> {
  const {run, tools} = deps
  const {runnerUid, sandboxUid, sandboxGid} = manifest.ids
  // Created as the runner before the first check, so every root exists when it is verified.
  for (const dir of manifest.handedOver) await fs.mkdir(dir, {recursive: true})
  const problem = await verifyRoots(manifest, deps, 'handoff')
  if (problem !== null) return err(`Refusing to hand files to the sandbox: ${problem}`)

  const snapshotDir = await fs.mkdtemp(path.join(manifest.runnerTemp, 'fro-bot-sandbox-trust-'))
  await fs.chmod(snapshotDir, 0o700)
  const journal: HandoffJournal = {
    snapshotDir,
    touched: [],
    chowned: [],
    aclTrees: [],
    git: null,
    gitPresent: false,
  }

  try {
    // 1. Trusted copy of the git metadata the runner will rely on after the model has run.
    await snapshotGit(manifest, journal)

    // 2. Locks: record, then apply.
    const plan = await planLocks(manifest)
    for (const target of new Set([...plan.traverse, ...plan.deny, ...plan.tighten])) {
      await recordMeta(target, journal, deps)
    }
    for (const target of plan.tighten) await must(run, [tools.chmod, '0700', target], `chmod ${target}`)
    for (const target of plan.traverse) {
      await must(run, [tools.setfacl, '-P', '-m', `u:${sandboxUid}:--x`, target], `traverse grant on ${target}`)
    }
    for (const target of plan.deny) {
      await must(run, [tools.setfacl, '-P', '-m', `u:${sandboxUid}:---`, target], `deny entry on ${target}`)
    }

    // 3. Checkout: ACL for the sandbox, default entries for both users so new files stay reachable for the runner.
    journal.aclTrees.push(manifest.workspace)
    await must(run, [tools.setfacl, '-R', '-P', '-m', `u:${sandboxUid}:rwX`, manifest.workspace], 'checkout ACL')
    await must(
      run,
      [
        tools.find,
        '-P',
        manifest.workspace,
        '-xdev',
        '-type',
        'd',
        '-exec',
        tools.setfacl,
        '-P',
        '-d',
        '-m',
        `u:${sandboxUid}:rwX,u:${runnerUid}:rwX`,
        '{}',
        '+',
      ],
      'checkout default ACL',
    )

    // 4. Handed-over directories: created as the runner, then chowned. The runner keeps an ACL entry so it can still
    // write into them during the run (the prompt artifact goes to the log dir).
    for (const dir of manifest.handedOver) {
      journal.chowned.push(dir)
      await must(
        run,
        [
          tools.find,
          '-P',
          dir,
          '-xdev',
          '-user',
          String(runnerUid),
          '-exec',
          tools.chown,
          '-h',
          `${sandboxUid}:${sandboxGid}`,
          '{}',
          '+',
        ],
        `handing ${dir} to the sandbox`,
      )
      journal.aclTrees.push(dir)
      await must(
        run,
        [
          tools.find,
          '-P',
          dir,
          '-xdev',
          '-type',
          'd',
          '-exec',
          tools.setfacl,
          '-P',
          '-m',
          `u:${runnerUid}:rwx,d:u:${runnerUid}:rwx`,
          '{}',
          '+',
        ],
        `runner ACL on ${dir}`,
      )
    }

    // 5. Read-only grants.
    for (const dir of manifest.readable) {
      journal.aclTrees.push(dir)
      await must(run, [tools.setfacl, '-R', '-P', '-m', `u:${sandboxUid}:rX`, dir], `read grant on ${dir}`)
      await must(
        run,
        [
          tools.find,
          '-P',
          dir,
          '-xdev',
          '-type',
          'd',
          '-exec',
          tools.setfacl,
          '-P',
          '-d',
          '-m',
          `u:${sandboxUid}:rX`,
          '{}',
          '+',
        ],
        `default read grant on ${dir}`,
      )
    }
  } catch (error) {
    const message = error instanceof HandoffError ? error.message : toErrorMessage(error)
    deps.logger.warning('Sandbox handoff failed; rolling back', {error: message})
    // The sandbox never ran, so there is nothing to stop; take-back reverses what was recorded.
    const rollback = await takeBack(manifest, journal, deps)
    return err(
      `Sandbox handoff failed: ${message}${rollback.status === 'restored' ? '' : ` (rollback incomplete: ${rollback.reason})`}`,
    )
  }
  return ok(journal)
}

async function recordMeta(target: string, journal: HandoffJournal, deps: HandoffDeps): Promise<void> {
  if (journal.touched.some(entry => entry.path === target)) return
  const stats = await fs.lstat(target)
  const acl = await deps.run([deps.tools.getfacl, '-p', '-c', target])
  if (acl.exitCode !== 0) throw new HandoffError(`reading the ACL of ${target} failed (exit ${acl.exitCode})`)
  const aclFile = path.join(journal.snapshotDir, `acl-${journal.touched.length}.txt`)
  await fs.writeFile(aclFile, acl.stdout, {mode: 0o600})
  // A base ACL is exactly user::, group::, other::. Anything else (named entries, mask, default) is extended.
  const extended = acl.stdout
    .split('\n')
    .some(line => line.trim().length > 0 && !/^(?:user::|group::|other::)/.test(line.trim()))
  journal.touched.push({path: target, mode: stats.mode & 0o7777, aclFile, extended})
}

async function snapshotGit(manifest: HandoffManifest, journal: HandoffJournal): Promise<void> {
  const gitDir = path.join(manifest.workspace, '.git')
  let stats
  try {
    stats = await fs.lstat(gitDir)
  } catch {
    return
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new HandoffError(
      'the checkout .git is not a plain directory (a symlink or a gitfile); it cannot be snapshotted',
    )
  }
  journal.gitPresent = true
  const present: Record<string, boolean> = {}
  for (const item of GIT_METADATA) {
    const source = path.join(gitDir, item)
    try {
      await fs.lstat(source)
    } catch {
      present[item] = false
      continue
    }
    present[item] = true
    await fs.cp(source, path.join(journal.snapshotDir, 'git', item), {
      recursive: true,
      verbatimSymlinks: true,
      errorOnExist: true,
      force: false,
    })
  }
  journal.git = {
    dir: path.join(journal.snapshotDir, 'git'),
    config: present.config === true,
    configWorktree: present['config.worktree'] === true,
    hooks: present.hooks === true,
    info: present.info === true,
  }
}

/**
 * Reverses handoff, in this order: verify, chown the sandbox's inodes back, restore the git metadata, remove ACLs and
 * restore recorded modes. Only call after the sandbox is verified dead. Any failure returns `unsafe`; nothing is
 * retried or skipped.
 */
export async function takeBack(
  manifest: HandoffManifest,
  journal: HandoffJournal,
  deps: HandoffDeps,
): Promise<TakeBackOutcome> {
  const {run, tools} = deps
  const {runnerUid, runnerGid, sandboxUid} = manifest.ids
  try {
    const problem = await verifyRoots(manifest, deps, 'take-back')
    if (problem !== null) return {status: 'unsafe', reason: problem}
    // Checked before anything is moved: a swapped `.git` must not be walked, restored into or followed.
    const gitDirProblem = await checkGitDir(manifest, journal, 'before')
    if (gitDirProblem !== null) return {status: 'unsafe', reason: gitDirProblem}

    for (const root of [manifest.workspace, ...journal.chowned]) {
      await must(
        run,
        [
          tools.find,
          '-P',
          root,
          '-xdev',
          '-user',
          String(sandboxUid),
          '-exec',
          tools.chown,
          '-h',
          `${runnerUid}:${runnerGid}`,
          '{}',
          '+',
        ],
        `taking ${root} back`,
      )
      const remaining = await run([tools.find, '-P', root, '-xdev', '-user', String(sandboxUid), '-print', '-quit'])
      if (remaining.exitCode !== 0 || remaining.stdout.trim().length > 0) {
        return {status: 'unsafe', reason: `${root} still holds files owned by the sandbox`}
      }
    }

    const gitProblem = await restoreGit(manifest, journal)
    if (gitProblem !== null) return {status: 'unsafe', reason: gitProblem}

    for (const tree of journal.aclTrees) {
      await must(run, [tools.setfacl, '-R', '-P', '-b', tree], `clearing ACLs on ${tree}`)
    }
    for (const entry of [...journal.touched].reverse()) {
      await must(run, [tools.setfacl, '-P', '-b', entry.path], `clearing the ACL of ${entry.path}`)
      await must(
        run,
        [tools.chmod, entry.mode.toString(8).padStart(4, '0'), entry.path],
        `restoring the mode of ${entry.path}`,
      )
      if (entry.extended) {
        await must(
          run,
          [tools.setfacl, '-P', `--set-file=${entry.aclFile}`, entry.path],
          `restoring the ACL of ${entry.path}`,
        )
      }
    }
  } catch (error) {
    return {status: 'unsafe', reason: error instanceof HandoffError ? error.message : toErrorMessage(error)}
  }
  await fs.rm(journal.snapshotDir, {recursive: true, force: true})
  return {status: 'restored'}
}

/**
 * `.git` must be the same kind of thing it was at handoff: a plain directory (not a symlink, not a gitfile), and absent
 * only if it was absent. `before` runs ahead of the chown (the sandbox may still own it); `after` requires the runner.
 */
async function checkGitDir(
  manifest: HandoffManifest,
  journal: HandoffJournal,
  when: 'after' | 'before',
): Promise<string | null> {
  const gitDir = path.join(manifest.workspace, '.git')
  let stats
  try {
    stats = await fs.lstat(gitDir)
  } catch {
    return journal.gitPresent ? '.git disappeared during the run' : null
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) return '.git is no longer a plain directory'
  if (!journal.gitPresent) return '.git was created during the run'
  if (when === 'after' && stats.uid !== manifest.ids.runnerUid) return '.git is not owned by the runner after take-back'
  return null
}

/** Writes the pre-model git metadata over whatever the model left and drops any new `config.worktree`. */
async function restoreGit(manifest: HandoffManifest, journal: HandoffJournal): Promise<string | null> {
  const problem = await checkGitDir(manifest, journal, 'after')
  if (problem !== null) return problem
  if (!journal.gitPresent || journal.git === null) return null
  const gitDir = path.join(manifest.workspace, '.git')

  const present: Record<string, boolean> = {
    config: journal.git.config,
    'config.worktree': journal.git.configWorktree,
    hooks: journal.git.hooks,
    info: journal.git.info,
  }
  for (const item of GIT_METADATA) {
    const target = path.join(gitDir, item)
    // rm on a symlink removes the link itself, never its target.
    await fs.rm(target, {recursive: true, force: true})
    if (present[item] === true) {
      await fs.cp(path.join(journal.git.dir, item), target, {recursive: true, verbatimSymlinks: true})
    }
  }
  return null
}
