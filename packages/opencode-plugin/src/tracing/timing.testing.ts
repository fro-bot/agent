/**
 * CPU-time measurement for timing tests, built so machine load cannot fail them and a real regression still does.
 *
 * Wall-clock time includes every moment the process is descheduled, and on a loaded machine (a busy CI runner, a laptop with a
 * dozen builds running) that adds milliseconds to a single measurement, in no relation to the work. CPU time (user + system,
 * from `process.cpuUsage`) counts only the time the process ran, so it stays close to its idle value under the same load. The
 * same method the runtime package's scrubber timing tests use (`packages/runtime/src/tracing/timing.testing.ts`): one untimed
 * warm-up, then the least CPU time of several runs, which drops garbage-collection and compiler-thread noise.
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
export function minCpuMs(work: () => void, attempts = 3): number {
  work()
  let best = Number.POSITIVE_INFINITY
  for (let attempt = 0; attempt < attempts; attempt += 1) best = Math.min(best, cpuMs(work))
  return best
}
