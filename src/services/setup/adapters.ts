import type {ExecAdapter, ToolCacheAdapter} from './types.js'
import * as exec from '@actions/exec'
import * as tc from '@actions/tool-cache'

export function createToolCacheAdapter(): ToolCacheAdapter {
  return {
    find: tc.find,
    downloadTool: tc.downloadTool,
    extractTar: tc.extractTar,
    extractZip: tc.extractZip,
    cacheDir: tc.cacheDir,
  }
}

export function createExecAdapter(): ExecAdapter {
  return {
    exec: exec.exec,
    getExecOutput: exec.getExecOutput,
  }
}
