"""
Tests for deploy/mitmproxy/allowlist.py.

Run with:
    pytest deploy/mitmproxy/test_allowlist.py -v

Or without pytest installed:
    python3 deploy/mitmproxy/test_allowlist.py

The mitmproxy package is NOT required — it is mocked via sys.modules injection
below so this suite can run in any standard Python 3.11+ environment.
"""

import sys
from unittest.mock import MagicMock

# ---------------------------------------------------------------------------
# Mock mitmproxy before importing allowlist.py — the test env does not have
# mitmproxy installed.
# ---------------------------------------------------------------------------
mitmproxy_http_mock = MagicMock()
sys.modules["mitmproxy"] = MagicMock(http=mitmproxy_http_mock)
sys.modules["mitmproxy.http"] = mitmproxy_http_mock

# ---------------------------------------------------------------------------
# Now we can safely import the module under test.
# ---------------------------------------------------------------------------
import importlib
import os
import types


def _load_allowlist(extra_env: dict | None = None):
    """Import (or re-import) allowlist with optional env overrides.

    Because ALLOWLIST is built at module import time from the env var, we need
    to reload the module for each env-var test scenario.
    """
    env_backup = os.environ.copy()
    try:
        # Always clear both managed env vars first for hermetic isolation.
        os.environ.pop("OBJECT_STORE_HOSTS", None)
        os.environ.pop("WORKSPACE_EGRESS_HOSTS", None)
        if extra_env:
            os.environ.update(extra_env)

        # Remove cached module so import runs fresh.
        sys.modules.pop("allowlist", None)

        import importlib.util
        import pathlib

        spec = importlib.util.spec_from_file_location(
            "allowlist",
            pathlib.Path(__file__).parent / "allowlist.py",
        )
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod
    finally:
        os.environ.clear()
        os.environ.update(env_backup)


def _make_flow(host: str, peername: str = "10.0.0.1:12345"):
    """Build a minimal mock flow object."""
    flow = MagicMock()
    flow.request.host = host
    flow.client_conn.peername = peername
    flow.response = None  # will be set by addon on block
    return flow


# ===========================================================================
# _is_allowed tests
# ===========================================================================


def test_is_allowed_exact_match():
    mod = _load_allowlist()
    assert mod._is_allowed("api.github.com") is True


def test_is_allowed_exact_no_match():
    mod = _load_allowlist()
    assert mod._is_allowed("evil.example") is False


def test_is_allowed_wildcard_apex():
    """*.discord.com should match the bare apex discord.com."""
    mod = _load_allowlist()
    assert mod._is_allowed("discord.com") is True


def test_is_allowed_wildcard_subdomain():
    """*.discord.com should match cdn.discord.com."""
    mod = _load_allowlist()
    assert mod._is_allowed("cdn.discord.com") is True


def test_is_allowed_case_normalization():
    """Host matching must be case-insensitive."""
    mod = _load_allowlist()
    assert mod._is_allowed("API.GitHub.COM") is True


def test_is_allowed_non_match():
    mod = _load_allowlist()
    assert mod._is_allowed("attacker.example.com") is False


def test_is_allowed_empty_allowlist():
    """With an empty allowlist, nothing is allowed."""
    mod = _load_allowlist()
    original = mod.ALLOWLIST[:]
    mod.ALLOWLIST.clear()
    try:
        assert mod._is_allowed("api.github.com") is False
    finally:
        mod.ALLOWLIST.extend(original)


# ===========================================================================
# _is_valid_hostname — dot-boundary edge cases (Fix 1)
# ===========================================================================


def test_is_valid_hostname_rejects_leading_dot():
    """.example.com must return False — leading dot creates an empty label."""
    mod = _load_allowlist()
    assert mod._is_valid_hostname(".example.com") is False


def test_is_valid_hostname_rejects_trailing_dot():
    """example.com. must return False — trailing dot is not a valid RFC 1123 host."""
    mod = _load_allowlist()
    assert mod._is_valid_hostname("example.com.") is False


def test_is_valid_hostname_rejects_consecutive_dots():
    """example..com must return False — consecutive dots create an empty label."""
    mod = _load_allowlist()
    assert mod._is_valid_hostname("example..com") is False


# ===========================================================================
# OBJECT_STORE_HOSTS env-var merging
# ===========================================================================


def test_object_store_hosts_included_when_set():
    mod = _load_allowlist(
        {"OBJECT_STORE_HOSTS": "my-bucket.s3.amazonaws.com,my-account.r2.cloudflarestorage.com"}
    )
    assert "my-bucket.s3.amazonaws.com" in mod.ALLOWLIST
    assert "my-account.r2.cloudflarestorage.com" in mod.ALLOWLIST


def test_object_store_hosts_not_in_static_list():
    """Without env var, broad S3/R2 wildcards must NOT be present."""
    mod = _load_allowlist()
    assert "*.s3.amazonaws.com" not in mod.ALLOWLIST
    assert "*.r2.cloudflarestorage.com" not in mod.ALLOWLIST


def test_object_store_hosts_empty_string():
    """Empty env var → only static list, no extra entries."""
    mod = _load_allowlist({"OBJECT_STORE_HOSTS": ""})
    assert "*.s3.amazonaws.com" not in mod.ALLOWLIST
    assert "*.r2.cloudflarestorage.com" not in mod.ALLOWLIST


def test_object_store_hosts_whitespace_padded():
    """Whitespace around entries must be stripped."""
    mod = _load_allowlist({"OBJECT_STORE_HOSTS": "  my-bucket.s3.amazonaws.com , "})
    assert "my-bucket.s3.amazonaws.com" in mod.ALLOWLIST
    # Ensure no whitespace-padded entry snuck in
    assert all(h == h.strip() for h in mod.ALLOWLIST)


