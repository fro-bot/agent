import process from 'node:process'
import {run} from './harness/run.js'

await run().then(exitCode => {
  process.exit(exitCode)
})
