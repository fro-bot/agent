import process from 'node:process'

import {dispatchArgv} from './main-dispatch.js'

// eslint-disable-next-line no-void
void dispatchArgv().catch((error: unknown) => {
  console.error(JSON.stringify({level: 'error', msg: 'dispatch failed', error: String(error)}))
  process.exit(1)
})
