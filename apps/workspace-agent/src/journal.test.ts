import type {Journal, RecoveryJournal, RecoveryJournalPhase, UpdateJournal, UpdateJournalPhase} from './journal.js'

import {lstat, mkdir, mkdtemp, rm, symlink, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {JournalDirectoryError, listJournals, readJournal, removeJournal, writeJournal} from './journal.js'

let tempRoot: string

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'journal-test-'))
})

afterEach(async () => {
  await rm(tempRoot, {recursive: true, force: true})
})

/** Mirrors production layout: `<reposRoot>/.workspace-agent/journals`. */
function journalsDirFor(root: string): string {
  return join(root, '.workspace-agent', 'journals')
}

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)
const SHA_C = 'c'.repeat(40)
const STARTED_AT = '2026-09-24T00:00:00.000Z'

function makeUpdateJournal(phase: UpdateJournalPhase, appliedAt = STARTED_AT): UpdateJournal {
  if (phase === 'applied') {
    return {
      kind: 'update',
      owner: 'acme',
      repo: 'widgets',
      phase,
      fromSha: SHA_A,
      toSha: SHA_B,
      startedAt: STARTED_AT,
      appliedAt,
    }
  }
  return {kind: 'update', owner: 'acme', repo: 'widgets', phase, fromSha: SHA_A, toSha: SHA_B, startedAt: STARTED_AT}
}

function makeRecoveryJournal(phase: RecoveryJournalPhase): RecoveryJournal {
  return {
    kind: 'recovery',
    owner: 'acme',
    repo: 'widgets',
    phase,
    recoveryId: 'gen-1',
    targetSha: SHA_B,
    branch: 'main',
    startedAt: STARTED_AT,
  }
}

describe('writeJournal / readJournal — round trip', () => {
  const updatePhases: readonly UpdateJournalPhase[] = ['fetched', 'applying', 'applied']
  const recoveryPhases: readonly RecoveryJournalPhase[] = ['building', 'quarantining', 'installing', 'verifying']

  it.each(updatePhases)('round-trips an update journal at phase %s', async phase => {
    // #given
    const journalsDir = journalsDirFor(tempRoot)
    const journal = makeUpdateJournal(phase)

    // #when
    await writeJournal(journalsDir, journal)
    const result = await readJournal(journalsDir, 'acme', 'widgets')

    // #then
    expect(result).toEqual({ok: true, journal})
  })

  it.each(recoveryPhases)('round-trips a recovery journal at phase %s', async phase => {
    // #given
    const journalsDir = journalsDirFor(tempRoot)
    const journal = makeRecoveryJournal(phase)

    // #when
    await writeJournal(journalsDir, journal)
    const result = await readJournal(journalsDir, 'acme', 'widgets')

    // #then
    expect(result).toEqual({ok: true, journal})
  })

  it('replaces a previous journal for the same repo atomically', async () => {
    // #given
    const journalsDir = journalsDirFor(tempRoot)
    const first = makeUpdateJournal('fetched')
    const second: UpdateJournal = {...first, phase: 'applying'}

    // #when
    await writeJournal(journalsDir, first)
    await writeJournal(journalsDir, second)

    // #then
    expect(await readJournal(journalsDir, 'acme', 'widgets')).toEqual({ok: true, journal: second})
  })

  it('creates the journals directory with mode 0700', async () => {
    // #given
    const journalsDir = journalsDirFor(tempRoot)

    // #when
    await writeJournal(journalsDir, makeUpdateJournal('fetched'))

    // #then
    const st = await lstat(journalsDir)
    expect(st.mode & 0o777).toBe(0o700)
  })
})

