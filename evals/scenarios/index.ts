import {cleanPrScenario} from './clean-pr.js'
import {plantedDefectScenario} from './planted-defect.js'

export const MAX_SCENARIOS = 8
export const ALL_SCENARIOS = [cleanPrScenario, plantedDefectScenario] as const
