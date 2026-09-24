#!/usr/bin/env bash
# deploy/tests/isolation-harness.sh
#
# Real-container acceptance harness for the workspace-agent uid isolation
# hardening (apps/workspace-agent/src/identity.ts + deploy/workspace.Dockerfile
# + deploy/compose.yaml + deploy/workspace-entrypoint.sh + deploy/scripts/*).
#
# Docker is not available in dev machines used on this branch, so THIS SCRIPT,
# run in CI against a real container, is the only place the security claims in
# the uid-isolation commits get proven. It is deliberately NOT inline CI YAML
# so it can also be run by hand against a Docker host.
#
# Every "must fail" property below is proven by actually attempting the
# violation and asserting it fails — never by reading source and assuming.
# Every such attempt has an explicit POSITIVE CONTROL: the same operation is
# also shown to succeed as root (or in an otherwise-permitted context), so a
# denial can never pass "for the wrong reason" (wrong path, wrong command,
# image doesn't have the tool, etc.) A prior security review in this repo
# shipped tests that passed for the wrong reason; this structure is the guard
# against repeating that.
#
# Every container is started with EXACTLY the security settings
# deploy/compose.yaml gives the `workspace` service in production (user,
# capabilities, no-new-privileges, protected tmpfs) — a harness that runs with
# more privilege than production doesn't prove production works.
#
# Exit behavior: exits non-zero on the FIRST violated property, printing a
# message naming that property. Containers and volumes are removed on every
# exit path via trap.
#
# Usage: WORKSPACE_IMAGE=fro-bot-workspace:smoke deploy/tests/isolation-harness.sh

set -euo pipefail

IMAGE="${WORKSPACE_IMAGE:-fro-bot-workspace:smoke}"

# ── bounded waits ────────────────────────────────────────────────────────────
HEALTHY_TIMEOUT_S="${ISOLATION_HARNESS_HEALTHY_TIMEOUT_S:-60}"
EXEC_TIMEOUT_S="${ISOLATION_HARNESS_EXEC_TIMEOUT_S:-15}"
SHUTDOWN_TIMEOUT_S="${ISOLATION_HARNESS_SHUTDOWN_TIMEOUT_S:-30}"
MIGRATION_HEALTHY_TIMEOUT_S="${ISOLATION_HARNESS_MIGRATION_TIMEOUT_S:-90}"

AGENT_UID=10001
AGENT_GID=10001

# Production security posture (deploy/compose.yaml `workspace` service, exact
# mirror — see deploy/README.md "Workspace uid isolation").
# shellcheck disable=SC2054 # the commas below are inside the --tmpfs VALUE, not array-element separators
WORKSPACE_SECURITY_ARGS=(
  --user 0:0
  --cap-drop ALL
  --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --cap-add SETUID --cap-add SETGID --cap-add KILL
  --security-opt no-new-privileges:true
  --tmpfs /run/workspace-agent:rw,nosuid,nodev,mode=0700,uid=0,gid=0
)

# ── cleanup bookkeeping ──────────────────────────────────────────────────────
CONTAINERS=()
VOLUMES=()
TMPFILES=()
PROPERTY_COUNT=0

cleanup() {
  local rc=$?
  set +e
  for c in "${CONTAINERS[@]:-}"; do
    [ -n "$c" ] && docker rm -f "$c" >/dev/null 2>&1
  done
  for v in "${VOLUMES[@]:-}"; do
    [ -n "$v" ] && docker volume rm -f "$v" >/dev/null 2>&1
  done
  for f in "${TMPFILES[@]:-}"; do
    [ -n "$f" ] && rm -f "$f"
  done
  if [ "$rc" -eq 0 ]; then
    echo "[isolation-harness] all ${PROPERTY_COUNT} properties verified — cleanup complete"
  else
    echo "[isolation-harness] exiting rc=${rc} — cleanup complete" >&2
  fi
  exit "$rc"
}
trap cleanup EXIT INT TERM

log() { echo "[isolation-harness] $*"; }

fail() {
  echo "" >&2
  echo "FAIL: $1" >&2
  echo "" >&2
  exit 1
}

pass() {
  PROPERTY_COUNT=$((PROPERTY_COUNT + 1))
  log "OK (${PROPERTY_COUNT}): $1"
}

# run_exec <cid> <user-spec-or-empty> <cmd...>  — bounded docker exec, never hangs.
run_exec() {
  local cid="$1" user="$2"
  shift 2
  if [ -n "$user" ]; then
    timeout "${EXEC_TIMEOUT_S}" docker exec --user "$user" "$cid" "$@"
  else
    timeout "${EXEC_TIMEOUT_S}" docker exec "$cid" "$@"
  fi
}

# must_fail <property> <cid> <user-spec> <cmd...> — the denial half of a pair.
# Prints captured output to aid debugging but does not itself assert content.
must_fail() {
  local property="$1" cid="$2" user="$3"
  shift 3
  local out status
  set +e
  out="$(run_exec "$cid" "$user" "$@" 2>&1)"
  status=$?
  set -e
  if [ "$status" -eq 0 ]; then
    echo "--- unexpected success output ---" >&2
    echo "$out" >&2
    fail "${property}: expected denial (as ${user:-container default}), but the operation SUCCEEDED"
  fi
}

# must_succeed <property> <cid> <user-spec> <cmd...> — the positive-control half.
must_succeed() {
  local property="$1" cid="$2" user="$3"
  shift 3
  local out status
  set +e
  out="$(run_exec "$cid" "$user" "$@" 2>&1)"
  status=$?
  set -e
  if [ "$status" -ne 0 ]; then
    echo "--- unexpected failure output ---" >&2
    echo "$out" >&2
    fail "${property} (positive control): expected success (as ${user:-container default}), but the operation FAILED"
  fi
}

