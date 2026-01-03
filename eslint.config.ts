import {defineConfig} from '@bfra.me/eslint-config'

export default defineConfig({
  name: '@bfra.me/github-action',
  ignores: ['.ai/', 'AGENTS.md', 'FEATURES.md', 'PRD.md', 'RFCs/', 'RULES.md', 'dist/**'],
  typescript: {
    tsconfigPath: './tsconfig.json',
  },
  vitest: true,
})
