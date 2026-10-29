/**
 * Approvals and question forms on the V2 loop: permission asks keyed by request id (nested asks from one `execute`
 * call stay distinct), the human-wait gauge that pauses the inactivity watchdog, the `question` form mapped onto the
 * existing question flow, and every other form kind cancelled with a visible notice.
 */

import type {TerminalListener} from '../approvals/request-gate.js'

import {afterEach, describe, expect, it, vi} from 'vitest'

import {createFormDirectoryV2} from './question-client-v2.js'
import {
  failure,
  frames,
  makeCoordinator,
  makeQuestions,
  ROOT,
  startRun,
  STRANGER,
  succeeded,
} from './run-core-v2.fixture.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('permission asks', () => {
  it('forwards two nested approvals from one execute call as two distinct requests', async () => {
    // #given — both asks carry the same execute call id (probe P5) and differ in request id
    const coordinator = makeCoordinator()
    const run = startRun({coordinator})
    await vi.advanceTimersByTimeAsync(10)

    // #when
    run.emit(
      frames.permissionAsked('per_a', ROOT, 'edit', '/wt/one'),
      frames.permissionAsked('per_b', ROOT, 'edit', '/wt/two'),
    )
    await vi.advanceTimersByTimeAsync(10)

    // #then
    const asked = vi.mocked(coordinator.onPermissionAsked).mock.calls.map(([request]) => request)
    expect(asked.map(request => request.requestID)).toEqual(['per_a', 'per_b'])
    expect(asked.map(request => request.sessionID)).toEqual([ROOT, ROOT])
    expect(asked[0]?.permission).toBe('edit')
    expect(asked[0]?.patterns).toEqual(['/wt/one'])
    run.close()
    await vi.advanceTimersByTimeAsync(20_000)
  })

  it('titles an outside-checkout ask with its path, as the approval UI expects', async () => {
    // #given
    const coordinator = makeCoordinator()
    const run = startRun({coordinator})
    await vi.advanceTimersByTimeAsync(10)

    // #when
    run.emit(frames.permissionAsked('per_a', ROOT, 'external_directory', '/etc/hosts'))
    await vi.advanceTimersByTimeAsync(10)

    // #then
    const request = vi.mocked(coordinator.onPermissionAsked).mock.calls[0]?.[0]
    expect(request?.title).toBe('Access outside workspace: /etc/hosts')
    run.close()
    await vi.advanceTimersByTimeAsync(20_000)
  })

  it('shows a shell ask the way the approval UI shows a command', async () => {
    // #given
    const coordinator = makeCoordinator()
    const run = startRun({coordinator})
    await vi.advanceTimersByTimeAsync(10)

    // #when
    run.emit(frames.permissionAsked('per_a', ROOT, 'shell', 'rm -rf build'))
    await vi.advanceTimersByTimeAsync(10)

    // #then
    const request = vi.mocked(coordinator.onPermissionAsked).mock.calls[0]?.[0]
    expect(request?.permission).toBe('bash')
    expect(request?.title).toBe('Run command: rm -rf build')
    run.close()
    await vi.advanceTimersByTimeAsync(20_000)
  })

  it('forwards the authoritative reply for each request on its own', async () => {
    // #given
    const coordinator = makeCoordinator()
    const run = startRun({coordinator})
    await vi.advanceTimersByTimeAsync(10)
    run.emit(frames.permissionAsked('per_a'), frames.permissionAsked('per_b'))

    // #when — the replies differ, and arrive in the other order
    run.emit(frames.permissionReplied('per_b', 'reject'), frames.permissionReplied('per_a', 'always'))
    await vi.advanceTimersByTimeAsync(10)

    // #then
    expect(
      vi.mocked(coordinator.onPermissionReplied).mock.calls.map(([event]) => [event.requestID, event.reply]),
    ).toEqual([
      ['per_b', 'reject'],
      ['per_a', 'always'],
    ])
    run.close()
    await vi.advanceTimersByTimeAsync(20_000)
  })

  it('skips a reply value outside once, always and reject', async () => {
    // #given
    const coordinator = makeCoordinator()
    const run = startRun({coordinator})
    await vi.advanceTimersByTimeAsync(10)

    // #when
    run.emit({type: 'permission.replied', data: {sessionID: ROOT, requestID: 'per_a', reply: 'allow-forever'}})
    await vi.advanceTimersByTimeAsync(10)

    // #then
    expect(coordinator.onPermissionReplied).not.toHaveBeenCalled()
    run.close()
    await vi.advanceTimersByTimeAsync(20_000)
  })

  it("keeps a stranger's ask out of this run's approval flow", async () => {
    // #given
    const coordinator = makeCoordinator()
    const run = startRun({coordinator})
    await vi.advanceTimersByTimeAsync(10)

    // #when
    run.emit(frames.permissionAsked('per_x', STRANGER), frames.permissionReplied('per_x', 'once', STRANGER))
    await vi.advanceTimersByTimeAsync(10)

    // #then
    expect(coordinator.onPermissionAsked).not.toHaveBeenCalled()
    expect(coordinator.onPermissionReplied).not.toHaveBeenCalled()
    run.close()
    await vi.advanceTimersByTimeAsync(20_000)
  })

  it('does not await the coordinator, so a pending approval never starves the stream', async () => {
    // #given — an approval nobody has answered yet
    const coordinator = makeCoordinator()
    vi.mocked(coordinator.onPermissionAsked).mockReturnValue(new Promise(() => undefined))
    const run = startRun({coordinator})
    await vi.advanceTimersByTimeAsync(10)

    // #when
    run.emit(frames.permissionAsked('per_a'), frames.delta('still streaming'))
    await vi.advanceTimersByTimeAsync(10)

    // #then
    expect(run.sink.text()).toContain('still streaming')
    run.close()
    await vi.advanceTimersByTimeAsync(20_000)
  })
})

