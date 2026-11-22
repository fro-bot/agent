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
  /** Planted by the runner inside a token run longer than any single read of the scanner. */
  readonly longControl: string
  /** Planted by the runner across the boundary between two chunks of a file larger than a chunk. */
  readonly boundaryControl: string
  readonly runnerTemp: string
  /** The checkout and the response directory. */
  readonly checkout: readonly string[]
  /** Bytes read at a time. Default `DEFAULT_CHUNK_BYTES`. */
  readonly chunkBytes?: number
  /** A file larger than this is skipped and counted. Default `DEFAULT_MAX_FILE_BYTES`. */
  readonly maxFileBytes?: number
  /** After this many seconds the scanner stops reading and counts what is left as skipped. Default `DEFAULT_BUDGET_SECONDS`. */
  readonly budgetSeconds?: number
  /** Whether the live controls in a process environment and a command line are required. Off only for a host with no `/proc`. */
  readonly requireProcControls?: boolean
}

export const DEFAULT_CHUNK_BYTES = 4 * 1024 * 1024
export const DEFAULT_MAX_FILE_BYTES = 1024 * 1024 * 1024
export const DEFAULT_BUDGET_SECONDS = 300

/** The hashes the scanner looks for, by name. Names are what it reports. */
function targets(spec: ScanSpec): Record<string, string> {
  return {
    [sha256Hex(spec.canary)]: 'canary',
    [sha256Hex(spec.liveControl)]: 'live',
    [sha256Hex(spec.xdgTextControl)]: 'xdgtext',
    [sha256Hex(spec.xdgBinaryControl)]: 'xdgbin',
    [sha256Hex(spec.longControl)]: 'long',
    [sha256Hex(spec.boundaryControl)]: 'boundary',
  }
}

/** The scanner's one argument: hashes, a length, bounds and paths. It holds no canary and no control value. */
export function scanConfig(spec: ScanSpec): string {
  return JSON.stringify({
    len: CANARY_LENGTH,
    targets: targets(spec),
    temp: spec.runnerTemp,
    checkout: spec.checkout,
    chunk: spec.chunkBytes ?? DEFAULT_CHUNK_BYTES,
    max: spec.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    budget: spec.budgetSeconds ?? DEFAULT_BUDGET_SECONDS,
    proc: spec.requireProcControls ?? true,
  })
}

/**
 * Reads every file under the named roots (binary files too, the session database and its WAL among them) and every
 * process's environment and command line, in chunks that overlap by one less than the canary's length, so a match across a
 * chunk boundary lies whole in the next chunk. Hashes every window of that length inside each run of `[A-Za-z0-9_-]` bytes,
 * however long the run, and counts the files whose hash is a target. A root that is a link is followed; a link met inside a
 * walk is not.
 *
 * Nothing is skipped silently: a file that cannot be opened or read, one over the size bound, and every file left when the
 * time budget is spent is counted per group. A skip in the checkout, the agent's home or OpenCode's storage makes the verdict
 * INCOMPLETE (unless the canary was found: that stays OPEN). Skips in the runner temp are counted only, since the sandbox is
 * not meant to read it. Prints one `RESULT` line, counts only.
 */
