import process from 'node:process'

import {dispatchArgv} from './main-dispatch.js'

// eslint-disable-next-line no-void
void dispatchArgv().catch(() => {
  console.error(JSON.stringify({level: 'error', msg: 'dispatch failed'}))
  process.exit(1)
})