def test_object_store_hosts_is_allowed():
    """A host from OBJECT_STORE_HOSTS must pass _is_allowed."""
    mod = _load_allowlist({"OBJECT_STORE_HOSTS": "my-bucket.s3.amazonaws.com"})
    assert mod._is_allowed("my-bucket.s3.amazonaws.com") is True


def test_object_store_hosts_other_bucket_blocked():
    """A different bucket must still be blocked even when env var is set."""
    mod = _load_allowlist({"OBJECT_STORE_HOSTS": "my-bucket.s3.amazonaws.com"})
    assert mod._is_allowed("attacker-bucket.s3.amazonaws.com") is False


# ===========================================================================
# AllowlistAddon.http_connect
# ===========================================================================


def _reset_response_mock():
    """Reset the shared Response.make mock to prevent cross-test contamination."""
    mitmproxy_http_mock.Response.make.reset_mock()


def test_http_connect_allowed_no_response():
    """Allowed CONNECT → flow.response must remain unset (pass-through)."""
    _reset_response_mock()
    mod = _load_allowlist()
    addon = mod.AllowlistAddon()
    flow = _make_flow("api.github.com")
    addon.http_connect(flow)
    assert flow.response is None
    mitmproxy_http_mock.Response.make.assert_not_called()


def test_http_connect_blocked_sets_403():
    """Blocked CONNECT → flow.response set to 403 text/plain."""
    _reset_response_mock()
    mod = _load_allowlist()
    addon = mod.AllowlistAddon()
    flow = _make_flow("evil.example.com")
    addon.http_connect(flow)
    mitmproxy_http_mock.Response.make.assert_called_once_with(
        403,
        "Blocked by fro-bot egress allowlist: evil.example.com",
        {"Content-Type": "text/plain"},
    )
    # flow.response was assigned (not None)
    assert flow.response is not None


# ===========================================================================
# AllowlistAddon.request  ← proves the plain-HTTP bypass is closed
# ===========================================================================


def test_request_allowed_no_response():
    """Allowed plain HTTP request → flow.response must remain unset."""
    _reset_response_mock()
    mod = _load_allowlist()
    addon = mod.AllowlistAddon()
    flow = _make_flow("api.github.com")
    addon.request(flow)
    assert flow.response is None
    mitmproxy_http_mock.Response.make.assert_not_called()


def test_request_blocked_sets_403():
    """Blocked plain HTTP request → flow.response set to 403 text/plain."""
    _reset_response_mock()
    mod = _load_allowlist()
    addon = mod.AllowlistAddon()
    flow = _make_flow("evil.example.com")
    addon.request(flow)
    mitmproxy_http_mock.Response.make.assert_called_once_with(
        403,
        "Blocked by fro-bot egress allowlist: evil.example.com",
        {"Content-Type": "text/plain"},
    )
    assert flow.response is not None


def test_request_blocked_does_not_kill_flow():
    """Blocked request must set response, not call flow.kill()."""
    _reset_response_mock()
    mod = _load_allowlist()
    addon = mod.AllowlistAddon()
    flow = _make_flow("evil.example.com")
    addon.request(flow)
    flow.kill.assert_not_called()


def test_request_s3_blocked_without_env_var():
    """Without OBJECT_STORE_HOSTS, any S3 host must be blocked via request hook."""
    _reset_response_mock()
    mod = _load_allowlist()
    addon = mod.AllowlistAddon()
    flow = _make_flow("attacker-bucket.s3.amazonaws.com")
    addon.request(flow)
    mitmproxy_http_mock.Response.make.assert_called_once()
    assert flow.response is not None


def test_request_s3_allowed_with_env_var():
    """With OBJECT_STORE_HOSTS set, the configured bucket passes the request hook."""
    _reset_response_mock()
    mod = _load_allowlist({"OBJECT_STORE_HOSTS": "my-bucket.s3.amazonaws.com"})
    addon = mod.AllowlistAddon()
    flow = _make_flow("my-bucket.s3.amazonaws.com")
    addon.request(flow)
    assert flow.response is None
    mitmproxy_http_mock.Response.make.assert_not_called()


# ===========================================================================
# Todo 016 — Wildcard and invalid hostname rejection
# ===========================================================================


def test_object_store_hosts_rejects_wildcard_apex():
    """OBJECT_STORE_HOSTS='*.s3.amazonaws.com' must raise ValueError with actionable guidance."""
    try:
        _load_allowlist({"OBJECT_STORE_HOSTS": "*.s3.amazonaws.com"})
        assert False, "Expected ValueError"
    except ValueError as e:
        msg = str(e)
        assert "Wildcards are not allowed" in msg, f"Expected 'Wildcards are not allowed' in error: {e}"
        assert "*.s3.amazonaws.com" in msg, f"Expected wildcard entry name in error: {e}"


def test_object_store_hosts_rejects_wildcard_subdomain():
    """OBJECT_STORE_HOSTS='*.example.com' must raise ValueError with actionable guidance."""
    try:
        _load_allowlist({"OBJECT_STORE_HOSTS": "*.example.com"})
        assert False, "Expected ValueError"
    except ValueError as e:
        msg = str(e)
        assert "Wildcards are not allowed" in msg, f"Expected 'Wildcards are not allowed' in error: {e}"
        assert "*.example.com" in msg, f"Expected wildcard entry name in error: {e}"


def test_object_store_hosts_rejects_invalid_hostname():
    """OBJECT_STORE_HOSTS='invalid host' (space) must raise ValueError with entry name."""
    try:
        _load_allowlist({"OBJECT_STORE_HOSTS": "invalid host"})
        assert False, "Expected ValueError"
    except ValueError as e:
        msg = str(e)
        # The validator sees "invalid host" as a single entry (space is not a comma),
        # which fails RFC 1123 — the error must name the offending entry.
        assert "invalid host" in msg, f"Expected entry name in error: {e}"


