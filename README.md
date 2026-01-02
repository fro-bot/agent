# TypeScript GitHub Action Template

[![CI](https://img.shields.io/github/actions/workflow/status/bfra-me/github-action/ci.yaml?branch=main&style=for-the-badge&logo=github-actions&logoColor=white&label=ci)](https://github.com/bfra-me/github-action/actions?query=workflow%3Aci) [![TypeScript](https://img.shields.io/badge/TypeScript-blue?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org) [![License](https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge)](LICENSE)

> A production-ready TypeScript template for creating GitHub Actions with modern tooling and best practices.

This template provides everything you need to build, test, and publish TypeScript-based GitHub Actions. It includes comprehensive tooling for development, testing, linting, and automated publishing workflows.

## Features

- **TypeScript First** - Full TypeScript support with strict type checking
- **Modern Tooling** - ESLint, Prettier, and Vitest for development workflow
- **Automated Building** - Uses `tsup` for fast, optimized bundling
- **Comprehensive Testing** - Unit tests with Vitest and integration testing setup
- **CI/CD Ready** - GitHub Actions workflow for testing and validation
- **Zero Dependencies Runtime** - Only uses `@actions/core` for minimal footprint

## Quick Start

### 1. Use This Template

Click **"Use this template"** to create a new repository from this template, or clone it directly:

```bash
git clone https://github.com/bfra-me/github-action.git my-action
cd my-action
```

### 2. Install Dependencies

```bash
pnpm install
```

### 3. Customize Your Action

Update `action.yaml` with your action's metadata:

```yaml
name: Your Action Name
description: Your action description
author: Your Name
inputs:
  your-input:
    description: Input description
    required: true
    default: default value
outputs:
  your-output:
    description: Output description
runs:
  using: node20
  main: dist/index.js
```

### 4. Implement Your Logic

Replace the example code in `src/main.ts`:

```javascript
import * as core from '@actions/core'

async function run() {
  try {
    const input = core.getInput('your-input')

    // Your action logic here
    const result = `Processed: ${input}`

    core.setOutput('your-output', result)
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message)
    }
  }
}

await run()
```

## Development

### Building

```bash
# Development build
pnpm run build

# Production build with minification
pnpm run build-release
```

### Testing

```bash
# Run all tests
pnpm test

# Type checking
pnpm run check-types

# Linting
pnpm run lint

# Auto-fix linting issues
pnpm run fix
```

### Local Testing

Test your action locally by setting environment variables and running the built code:

```bash
# Build the action
pnpm run build

# Set input environment variables
export INPUT_MILLISECONDS=1000

# Run the action
node dist/index.js
```

## Example Usage

Once published, your action can be used in workflows like this:

```yaml
name: Example Workflow
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Run Custom Action
        uses: your-username/your-action@v1
        with:
          milliseconds: 2000
```

## Publishing Your Action

### 1. Update Package Metadata

Update `package.json` with your action's information:

```json
{
  "name": "your-action-name",
  "description": "Your action description",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/your-username/your-action.git"
  }
}
```

### 2. Build and Commit Distribution

```bash
# Build for production
pnpm run build-release

# Commit the dist folder
git add dist/
git commit -m "Add distribution files"
git push
```

### 3. Create a Release

```bash
# Tag your release
git tag -a v1.0.0 -m "Initial release"
git push origin v1.0.0

# Create major version tag for easier referencing
git tag -a v1 -m "Version 1"
git push origin v1
```

> [!TIP]
>
> Users can reference your action using `@v1` for the latest v1.x.x release, or `@v1.0.0` for a specific version.

## Project Structure

```text
├── src/
│   ├── main.ts          # Main action entry point
│   └── wait.ts          # Example utility function
├── __tests__/
│   └── main.test.ts     # Test files
├── dist/               # Built distribution files (auto-generated)
├── action.yaml         # Action metadata
├── package.json        # Node.js dependencies and scripts
├── tsconfig.json       # TypeScript configuration
├── tsup.config.ts      # Build configuration
└── eslint.config.ts    # ESLint configuration
```

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make your changes and add tests
4. Run the test suite: `pnpm test`
5. Commit your changes: `git commit -m "Add my feature"`
6. Push to the branch: `git push origin feature/my-feature`
7. Submit a pull request

## Example Action (Included)

This template includes a simple example action that waits for a specified number of milliseconds. This demonstrates:

- Input handling with `@actions/core`
- Async operations
- Output setting
- Error handling
- TypeScript best practices

You can test it immediately:

```yaml
- name: Wait Example
  uses: ./
  with:
    milliseconds: 1000
```
