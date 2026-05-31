# Fro Bot Agent — GitHub App

**Fro Bot Agent** is the GitHub App that lets a self-hosted [Fro Bot](https://github.com/fro-bot/agent) Discord gateway read a repository you choose, so you can drive Fro Bot against it from Discord.

- **App:** https://github.com/apps/fro-bot-agent
- **Owner:** the `fro-bot` GitHub account
- **Permission:** `contents: read` — read-only access to repository contents. Nothing else.
- **Webhook:** none. The app receives no events from GitHub.

## What it does

When you run `/fro-bot add-project <repo-url>` in a Discord server running a Fro Bot gateway, the gateway uses this app's installation to clone and read the repository you named. The read-only `contents` permission is the entire access surface — the app cannot write to your code, open pull requests, change settings, or read anything beyond repository contents.

## Permissions

| Permission          | Access   | Why                                                                    |
| ------------------- | -------- | ---------------------------------------------------------------------- |
| Repository contents | **Read** | Clone and read the repo you explicitly add via `/fro-bot add-project`. |

That is the complete list. The app requests no write scopes, no metadata beyond what `contents: read` implies, and no organization or account permissions.

## Privacy

The app is **inert unless you pair it with a Fro Bot gateway in your own Discord server**. Installing it grants read access; nothing happens until a gateway you control uses that access in response to a command you run.

- This repository collects no data and operates no hosted service. There is no telemetry.
- All credentials and runtime live in **your** gateway deployment, not here.
- The app has no webhook, so GitHub sends it no events and it stores nothing on GitHub's side.

## Install

1. Open https://github.com/apps/fro-bot-agent and click **Install** (or **Configure**).
2. Choose the account or organization that owns the repositories you want Fro Bot to read.
3. Select **Only select repositories** and pick the repos you intend to add — least privilege. (You can add more later.)

You only need to install on repositories you plan to use with `/fro-bot add-project`.

## Uninstall

Remove access at any time:

1. Go to **Settings → Applications → Installed GitHub Apps** (for your account) or your org's **Settings → GitHub Apps**.
2. Find **Fro Bot Agent** and click **Configure**.
3. Remove individual repositories, or scroll to **Uninstall** to revoke all access.

Uninstalling immediately revokes the gateway's ability to read your repositories.

## Running your own gateway

This app is only useful alongside a self-hosted gateway. To register your own app and wire credentials, see the [setup runbook](./github-app-setup.md).

## GitHub App settings copy

These values go in the App's **Basic Information** settings page (`fro-bot` account → Settings → Developer settings → GitHub Apps → Fro Bot Agent).

### Description (paste into "Basic Information → Description")

This field is displayed to users on the App's public page and renders markdown:

```markdown
**Fro Bot Agent** gives a self-hosted [Fro Bot](https://github.com/fro-bot/agent) Discord gateway read-only access to repositories you choose, so you can drive Fro Bot against them from Discord.

**Permission:** `contents: read` only — it can clone and read the repos you add, nothing else. No write access, no webhook.

**Privacy:** inert until you pair it with a Fro Bot gateway in your own Discord server. No data is collected and no hosted service runs on your behalf; all credentials live in your own deployment.

Add a repo from Discord with `/fro-bot add-project <repo-url>`.
```

### Adjacent fields

- **Homepage URL:** `https://github.com/fro-bot/agent`
- **Webhook → Active:** unchecked (the app needs no webhook)
- **Badge background color:** `0D0216` (the Void brand color — frames the cyan token on near-black)

### Short blurb (for any one-line listing)

> Read-only repo access for your self-hosted Fro Bot Discord gateway — no webhook, inert until you use it.
