import {Buffer} from 'node:buffer'
import {spawn} from 'node:child_process'
import process from 'node:process'

import {AGENT_HOME, AGENT_TMPDIR} from './identity.js'

export type CheckoutLayoutChildOutcome =
  | {readonly kind: 'ok'; readonly stdout: string}
  | {readonly kind: 'failed'}
  | {readonly kind: 'termination-unconfirmed'}

export interface CheckoutLayoutChildOptions {
  readonly checkoutPath: string
  readonly timeoutMs: number
  readonly uid: number | undefined
  readonly gid: number | undefined
}

export type ObstructionPathResult =
  | {readonly kind: 'file'; readonly text: string}
  | {readonly kind: 'symlink'; readonly target: string}
  | {readonly kind: 'special'}
  | {readonly kind: 'too-large'}
  | {readonly kind: 'failed'}
  | {readonly kind: 'termination-unconfirmed'}

export interface ObstructionPathOptions {
  readonly checkoutPath: string
  readonly relativePath: string
  readonly maxBytes: number
  readonly timeoutMs: number
  readonly uid: number | undefined
  readonly gid: number | undefined
}

export type ObstructionPathRunner = (options: ObstructionPathOptions) => Promise<ObstructionPathResult>

const REAP_GRACE_MS = 2_000
const MAX_OUTPUT_BYTES = 64 * 1024
const CHILD_ENV: NodeJS.ProcessEnv = {PATH: '/usr/bin:/bin', HOME: AGENT_HOME, TMPDIR: AGENT_TMPDIR, LANG: 'C'}

