/**
 * Post-action entry point — delegates to harness/post.ts.
 */
import process from 'node:process'
import {runPostStep} from './harness/post.js'

const {traced} = await runPostStep()

// A step that sent a span ends here, now that its export has settled or hit its bound. The trace SDK's own retry timer (a
// collector answering 503 with a long Retry-After) cannot be cancelled and would otherwise keep the process, and the job's
// last step, alive for as long as the collector asked. A step that sent nothing ends as it always did.
if (traced) process.exit(process.exitCode ?? 0)