wait_for_healthz() {
  local cid="$1" timeout_s="$2"
  local ok=false
  for _ in $(seq 1 "$timeout_s"); do
    if timeout 3 docker exec "$cid" curl -fsS -o /dev/null http://127.0.0.1:9100/healthz 2>/dev/null; then
      ok=true
      break
    fi
    sleep 1
  done
  [ "$ok" = "true" ]
}

# ─────────────────────────────────────────────────────────────────────────────
# Phase 0: start the main long-lived container with production security
# settings, a real volume at /workspace/repos, and the secret/CA mounts nested
# under the protected tmpfs exactly as compose.yaml does.
# ─────────────────────────────────────────────────────────────────────────────
log "phase 0: starting main container (${IMAGE})"

MAIN_VOLUME="isolation-harness-repos-$$-${RANDOM}"
docker volume create "$MAIN_VOLUME" >/dev/null
VOLUMES+=("$MAIN_VOLUME")

TOKEN_FILE="$(mktemp)"
AUTH_FILE="$(mktemp)"
CA_FILE="$(mktemp)"
TMPFILES+=("$TOKEN_FILE" "$AUTH_FILE" "$CA_FILE")
printf 'isolation-harness-dummy-bearer-token' >"$TOKEN_FILE"
printf '{"anthropic":{"type":"api","key":"sk-isolation-harness-dummy"}}' >"$AUTH_FILE"
# Not a real certificate — this phase only proves the mount is VISIBLE at its
# new nested path (deploy/README.md's open question). CA *installation*
# correctness (update-ca-certificates parsing a real PEM) is exercised by the
# existing "Live egress containment smoke" step, not here.
printf -- '-----BEGIN CERTIFICATE-----\nisolation-harness-dummy-ca\n-----END CERTIFICATE-----\n' >"$CA_FILE"

MAIN_CID="$(docker run -d \
  "${WORKSPACE_SECURITY_ARGS[@]}" \
  -e WORKSPACE_OPENCODE_TOKEN_FILE=/run/workspace-agent/secrets/workspace_opencode_token \
  -e WORKSPACE_OPENCODE_AUTH_FILE=/run/workspace-agent/secrets/workspace_opencode_auth \
  -e MITMPROXY_CA_PATH=/run/workspace-agent/mitmproxy/mitmproxy-ca-cert.pem \
  -e MITMPROXY_CA_OPTIONAL=true \
  -e NO_PROXY='*' \
  -v "${TOKEN_FILE}:/run/workspace-agent/secrets/workspace_opencode_token:ro" \
  -v "${AUTH_FILE}:/run/workspace-agent/secrets/workspace_opencode_auth:ro" \
  -v "${CA_FILE}:/run/workspace-agent/mitmproxy/mitmproxy-ca-cert.pem:ro" \
  -v "${MAIN_VOLUME}:/workspace/repos" \
  "$IMAGE")"
CONTAINERS+=("$MAIN_CID")

if ! wait_for_healthz "$MAIN_CID" "$HEALTHY_TIMEOUT_S"; then
  echo "--- container logs ---" >&2
  docker logs "$MAIN_CID" 2>&1 >&2 || true
  fail "startup: container did not become healthy within ${HEALTHY_TIMEOUT_S}s"
fi
pass "container boots healthy with production security settings"

# ─────────────────────────────────────────────────────────────────────────────
# Phase 1: identity
# ─────────────────────────────────────────────────────────────────────────────
log "phase 1: identity"

if ! svc_status="$(run_exec "$MAIN_CID" "" cat /proc/1/status)"; then
  fail "identity: could not read /proc/1/status (workspace-agent service)"
fi
svc_uid_line="$(echo "$svc_status" | grep '^Uid:')"
svc_gid_line="$(echo "$svc_status" | grep '^Gid:')"
echo "$svc_uid_line" | awk '{print $2}' | grep -qx '0' || fail "identity: workspace-agent service (pid 1) real uid is not 0 (${svc_uid_line})"
echo "$svc_gid_line" | awk '{print $2}' | grep -qx '0' || fail "identity: workspace-agent service (pid 1) real gid is not 0 (${svc_gid_line})"
pass "workspace agent service (pid 1) runs as uid/gid 0:0"

# OpenCode's pid, found INSIDE the container's own pid namespace (pidof runs
# via docker exec, so PIDs are already container-relative — no host/container
# translation needed).
set +e
OC_PID="$(run_exec "$MAIN_CID" "" pidof opencode | awk '{print $1}')"
set -e
[ -n "$OC_PID" ] || fail "identity: could not find the opencode process (pidof opencode returned nothing — is 'pidof' present in this image's busybox build?)"

if ! oc_status="$(run_exec "$MAIN_CID" "" cat "/proc/${OC_PID}/status")"; then
  fail "identity: could not read /proc/${OC_PID}/status (OpenCode) as root — unexpected: this file is not ptrace-gated, only environ/mem are"
fi
oc_uid_line="$(echo "$oc_status" | grep '^Uid:')"
oc_gid_line="$(echo "$oc_status" | grep '^Gid:')"
oc_groups_line="$(echo "$oc_status" | grep '^Groups:')"
oc_capeff_line="$(echo "$oc_status" | grep '^CapEff:')"
oc_capprm_line="$(echo "$oc_status" | grep '^CapPrm:')"
oc_capamb_line="$(echo "$oc_status" | grep '^CapAmb:')"
oc_nnp_line="$(echo "$oc_status" | grep '^NoNewPrivs:')"

