import type {OmoInstallOptions} from '../../services/setup/omo.js'

export const VALID_OMO_PROVIDERS = [
  'claude',
  'claude-max20',
  'copilot',
  'gemini',
  'openai',
  'opencode-zen',
  'zai-coding-plan',
  'kimi-for-coding',
] as const

export function parseOmoProviders(input: string): OmoInstallOptions {
  const providers = input
    .split(',')
    .map(p => p.trim().toLowerCase())
    .filter(p => p.length > 0)

  let claude: 'no' | 'yes' | 'max20' = 'no'
  let copilot: 'no' | 'yes' = 'no'
  let gemini: 'no' | 'yes' = 'no'
  let openai: 'no' | 'yes' = 'no'
  let opencodeZen: 'no' | 'yes' = 'no'
  let zaiCodingPlan: 'no' | 'yes' = 'no'
  let kimiForCoding: 'no' | 'yes' = 'no'

  for (const provider of providers) {
    if (!VALID_OMO_PROVIDERS.includes(provider as (typeof VALID_OMO_PROVIDERS)[number])) {
      continue
    }

    switch (provider) {
      case 'claude':
        claude = 'yes'
        break
      case 'claude-max20':
        claude = 'max20'
        break
      case 'copilot':
        copilot = 'yes'
        break
      case 'gemini':
        gemini = 'yes'
        break
      case 'openai':
        openai = 'yes'
        break
      case 'opencode-zen':
        opencodeZen = 'yes'
        break
      case 'zai-coding-plan':
        zaiCodingPlan = 'yes'
        break
      case 'kimi-for-coding':
        kimiForCoding = 'yes'
        break
    }
  }

  return {claude, copilot, gemini, openai, opencodeZen, zaiCodingPlan, kimiForCoding}
}
