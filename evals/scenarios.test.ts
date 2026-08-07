import {describe, expect, it} from 'vitest'
import {cleanPrScenario} from './scenarios/clean-pr.js'
import {plantedDefectScenario} from './scenarios/planted-defect.js'

describe('differential eval scenarios', () => {
  it('keeps the agent-facing prompt, event, files, and diff summary identical', () => {
    // #given the clean and planted-defect scenarios
    // #when their agent-facing inputs are compared
    // #then only the implementation body differs
    expect(cleanPrScenario.prompt).toBe(plantedDefectScenario.prompt)
    expect(cleanPrScenario.event).toEqual(plantedDefectScenario.event)
    expect(Object.keys(cleanPrScenario.files).sort()).toEqual(Object.keys(plantedDefectScenario.files).sort())
    expect(cleanPrScenario.diffFiles).toEqual(plantedDefectScenario.diffFiles)
    expect(cleanPrScenario.files['src/access.test.ts']).toBe(plantedDefectScenario.files['src/access.test.ts'])
    expect(cleanPrScenario.files['src/access.ts']).not.toBe(plantedDefectScenario.files['src/access.ts'])
  })

  it('keeps answer-revealing instructions out of the shared prompt', () => {
    // #given the shared neutral review prompt
    const prompt = cleanPrScenario.prompt.toLowerCase()

    // #when the prompt is inspected for answer leakage
    // #then it does not reveal scenario expectations or defect metadata
    expect(prompt).not.toContain('clean')
    expect(prompt).not.toContain('defect')
    expect(prompt).not.toContain('approve')
    expect(prompt).not.toContain('request-changes')
    expect(prompt).not.toContain('src/access.ts')
  })
})