for tok in $(echo "$oc_uid_line" | awk '{print $2, $3, $4}'); do
  [ "$tok" = "10001" ] || fail "identity: OpenCode uid line is not all 10001 (${oc_uid_line})"
done
for tok in $(echo "$oc_gid_line" | awk '{print $2, $3, $4}'); do
  [ "$tok" = "10001" ] || fail "identity: OpenCode gid line is not all 10001 (${oc_gid_line})"
done
pass "OpenCode process runs as uid/gid 10001:10001 (real/effective/saved)"

if echo "$oc_groups_line" | grep -qwE '(^|[[:space:]])0([[:space:]]|$)'; then
  fail "identity: OpenCode's supplementary Groups: line contains gid 0 (root) — ${oc_groups_line}"
fi
pass "OpenCode's Groups: line contains no gid 0"

echo "$oc_capeff_line" | grep -qiE 'CapEff:[[:space:]]*0+$' || fail "identity: OpenCode CapEff is not all-zero (${oc_capeff_line})"
echo "$oc_capprm_line" | grep -qiE 'CapPrm:[[:space:]]*0+$' || fail "identity: OpenCode CapPrm is not all-zero (${oc_capprm_line})"
echo "$oc_capamb_line" | grep -qiE 'CapAmb:[[:space:]]*0+$' || fail "identity: OpenCode CapAmb is not all-zero (${oc_capamb_line})"
pass "OpenCode CapEff/CapPrm/CapAmb are all zero"

echo "$oc_nnp_line" | grep -qE 'NoNewPrivs:[[:space:]]*1$' || fail "identity: OpenCode NoNewPrivs is not 1 (${oc_nnp_line})"
pass "OpenCode NoNewPrivs is 1"

# Record-only (never asserted): ptrace_scope, /proc mount options, service CapEff.
ptrace_scope="$(run_exec "$MAIN_CID" "" sh -c 'cat /proc/sys/kernel/yama/ptrace_scope 2>/dev/null || echo "(not present — Yama LSM not active on host kernel)"')"
proc_mount_opts="$(run_exec "$MAIN_CID" "" sh -c "grep '^proc ' /proc/mounts || echo '(no explicit proc mount line found)'")"
svc_capeff_line="$(echo "$svc_status" | grep '^CapEff:')"
log "RECORD (not asserted) /proc/sys/kernel/yama/ptrace_scope: ${ptrace_scope}"
log "RECORD (not asserted) /proc mount line: ${proc_mount_opts}"
log "RECORD (not asserted) workspace-agent service CapEff: ${svc_capeff_line}"

# ─────────────────────────────────────────────────────────────────────────────
# Phase 2: denials, run as uid 10001 (docker exec --user 10001:10001 — no
# new privilege is added by exec itself; no-new-privileges was already set at
# `docker run` time and is inherited by every descendant).
# ─────────────────────────────────────────────────────────────────────────────
log "phase 2: denials as uid 10001"

AGENT_USER="${AGENT_UID}:${AGENT_GID}"

must_fail "cannot list /var/lib/workspace-agent/home" "$MAIN_CID" "$AGENT_USER" ls /var/lib/workspace-agent/home
must_succeed "cannot list /var/lib/workspace-agent/home" "$MAIN_CID" "0:0" ls /var/lib/workspace-agent/home
pass "uid 10001 cannot list /var/lib/workspace-agent/home (root can)"

must_fail "cannot list /run/workspace-agent" "$MAIN_CID" "$AGENT_USER" ls /run/workspace-agent
must_succeed "cannot list /run/workspace-agent" "$MAIN_CID" "0:0" ls /run/workspace-agent
pass "uid 10001 cannot list /run/workspace-agent (root can)"

must_fail "cannot read /run/workspace-agent/secrets/workspace_opencode_token" "$MAIN_CID" "$AGENT_USER" \
  cat /run/workspace-agent/secrets/workspace_opencode_token
must_succeed "cannot read /run/workspace-agent/secrets/workspace_opencode_token" "$MAIN_CID" "0:0" \
  cat /run/workspace-agent/secrets/workspace_opencode_token
pass "uid 10001 cannot read /run/workspace-agent/secrets/workspace_opencode_token (root can)"

must_fail "cannot read /run/workspace-agent/secrets/workspace_opencode_auth" "$MAIN_CID" "$AGENT_USER" \
  cat /run/workspace-agent/secrets/workspace_opencode_auth
must_succeed "cannot read /run/workspace-agent/secrets/workspace_opencode_auth" "$MAIN_CID" "0:0" \
  cat /run/workspace-agent/secrets/workspace_opencode_auth
pass "uid 10001 cannot read /run/workspace-agent/secrets/workspace_opencode_auth (root can)"

must_fail "cannot list /workspace/repos/.workspace-agent" "$MAIN_CID" "$AGENT_USER" ls /workspace/repos/.workspace-agent
must_succeed "cannot list /workspace/repos/.workspace-agent" "$MAIN_CID" "0:0" ls /workspace/repos/.workspace-agent
pass "uid 10001 cannot list /workspace/repos/.workspace-agent (root can)"

must_fail "cannot write the service's global git config" "$MAIN_CID" "$AGENT_USER" \
  sh -c 'echo "[user] name = hostile" > /var/lib/workspace-agent/home/.gitconfig'
