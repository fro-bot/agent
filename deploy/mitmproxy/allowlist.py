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

WORKSPACE_EGRESS_HOSTS
    Comma-separated list of additional hosts to allow for workspace egress.
    Use this for self-hosted model proxies or other explicitly-justified egress
    hosts that the workspace must reach (e.g. a self-hosted OpenCode proxy).
    Example: "cliproxy.fro.bot"

    Applies the same validation as OBJECT_STORE_HOSTS: wildcards, private/
    loopback/link-local/reserved IPs, and port suffixes are all rejected.

    If unset or empty, no additional workspace-egress hosts are allowed
    (fail-closed default).
"""

import ipaddress
import os
import socket
import sys
from mitmproxy import http

# ---------------------------------------------------------------------------
# Allowlist — production-safe defaults for fro-bot v1.
# Entries starting with "*." match any subdomain of the given domain.
#
# Wildcard entries (*.foo.com) are permitted in this static list because they
# go through code review. The same wildcards are REJECTED when supplied via
# OBJECT_STORE_HOSTS or WORKSPACE_EGRESS_HOSTS env vars to prevent operators
# (or attackers with deploy-config access) from silently re-introducing
# over-broad allowlist holes.
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


def _ip_is_disallowed(ip_str: str) -> bool:
    """Return True if *ip_str* is a reserved/private/loopback/link-local IP.

    Covers all ranges that must not be reachable from the workspace:
      - RFC 1918 private (10/8, 172.16/12, 192.168/16)
      - loopback (127/8, ::1/128)
      - link-local (169.254/16, fe80::/10)
      - shared address space / CGNAT (100.64/10, RFC 6598)
      - documentation ranges (192.0.2/24, 198.51.100/24, 203.0.113/24, 2001:db8::/32)
      - benchmarking (198.18/15)
      - multicast, unspecified (0.0.0.0, ::), site-local, unique local IPv6 (fc00::/7)

    Returns False for globally-routable public IPs (accepted for self-hosted
    MinIO deployments and similar use cases).
    """
    try:
        ip = ipaddress.ip_address(ip_str)
    except ValueError:
        # Not a parseable IP address — not our concern here.
        return False
    return not ip.is_global


def _is_valid_hostname(hostname: str) -> bool:
    """Return True if *hostname* is a valid RFC 1123 hostname.

    Accepts 1-253 characters composed of labels separated by dots. Each label
    must be 1-63 characters of [a-z0-9-], must not start or end with a hyphen.
    Uppercase is not accepted here — callers must lowercase first.
    """
    if not (1 <= len(hostname) <= 253):
        return False
    # Reject leading/trailing dots and consecutive dots — these create empty
    # labels that pass the per-label check but are not valid RFC 1123 hosts.
    if hostname.startswith(".") or hostname.endswith("."):
        return False
    if ".." in hostname:
        return False
    labels = hostname.split(".")
    for label in labels:
        if not label or len(label) > 63:
            return False
        if label.startswith("-") or label.endswith("-"):
            return False
        if not all(c in "abcdefghijklmnopqrstuvwxyz0123456789-" for c in label):
            return False
    return True


# ---------------------------------------------------------------------------
# Shared parse/validate pipeline for operator-supplied egress host env vars.
#
# Validation order per entry (after strip):
#   1. empty-skip        — blank entries are silently ignored
#   2. wildcard-reject   — entries starting with "*." are rejected
#   3. ip-literal-validate — if the entry parses as an IP address, validate it:
#                            public IPs are accepted (MinIO/self-hosted use case);
#                            private/loopback/link-local/reserved IPs are rejected
#                            to prevent egress to internal services such as the
#                            cloud metadata endpoint (169.254.169.254). Bare IPv6
#                            literals (e.g. "::1", "2001:db8::1") are caught here
#                            before the port-reject step.
#   4. port-reject       — entries containing ":" that did NOT parse as a bare IP
#                          are rejected (bracket-form IPv6+port, hostname:port).
#   5. hostname-validate — must pass RFC 1123 check (after lowercasing)
#   6. lowercase-normalize — stored in lowercase for consistent matching
# ---------------------------------------------------------------------------


def _parse_egress_hosts(env_var_name: str, raw_value: str) -> list[str]:
    """Parse and validate a comma-separated list of egress hostnames from an env var.

    *env_var_name* is used in error messages so operators know which variable
    to fix. *raw_value* is the raw string from the environment (may be empty).

    Returns the validated, lowercased host list. Raises ValueError on the first
    invalid entry, naming the env var and the offending value.
    """
    result: list[str] = []
    for _entry in raw_value.split(","):
        _h = _entry.strip()
        if not _h:
            # 1. empty-skip
            continue
        if _h.startswith("*."):
            # 2. wildcard-reject
            raise ValueError(
                f"{env_var_name} contains a wildcard entry '{_h}'. "
                "Wildcards are not allowed in object-store hosts to prevent "
                "re-introducing the over-broad-allowlist security gap. "
                "Set exact bucket hostnames (e.g. 'my-bucket.s3.amazonaws.com')."
            )
        # 3. ip-literal-validate — fires before port-reject so bare IPv6 literals
        # (which contain colons) are handled correctly. Returns the entry if it is
        # a valid public IP, raises on reserved ranges, returns None if not an IP.
        try:
            ipaddress.ip_address(_h)
            # Parsed as IP — check if it's disallowed.
            if _ip_is_disallowed(_h):
                raise ValueError(
                    f"{env_var_name} entry '{_h}' is not a globally-routable public IP.\n"
                    "Rejected: private (10.x/172.16-31.x/192.168.x), loopback (127.0.0.1, ::1),\n"
                    "link-local (169.254/16, fe80::/10), shared address space / CGNAT (100.64/10),\n"
                    "documentation (192.0.2.x, 198.51.100.x, 203.0.113.x, 2001:db8::/32),\n"
                    "multicast, and reserved ranges are blocked to prevent egress to internal\n"
                    "or unroutable destinations. Use a public IP, or set up a hostname mapping\n"
                    "for internal endpoints."
                )
            result.append(_h)
            continue
        except ValueError as exc:
            # Re-raise if it's our own validation error (not the ip_address parse failure).
            if env_var_name in str(exc):
                raise
            # Otherwise it wasn't a valid IP — fall through to port/hostname checks.
        if ":" in _h:
            # 4. port-reject — entry was not a bare IP but still contains ":".
            # Could be hostname:port or bracket-form IPv6+port ([::1]:9000).
            if _h.count(":") > 1 or _h.startswith("["):
                raise ValueError(
                    f"{env_var_name} entry '{_h}' looks like an IPv6 address with a port "
                    "or bracket notation. Bare IPv6 addresses are validated above; "
                    "IPv6+port is not supported. Use a bare IPv6 address or a hostname."
                )
            raise ValueError(
                f"{env_var_name} entry '{_h}' contains a port. mitmproxy may "
                "or may not include the port in flow.request.host depending on "
                "version and proxy mode. Set bare hostnames only "
                "(e.g. 'localhost' or 'minio')."
            )
        _h_lower = _h.lower()
        if not _is_valid_hostname(_h_lower):
            # 5. hostname-validate
            raise ValueError(
                f"{env_var_name} entry '{_h}' is not a valid hostname. "
                "Use RFC 1123 hostnames composed of labels separated by dots "
                "(e.g. 'my-bucket.s3.amazonaws.com')."
            )
        # 6. lowercase-normalize
        result.append(_h_lower)
    return result


# ---------------------------------------------------------------------------
# Merge OBJECT_STORE_HOSTS env var into the allowlist at module import time.
# ---------------------------------------------------------------------------
_object_store_hosts = _parse_egress_hosts(
    "OBJECT_STORE_HOSTS", os.environ.get("OBJECT_STORE_HOSTS", "")
)
ALLOWLIST = ALLOWLIST + _object_store_hosts

# ---------------------------------------------------------------------------
# Merge WORKSPACE_EGRESS_HOSTS env var into the allowlist at module import time.
# ---------------------------------------------------------------------------
_workspace_egress_hosts = _parse_egress_hosts(
    "WORKSPACE_EGRESS_HOSTS", os.environ.get("WORKSPACE_EGRESS_HOSTS", "")
)
ALLOWLIST = ALLOWLIST + _workspace_egress_hosts

# ---------------------------------------------------------------------------
# Track the set of operator-supplied hosts for resolved-IP validation at
# enforcement time. Only hosts from env vars (not the static list) are
# subject to DNS-rebinding checks — vendor hosts go through code review.
# ---------------------------------------------------------------------------
_operator_supplied_hosts: set[str] = {h.lower() for h in _object_store_hosts + _workspace_egress_hosts}


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


def _resolve_has_disallowed_ip(host: str) -> bool:
    """Resolve *host* and return True if ANY resolved address is disallowed.

    Fails closed: if resolution raises, returns True (block the request).

    Note: this check runs at the addon hook layer. mitmproxy performs its own
    independent resolution for the upstream dial (TOCTOU gap). This is
    defense-in-depth against operator misconfiguration and naive DNS rebinding,
    not a hermetic guarantee.
    """
    try:
        results = socket.getaddrinfo(host, None)
    except socket.gaierror:
        return True  # fail closed — resolution failure blocks the request
    for _family, _type, _proto, _canonname, sockaddr in results:
        ip_str = sockaddr[0]
        if _ip_is_disallowed(ip_str):
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
            return

        # For operator-supplied hosts, validate the resolved IP at enforcement
        # time to defend against DNS rebinding. Vendor static-list hosts are
        # not resolved-checked (they go through code review).
        if host.lower() in _operator_supplied_hosts:
            if _resolve_has_disallowed_ip(host):
                print(
                    f"[allowlist] BLOCKED {kind} host={host} reason=resolves-to-disallowed-ip "
                    f"client={flow.client_conn.peername}",
                    file=sys.stderr,
                    flush=True,
                )
                flow.response = http.Response.make(
                    403,
                    f"Blocked by fro-bot egress allowlist: {host} resolves to a disallowed IP",
                    {"Content-Type": "text/plain"},
                )
                return

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
