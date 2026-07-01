# Contributing

Thanks for contributing to `fro-bot/agent`. This document covers the contributor workflow — setup, the command surface, testing, and commit conventions. For how the system is built and where code lives, read these first:

- **[ARCHITECTURE.md](ARCHITECTURE.md)** — system design, invariants, the three data flows, cross-cutting concerns.
- **[STRUCTURE.md](STRUCTURE.md)** — directory layout, key file locations, where to add new code.
- **[AGENTS.md](AGENTS.md)** — conventions, anti-patterns, and the command reference in one operational page.

## Prerequisites

- **[Bun](https://bun.sh/)** — the package manager and test runner for this monorepo.
- **Node 24** — matches the `action.yaml` runtime; the bundled Action and `deploy/scripts/` both target it.

## Setup

```bash
bun install
```

This installs workspace dependencies and registers the git hooks (via `simple-git-hooks`).

## Command Surface

```bash
bun run test          # Run the workspace package test suites (Vitest)
bun run test:scripts  # Run the repo-root scripts/ test suite (Vitest)
bun run lint          # ESLint check (also scans committed dist/ for hidden Unicode)
bun run fix           # ESLint auto-fix
bun run check-types   # TypeScript type check (tsc --noEmit)
bun run build         # Type-check + bundle to dist/ (dist/ is committed and must stay in sync)
```

`bun run build` regenerates the committed `dist/`. Never edit `dist/` by hand — CI fails if a fresh build produces a diff. See [ARCHITECTURE.md](ARCHITECTURE.md) for why `dist/` is committed.

## Testing

- **Vitest** for the workspace; test files are colocated as `<name>.test.ts` next to the code they cover.
- **BDD comments** mark the phases of each test: `// #given`, `// #when`, `// #then`.
- **`deploy/scripts/`** is a carve-out: plain Node ESM (`.mjs`) run with the built-in `node --test` runner, not Vitest. It is exercised in CI by the `workspace-smoke` job.
- Write the test alongside the change in the same PR; behavior changes need a test that pins the new behavior.

## Type Safety

Type suppression is forbidden project-wide — no `as any`, `@ts-ignore`, or `@ts-expect-error`. See [AGENTS.md](AGENTS.md) for the full convention and anti-pattern list.

## Commits

Follow [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): description`.

- **Types:** `feat`, `fix`, `docs`, `refactor`, `test`, `build`, `ci`, `style`, `perf`, `revert`, `chore`.
- Releases are automated from commit history via semantic-release, so an accurate `type` matters — `feat` and `fix` drive version bumps.

Example: `feat(setup): add --skip-auth flag`.

## Git Hooks

Hooks are installed automatically on `bun install`:

- **pre-commit** — runs `lint-staged` (ESLint `--fix` on staged files).
- **pre-push** — runs `bun run lint && bun run build`, including the committed-`dist/` sync check.

Run `bun run lint && bun run build` yourself before pushing to catch failures early.

## Pull Requests

- Keep changes minimal and reversible; minimize blast radius.
- Update tests and `README.md` when inputs or public behavior change.
- Ensure `bun run lint` and `bun run build` are clean and `dist/` is in sync before opening the PR.