must_succeed "cannot write the service's global git config" "$MAIN_CID" "0:0" \
  sh -c 'echo "[user] name = harness-positive-control" > /var/lib/workspace-agent/home/.gitconfig && rm -f /var/lib/workspace-agent/home/.gitconfig'
pass "uid 10001 cannot write /var/lib/workspace-agent/home/.gitconfig (root can)"

# ── /proc/<pid>/environ of a live root process holding a secret ────────────
# `docker exec -d` is Docker's own documented detached-exec mode: the spawned
# process is NOT tied to this docker-exec client's lifetime (unlike a plain
# `docker exec ... &` backgrounded in this script, which would race the
# `timeout` wrapper in run_exec killing the client). `exec env VAR=... sleep
# N`: env(1) execve()s sleep directly (no extra fork), and the outer shell
# already `exec`'d into env, so the pid captured via `$$` before the exec is
# the SAME pid that ends up running `sleep` with the dummy token in its
# environment (execve never changes pid).
DUMMY_TOKEN="ghs_isolationHarnessDUMMYtoken1234567890"
docker exec -d --user 0:0 "$MAIN_CID" sh -c \
  "echo \$\$ > /tmp/isolation-harness-secret-holder.pid; exec env GITHUB_TOKEN=${DUMMY_TOKEN} sleep 600"
# Bounded wait for the detached exec to actually land the pid file.
secret_pid_ready=false
for _ in $(seq 1 20); do
  if run_exec "$MAIN_CID" "0:0" test -f /tmp/isolation-harness-secret-holder.pid; then
    secret_pid_ready=true
    break
  fi
  sleep 0.5
done
[ "$secret_pid_ready" = "true" ] || fail "setup: dummy secret-holder process never wrote its pid file"
SECRET_PID="$(run_exec "$MAIN_CID" "0:0" cat /tmp/isolation-harness-secret-holder.pid | tr -d '[:space:]')"
[ -n "$SECRET_PID" ] || fail "setup: could not determine pid of the dummy secret-holder process"
must_succeed "root can read the dummy secret-holder's environ (setup sanity check)" "$MAIN_CID" "0:0" \
  sh -c "grep -q GITHUB_TOKEN /proc/${SECRET_PID}/environ"

# /proc/<pid>/mem probes use `dd ... count=0`, deliberately: dd still open()s
# the file (where the kernel's ptrace_may_access() permission gate actually
# lives, in proc_mem_open()) but issues ZERO read() calls. A real read() at
# offset 0 would fail with EIO (unmapped guard page) for EVERYONE, including
# root — that unrelated I/O failure is not the property under test and would
# make a positive control fail for the wrong reason. count=0 isolates exactly
# the open()-time permission check.
secret_env_out=""
set +e
secret_env_out="$(run_exec "$MAIN_CID" "$AGENT_USER" cat "/proc/${SECRET_PID}/environ" 2>&1)"
secret_env_status=$?
secret_mem_out="$(run_exec "$MAIN_CID" "$AGENT_USER" sh -c "dd if=/proc/${SECRET_PID}/mem of=/dev/null bs=1 count=0 2>&1")"
secret_mem_status=$?
secret_fd_out="$(run_exec "$MAIN_CID" "$AGENT_USER" ls -la "/proc/${SECRET_PID}/fd" 2>&1)"
secret_fd_status=$?
set -e
[ "$secret_env_status" -ne 0 ] || fail "denial: uid 10001 could read /proc/${SECRET_PID}/environ of a root process holding a secret"
[ "$secret_mem_status" -ne 0 ] || fail "denial: uid 10001 could read /proc/${SECRET_PID}/mem of a root process holding a secret"
[ "$secret_fd_status" -ne 0 ] || fail "denial: uid 10001 could list /proc/${SECRET_PID}/fd of a root process holding a secret"
if printf '%s%s%s' "$secret_env_out" "$secret_mem_out" "$secret_fd_out" | grep -qF "$DUMMY_TOKEN"; then
  fail "denial: the dummy GITHUB_TOKEN leaked into environ/mem/fd output despite the operations failing"
fi
pass "uid 10001 cannot read environ/mem/fd of a root process holding a secret, and the secret never leaks into output"

# ── workspace agent's own /proc/1/environ (holds WORKSPACE_OPENCODE_TOKEN_FILE
# and, via config.ts's file-read path, is where a plain (non-_FILE) secret
# value would land if ever passed that way) ─────────────────────────────────
must_succeed "root can read its own /proc/1/environ (setup sanity check)" "$MAIN_CID" "0:0" cat /proc/1/environ
must_fail "cannot read the workspace agent's own /proc/1/environ" "$MAIN_CID" "$AGENT_USER" cat /proc/1/environ
pass "uid 10001 cannot read the workspace agent service's own /proc/1/environ"

# ── ptrace attach / process_vm_readv proxy ──────────────────────────────────
# The image ships neither gdb nor strace (deploy/workspace.Dockerfile's final
# stage apk-installs only git/ca-certificates/libgcc/libstdc++/ripgrep/curl/
# setpriv — no debugger, no C toolchain to compile a raw-syscall program).
# Node IS present (it is the runtime the supervisor itself execs). Node's
# stdlib has no ptrace(2)/process_vm_readv(2) binding, so this harness uses
# the kernel's OWN equivalence instead of a syscall wrapper: opening
# /proc/<pid>/mem for read, and ptrace(PTRACE_ATTACH)/process_vm_readv both
# go through the exact same kernel gate — __ptrace_may_access() with
# PTRACE_MODE_ATTACH — so a failed /proc/<pid>/mem open is not an analogy for
# "ptrace would also fail", it IS the same permission check ptrace(2) and
# process_vm_readv(2) perform internally. This was already exercised above
# against the dummy secret-holder (secret_mem_status); this block repeats it
# explicitly against the workspace agent's own pid so ptrace/process_vm_readv
# denial is proven against BOTH a synthetic target and the real supervisor.
must_succeed "root can open its own /proc/1/mem (setup sanity check)" "$MAIN_CID" "0:0" \
  sh -c 'dd if=/proc/1/mem of=/dev/null bs=1 count=0 2>&1'