export const SCAN_PROGRAM = `import glob, hashlib, json, os, re, sys, time

cfg = json.loads(sys.argv[1])
extra = sys.argv[2]
LEN = cfg['len']
TARGETS = cfg['targets']
CHUNK = max(cfg['chunk'], LEN)
MAX_BYTES = cfg['max']
DEADLINE = time.monotonic() + cfg['budget']
TOKEN = re.compile(rb'[A-Za-z0-9_-]+')
GROUPS = ['environ', 'cmdline', 'file', 'temp', 'checkout', 'home', 'xdg']
COVERED = ('checkout', 'home', 'xdg')
env = os.environ
bases = [env.get(n, '') for n in ('XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME')]
bases = [b for b in bases if b]
# The places that decide the verdict come before the runner temp, so a spent budget never starves them.
roots = {
    'file': [extra],
    'xdg': [os.path.join(b, 'opencode') for b in bases],
    'checkout': cfg['checkout'],
    'home': [r for r in [env.get('HOME', '')] + bases if r],
    'temp': [cfg['temp']],
}
read = {g: 0 for g in GROUPS}
skip = {g: 0 for g in GROUPS}
hits = {g: {} for g in GROUPS}


def found_in(data, found):
    for m in TOKEN.finditer(data):
        tok = m.group()
        n = len(tok)
        if n < LEN:
            continue
        for i in range(n - LEN + 1):
            name = TARGETS.get(hashlib.sha256(tok[i:i + LEN]).hexdigest())
            if name is not None:
                found.add(name)


def scan_stream(f):
    """The set of target names in a stream, read in chunks that overlap by LEN - 1 bytes. None when the budget runs out."""
    found = set()
    carry = b''
    while True:
        block = f.read(CHUNK)
        if not block:
            return found
        buf = carry + block
        found_in(buf, found)
        carry = buf[-(LEN - 1):]
        if time.monotonic() > DEADLINE:
            return None


def count(group, found):
    read[group] += 1
    for name in found:
        hits[group][name] = hits[group].get(name, 0) + 1


for group in ('environ', 'cmdline'):
    for p in glob.glob('/proc/[0-9]*/' + group):
        # Another user's process is meant to be unreadable here: not counted as a skip.
        try:
            with open(p, 'rb') as f:
                found = scan_stream(f)
            if found is not None:
                count(group, found)
        except OSError:
            pass


def scan_file(group, p):
    if time.monotonic() > DEADLINE:
        skip[group] += 1
        return
    try:
        if os.path.islink(p):
            return
        if os.stat(p).st_size > MAX_BYTES:
            skip[group] += 1
            return
        with open(p, 'rb') as f:
            found = scan_stream(f)
        if found is None:
            skip[group] += 1
        else:
            count(group, found)
    except OSError:
        skip[group] += 1


def walk_error(group):
    def on_error(_error):
        skip[group] += 1
    return on_error


for group, group_roots in roots.items():
    for root in group_roots:
        if os.path.isfile(root):
            scan_file(group, root)
            continue
        for top, _dirs, files in os.walk(root, followlinks=False, onerror=walk_error(group)):
            for name in files:
                scan_file(group, os.path.join(top, name))

canary = {g: hits[g].get('canary', 0) for g in GROUPS}
need = [('live', 'file'), ('xdgtext', 'xdg'), ('xdgbin', 'xdg'), ('long', 'xdg'), ('boundary', 'xdg')]
if cfg['proc']:
    need = [('live', 'environ'), ('live', 'cmdline')] + need
missing = [n + '.' + g for n, g in need if hits[g].get(n, 0) < 1]
incomplete = sum(skip[g] for g in COVERED) > 0
parts = ['canary.' + g + '=' + str(canary[g]) for g in GROUPS if g != 'file']
parts += ['ctl.' + n + '.' + g + '=' + str(hits[g].get(n, 0)) for n, g in need]
parts += ['read.' + g + '=' + str(read[g]) for g in ('checkout', 'home', 'xdg')]
parts += ['skip.' + g + '=' + str(skip[g]) for g in ('checkout', 'home', 'xdg', 'temp')]
if missing:
    print('RESULT canary_scan FAILED a detector control was not seen: ' + ','.join(missing) + ' ' + ' '.join(parts))
elif sum(canary.values()) > 0:
    print('RESULT canary_scan OPEN ' + ' '.join(parts))
elif incomplete:
    print('RESULT canary_scan INCOMPLETE ' + ' '.join(parts))
else:
    print('RESULT canary_scan BLOCKED ' + ' '.join(parts))
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
 * Plants the runner's controls where the sandbox reaches OpenCode's storage:
 * - a text file in the data `opencode` directory (the sandbox's link points here);
 * - a binary file, with the value at an odd offset between NULs, in the state one;
 * - a file in the config one holding the value inside a token run longer than any read;
 * - a file in the cache one of two chunks, with the value straddling the boundary between them.
 */
export function plantScanControls(xdgRoot: string, spec: ScanSpec): void {
  const dirs = {
    data: path.join(xdgRoot, 'data', 'opencode'),
    state: path.join(xdgRoot, 'state', 'opencode'),
    config: path.join(xdgRoot, 'config', 'opencode'),
    cache: path.join(xdgRoot, 'cache', 'opencode'),
  }
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, {recursive: true})
  fs.writeFileSync(path.join(dirs.data, 'it-control.txt'), `scan control ${spec.xdgTextControl}\n`)
  fs.writeFileSync(
    path.join(dirs.state, 'it-control.bin'),
    Buffer.concat([
      Buffer.from([0, 1, 2, 0xff, 0xfe, 0, 7]),
      Buffer.from(spec.xdgBinaryControl),
      Buffer.from([0, 0x80, 0x81, 0, 3]),
    ]),
  )
  const chunk = spec.chunkBytes ?? DEFAULT_CHUNK_BYTES
  const long = Math.max(chunk, 8192) + 1000
  fs.writeFileSync(
    path.join(dirs.config, 'it-control-long.txt'),
    `${'k'.repeat(long)}${spec.longControl}${'m'.repeat(long)}`,
  )
  // Starts 17 bytes before the end of the first chunk, so it ends inside the second.
  const edge = Buffer.alloc(chunk * 2, 1)
  Buffer.from(spec.boundaryControl).copy(edge, chunk - 17)
  fs.writeFileSync(path.join(dirs.cache, 'it-control-boundary.bin'), edge)
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
