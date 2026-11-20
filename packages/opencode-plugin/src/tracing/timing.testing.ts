/**
 * Timing for the growth tests, built so machine load cannot fail them and a real regression still does.
 *
 * Wall-clock time includes every moment the process is descheduled, and on a loaded machine (a busy CI runner, a laptop with a
 * dozen builds running) that adds tens of milliseconds to a single measurement, in no relation to the work: a 2 ms scrub of 20 KB
 * and a 17 ms scrub of 160 KB both measured at 80 ms and 330 ms. CPU time (user + system, from `process.cpuUsage`) counts only
 * the time the process ran, so it stays within a few percent of its idle value under the same load, while a quadratic rule still
 * shows as quadratic CPU time. The tests run in a forked process (the Vitest default), so the figure is this test file's own.
 *
 * Method: the minimum over several measurements per size (the minimum drops garbage-collection and compiler-thread noise), the
 * 8x-size ratio compared against a limit three times the linear value, plus an absolute ceiling.
 */

import process from 'node:process'

/** CPU milliseconds (user + system) the process spends running `work`. */
export function cpuMs(work: () => void): number {
  const before = process.cpuUsage()
  work()
  const used = process.cpuUsage(before)
  return (used.user + used.system) / 1_000
}

/** The least CPU time of `attempts` runs of `work` (one untimed warm-up first, so compilation is not measured). */
export function minCpuMs(work: () => void, attempts = 5): number {
  work()
  let best = Number.POSITIVE_INFINITY
  for (let attempt = 0; attempt < attempts; attempt += 1) best = Math.min(best, cpuMs(work))
  return best
}
