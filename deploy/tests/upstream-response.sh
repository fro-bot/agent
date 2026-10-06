# shellcheck shell=bash
# Sourced by egress-smoke.sh and validate-stack.test.sh (no side effects).
#
# upstream_response_verified <curl-exit> <curl -sv output>: succeeds only when
# the output proves a real api.github.com response arrived through mitmproxy,
# whatever its status (a rate-limit 403/429 still proves routing):
#   - curl exited 0 (no CONNECT refusal, TLS failure, or timeout),
#   - the TLS session verified against the mitmproxy-issued leaf certificate,
#   - an HTTP status line was received,
#   - the response carries GitHub's x-github-request-id, which mitmproxy's own
#     responses (the 403 allowlist block, 502 upstream-connect error) never set.
# Here-strings, NOT `printf | grep -q`: see log-contains.sh (SIGPIPE under pipefail).
upstream_response_verified() {
  local rc="$1" out="$2"
  [ "${rc}" -eq 0 ] || return 1
  grep -qE '^\* +SSL certificate (verify ok|verified via)' <<<"${out}" || return 1
  grep -qE '^\* +issuer:.*CN ?= ?mitmproxy' <<<"${out}" || return 1
  grep -qE '^< HTTP/[0-9.]+ [0-9]+' <<<"${out}" || return 1
  grep -qiE '^< x-github-request-id:' <<<"${out}" || return 1
}