must_fail "ptrace/process_vm_readv-equivalent access to the service's own memory" "$MAIN_CID" "$AGENT_USER" \
  sh -c 'dd if=/proc/1/mem of=/dev/null bs=1 count=0 2>&1'
pass "uid 10001 cannot open /proc/1/mem for read (same kernel gate as ptrace(PTRACE_ATTACH)/process_vm_readv against the service)"

# ── cannot replace the checkout directory itself (root-owned 0755 parent) ──
run_exec "$MAIN_CID" "0:0" sh -c \
  'mkdir -p /workspace/repos/acme/throwaway && echo x > /workspace/repos/acme/throwaway/f'
parent_mode="$(run_exec "$MAIN_CID" "0:0" stat -c '%u:%a' /workspace/repos/acme)"
[ "$parent_mode" = "0:755" ] || fail "setup: /workspace/repos/acme is ${parent_mode}, expected 0:755 (owner dirs must stay root-owned 0755)"
must_fail "cannot rename the checkout directory" "$MAIN_CID" "$AGENT_USER" \
  mv /workspace/repos/acme/throwaway /workspace/repos/acme/throwaway-renamed
must_fail "cannot remove the checkout directory" "$MAIN_CID" "$AGENT_USER" \
  rm -rf /workspace/repos/acme/throwaway
must_succeed "cannot remove the checkout directory" "$MAIN_CID" "0:0" \
  rm -rf /workspace/repos/acme/throwaway
pass "uid 10001 cannot rename or remove a checkout directory (root-owned 0755 parent blocks it; root can)"

# ── cannot bind 9100 or 9200 while the service holds them ──────────────────
# `timeout N nc -l -p PORT` inside the container disambiguates bind failure
# (nc exits nonzero immediately, status != 124) from bind SUCCESS-but-no-
# connection-arrived (nc/timeout would otherwise hang until run_exec's own
# EXEC_TIMEOUT_S killed the docker-exec client for an unrelated reason, which
# would make a positive control "fail" for the wrong reason).
assert_cannot_bind() {
  local property="$1" cid="$2" user="$3" port="$4"
  local out status
  set +e
  out="$(run_exec "$cid" "$user" sh -c "timeout 2 nc -l -p ${port} 2>&1")"
  status=$?
  set -e
  if [ "$status" -eq 124 ] || [ "$status" -eq 0 ]; then
    fail "${property}: uid ${user} appears to have BOUND port ${port} (status=${status}: 124=harness timeout killed a still-listening nc, 0=nc exited cleanly after accepting/timing out on an open listen) — output: ${out}"
  fi
  log "  bind attempt on :${port} failed as expected (status=${status}): ${out}"
}

assert_can_bind() {
  local property="$1" cid="$2" user="$3" port="$4"
  local out status
  set +e
  out="$(run_exec "$cid" "$user" sh -c "timeout 2 nc -l -p ${port} 2>&1")"
  status=$?
  set -e
  if [ "$status" -ne 0 ] && [ "$status" -ne 124 ]; then
    fail "${property} (positive control): uid ${user} could NOT bind port ${port} (status=${status}): ${out}"
  fi
}

assert_cannot_bind "cannot bind :9100 (already held by the service)" "$MAIN_CID" "$AGENT_USER" 9100
assert_cannot_bind "cannot bind :9200 (already held by the service)" "$MAIN_CID" "$AGENT_USER" 9200
# Positive control: uid 10001 CAN bind an ordinary unprivileged port — proves
# the two failures above are because 9100/9200 are TAKEN, not a blanket
# "10001 can never bind any port" restriction.
assert_can_bind "cannot bind :9100/:9200 (positive control — an unheld port binds fine)" "$MAIN_CID" "$AGENT_USER" 19191
pass "uid 10001 cannot bind :9100 or :9200 (already owned by the service); an unheld port binds fine as the same uid"
log "NOTE: this proves the ports are held BY THE TIME the container is healthy; it does not independently re-time the exact startup race — see report for how that maps to main.ts's awaited bind ordering."

# ─────────────────────────────────────────────────────────────────────────────
# Phase 3: allowed, as 10001
# ─────────────────────────────────────────────────────────────────────────────
log "phase 3: allowed operations as uid 10001"

run_exec "$MAIN_CID" "0:0" sh -c '
  set -e
  mkdir -p /workspace/repos/acme/owned-checkout
  chown 10001:10001 /workspace/repos/acme/owned-checkout
'
must_succeed "can read/write inside a checkout it owns" "$MAIN_CID" "$AGENT_USER" \
  sh -c 'echo hello > /workspace/repos/acme/owned-checkout/f.txt && grep -q hello /workspace/repos/acme/owned-checkout/f.txt'
pass "uid 10001 can read and write inside a checkout it owns"

must_succeed "can read the installed CA bundle" "$MAIN_CID" "$AGENT_USER" \
  sh -c 'test -s /etc/ssl/certs/ca-certificates.crt'
