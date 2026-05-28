# syntax=docker/dockerfile:1@sha256:87999aa3d42bdc6bea60565083ee17e86d1f3339802f543c0d03998580f9cb89

# Workspace agent build is implemented in Unit 7. This Dockerfile is a
# placeholder that builds an idle container so the compose stack composes
# cleanly.
#
# Unit 7 will replace this with a real build that installs:
#   - OpenCode CLI  pinned to 1.14.41
#   - oMo (oh-my-opencode) pinned to the version in src/shared/constants.ts
#   - @fro.bot/systematic plugin (pinned to DEFAULT_SYSTEMATIC_VERSION in constants.ts)
#   - mitmproxy CA injected into /usr/local/share/ca-certificates/mitmproxy.crt
#     followed by update-ca-certificates so all outbound TLS goes through the proxy

FROM node:24.16.0-alpine@sha256:2bdb65ed1dab192432bc31c95f94155ca5ad7fc1392fb7eb7526ab682fa5bf14

CMD ["sh", "-c", "echo 'workspace placeholder — Unit 7 will replace this'; sleep infinity"]
