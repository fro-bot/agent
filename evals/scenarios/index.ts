import {cleanPrScenario} from './clean-pr.js'
import {issueKnownFilesScenario} from './issue-known-files.js'
import {plantedDefectScenario} from './planted-defect.js'

export const MAX_SCENARIOS = 8
export const ALL_SCENARIOS = [cleanPrScenario, plantedDefectScenario, issueKnownFilesScenario] as const
