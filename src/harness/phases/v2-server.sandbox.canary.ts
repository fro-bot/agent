/**
 * Canary search for the real-runner tracing rows (`v2-server.sandbox.integration.test.ts`, suite 14). Nothing here is product
 * code.
 *
 * The sandbox must never hold the value it is shown unable to read. So the search that runs as the sandbox user is given a
 * one-way fingerprint (the SHA-256) and the length of the canary, never the canary: it hashes every token-shaped run of
 * bytes it reads and compares the hash. The detectors are proven separately, with control values that are not the canary: one
 * the search plants itself (a file, a process environment, a command line), and two the runner plants before the run in the
 * places the sandbox reaches OpenCode's storage by, a text file behind a nested `opencode` link and a binary file.
 */
import {Buffer} from 'node:buffer'
import {createHash} from 'node:crypto'
import * as fs from 'node:fs'
import path from 'node:path'
import {q} from './v2-server.sandbox.harness.js'

export const sha256Hex = (value: string): string => createHash('sha256').update(value).digest('hex')

/** Every canary and control has this length, so one window size finds all of them. */
export const CANARY_LENGTH = 34

/** A value of the canary's shape (`prefix` plus random hex, `CANARY_LENGTH` characters in all), unique to this call. */
export function canaryShapedValue(prefix: string, randomHex: string): string {
  if (!/^[\w-]+$/.test(prefix) || randomHex.length < CANARY_LENGTH) throw new Error('bad canary shape')
  return `${prefix}${randomHex}`.slice(0, CANARY_LENGTH)
}

export interface ScanSpec {
  /** Only its length and its SHA-256 reach the sandbox. */
  readonly canary: string
  /** Planted by the search itself, as plain text, in a file, a process environment and a command line. */
  readonly liveControl: string
  /** Planted by the runner in a text file in the `opencode` directory the sandbox reaches through a link. */
  readonly xdgTextControl: string
  /** Planted by the runner in a binary file in another `opencode` directory. */
  readonly xdgBinaryControl: string
  readonly runnerTemp: string
  /** The checkout and the response directory. */
  readonly checkout: readonly string[]
}

/** The hashes the scanner looks for, by name. Names are what it reports. */
function targets(spec: ScanSpec): Record<string, string> {
  return {
    [sha256Hex(spec.canary)]: 'canary',
    [sha256Hex(spec.liveControl)]: 'live',
    [sha256Hex(spec.xdgTextControl)]: 'xdgtext',
    [sha256Hex(spec.xdgBinaryControl)]: 'xdgbin',
  }
}

/** The scanner's one argument: hashes, a length and paths. It holds no canary and no control value. */
export function scanConfig(spec: ScanSpec): string {
  return JSON.stringify({len: CANARY_LENGTH, targets: targets(spec), temp: spec.runnerTemp, checkout: spec.checkout})
}

/**
 * Reads every file under the named roots (binary files too, the session database and its WAL among them) and every
 * process's environment and command line; hashes each run of `[A-Za-z0-9_-]` bytes (and each window of that length inside a
 * longer run) and counts the files whose hash is a target. A root that is a link is followed; a link met inside a walk is not.
 * A file over 64 MiB is skipped and counted. Prints one `RESULT` line, counts only.
 */
export const SCAN_PROGRAM = `import glob, hashlib, json, os, re, sys

cfg = json.loads(sys.argv[1])
extra = sys.argv[2]
LEN = cfg['len']
TARGETS = cfg['targets']
MAX_BYTES = 64 * 1024 * 1024
TOKEN = re.compile(rb'[A-Za-z0-9_-]+')
GROUPS = ['environ', 'cmdline', 'file', 'temp', 'checkout', 'home', 'xdg']
env = os.environ
bases = [env.get(n, '') for n in ('XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME')]
bases = [b for b in bases if b]
roots = {
    'file': [extra],
    'temp': [cfg['temp']],
    'checkout': cfg['checkout'],
    'home': [r for r in [env.get('HOME', '')] + bases if r],
    'xdg': [os.path.join(b, 'opencode') for b in bases],
}
read = {g: 0 for g in GROUPS}
hits = {g: {} for g in GROUPS}
skipped = 0


def found_in(data):
    found = set()
    for m in TOKEN.finditer(data):
        tok = m.group()
        n = len(tok)
        if n < LEN or n > 4096:
            continue
        for i in range(n - LEN + 1):
            name = TARGETS.get(hashlib.sha256(tok[i:i + LEN]).hexdigest())
            if name is not None:
                found.add(name)
    return found


def count(group, data):
    read[group] += 1
    for name in found_in(data):
        hits[group][name] = hits[group].get(name, 0) + 1


for group in ('environ', 'cmdline'):
    for p in glob.glob('/proc/[0-9]*/' + group):
        try:
            with open(p, 'rb') as f:
                count(group, f.read())
        except OSError:
            pass

for group, group_roots in roots.items():
    for root in group_roots:
        walk = [(os.path.dirname(root), [], [os.path.basename(root)])] if os.path.isfile(root) else os.walk(root, followlinks=False)
        for top, _dirs, files in walk:
            for name in files:
                p = os.path.join(top, name)
                try:
                    if os.path.islink(p):
                        continue
                    if os.stat(p).st_size > MAX_BYTES:
                        skipped += 1
                        continue
                    with open(p, 'rb') as f:
                        count(group, f.read())
                except OSError:
                    pass

canary = {g: hits[g].get('canary', 0) for g in GROUPS}
need = [('live', 'environ'), ('live', 'cmdline'), ('live', 'file'), ('xdgtext', 'xdg'), ('xdgbin', 'xdg')]
missing = [n + '.' + g for n, g in need if hits[g].get(n, 0) < 1]
parts = ['canary.' + g + '=' + str(canary[g]) for g in GROUPS if g not in ('file',)]
parts += ['ctl.' + n + '.' + g + '=' + str(hits[g].get(n, 0)) for n, g in need]
parts += ['read.' + g + '=' + str(read[g]) for g in ('checkout', 'home', 'xdg')]
parts.append('skipped=' + str(skipped))
if missing:
    print('RESULT canary_scan FAILED a detector control was not seen: ' + ','.join(missing) + ' ' + ' '.join(parts))
else:
    print('RESULT canary_scan ' + ('OPEN' if sum(canary.values()) > 0 else 'BLOCKED') + ' ' + ' '.join(parts))
`

