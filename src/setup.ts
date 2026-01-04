/**
 * Setup action entry point.
 *
 * This file is bundled to dist/setup.js and executed by the setup composite action.
 * It bootstraps the environment for OpenCode agent execution.
 *
 * @module setup
 */

import {runSetup} from './lib/setup/setup.js'

await runSetup()
