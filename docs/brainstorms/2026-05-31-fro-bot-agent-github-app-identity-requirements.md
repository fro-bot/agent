# Fro Bot Agent GitHub App — In-Repo Identity Deliverables

- **Date:** 2026-05-31
- **Status:** ready-for-planning
- **Source:** issue #703 + Fro Bot triage
- **Scope:** Lightweight–Standard (docs + assets + one correctness fix)

## Problem

The "Fro Bot Agent" GitHub App is registered and owned by the `fro-bot` GitHub
user account, public at `https://github.com/apps/fro-bot-agent` (App ID
3918015), installed across `marcusrbrown` repos with `contents: read` only. The
runtime that consumes it (App auth, installation discovery, token minting for
`/fro-bot add-project`) already shipped in v0.45.0/v0.46.x. What's missing is the
**in-repo public identity**: docs, a creation/ownership runbook, an avatar, and
a correctness fix to the install-URL slug.

## Background (verified against current source)

- **Install-URL slug is wrong in code.** Ten literals hardcode
  `https://github.com/apps/fro-bot/installations/new` — a runtime default at
  `packages/gateway/src/config.ts:331`, a second default at
  `packages/gateway/src/github/app-client.ts:130`, and 6 test sites
  (`program.test.ts`, `config.test.ts`, `app-client.test.ts`,
  `discord/commands/add-project.test.ts` ×3, `discord/commands/index.test.ts`).
  The real app slug is **`fro-bot-agent`**. Today the "app not installed"
  message points operators at the wrong page.
- **Permission is correct** — `contents: 'read'` at
  `packages/gateway/src/github/app-client.ts:59`, verified on installation.
- **Both docs missing** — no `docs/github-app.md`, no `docs/github-app-setup.md`.
- **Ownership needs no transfer** — the `fro-bot` account already owns the app.
  The runbook documents existing reality, not a migration.

## Requirements

### R1 — Slug correctness fix (independent, ship-ready)
Replace `apps/fro-bot/installations/new` → `apps/fro-bot-agent/installations/new`
across all 10 sites (runtime defaults in `config.ts` + `app-client.ts`, and the 6
test literals — they must change together). Run `pnpm build` so `dist/` stays in
sync per AGENTS.md. This is a correctness fix and can land independently of the
identity deliverables.

### R2 — Public docs page (`docs/github-app.md`)
Plain markdown, GitHub-Pages-friendly (no build tooling). Covers: what the app
does; exact permission (`contents: read` only); privacy posture ("inert unless
paired with a Fro Bot gateway in your Discord server — no webhook, no data
collected by this repo"); install link
(`https://github.com/apps/fro-bot-agent`); how to uninstall; link to the setup
runbook. Includes the listing copy (R4) inline or adjacent.

### R3 — Setup / ownership runbook (`docs/github-app-setup.md`)
Operator-facing: how the app is registered (name "Fro Bot Agent",
`contents: read`, public, no webhook), that the `fro-bot` account owns it, how to
generate the private key, and **where credentials live** — the operator's own
gateway deployment env (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`), never
committed to this repo. Notes that GitHub does not live-reconcile app settings
from a repo file (no GitOps); this runbook is the source of truth for recreation.

### R4 — Listing copy
~150-char App description + a short tagline for the GitHub App listing page.
Trustworthy, plain, no hype. Lives in `docs/github-app.md`.

### R5 — Logo assets (DONE in brainstorm)
Simplified flat geometric mark derived from Fro Bot's head icon, anchored to
`assets/styleguide.md` palette. Delivered and verified:
- `assets/github-app-logo.svg` — primary "Cyber Token" (cyan→teal token, purple
  afro silhouette, white faceplate, dark visor, magenta+amber optics; glow
  filter removed and optics enlarged for 64px legibility).
- `assets/github-app-logo-alt.svg` — dark "Deep Space Neon" variant (kept for
  reference).
- `assets/github-app-logo-512.png` — 512×512 export (reproducible via
  `rsvg-convert -w 512 -h 512`).

## Non-Goals

- No ownership transfer (the `fro-bot` account already owns the app).
- No live GitOps / app-config reconciliation from the repo (GitHub doesn't
  support it).
- No committed manifest snapshot, no GitHub Pages automation, no Pages publish
  step (deferred — keep deliverables as plain static files).
- App registration itself is a human-only GitHub UI action, already done.

## Success Criteria

- The `/add-project` "app not installed" message links to
  `https://github.com/apps/fro-bot-agent/installations/new`; all slug literals
  consistent; `dist/` in sync; tests green.
- `docs/github-app.md` and `docs/github-app-setup.md` exist, plain markdown,
  accurate permission + privacy posture, correct slug + install/uninstall links.
- Logo assets committed; primary mark legible as a 64px circle on light and dark.

## Open Items for Planning

- Whether R1 (slug fix) ships as its own PR (unblocks the real install path now)
  or folds into the single identity PR. Either is fine; R1 is independently
  valid.
- Final avatar upload to the App settings is a manual step (documented in R3).
