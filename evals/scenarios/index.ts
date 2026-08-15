import {cleanPrScenario} from './clean-pr.js'
import {continuationIrrelevantNonDegradationScenario} from './continuation-irrelevant-non-degradation.js'
import {continuationRelevantScenario} from './continuation-relevant.js'
import {issueKnownFilesScenario} from './issue-known-files.js'
import {plantedDefectScenario} from './planted-defect.js'
import {unchangedConstraintViolationScenario} from './unchanged-constraint-violation.js'

export const MAX_SCENARIOS = 8
export const ALL_SCENARIOS = [
  cleanPrScenario,
  plantedDefectScenario,
  issueKnownFilesScenario,
  continuationRelevantScenario,
  continuationIrrelevantNonDegradationScenario,
  unchangedConstraintViolationScenario,
] as const

export const PRESEARCH_EXPERIMENT_SCENARIO_IDS = [
  'continuation-relevant',
  'continuation-irrelevant-non-degradation',
] as const
