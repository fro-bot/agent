/**
 * Unit 2 adversarial fixture suite — metadata / layout attacks.
 *
 * Every vector here redirects git's OWN notion of "where the repository lives" or "what history
 * looks like" away from the checkout's actual on-disk path or actual commit graph, without
 * touching any file admission's config inventory alone would catch. `checkCheckoutLayout`
 * (checkout-profile.ts, Unit 3, not implemented yet) must detect every one of these directly from
 * the filesystem and repository metadata — never by trusting the checkout's own (agent-writable)
 * `.git/config`.
 *
 * See docs/plans/2026-09-24-001-feat-workspace-checkout-update-recovery-plan.md, Unit 2's
 * "Metadata attacks" scenario bullet.
 */

import {realpath, rename, rm, symlink, writeFile} from 'node:fs/promises'
import {join} from 'node:path'

import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {checkCheckoutLayout} from '../checkout-profile.js'
import {commitFile, gitSync, initRepo, isolatedGitEnv, makeTempDir} from './helpers.js'

let checkoutDir: string
let checkoutHome: string

beforeEach(async () => {
  checkoutDir = await makeTempDir('layout-checkout-')
  checkoutHome = await makeTempDir('layout-home-')
  initRepo(checkoutDir, isolatedGitEnv(checkoutHome))
})

afterEach(async () => {
  await rm(checkoutDir, {recursive: true, force: true})
  await rm(checkoutHome, {recursive: true, force: true})
})

describe('layout — core.worktree relocation (real git, no stub)', () => {
  it('makes every git operation act on a DIFFERENT directory than the checkout path', async () => {
    // #given a real commit, and a separate directory holding a tampered copy of the same file
    const env = isolatedGitEnv(checkoutHome)
    commitFile(checkoutDir, env, 'a.txt', 'original', 'c1')
    const evilWorktree = await makeTempDir('layout-evil-worktree-')
    await writeFile(join(evilWorktree, 'a.txt'), 'evil')
    gitSync(checkoutDir, ['config', 'core.worktree', evilWorktree], env)

    // #when
    const status = gitSync(checkoutDir, ['status', '--porcelain'], env)
    const toplevel = gitSync(checkoutDir, ['rev-parse', '--show-toplevel'], env).trim()

    // #then — git is now operating on evilWorktree, not checkoutDir
    expect(status).toContain('a.txt')
    expect(toplevel).not.toBe(checkoutDir)
    await rm(evilWorktree, {recursive: true, force: true})
  })
})

describe('layout — gitfile and symlinked .git (real git, no stub)', () => {
  it('a `.git` GITFILE pointing outside the checkout redirects every git operation there', async () => {
    // #given a real repo, then its .git directory moved elsewhere and replaced with a gitfile
    const env = isolatedGitEnv(checkoutHome)
    commitFile(checkoutDir, env, 'a.txt', 'one', 'c1')
    const elsewhere = await makeTempDir('layout-elsewhere-')
    const realGitDir = join(elsewhere, 'real.git')
    await rename(join(checkoutDir, '.git'), realGitDir)
    await writeFile(join(checkoutDir, '.git'), `gitdir: ${realGitDir}\n`)

    // #when
    const resolvedGitDir = await realpath(gitSync(checkoutDir, ['rev-parse', '--absolute-git-dir'], env).trim())
    const resolvedElsewhere = await realpath(elsewhere)

    // #then
    expect(resolvedGitDir).not.toBe(join(checkoutDir, '.git'))
    expect(resolvedGitDir.startsWith(resolvedElsewhere)).toBe(true)
    await rm(elsewhere, {recursive: true, force: true})
  })

  it('a SYMLINKED `.git` directory redirects every git operation outside the checkout the same way', async () => {
    const env = isolatedGitEnv(checkoutHome)
    commitFile(checkoutDir, env, 'a.txt', 'one', 'c1')
    const elsewhere = await makeTempDir('layout-elsewhere-')
    const realGitDir = join(elsewhere, 'real.git')
    await rename(join(checkoutDir, '.git'), realGitDir)
    await symlink(realGitDir, join(checkoutDir, '.git'))

    const resolvedGitDir = await realpath(gitSync(checkoutDir, ['rev-parse', '--absolute-git-dir'], env).trim())
    const resolvedElsewhere = await realpath(elsewhere)

    expect(resolvedGitDir.startsWith(resolvedElsewhere)).toBe(true)
    await rm(elsewhere, {recursive: true, force: true})
  })

  it('a SYMLINKED `.git/config` lets an attacker-controlled file outside the checkout supply config', async () => {
    const env = isolatedGitEnv(checkoutHome)
    commitFile(checkoutDir, env, 'a.txt', 'one', 'c1')
    const elsewhere = await makeTempDir('layout-elsewhere-')
    const hostileConfigPath = join(elsewhere, 'hostile.gitconfig')
    await writeFile(hostileConfigPath, '[user]\n\tname = attacker-controlled\n')
    await rm(join(checkoutDir, '.git', 'config'), {force: true})
    await symlink(hostileConfigPath, join(checkoutDir, '.git', 'config'))

    const userName = gitSync(checkoutDir, ['config', 'user.name'], env).trim()

    expect(userName).toBe('attacker-controlled')
    await rm(elsewhere, {recursive: true, force: true})
  })
})

