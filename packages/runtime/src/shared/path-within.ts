import path from 'node:path'

/**
 * True when `child` is `parent` or lies inside it, comparing path components. Both are resolved lexically, so `..` segments
 * and trailing separators are normalized, but symlinks are not followed.
 *
 * A prefix test on the relative path (`relative.startsWith('..')`) is wrong: it reads a real directory named `..action` as
 * a climb out of the parent. Only the component `..` (alone, or followed by a separator) means that.
 */
export function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  if (relative === '') return true
  if (relative === '..' || relative.startsWith(`..${path.sep}`)) return false
  return !path.isAbsolute(relative)
}