def test_object_store_hosts_accepts_valid_bucket_host():
    """OBJECT_STORE_HOSTS='my-bucket.s3.amazonaws.com' must load without error."""
    mod = _load_allowlist({"OBJECT_STORE_HOSTS": "my-bucket.s3.amazonaws.com"})
    assert mod._is_allowed("my-bucket.s3.amazonaws.com") is True


# ===========================================================================
# Todo 015 — Uppercase normalization and port rejection
# ===========================================================================


def test_object_store_hosts_uppercase_normalized():
    """Uppercase OBJECT_STORE_HOSTS entry must allow the lowercase request host."""
    mod = _load_allowlist({"OBJECT_STORE_HOSTS": "FOO.S3.AMAZONAWS.COM"})
    assert mod._is_allowed("foo.s3.amazonaws.com") is True


def test_object_store_hosts_rejects_port_in_host():
    """OBJECT_STORE_HOSTS='localhost:9000' must raise ValueError."""
    try:
        _load_allowlist({"OBJECT_STORE_HOSTS": "localhost:9000"})
        assert False, "Expected ValueError"
    except ValueError as e:
        assert "port" in str(e).lower(), f"Expected 'port' in error: {e}"


def test_object_store_hosts_rejects_ipv6_literal():
    """OBJECT_STORE_HOSTS='::1' must raise ValueError — loopback IPv6 is a reserved range."""
    try:
        _load_allowlist({"OBJECT_STORE_HOSTS": "::1"})
        assert False, "Expected ValueError"
    except ValueError as e:
        msg = str(e)
        # The IP-literal check fires before port-reject, so the error should
        # mention reserved/loopback, not "contains a port" or "IPv6 not supported".
        assert "reserved" in msg.lower() or "loopback" in msg.lower(), (
            f"Expected 'reserved' or 'loopback' in error, got: {e}"
        )
        assert "contains a port" not in msg.lower(), (
            f"Error should not say 'contains a port' for bare IPv6: {e}"
        )


def test_object_store_hosts_accepts_ipv4_literal() -> None:
    """Public IPv4 literals are accepted; private/reserved ranges are rejected.

    This test was updated in todo 017 (Option 2 implementation) to reflect the
    new behavior: private IPs like 10.0.0.5 are now rejected to prevent egress
    to internal services. Public IPs (e.g. 8.8.8.8) are accepted to support
    self-hosted MinIO deployments that use a public IP address.

    Previously (PR #638) this test documented that 10.0.0.5 was accepted on
    deploy-config-trust grounds. That decision has been superseded — reserved
    ranges are now blocked unconditionally.
    """
    # Public IP must be accepted
    mod = _load_allowlist({"OBJECT_STORE_HOSTS": "8.8.8.8"})
    assert mod._is_allowed("8.8.8.8") is True

    # Private IP must be rejected
    try:
        _load_allowlist({"OBJECT_STORE_HOSTS": "10.0.0.5"})
        assert False, "Expected ValueError for private IP 10.0.0.5"
    except ValueError as e:
        assert "reserved" in str(e).lower() or "private" in str(e).lower(), (
            f"Expected 'reserved' or 'private' in error: {e}"
        )


# ===========================================================================
# Todo 017 — IP literal validation (public allowed, reserved rejected)
# ===========================================================================


def test_object_store_hosts_rejects_metadata_service_ipv4():
    """169.254.169.254 (cloud metadata) must be rejected as link-local/reserved."""
    try:
        _load_allowlist({"OBJECT_STORE_HOSTS": "169.254.169.254"})
        assert False, "Expected ValueError"
    except ValueError as e:
        msg = str(e).lower()
        assert "reserved" in msg or "metadata" in msg or "link-local" in msg, (
            f"Expected 'reserved', 'metadata', or 'link-local' in error: {e}"
        )


def test_object_store_hosts_rejects_private_ipv4_10():
    """10.0.0.5 (RFC 1918 private) must be rejected."""
    try:
        _load_allowlist({"OBJECT_STORE_HOSTS": "10.0.0.5"})
        assert False, "Expected ValueError"
    except ValueError as e:
        msg = str(e).lower()
        assert "reserved" in msg or "private" in msg, (
            f"Expected 'reserved' or 'private' in error: {e}"
        )


def test_object_store_hosts_rejects_private_ipv4_172():
    """172.16.0.1 (RFC 1918 private) must be rejected."""
    try:
        _load_allowlist({"OBJECT_STORE_HOSTS": "172.16.0.1"})
        assert False, "Expected ValueError"
    except ValueError as e:
        msg = str(e).lower()
        assert "reserved" in msg or "private" in msg, (
            f"Expected 'reserved' or 'private' in error: {e}"
        )


def test_object_store_hosts_rejects_private_ipv4_192():
    """192.168.1.1 (RFC 1918 private) must be rejected."""
    try:
        _load_allowlist({"OBJECT_STORE_HOSTS": "192.168.1.1"})
        assert False, "Expected ValueError"
    except ValueError as e:
        msg = str(e).lower()
        assert "reserved" in msg or "private" in msg, (
            f"Expected 'reserved' or 'private' in error: {e}"
        )


def test_object_store_hosts_rejects_loopback_ipv4():
    """127.0.0.1 (loopback) must be rejected."""
    try:
        _load_allowlist({"OBJECT_STORE_HOSTS": "127.0.0.1"})
        assert False, "Expected ValueError"
    except ValueError as e:
        msg = str(e).lower()
        assert "reserved" in msg or "loopback" in msg, (
            f"Expected 'reserved' or 'loopback' in error: {e}"
        )


