"""
mitmproxy egress allowlist addon — fro-bot gateway v1.

Enforces a static allowlist of permitted CONNECT destinations.
Any host not on the list receives a synthetic 403 and the connection is killed.

Changes to the allowlist require restarting the mitmproxy container (no runtime
YAML override in v1 — the list is intentionally a code-level constant so that
changes go through review).
"""

import re
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
    # S3-compatible object stores
    "*.s3.amazonaws.com",
    "*.r2.cloudflarestorage.com",
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


def _is_allowed(host: str) -> bool:
    """Return True if *host* matches any entry in ALLOWLIST."""
    host = host.lower()
    for entry in ALLOWLIST:
        if entry.startswith("*."):
            # Wildcard: match any subdomain of the base domain.
            base = entry[2:]  # strip "*."
            if host == base or host.endswith("." + base):
                return True
        else:
            if host == entry:
                return True
    return False


class AllowlistAddon:
    def http_connect(self, flow: http.HTTPFlow) -> None:
        host = flow.request.host
        if not _is_allowed(host):
            print(
                f"[allowlist] BLOCKED connect host={host} "
                f"client={flow.client_conn.peername}",
                file=sys.stderr,
                flush=True,
            )
            flow.response = http.Response.make(
                403,
                f"Blocked by fro-bot egress allowlist: {host}",
                {"Content-Type": "text/plain"},
            )
            flow.kill()
        else:
            print(
                f"[allowlist] ALLOWED connect host={host}",
                file=sys.stderr,
                flush=True,
            )


addons = [AllowlistAddon()]