describe('the human-wait gauge', () => {
  it('pauses the inactivity watchdog while an approval is open and re-arms it when the last one is answered', async () => {
    // #given
    const onBusy = vi.fn()
    const run = startRun({inactivityTimeoutMs: 5_000, onBusy})
    await vi.advanceTimersByTimeAsync(10)

    // #when — two approvals stay open far longer than the inactivity window
    run.emit(frames.permissionAsked('per_a'), frames.permissionAsked('per_b'))
    await vi.advanceTimersByTimeAsync(60_000)

    // #then — still running, and not busy
    expect(run.outcome()).toBeUndefined()
    expect(onBusy).toHaveBeenLastCalledWith(false)

    // #when — one is answered, one is still open
    run.emit(frames.permissionReplied('per_a', 'once'))
    await vi.advanceTimersByTimeAsync(60_000)

    // #then — one open approval still holds the watchdog
    expect(run.outcome()).toBeUndefined()

    // #when — the last is answered, and the agent then goes quiet
    run.emit(frames.permissionReplied('per_b', 'once'))
    await vi.advanceTimersByTimeAsync(10)
    expect(onBusy).toHaveBeenLastCalledWith(true)
    await vi.advanceTimersByTimeAsync(6_000)
    await vi.advanceTimersByTimeAsync(20_000)

    // #then — the watchdog is armed again with a fresh window
    expect(failure(run).kind).toBe('inactivity-timeout')
  })

  it("releases a wait on the request gate's terminal notification, which has no server echo", async () => {
    // #given — a settlement that produces no echo (a deadline skip)
    let listener: TerminalListener | undefined
    const run = startRun({
      inactivityTimeoutMs: 5_000,
      onHumanWaitTerminal: l => {
        listener = l
        return () => {
          listener = undefined
        }
      },
    })
    await vi.advanceTimersByTimeAsync(10)
    run.emit(frames.permissionAsked('per_a'))
    await vi.advanceTimersByTimeAsync(30_000)
    expect(run.outcome()).toBeUndefined()

    // #when
    listener?.({requestID: 'per_a', sessionID: ROOT, family: 'approval', scopeId: 's', outcome: 'deadline'} as never)
    await vi.advanceTimersByTimeAsync(6_000)
    await vi.advanceTimersByTimeAsync(20_000)

    // #then — released, so the watchdog fires after its fresh window
    expect(failure(run).kind).toBe('inactivity-timeout')
  })

  it('unsubscribes from terminal notifications when the loop exits', async () => {
    // #given
    const unsubscribe = vi.fn()
    const run = startRun({onHumanWaitTerminal: () => unsubscribe})
    await vi.advanceTimersByTimeAsync(10)

    // #when
    run.emit(frames.succeeded())
    await vi.advanceTimersByTimeAsync(10)

    // #then
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('fail-closes the open approvals the moment the run fails', async () => {
    // #given — an approval is open when the stream is lost
    const coordinator = makeCoordinator()
    const questions = makeQuestions()
    const run = startRun({coordinator, questions})
    await vi.advanceTimersByTimeAsync(10)
    run.emit(frames.permissionAsked('per_a'))
    await vi.advanceTimersByTimeAsync(10)

    // #when
    run.failStream(new Error('lost'))
    await vi.advanceTimersByTimeAsync(20_000)

    // #then — disposed before the barrier's 15 s, so an `always` press cannot persist a rule meanwhile
    expect(coordinator.dispose).toHaveBeenCalledWith('run ended')
    expect(questions.dispose).toHaveBeenCalledWith('run ended')
  })
})

describe('question forms', () => {
  it('maps a question form onto the existing question flow and records it for the reply', async () => {
    // #given
    const questions = makeQuestions()
    const forms = createFormDirectoryV2()
    const run = startRun({questions, forms})
    await vi.advanceTimersByTimeAsync(10)

    // #when — the form the `question` tool asks (one field per question, keyed q0, q1, …)
    run.emit(frames.questionForm('frm_1'))
    await vi.advanceTimersByTimeAsync(10)

    // #then
    expect(questions.onAsked).toHaveBeenCalledWith({
      requestID: 'frm_1',
      sessionID: ROOT,
      questions: [
        {
          question: 'Pick?',
          header: 'Pick',
          options: [
            {label: 'A', description: 'a'},
            {label: 'B', description: 'b'},
          ],
          multiple: false,
          custom: true,
        },
      ],
    })
    expect(forms.lookup('frm_1')).toMatchObject({sessionId: ROOT, fields: [{key: 'q0', type: 'string'}]})
    expect(run.cancelForm).not.toHaveBeenCalled()
    run.close()
    await vi.advanceTimersByTimeAsync(20_000)
  })

  it('holds the inactivity watchdog while the question is open and forwards the answer as an echo', async () => {
    // #given
    const questions = makeQuestions()
    const run = startRun({questions, inactivityTimeoutMs: 5_000})
    await vi.advanceTimersByTimeAsync(10)
    run.emit(frames.questionForm('frm_1'))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(run.outcome()).toBeUndefined()

    // #when — the server echoes the reply, keyed by field
    run.emit(frames.formReplied('frm_1', {q0: 'B'}))
    await vi.advanceTimersByTimeAsync(10)

    // #then
    expect(questions.onEcho).toHaveBeenCalledWith({
      kind: 'replied',
      requestID: 'frm_1',
      sessionID: ROOT,
      answers: [['B']],
    })
    run.close()
    await vi.advanceTimersByTimeAsync(20_000)
  })

  it('forwards a cancelled question as a rejection', async () => {
    // #given
    const questions = makeQuestions()
    const run = startRun({questions})
    await vi.advanceTimersByTimeAsync(10)
    run.emit(frames.questionForm('frm_1'))
    await vi.advanceTimersByTimeAsync(10)

    // #when
    run.emit(frames.formCancelled('frm_1'))
    await vi.advanceTimersByTimeAsync(10)

    // #then
    expect(questions.onEcho).toHaveBeenCalledWith({kind: 'rejected', requestID: 'frm_1', sessionID: ROOT})
    run.close()
    await vi.advanceTimersByTimeAsync(20_000)
  })

  it('releases the wait itself when the coordinator skipped the question', async () => {
    // #given — no budget for a deadline: skipped, never registered, so no terminal event will come
    const questions = makeQuestions()
    vi.mocked(questions.onAsked).mockResolvedValue('skipped')
    const run = startRun({questions, inactivityTimeoutMs: 5_000})
    await vi.advanceTimersByTimeAsync(10)

    // #when
    run.emit(frames.questionForm('frm_1'))
    await vi.advanceTimersByTimeAsync(6_000)
    await vi.advanceTimersByTimeAsync(20_000)

    // #then — the watchdog was re-armed and fired
    expect(failure(run).kind).toBe('inactivity-timeout')
  })

  it('keeps going when the coordinator fails to register the question', async () => {
    // #given
    const questions = makeQuestions()
    vi.mocked(questions.onAsked).mockRejectedValue(new Error('registry down'))
    const run = startRun({questions})
    await vi.advanceTimersByTimeAsync(10)

    // #when
    run.emit(frames.questionForm('frm_1'), frames.delta('on'), frames.succeeded())
    await vi.advanceTimersByTimeAsync(10)

    // #then
    expect(succeeded(run)).toBe(true)
  })

  it('rejects a question form too large for the question flow so the asking turn ends now', async () => {
    // #given — more questions than one request may carry
    const questions = makeQuestions()
    const run = startRun({questions})
    await vi.advanceTimersByTimeAsync(10)
    const base = frames.questionForm('frm_big')
    const [field] = (base.data.form as unknown as {fields: unknown[]}).fields
    const tooBig = {...base, data: {form: {...base.data.form, fields: Array.from({length: 9}, () => field)}}}

    // #when
    run.emit(tooBig)
    await vi.advanceTimersByTimeAsync(10)

    // #then
    expect(questions.onMalformed).toHaveBeenCalledWith({requestID: 'frm_big', sessionID: ROOT, reason: 'oversize'})
    expect(questions.onAsked).not.toHaveBeenCalled()
    run.close()
    await vi.advanceTimersByTimeAsync(20_000)
  })

  it('cancels a question form with a message, not a hang, when no question handler is wired', async () => {
    // #given
    const run = startRun()
    await vi.advanceTimersByTimeAsync(10)

    // #when
    run.emit(frames.questionForm('frm_1'))
    await vi.advanceTimersByTimeAsync(10)

    // #then — the model's turn continues with a message instead of blocking until the deadline
    const input = vi.mocked(run.cancelForm).mock.calls[0]?.[0] as {sessionId: string; formId: string; message?: string}
    expect(input).toMatchObject({sessionId: ROOT, formId: 'frm_1'})
    expect(typeof input.message).toBe('string')
    run.close()
    await vi.advanceTimersByTimeAsync(20_000)
  })

  it('ignores a question form from a session it does not own, without cancelling it', async () => {
    // #given
    const questions = makeQuestions()
    const run = startRun({questions})
    await vi.advanceTimersByTimeAsync(10)

    // #when
    run.emit(frames.questionForm('frm_x', STRANGER))
    await vi.advanceTimersByTimeAsync(10)

    // #then
    expect(questions.onAsked).not.toHaveBeenCalled()
    expect(run.cancelForm).not.toHaveBeenCalled()
    run.close()
    await vi.advanceTimersByTimeAsync(20_000)
  })
})

describe('forms of any other kind', () => {
  it('cancels an unknown form kind with a message and shows the user a notice', async () => {
    // #given — an MCP-style form with no metadata.kind
    const onActivity = vi.fn()
    const questions = makeQuestions()
    const run = startRun({questions, onActivity})
    await vi.advanceTimersByTimeAsync(10)

    // #when
    run.emit(frames.unknownKindForm('frm_unknown'))
    await vi.advanceTimersByTimeAsync(10)

    // #then — cancelled with a message so the asking step continues, never forwarded as a question
    const input = vi.mocked(run.cancelForm).mock.calls[0]?.[0] as {sessionId: string; formId: string; message?: string}
    expect(input).toMatchObject({sessionId: ROOT, formId: 'frm_unknown'})
    expect(typeof input.message).toBe('string')
    expect(questions.onAsked).not.toHaveBeenCalled()
    expect(run.sink.text()).toContain('could not be shown here and was cancelled')
    expect(onActivity).toHaveBeenCalledWith(expect.stringContaining('cancelled'))
    run.close()
    await vi.advanceTimersByTimeAsync(20_000)
  })

  it("never copies the form's title or fields into the notice or the logs", async () => {
    // #given — the title and field names are plugin-controlled
    const run = startRun()
    await vi.advanceTimersByTimeAsync(10)

    // #when
    run.emit(frames.unknownKindForm('frm_unknown'))
    await vi.advanceTimersByTimeAsync(10)

    // #then
    expect(run.sink.text()).not.toContain('Sign in')
    expect(JSON.stringify(vi.mocked(run.logger.warn).mock.calls)).not.toContain('Sign in')
    run.close()
    await vi.advanceTimersByTimeAsync(20_000)
  })

  it('does not hold the watchdog for a form it cancelled', async () => {
    // #given
    const run = startRun({inactivityTimeoutMs: 5_000})
    await vi.advanceTimersByTimeAsync(10)

    // #when
    run.emit(frames.unknownKindForm('frm_unknown'))
    await vi.advanceTimersByTimeAsync(6_000)
    await vi.advanceTimersByTimeAsync(20_000)

    // #then
    expect(failure(run).kind).toBe('inactivity-timeout')
  })

  it('survives a form cancel that fails', async () => {
    // #given
    const run = startRun()
    run.cancelForm.mockRejectedValue(new Error('down'))
    await vi.advanceTimersByTimeAsync(10)

    // #when
    run.emit(frames.unknownKindForm('frm_unknown'), frames.delta('carry on'), frames.succeeded())
    await vi.advanceTimersByTimeAsync(10)

    // #then
    expect(succeeded(run)).toBe(true)
  })

  it('fails closed on a form it cannot read for an owned session', async () => {
    // #given — no fields: nothing to cancel by id would reach the asker either
    const run = startRun()
    await vi.advanceTimersByTimeAsync(10)

    // #when
    run.emit({type: 'form.created', data: {form: {id: 'frm_bad', sessionID: ROOT, title: 't'}}})
    await vi.advanceTimersByTimeAsync(20_000)

    // #then
    expect(failure(run).kind).toBe('session-error')
  })
})