def test_object_store_hosts_rejects_unspecified_ipv4():
    """0.0.0.0 (unspecified) must be rejected."""
    try:
        _load_allowlist({"OBJECT_STORE_HOSTS": "0.0.0.0"})
        assert False, "Expected ValueError"
    except ValueError as e:
        msg = str(e).lower()
        assert "reserved" in msg or "unspecified" in msg or "private" in msg, (
            f"Expected 'reserved', 'unspecified', or 'private' in error: {e}"
        )


def test_object_store_hosts_accepts_public_ipv6():
    """2001:4860:4860::8888 (Google IPv6 DNS) is a public IP and must be accepted."""
    mod = _load_allowlist({"OBJECT_STORE_HOSTS": "2001:4860:4860::8888"})
    assert mod._is_allowed("2001:4860:4860::8888") is True


def test_object_store_hosts_rejects_loopback_ipv6():
    """::1 (IPv6 loopback) must be rejected — IP check fires before port-reject."""
    try:
        _load_allowlist({"OBJECT_STORE_HOSTS": "::1"})
        assert False, "Expected ValueError"
    except ValueError as e:
        msg = str(e).lower()
        assert "reserved" in msg or "loopback" in msg, (
            f"Expected 'reserved' or 'loopback' in error: {e}"
        )
        assert "contains a port" not in msg, (
            f"Error should not say 'contains a port' for bare IPv6 loopback: {e}"
        )


def test_object_store_hosts_rejects_link_local_ipv6():
    """fe80::1 (IPv6 link-local) must be rejected."""
    try:
        _load_allowlist({"OBJECT_STORE_HOSTS": "fe80::1"})
        assert False, "Expected ValueError"
    except ValueError as e:
        msg = str(e).lower()
        assert "reserved" in msg or "link-local" in msg or "private" in msg, (
            f"Expected 'reserved', 'link-local', or 'private' in error: {e}"
        )


def test_object_store_hosts_rejects_unique_local_ipv6():
    """fc00::1 (IPv6 unique local / fc00::/7) must be rejected."""
    try:
        _load_allowlist({"OBJECT_STORE_HOSTS": "fc00::1"})
        assert False, "Expected ValueError"
    except ValueError as e:
        msg = str(e).lower()
        assert "reserved" in msg or "private" in msg, (
            f"Expected 'reserved' or 'private' in error: {e}"
        )


# ===========================================================================
# CGNAT and documentation range regression guards
# ===========================================================================


def test_object_store_hosts_rejects_cgnat_ipv4():
    """100.64.0.1 (RFC 6598 CGNAT / shared address space) must be rejected.

    Python's ipaddress module returns False for is_private, is_reserved,
    is_link_local, is_multicast, and is_global on 100.64.0.0/10. The old
    OR-chain guard (is_private or is_loopback or ...) silently accepted these
    addresses as "public". The new not-is_global guard correctly rejects them.
    """
    try:
        _load_allowlist({"OBJECT_STORE_HOSTS": "100.64.0.1"})
        assert False, "Expected ValueError for CGNAT IP 100.64.0.1"
    except ValueError as e:
        msg = str(e)
        assert "globally-routable" in msg.lower() or "cgnat" in msg.lower(), (
            f"Expected 'globally-routable' or 'CGNAT' in error: {e}"
        )


def test_object_store_hosts_rejects_documentation_ipv4():
    """192.0.2.1 (TEST-NET-1, RFC 5737) must be rejected.

    Documentation ranges (192.0.2/24, 198.51.100/24, 203.0.113/24) are not
    globally routable. Under the new not-is_global guard these are rejected
    regardless of whether is_private returns True or False.
    """
    try:
        _load_allowlist({"OBJECT_STORE_HOSTS": "192.0.2.1"})
        assert False, "Expected ValueError for documentation IP 192.0.2.1"
    except ValueError as e:
        msg = str(e)
        assert "globally-routable" in msg.lower() or "documentation" in msg.lower() or "reserved" in msg.lower(), (
            f"Expected 'globally-routable', 'documentation', or 'reserved' in error: {e}"
        )


def test_object_store_hosts_rejects_documentation_ipv6():
    """2001:db8::1 (IPv6 documentation range, RFC 3849) must be rejected."""
    try:
        _load_allowlist({"OBJECT_STORE_HOSTS": "2001:db8::1"})
        assert False, "Expected ValueError for documentation IPv6 2001:db8::1"
    except ValueError as e:
        msg = str(e)
        assert "globally-routable" in msg.lower() or "documentation" in msg.lower() or "reserved" in msg.lower(), (
            f"Expected 'globally-routable', 'documentation', or 'reserved' in error: {e}"
        )


# ===========================================================================
# WORKSPACE_EGRESS_HOSTS env-var merging
# ===========================================================================


def test_workspace_egress_hosts_included_when_set():
    """WORKSPACE_EGRESS_HOSTS=cliproxy.fro.bot → host in ALLOWLIST."""
    mod = _load_allowlist({"WORKSPACE_EGRESS_HOSTS": "cliproxy.fro.bot"})
    assert "cliproxy.fro.bot" in mod.ALLOWLIST


def test_workspace_egress_hosts_is_allowed():
    """A host from WORKSPACE_EGRESS_HOSTS must pass _is_allowed."""
    mod = _load_allowlist({"WORKSPACE_EGRESS_HOSTS": "cliproxy.fro.bot"})
    assert mod._is_allowed("cliproxy.fro.bot") is True


def test_workspace_egress_hosts_comma_separated():
    """Comma-separated WORKSPACE_EGRESS_HOSTS adds all entries."""
    mod = _load_allowlist({"WORKSPACE_EGRESS_HOSTS": "cliproxy.fro.bot,proxy2.example.com"})
    assert "cliproxy.fro.bot" in mod.ALLOWLIST
    assert "proxy2.example.com" in mod.ALLOWLIST
    assert mod._is_allowed("cliproxy.fro.bot") is True
    assert mod._is_allowed("proxy2.example.com") is True


