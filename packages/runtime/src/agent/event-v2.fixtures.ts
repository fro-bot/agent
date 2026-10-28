/**
 * Test fixtures for the OpenCode V2 event mapper, ledger adapter and subagent-notice reader.
 *
 * Every payload comes from the real v2.2.0 probe run (Unit 1, `/tmp/v2-plan/probes/logs/`, binary sha256
 * `c71b1cd96541539ad38e2a75377d2f43d2a27567289a14371a182e9a0800db3d`). Nothing here is hand-shaped from a
 * schema, except the entries listed under "Derived" below.
 *
 * Captured (verbatim `data`, session ids and values untouched):
 * - `p01.events.json`: complete frames (envelope + `data`) for a plain text turn.
 * - `p11b.out.json`: a complete `session.execution.interrupted` frame (reason `user`).
 * - `p05.out.json` `lifecycle`: an `execute` call, `input.started` through `progress` ×4. The probe logger cut
 *   long strings at a fixed width, so `called.input.code` is the captured prefix, and the last two `progress`
 *   frames are trimmed to the keys that survived intact (the second inner call's `input` was cut off and is
 *   dropped, not completed).
 * - `p05b.out.json` `pendingList`: two concurrent `permission.asked` payloads from one `execute` call.
 * - `p06.baseline.json`: complete `tool.called`/`tool.success`/`tool.failed`, `permission.asked` and
 *   `form.cancelled` payloads. The probe stripped `"sessionID"` from these before logging, so it is re-added from
 *   the `sessionID` field recorded on the same behavior.
 * - `p12.out.json`: a `session.moved` payload. The trailing `subpath` was cut by the logger and is dropped.
 * - `p02.out.json`: the persisted subagent notice message (with `metadata`), the session list, `session.active`
 *   while the child was held, and the child list.
 *
 * Derived from the v2.2.0 source (no wire capture exists), shaped to the schema and labelled `derived`:
 * `form.created` (`packages/core/src/tool/plugin/question.ts`, `packages/schema/src/form.ts`),
 * `session.inbox.enqueued` carrying a synthetic subagent item (`packages/schema/src/session-inbox.ts`,
 * `packages/core/src/session/subagent-completion.ts`), `session.retry.scheduled`, `session.execution.failed`,
 * `session.step.failed` (`packages/schema/src/session-event.ts`, `session-error.ts`), the `session.reasoning.*`
 * family, and a running background `subagent` dispatch (`packages/core/src/tool/plugin/subagent.ts`).
 */

/** Envelope the mapper reads: only `type` and `data` matter. Used where the probe logged `data` alone. */
function frame(type: string, data: unknown): {readonly type: string; readonly data: unknown} {
  return {type, data}
}

// --- p01.events.json: complete frames, plain text turn -------------------------------------------------------------

export const TEXT_SESSION_ID = 'ses_e7c9285d6ffemfG3dpE7QZhubG'
export const TEXT_MESSAGE_ID = 'msg_1836d7dc50010bSp10K3TEn20Z'

export const SERVER_CONNECTED_FRAME = {
  id: 'evt_1836d7a1e001N9bXKngAACh82r',
  type: 'server.connected',
  data: {},
} as const

export const EXECUTION_STARTED_FRAME = {
  id: 'evt_1836d7db3001JL2OrekCUT141A',
  created: 1793206353331,
  type: 'session.execution.started',
  data: {sessionID: TEXT_SESSION_ID},
  durable: {aggregateID: TEXT_SESSION_ID, seq: 2, version: 1},
} as const

export const INBOX_ENQUEUED_USER_FRAME = {
  id: 'evt_1836d7dae001vYfS14Bynv7HAN',
  created: 1793206353326,
  type: 'session.inbox.enqueued',
  location: {directory: '/tmp/v2-plan/probes/work/repo-main'},
  data: {
    inboxID: 'msg_1836d7c84001UcG33UmRHZFsFl',
    sessionID: TEXT_SESSION_ID,
    item: {type: 'user', payload: {text: 'run shell'}, delivery: 'steer'},
  },
  durable: {aggregateID: TEXT_SESSION_ID, seq: 1, version: 1},
} as const

export const STEP_STARTED_FRAME = {
  id: 'evt_1836d7de7001DXWtvMvPR728Kk',
  created: 1793206353383,
  type: 'session.step.started',
  location: {directory: '/tmp/v2-plan/probes/work/repo-main'},
  data: {
    sessionID: TEXT_SESSION_ID,
    agent: 'build',
    model: {id: 'fixture-model', providerID: 'fake'},
    assistantMessageID: TEXT_MESSAGE_ID,
    started: 1793206353352,
  },
  durable: {aggregateID: TEXT_SESSION_ID, seq: 6, version: 1},
} as const