describe('layout — alternates (real git, no stub)', () => {
  it('objects/info/alternates makes a foreign repository\u2019s objects visible as if they were the checkout\u2019s own', async () => {
    // #given a completely separate repository with content the checkout never fetched or committed
    const foreignRepo = await makeTempDir('layout-foreign-')
    const foreignHome = await makeTempDir('layout-foreign-home-')
    initRepo(foreignRepo, isolatedGitEnv(foreignHome))
    const foreignSha = commitFile(
      foreignRepo,
      isolatedGitEnv(foreignHome),
      'secret.txt',
      'foreign secret content',
      'foreign commit',
    )

    // #given the checkout's alternates file points at the foreign repo's object store
    await writeFile(
      join(checkoutDir, '.git', 'objects', 'info', 'alternates'),
      `${join(foreignRepo, '.git', 'objects')}\n`,
    )

    // #when the checkout is asked about an object it never received
    const kind = gitSync(checkoutDir, ['cat-file', '-t', foreignSha], isolatedGitEnv(checkoutHome)).trim()

    // #then \u2014 the checkout reports it as present, sourced entirely from the foreign store
    expect(kind).toBe('commit')
    await rm(foreignRepo, {recursive: true, force: true})
    await rm(foreignHome, {recursive: true, force: true})
  })
})

describe('layout — replace refs and grafts (real git, no stub)', () => {
  it('a replace ref makes HEAD transparently resolve to a DIFFERENT commit than the real ref target', async () => {
    const env = isolatedGitEnv(checkoutHome)
    const c1 = commitFile(checkoutDir, env, 'a.txt', 'one', 'c1')
    const c2 = commitFile(checkoutDir, env, 'b.txt', 'two', 'c2')
    gitSync(checkoutDir, ['replace', c2, c1], env)

    const resolvedMessage = gitSync(checkoutDir, ['log', '-1', '--format=%s', 'HEAD'], env).trim()

    expect(resolvedMessage).toBe('c1')
    expect(resolvedMessage).not.toBe('c2')
  })

  it('a grafts file transparently rewrites a commit\u2019s recorded parentage', async () => {
    const env = isolatedGitEnv(checkoutHome)
    const c1 = commitFile(checkoutDir, env, 'a.txt', 'one', 'c1')
    commitFile(checkoutDir, env, 'b.txt', 'two', 'c2')
    const c3 = commitFile(checkoutDir, env, 'c.txt', 'three', 'c3')
    // Grafts c3 directly onto c1, hiding c2 from history entirely.
    await writeFile(join(checkoutDir, '.git', 'info', 'grafts'), `${c3} ${c1}\n`)

    const log = gitSync(checkoutDir, ['-c', 'advice.graftFileDeprecated=false', 'log', '--format=%s'], env)

    expect(log).not.toContain('c2')
    expect(log).toContain('c1')
    expect(log).toContain('c3')
  })
})