describe('readJournal — absent', () => {
  it('reports absent when the journals directory has never been created', async () => {
    // #given / #when
    const result = await readJournal(journalsDirFor(tempRoot), 'acme', 'widgets')

    // #then
    expect(result).toEqual({ok: false, reason: 'absent'})
  })

  it('reports absent when the journals directory exists but has no journal for this repo', async () => {
    // #given
    const journalsDir = journalsDirFor(tempRoot)
    await writeJournal(journalsDir, {
      kind: 'update',
      owner: 'acme',
      repo: 'other-repo',
      phase: 'fetched',
      fromSha: SHA_A,
      toSha: SHA_B,
      startedAt: STARTED_AT,
    })

    // #when
    const result = await readJournal(journalsDir, 'acme', 'widgets')

    // #then
    expect(result).toEqual({ok: false, reason: 'absent'})
  })
})

describe('readJournal — malformed input is refused, never treated as absent', () => {
  it('refuses truncated JSON', async () => {
    // #given
    const journalsDir = journalsDirFor(tempRoot)
    await mkdir(journalsDir, {recursive: true, mode: 0o700})
    await writeFile(join(journalsDir, 'acme__widgets.json'), '{"kind":"update","owner":"acme"')

    // #when
    const result = await readJournal(journalsDir, 'acme', 'widgets')

    // #then
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe('malformed')
  })

  it('refuses a foreign-schema JSON object', async () => {
    // #given
    const journalsDir = journalsDirFor(tempRoot)
    await mkdir(journalsDir, {recursive: true, mode: 0o700})
    await writeFile(join(journalsDir, 'acme__widgets.json'), JSON.stringify({hello: 'world'}))

    // #when
    const result = await readJournal(journalsDir, 'acme', 'widgets')

    // #then
    if (result.ok || result.reason !== 'malformed') throw new Error('expected a malformed result')
    expect(typeof result.detail).toBe('string')
  })

  it('refuses an unrecognized phase for a known kind', async () => {
    // #given
    const journalsDir = journalsDirFor(tempRoot)
    await mkdir(journalsDir, {recursive: true, mode: 0o700})
    await writeFile(
      join(journalsDir, 'acme__widgets.json'),
      JSON.stringify({
        kind: 'update',
        owner: 'acme',
        repo: 'widgets',
        phase: 'bogus-phase',
        fromSha: SHA_A,
        toSha: SHA_B,
        startedAt: STARTED_AT,
      }),
    )

    // #when
    const result = await readJournal(journalsDir, 'acme', 'widgets')

    // #then
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe('malformed')
  })

  it('refuses an unrecognized kind', async () => {
    // #given
    const journalsDir = journalsDirFor(tempRoot)
    await mkdir(journalsDir, {recursive: true, mode: 0o700})
    await writeFile(
      join(journalsDir, 'acme__widgets.json'),
      JSON.stringify({kind: 'reticulate-splines', owner: 'acme', repo: 'widgets', startedAt: STARTED_AT}),
    )

    // #when
    const result = await readJournal(journalsDir, 'acme', 'widgets')

    // #then
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe('malformed')
  })

  it("refuses an 'applied' update journal missing appliedAt (review round B, B7)", async () => {
    // #given a phase 'applied' journal written without appliedAt — nothing has shipped, so this
    // is never a legacy journal to stay lenient for; it must be malformed, never defaulted.
    const journalsDir = journalsDirFor(tempRoot)
    await mkdir(journalsDir, {recursive: true, mode: 0o700})
    await writeFile(
      join(journalsDir, 'acme__widgets.json'),
      JSON.stringify({
        kind: 'update',
        owner: 'acme',
        repo: 'widgets',
        phase: 'applied',
        fromSha: SHA_A,
        toSha: SHA_B,
        startedAt: STARTED_AT,
      }),
    )

    // #when
    const result = await readJournal(journalsDir, 'acme', 'widgets')

    // #then
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe('malformed')
  })

  it('refuses a journal file that is itself a symlink — never followed', async () => {
    // #given
    const journalsDir = journalsDirFor(tempRoot)
    await mkdir(journalsDir, {recursive: true, mode: 0o700})
    const target = join(tempRoot, 'secret.json')
    await writeFile(target, JSON.stringify(makeUpdateJournal('fetched')))
    await symlink(target, join(journalsDir, 'acme__widgets.json'))

    // #when
    const result = await readJournal(journalsDir, 'acme', 'widgets')

    // #then
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe('malformed')
  })
})