def test_workspace_egress_hosts_unset_no_change():
    """Unset WORKSPACE_EGRESS_HOSTS → no change to ALLOWLIST, no error."""
    mod_without = _load_allowlist()
    mod_with_empty = _load_allowlist({"WORKSPACE_EGRESS_HOSTS": ""})
    # Neither should raise; static list length should be the same
    assert len(mod_without.ALLOWLIST) == len(mod_with_empty.ALLOWLIST)


def test_workspace_egress_hosts_case_normalized():
    """CliProxy.FRO.bot must be lowercased and matched case-insensitively."""
    mod = _load_allowlist({"WORKSPACE_EGRESS_HOSTS": "CliProxy.FRO.bot"})
    assert "cliproxy.fro.bot" in mod.ALLOWLIST
    assert mod._is_allowed("cliproxy.fro.bot") is True
    assert mod._is_allowed("CliProxy.FRO.bot") is True  # _is_allowed lowercases


def test_workspace_egress_hosts_rejects_wildcard():
    """WORKSPACE_EGRESS_HOSTS='*.fro.bot' must raise ValueError naming the var."""
    try:
        _load_allowlist({"WORKSPACE_EGRESS_HOSTS": "*.fro.bot"})
        assert False, "Expected ValueError"
    except ValueError as e:
        msg = str(e)
        assert "WORKSPACE_EGRESS_HOSTS" in msg, f"Expected var name in error: {e}"
        assert "*.fro.bot" in msg, f"Expected wildcard entry in error: {e}"


def test_workspace_egress_hosts_rejects_private_ip_10():
    """WORKSPACE_EGRESS_HOSTS='10.0.0.5' must raise ValueError."""
    try:
        _load_allowlist({"WORKSPACE_EGRESS_HOSTS": "10.0.0.5"})
        assert False, "Expected ValueError"
    except ValueError as e:
        msg = str(e).lower()
        assert "reserved" in msg or "private" in msg, f"Expected 'reserved' or 'private' in error: {e}"


def test_workspace_egress_hosts_rejects_loopback_ip():
    """WORKSPACE_EGRESS_HOSTS='127.0.0.1' must raise ValueError."""
    try:
        _load_allowlist({"WORKSPACE_EGRESS_HOSTS": "127.0.0.1"})
        assert False, "Expected ValueError"
    except ValueError as e:
        msg = str(e).lower()
        assert "reserved" in msg or "loopback" in msg, f"Expected 'reserved' or 'loopback' in error: {e}"


def test_workspace_egress_hosts_rejects_link_local_ip():
    """WORKSPACE_EGRESS_HOSTS='169.254.169.254' must raise ValueError."""
    try:
        _load_allowlist({"WORKSPACE_EGRESS_HOSTS": "169.254.169.254"})
        assert False, "Expected ValueError"
    except ValueError as e:
        msg = str(e).lower()
        assert "reserved" in msg or "link-local" in msg, f"Expected 'reserved' or 'link-local' in error: {e}"


def test_workspace_egress_hosts_rejects_port():
    """WORKSPACE_EGRESS_HOSTS='cliproxy.fro.bot:443' must raise ValueError."""
    try:
        _load_allowlist({"WORKSPACE_EGRESS_HOSTS": "cliproxy.fro.bot:443"})
        assert False, "Expected ValueError"
    except ValueError as e:
        assert "port" in str(e).lower(), f"Expected 'port' in error: {e}"


def test_workspace_egress_hosts_rejects_invalid_hostname():
    """WORKSPACE_EGRESS_HOSTS with leading/trailing/consecutive dots must raise ValueError."""
    for bad in [".cliproxy.fro.bot", "cliproxy.fro.bot.", "cliproxy..fro.bot"]:
        try:
            _load_allowlist({"WORKSPACE_EGRESS_HOSTS": bad})
            assert False, f"Expected ValueError for '{bad}'"
        except ValueError as e:
            assert bad in str(e) or "hostname" in str(e).lower(), (
                f"Expected entry name or 'hostname' in error for '{bad}': {e}"
            )


def test_workspace_egress_hosts_and_object_store_hosts_both_present():
    """Both OBJECT_STORE_HOSTS and WORKSPACE_EGRESS_HOSTS set → both in ALLOWLIST."""
    mod = _load_allowlist({
        "OBJECT_STORE_HOSTS": "my-bucket.s3.amazonaws.com",
        "WORKSPACE_EGRESS_HOSTS": "cliproxy.fro.bot",
    })
    assert "my-bucket.s3.amazonaws.com" in mod.ALLOWLIST
    assert "cliproxy.fro.bot" in mod.ALLOWLIST
    assert mod._is_allowed("my-bucket.s3.amazonaws.com") is True
    assert mod._is_allowed("cliproxy.fro.bot") is True


def test_workspace_egress_hosts_only_does_not_affect_object_store():
    """Setting only WORKSPACE_EGRESS_HOSTS does not add object-store hosts."""
    mod = _load_allowlist({"WORKSPACE_EGRESS_HOSTS": "cliproxy.fro.bot"})
    assert "my-bucket.s3.amazonaws.com" not in mod.ALLOWLIST
    assert mod._is_allowed("attacker-bucket.s3.amazonaws.com") is False


def test_object_store_hosts_only_does_not_affect_workspace_egress():
    """Setting only OBJECT_STORE_HOSTS does not add workspace-egress hosts."""
    mod = _load_allowlist({"OBJECT_STORE_HOSTS": "my-bucket.s3.amazonaws.com"})
    assert "cliproxy.fro.bot" not in mod.ALLOWLIST
    assert mod._is_allowed("cliproxy.fro.bot") is False