describe('layout — shallow and partial clone (real git, no stub)', () => {
  it('a `.git/shallow` file makes the repository report itself as shallow', async () => {
    const env = isolatedGitEnv(checkoutHome)
    const c1 = commitFile(checkoutDir, env, 'a.txt', 'one', 'c1')
    await writeFile(join(checkoutDir, '.git', 'shallow'), `${c1}\n`)

    const isShallow = gitSync(checkoutDir, ['rev-parse', '--is-shallow-repository'], env).trim()

    expect(isShallow).toBe('true')
  })

  it('extensions.partialClone plus a promisor remote marks the checkout as a partial clone', async () => {
    const env = isolatedGitEnv(checkoutHome)
    commitFile(checkoutDir, env, 'a.txt', 'one', 'c1')
    gitSync(checkoutDir, ['config', 'extensions.partialClone', 'origin'], env)
    gitSync(checkoutDir, ['config', 'remote.origin.promisor', 'true'], env)
    gitSync(checkoutDir, ['config', 'remote.origin.partialclonefilter', 'blob:none'], env)

    const partialCloneRemote = gitSync(checkoutDir, ['config', 'extensions.partialClone'], env).trim()

    expect(partialCloneRemote).toBe('origin')
  })
})

describe('layout — protected (Unit 3 checkout-profile.ts, not implemented yet)', () => {
  it('checkCheckoutLayout returns ok for a genuinely ordinary checkout with none of the vectors below', async () => {
    // #given a plain checkout with a real commit and nothing exotic about its layout — this is
    // the case a trivial "always refused" implementation would fail, since it must distinguish
    // this from every hostile fixture below
    commitFile(checkoutDir, isolatedGitEnv(checkoutHome), 'a.txt', 'one', 'c1')

    // #when
    // NOT IMPLEMENTED YET (Unit 3): this throws, so this test is expected to fail red until Unit
    // 3 lands.
    const outcome = await checkCheckoutLayout({checkoutPath: checkoutDir, timeoutMs: 5_000})

    // #then
    expect(outcome.kind).toBe('ok')
  })

  it('checkCheckoutLayout refuses a relocated core.worktree with reason "core-worktree"', async () => {
    // #given the same core.worktree exploit fixture as the real-git test above
    const env = isolatedGitEnv(checkoutHome)
    commitFile(checkoutDir, env, 'a.txt', 'original', 'c1')
    const evilWorktree = await makeTempDir('layout-evil-worktree-')
    gitSync(checkoutDir, ['config', 'core.worktree', evilWorktree], env)

    // NOT IMPLEMENTED YET (Unit 3): this throws, so this test is expected to fail red until Unit 3
    // lands. It documents the exact contract: the reason must name THIS vector specifically, not
    // just "refused" — a trivial always-refused-with-a-fixed-reason implementation would fail every
    // OTHER test in this block.
    const outcome = await checkCheckoutLayout({checkoutPath: checkoutDir, timeoutMs: 5_000})

    expect(outcome.kind).toBe('refused')
    expect(outcome.kind === 'refused' ? outcome.reason : null).toBe('core-worktree')
    await rm(evilWorktree, {recursive: true, force: true})
  })

  it('checkCheckoutLayout refuses a `.git` GITFILE pointing outside the checkout with reason "gitfile"', async () => {
    const env = isolatedGitEnv(checkoutHome)
    commitFile(checkoutDir, env, 'a.txt', 'one', 'c1')
    const elsewhere = await makeTempDir('layout-elsewhere-')
    const realGitDir = join(elsewhere, 'real.git')
    await rename(join(checkoutDir, '.git'), realGitDir)
    await writeFile(join(checkoutDir, '.git'), `gitdir: ${realGitDir}\n`)

    const outcome = await checkCheckoutLayout({checkoutPath: checkoutDir, timeoutMs: 5_000})

    expect(outcome.kind).toBe('refused')
    expect(outcome.kind === 'refused' ? outcome.reason : null).toBe('gitfile')
    await rm(elsewhere, {recursive: true, force: true})
  })

  it('checkCheckoutLayout refuses a SYMLINKED `.git` directory with reason "symlinked-git-dir"', async () => {
    const env = isolatedGitEnv(checkoutHome)
    commitFile(checkoutDir, env, 'a.txt', 'one', 'c1')
    const elsewhere = await makeTempDir('layout-elsewhere-')
    const realGitDir = join(elsewhere, 'real.git')
    await rename(join(checkoutDir, '.git'), realGitDir)
    await symlink(realGitDir, join(checkoutDir, '.git'))

    const outcome = await checkCheckoutLayout({checkoutPath: checkoutDir, timeoutMs: 5_000})

    expect(outcome.kind).toBe('refused')
    expect(outcome.kind === 'refused' ? outcome.reason : null).toBe('symlinked-git-dir')
    await rm(elsewhere, {recursive: true, force: true})
  })

  it('checkCheckoutLayout refuses a SYMLINKED `.git/config` with reason "symlinked-config"', async () => {
    const env = isolatedGitEnv(checkoutHome)
    commitFile(checkoutDir, env, 'a.txt', 'one', 'c1')
    const elsewhere = await makeTempDir('layout-elsewhere-')
    const hostileConfigPath = join(elsewhere, 'hostile.gitconfig')
    await writeFile(hostileConfigPath, '[user]\n\tname = attacker-controlled\n')
    await rm(join(checkoutDir, '.git', 'config'), {force: true})
    await symlink(hostileConfigPath, join(checkoutDir, '.git', 'config'))

    const outcome = await checkCheckoutLayout({checkoutPath: checkoutDir, timeoutMs: 5_000})

    expect(outcome.kind).toBe('refused')
    expect(outcome.kind === 'refused' ? outcome.reason : null).toBe('symlinked-config')
    await rm(elsewhere, {recursive: true, force: true})
  })

  it('checkCheckoutLayout refuses objects/info/alternates with reason "alternates"', async () => {
    const foreignRepo = await makeTempDir('layout-foreign-')
    const foreignHome = await makeTempDir('layout-foreign-home-')
    initRepo(foreignRepo, isolatedGitEnv(foreignHome))
    commitFile(checkoutDir, isolatedGitEnv(checkoutHome), 'a.txt', 'one', 'c1')
    await writeFile(
      join(checkoutDir, '.git', 'objects', 'info', 'alternates'),
      `${join(foreignRepo, '.git', 'objects')}\n`,
    )

    const outcome = await checkCheckoutLayout({checkoutPath: checkoutDir, timeoutMs: 5_000})

    expect(outcome.kind).toBe('refused')
    expect(outcome.kind === 'refused' ? outcome.reason : null).toBe('alternates')
    await rm(foreignRepo, {recursive: true, force: true})
    await rm(foreignHome, {recursive: true, force: true})
  })

  it('checkCheckoutLayout refuses a replace ref with reason "replace-refs"', async () => {
    const env = isolatedGitEnv(checkoutHome)
    const c1 = commitFile(checkoutDir, env, 'a.txt', 'one', 'c1')
    const c2 = commitFile(checkoutDir, env, 'b.txt', 'two', 'c2')
    gitSync(checkoutDir, ['replace', c2, c1], env)

    const outcome = await checkCheckoutLayout({checkoutPath: checkoutDir, timeoutMs: 5_000})

    expect(outcome.kind).toBe('refused')
    expect(outcome.kind === 'refused' ? outcome.reason : null).toBe('replace-refs')
  })

  it('checkCheckoutLayout refuses a grafts file with reason "grafts"', async () => {
    const env = isolatedGitEnv(checkoutHome)
    const c1 = commitFile(checkoutDir, env, 'a.txt', 'one', 'c1')
    commitFile(checkoutDir, env, 'b.txt', 'two', 'c2')
    const c3 = commitFile(checkoutDir, env, 'c.txt', 'three', 'c3')
    await writeFile(join(checkoutDir, '.git', 'info', 'grafts'), `${c3} ${c1}\n`)

    const outcome = await checkCheckoutLayout({checkoutPath: checkoutDir, timeoutMs: 5_000})

    expect(outcome.kind).toBe('refused')
    expect(outcome.kind === 'refused' ? outcome.reason : null).toBe('grafts')
  })

  it('checkCheckoutLayout refuses a shallow checkout with reason "shallow"', async () => {
    const env = isolatedGitEnv(checkoutHome)
    const c1 = commitFile(checkoutDir, env, 'a.txt', 'one', 'c1')
    await writeFile(join(checkoutDir, '.git', 'shallow'), `${c1}\n`)

    const outcome = await checkCheckoutLayout({checkoutPath: checkoutDir, timeoutMs: 5_000})

    expect(outcome.kind).toBe('refused')
    expect(outcome.kind === 'refused' ? outcome.reason : null).toBe('shallow')
  })

  it('checkCheckoutLayout refuses a partial clone with reason "partial-clone"', async () => {
    const env = isolatedGitEnv(checkoutHome)
    commitFile(checkoutDir, env, 'a.txt', 'one', 'c1')
    gitSync(checkoutDir, ['config', 'extensions.partialClone', 'origin'], env)
    gitSync(checkoutDir, ['config', 'remote.origin.promisor', 'true'], env)
    gitSync(checkoutDir, ['config', 'remote.origin.partialclonefilter', 'blob:none'], env)

    const outcome = await checkCheckoutLayout({checkoutPath: checkoutDir, timeoutMs: 5_000})

    expect(outcome.kind).toBe('refused')
    expect(outcome.kind === 'refused' ? outcome.reason : null).toBe('partial-clone')
  })
})

