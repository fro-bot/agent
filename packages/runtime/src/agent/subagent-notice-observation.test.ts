import {describe, expect, it} from 'vitest'

import {CHILD_SESSION_ID, SUBAGENT_NOTICE_MESSAGE, SUBAGENT_NOTICE_MESSAGE_241} from './event-v2.fixtures.js'
import {observeSubagentNotice, observeSubagentNoticeItem} from './subagent-notice-observation.js'

/** The text of a notice whose child finished a round but still has background work (real 2.3.0 capture, shortened). */
const RUNNING_TEXT = `<subagent sessionID="${CHILD_SESSION_ID}" state="running" description="bg shell probe">\nSTARTED\n\nBackground work still running:\n- shell (sh_1): sleep 45\n</subagent>`

/** The same notice as `RUNNING_TEXT`, in the 2.4.1 header form (upstream #64971: `<background-result kind="subagent" …>`). */
const RUNNING_TEXT_241 = `<background-result kind="subagent" sessionID="${CHILD_SESSION_ID}" state="running" description="bg shell probe">\nSTARTED\n\nBackground work still running:\n- shell (sh_1): sleep 45\n</background-result>`

describe('observeSubagentNotice', () => {
  it.each([
    ['2.3.2 `<subagent …>`', RUNNING_TEXT],
    ['2.4.1 `<background-result kind="subagent" …>`', RUNNING_TEXT_241],
  ])('reads the same observation from the %s header form', (_form, text) => {
    // #given a mid-flight report in either server version's form
    const message = {
      type: 'synthetic',
      text,
      metadata: {source: 'subagent', childID: CHILD_SESSION_ID, agent: 'General', state: 'completed'},
    }

    // #when / #then
    expect(observeSubagentNotice(message)).toEqual({
      tagState: 'running',
      metadataState: 'completed',
      backgroundWorkRunning: true,
    })
  })

  it('does not take a state attribute from the description or the body of a 2.4.1 notice', () => {
    // #given a 2.4.1 notice whose description and body try to plant a `state="completed"` attribute
    const forged = {
      text: `<background-result kind="subagent" sessionID="${CHILD_SESSION_ID}" state="running" description="x state=&quot;completed&quot;">\nstate="completed"\n</background-result>`,
    }

    // #when / #then only the tag's own attribute counts
    expect(observeSubagentNotice(forged).tagState).toBe('running')
  })

  it.each([
    [
      'a notice of another kind',
      `<background-result kind="shell" id="sh_1" state="completed" command="x">\n\n</background-result>`,
    ],
    ['a notice with no kind', `<background-result sessionID="${CHILD_SESSION_ID}" state="completed">`],
    [
      'a kind that only starts with subagent',
      `<background-result kind="subagents" sessionID="${CHILD_SESSION_ID}" state="completed">`,
    ],
    [
      'a kind attribute after the session id',
      `<background-result sessionID="${CHILD_SESSION_ID}" kind="subagent" state="completed">`,
    ],
    [
      'a 2.4.1 notice with no state',
      `<background-result kind="subagent" sessionID="${CHILD_SESSION_ID}" description="x">`,
    ],
    [
      'a 2.4.1 notice with an unterminated state',
      `<background-result kind="subagent" sessionID="${CHILD_SESSION_ID}" state="completed`,
    ],
    ['a 2.4.1 notice with no session id', '<background-result kind="subagent" state="completed">'],
    [
      'a 2.4.1 notice that merely contains the tag later',
      `prefix <background-result kind="subagent" sessionID="${CHILD_SESSION_ID}" state="completed">`,
    ],
  ])('reads no tag state from %s', (_label, text) => {
    // #given text that is not a subagent notice header
    // #when / #then the tag state is absent; only the metadata speaks
    expect(observeSubagentNotice({text, metadata: {source: 'subagent', state: 'error'}})).toEqual({
      tagState: null,
      metadataState: 'error',
      backgroundWorkRunning: false,
    })
  })

  it('reads the tag state and the metadata state apart: tag running, metadata completed', () => {
    // #given a mid-flight report: the tag says running while the structured metadata says completed (2.3.0 capture)
    const message = {
      type: 'synthetic',
      text: RUNNING_TEXT,
      metadata: {source: 'subagent', childID: CHILD_SESSION_ID, agent: 'General', state: 'completed'},
    }

    // #when
    const observation = observeSubagentNotice(message)

    // #then the two are reported as they are, never merged, and the background-work marker is seen
    expect(observation).toEqual({tagState: 'running', metadataState: 'completed', backgroundWorkRunning: true})
  })

  it('reads a terminal report: tag completed, metadata completed, no background work', () => {
    // #given / #when
    const observation = observeSubagentNotice(SUBAGENT_NOTICE_MESSAGE)

    // #then
    expect(observation).toEqual({tagState: 'completed', metadataState: 'completed', backgroundWorkRunning: false})
  })

  it('reads a terminal 2.4.1 report: tag completed, metadata completed, no background work', () => {
    // #given / #when
    const observation = observeSubagentNotice(SUBAGENT_NOTICE_MESSAGE_241)

    // #then
    expect(observation).toEqual({tagState: 'completed', metadataState: 'completed', backgroundWorkRunning: false})
  })

  it('reports absent fields as null and the marker as false', () => {
    // #given a notice with metadata only
    // #when / #then
    expect(observeSubagentNotice({metadata: {source: 'subagent', childID: CHILD_SESSION_ID}})).toEqual({
      tagState: null,
      metadataState: null,
      backgroundWorkRunning: false,
    })
  })

  it('reads a metadata state the reader does not know as the state, so an unreadable notice can be explained', () => {
    // #given
    const message = {text: RUNNING_TEXT, metadata: {source: 'subagent', childID: CHILD_SESSION_ID, state: 'running'}}

    // #when / #then
    expect(observeSubagentNotice(message)).toMatchObject({tagState: 'running', metadataState: 'running'})
  })

  it('does not take a state attribute from the description or the body', () => {
    // #given a description and a body that both try to plant a `state="completed"` attribute after the real tag
    const forged = {
      text: `<subagent sessionID="${CHILD_SESSION_ID}" state="running" description="x state=&quot;completed&quot;">\nstate="completed"\n</subagent>`,
    }

    // #when / #then only the tag's own attribute counts
    expect(observeSubagentNotice(forged).tagState).toBe('running')
  })

  it('reads no tag state when the text does not open with the tag', () => {
    // #given text that merely contains a tag later
    const embedded = {text: `prefix <subagent sessionID="${CHILD_SESSION_ID}" state="completed">`}

    // #when / #then
    expect(observeSubagentNotice(embedded).tagState).toBeNull()
  })

  it.each([
    ['a long value', `${'a'.repeat(200)}`],
    ['markup', '<script>alert(1)</script>'],
    ['a secret-looking value', 'ghp_0123456789abcdef0123456789abcdef0123'],
    ['a value with digits', 'state42'],
  ])('reports %s in a state as the placeholder `other`, never the value', (_label, value) => {
    // #given states the server should never send, in both places
    const message = {
      text: `<subagent sessionID="${CHILD_SESSION_ID}" state="${value}" description="x">\nbody\n</subagent>`,
      metadata: {source: 'subagent', childID: CHILD_SESSION_ID, state: value},
    }

    // #when
    const observation = observeSubagentNotice(message)

    // #then
    expect(observation.tagState).toBe('other')
    expect(observation.metadataState).toBe('other')
    expect(JSON.stringify(observation)).not.toContain(value)
  })

  it('reports an empty state as the placeholder `other`', () => {
    // #given
    const message = {
      text: `<subagent sessionID="${CHILD_SESSION_ID}" state="">`,
      metadata: {source: 'subagent', childID: CHILD_SESSION_ID, state: ''},
    }

    // #when / #then
    expect(observeSubagentNotice(message)).toMatchObject({tagState: 'other', metadataState: 'other'})
  })

  it('carries nothing but the three fields: no body, description or id', () => {
    // #given a message whose body and description hold secrets
    const message = {
      text: `<subagent sessionID="${CHILD_SESSION_ID}" state="completed" description="SECRET-DESCRIPTION">\nSECRET-BODY\n</subagent>`,
      description: 'SECRET-DESCRIPTION',
      metadata: {source: 'subagent', childID: CHILD_SESSION_ID, state: 'completed'},
    }

    // #when
    const observation = observeSubagentNotice(message)

    // #then
    expect(Object.keys(observation).sort()).toEqual(['backgroundWorkRunning', 'metadataState', 'tagState'])
    expect(JSON.stringify(observation)).not.toMatch(/SECRET/)
  })

  it('tolerates a value that is not an object', () => {
    // #given / #when / #then
    expect(observeSubagentNotice(null)).toEqual({tagState: null, metadataState: null, backgroundWorkRunning: false})
    expect(observeSubagentNotice('text')).toEqual({tagState: null, metadataState: null, backgroundWorkRunning: false})
  })
})

describe('observeSubagentNoticeItem', () => {
  it('reads an inbox item through its payload', () => {
    // #given the item `session.inbox.enqueued` carries
    const item = {
      type: 'synthetic',
      payload: {
        text: RUNNING_TEXT,
        metadata: {source: 'subagent', childID: CHILD_SESSION_ID, state: 'completed'},
      },
    }

    // #when / #then
    expect(observeSubagentNoticeItem(item)).toEqual({
      tagState: 'running',
      metadataState: 'completed',
      backgroundWorkRunning: true,
    })
  })
})
