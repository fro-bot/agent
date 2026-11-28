/** The CI pipeline run attributes (fro-bot/agent#2403). */

import {describe, expect, it} from 'vitest'

import {chat, exported, invoke, rewritingScrubber, tool} from './genai-attributes.testing.js'

describe('the CI pipeline run', () => {
  const identity = {repository: 'fro-bot/agent', runId: '4242', attempt: '2', job: 'fro-bot', trigger: 'issue_comment'}
  const SERVER = 'https://github.com'

  it('sets the run id on every span that carries the run id metadata', () => {
    // #given each kind of span in an Action run
    for (const record of [chat(), tool(), invoke()]) {
      const span = exported(record, {identity, serverUrl: SERVER})

      // #then cicd.pipeline.run.id sits wherever langfuse.trace.metadata.run_id does, and says the same
      expect(span.attributes['langfuse.trace.metadata.run_id']).toBe('4242')
      expect(span.attributes['cicd.pipeline.run.id']).toBe('4242')
    }
  })

  it('builds the run URL of a re-run in GitHub’s form: <server>/<repository>/actions/runs/<id>/attempts/<n>', () => {
    // #given
    const span = exported(invoke(), {identity, serverUrl: SERVER})

    // #then
    expect(span.attributes['cicd.pipeline.run.url.full']).toBe(
      'https://github.com/fro-bot/agent/actions/runs/4242/attempts/2',
    )
  })

  it('builds the run URL of the first attempt without an attempts part, as GitHub’s own html_url has it', () => {
    // #given the first attempt, on an enterprise server with a port
    const span = exported(invoke(), {identity: {...identity, attempt: '1'}, serverUrl: 'https://ghe.example.com:8443'})

    // #then
    expect(span.attributes['cicd.pipeline.run.url.full']).toBe(
      'https://ghe.example.com:8443/fro-bot/agent/actions/runs/4242',
    )
  })

  it('sets the id but not the URL when the launcher gave no server', () => {
    // #given a launcher document from before the field existed
    const span = exported(invoke(), {identity})

    // #then
    expect(span.attributes['cicd.pipeline.run.id']).toBe('4242')
    expect('cicd.pipeline.run.url.full' in span.attributes).toBe(false)
  })

  it.each([
    ['a repository with a path in it', {repository: 'fro-bot/agent/../../x'}],
    ['a repository with no owner', {repository: 'agent'}],
    ['a repository with a query', {repository: 'fro-bot/agent?x=1'}],
    ['a run id that is not a number', {runId: '42/../1'}],
    ['an attempt that is not a number', {attempt: '2#frag'}],
  ])('sets no URL for %s, since it would not name a run', (_label, override) => {
    // #given an identity the URL cannot be built from safely
    const span = exported(invoke(), {identity: {...identity, ...override}, serverUrl: SERVER})

    // #then
    expect('cicd.pipeline.run.url.full' in span.attributes).toBe(false)
  })

  it('sets nothing in local mode, where there is no run', () => {
    // #given no identity
    const span = exported(invoke(), {serverUrl: SERVER})

    // #then
    expect('cicd.pipeline.run.id' in span.attributes).toBe(false)
    expect('cicd.pipeline.run.url.full' in span.attributes).toBe(false)
  })

  it('goes through the scrub like every other attribute', () => {
    // #given a scrubber that rewrites every string

    // #when
    const span = exported(invoke(), {identity, serverUrl: SERVER}, rewritingScrubber)

    // #then neither value is exported as it was built
    expect(span.attributes['cicd.pipeline.run.id']).toBe('[REDACTED:4]')
    expect(String(span.attributes['cicd.pipeline.run.url.full']).startsWith('[REDACTED:')).toBe(true)
  })
})