describe('layout — linked worktree (real git, no stub)', () => {
  it('git worktree add creates a second working directory that shares refs/objects with the checkout', async () => {
    // #given a real commit, then a SECOND, linked working directory attached to the same repo
    const env = isolatedGitEnv(checkoutHome)
    commitFile(checkoutDir, env, 'a.txt', 'one', 'c1')
    const linkedWorktreeParent = await makeTempDir('layout-linked-parent-')
    const linkedWorktreeDir = join(linkedWorktreeParent, 'wt')

    // #when
    gitSync(checkoutDir, ['worktree', 'add', '--detach', linkedWorktreeDir, 'HEAD'], env)

    // #then — the exploit genuinely works: `.git/worktrees/<name>` now exists, and `worktree list`
    // reports both directories sharing the same repository
    const worktreeList = gitSync(checkoutDir, ['worktree', 'list'], env)
    expect(worktreeList).toContain(checkoutDir)
    expect(worktreeList).toContain(linkedWorktreeDir)

    gitSync(checkoutDir, ['worktree', 'remove', '--force', linkedWorktreeDir], env)
    await rm(linkedWorktreeParent, {recursive: true, force: true})
  })
})

describe('layout — bare repository (real git, no stub)', () => {
  it('a bare clone reports itself as bare and has no separate .git directory', async () => {
    // #given a real commit, then a real BARE clone of it (repository files live directly at the
    // clone's own root — there is no `.git` subdirectory at all)
    const env = isolatedGitEnv(checkoutHome)
    commitFile(checkoutDir, env, 'a.txt', 'one', 'c1')
    const bareDir = await makeTempDir('layout-bare-')
    await rm(bareDir, {recursive: true, force: true})
    gitSync(await makeTempDir('layout-bare-cwd-'), ['clone', '-q', '--bare', checkoutDir, bareDir], env)

    // #when
    const isBare = gitSync(bareDir, ['rev-parse', '--is-bare-repository'], env).trim()

    // #then
    expect(isBare).toBe('true')
    await rm(bareDir, {recursive: true, force: true})
  })
})