// All checkout-path lookups happen inside this agent-UID process. Reads of config and packed-refs
// are descriptor-based and nonblocking so an agent-created FIFO can neither hang the service nor
// be mistaken for missing metadata.
const LAYOUT_SCRIPT = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const rootArg = process.argv[1];
const fail = () => ({kind:'inspection-failed'});
const refused = reason => ({kind:'refused',reason});
function exists(p) { try { fs.statSync(p); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
function hasEntries(p) { try { return fs.readdirSync(p).length > 0; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
function readRegular(p, absentAllowed) {
  let fd;
  try {
    fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return {error:true};
    return {text:fs.readFileSync(fd, 'utf8')};
  } catch (e) { if (absentAllowed && e.code === 'ENOENT') return {text:null}; return {error:true}; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function configKeys(text) {
  const out=[]; let section='';
  for (const raw of text.split(/\r?\n/)) {
    const line=raw.trim(); if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const m=/^\[([^\s\]"]+)(?:\s+"[^"]*")?\]/.exec(line);
    if (m) { section=m[1].toLowerCase(); continue; }
    if (!section) continue;
    const k=/^([A-Z][A-Z0-9-]*)\b/i.exec(line); if (k) out.push({section,key:k[1].toLowerCase()});
  }
  return out;
}
function inspect() {
  const canonical=fs.realpathSync(rootArg), git=path.join(canonical,'.git');
  let gs; try { gs=fs.lstatSync(git); } catch (e) {
    if (e.code !== 'ENOENT') return fail();
    if (exists(path.join(canonical,'HEAD')) && exists(path.join(canonical,'objects')) && exists(path.join(canonical,'refs'))) return refused('bare-repository');
    return fail();
  }
  if (gs.isSymbolicLink()) return refused('symlinked-git-dir');
  if (!gs.isDirectory()) return gs.isFile() ? refused('gitfile') : fail();
  const config=path.join(git,'config');
  let cs; try { cs=fs.lstatSync(config); } catch (_) { return fail(); }
  if (cs.isSymbolicLink()) return refused('symlinked-config');
  if (!cs.isFile()) return fail();
  const configRead=readRegular(config,false); if (configRead.error) return fail();
  const entries=configKeys(configRead.text);
  if (entries.some(e=>e.section==='core'&&e.key==='worktree')) return refused('core-worktree');
  if (exists(path.join(git,'objects','info','alternates')) || exists(path.join(git,'objects','info','http-alternates'))) return refused('alternates');
  if (hasEntries(path.join(git,'refs','replace'))) return refused('replace-refs');
  const packed=readRegular(path.join(git,'packed-refs'),true); if (packed.error) return fail();
  if (packed.text!==null&&packed.text.split('\n').some(x=>x.includes(' refs/replace/'))) return refused('replace-refs');
  if (exists(path.join(git,'info','grafts'))) return refused('grafts');
  if (exists(path.join(git,'shallow'))) return refused('shallow');
  if (entries.some(e=>(e.section==='extensions'&&e.key==='partialclone')||(e.section==='remote'&&e.key==='promisor'))) return refused('partial-clone');
  if (hasEntries(path.join(git,'worktrees'))) return refused('linked-worktree');
  let shared=false; try { shared=fs.readdirSync(git).some(n=>n.startsWith('sharedindex.')); } catch (e) { if(e.code!=='ENOENT') return fail(); }
  if (shared || entries.some(e=>(e.section==='core'&&(e.key==='splitindex'||e.key==='sparsecheckout'))||(e.section==='index'&&(e.key==='sparse'||e.key==='version'))||(e.section==='extensions'&&e.key!=='partialclone'))) return refused('unsupported-index-flag');
  return {kind:'ok'};
}
let result; try { result=inspect(); } catch (_) { result={kind:'inspection-failed'}; }
process.stdout.write(JSON.stringify(result));
`

const OBSTRUCTION_SCRIPT = String.raw`
const fs=require('node:fs');
const path=require('node:path');
const [rootArg,relativePath,maxBytesArg]=process.argv.slice(1);
const maxBytes=Number(maxBytesArg);
const result=(kind,extra={})=>({kind,...extra});
function inspect(){
  const root=fs.realpathSync(rootArg);
  const target=path.resolve(root,relativePath);
  const rel=path.relative(root,target);
  if(rel===''||rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel)) return result('failed');
  const segments=rel.split(path.sep);
  let current=root;
  for(let i=0;i<segments.length-1;i++){
    current=path.join(current,segments[i]);
    const ancestor=fs.lstatSync(current);
    if(ancestor.isSymbolicLink()||!ancestor.isDirectory()) return result('special');
  }
  let st;
  try{st=fs.lstatSync(target);}catch(e){if(e.code==='ENOENT')return result('failed');throw e;}
  if(st.isSymbolicLink()) return result('symlink',{target:fs.readlinkSync(target,'utf8')});
  if(!st.isFile()) return result('special');
  let fd;
  try{
    fd=fs.openSync(target,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
    st=fs.fstatSync(fd);
    if(!st.isFile())return result('special');
    const chunks=[]; let total=0;
    while(total<=maxBytes){
      const chunk=Buffer.allocUnsafe(Math.min(65536,maxBytes+1-total));
      const count=fs.readSync(fd,chunk,0,chunk.length,null);
      if(count===0)break;
      total+=count; chunks.push(chunk.subarray(0,count));
      if(total>maxBytes)return result('too-large');
    }
    return result('file',{text:Buffer.concat(chunks,total).toString('utf8')});
  }catch(e){if(e.code==='ELOOP'||e.code==='ENXIO')return result('special');return result('failed');}
  finally{if(fd!==undefined)fs.closeSync(fd);}
}
let output;try{output=inspect();}catch(_){output=result('failed');}
process.stdout.write(JSON.stringify(output));
`

interface ChildScriptOptions {
  readonly script: string
  readonly args: readonly string[]
  readonly timeoutMs: number
  readonly uid: number | undefined
  readonly gid: number | undefined
  readonly maxOutputBytes: number
}

type ChildScriptOutcome =
  | {readonly kind: 'ok'; readonly stdout: string}
  | {readonly kind: 'failed'}
  | {readonly kind: 'termination-unconfirmed'}

function runBoundedChild(options: ChildScriptOptions): Promise<ChildScriptOutcome> {
  return new Promise(resolve => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(process.execPath, ['--disallow-code-generation-from-strings', '--no-addons', '-e', options.script, '--', ...options.args], {
        cwd: '/', env: CHILD_ENV, uid: options.uid, gid: options.gid, stdio: ['ignore', 'pipe', 'ignore'],
      })
    } catch { resolve({kind: 'failed'}); return }
    let settled = false
    let bytes = 0
    let overflowed = false
    let chunks: Buffer[] = []
    let timeout: ReturnType<typeof setTimeout>
    let grace: ReturnType<typeof setTimeout> | undefined
    const armUnconfirmed = (): void => {
      if (grace !== undefined) return
      grace = setTimeout(() => {
        if (settled) return
        settled = true
        chunks = []
        resolve({kind: 'termination-unconfirmed'})
      }, REAP_GRACE_MS)
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled) return
      bytes += chunk.length
      if (bytes > options.maxOutputBytes) {
        overflowed = true
        chunks = []
        child.kill('SIGKILL')
        armUnconfirmed()
        return
      }
      chunks.push(chunk)
    })
    child.on('error', () => {
      if (settled) return
      if (child.pid === undefined) {
        settled = true
        clearTimeout(timeout)
        resolve({kind: 'failed'})
        return
      }
      armUnconfirmed()
    })
    child.on('close', code => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (grace !== undefined) clearTimeout(grace)
      if (code !== 0 || overflowed) {
        resolve({kind: 'failed'})
        return
      }
      resolve({kind: 'ok', stdout: Buffer.concat(chunks).toString('utf8')})
    })
    timeout = setTimeout(() => {
      if (settled) return
      child.kill('SIGKILL')
      armUnconfirmed()
    }, options.timeoutMs)
  })
}

function parseObstructionResult(stdout: string): ObstructionPathResult {
  let parsed: unknown
  try { parsed = JSON.parse(stdout) } catch { return {kind: 'failed'} }
  if (typeof parsed !== 'object' || parsed === null || !('kind' in parsed)) return {kind: 'failed'}
  const value = parsed as {readonly kind: unknown; readonly text?: unknown; readonly target?: unknown}
  if (value.kind === 'file' && typeof value.text === 'string') return {kind: 'file', text: value.text}
  if (value.kind === 'symlink' && typeof value.target === 'string') return {kind: 'symlink', target: value.target}
  if (value.kind === 'special' || value.kind === 'too-large' || value.kind === 'failed') return {kind: value.kind}
  return {kind: 'failed'}
}

export function runCheckoutLayoutChild(options: CheckoutLayoutChildOptions): Promise<CheckoutLayoutChildOutcome> {
  return runBoundedChild({
    script: LAYOUT_SCRIPT,
    args: [options.checkoutPath],
    timeoutMs: options.timeoutMs,
    uid: options.uid,
    gid: options.gid,
    maxOutputBytes: MAX_OUTPUT_BYTES,
  })
}

export function runCheckoutObstructionChild(options: ObstructionPathOptions): Promise<ObstructionPathResult> {
  return runBoundedChild({
    script: OBSTRUCTION_SCRIPT,
    args: [options.checkoutPath, options.relativePath, String(options.maxBytes)],
    timeoutMs: options.timeoutMs,
    uid: options.uid,
    gid: options.gid,
    maxOutputBytes: Math.max(MAX_OUTPUT_BYTES, options.maxBytes * 6 + 1024),
  }).then(outcome => {
    if (outcome.kind !== 'ok') return outcome
    return parseObstructionResult(outcome.stdout)
  })
}