export const TEXT_STARTED_FRAME = {
  id: 'evt_1836d7de9001aU3UkzwyUr5soK',
  created: 1793206353385,
  type: 'session.text.started',
  location: {directory: '/tmp/v2-plan/probes/work/repo-main'},
  data: {sessionID: TEXT_SESSION_ID, assistantMessageID: TEXT_MESSAGE_ID, ordinal: 0},
  durable: {aggregateID: TEXT_SESSION_ID, seq: 7, version: 1},
} as const

export const TEXT_DELTA_FRAME = {
  id: 'evt_1836d7deb001gkgC9qw7HPQobs',
  created: 1793206353387,
  type: 'session.text.delta',
  location: {directory: '/tmp/v2-plan/probes/work/repo-main'},
  data: {sessionID: TEXT_SESSION_ID, assistantMessageID: TEXT_MESSAGE_ID, ordinal: 0, delta: 'all done'},
} as const

export const TEXT_ENDED_FRAME = {
  id: 'evt_1836d7deb002LBusc5dbDxuYTX',
  created: 1793206353387,
  type: 'session.text.ended',
  location: {directory: '/tmp/v2-plan/probes/work/repo-main'},
  data: {sessionID: TEXT_SESSION_ID, assistantMessageID: TEXT_MESSAGE_ID, ordinal: 0, text: 'all done'},
  durable: {aggregateID: TEXT_SESSION_ID, seq: 8, version: 1},
} as const

export const EXECUTION_SUCCEEDED_FRAME = {
  id: 'evt_1836d7dee001quP4xueA3Gc0lm',
  created: 1793206353390,
  type: 'session.execution.succeeded',
  data: {sessionID: TEXT_SESSION_ID},
  durable: {aggregateID: TEXT_SESSION_ID, seq: 11, version: 1},
} as const

/** The whole captured plain turn, in wire order (non-mapped frames included). */
export const PLAIN_TURN_FRAMES = [
  SERVER_CONNECTED_FRAME,
  INBOX_ENQUEUED_USER_FRAME,
  EXECUTION_STARTED_FRAME,
  STEP_STARTED_FRAME,
  TEXT_STARTED_FRAME,
  TEXT_DELTA_FRAME,
  TEXT_ENDED_FRAME,
  EXECUTION_SUCCEEDED_FRAME,
] as const

// --- p11b.out.json: complete interrupt frame -----------------------------------------------------------------------

export const INTERRUPT_SESSION_ID = 'ses_e7c833b17ffeuDWcNtK6kbavj8'

export const EXECUTION_INTERRUPTED_USER_FRAME = {
  id: 'evt_1837ccbc2001xHGNnKIATFS4NK',
  created: 1793207356354,
  type: 'session.execution.interrupted',
  data: {sessionID: INTERRUPT_SESSION_ID, reason: 'user'},
  durable: {aggregateID: INTERRUPT_SESSION_ID, seq: 9, version: 1},
} as const

/** Same shape as the captured frame; `reason: "shutdown"` is the value `core/src/session/execution.ts:60-74` emits. */
export const EXECUTION_INTERRUPTED_SHUTDOWN_FRAME = {
  ...EXECUTION_INTERRUPTED_USER_FRAME,
  data: {sessionID: INTERRUPT_SESSION_ID, reason: 'shutdown'},
} as const

// --- p05.out.json lifecycle: one `execute` call with two inner calls -----------------------------------------------

export const EXECUTE_SESSION_ID = 'ses_e7c74183bffeYkjoiqyba26QiG'
export const EXECUTE_MESSAGE_ID = 'msg_1838bea650013lqWJEFLdW8KKG'
export const EXECUTE_CALL_ID = 'call_10_0'

export const EXECUTE_INPUT_STARTED_FRAME = frame('session.tool.input.started', {
  sessionID: EXECUTE_SESSION_ID,
  assistantMessageID: EXECUTE_MESSAGE_ID,
  id: EXECUTE_CALL_ID,
  name: 'execute',
})

