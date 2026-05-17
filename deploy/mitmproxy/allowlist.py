"""
mitmproxy egress allowlist addon — fro-bot gateway v1.

Enforces a static allowlist of permitted CONNECT destinations and plain HTTP
request hosts. Any host not on the list receives a synthetic 403 short-circuit
response.

Changes to the allowlist require restarting the mitmproxy container (no runtime
YAML override in v1 — the list is intentionally a code-level constant so that
changes go through review).

Environment variables
---------------------
OBJECT_STORE_HOSTS
    Comma-separated list of additional hosts to allow for object-store access.
    Example: "my-bucket.s3.amazonaws.com,my-account.r2.cloudflarestorage.com"

    The static allowlist intentionally omits the broad *.s3.amazonaws.com and
    *.r2.cloudflarestorage.com wildcards to prevent data exfiltration to
    attacker-controlled buckets in those clouds. Set this variable to the exact
    bucket host(s) your deployment uses.

    If unset or empty, all S3/R2 traffic is blocked (fail-closed default).
"""

import os
import sys
from mitmproxy import http

# ---------------------------------------------------------------------------
# Allowlist — production-safe defaults for fro-bot v1.
# Entries starting with "*." match any subdomain of the given domain.
# ---------------------------------------------------------------------------
ALLOWLIST: list[str] = [
    # GitHub
    "api.github.com",
    "objects.githubusercontent.com",
    "uploads.github.com",
    "raw.githubusercontent.com",
    "github.com",
    # npm registry
    "registry.npmjs.org",
    # NOTE: S3/R2 wildcards removed — use OBJECT_STORE_HOSTS env var to scope
    # to the exact bucket host(s) your deployment uses. See module docstring.
    # Discord
    "discord.com",
    "gateway.discord.gg",
    "*.discord.com",
    "*.discord.gg",
    # LLM providers
    "api.anthropic.com",
    "api.openai.com",
    "generativelanguage.googleapis.com",
]

# ---------------------------------------------------------------------------
# Hostname validation helper (RFC 1123 subset).
# ---------------------------------------------------------------------------

def _is_valid_hostname(hostname: str) -> bool:
    """Return True if *hostname* is a valid RFC 1123 hostname.

    Accepts 1-253 characters composed of labels separated by dots. Each label
    must be 1-63 characters of [a-z0-9-], must not start or end with a hyphen.
    Uppercase is not accepted here — callers must lowercase first.
    """
    if not hostname or len(hostname) > 253:
        return False
    labels = hostname.rstrip(".").split(".")
    for label in labels:
        if not label or len(label) > 63:
            return False
        if label.startswith("-") or label.endswith("-"):
            return False
        if not all(c in "abcdefghijklmnopqrstuvwxyz0123456789-" for c in label):
            return False
    return True


# ---------------------------------------------------------------------------
# Merge OBJECT_STORE_HOSTS env var into the allowlist at module import time.
#
# Validation order per entry (after strip):
#   1. empty-skip   — blank entries are silently ignored
#   2. wildcard-reject — entries starting with "*." are rejected (more
#                        actionable error than the generic hostname check)
#   3. port-reject  — entries containing ":" are rejected (mitmproxy
#                     flow.request.host may or may not include the port
#                     depending on version/mode; bare hostnames only)
#   4. hostname-validate — must pass RFC 1123 check (after lowercasing)
#   5. lowercase-normalize — stored in lowercase for consistent matching
# ---------------------------------------------------------------------------
_object_store_hosts_raw = os.environ.get("OBJECT_STORE_HOSTS", "")
_object_store_hosts: list[str] = []
for _entry in _object_store_hosts_raw.split(","):
    _h = _entry.strip()
    if not _h:
        # 1. empty-skip
        continue
    if _h.startswith("*."):
        # 2. wildcard-reject
        raise ValueError(
            f"OBJECT_STORE_HOSTS contains a wildcard entry '{_h}'. "
            "Wildcards are not allowed in object-store hosts to prevent "
            "re-introducing the over-broad-allowlist security gap. "
            "Set exact bucket hostnames (e.g. 'my-bucket.s3.amazonaws.com')."
        )
    if ":" in _h:
        # 3. port-reject
        raise ValueError(
            f"OBJECT_STORE_HOSTS entry '{_h}' contains a port. "
            "mitmproxy may or may not include the port in flow.request.host "
            "depending on version and proxy mode. "
            "Set bare hostnames only (e.g. 'localhost' or 'minio')."
        )
    _h_lower = _h.lower()
    if not _is_valid_hostname(_h_lower):
        # 4. hostname-validate
        raise ValueError(
            f"OBJECT_STORE_HOSTS entry '{_h}' is not a valid hostname. "
            "Use RFC 1123 hostnames composed of labels separated by dots "
            "(e.g. 'my-bucket.s3.amazonaws.com')."
        )
    # 5. lowercase-normalize
    _object_store_hosts.append(_h_lower)

ALLOWLIST = ALLOWLIST + _object_store_hosts


def _is_allowed(host: str) -> bool:
    """Return True if *host* matches any entry in ALLOWLIST.

    Wildcard semantics: "*.example.com" matches both the bare apex
    (example.com) and any subdomain (api.example.com). This is intentional
    — most providers expose both an apex and subdomain surface, and listing
    them separately doubles the allowlist without any security benefit.
    """
    host = host.lower()
    for entry in ALLOWLIST:
        if entry.startswith("*."):
            # Wildcard: match the apex domain OR any subdomain of it.
            base = entry[2:]  # strip "*."
            if host == base or host.endswith("." + base):
                return True
        else:
            if host == entry:
                return True
    return False


class AllowlistAddon:
    def _enforce(self, flow: http.HTTPFlow, kind: str) -> None:
        """Apply the allowlist to *flow*. *kind* is 'connect' or 'request' for logging."""
        host = flow.request.host
        if not _is_allowed(host):
            print(
                f"[allowlist] BLOCKED {kind} host={host} "
                f"client={flow.client_conn.peername}",
                file=sys.stderr,
                flush=True,
            )
            # Setting flow.response short-circuits the request before mitmproxy
            # establishes the upstream tunnel. We intentionally do NOT call
            # flow.kill() — that would also produce a redundant "killed" log
            # line in some mitmproxy versions.
            flow.response = http.Response.make(
                403,
                f"Blocked by fro-bot egress allowlist: {host}",
                {"Content-Type": "text/plain"},
            )
        else:
            print(
                f"[allowlist] ALLOWED {kind} host={host}",
                file=sys.stderr,
                flush=True,
            )

    def http_connect(self, flow: http.HTTPFlow) -> None:
        """Enforce allowlist for HTTPS CONNECT tunnels."""
        self._enforce(flow, "connect")

    def request(self, flow: http.HTTPFlow) -> None:
        """Enforce allowlist for plain HTTP requests.

        The http_connect hook only fires for HTTPS CONNECT tunnels. Plain HTTP
        requests routed through HTTP_PROXY flow through this hook instead.
        Without this check, a workspace container could bypass the allowlist
        entirely by using http:// URLs.
        """
        self._enforce(flow, "request")



addons = [AllowlistAddon()]