describe('writeJournal — crash between temp write and rename', () => {
  it('leaves the previous journal readable when a leftover temp file is found at the canonical path’s side', async () => {
    // #given — a real journal was published successfully
    const journalsDir = journalsDirFor(tempRoot)
    const original = makeUpdateJournal('fetched')
    await writeJournal(journalsDir, original)

    // Simulate a crash mid-write of a SECOND journal for the same repo: a temp file is left
    // behind (matching writeJournal's own naming convention), but the rename onto the
    // canonical path never happened.
    const leftoverTemp = join(journalsDir, '.acme__widgets.json.tmp-deadbeef')
    await writeFile(
      leftoverTemp,
      JSON.stringify({...makeUpdateJournal('applying'), toSha: SHA_C, startedAt: '2026-09-24T00:05:00.000Z'}),
    )

    // #when
    const result = await readJournal(journalsDir, 'acme', 'widgets')

    // #then — the ORIGINAL journal is still what's read; the leftover temp file is invisible
    expect(result).toEqual({ok: true, journal: original})

    // listJournals also ignores the leftover temp file entirely — it never appears as a
    // second (malformed-or-otherwise) entry.
    const listed = await listJournals(journalsDir)
    expect(listed).toEqual([{fileName: 'acme__widgets.json', result: {ok: true, journal: original}}])
  })
})

describe('removeJournal', () => {
  it('removes an existing journal; readJournal reports absent afterward', async () => {
    // #given
    const journalsDir = journalsDirFor(tempRoot)
    await writeJournal(journalsDir, makeRecoveryJournal('building'))

    // #when
    await removeJournal(journalsDir, 'acme', 'widgets')

    // #then
    expect(await readJournal(journalsDir, 'acme', 'widgets')).toEqual({ok: false, reason: 'absent'})
  })

  it('is a no-op when there is nothing to remove', async () => {
    // #given / #when / #then
    await expect(removeJournal(journalsDirFor(tempRoot), 'acme', 'widgets')).resolves.toBeUndefined()
  })
})

describe('listJournals', () => {
  it('is empty before any journals directory exists, and lists every journal across repositories once written', async () => {
    // #given
    const journalsDir = journalsDirFor(tempRoot)
    expect(await listJournals(journalsDir)).toEqual([])

    const j1 = makeUpdateJournal('fetched')
    const j2: Journal = {
      kind: 'recovery',
      owner: 'acme',
      repo: 'gadgets',
      phase: 'building',
      recoveryId: 'gen-1',
      targetSha: SHA_B,
      branch: 'main',
      startedAt: '2026-09-24T00:01:00.000Z',
    }

    // #when
    await writeJournal(journalsDir, j1)
    await writeJournal(journalsDir, j2)
    const listed = await listJournals(journalsDir)

    // #then
    expect(listed).toHaveLength(2)
    expect(listed).toEqual(
      expect.arrayContaining([
        {fileName: 'acme__widgets.json', result: {ok: true, journal: j1}},
        {fileName: 'acme__gadgets.json', result: {ok: true, journal: j2}},
      ]),
    )
  })

  it('surfaces a malformed journal for one repository without hiding the others', async () => {
    // #given
    const journalsDir = journalsDirFor(tempRoot)
    await writeJournal(journalsDir, makeUpdateJournal('fetched'))
    await mkdir(journalsDir, {recursive: true, mode: 0o700})
    await writeFile(join(journalsDir, 'acme__broken.json'), 'not json at all')

    // #when
    const listed = await listJournals(journalsDir)

    // #then
    expect(listed).toHaveLength(2)
    const broken = listed.find(entry => entry.fileName === 'acme__broken.json')
    expect(broken?.result.ok).toBe(false)
    if (broken?.result.ok !== false) throw new Error('unreachable')
    expect(broken.result.reason).toBe('malformed')
  })
})