export const EXECUTE_CALLED_FRAME = frame('session.tool.called', {
  sessionID: EXECUTE_SESSION_ID,
  assistantMessageID: EXECUTE_MESSAGE_ID,
  id: EXECUTE_CALL_ID,
  // Prefix only: the probe logger cut the captured string here.
  input: {
    code: 'const [a, b] = await Promise.all([tools.opencode.worktree_list({}), tools.opencode.models({limit: 1})]); return {wt: a.worktre',
  },
  executed: false,
})

export const EXECUTE_PROGRESS_FRAMES = [
  frame('session.tool.progress', {
    sessionID: EXECUTE_SESSION_ID,
    assistantMessageID: EXECUTE_MESSAGE_ID,
    id: EXECUTE_CALL_ID,
    metadata: {toolCalls: [{tool: 'opencode.worktree_list', status: 'running'}]},
  }),
  frame('session.tool.progress', {
    sessionID: EXECUTE_SESSION_ID,
    assistantMessageID: EXECUTE_MESSAGE_ID,
    id: EXECUTE_CALL_ID,
    metadata: {toolCalls: [{tool: 'opencode.worktree_list', status: 'completed'}]},
  }),
  // Trimmed: the second call's `input` was cut off by the probe logger and is dropped.
  frame('session.tool.progress', {
    sessionID: EXECUTE_SESSION_ID,
    assistantMessageID: EXECUTE_MESSAGE_ID,
    id: EXECUTE_CALL_ID,
    metadata: {
      toolCalls: [
        {tool: 'opencode.worktree_list', status: 'completed'},
        {tool: 'opencode.models', status: 'running'},
      ],
    },
  }),
  frame('session.tool.progress', {
    sessionID: EXECUTE_SESSION_ID,
    assistantMessageID: EXECUTE_MESSAGE_ID,
    id: EXECUTE_CALL_ID,
    metadata: {
      toolCalls: [
        {tool: 'opencode.worktree_list', status: 'completed'},
        {tool: 'opencode.models', status: 'completed'},
      ],
    },
  }),
] as const

/** `content` verbatim from the capture; `metadata.toolCalls` is the final `progress` frame's list. */
export const EXECUTE_SUCCESS_FRAME = frame('session.tool.success', {
  sessionID: EXECUTE_SESSION_ID,
  assistantMessageID: EXECUTE_MESSAGE_ID,
  id: EXECUTE_CALL_ID,
  content: [{type: 'text', text: '{\n  "wt": 1,\n  "models": 1\n}'}],
  metadata: {
    toolCalls: [
      {tool: 'opencode.worktree_list', status: 'completed'},
      {tool: 'opencode.models', status: 'completed'},
    ],
  },
  executed: false,
})

// --- p05b.out.json pendingList: two concurrent asks from one `execute` call ----------------------------------------

export const NESTED_ASK_SESSION_ID = 'ses_e7c731d44ffeRXimVPifkTH145'
export const NESTED_ASK_EXECUTE_CALL_ID = 'call_20_0'
export const NESTED_ASK_MESSAGE_ID = 'msg_1838ce2f70017aca6pY0MFDLYa'
export const NESTED_ASK_REQUEST_IDS = ['per_1838ce308001tRqxeHBwCeetcs', 'per_1838ce308003xmw1GIBf1PJLzo'] as const

const WORKTREE_BASE = '/private/tmp/v2-plan/probes/work/p05b-nested-ask/home/.local/share/opencode/worktree/8f5f69'

export const NESTED_PERMISSION_ASKED_FRAMES = [
  frame('permission.asked', {
    id: NESTED_ASK_REQUEST_IDS[0],
    sessionID: NESTED_ASK_SESSION_ID,
    action: 'edit',
    resources: [`${WORKTREE_BASE}/probe-wt-d1`],
    save: ['*'],
    source: {type: 'tool', messageID: NESTED_ASK_MESSAGE_ID, id: NESTED_ASK_EXECUTE_CALL_ID},
  }),
  frame('permission.asked', {
    id: NESTED_ASK_REQUEST_IDS[1],
    sessionID: NESTED_ASK_SESSION_ID,
    action: 'edit',
    resources: [`${WORKTREE_BASE}/probe-wt-d2`],
    save: ['*'],
    source: {type: 'tool', messageID: NESTED_ASK_MESSAGE_ID, id: NESTED_ASK_EXECUTE_CALL_ID},
  }),
] as const

// --- p06.baseline.json: direct tools, an `ask` with nobody to answer, a cancelled question form -------------------

export const ENV_ASK_SESSION_ID = 'ses_e7c76c486ffe1VvXMPH3vnN4T5'

