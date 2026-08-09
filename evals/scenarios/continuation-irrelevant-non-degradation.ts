import type {PriorWork, Scenario} from '../types.js'
import {CONTINUATION_FILES, CONTINUATION_PROMPT, CONTINUATION_SURFACE} from './continuation-shared.js'

const IRRELEVANT_PRIOR_WORK: PriorWork = {
  sessionContext: {
    recentSessions: [],
    priorWorkContext: [
      {
        sessionId: 'continuation-session-42',
        matches: [
          {
            messageId: 'message-utc-rounding-9000',
            partId: 'part-utc-rounding-9000',
            excerpt: 'Unrelated decision UTC-ROUNDING-9000: display timestamps use a normalized UTC representation.',
            role: 'assistant',
            agent: 'build',
          },
        ],
      },
    ],
  },
  currentThreadSessionId: 'continuation-session-42',
}

export const continuationIrrelevantNonDegradationScenario: Scenario = {
  id: 'continuation-irrelevant-non-degradation',
  description: 'An issue answer that should not degrade when prior work is unrelated.',
  files: CONTINUATION_FILES,
  surface: CONTINUATION_SURFACE,
  prompt: CONTINUATION_PROMPT,
  priorWork: IRRELEVANT_PRIOR_WORK,
  expect: {
    verdict: null,
    requiredSignals: [{id: 'ordering-field', anyOf: ['seq']}],
  },
}