pass "uid 10001 can read the installed CA bundle"

# ─────────────────────────────────────────────────────────────────────────────
# Phase 4: service behavior
# ─────────────────────────────────────────────────────────────────────────────
log "phase 4: service behavior"

# A root-owned checkout (the SAME topology clone.ts currently produces, and
# the same topology every pre-migration legacy checkout has) proves the
# safe.directory scheme on a genuine cross-uid tree: git runs as 10001
# against files it does not own.
run_exec "$MAIN_CID" "0:0" sh -c '
  set -e
  mkdir -p /workspace/repos/acme/widgets
  cd /workspace/repos/acme/widgets
  git init -q
  git config user.email harness@isolation-harness.local
  git config user.name isolation-harness
  echo "hello" > README.md
  git add README.md
  git commit -q -m init
'
# curl is apk-installed in the runtime image (deploy/workspace.Dockerfile) for
# the SHA256SUMS fetch at build time, so it is always present here — no
# wget-availability fallback needed. curl -d auto-sets Content-Length, which
# POST /inspect requires (server.ts rejects a missing content-length header).
inspect_out="$(run_exec "$MAIN_CID" "0:0" sh -c "curl -sS -X POST -H 'Content-Type: application/json' -d '{\"owner\":\"acme\",\"repo\":\"widgets\"}' http://127.0.0.1:9100/inspect" 2>&1 || true)"
echo "$inspect_out" | grep -q '"ok":true' || fail "service behavior: POST /inspect against a root-owned checkout did not return ok:true — got: ${inspect_out}"
echo "$inspect_out" | grep -qi 'dubious' && fail "service behavior: POST /inspect response mentions 'dubious' ownership — got: ${inspect_out}"
pass "POST /inspect succeeds against a checkout git does not own, with no dubious-ownership error"

# OpenCode's database/logs/cache/state land under /home/opencode, owned by
# 10001, nothing under /root.
find_out="$(run_exec "$MAIN_CID" "0:0" find /home/opencode -mindepth 1 2>&1 || true)"
[ -n "$find_out" ] || fail "service behavior: nothing found under /home/opencode — expected OpenCode's config/data/cache/state files"
non_agent_owned="$(run_exec "$MAIN_CID" "0:0" find /home/opencode -mindepth 1 -not -user 10001 2>&1 || true)"
[ -z "$non_agent_owned" ] || fail "service behavior: file(s) under /home/opencode NOT owned by uid 10001: ${non_agent_owned}"
root_dir_written="$(run_exec "$MAIN_CID" "0:0" sh -c 'find /root -mindepth 1 2>/dev/null | head -1 || true')"
[ -z "$root_dir_written" ] || fail "service behavior: something was written under /root: ${root_dir_written} (the service HOME is /var/lib/workspace-agent/home, never /root)"
pass "OpenCode's files under /home/opencode are all owned by uid 10001; nothing under /root"

# The 9200 bearer proxy reaches OpenCode, and the bearer token is not exposed
# via OpenCode's own /proc/<pid>/environ (read as root) or any file OpenCode
# can read.
proxy_probe="$(run_exec "$MAIN_CID" "0:0" sh -c "curl -sS -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer isolation-harness-dummy-bearer-token' http://127.0.0.1:9200/ 2>&1 || true")"
case "$proxy_probe" in
  2* | 3* | 4[0-9][0-9]) : ;; # any HTTP response (even 404/405 from the upstream) proves the proxy reached OpenCode and forwarded
  *) fail "service behavior: :9200 bearer proxy did not produce an HTTP response (got '${proxy_probe}') — proxy or upstream may be down" ;;
esac
# NOTE: reading a DIFFERENT uid's /proc/<pid>/environ is gated by the kernel's
# ptrace_may_access() check, which (unlike ordinary file permissions) is NOT
# satisfied by CAP_DAC_OVERRIDE — it requires either matching uid/gid or
# CAP_SYS_PTRACE. The production capability set (and this harness's
# WORKSPACE_SECURITY_ARGS, deliberately mirroring it) does NOT grant
# CAP_SYS_PTRACE, so root here may not even be able to OPEN OpenCode's (uid
# 10001) environ at all. Both outcomes support the same security claim: if
# the read fails outright, the token is a fortiori not exposed via this
# channel (an even stronger result than "present but not visible"); if it
# succeeds, its content must not contain the token.
set +e
oc_environ_raw="$(run_exec "$MAIN_CID" "0:0" cat "/proc/${OC_PID}/environ" 2>&1)"
oc_environ_status=$?
set -e
if [ "$oc_environ_status" -eq 0 ]; then
  oc_environ="$(printf '%s' "$oc_environ_raw" | tr '\0' '\n')"
  echo "$oc_environ" | grep -qi 'bearer-token\|isolation-harness-dummy-bearer-token' && \
    fail "service behavior: the bearer token appears in OpenCode's own /proc/${OC_PID}/environ"
  echo "$oc_environ" | grep -qi 'WORKSPACE_OPENCODE_TOKEN' && \
    fail "service behavior: WORKSPACE_OPENCODE_TOKEN* is present in OpenCode's own environ (should be allowlisted out — see buildOpencodeEnv)"
  pass ":9200 bearer proxy reaches OpenCode; the bearer token is absent from OpenCode's own /proc/<pid>/environ (root COULD read it — CAP_SYS_PTRACE must be present after all, or the kernel's dumpable/same-userns rules allowed it — and it was clean)"
