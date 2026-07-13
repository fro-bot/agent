/**
 * Thin re-export entry for the self-contained session-tools bundle.
 *
 * tsdown emits this as `dist/session-tools.js`; the tool registry derives
 * ids (`session_list`, `session_read`, `session_search`, `session_info`)
 * from the file's namespace (`session`) + each named export, so the export
 * surface here must be EXACTLY {list, read, search, info} — no extra named
 * exports, no `createSessionTools`.
 */
export {info, list, read, search} from '../../../packages/runtime/src/agent/session-tools.js'
