# Security Policy

## Reporting a Vulnerability

Please report security vulnerabilities privately — do not open a public issue for a suspected vulnerability.

- Use [GitHub's private vulnerability reporting](https://github.com/fro-bot/agent/security/advisories/new) to open a confidential advisory, **or**
- Email **contact@marcusrbrown.com** with the details.

Include a description of the issue, the affected component (the Action, `@fro-bot/gateway`, `@fro.bot/harness`, or a workspace container), and reproduction steps or a proof of concept where possible. You will receive an acknowledgement, and fixes for confirmed issues are coordinated privately before disclosure.

## Supported Versions

This project follows continuous delivery from `main` via semantic-release; fixes land in the latest release. Only the most recent release line receives security updates.

| Version        | Supported |
| -------------- | --------- |
| Latest release | ✅        |
| Older releases | ❌        |

## Security Posture

This is a security-sensitive CI runtime. Credential handling, log redaction, and authorization gating are non-negotiable invariants, not conveniences:

- Secrets are never logged or committed; the injected logger redacts sensitive values.
- Authorization gating restricts agent invocation to trusted actors; bots and fork PRs are blocked from privileged paths.
- The gateway workspace runs in a sandboxed container whose egress is confined to an allowlist through a mitmproxy.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the redaction gate, the fork-PR authorization model, and the workspace egress topology.

The project's supply-chain and security posture is tracked publicly via [OpenSSF Scorecard](https://securityscorecards.dev/viewer/?uri=github.com/fro-bot/agent).