else
  log "root could not open /proc/${OC_PID}/environ at all (status=${oc_environ_status}: ${oc_environ_raw}) — expected, since the production capability set omits CAP_SYS_PTRACE and ptrace_may_access() requires it for cross-uid access. This is a STRONGER result than the token merely being absent from readable content."
  pass ":9200 bearer proxy reaches OpenCode; OpenCode's own /proc/<pid>/environ is not even readable cross-uid by root (missing CAP_SYS_PTRACE), so the bearer token cannot be exposed via that channel"
fi

# Signals across uids: the root supervisor can stop the uid-10001 OpenCode
# process on shutdown (killChildGroup sends SIGTERM to -pgid as root, which
# CAP_KILL + matching process-group membership permits regardless of uid).
docker stop --time "$SHUTDOWN_TIMEOUT_S" "$MAIN_CID" >/dev/null
# docker stop already waited for the container to exit (or killed it at the
# timeout); if OpenCode were still running/wedged, the container would not
# have stopped inside SHUTDOWN_TIMEOUT_S at all, but confirm explicitly via
# `docker top` — an exited container reports no processes.
if docker top "$MAIN_CID" >/dev/null 2>&1; then
  fail "signal handling: container is still running after 'docker stop --time ${SHUTDOWN_TIMEOUT_S}' — OpenCode (or the supervisor) did not shut down"
fi
container_state="$(docker inspect -f '{{.State.Status}}' "$MAIN_CID")"
[ "$container_state" = "exited" ] || fail "signal handling: container state after stop is '${container_state}', expected 'exited'"
pass "the root supervisor's shutdown (docker stop, SIGTERM) reaps the uid-10001 OpenCode process; no 10001 process survives"
log "NOTE (confidence: see report): this proves OpenCode itself is reaped. It does NOT independently prove a GRANDCHILD of OpenCode is also reaped — POSIX setpgid() cannot join an externally-spawned docker-exec process to OpenCode's process group from outside its own ancestry, and constructing a REAL grandchild needs OpenCode to actually dispatch a tool subprocess, which needs live provider credentials this smoke context does not have. killChildGroup's use of \`process.kill(-pgid, 'SIGTERM')\` is, by POSIX semantics, unconditionally group-wide (see apps/workspace-agent/src/opencode-server.ts) — this harness proves the mechanism reaches OpenCode itself; the grandchild case rests on that same POSIX guarantee rather than an independent empirical check here."

# restart container so we don't leak a stopped-but-not-removed container past
# this phase's own trap accounting (cleanup() force-removes regardless, but
# keep the container state consistent for anyone inspecting mid-run logs).
docker rm -f "$MAIN_CID" >/dev/null 2>&1 || true
CONTAINERS=("${CONTAINERS[@]/$MAIN_CID/}")

# ─────────────────────────────────────────────────────────────────────────────
# Phase 5: migration of an existing volume
# ─────────────────────────────────────────────────────────────────────────────
log "phase 5: migration of a pre-existing (legacy root-owned) volume"

MIGRATION_VOLUME="isolation-harness-migration-$$-${RANDOM}"
docker volume create "$MIGRATION_VOLUME" >/dev/null
VOLUMES+=("$MIGRATION_VOLUME")

# Populate the volume AS ROOT, BEFORE the workspace container ever starts —
# using the same image (it has git + coreutils) with a throwaway entrypoint,
# simulating a checkout that predates uid isolation.
docker run --rm \
  -v "${MIGRATION_VOLUME}:/workspace/repos" \
  --entrypoint sh \
  "$IMAGE" -c '
    set -e
    mkdir -p /workspace/repos/acme/widgets
    cd /workspace/repos/acme/widgets
    git init -q
    git config user.email legacy@legacy.local
    git config user.name legacy
    echo "tracked content" > tracked.txt
    git add tracked.txt
    git commit -q -m init
    echo "dirty uncommitted change" >> tracked.txt
    printf "ignored content\n" > ignored.log
    printf "ignored.log\n" > .gitignore
    printf "#!/bin/sh\necho hi\n" > run.sh
    chmod 755 run.sh
    # Sentinel target OUTSIDE the checkout, same volume/filesystem, root-owned.
    printf "outside sentinel content\n" > /workspace/repos/.sentinel-target
    ln -s /workspace/repos/.sentinel-target symlink-to-outside
    # Hardlink to a root-owned file elsewhere on the same volume.
    printf "shared inode content\n" > /workspace/repos/.hardlink-source
    ln /workspace/repos/.hardlink-source hardlinked.txt
    # Record hashes for post-migration comparison.
    sha256sum tracked.txt ignored.log run.sh hardlinked.txt /workspace/repos/.sentinel-target /workspace/repos/.hardlink-source \
      > /workspace/repos/.pre-migration-hashes.txt
  '

log "legacy fixture populated (dirty tracked file, ignored file, executable, outside symlink, outside hardlink)"

MIG_CID="$(docker run -d \
  "${WORKSPACE_SECURITY_ARGS[@]}" \
  -e WORKSPACE_OPENCODE_TOKEN=isolation-harness-migration-token \
  -e MITMPROXY_CA_WAIT_SECONDS=0 \
  -e NO_PROXY='*' \
  -v "${MIGRATION_VOLUME}:/workspace/repos" \
  "$IMAGE")"
CONTAINERS+=("$MIG_CID")

if ! wait_for_healthz "$MIG_CID" "$MIGRATION_HEALTHY_TIMEOUT_S"; then
  echo "--- container logs ---" >&2
  docker logs "$MIG_CID" 2>&1 >&2 || true
  fail "migration: container did not become healthy within ${MIGRATION_HEALTHY_TIMEOUT_S}s (migration may have failed or hit its deadline)"