# ===========================================================================
# DNS-rebinding defense — resolved-IP validation at enforcement time
# ===========================================================================


def _load_allowlist_with_socket_mock(extra_env, getaddrinfo_side_effect):
    """Load allowlist with env overrides and a mocked socket.getaddrinfo.

    Returns (mod, socket_mock) so tests can inspect call counts.
    """
    import unittest.mock as mock

    mod = _load_allowlist(extra_env)
    socket_mock = mock.MagicMock()
    socket_mock.getaddrinfo.side_effect = getaddrinfo_side_effect
    mod.socket = socket_mock
    return mod, socket_mock


def _make_flow_with_response(host: str, peername: str = "10.0.0.1:12345"):
    """Build a mock flow that properly tracks response assignment."""
    flow = MagicMock()
    flow.request.host = host
    flow.client_conn.peername = peername
    # Track response assignment via a real attribute
    flow.response = None
    return flow


def test_dns_rebinding_operator_host_public_ip_allowed():
    """Operator-supplied host resolving to a public IP is allowed through."""
    import unittest.mock as mock

    mod = _load_allowlist({"WORKSPACE_EGRESS_HOSTS": "cliproxy.fro.bot"})
    # getaddrinfo returns a public IP (8.8.8.8)
    mod.socket = mock.MagicMock()
    mod.socket.getaddrinfo.return_value = [
        (None, None, None, None, ("8.8.8.8", 0))
    ]
    addon = mod.AllowlistAddon()
    flow = _make_flow_with_response("cliproxy.fro.bot")
    addon.http_connect(flow)
    # Should NOT be blocked — response stays None
    assert flow.response is None


def test_dns_rebinding_operator_host_loopback_blocked():
    """Operator-supplied host resolving to 127.0.0.1 is rejected with 403."""
    import unittest.mock as mock

    _reset_response_mock()
    mod = _load_allowlist({"WORKSPACE_EGRESS_HOSTS": "cliproxy.fro.bot"})
    mod.socket = mock.MagicMock()
    mod.socket.getaddrinfo.return_value = [
        (None, None, None, None, ("127.0.0.1", 0))
    ]
    addon = mod.AllowlistAddon()
    flow = _make_flow_with_response("cliproxy.fro.bot")
    addon.http_connect(flow)
    assert flow.response is not None
    mitmproxy_http_mock.Response.make.assert_called_once()
    call_args = mitmproxy_http_mock.Response.make.call_args
    assert call_args[0][0] == 403


def test_dns_rebinding_operator_host_private_10_blocked():
    """Operator-supplied host resolving to 10.0.0.5 is rejected with 403."""
    import unittest.mock as mock

    _reset_response_mock()
    mod = _load_allowlist({"WORKSPACE_EGRESS_HOSTS": "cliproxy.fro.bot"})
    mod.socket = mock.MagicMock()
    mod.socket.getaddrinfo.return_value = [
        (None, None, None, None, ("10.0.0.5", 0))
    ]
    addon = mod.AllowlistAddon()
    flow = _make_flow_with_response("cliproxy.fro.bot")
    addon.http_connect(flow)
    assert flow.response is not None
    call_args = mitmproxy_http_mock.Response.make.call_args
    assert call_args[0][0] == 403


def test_dns_rebinding_operator_host_link_local_blocked():
    """Operator-supplied host resolving to 169.254.169.254 is rejected with 403."""
    import unittest.mock as mock

    _reset_response_mock()
    mod = _load_allowlist({"WORKSPACE_EGRESS_HOSTS": "cliproxy.fro.bot"})
    mod.socket = mock.MagicMock()
    mod.socket.getaddrinfo.return_value = [
        (None, None, None, None, ("169.254.169.254", 0))
    ]
    addon = mod.AllowlistAddon()
    flow = _make_flow_with_response("cliproxy.fro.bot")
    addon.http_connect(flow)
    assert flow.response is not None
    call_args = mitmproxy_http_mock.Response.make.call_args
    assert call_args[0][0] == 403


def test_dns_rebinding_operator_host_ipv6_loopback_blocked():
    """Operator-supplied host resolving to ::1 is rejected with 403."""
    import unittest.mock as mock

    _reset_response_mock()
    mod = _load_allowlist({"WORKSPACE_EGRESS_HOSTS": "cliproxy.fro.bot"})
    mod.socket = mock.MagicMock()
    mod.socket.getaddrinfo.return_value = [
        (None, None, None, None, ("::1", 0))
    ]
    addon = mod.AllowlistAddon()
    flow = _make_flow_with_response("cliproxy.fro.bot")
    addon.http_connect(flow)
    assert flow.response is not None
    call_args = mitmproxy_http_mock.Response.make.call_args
    assert call_args[0][0] == 403


def test_dns_rebinding_any_private_record_blocks():
    """Multiple A-records where ANY is private → rejected."""
    import unittest.mock as mock

    _reset_response_mock()
    mod = _load_allowlist({"WORKSPACE_EGRESS_HOSTS": "cliproxy.fro.bot"})
    mod.socket = mock.MagicMock()
    # First record is public, second is private
    mod.socket.getaddrinfo.return_value = [
        (None, None, None, None, ("8.8.8.8", 0)),
        (None, None, None, None, ("10.0.0.5", 0)),
    ]
    addon = mod.AllowlistAddon()
    flow = _make_flow_with_response("cliproxy.fro.bot")
    addon.http_connect(flow)
    assert flow.response is not None
    call_args = mitmproxy_http_mock.Response.make.call_args
    assert call_args[0][0] == 403


