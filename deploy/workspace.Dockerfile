# syntax=docker/dockerfile:1

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

FROM node:24-alpine

CMD ["sh", "-c", "echo 'workspace placeholder — Unit 7 will replace this'; sleep infinity"]
