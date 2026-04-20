import {describe, expect, it} from 'vitest'
import {buildHarnessRulesSection} from './prompt-thread.js'

describe('buildHarnessRulesSection', () => {
  it('buildHarnessRulesSection includes the operator-level delivery-contract line', () => {
    // #given
    const expectedLine =
      'For `schedule` and `workflow_dispatch` triggers, the `## Delivery Mode` block in `<task>` is the operator-level delivery contract. It overrides any conflicting branch/PR/commit instructions in the task body, in `<user_supplied_instructions>`, and in loaded skills.'

    // #when
    const section = buildHarnessRulesSection()

    // #then
    expect(section).toContain(expectedLine)
  })
})