def test_dns_rebinding_all_public_records_allowed():
    """Multiple A-records where ALL are public → operator-supplied host is allowed through."""
    import unittest.mock as mock

    mod = _load_allowlist({"WORKSPACE_EGRESS_HOSTS": "cliproxy.fro.bot"})
    mod.socket = mock.MagicMock()
    # Both records are public — no private address in the set
    mod.socket.getaddrinfo.return_value = [
        (None, None, None, None, ("8.8.8.8", 0)),
        (None, None, None, None, ("1.1.1.1", 0)),
    ]
    addon = mod.AllowlistAddon()
    flow = _make_flow_with_response("cliproxy.fro.bot")
    addon.http_connect(flow)
    # Should NOT be blocked — response stays None
    assert flow.response is None


def test_dns_rebinding_vendor_host_not_resolved():
    """Vendor static-ALLOWLIST host (github.com) is NOT resolved-checked."""
    import unittest.mock as mock

    _reset_response_mock()
    mod = _load_allowlist()
    socket_mock = mock.MagicMock()
    mod.socket = socket_mock
    addon = mod.AllowlistAddon()
    flow = _make_flow_with_response("github.com")
    addon.http_connect(flow)
    # github.com is in the static list, not operator-supplied → no getaddrinfo call
    socket_mock.getaddrinfo.assert_not_called()
    assert flow.response is None


def test_dns_rebinding_resolution_failure_blocks():
    """Resolution failure for an operator-supplied host → fail closed (403)."""
    import unittest.mock as mock
    import socket as real_socket

    _reset_response_mock()
    mod = _load_allowlist({"WORKSPACE_EGRESS_HOSTS": "cliproxy.fro.bot"})
    mod.socket = mock.MagicMock()
    mod.socket.gaierror = real_socket.gaierror
    mod.socket.getaddrinfo.side_effect = real_socket.gaierror("resolution failed")
    addon = mod.AllowlistAddon()
    flow = _make_flow_with_response("cliproxy.fro.bot")
    addon.http_connect(flow)
    assert flow.response is not None
    call_args = mitmproxy_http_mock.Response.make.call_args
    assert call_args[0][0] == 403


def test_dns_rebinding_timeout_blocks():
    """socket.timeout during resolution for an operator-supplied host → fail closed (403)."""
    import unittest.mock as mock
    import socket as real_socket

    _reset_response_mock()
    mod = _load_allowlist({"WORKSPACE_EGRESS_HOSTS": "cliproxy.fro.bot"})
    mod.socket = mock.MagicMock()
    mod.socket.getaddrinfo.side_effect = real_socket.timeout("timed out")
    addon = mod.AllowlistAddon()
    flow = _make_flow_with_response("cliproxy.fro.bot")
    addon.http_connect(flow)
    assert flow.response is not None
    call_args = mitmproxy_http_mock.Response.make.call_args
    assert call_args[0][0] == 403


def test_dns_rebinding_oserror_blocks():
    """Generic OSError during resolution for an operator-supplied host → fail closed (403)."""
    import unittest.mock as mock

    _reset_response_mock()
    mod = _load_allowlist({"WORKSPACE_EGRESS_HOSTS": "cliproxy.fro.bot"})
    mod.socket = mock.MagicMock()
    mod.socket.getaddrinfo.side_effect = OSError("network unreachable")
    addon = mod.AllowlistAddon()
    flow = _make_flow_with_response("cliproxy.fro.bot")
    addon.http_connect(flow)
    assert flow.response is not None
    call_args = mitmproxy_http_mock.Response.make.call_args
    assert call_args[0][0] == 403


def test_dns_rebinding_object_store_host_also_checked():
    """Operator-supplied OBJECT_STORE_HOSTS host resolving to private IP is blocked."""
    import unittest.mock as mock

    _reset_response_mock()
    mod = _load_allowlist({"OBJECT_STORE_HOSTS": "my-bucket.s3.amazonaws.com"})
    mod.socket = mock.MagicMock()
    mod.socket.getaddrinfo.return_value = [
        (None, None, None, None, ("10.0.0.5", 0))
    ]
    addon = mod.AllowlistAddon()
    flow = _make_flow_with_response("my-bucket.s3.amazonaws.com")
    addon.http_connect(flow)
    assert flow.response is not None
    call_args = mitmproxy_http_mock.Response.make.call_args
    assert call_args[0][0] == 403


def test_dns_rebinding_request_hook_also_enforced():
    """DNS-rebinding check applies to the request hook (plain HTTP), not just http_connect."""
    import unittest.mock as mock

    _reset_response_mock()
    mod = _load_allowlist({"WORKSPACE_EGRESS_HOSTS": "cliproxy.fro.bot"})
    mod.socket = mock.MagicMock()
    mod.socket.getaddrinfo.return_value = [
        (None, None, None, None, ("127.0.0.1", 0))
    ]
    addon = mod.AllowlistAddon()
    flow = _make_flow_with_response("cliproxy.fro.bot")
    addon.request(flow)
    assert flow.response is not None
    call_args = mitmproxy_http_mock.Response.make.call_args
    assert call_args[0][0] == 403


# ===========================================================================
# NAT64 Well-Known Prefix (64:ff9b::/96) embedded-IPv4 bypass — RFC 6052
# ===========================================================================


def test_ip_is_disallowed_nat64_embeds_rfc1918_10():
    """64:ff9b::a00:1 embeds 10.0.0.1 (RFC 1918) — must be disallowed."""
    mod = _load_allowlist()
    assert mod._ip_is_disallowed("64:ff9b::a00:1") is True


def test_ip_is_disallowed_nat64_embeds_loopback():
    """64:ff9b::7f00:1 embeds 127.0.0.1 (loopback) — must be disallowed."""
    mod = _load_allowlist()
    assert mod._ip_is_disallowed("64:ff9b::7f00:1") is True


def test_ip_is_disallowed_nat64_embeds_link_local():
    """64:ff9b::a9fe:1 embeds 169.254.0.1 (link-local) — must be disallowed."""
    mod = _load_allowlist()
    assert mod._ip_is_disallowed("64:ff9b::a9fe:1") is True