fi
pass "container with a pre-existing legacy volume boots healthy (migration completed before the clone API started serving)"

assert_migration_state() {
  local label="$1"
  local root_owner acme_owner outside_owner
  root_owner="$(run_exec "$MIG_CID" "0:0" stat -c '%u:%g' /workspace/repos)"
  [ "$root_owner" = "0:0" ] || fail "migration (${label}): /workspace/repos is ${root_owner}, expected 0:0"
  acme_owner="$(run_exec "$MIG_CID" "0:0" stat -c '%u:%g' /workspace/repos/acme)"
  [ "$acme_owner" = "0:0" ] || fail "migration (${label}): /workspace/repos/acme is ${acme_owner}, expected 0:0"

  local non_agent
  non_agent="$(run_exec "$MIG_CID" "0:0" find /workspace/repos/acme/widgets -not -user 10001 2>&1 || true)"
  [ -z "$non_agent" ] || fail "migration (${label}): file(s) inside the checkout not owned by uid 10001: ${non_agent}"

  run_exec "$MIG_CID" "0:0" sh -c 'cd /workspace/repos/acme/widgets && sha256sum -c /workspace/repos/.pre-migration-hashes.txt' \
    || fail "migration (${label}): content hashes changed after migration"

  # The fixture created run.sh with `chmod 755`. migrate-repo-ownership.mjs
  # only ORs in 0o600 for files (never touches the exec bit), so the mode
  # must be byte-for-byte unchanged — not just "some exec bit somewhere"
  # (the OWNER's exec bit is the FIRST octal digit, not the last).
  local run_sh_mode
  run_sh_mode="$(run_exec "$MIG_CID" "0:0" stat -c '%a' /workspace/repos/acme/widgets/run.sh)"
  [ "$run_sh_mode" = "755" ] || fail "migration (${label}): run.sh mode is ${run_sh_mode}, expected 755 unchanged (owner-exec bit is the FIRST octal digit)"

  outside_owner="$(run_exec "$MIG_CID" "0:0" stat -c '%u' /workspace/repos/.sentinel-target)"
  [ "$outside_owner" = "0" ] || fail "migration (${label}): symlink target /workspace/repos/.sentinel-target owner changed to ${outside_owner}, expected 0 (migration must never follow symlinks)"
  local symlink_owner
  symlink_owner="$(run_exec "$MIG_CID" "0:0" stat -c '%u' /workspace/repos/acme/widgets/symlink-to-outside)"
  [ "$symlink_owner" = "10001" ] || fail "migration (${label}): the symlink ITSELF is owned by ${symlink_owner}, expected 10001 (lchown of the symlink, not its target)"

  local hardlink_source_owner hardlink_source_nlink
  hardlink_source_owner="$(run_exec "$MIG_CID" "0:0" stat -c '%u' /workspace/repos/.hardlink-source)"
  [ "$hardlink_source_owner" = "0" ] || fail "migration (${label}): outside hardlink source /workspace/repos/.hardlink-source owner changed to ${hardlink_source_owner}, expected 0"
  hardlink_source_nlink="$(run_exec "$MIG_CID" "0:0" stat -c '%h' /workspace/repos/.hardlink-source)"
  [ "$hardlink_source_nlink" = "1" ] || fail "migration (${label}): outside hardlink source still has nlink ${hardlink_source_nlink} (expected 1 — the inside copy should have been broken onto its own inode)"

  run_exec "$MIG_CID" "0:0" test -f /workspace/repos/.workspace-agent/completed/acme__widgets.json \
    || fail "migration (${label}): no completion marker at /workspace/repos/.workspace-agent/completed/acme__widgets.json"

  log "migration state verified (${label}): checkout is 10001-owned, owner dirs stay root, hashes unchanged, exec bit survived, outside symlink target and outside hardlink source both stayed root-owned"
}

assert_migration_state "first boot"
pass "migration: checkout ownership, content hashes, executable bit, symlink-target ownership, and hardlink-source ownership all correct after first boot"

# Idempotency: restart and confirm nothing changes and it finishes fast.
restart_started_at="$(date +%s)"
docker restart --time "$SHUTDOWN_TIMEOUT_S" "$MIG_CID" >/dev/null
if ! wait_for_healthz "$MIG_CID" "$MIGRATION_HEALTHY_TIMEOUT_S"; then
  echo "--- container logs ---" >&2
  docker logs "$MIG_CID" 2>&1 >&2 || true
  fail "migration idempotency: container did not become healthy again within ${MIGRATION_HEALTHY_TIMEOUT_S}s after restart"
fi
restart_elapsed=$(( $(date +%s) - restart_started_at ))
assert_migration_state "after restart (idempotency)"
# "Finishes quickly": already-migrated checkouts are skipped via their
# completion marker, so a restart should be nowhere near the 5-minute
# migration deadline. 30s is a generous bound for image-cold-start + healthz
# polling overhead in CI, not a tight timing assertion.
if [ "$restart_elapsed" -gt 30 ]; then
  fail "migration idempotency: restart took ${restart_elapsed}s to become healthy again — expected a fast (already-migrated, marker-skipped) restart, not a re-walk"
fi
pass "migration is idempotent across a restart (state unchanged, completed in ${restart_elapsed}s)"

docker rm -f "$MIG_CID" >/dev/null 2>&1 || true
CONTAINERS=("${CONTAINERS[@]/$MIG_CID/}")

log "all phases complete"
