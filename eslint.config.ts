import {defineConfig} from '@bfra.me/eslint-config'

export default defineConfig(
  {
    name: '@bfra.me/github-action',
    ignores: [
      '.agents/skills/',
      '.ai/',
      '.github/copilot-*.md',
      '**/AGENTS.md',
      '**/.obsidian/',
      'FEATURES.md',
      'PRD.md',
      'RFCs/',
      'RFCS.md',
      'RULES.md',
      'dist/**',
      'docs/brainstorms/',
      'docs/ideation/',
      'docs/plans/',
      'docs/solutions/',
    ],
    typescript: {
      tsconfigPath: './tsconfig.json',
    },
    vitest: true,
  },
  {
    name: 'wiki markdown overrides',
    files: ['docs/wiki/**/*.md'],
    rules: {
      'markdown/no-missing-label-refs': 'off',
    },
  },
  {
    name: 'vitest overrides',
    files: ['**/*.test.ts', '**/*.spec.ts'],
    rules: {
      'vitest/prefer-lowercase-title': ['error', {ignore: ['describe']}],
    },
  },
)