def test_ip_is_disallowed_nat64_embeds_cgnat():
    """64:ff9b::6440:1 embeds 100.64.0.1 (CGNAT / RFC 6598) — must be disallowed."""
    mod = _load_allowlist()
    assert mod._ip_is_disallowed("64:ff9b::6440:1") is True


def test_ip_is_disallowed_nat64_embeds_public_allowed():
    """64:ff9b::808:808 embeds 8.8.8.8 (public) — must NOT be disallowed."""
    mod = _load_allowlist()
    assert mod._ip_is_disallowed("64:ff9b::808:808") is False


def test_ip_is_disallowed_nat64_regression_6to4_still_blocked():
    """2002:0a00:0001:: (6to4 embedding 10.0.0.1) — already blocked, must stay True."""
    mod = _load_allowlist()
    assert mod._ip_is_disallowed("2002:0a00:0001::") is True


def test_ip_is_disallowed_nat64_regression_v4mapped_still_blocked():
    """::ffff:10.0.0.1 (v4-mapped) — already blocked, must stay True."""
    mod = _load_allowlist()
    assert mod._ip_is_disallowed("::ffff:10.0.0.1") is True


def test_ip_is_disallowed_nat64_regression_rfc8215_still_blocked():
    """64:ff9b:1::a00:1 (RFC 8215 local NAT64 prefix) — already blocked, must stay True."""
    mod = _load_allowlist()
    assert mod._ip_is_disallowed("64:ff9b:1::a00:1") is True


def test_ip_is_disallowed_nat64_regression_public_ipv6_allowed():
    """2606:4700::1111 (Cloudflare public IPv6) — must NOT be disallowed."""
    mod = _load_allowlist()
    assert mod._ip_is_disallowed("2606:4700::1111") is False


def test_ip_is_disallowed_nat64_embeds_private_172():
    """64:ff9b::ac10:1 embeds 172.16.0.1 (RFC 1918) — must be disallowed."""
    mod = _load_allowlist()
    assert mod._ip_is_disallowed("64:ff9b::ac10:1") is True


def test_ip_is_disallowed_nat64_embeds_private_192_168():
    """64:ff9b::c0a8:101 embeds 192.168.1.1 (RFC 1918) — must be disallowed."""
    mod = _load_allowlist()
    assert mod._ip_is_disallowed("64:ff9b::c0a8:101") is True


# ===========================================================================
# IPv4-compatible IPv6 addresses (::/96) embedded-IPv4 bypass — RFC 4291 §2.5.5.1
# ===========================================================================


def test_ip_is_disallowed_ipv4compat_embeds_rfc1918_10():
    """::10.0.0.1 (::a00:1) embeds 10.0.0.1 (RFC 1918) — must be disallowed."""
    mod = _load_allowlist()
    assert mod._ip_is_disallowed("::a00:1") is True


def test_ip_is_disallowed_ipv4compat_embeds_loopback():
    """::127.0.0.1 (::7f00:1) embeds 127.0.0.1 (loopback) — must be disallowed."""
    mod = _load_allowlist()
    assert mod._ip_is_disallowed("::7f00:1") is True


def test_ip_is_disallowed_ipv4compat_embeds_link_local():
    """::169.254.0.1 (::a9fe:1) embeds 169.254.0.1 (link-local) — must be disallowed."""
    mod = _load_allowlist()
    assert mod._ip_is_disallowed("::a9fe:1") is True


def test_ip_is_disallowed_ipv4compat_embeds_public_allowed():
    """::8.8.8.8 (::808:808) embeds 8.8.8.8 (public) — must NOT be disallowed."""
    mod = _load_allowlist()
    assert mod._ip_is_disallowed("::808:808") is False


def test_ip_is_disallowed_ipv4compat_regression_loopback_still_blocked():
    """::1 (IPv6 loopback) — already is_global=False, must stay True (unaffected)."""
    mod = _load_allowlist()
    assert mod._ip_is_disallowed("::1") is True


def test_ip_is_disallowed_ipv4compat_regression_unspecified_still_blocked():
    """:: (unspecified) — already is_global=False, must stay True (unaffected)."""
    mod = _load_allowlist()
    assert mod._ip_is_disallowed("::") is True


def test_ip_is_disallowed_ipv4compat_regression_v4mapped_still_blocked():
    """::ffff:10.0.0.1 (v4-mapped, ::ffff:0:0/96) — different prefix, already blocked."""
    mod = _load_allowlist()
    assert mod._ip_is_disallowed("::ffff:10.0.0.1") is True


def test_ip_is_disallowed_nat64_wkp_network_address_blocked():
    """64:ff9b:: (NAT64 WKP network address, embeds 0.0.0.0) — must be disallowed."""
    mod = _load_allowlist()
    assert mod._ip_is_disallowed("64:ff9b::") is True


def test_ip_is_disallowed_public_ipv6_outside_nat64_allowed():
    """2606:4700::1111 (Cloudflare public IPv6, outside NAT64/compat prefixes) — must NOT be disallowed."""
    mod = _load_allowlist()
    assert mod._ip_is_disallowed("2606:4700::1111") is False


# ===========================================================================
# Standalone runner (no pytest required)
# ===========================================================================

if __name__ == "__main__":
    import traceback

    tests = [
        obj for name, obj in sorted(globals().items())
        if name.startswith("test_") and callable(obj)
    ]

    passed = 0
    failed = 0
    for t in tests:
        try:
            t()
            print(f"  PASS  {t.__name__}")
            passed += 1
        except Exception:
            print(f"  FAIL  {t.__name__}")
            traceback.print_exc()
            failed += 1

    print(f"\n{passed} passed, {failed} failed")
    sys.exit(0 if failed == 0 else 1)
