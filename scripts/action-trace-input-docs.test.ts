import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'
import {parse} from 'yaml'

// The trace inputs' public descriptions say who receives the collector credential. Two senders hold it: the relay process
// (the run's trace) and the Action's own main and post steps (their lifecycle trace, sent directly). The OpenCode server and
// the plugin never receive it. A description that names only the relay misleads an operator deciding what to trust.
const ACTION_YAML_PATH = join(import.meta.dirname, '..', 'action.yaml')

interface ActionYamlSchema {
  readonly inputs?: Record<string, {readonly description?: string}>
}

const descriptionOf = (name: string): string => {
  const action = parse(readFileSync(ACTION_YAML_PATH, 'utf8')) as ActionYamlSchema
  const description = action.inputs?.[name]?.description
  if (description === undefined) throw new Error(`action.yaml has no description for ${name}`)
  return description
}

describe('action.yaml trace input descriptions', () => {
  it('says the credential also goes to the Action’s main and post steps, for their own lifecycle trace', () => {
    // #given the credential's description
    const description = descriptionOf('trace-headers')

    // #then it no longer claims the relay is the only holder, and names both direct senders
    expect(description).not.toContain('relay process only')
    expect(description).toMatch(/main and post steps/)
    expect(description).toMatch(/lifecycle trace/)
    expect(description).toMatch(/directly/)
  })

  it('keeps what it promised: the OpenCode server and the plugin never receive the credential', () => {
    // #given
    const description = descriptionOf('trace-headers')

    // #then
    expect(description).toMatch(/not passed to the OpenCode server or the plugin/)
  })

  it('keeps the isolate-agent caveat', () => {
    // #given
    const description = descriptionOf('trace-headers')

    // #then
    expect(description).toMatch(/With\s+`isolate-agent: true`\s+the agent cannot read them/)
    expect(description).toMatch(/Without it the agent runs as the same user as the Action and can\s+read them/)
  })

  it('tells the endpoint’s reader that the main and post steps send to it too', () => {
    // #given
    const description = descriptionOf('trace-endpoint')

    // #then
    expect(description).toMatch(/main and post steps/)
  })
})
