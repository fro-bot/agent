# Copilot Coding Agent: MCP & Firewall Configuration

These settings are configured via the GitHub repo Settings UI, not files. Apply them **after merging** the setup-steps and hooks changes to the default branch.

## Step 1: Context7 MCP Server

**Location:** Repo Settings → Code & automation → Copilot → Coding agent → MCP configuration

Paste this JSON:

```json
{
  "mcpServers": {
    "context7": {
      "type": "local",
      "command": "npx",
      "args": ["-y", "@upstash/context7-mcp@latest"],
      "tools": ["resolve-library-id", "get-library-docs"]
    }
  }
}
```

### Context7 Library IDs (pre-resolved)

These are already documented in AGENTS.md for reference:

| Library                | Context7 ID        |
| ---------------------- | ------------------ |
| GitHub Actions Toolkit | /actions/toolkit   |
| GitHub Actions Cache   | /actions/cache     |
| Vitest                 | /vitest-dev/vitest |
| tsdown                 | /rolldown/tsdown   |
| OpenCode SDK           | /sst/opencode-sdk-js |

## Step 2: Firewall Allowlist

**Location:** Repo Settings → Code & automation → Copilot → Coding agent → Firewall

Context7 MCP makes outbound HTTP requests to fetch documentation. Add these to the firewall allowlist:

```text
registry.npmjs.org:443
context7.com:443
```

> **Note:** `registry.npmjs.org` is likely already allowed by the default Copilot firewall for dependency installation. The Context7 API endpoint is `context7.com` ([source](https://github.com/upstash/context7/blob/main/packages/mcp/src/lib/constants.ts)).

## Step 3: Copilot Environment (if needed)

If Context7 requires an API key in the future:

1. Go to Repo Settings → Environments → Create environment named `copilot`
2. Add secret with name `COPILOT_MCP_CONTEXT7_API_KEY` (must have `COPILOT_MCP_` prefix)
3. Update the MCP config to reference it:

```json
{
  "mcpServers": {
    "context7": {
      "type": "local",
      "command": "npx",
      "args": ["-y", "@upstash/context7-mcp@latest"],
      "env": {
        "CONTEXT7_API_KEY": "${{ COPILOT_MCP_CONTEXT7_API_KEY }}"
      },
      "tools": ["resolve-library-id", "get-library-docs"]
    }
  }
}
```

## Verification

After applying settings, trigger Copilot on an issue or PR and check:

1. Session logs show Context7 MCP server starting
2. The `resolve-library-id` and `get-library-docs` tools appear in the tool list
3. No firewall-blocked connection errors in logs