export const ENV_PERMISSION_ASKED_FRAME = frame('permission.asked', {
  id: 'per_183893b940016SU8uCIJklSPOY',
  sessionID: ENV_ASK_SESSION_ID,
  action: 'read',
  resources: ['.env'],
  save: ['*'],
  source: {type: 'tool', messageID: 'msg_183893b89001zTUTVVjKSYBbSf', id: 'call_11_0'},
})

export const QUESTION_SESSION_ID = 'ses_e7c7674b6ffeTCxnqVMBl6nqkF'
export const QUESTION_MESSAGE_ID = 'msg_183898b610014onEp0BwSoDKpA'
export const QUESTION_CALL_ID = 'call_13_0'
export const QUESTION_FORM_ID = 'frm_183898b6d001OYjyqnfpPw3bhJ'

export const QUESTION_TOOL_CALLED_FRAME = frame('session.tool.called', {
  sessionID: QUESTION_SESSION_ID,
  assistantMessageID: QUESTION_MESSAGE_ID,
  id: QUESTION_CALL_ID,
  input: {
    questions: [
      {
        question: 'Pick?',
        header: 'Pick',
        options: [
          {label: 'A', description: 'a'},
          {label: 'B', description: 'b'},
        ],
      },
    ],
  },
  executed: false,
})

export const FORM_CANCELLED_FRAME = frame('form.cancelled', {id: QUESTION_FORM_ID, sessionID: QUESTION_SESSION_ID})

export const QUESTION_TOOL_FAILED_FRAME = frame('session.tool.failed', {
  sessionID: QUESTION_SESSION_ID,
  assistantMessageID: QUESTION_MESSAGE_ID,
  id: QUESTION_CALL_ID,
  error: {type: 'tool.execution', message: 'probe-cancel'},
  executed: false,
})

/**
 * Derived: the form the `question` tool asks, as `packages/core/src/tool/plugin/question.ts` builds it for the
 * `question` input in `QUESTION_TOOL_CALLED_FRAME` (title `Questions`, `metadata.kind` `question`, one field per
 * prompt). The capture only recorded the pending form's id and `kind`, not the whole `form.created` payload.
 */
export const QUESTION_FORM_CREATED_FRAME = frame('form.created', {
  form: {
    id: QUESTION_FORM_ID,
    sessionID: QUESTION_SESSION_ID,
    title: 'Questions',
    metadata: {kind: 'question', tool: {messageID: QUESTION_MESSAGE_ID, id: QUESTION_CALL_ID}},
    fields: [
      {
        key: 'q0',
        title: 'Pick',
        description: 'Pick?',
        type: 'string',
        options: [
          {value: 'A', label: 'A', description: 'a'},
          {value: 'B', label: 'B', description: 'b'},
        ],
        custom: true,
      },
    ],
  },
})

/** Derived: an MCP-style form with no `metadata.kind`, the case the gateway cancels with a notice. */
export const UNKNOWN_KIND_FORM_CREATED_FRAME = frame('form.created', {
  form: {
    id: 'frm_unknown_kind',
    sessionID: QUESTION_SESSION_ID,
    title: 'Sign in',
    fields: [{key: 'token', type: 'string'}],
  },
})

/** p06.baseline.json: complete direct-tool success (a `read`). */
export const READ_TOOL_SUCCESS_FRAME = frame('session.tool.success', {
  sessionID: 'ses_e7c76ca2cffeCMj4wOOeafylOu',
  assistantMessageID: 'msg_1838935fd001YMNMtm5HdEmtH8',
  id: 'call_2_0',
  content: [
    {type: 'text', text: 'Read file /tmp/v2-plan/probes/work/outside/secret.txt, lines 1-1\n1: TOP-SECRET-OUTSIDE'},
  ],
  metadata: {truncated: false},
  executed: false,
})

/** p06.baseline.json `subagent_read_outside`: a foreground `subagent` call finishing (`status: "completed"`). */
export const SUBAGENT_FOREGROUND_SUCCESS_FRAME = frame('session.tool.success', {
  sessionID: 'ses_e7c764413ffetnK0nwDW21nYNV',
  assistantMessageID: 'msg_18389bbfb001CZWJmESBpyKCto',
  id: 'call_16_0',
  content: [
    {
      type: 'text',
      text: '<subagent sessionID="ses_e7c7643f9ffekhDhU3IqIyIIJS" state="completed">\nchild done\n</subagent>',
    },
  ],
  metadata: {sessionID: 'ses_e7c7643f9ffekhDhU3IqIyIIJS', status: 'completed', truncated: false},
  executed: false,
})

