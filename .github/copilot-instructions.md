# GitHub Action Development Guide

This repository is a TypeScript GitHub Action template designed for creating production-ready actions with modern tooling.

## Core Architecture

- **Entry Point**: `src/main.ts` is the action's entry point, must export an async `run()` function
- **Build Target**: Actions compile to `dist/index.js` (single bundle) using tsup with ESM format
- **Runtime**: Node 20 with `@actions/core` as the only runtime dependency
- **Action Metadata**: `action.yaml` defines inputs/outputs - GitHub requires this exact filename

## Development Patterns

### Action Structure
```typescript
// src/main.ts - Follow this exact pattern
import * as core from '@actions/core'

async function run(): Promise<void> {
  try {
    const input = core.getInput('input-name')
    core.debug('Debug messages only show with ACTIONS_STEP_DEBUG=true')

    // Your logic here
    core.setOutput('output-name', result)
  } catch (error) {
    if (error instanceof Error) core.setFailed(error.message)
  }
}

await run() // Top-level await required
```

### Testing Approach
- Use Vitest for all tests (`__tests__/*.test.ts`)
- Test pattern: Unit tests for utilities, integration test for main action
- Local testing: Set `INPUT_*` env vars and run `node dist/index.js`
- CI testing: The action tests itself in `.github/workflows/ci.yaml`

### Build System (tsup)
- `pnpm run build`: Development build
- `pnpm run build-release`: Production build with minification
- **Critical**: Must commit `dist/` folder - GitHub runs actions from this
- ESM banner injection handles Node.js require() compatibility
- License generation creates `licenses.txt` automatically

## Specific Conventions

### Package Manager
- **Always use pnpm** - this org uses pnpm workspaces and specific configs
- `pnpm bootstrap` installs with offline preference and quiet logging
- Pre-commit hooks run `lint-staged` for formatting

### ESLint Configuration
- Uses `@bfra.me/eslint-config` with Vitest plugin enabled
- Ignores `dist/**` and `**/*.test.ts` files
- Auto-fix with `pnpm run fix`

### Publishing Workflow
1. Update `package.json` metadata (name, description, repository)
2. `pnpm run build-release && git add dist/`
3. Tag with both specific (`v1.0.0`) and major (`v1`) version tags
4. Users reference actions with `@v1` for latest minor/patch updates

## Key Files to Modify

- `action.yaml`: Action metadata (name, description, inputs, outputs)
- `src/main.ts`: Core action logic
- `package.json`: Action name and description for marketplace
- `README.md`: Update usage examples and replace template content

## Local Development Commands

```bash
pnpm bootstrap              # Install dependencies (preferred over install)
pnpm run build             # Build for development
pnpm run test              # Run all tests
pnpm run check-types       # TypeScript type checking
export INPUT_MILLISECONDS=1000 && node dist/index.js  # Test locally
```