describe('layout — split index (real git, no stub)', () => {
  it('git update-index --split-index creates a .git/sharedindex.* file', async () => {
    // #given a real commit, then the index split via the real git feature
    const env = isolatedGitEnv(checkoutHome)
    commitFile(checkoutDir, env, 'a.txt', 'one', 'c1')

    // #when
    gitSync(checkoutDir, ['update-index', '--split-index'], env)

    // #then — the exploit genuinely works: a shared-index file now exists alongside the main index
    const {readdir} = await import('node:fs/promises')
    const gitDirEntries = await readdir(join(checkoutDir, '.git'))
    expect(gitDirEntries.some(name => name.startsWith('sharedindex.'))).toBe(true)
  })
})

describe('layout — sparse index (real git, no stub)', () => {
  it('git sparse-checkout init --cone --sparse-index enables a sparse index via the worktreeConfig extension', async () => {
    // #given a real commit, then cone-mode sparse-checkout with a sparse index enabled — the real
    // git feature this fixture reproduces, not a faked config write
    const env = isolatedGitEnv(checkoutHome)
    commitFile(checkoutDir, env, 'a.txt', 'one', 'c1')

    // #when
    gitSync(checkoutDir, ['sparse-checkout', 'init', '--cone', '--sparse-index'], env)

    // #then — the exploit genuinely works: git itself now reports a sparse index, and the
    // extension it rides in on (`extensions.worktreeConfig`) is visible in the checkout's own
    // main config (not just the per-worktree config file)
    const sparseIndexValue = gitSync(checkoutDir, ['config', '--worktree', 'index.sparse'], env).trim()
    expect(sparseIndexValue).toBe('true')
    const mainConfig = gitSync(
      checkoutDir,
      ['config', '--local', '--no-includes', '--get', 'extensions.worktreeConfig'],
      env,
    ).trim()
    expect(mainConfig).toBe('true')
  })
})