/**
 * The tool command: it plants and starts the live controls, runs the scanner over everything, stops the controls and prints
 * the scanner's line. The canary is not in it, whole or in part.
 */
export function scanCommand(spec: ScanSpec): string {
  return [
    `CFG=${q(scanConfig(spec))}; V=${q(spec.liveControl)}`,
    // A file, a process environment and a command line that hold the live control: the search must find each.
    'ctl=$(mktemp -d) && printf %s "$V" > "$ctl/notes.txt" || { R canary_scan FAILED "control setup"; exit 0; }',
    `CTLENV="$V" sleep 60 & p1=$!`,
    `bash -c 'exec -a "$0" sleep 60' "$V" & p2=$!`,
    'sleep 1',
    // The program goes to a file first: a here-document inside `$(...)` is parsed differently by older shells.
    `cat > "$ctl/scan.py" <<'PYEOF'`,
    SCAN_PROGRAM.trimEnd(),
    'PYEOF',
    'out=$(python3 "$ctl/scan.py" "$CFG" "$ctl")',
    'kill $p1 $p2 2>/dev/null; wait $p1 $p2 2>/dev/null; rm -rf "$ctl"',
    String.raw`if [ -n "$out" ]; then printf '%s\n' "$out"; else R canary_scan FAILED "the scanner did not run"; fi`,
  ].join('\n')
}

/**
 * Plants the runner's controls where the sandbox reaches OpenCode's storage: a text file in the data `opencode` directory
 * (the sandbox's link points here) and a binary file, with the value at an odd offset between NULs, in the state one.
 */
export function plantScanControls(xdgRoot: string, spec: ScanSpec): void {
  const text = path.join(xdgRoot, 'data', 'opencode')
  const binary = path.join(xdgRoot, 'state', 'opencode')
  fs.mkdirSync(text, {recursive: true})
  fs.mkdirSync(binary, {recursive: true})
  fs.writeFileSync(path.join(text, 'it-control.txt'), `scan control ${spec.xdgTextControl}\n`)
  fs.writeFileSync(
    path.join(binary, 'it-control.bin'),
    Buffer.concat([
      Buffer.from([0, 1, 2, 0xff, 0xfe, 0, 7]),
      Buffer.from(spec.xdgBinaryControl),
      Buffer.from([0, 0x80, 0x81, 0, 3]),
    ]),
  )
}

/** Every string a JSON body holds, as parsed (so every escape is already undone). Empty for a body that is not JSON. */
export function bodyStrings(body: Buffer): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(body.toString('utf8'))
  } catch {
    return []
  }
  const strings: string[] = []
  const walk = (value: unknown): void => {
    if (typeof value === 'string') strings.push(value)
    else if (Array.isArray(value)) for (const item of value) walk(item)
    else if (typeof value === 'object' && value !== null) {
      for (const [key, item] of Object.entries(value)) {
        strings.push(key)
        walk(item)
      }
    }
  }
  walk(parsed)
  return strings
}

/** The base64 text a value has when it sits at byte offset 0, 1 or 2 of a longer message, less the edges that depend on neighbours. */
function base64Needles(value: string, alphabet: 'base64' | 'base64url'): string[] {
  return [0, 1, 2].map(offset => {
    const encoded = Buffer.from('x'.repeat(offset) + value).toString(alphabet)
    return encoded.slice([0, 2, 3][offset], -4)
  })
}

/**
 * The forms in which a body holds the canary, by name; empty when it holds none:
 * - `contiguous`: the canary as written, in the raw bytes or in any parsed string;
 * - `escaped`: every character as a `\uXXXX` escape, in the raw bytes;
 * - `halves`: both halves of it, apart or together, in the raw bytes or one parsed string;
 * - `base64`, `base64url`: the canary encoded at any of the three alignments it can have inside a longer message;
 * - `hex`: the canary's bytes as hex.
 */
export function canaryForms(body: Buffer, canary: string): string[] {
  const raw = body.toString('latin1')
  const strings = bodyStrings(body)
  const half = Math.floor(canary.length / 2)
  const [first, second] = [canary.slice(0, half), canary.slice(half)]
  const escaped = [...canary].map(char => String.raw`\u` + char.charCodeAt(0).toString(16).padStart(4, '0'))
  const found = new Set<string>()
  const anywhere = (needle: string): boolean => raw.includes(needle) || strings.some(text => text.includes(needle))
  if (anywhere(canary)) found.add('contiguous')
  if (raw.toLowerCase().includes(escaped.join(''))) found.add('escaped')
  if (anywhere(first) && anywhere(second)) found.add('halves')
  for (const alphabet of ['base64', 'base64url'] as const) {
    if (base64Needles(canary, alphabet).some(needle => anywhere(needle))) found.add(alphabet)
  }
  if (anywhere(Buffer.from(canary).toString('hex'))) found.add('hex')
  return [...found]
}