// --- p12.out.json: session.moved -----------------------------------------------------------------------------------

export const MOVED_SESSION_ID = 'ses_e7c70d6deffed2HvubLMRKrBW3'

/** `subpath` is dropped: the probe logger cut it mid-string. */
export const SESSION_MOVED_FRAME = frame('session.moved', {
  sessionID: MOVED_SESSION_ID,
  location: {directory: '/tmp/v2-plan/probes/work/p12-destination'},
  projectID: '98383e6629c0b8a05373f0fa522a7f7e7206e3b2',
})

// --- p02.out.json: background child + notice -----------------------------------------------------------------------

export const PARENT_SESSION_ID = 'ses_e7c793956ffeAi2UXkww9zfMtr'
export const CHILD_SESSION_ID = 'ses_e7c7935fdffeLXXB12WQkozSKw'
export const REPO_A_DIRECTORY = '/tmp/v2-plan/probes/work/p02-repoA-0'

/** The persisted synthetic message the parent received when the child finished, verbatim. */
export const SUBAGENT_NOTICE_MESSAGE = {
  id: 'msg_18386ca070019dpFi0bxS4Wyfm',
  metadata: {source: 'subagent', childID: CHILD_SESSION_ID, agent: 'General', state: 'completed'},
  time: {created: 1793208012128},
  text: `<subagent sessionID="${CHILD_SESSION_ID}" state="completed" description="bg child">\nchild result text\n</subagent>`,
  description: 'bg child',
  type: 'synthetic',
} as const

/** `GET /api/session/active` while the child was held and the parent had finished: only the child is listed. */
export const ACTIVE_WHILE_CHILD_HELD = {[CHILD_SESSION_ID]: {type: 'running'}} as const

export const PARENT_SESSION_INFO = {
  id: PARENT_SESSION_ID,
  projectID: '2f82ae449e93bc3b5c33b2e0556351fff895a4d0',
  cost: 0,
  tokens: {input: 30, output: 15, reasoning: 0, cache: {read: 0, write: 0}},
  outcome: 'succeeded',
  time: {created: 1793208010455, updated: 1793208011294, idle: 1793208011295},
  title: 'done',
  subpath: '../../../../../../tmp/v2-plan/probes/work/p02-repoA-0',
  location: {directory: REPO_A_DIRECTORY},
} as const

export const CHILD_SESSION_INFO = {
  id: CHILD_SESSION_ID,
  parentID: PARENT_SESSION_ID,
  projectID: '2f82ae449e93bc3b5c33b2e0556351fff895a4d0',
  agent: 'general',
  cost: 0,
  tokens: {input: 0, output: 0, reasoning: 0, cache: {read: 0, write: 0}},
  time: {created: 1793208011267, updated: 1793208011269},
  title: 'bg child',
  subpath: '../../../../../../tmp/v2-plan/probes/work/p02-repoA-0',
  location: {directory: REPO_A_DIRECTORY},
} as const

/** A session in the other repo (`listB` in the capture): same server, different directory, not active. */
export const REPO_B_SESSION_INFO = {
  id: 'ses_e7c793923ffe08O9I1tsfaBNeM',
  projectID: '2f82ae449e93bc3b5c33b2e0556351fff895a4d0',
  cost: 0,
  tokens: {input: 0, output: 0, reasoning: 0, cache: {read: 0, write: 0}},
  time: {created: 1793208010460, updated: 1793208010460},
  location: {directory: '/tmp/v2-plan/probes/work/p02-repoB-0'},
} as const

// --- Derived frames (no wire capture) ------------------------------------------------------------------------------

/**
 * Derived: the synthetic inbox item the server enqueues on the parent when a subagent finishes
 * (`subagent-completion.ts`), carrying the P2-captured `metadata`. `delivery` is `steer`, one of the two schema values.
 */
export const SUBAGENT_NOTICE_ENQUEUED_FRAME = frame('session.inbox.enqueued', {
  inboxID: SUBAGENT_NOTICE_MESSAGE.id,
  sessionID: PARENT_SESSION_ID,
  item: {
    type: 'synthetic',
    payload: {
      text: SUBAGENT_NOTICE_MESSAGE.text,
      description: SUBAGENT_NOTICE_MESSAGE.description,
      metadata: SUBAGENT_NOTICE_MESSAGE.metadata,
    },
    delivery: 'steer',
  },
})

