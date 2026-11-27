import type {ChildProcess} from 'node:child_process'
import {spawn} from 'node:child_process'
import {mkdtempSync, rmSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import {afterEach, describe, expect, it} from 'vitest'
import {
  findServicesOfAccount,
  findServicesOwnedByState,
  killOwnedServices,
  listMatchingProcesses,
  ownsState,
  readProcessEnvironment,
} from './owned-service-processes.js'

const children: ChildProcess[] = []
const dirs: string[] = []

/** A decoy that the old `pgrep -f 'serve --service'` would have matched: a sleeper whose command line ends in those words. */
function decoy(env: NodeJS.ProcessEnv): number {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', 'serve', '--service'], {
    env,
    stdio: 'ignore',
  })
  children.push(child)
  if (child.pid === undefined) throw new Error('the decoy did not start')
  return child.pid
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25))
}

function stateDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'owned-service-state-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  // Only the decoys this file started.
  for (const child of children.splice(0)) child.kill('SIGKILL')
  for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true})
})

describe('owned service processes', () => {
  it('neither detects nor kills a matching process that the test did not start through its own state directory', async () => {
    // #given the test's state directory, and a decoy `serve --service` (an unrelated host service) with a different one
    const mine = stateDir()
    const theirs = stateDir()
    const stranger = decoy({...process.env, XDG_STATE_HOME: theirs})
    await waitFor(() => listMatchingProcesses().includes(stranger))

    // #then the plain command-line match does see it (the old cleanup would have killed it)
    expect(listMatchingProcesses()).toContain(stranger)

    // #when ownership is decided by the test's own state directory, and cleanup runs on what it proves
    const owned = findServicesOwnedByState(mine)
    killOwnedServices(owned)

    // #then it is not detected, and it is still running
    expect(owned).toEqual([])
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(alive(stranger)).toBe(true)
  })

  it('detects and kills only the process whose environment names the test’s state directory', async () => {
    // #given one decoy that carries the test's state directory (what the agent's autostart would give) and one that does not
    const mine = stateDir()
    const own = decoy({...process.env, XDG_STATE_HOME: mine})
    const stranger = decoy({...process.env, XDG_STATE_HOME: stateDir()})
    await waitFor(() => listMatchingProcesses().includes(own) && listMatchingProcesses().includes(stranger))

    // #when
    const owned = findServicesOwnedByState(mine)
    killOwnedServices(owned)

    // #then exactly the owned one is found and killed
    expect(owned).toEqual([own])
    await waitFor(() => !alive(own))
    expect(alive(own)).toBe(false)
    expect(alive(stranger)).toBe(true)
  })

  it('does not take a process it cannot read for its own', () => {
    // #given an environment that cannot be read, and one that merely contains the directory as a prefix of another value
    const mine = '/tmp/owned-state-a'

    // #then neither is proof
    expect(ownsState(123, mine, () => null)).toBe(false)
    expect(ownsState(123, mine, () => [`XDG_STATE_HOME=${mine}-other`])).toBe(false)
    expect(ownsState(123, '', () => ['XDG_STATE_HOME='])).toBe(false)
    expect(ownsState(123, mine, () => [`XDG_STATE_HOME=${mine}`])).toBe(true)
    expect(readProcessEnvironment(2_147_483_000)).toBeNull()
  })

  it('refuses an account uid that is root or the caller’s own, which would not be the sandbox account', () => {
    expect(findServicesOfAccount(0)).toEqual([])
    expect(findServicesOfAccount(process.getuid?.() ?? 1)).toEqual([])
    expect(findServicesOfAccount(Number.NaN)).toEqual([])
  })
})
