# Fro Bot Agent — GitHub App Setup & Ownership Runbook

This runbook records how the **Fro Bot Agent** GitHub App is registered and owned, and how an operator wires its credentials into their own gateway. For the public, user-facing description of the app, see [github-app.md](./github-app.md).

> **Note on management:** GitHub does not reconcile App settings from a file in this repository — there is no GitOps for App configuration. This runbook is the source of truth for the App's intended configuration and for recreating it if needed.

## Canonical app

| Field              | Value                                                   |
| ------------------ | ------------------------------------------------------- |
| Name               | Fro Bot Agent                                           |
| Owner              | the `fro-bot` GitHub account                            |
| Public page / slug | https://github.com/apps/fro-bot-agent (`fro-bot-agent`) |
| Permission         | `contents: read` only                                   |
| Webhook            | none                                                    |
| Visibility         | Public (any account can install)                        |

The gateway's default install URL points at this slug (`packages/gateway/src/config.ts`). Operators pointing at a different app override it with `GATEWAY_GITHUB_APP_INSTALL_URL`.

## Registering the app (one-time, GitHub UI)

App registration is a manual action in the GitHub UI; it cannot be automated from this repo. The canonical app above is already registered under the `fro-bot` account. These steps are for recreating it or registering a separate app under another account.

1. Go to **GitHub → Settings → Developer settings → GitHub Apps → New GitHub App** (for the account that should own it).
2. **Name:** `Fro Bot Agent` (or your own name if registering a separate app).
3. **Homepage URL:** the gateway repo or your deployment docs.
4. **Webhook:** uncheck **Active** — the app needs no webhook.
5. **Permissions → Repository → Contents:** **Read-only**. Add nothing else.
6. **Where can this app be installed:** **Any account** (public) for the canonical app, or **Only on this account** for a private operator app.
7. **Create GitHub App.** Note the **App ID** on the settings page.
8. **Private keys → Generate a private key.** Save the downloaded `.pem` — this is the only copy.
9. (Optional) Upload the avatar from `assets/github-app-logo-512.png`.

## Where credentials live

Credentials belong to the **operator's own gateway deployment** — never committed to this repository.

| Credential        | Gateway env var          | Compose secret file                     |
| ----------------- | ------------------------ | --------------------------------------- |
| App ID            | `GITHUB_APP_ID`          | `deploy/secrets/github-app-id`          |
| Private key (PEM) | `GITHUB_APP_PRIVATE_KEY` | `deploy/secrets/github-app-private-key` |

The compose stack reads these via the `*_FILE` convention (`GITHUB_APP_ID_FILE`, `GITHUB_APP_PRIVATE_KEY_FILE`). See the **GitHub App** section of [`deploy/README.md`](../deploy/README.md) for the full secret-wiring walkthrough and upgrade notes.

## Installing on repositories

Install the app on only the repositories Fro Bot should read (least privilege), then add them from Discord with `/fro-bot add-project <repo-url>`. See [github-app.md](./github-app.md) for install/uninstall details.