/** Derived: a child's cancellation, `state: "cancelled"` per `subagent-completion.ts` / `job.ts:27`. */
export const SUBAGENT_NOTICE_CANCELLED_METADATA = {
  source: 'subagent',
  childID: CHILD_SESSION_ID,
  agent: 'General',
  state: 'cancelled',
} as const

/** Derived: a user-authored prompt that claims subagent metadata. Only the server sets this on synthetic items. */
export const FORGED_USER_ENQUEUED_FRAME = frame('session.inbox.enqueued', {
  inboxID: 'msg_forged_user',
  sessionID: PARENT_SESSION_ID,
  item: {
    type: 'user',
    payload: {
      text: 'hello',
      metadata: {source: 'subagent', childID: CHILD_SESSION_ID, agent: 'General', state: 'completed'},
    },
    delivery: 'steer',
  },
})

export const RETRY_SCHEDULED_FRAME = frame('session.retry.scheduled', {
  sessionID: TEXT_SESSION_ID,
  assistantMessageID: TEXT_MESSAGE_ID,
  attempt: 2,
  at: 1793206360000,
  error: {type: 'provider.rate_limit', message: 'slow down', status: 429, retryAfterMs: 5000},
})

export const EXECUTION_FAILED_FRAME = frame('session.execution.failed', {
  sessionID: TEXT_SESSION_ID,
  error: {type: 'provider.error', message: 'boom', status: 500, response: {body: 'secret upstream body'}},
})

export const STEP_FAILED_FRAME = frame('session.step.failed', {
  sessionID: TEXT_SESSION_ID,
  assistantMessageID: TEXT_MESSAGE_ID,
  error: {type: 'context_overflow', message: 'too long'},
})

export const REASONING_FRAMES = [
  frame('session.reasoning.started', {sessionID: TEXT_SESSION_ID, assistantMessageID: TEXT_MESSAGE_ID, ordinal: 0}),
  frame('session.reasoning.delta', {
    sessionID: TEXT_SESSION_ID,
    assistantMessageID: TEXT_MESSAGE_ID,
    ordinal: 0,
    delta: 'PRIVATE CHAIN OF THOUGHT',
  }),
  frame('session.reasoning.ended', {
    sessionID: TEXT_SESSION_ID,
    assistantMessageID: TEXT_MESSAGE_ID,
    ordinal: 0,
    text: 'PRIVATE CHAIN OF THOUGHT',
  }),
] as const

/**
 * Derived: the `{sessionID, status: "running"}` metadata `subagent.ts` passes to `context.progress` (`:201`) and returns
 * as a backgrounded call's result (`:19-21`).
 */
export const SUBAGENT_BACKGROUND_METADATA = {sessionID: CHILD_SESSION_ID, status: 'running'} as const

const SUBAGENT_TOOL_ENVELOPE = {
  sessionID: PARENT_SESSION_ID,
  assistantMessageID: 'msg_18389bbfb001CZWJmESBpyKCto',
  id: 'call_16_0',
} as const

/** Derived: `context.progress` at `subagent.ts:201`, emitted for foreground and background calls alike. */
export const SUBAGENT_RUNNING_PROGRESS_FRAME = frame('session.tool.progress', {
  ...SUBAGENT_TOOL_ENVELOPE,
  metadata: SUBAGENT_BACKGROUND_METADATA,
})

/** Derived: the success of a backgrounded call; its `metadata` is the `backgroundResult` (`subagent.ts:19-21,264`). */
export const SUBAGENT_BACKGROUND_SUCCESS_FRAME = frame('session.tool.success', {
  ...SUBAGENT_TOOL_ENVELOPE,
  content: [
    {
      type: 'text',
      text: `The subagent is working in the background (sessionID: ${CHILD_SESSION_ID}). You will be notified automatically when it finishes.`,
    },
  ],
  metadata: {...SUBAGENT_BACKGROUND_METADATA, truncated: false},
  executed: false,
})

/**
 * Derived: a `subagent` call whose prompt admission failed after the progress emit. A failed tool keeps its last
 * progress snapshot as `metadata` (`packages/core/src/session/runner/publish-llm-event.ts:109-112`).
 */
export const SUBAGENT_PROMPT_FAILED_FRAME = frame('session.tool.failed', {
  ...SUBAGENT_TOOL_ENVELOPE,
  error: {type: 'tool.execution', message: `Failed to prompt subagent: ${CHILD_SESSION_ID}`},
  metadata: SUBAGENT_BACKGROUND_METADATA,
  executed: false,
})
