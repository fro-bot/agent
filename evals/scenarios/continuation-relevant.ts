import type {PriorWork, Scenario} from '../types.js'
import {CONTINUATION_FILES, CONTINUATION_PROMPT, CONTINUATION_SURFACE} from './continuation-shared.js'

const RELEVANT_PRIOR_WORK: PriorWork = {
  sessionContext: {
    recentSessions: [],
    priorWorkContext: [
      {
        sessionId: 'continuation-session-42',
        matches: [
          {
            messageId: 'message-orbit-217',
            partId: 'part-orbit-217',
            excerpt: 'Decision ORBIT-217: Event ordering must use the seq field, never wall-clock timestamps.',
            role: 'assistant',
            agent: 'build',
          },
        ],
      },
    ],
  },
  currentThreadSessionId: 'continuation-session-42',
}

export const continuationRelevantScenario: Scenario = {
  id: 'continuation-relevant',
  description: 'An issue answer with a prior decision directly relevant to the current question.',
  files: CONTINUATION_FILES,
  surface: CONTINUATION_SURFACE,
  prompt: CONTINUATION_PROMPT,
  priorWork: RELEVANT_PRIOR_WORK,
  expect: {
    verdict: null,
    requiredSignals: [
      {id: 'ordering-field', anyOf: ['seq']},
      {id: 'prior-decision', anyOf: ['ORBIT-217']},
    ],
  },
}
