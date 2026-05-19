# syntax=docker/dockerfile:1@sha256:2780b5c3bab67f1f76c781860de469442999ed1a0d7992a5efdf2cffc0e3d769

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

FROM node:24-alpine@sha256:d1b3b4da11eefd5941e7f0b9cf17783fc99d9c6fc34884a665f40a06dbdfc94f

CMD ["sh", "-c", "echo 'workspace placeholder — Unit 7 will replace this'; sleep infinity"]
