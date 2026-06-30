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
      'docs/product/',
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
    name: 'deploy/scripts plain-Node-ESM overrides',
    files: ['deploy/scripts/**/*.mjs'],
    rules: {
      // deploy/scripts uses node --test runner, not vitest
      'vitest/no-import-node-test': 'off',
      // plain Node ESM scripts use process directly without importing it
      'node/prefer-global/process': 'off',
      // import ordering is not enforced in plain-Node-ESM scripts
      'perfectionist/sort-imports': 'off',
    },
  },
  {
    name: 'vitest overrides',
    files: ['**/*.test.ts', '**/*.spec.ts'],
    rules: {
      'vitest/expect-expect': ['error', {assertFunctionNames: ['expect', 'expect*', 'assert*']}],
      'vitest/prefer-lowercase-title': ['error', {ignore: ['describe']}],
    },
  },
  {
    // Phantom-dependency guard. The hoisted Bun linker resolves imports of
    // undeclared packages from the workspace root, so flag any import that is
    // declared in NO manifest. packageDir lists the root plus every workspace
    // package, so a dependency counts as declared if it appears in the root or
    // any package manifest — which matches how hoisted resolution actually
    // works (root deps like @aws-sdk/client-s3 are shared) while still catching
    // an import present in no package.json at all.
    name: 'phantom-dependency guard',
    files: ['**/*.ts'],
    rules: {
      'import-x/no-extraneous-dependencies': [
        'error',
        {
          // Keep this list in sync with the workspace packages in
          // package.json#workspaces. A missing entry produces false-positive
          // extraneous-dependency errors for that package's imports.
          packageDir: [
            import.meta.dirname,
            `${import.meta.dirname}/apps/action`,
            `${import.meta.dirname}/apps/workspace-agent`,
            `${import.meta.dirname}/packages/runtime`,
            `${import.meta.dirname}/packages/gateway`,
            `${import.meta.dirname}/packages/harness`,
          ],
          // devDependencies are legitimate in tests, test support, config, and
          // build scripts.
          devDependencies: [
            '**/*.test.ts',
            '**/*.spec.ts',
            '**/test-helpers.ts',
            '**/__fixtures__/**',
            '**/*.config.ts',
            'eslint.config.ts',
            'scripts/**',
            'packages/harness/scripts/**',
          ],
          peerDependencies: true,
        },
      ],
    },
  },
)