describe('directory safety — symlinked parent is refused, never followed', () => {
  it('refuses to read when the journals directory’s parent is a symlink', async () => {
    // #given — `.workspace-agent` itself is a symlink to somewhere else
    const elsewhereDir = join(tempRoot, 'elsewhere')
    await mkdir(elsewhereDir, {recursive: true})
    const stateDirPath = join(tempRoot, '.workspace-agent')
    await symlink(elsewhereDir, stateDirPath)
    const journalsDir = join(stateDirPath, 'journals')

    // #when / #then
    await expect(readJournal(journalsDir, 'acme', 'widgets')).rejects.toThrow(JournalDirectoryError)
  })

  it('refuses to write when the journals directory’s parent is a symlink, and never writes through it', async () => {
    // #given
    const elsewhereDir = join(tempRoot, 'elsewhere')
    await mkdir(elsewhereDir, {recursive: true})
    const stateDirPath = join(tempRoot, '.workspace-agent')
    await symlink(elsewhereDir, stateDirPath)
    const journalsDir = join(stateDirPath, 'journals')

    // #when
    await expect(writeJournal(journalsDir, makeUpdateJournal('fetched'))).rejects.toThrow(JournalDirectoryError)

    // #then — nothing was written into the symlink target either (positive control: the write
    // really was refused, not silently redirected)
    const listed = await listJournals(join(elsewhereDir, 'journals'))
    expect(listed).toEqual([])
  })

  it('refuses when the journals directory itself (not just its parent) is a symlink', async () => {
    // #given — `.workspace-agent` is a real, safe directory, but `journals` under it is a symlink
    const elsewhereDir = join(tempRoot, 'elsewhere-journals')
    await mkdir(elsewhereDir, {recursive: true})
    const stateDirPath = join(tempRoot, '.workspace-agent')
    await mkdir(stateDirPath, {recursive: true, mode: 0o700})
    const journalsDir = join(stateDirPath, 'journals')
    await symlink(elsewhereDir, journalsDir)

    // #when / #then
    await expect(readJournal(journalsDir, 'acme', 'widgets')).rejects.toThrow(JournalDirectoryError)
  })
})

describe('RecoveryJournal.supersededUpdate (F3) \u2014 strict round trip', () => {
  it('round-trips a recovery journal carrying the update journal it superseded', async () => {
    // #given
    const dir = journalsDirFor(tempRoot)
    const superseded = makeUpdateJournal('applying')
    const journal: RecoveryJournal = {...makeRecoveryJournal('building'), supersededUpdate: superseded}

    // #when
    await writeJournal(dir, journal)
    const result = await readJournal(dir, 'acme', 'widgets')

    // #then
    expect(result).toEqual({ok: true, journal})
  })

  it('a recovery journal with no supersededUpdate still round-trips (the field is optional)', async () => {
    const dir = journalsDirFor(tempRoot)
    const journal = makeRecoveryJournal('quarantining')
    await writeJournal(dir, journal)
    const result = await readJournal(dir, 'acme', 'widgets')
    expect(result).toEqual({ok: true, journal})
  })

  it('rejects a supersededUpdate missing a required field as malformed, not absent', async () => {
    const dir = journalsDirFor(tempRoot)
    await mkdir(dir, {recursive: true})
    const raw = {...makeRecoveryJournal('building'), supersededUpdate: {kind: 'update', owner: 'acme'}}
    await writeFile(join(dir, 'acme__widgets.json'), JSON.stringify(raw))
    const result = await readJournal(dir, 'acme', 'widgets')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe('malformed')
  })

  it('rejects a supersededUpdate whose own kind is not "update"', async () => {
    const dir = journalsDirFor(tempRoot)
    await mkdir(dir, {recursive: true})
    const raw = {...makeRecoveryJournal('building'), supersededUpdate: {...makeRecoveryJournal('building')}}
    await writeFile(join(dir, 'acme__widgets.json'), JSON.stringify(raw))
    const result = await readJournal(dir, 'acme', 'widgets')
    expect(result.ok).toBe(false)
  })
})
