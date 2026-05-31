# syntax=docker/dockerfile:1@sha256:87999aa3d42bdc6bea60565083ee17e86d1f3339802f543c0d03998580f9cb89

# Workspace agent container.
#
# Currently a minimal idle container. The full image build — OpenCode CLI
# (pinned 1.14.41), oMo, the @fro.bot/systematic plugin, and the mitmproxy CA
# for outbound TLS interception — is not yet wired here.
#
# Port model:
#   - 9100 (Hono API: /healthz, /clone) — sandbox-net reachable
#   - 9200 (OpenCode bearer-token proxy) — sandbox-net reachable (gateway attaches here)
#   - 54321 (raw OpenCode SDK server) — loopback (127.0.0.1) ONLY, never exposed

FROM node:24.16.0-alpine@sha256:2bdb65ed1dab192432bc31c95f94155ca5ad7fc1392fb7eb7526ab682fa5bf14

CMD ["sh", "-c", "echo 'workspace container (idle)'; sleep infinity"]