describe('layout — protected (Unit 3 checkout-profile.ts): linked worktree, bare repository, and unsupported index flags', () => {
  it('checkCheckoutLayout refuses a linked worktree with reason "linked-worktree"', async () => {
    const env = isolatedGitEnv(checkoutHome)
    commitFile(checkoutDir, env, 'a.txt', 'one', 'c1')
    const linkedWorktreeParent = await makeTempDir('layout-linked-parent-')
    const linkedWorktreeDir = join(linkedWorktreeParent, 'wt')
    gitSync(checkoutDir, ['worktree', 'add', '--detach', linkedWorktreeDir, 'HEAD'], env)

    const outcome = await checkCheckoutLayout({checkoutPath: checkoutDir, timeoutMs: 5_000})

    expect(outcome.kind).toBe('refused')
    expect(outcome.kind === 'refused' ? outcome.reason : null).toBe('linked-worktree')
    gitSync(checkoutDir, ['worktree', 'remove', '--force', linkedWorktreeDir], env)
    await rm(linkedWorktreeParent, {recursive: true, force: true})
  })

  it('checkCheckoutLayout refuses a bare repository with reason "bare-repository"', async () => {
    const env = isolatedGitEnv(checkoutHome)
    commitFile(checkoutDir, env, 'a.txt', 'one', 'c1')
    const bareDir = await makeTempDir('layout-bare-')
    await rm(bareDir, {recursive: true, force: true})
    gitSync(await makeTempDir('layout-bare-cwd-'), ['clone', '-q', '--bare', checkoutDir, bareDir], env)

    const outcome = await checkCheckoutLayout({checkoutPath: bareDir, timeoutMs: 5_000})

    expect(outcome.kind).toBe('refused')
    expect(outcome.kind === 'refused' ? outcome.reason : null).toBe('bare-repository')
    await rm(bareDir, {recursive: true, force: true})
  })

  it('checkCheckoutLayout refuses a split index with reason "unsupported-index-flag"', async () => {
    const env = isolatedGitEnv(checkoutHome)
    commitFile(checkoutDir, env, 'a.txt', 'one', 'c1')
    gitSync(checkoutDir, ['update-index', '--split-index'], env)

    const outcome = await checkCheckoutLayout({checkoutPath: checkoutDir, timeoutMs: 5_000})

    expect(outcome.kind).toBe('refused')
    expect(outcome.kind === 'refused' ? outcome.reason : null).toBe('unsupported-index-flag')
  })

  it('checkCheckoutLayout refuses a sparse index with reason "unsupported-index-flag"', async () => {
    const env = isolatedGitEnv(checkoutHome)
    commitFile(checkoutDir, env, 'a.txt', 'one', 'c1')
    gitSync(checkoutDir, ['sparse-checkout', 'init', '--cone', '--sparse-index'], env)

    const outcome = await checkCheckoutLayout({checkoutPath: checkoutDir, timeoutMs: 5_000})

    expect(outcome.kind).toBe('refused')
    expect(outcome.kind === 'refused' ? outcome.reason : null).toBe('unsupported-index-flag')
  })
})
