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
SIGNAL_WAIT_TIMEOUT_S="${ISOLATION_HARNESS_SIGNAL_WAIT_TIMEOUT_S:-15}"
MIGRATION_HEALTHY_TIMEOUT_S="${ISOLATION_HARNESS_MIGRATION_TIMEOUT_S:-90}"
# Tight bound for a restart AFTER /clone: the checkout is already agent-owned,
# so the migration must skip it outright (no walk) — nowhere near the full
# MIGRATION_HEALTHY_TIMEOUT_S a from-scratch legacy-volume migration gets.
CLONE_RESTART_HEALTHY_TIMEOUT_S="${ISOLATION_HARNESS_CLONE_RESTART_TIMEOUT_S:-60}"

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
TMPDIRS=()
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
  for d in "${TMPDIRS[@]:-}"; do
    [ -n "$d" ] && rm -rf "$d"
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
# A real, throwaway self-signed CA. The entrypoint installs whatever is
# mounted here into the system trust store, and a malformed PEM there can
# break TLS for every client that loads the bundle — including the real
# /clone to github.com in phase 4b. Nothing trusts this key for anything.
CA_KEY_FILE="$(mktemp)"
TMPFILES+=("$CA_KEY_FILE")
openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -subj "/CN=isolation-harness-dummy-ca" \
  -keyout "$CA_KEY_FILE" -out "$CA_FILE" >/dev/null 2>&1 \
  || fail "setup: could not generate the throwaway CA certificate with openssl"

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

# ── Yama ptrace_scope and the /proc/<pid>/mem positive controls ────────────
# Opening /proc/<pid>/mem is a PTRACE_MODE_ATTACH check (__ptrace_may_access()
# with PTRACE_MODE_ATTACH), and with the Yama LSM's ptrace_scope >= 1
# (restricted — the default on the GitHub Actions runner this harness runs
# on), ATTACH is granted only to an ANCESTOR of the target process, or to a
# caller holding CAP_SYS_PTRACE (which production's capability set, and this
# harness's WORKSPACE_SECURITY_ARGS mirroring it, deliberately omits). The
# `docker exec` root process used by must_succeed/must_fail is NOT an
# ancestor of any process already running inside the container (the
# secret-holder, or pid 1 itself) — it is a sibling spawned fresh by the
# Docker engine. So on this kernel, root asserting "I can open THIS
# pre-existing process's /proc/<pid>/mem" is FALSE for a reason that has
# nothing to do with the uid boundary under test, which is exactly the bug a
# prior revision of this harness hit (see the module comment history). The
# fix: prove dd-can-open-/proc/<pid>/mem-AT-ALL under this kernel's Yama
# policy using a target the opener IS an ancestor of. Yama checks the process
# doing the open, so `sleep & dd /proc/$!/mem` is NOT enough — dd would be
# sleep's sibling, both children of sh. `exec dd` replaces sh in place (same
# pid), making dd itself sleep's parent. A descendant is always a valid ATTACH
# target regardless of ptrace_scope (0 or 1). The uid-10001 control below
# does the same against ITS OWN child, ruling out a mount or hidepid=...
# artifact that would block 10001 from opening ANY /proc/*/mem file
# (which would otherwise make the mem denials below pass for the wrong
# reason). Neither control asserts access to the SECRET_PID or pid-1
# targets the denials below test — see the ptrace_scope-conditioned logging
# after each denial for what the denial result does and does not prove.
# shellcheck disable=SC2016 # the $! / $p / $r are for the INNER sh -c script, not this outer bash line
must_succeed "root can open a child process's /proc/<pid>/mem (Yama-compliant descendant target, setup sanity check)" \
  "$MAIN_CID" "0:0" \
  sh -c 'sleep 5 & exec dd if=/proc/$!/mem of=/dev/null bs=1 count=0 2>&1'
# shellcheck disable=SC2016 # same as above — inner sh -c script, uid 10001's own child
must_succeed "uid 10001 can open its own child process's /proc/<pid>/mem (rules out a mount/hidepid artifact, setup sanity check)" \
  "$MAIN_CID" "$AGENT_USER" \
  sh -c 'sleep 5 & exec dd if=/proc/$!/mem of=/dev/null bs=1 count=0 2>&1'

# /proc/<pid>/mem probes use `dd ... count=0`, deliberately: dd still open()s
# the file (where the kernel's ptrace_may_access() permission gate actually
# lives, in proc_mem_open()) but issues ZERO read() calls. A real read() at
# offset 0 would fail with EIO (unmapped guard page) for EVERYONE, including
# root — that unrelated I/O failure is not the property under test and would
# make a positive control fail for the wrong reason. count=0 isolates exactly
# the open()-time permission check.
# NULs inside /proc/<pid>/environ are stripped to newlines INSIDE the exec'd
# command, before the output ever reaches bash's own command substitution.
# bash's $(...) can silently drop bytes once it hits a raw NUL (the source of
# the "command substitution: ignored null byte in input" warning this
# harness previously logged), which would make the `grep -qF "$DUMMY_TOKEN"`
# below miss the token if it happened to land after a NUL boundary in the raw
# environ blob — exactly in the scenario where the denial has ALREADY failed
# and this check is the last line of defense. cat's raw (possibly NUL-laden)
# output is redirected to a real file first — file redirection has no NUL
# truncation issue, unlike command substitution — so cat's own exit status
# ($st) survives intact; tr then reads that file and only the already-clean
# text reaches docker exec's stdout, which is what bash's outer $(...) here
# actually captures.
secret_env_out=""
set +e
secret_env_out="$(run_exec "$MAIN_CID" "$AGENT_USER" sh -c \
  "cat /proc/${SECRET_PID}/environ >/tmp/isolation-harness-environ-capture 2>&1; st=\$?; tr '\\0' '\\n' </tmp/isolation-harness-environ-capture; rm -f /tmp/isolation-harness-environ-capture; exit \$st")"
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
if [ "$ptrace_scope" = "0" ]; then
  log "  mem denial mechanism at ptrace_scope=0: the uid/capability check alone (uid 10001 lacks CAP_SYS_PTRACE and does not match the secret-holder's uid) — Yama imposes no additional restriction at scope 0"
else
  log "  mem denial mechanism at ptrace_scope=${ptrace_scope}: BOTH the uid/capability check AND Yama's non-ancestor rule deny this to uid 10001. The mem denial alone does NOT isolate which one is doing the work here — see the environ denial just proven above (a PTRACE_MODE_READ check, which Yama never restricts), which proves the uid boundary independently of Yama"
fi

# ── workspace agent's own /proc/1/environ (holds WORKSPACE_OPENCODE_TOKEN_FILE
# and, via config.ts's file-read path, is where a plain (non-_FILE) secret
# value would land if ever passed that way) ─────────────────────────────────
# See the earlier NUL-stripping note (phase 2, secret-holder environ capture)
# for why the raw environ is redirected to a file inside the container and
# passed through tr before docker exec's stdout is captured, instead of
# letting bash's own command substitution see raw NUL bytes directly.
# shellcheck disable=SC2016 # the $? / $st are for the INNER sh -c script, not this outer bash line
must_succeed "root can read its own /proc/1/environ (setup sanity check)" "$MAIN_CID" "0:0" \
  sh -c 'cat /proc/1/environ >/tmp/isolation-harness-pid1-environ-capture 2>&1; st=$?; tr "\0" "\n" </tmp/isolation-harness-pid1-environ-capture; rm -f /tmp/isolation-harness-pid1-environ-capture; exit $st'
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
#
# There is deliberately NO "root opens /proc/1/mem" positive control here: a
# docker-exec root process is not an ancestor of pid 1 either, so under Yama
# ptrace_scope >= 1 that assertion is FALSE on this runner's kernel — the
# exact bug a prior revision of this harness hit. The child-based root and
# uid-10001 positive controls earlier in phase 2 already established that dd
# can open /proc/<pid>/mem at all under this kernel's Yama policy, against
# targets each caller legitimately owns as an ancestor.
must_fail "ptrace/process_vm_readv-equivalent access to the service's own memory" "$MAIN_CID" "$AGENT_USER" \
  sh -c 'dd if=/proc/1/mem of=/dev/null bs=1 count=0 2>&1'
if [ "$ptrace_scope" = "0" ]; then
  log "  pid-1 mem denial mechanism at ptrace_scope=0: the uid/capability check alone (uid 10001 lacks CAP_SYS_PTRACE and does not match pid 1's uid)"
else
  log "  pid-1 mem denial mechanism at ptrace_scope=${ptrace_scope}: BOTH Yama's non-ancestor rule (a docker-exec root process is not pid 1's ancestor either) AND the uid/capability check deny this to uid 10001 — this denial alone does NOT isolate the uid boundary at scope >= 1; the /proc/1/environ denial proven above (PTRACE_MODE_READ, unaffected by Yama) proves that independently"
fi
pass "uid 10001 cannot open /proc/1/mem for read (same kernel gate as ptrace(PTRACE_ATTACH)/process_vm_readv against the service; the environ denial above is the Yama-independent proof of the uid boundary)"

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
# `timeout N nc -l -p PORT` inside the container bounds a successful listen
# that no connection ever reaches. The exit status alone cannot tell the two
# outcomes apart reliably: busybox `timeout` reports a timed-out child as
# 143 (128+SIGTERM), not GNU's 124. So each side keys on what nc says:
# a refused bind prints "Address in use" (EADDRINUSE, the specific reason
# under test); a successful listen prints no bind error and ends by timeout.
assert_cannot_bind() {
  local property="$1" cid="$2" user="$3" port="$4"
  local out status
  set +e
  out="$(run_exec "$cid" "$user" sh -c "timeout 2 nc -l -p ${port} 2>&1")"
  status=$?
  set -e
  if ! printf '%s' "$out" | grep -q 'Address in use'; then
    fail "${property}: uid ${user} was not refused with EADDRINUSE on port ${port} (status=${status}) — it may have bound it, or failed for an unrelated reason — output: ${out}"
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
  # 0: nc exited on its own; 124 (GNU) / 143 (busybox): timeout ended a listen.
  if printf '%s' "$out" | grep -qi 'bind'; then
    fail "${property} (positive control): uid ${user} could NOT bind port ${port} (status=${status}): ${out}"
  fi
  case "$status" in
    0 | 124 | 143) ;;
    *) fail "${property} (positive control): nc on port ${port} ended with unexpected status ${status}: ${out}" ;;
  esac
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
# Same NUL-safety technique as the earlier environ captures: redirect the
# raw (possibly NUL-laden) bytes to a file inside the container first so
# cat's own exit status survives a failed read, then only the already-clean
# (NUL-stripped) text reaches this script's command substitution.
set +e
oc_environ_raw="$(run_exec "$MAIN_CID" "0:0" \
  sh -c "cat /proc/${OC_PID}/environ >/tmp/isolation-harness-oc-environ-capture 2>&1; st=\$?; tr '\\0' '\\n' </tmp/isolation-harness-oc-environ-capture; rm -f /tmp/isolation-harness-oc-environ-capture; exit \$st")"
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

# ─────────────────────────────────────────────────────────────────────────────
# Phase 4b: /clone hands new checkouts to the agent uid (real /clone, real repo)
#
# DEPENDS ON A CONTRACT NOT YET IMPLEMENTED as of this harness revision:
# clone.ts still clones as the service (root), with no post-clone chown (see
# this harness's earlier report). A separate lane is implementing the
# contract below in apps/workspace-agent/src/clone.ts concurrently; these
# assertions will FAIL on CI until that lands. That is expected, not a
# harness bug — see the report's confidence notes.
#
# Repo choice: octocat/Hello-World — GitHub's own canonical demo repository,
# used in GitHub's own API/CLI documentation for over a decade, a few commits
# and a README only (seconds to clone), and about as unlikely to be deleted
# or renamed as a GitHub-hosted repo can be.
#
# Network path: this container was started via plain `docker run` (no
# --network flag), so it is on Docker's default bridge network, which NATs
# out to the internet on a GitHub Actions runner exactly like every other
# `docker run` in this harness and in ci.yaml's workspace-smoke job — none of
# them attach to compose's internal-only sandbox-net or route through
# mitmproxy. No proxy env is set on this container (see phase 0), so the
# clone request goes DIRECT to github.com, the same as the rest of this
# harness. If a future CI runner's default network has no egress, this whole
# block will fail with a network-level clone-failed error, not a uid/ownership
# error — that distinction is worth checking first if this ever goes red.
#
# Token: server-side shape validation (sanitizeOwner/sanitizeRepo/
# validateTokenShape in sanitize.ts) requires `ghs_` + at least 16 more chars
# — checked BEFORE any git subprocess runs, so a syntactically well-formed
# but fake token clears that gate. octocat/Hello-World is public, so git
# should not even need to present it to GitHub to succeed.
# ─────────────────────────────────────────────────────────────────────────────
log "phase 4b: /clone hands new checkouts to the agent uid"

# CLONE_OWNER/CLONE_REPO are the single source of truth for the repo this
# phase clones — every request body, path, and diagnostic below is derived
# from these two variables so the assertions and the failure diagnostics can
# never drift apart.
CLONE_OWNER="octocat"
CLONE_REPO="Hello-World"
CLONE_TOKEN="ghs_isolationHarnessDummyCloneToken1234567890"  # ghs_ + 40 chars, well past validateTokenShape's >=20 minimum
clone_out="$(run_exec "$MAIN_CID" "0:0" sh -c "curl -sS -X POST -H 'Content-Type: application/json' -d '{\"owner\":\"${CLONE_OWNER}\",\"repo\":\"${CLONE_REPO}\",\"token\":\"${CLONE_TOKEN}\"}' http://127.0.0.1:9100/clone" 2>&1 || true)"
if ! echo "$clone_out" | grep -q '"ok":true'; then
  # /clone reports only a coarse error code. Reproduce the network half with
  # the same sealed git config, as root, so the log shows git's own reason.
  echo "--- diagnostic: git ls-remote as root with sealed config ---" >&2
  run_exec "$MAIN_CID" "0:0" sh -c "GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_ALLOW_PROTOCOL=https GIT_TERMINAL_PROMPT=0 git ls-remote https://github.com/${CLONE_OWNER}/${CLONE_REPO}.git HEAD 2>&1" >&2 || true
  echo "--- diagnostic: staging and owner directories ---" >&2
  run_exec "$MAIN_CID" "0:0" sh -c "ls -la /workspace/repos /workspace/repos/.workspace-agent /workspace/repos/.workspace-agent/staging /workspace/repos/${CLONE_OWNER} 2>&1" >&2 || true
  echo "--- diagnostic: workspace logs (tail) ---" >&2
  docker logs --tail 40 "$MAIN_CID" >&2 2>&1 || true
fi
echo "$clone_out" | grep -q '"ok":true' || fail "clone: POST /clone ${CLONE_OWNER}/${CLONE_REPO} did not return ok:true — got: ${clone_out} (network-level failure? this container has no --network override, so it depends on the runner having outbound internet — see the block comment above before assuming a uid/ownership regression)"
pass "POST /clone ${CLONE_OWNER}/${CLONE_REPO} succeeds over the harness's direct (unproxied) network path"

clone_root_owner="$(run_exec "$MAIN_CID" "0:0" stat -c '%u:%g:%a' /workspace/repos)"
[ "$clone_root_owner" = "0:0:755" ] || fail "clone: /workspace/repos is ${clone_root_owner}, expected 0:0:755"
clone_owner_dir_owner="$(run_exec "$MAIN_CID" "0:0" stat -c '%u:%g:%a' "/workspace/repos/${CLONE_OWNER}")"
[ "$clone_owner_dir_owner" = "0:0:755" ] || fail "clone: /workspace/repos/${CLONE_OWNER} is ${clone_owner_dir_owner}, expected 0:0:755"
clone_non_agent_owned="$(run_exec "$MAIN_CID" "0:0" find "/workspace/repos/${CLONE_OWNER}/${CLONE_REPO}" -not -user 10001 2>&1 || true)"
[ -z "$clone_non_agent_owned" ] || fail "clone: file(s) inside the new checkout not owned by uid 10001: ${clone_non_agent_owned}"
pass "clone: /workspace/repos and /workspace/repos/${CLONE_OWNER} stay 0:0 0755; the new checkout is entirely 10001-owned"

clone_staging_listing="$(run_exec "$MAIN_CID" "0:0" sh -c 'find /workspace/repos/.workspace-agent/staging -mindepth 1 2>&1 || true')"
[ -z "$clone_staging_listing" ] || fail "clone: /workspace/repos/.workspace-agent/staging/ is not empty after a completed clone: ${clone_staging_listing}"
clone_stray_tmp="$(run_exec "$MAIN_CID" "0:0" sh -c "find /workspace/repos/${CLONE_OWNER} -maxdepth 1 -name '.tmp-*' 2>&1 || true")"
[ -z "$clone_stray_tmp" ] || fail "clone: stray .tmp-* entries left under /workspace/repos/${CLONE_OWNER}: ${clone_stray_tmp}"
pass "clone: staging directory is empty and no .tmp-* staging leftovers remain under the owner directory"

must_succeed "clone: uid 10001 can create/edit a file in the new checkout" "$MAIN_CID" "$AGENT_USER" \
  sh -c "echo 'isolation-harness-edit' > /workspace/repos/${CLONE_OWNER}/${CLONE_REPO}/isolation-harness-edit.txt && grep -q isolation-harness-edit /workspace/repos/${CLONE_OWNER}/${CLONE_REPO}/isolation-harness-edit.txt"
pass "clone: uid 10001 can create and edit a file inside the checkout /clone produced"

clone_inspect_out="$(run_exec "$MAIN_CID" "0:0" sh -c "curl -sS -X POST -H 'Content-Type: application/json' -d '{\"owner\":\"${CLONE_OWNER}\",\"repo\":\"${CLONE_REPO}\"}' http://127.0.0.1:9100/inspect" 2>&1 || true)"
echo "$clone_inspect_out" | grep -q '"ok":true' || fail "clone: POST /inspect on the new checkout did not return ok:true — got: ${clone_inspect_out}"
pass "clone: POST /inspect on the /clone-produced checkout succeeds"

clone_repeat_out="$(run_exec "$MAIN_CID" "0:0" sh -c "curl -sS -o /tmp/clone-repeat-body.json -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{\"owner\":\"${CLONE_OWNER}\",\"repo\":\"${CLONE_REPO}\",\"token\":\"${CLONE_TOKEN}\"}' http://127.0.0.1:9100/clone" 2>&1 || true)"
[ "$clone_repeat_out" = "409" ] || fail "clone: second POST /clone of the same repo returned HTTP ${clone_repeat_out}, expected 409 (repo-exists) — body: $(run_exec "$MAIN_CID" "0:0" cat /tmp/clone-repeat-body.json 2>&1 || true)"
clone_repeat_body="$(run_exec "$MAIN_CID" "0:0" cat /tmp/clone-repeat-body.json 2>&1 || true)"
echo "$clone_repeat_body" | grep -q 'repo-exists' || fail "clone: second /clone returned 409 but body does not say repo-exists: ${clone_repeat_body}"
clone_repeat_logs="$(docker logs "$MAIN_CID" 2>&1 || true)"
echo "$clone_repeat_logs" | grep -qi 'dubious ownership' && fail "clone: 'dubious ownership' appeared in workspace logs after the repeat /clone's repo-exists validation ran git as 10001 against the checkout"
pass "clone: a second /clone of the same repo returns 409 repo-exists, with no dubious-ownership error in the workspace logs"

# ─────────────────────────────────────────────────────────────────────────────
# Phase 4b-restart: a restart AFTER /clone must not re-walk the checkout
# /clone just produced. /clone hands new checkouts straight to uid 10001 but
# writes no completion marker for them — it's migrate-repo-ownership.mjs's
# skip-if-checkout-root-is-already-agent-owned rule (not the marker) that
# keeps every subsequent boot cheap and correct. This is exactly the
# regression the rule fixes: without it, every boot after a /clone would
# re-walk that checkout as root, growing unboundedly toward the migration
# deadline as more repos get cloned.
# ─────────────────────────────────────────────────────────────────────────────
log "phase 4b-restart: a restart after /clone skips the freshly cloned checkout entirely"

CLONE_CHECKOUT_PATH="/workspace/repos/${CLONE_OWNER}/${CLONE_REPO}"

# Record the checkout's full content hash and per-path uid:gid BEFORE the
# restart, sorted so the comparison isn't sensitive to readdir order.
clone_restart_hashes_before="$(run_exec "$MAIN_CID" "0:0" sh -c "find '${CLONE_CHECKOUT_PATH}' -type f -exec sha256sum {} \\; | sort")"
clone_restart_owners_before="$(run_exec "$MAIN_CID" "0:0" sh -c "find '${CLONE_CHECKOUT_PATH}' -exec stat -c '%n %u:%g' {} \\; | sort")"
[ -n "$clone_restart_hashes_before" ] || fail "phase 4b-restart: pre-restart content hash of ${CLONE_CHECKOUT_PATH} is empty — the checkout appears empty, cannot prove anything is unchanged"

clone_restart_started_at="$(date +%s)"
docker restart --time "$SHUTDOWN_TIMEOUT_S" "$MAIN_CID" >/dev/null
if ! wait_for_healthz "$MAIN_CID" "$CLONE_RESTART_HEALTHY_TIMEOUT_S"; then
  echo "--- container logs ---" >&2
  docker logs "$MAIN_CID" 2>&1 >&2 || true
  fail "phase 4b-restart: container did not become healthy within ${CLONE_RESTART_HEALTHY_TIMEOUT_S}s after restarting post-/clone (a full re-walk of the /clone checkout would blow this bound)"
fi
clone_restart_elapsed=$(( $(date +%s) - clone_restart_started_at ))
pass "phase 4b-restart: container restarted and became healthy again in ${clone_restart_elapsed}s (within the ${CLONE_RESTART_HEALTHY_TIMEOUT_S}s bound)"

# Read ONLY this new boot's migration summary line. docker's log driver
# appends across restarts (the log is NOT reset), and this container has now
# booted twice, so a plain `docker logs` would also match the first boot's
# line (which legitimately reports zero of everything, since /clone hadn't
# run yet) — `--since` the new boot's own recorded start time isolates it,
# mirroring how the migration phase's docker-logs reads are always scoped to
# a single boot by construction (a freshly created container there, a
# freshly restarted one here).
clone_restart_started_iso="$(docker inspect -f '{{.State.StartedAt}}' "$MAIN_CID")"
clone_restart_logs="$(docker logs --since "$clone_restart_started_iso" "$MAIN_CID" 2>&1 || true)"
clone_restart_summary_line="$(printf '%s\n' "$clone_restart_logs" | grep 'migrate-repo-ownership: completed=' | tail -1)"
[ -n "$clone_restart_summary_line" ] || fail "phase 4b-restart: no 'migrate-repo-ownership: completed=...' summary line found in this boot's logs — got: ${clone_restart_logs}"
log "  migration summary for this boot: ${clone_restart_summary_line}"

# Assert on the /clone checkout BY NAME, not on the run's totals: earlier
# phases deliberately leave a root-owned git checkout on this volume (the
# /inspect dubious-ownership fixture), and migrating it on this boot is
# correct. Only the /clone checkout must be skipped.
clone_restart_key="${CLONE_OWNER}/${CLONE_REPO}"
printf '%s\n' "$clone_restart_logs" | grep -qxF "migrate: ${clone_restart_key}: skipped (already agent-owned)" \
  || fail "phase 4b-restart: this boot's migration did not report ${clone_restart_key} as skipped (already agent-owned) — got: ${clone_restart_logs}"
if printf '%s\n' "$clone_restart_logs" | grep -qxF "migrate: ${clone_restart_key}: complete"; then
  fail "phase 4b-restart: this boot's migration WALKED ${clone_restart_key} (reported it complete) instead of skipping it"
fi
pass "phase 4b-restart: this boot's migration skipped the /clone checkout (${clone_restart_key}) as already agent-owned, without walking it"

clone_restart_hashes_after="$(run_exec "$MAIN_CID" "0:0" sh -c "find '${CLONE_CHECKOUT_PATH}' -type f -exec sha256sum {} \\; | sort")"
clone_restart_owners_after="$(run_exec "$MAIN_CID" "0:0" sh -c "find '${CLONE_CHECKOUT_PATH}' -exec stat -c '%n %u:%g' {} \\; | sort")"
[ "$clone_restart_hashes_before" = "$clone_restart_hashes_after" ] \
  || fail "phase 4b-restart: checkout content hashes changed across the restart"
[ "$clone_restart_owners_before" = "$clone_restart_owners_after" ] \
  || fail "phase 4b-restart: checkout ownership (uid:gid per path) changed across the restart"
pass "phase 4b-restart: checkout content hashes and per-path uid:gid are byte-for-byte unchanged across the restart"

# ─────────────────────────────────────────────────────────────────────────────
# Phase 4c: the image's git produces the prompts the askpass helper expects
#
# #1658's askpass helper (apps/workspace-agent/src/clone.ts, writeAskpassHelper)
# matches EXACT literal prompt text, not a glob. If Alpine's git (the image's
# git, NOT this CI runner's or a dev machine's) phrases the prompt even
# slightly differently, the helper refuses every prompt and every private
# clone breaks again, silently, under a fully passing test suite that never
# actually drives real git prompts. This block extracts the literals from the
# BUILT ARTIFACT (dist/main.mjs, inside the image) rather than hand-copying
# them from clone.ts source, then compares them against what the image's own
# git ACTUALLY says.
#
# writeAskpassHelper is exported from clone.ts but main.ts (the bundle entry)
# does not re-export it, so dist/main.mjs has no callable public export for
# it — `node -e "import('...').then(m => m.writeAskpassHelper)"` would be
# undefined. tsdown.config.ts sets no `minify` option (tsdown/rolldown
# default unminified), confirmed by ci.yaml's own existing bundle-guard step
# (`grep -q "startWorkspaceAgent" dist/main.mjs` — a plain identifier grep,
# which only works unminified) and by tsdown.config.ts's own
# bundleSymbolGuardPlugin doing the exact same plain-string containment
# check. writeAskpassHelper IS reachable from the entry (executeClone calls
# it, executeClone is wired into createApp's /clone route, createApp is
# called from startWorkspaceAgent) so its code — including these string
# literals — is bundled in, just not exported. Grepping dist/main.mjs's
# source text for the literals is therefore the only viable extraction path
# here; running the function is not.
# ─────────────────────────────────────────────────────────────────────────────
log "phase 4c: askpass prompt literals vs. the image's real git"

PROMPT_CHECK_DIR="$(mktemp -d)"
TMPDIRS+=("$PROMPT_CHECK_DIR")

# CORRECT recorder: replies 'x-access-token' to a Username prompt, a dummy
# value to anything else. This is NOT about answering "correctly" in any
# auth sense (this run never needs to actually authenticate) — it matters
# because git embeds whatever username it RECEIVED into the URL of the
# Password prompt that follows ("Password for 'https://<username>@host': ").
# The shipped literal is 'Password for 'https://x-access-token@github.com': '
# (clone.ts writeAskpassHelper always answers Username with 'x-access-token'
# — see clone.ts). Answering the Username prompt with anything else here
# would make git ask a DIFFERENT password prompt than production ever sees,
# and the comparison below would fail on every run regardless of what the
# image's git or the shipped helper actually do — that was exactly the bug
# in the previous revision of this block.
cat > "${PROMPT_CHECK_DIR}/recorder-askpass.sh" <<'RECORDER_EOF'
#!/bin/sh
printf '%s\n' "$1" >> "${RECORDER_OUT:-/tmp/askpass-recorder-prompts.txt}"
case "$1" in
  Username*) printf 'x-access-token' ;;
  *) printf 'isolation-harness-dummy-response' ;;
esac
RECORDER_EOF
chmod 755 "${PROMPT_CHECK_DIR}/recorder-askpass.sh"

# WRONG-USERNAME recorder: same shape, but answers Username with something
# OTHER than 'x-access-token'. Used only for the regression-pinning control
# below — reproduces, on demand, the exact failure mode the fix above closes.
cat > "${PROMPT_CHECK_DIR}/recorder-askpass-wronguser.sh" <<'WRONGUSER_EOF'
#!/bin/sh
printf '%s\n' "$1" >> "${RECORDER_OUT:-/tmp/askpass-recorder-prompts.txt}"
case "$1" in
  Username*) printf 'isolation-harness-wrong-user' ;;
  *) printf 'isolation-harness-dummy-response' ;;
esac
WRONGUSER_EOF
chmod 755 "${PROMPT_CHECK_DIR}/recorder-askpass-wronguser.sh"

# Extraction target: the FUNCTIONAL case-arm line in writeAskpassHelper, e.g.
#   `  "Username for 'https://github.com': ") printf '%s' 'x-access-token' ;;`,
# NOT clone.ts's own JSDoc comment for writeAskpassHelper, which ALSO quotes
# these prompts verbatim in backticks for documentation:
#   * literals (no globs) against git's real prompt text — `Username for 'https://github.com': `
#   * and `Password for 'https://x-access-token@github.com': ` — confirmed against real git
# Confirmed against the actual clone.ts source (read-only for this harness
# revision): a plain `grep -c "Username for"` finds BOTH lines (2 matches) —
# the comment line textually precedes the code line, so a naive first-match
# extraction would silently grab the comment instead of the code if tsdown
# preserves comments in the unminified bundle. The comment's backtick span
# ends right after the closing "': `" with no trailing shell code; the real
# case arm continues immediately with `") printf '%s' ...` after the closing
# quote. Requiring that continuation on the same line is what tells them
# apart, and matches exactly 1 line against real clone.ts source (verified
# locally: `grep -c "Username for .*\") printf"` -> 1, matching line 346).
# If the built bundle ever has zero or more than one such line — comment
# formatting changed, the case arm was refactored, whatever — this fails
# loudly instead of silently taking the first (possibly wrong) candidate.
cat > "${PROMPT_CHECK_DIR}/extract-literals.sh" <<'EXTRACT_EOF'
#!/bin/sh
set -e
BUNDLE=/app/apps/workspace-agent/dist/main.mjs
USER_PATTERN='Username for .*") printf'
PASS_PATTERN='Password for .*") printf'

user_matches="$(grep -c "$USER_PATTERN" "$BUNDLE" || true)"
if [ "$user_matches" -ne 1 ]; then
  echo "expected exactly 1 line matching the Username case-arm shape in $BUNDLE, found $user_matches" >&2
  exit 1
fi
grep "$USER_PATTERN" "$BUNDLE" | awk -F'"' '{print $2}' > /tmp/bundle-username-literal.txt

pass_matches="$(grep -c "$PASS_PATTERN" "$BUNDLE" || true)"
if [ "$pass_matches" -ne 1 ]; then
  echo "expected exactly 1 line matching the Password case-arm shape in $BUNDLE, found $pass_matches" >&2
  exit 1
fi
grep "$PASS_PATTERN" "$BUNDLE" | awk -F'"' '{print $2}' > /tmp/bundle-password-literal.txt
EXTRACT_EOF
chmod 755 "${PROMPT_CHECK_DIR}/extract-literals.sh"

docker cp "${PROMPT_CHECK_DIR}/recorder-askpass.sh" "${MAIN_CID}:/tmp/recorder-askpass.sh"
docker cp "${PROMPT_CHECK_DIR}/recorder-askpass-wronguser.sh" "${MAIN_CID}:/tmp/recorder-askpass-wronguser.sh"
docker cp "${PROMPT_CHECK_DIR}/extract-literals.sh" "${MAIN_CID}:/tmp/extract-literals.sh"
run_exec "$MAIN_CID" "0:0" chmod 755 /tmp/recorder-askpass.sh /tmp/recorder-askpass-wronguser.sh /tmp/extract-literals.sh
run_exec "$MAIN_CID" "0:0" /tmp/extract-literals.sh \
  || fail "askpass prompts: extract-literals.sh failed against the built bundle — dist/main.mjs may not be at /app/apps/workspace-agent/dist/main.mjs, the case-arm shape changed, or a JSDoc-vs-code ambiguity was found (see the script's own stderr above)"

bundle_username_literal="$(run_exec "$MAIN_CID" "0:0" cat /tmp/bundle-username-literal.txt)"
bundle_password_literal="$(run_exec "$MAIN_CID" "0:0" cat /tmp/bundle-password-literal.txt)"
[ -n "$bundle_username_literal" ] || fail "askpass prompts: could not extract the Username literal from the built bundle (dist/main.mjs)"
[ -n "$bundle_password_literal" ] || fail "askpass prompts: could not extract the Password literal from the built bundle (dist/main.mjs)"
log "  bundle Username literal: '${bundle_username_literal}'"
log "  bundle Password literal: '${bundle_password_literal}'"

# run_prompt_probe <recorder-script-path> <host> <output-file> — runs 'git
# credential fill' for protocol=https host=<host> against the given askpass
# recorder, with sealed config (GIT_CONFIG_GLOBAL=/dev/null,
# GIT_CONFIG_NOSYSTEM=1) so no repo/operator config can alter credential
# prompting. GIT_TERMINAL_PROMPT=0 does not suppress GIT_ASKPASS-driven
# prompting (git only falls back to the TTY prompt when no askpass mechanism
# is configured at all) — mirrors clone.ts's own buildCloneGitEnv, which sets
# both for the same reason.
run_prompt_probe() {
  local askpass_script="$1" host="$2" out_file="$3"
  run_exec "$MAIN_CID" "0:0" rm -f "$out_file"
  # RECORDER_OUT is only needed in the environment of the `git` invocation
  # (after the pipe) — git inherits it into the askpass child it spawns.
  run_exec "$MAIN_CID" "0:0" sh -c \
    "printf 'protocol=https\nhost=${host}\n' | RECORDER_OUT='${out_file}' GIT_ASKPASS='${askpass_script}' GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 git -c credential.helper= credential fill >/dev/null 2>&1 || true"
}

run_prompt_probe /tmp/recorder-askpass.sh github.com /tmp/prompts-github.txt
recorded_prompts="$(run_exec "$MAIN_CID" "0:0" cat /tmp/prompts-github.txt 2>&1 || true)"
[ -n "$recorded_prompts" ] || fail "askpass prompts: 'git credential fill' never invoked the recorder askpass helper at all — git may already have cached credentials, or credential.helper= did not disable an operator-configured helper as expected"
recorded_username_prompt="$(printf '%s\n' "$recorded_prompts" | sed -n '1p')"
recorded_password_prompt="$(printf '%s\n' "$recorded_prompts" | sed -n '2p')"
log "  recorded Username prompt (github.com, correct recorder): '${recorded_username_prompt}'"
log "  recorded Password prompt (github.com, correct recorder): '${recorded_password_prompt}'"

[ "$recorded_username_prompt" = "$bundle_username_literal" ] || \
  fail "askpass prompts: the image's real git Username prompt ('${recorded_username_prompt}') does not EXACTLY match the shipped helper's literal ('${bundle_username_literal}') — the helper would refuse every private clone's username prompt"
[ "$recorded_password_prompt" = "$bundle_password_literal" ] || \
  fail "askpass prompts: the image's real git Password prompt ('${recorded_password_prompt}') does not EXACTLY match the shipped helper's literal ('${bundle_password_literal}') — the helper would refuse every private clone's password prompt"
pass "the image's git produces prompts that exactly match the shipped askpass helper's literals (extracted from the built bundle, not hand-copied)"

# Control A: same recorder, a DIFFERENT host. Real git output, not a string
# mutation — this is the actual refusal case the helper's exact-literal
# matching exists for (see clone.ts: a lookalike/different host must never
# match). Proves the comparator can tell two REAL prompts apart, not just
# that string concatenation produces a different string.
run_prompt_probe /tmp/recorder-askpass.sh example.com /tmp/prompts-example.txt
control_a_prompts="$(run_exec "$MAIN_CID" "0:0" cat /tmp/prompts-example.txt 2>&1 || true)"
[ -n "$control_a_prompts" ] || fail "askpass prompts (control A): 'git credential fill' never invoked the recorder for host=example.com"
control_a_username_prompt="$(printf '%s\n' "$control_a_prompts" | sed -n '1p')"
control_a_password_prompt="$(printf '%s\n' "$control_a_prompts" | sed -n '2p')"
log "  recorded Username prompt (example.com control): '${control_a_username_prompt}'"
log "  recorded Password prompt (example.com control): '${control_a_password_prompt}'"
if [ "$control_a_username_prompt" = "$bundle_username_literal" ]; then
  fail "askpass prompts (control A): example.com's real Username prompt matched the github.com bundle literal — the comparison cannot discriminate hosts"
fi
if [ "$control_a_password_prompt" = "$bundle_password_literal" ]; then
  fail "askpass prompts (control A): example.com's real Password prompt matched the github.com bundle literal — the comparison cannot discriminate hosts"
fi
pass "askpass prompt control A: real git prompts for a different host (example.com) do NOT match the github.com bundle literals"

# Control B: github.com again, but the WRONG-USERNAME recorder. Pins the
# exact regression this block's own recorder fix (above) closes: answering
# the Username prompt with anything other than 'x-access-token' changes the
# Password prompt's embedded username, and the real Password prompt must
# then NOT match the bundle literal.
run_prompt_probe /tmp/recorder-askpass-wronguser.sh github.com /tmp/prompts-wronguser.txt
control_b_prompts="$(run_exec "$MAIN_CID" "0:0" cat /tmp/prompts-wronguser.txt 2>&1 || true)"
[ -n "$control_b_prompts" ] || fail "askpass prompts (control B): 'git credential fill' never invoked the wrong-username recorder for host=github.com"
control_b_password_prompt="$(printf '%s\n' "$control_b_prompts" | sed -n '2p')"
log "  recorded Password prompt (github.com, wrong-username control): '${control_b_password_prompt}'"
if [ "$control_b_password_prompt" = "$bundle_password_literal" ]; then
  fail "askpass prompts (control B): a Password prompt built from a non-'x-access-token' username unexpectedly matched the bundle literal — the comparison cannot discriminate the embedded username"
fi
pass "askpass prompt control B: a Password prompt built from the wrong embedded username does NOT match the bundle literal (regression check for this block's own recorder fix)"

# ─────────────────────────────────────────────────────────────────────────────
# Phase 4d: signals across uids, verified INSIDE a running container
#
# An exited container reports no processes by definition — "docker stop"
# followed by "docker top fails" proves the CONTAINER stopped, not that
# killChildGroup's actual mechanism (root sending SIGTERM to a NEGATIVE pgid
# owned by uid 10001) works. That check would pass identically even if
# killChildGroup were a no-op, since Docker's own teardown (SIGTERM to pid 1,
# then SIGKILL to the whole cgroup at the timeout) would eventually clear
# every process regardless. This phase proves the actual mechanism instead,
# while the container is still up: build a real 3-level uid-10001 process
# tree with a known pgid, prove (positive control) it is really running as
# 10001, kill -TERM the negative pgid AS ROOT the same way killChildGroup
# does, and prove every level — including the grandchild — is gone from
# /proc while the container keeps running. A separate negative control
# proves the direction is one-way: 10001 cannot signal the root service.
#
# Tool availability (checked at runtime, not assumed): deploy/workspace.Dockerfile's
# final stage apk-installs only git/ca-certificates/libgcc/libstdc++/ripgrep/
# curl/setpriv on top of the node:24-alpine base — no explicit util-linux or
# procps package. `setsid` and `kill` are therefore expected to be busybox's
# own applets (or ash's builtin `kill`), not util-linux's setsid or
# procps-ng's kill. Busybox ships `setsid` as a standard applet (creates a
# new session, so the exec'd process becomes both session leader and the
# leader of a fresh process group) and its `kill` applet accepts a negative
# pid to target a process group, same as procps — this is ordinary POSIX
# kill(1)/setsid(1) behavior, not a GNU/util-linux extension, so no
# real behavioral gap is expected between implementations. Still checked
# with `command -v` rather than assumed: if setsid is missing, this block
# falls back to a plain docker-exec-spawned tree (docker exec typically
# still assigns a fresh process group to the exec'd process, since it has no
# controlling terminal to join) and flags that path as lower confidence in
# logs — it does NOT silently skip the property. If `kill` itself is
# missing (would be unusual — even ash's builtin kill is always present),
# the block fails loudly naming exactly that, rather than producing a
# false pass from an unrelated "command not found" exit code.
# ─────────────────────────────────────────────────────────────────────────────
log "phase 4d: signals across uids (real process-group kill, verified via /proc)"

SIGNAL_CHECK_DIR="$(mktemp -d)"
TMPDIRS+=("$SIGNAL_CHECK_DIR")

cat > "${SIGNAL_CHECK_DIR}/group-tree.sh" <<'GROUPTREE_EOF'
#!/bin/sh
# Spawns a 3-level process tree (parent -> child -> grandchild). Nothing
# here calls setpgid, so all three share whatever process group this
# top-level process started in — setsid (when the caller uses it) makes
# that a brand-new group with pgid == this process's own pid.
echo $$ > /tmp/group-parent.pid
sh -c '
  echo $$ > /tmp/group-child.pid
  sleep 600 &
  echo $! > /tmp/group-grandchild.pid
  wait
' &
wait
GROUPTREE_EOF
chmod 755 "${SIGNAL_CHECK_DIR}/group-tree.sh"

cat > "${SIGNAL_CHECK_DIR}/pgid-of.sh" <<'PGIDOF_EOF'
#!/bin/sh
# Usage: pgid-of.sh <pid> — prints the pgrp field from /proc/<pid>/stat.
# comm (field 2) is parenthesized and may itself contain spaces, so split on
# the LAST ") " rather than naive whitespace splitting: state=$1 ppid=$2
# pgrp=$3 of what remains.
awk -F') ' '{print $NF}' "/proc/$1/stat" | awk '{print $3}'
PGIDOF_EOF
chmod 755 "${SIGNAL_CHECK_DIR}/pgid-of.sh"

cat > "${SIGNAL_CHECK_DIR}/group-scan.sh" <<'GROUPSCAN_EOF'
#!/bin/sh
# Usage: group-scan.sh <pid> — resolves <pid>'s pgid, then lists every
# process in /proc sharing that pgid as "MEMBER pid=<p> uid=<u>". Used both
# to confirm OpenCode's own process group is entirely uid-10001 (read-only —
# never kills through this path) and, incidentally, exercises the same
# pgid-lookup logic the kill-target discovery below relies on.
TARGET_PID="$1"
TARGET_PGID="$(awk -F') ' '{print $NF}' "/proc/${TARGET_PID}/stat" | awk '{print $3}')"
echo "PGID=${TARGET_PGID}"
for p in /proc/[0-9]*; do
  pid="${p#/proc/}"
  [ -r "$p/stat" ] || continue
  pgid="$(awk -F') ' '{print $NF}' "$p/stat" 2>/dev/null | awk '{print $3}')"
  [ "$pgid" = "$TARGET_PGID" ] || continue
  uid_line="$(awk '/^Uid:/{print $2}' "$p/status" 2>/dev/null)"
  echo "MEMBER pid=${pid} uid=${uid_line}"
done
GROUPSCAN_EOF
chmod 755 "${SIGNAL_CHECK_DIR}/group-scan.sh"

docker cp "${SIGNAL_CHECK_DIR}/group-tree.sh" "${MAIN_CID}:/tmp/group-tree.sh"
docker cp "${SIGNAL_CHECK_DIR}/pgid-of.sh" "${MAIN_CID}:/tmp/pgid-of.sh"
docker cp "${SIGNAL_CHECK_DIR}/group-scan.sh" "${MAIN_CID}:/tmp/group-scan.sh"
run_exec "$MAIN_CID" "0:0" chmod 755 /tmp/group-tree.sh /tmp/pgid-of.sh /tmp/group-scan.sh

if run_exec "$MAIN_CID" "0:0" sh -c 'command -v setsid >/dev/null 2>&1'; then
  GROUP_LAUNCH_CMD=(setsid /tmp/group-tree.sh)
  log "  setsid found in the image — using it for a deterministic fresh session+process-group"
else
  GROUP_LAUNCH_CMD=(/tmp/group-tree.sh)
  log "  setsid NOT found in this image — falling back to a plain docker-exec-spawned tree. The pgid below is still DISCOVERED empirically via /proc (never assumed), but this path has NOT independently confirmed isolation from any other uid-10001 process group the way an explicit new session does — treat this property's result as lower confidence if this branch is the one that ran (see report)."
fi
if ! run_exec "$MAIN_CID" "0:0" sh -c 'command -v kill >/dev/null 2>&1 || kill -l >/dev/null 2>&1'; then
  fail "signal handling: no usable 'kill' found in the image (checked both a standalone binary and the shell builtin) — cannot send the negative-pgid signal this property depends on"
fi

docker exec --user 10001:10001 -d "$MAIN_CID" "${GROUP_LAUNCH_CMD[@]}"

# Bounded wait for all three pid files (the tree self-reports its own pids —
# no guessing).
group_pids_ready=false
for _ in $(seq 1 20); do
  if run_exec "$MAIN_CID" "0:0" sh -c 'test -f /tmp/group-parent.pid && test -f /tmp/group-child.pid && test -f /tmp/group-grandchild.pid'; then
    group_pids_ready=true
    break
  fi
  sleep 0.5
done
[ "$group_pids_ready" = "true" ] || fail "signal handling: the uid-10001 test process tree never wrote all three pid files — setup itself failed, before any kill was attempted"

group_parent_pid="$(run_exec "$MAIN_CID" "0:0" cat /tmp/group-parent.pid | tr -d '[:space:]')"
group_child_pid="$(run_exec "$MAIN_CID" "0:0" cat /tmp/group-child.pid | tr -d '[:space:]')"
group_grandchild_pid="$(run_exec "$MAIN_CID" "0:0" cat /tmp/group-grandchild.pid | tr -d '[:space:]')"
[ -n "$group_parent_pid" ] && [ -n "$group_child_pid" ] && [ -n "$group_grandchild_pid" ] \
  || fail "signal handling: one or more test-tree pid files were empty (parent='${group_parent_pid}' child='${group_child_pid}' grandchild='${group_grandchild_pid}')"
log "  test tree pids: parent=${group_parent_pid} child=${group_child_pid} grandchild=${group_grandchild_pid}"

test_group_pgid="$(run_exec "$MAIN_CID" "0:0" /tmp/pgid-of.sh "$group_parent_pid" | tr -d '[:space:]')"
[ -n "$test_group_pgid" ] || fail "signal handling: could not determine the test tree's pgid from /proc/${group_parent_pid}/stat"
log "  test tree pgid: ${test_group_pgid}"

# Refuse to signal a group that is not exclusively the test tree's. Without
# setsid, the tree could inherit a pgid shared with the root service (pid 1)
# or its supervisor, and a root `kill -<pgid>` would take down the service
# instead of proving anything. The group leader must be the tree's own parent.
service_pgid="$(run_exec "$MAIN_CID" "0:0" /tmp/pgid-of.sh 1 | tr -d '[:space:]')"
[ "$test_group_pgid" != "$service_pgid" ] \
  || fail "signal handling: the test tree shares pgid ${test_group_pgid} with the root service (pid 1) — refusing to signal it"
[ "$test_group_pgid" = "$group_parent_pid" ] \
  || fail "signal handling: the test tree's pgid (${test_group_pgid}) is not its own parent (${group_parent_pid}), so the group may contain other processes — refusing to signal it"

# Positive control: every recorded pid is alive AND really running as uid
# 10001 before the kill — otherwise the kill "succeeding" would prove nothing
# (it could just be signalling processes that were never there or never
# 10001-owned in the first place).
GROUP_TREE_PID_NAMES=(group_parent_pid group_child_pid group_grandchild_pid)
GROUP_TREE_PIDS=("$group_parent_pid" "$group_child_pid" "$group_grandchild_pid")
for pid_idx in 0 1 2; do
  pid_name="${GROUP_TREE_PID_NAMES[$pid_idx]}"
  pid_val="${GROUP_TREE_PIDS[$pid_idx]}"
  must_succeed "signal handling positive control: ${pid_name} (${pid_val}) exists before the kill" "$MAIN_CID" "0:0" test -d "/proc/${pid_val}"
  # shellcheck disable=SC2016 # awk's own $2 field reference, deliberately not a bash expansion
  pid_uid_line="$(run_exec "$MAIN_CID" "0:0" awk '/^Uid:/{print $2}' "/proc/${pid_val}/status")"
  [ "$pid_uid_line" = "10001" ] || fail "signal handling positive control: ${pid_name} (${pid_val}) has real uid ${pid_uid_line}, expected 10001 — the test tree did not actually run as the agent uid, so killing it would prove nothing"
done
pass "signal handling positive control: all three test-tree pids (parent/child/grandchild) exist and run as real uid 10001 before the kill"

# The actual property: root, with ONLY the production capabilities (CAP_KILL
# among them, no CAP_SYS_PTRACE), signals the uid-10001 process GROUP with a
# negative pgid — exactly what killChildGroup does
# (apps/workspace-agent/src/opencode-server.ts: process.kill(-(child.pid), 'SIGTERM')).
#
# NOT `kill -TERM -- "-${pgid}"`: the image's kill is busybox's, which does
# not understand the GNU `--` end-of-options marker and rejects it ("kill:
# invalid number '--'"). Signal the group the exact way killChildGroup itself
# does — via node's process.kill(-pgid, 'SIGTERM') — rather than chasing
# busybox kill's own negative-number syntax. node is already in this image.
run_exec "$MAIN_CID" "0:0" node -e 'process.kill(-Number(process.argv[1]), "SIGTERM")' "$test_group_pgid"

signal_reaped=false
for _ in $(seq 1 "$SIGNAL_WAIT_TIMEOUT_S"); do
  if ! run_exec "$MAIN_CID" "0:0" sh -c "test -d /proc/${group_parent_pid} || test -d /proc/${group_child_pid} || test -d /proc/${group_grandchild_pid}"; then
    signal_reaped=true
    break
  fi
  sleep 1
done
if [ "$signal_reaped" != "true" ]; then
  still_alive=""
  for pid_idx in 0 1 2; do
    pid_name="${GROUP_TREE_PID_NAMES[$pid_idx]}"
    pid_val="${GROUP_TREE_PIDS[$pid_idx]}"
    run_exec "$MAIN_CID" "0:0" test -d "/proc/${pid_val}" && still_alive="${still_alive} ${pid_name}(${pid_val})"
  done
  fail "signal handling: 'kill -TERM -${test_group_pgid}' as root did not reap the uid-10001 test tree within ${SIGNAL_WAIT_TIMEOUT_S}s — still alive:${still_alive:- none? (race — re-check the poll logic)} — this directly exercises what killChildGroup depends on"
fi
# docker top the CONTAINER (not /proc) as an independent cross-check that we
# didn't just lose the pids to a container-wide teardown — the container is
# still supposed to be fully up at this point.
docker top "$MAIN_CID" >/dev/null 2>&1 || fail "signal handling: the container itself is no longer running — this check is only meaningful while it's up, not via container teardown"
pass "signal handling: root, with only the production capabilities (CAP_KILL, no CAP_SYS_PTRACE), sent SIGTERM to the uid-10001 process group's negative pgid and reaped parent + child + GRANDCHILD, entirely inside a still-running container"

# Negative control: the direction is one-way. As uid 10001, signalling the
# root service (pid 1) must fail with a permission error, and pid 1 must
# still be alive and the container still healthy afterward.
#
# `kill -TERM 1` (a single positive pid, no negative-pgid `--` marker) means
# exactly what it says under busybox's kill — this call is NOT affected by
# the `--` incompatibility fixed above, confirmed by inspection of busybox's
# kill applet (it only special-cases the leading `-` on NEGATIVE numbers /
# signal names, never on a bare positive pid).
must_fail "signal handling negative control: uid 10001 cannot kill -TERM the root service (pid 1)" "$MAIN_CID" "$AGENT_USER" kill -TERM 1
must_succeed "signal handling negative control: pid 1 is still alive after the denied kill attempt" "$MAIN_CID" "0:0" test -d /proc/1
wait_for_healthz "$MAIN_CID" 10 || fail "signal handling negative control: the container is no longer healthy after the denied 10001->root kill attempt (pid 1 should be completely unaffected)"
pass "signal handling negative control: uid 10001 cannot signal the root service; pid 1 and the container's healthz remain unaffected"

# OpenCode's own process group, read-only — never killed through this path.
# Whether OpenCode is actually serving at this point in the harness: yes for
# this specific check (it only needs `opencode serve` to be listening, which
# happens on boot independent of provider credentials — the credential-only
# gap this harness cannot exercise is a live AGENTIC TURN through the
# mention loop, e.g. the :9200 proxy-reaches-OpenCode check in phase 4 and
# this group-membership check, not "is the process up at all").
set +e
oc_pid_now="$(run_exec "$MAIN_CID" "0:0" pidof opencode 2>/dev/null | awk '{print $1}')"
set -e
if [ -z "$oc_pid_now" ]; then
  log "  OpenCode is not running at this point in the harness (pidof opencode found nothing) — skipping the OpenCode-group-membership check; not a failure of this phase's own properties"
else
  oc_group_scan="$(run_exec "$MAIN_CID" "0:0" /tmp/group-scan.sh "$oc_pid_now")"
  log "  OpenCode (pid ${oc_pid_now}) process-group scan:"
  printf '%s\n' "$oc_group_scan" | while IFS= read -r scan_line; do log "    ${scan_line}"; done
  oc_group_non_agent="$(printf '%s\n' "$oc_group_scan" | grep '^MEMBER' | grep -v 'uid=10001' || true)"
  [ -z "$oc_group_non_agent" ] || fail "signal handling: OpenCode's process group contains non-10001 member(s): ${oc_group_non_agent}"
  oc_member_count="$(printf '%s\n' "$oc_group_scan" | grep -c '^MEMBER')"
  [ "$oc_member_count" -ge 1 ] || fail "signal handling: OpenCode's process-group scan found zero members, including OpenCode itself — scan logic is broken"
  pass "OpenCode's own process group (pid ${oc_pid_now}) has ${oc_member_count} member(s), all uid 10001 — confirms detached:true made it a group leader of an all-agent-uid group (read-only check, never killed)"
fi

# ─────────────────────────────────────────────────────────────────────────────
# docker stop: kept for its own real purpose — a clean shutdown within the
# timeout — NOT as proof of reaping (Phase 4d above already proved the
# actual signalling mechanism against real /proc state; an exited container
# reporting no processes is true by definition and proves nothing about
# killChildGroup specifically).
# ─────────────────────────────────────────────────────────────────────────────
docker stop --time "$SHUTDOWN_TIMEOUT_S" "$MAIN_CID" >/dev/null
if docker top "$MAIN_CID" >/dev/null 2>&1; then
  fail "shutdown: container is still running after 'docker stop --time ${SHUTDOWN_TIMEOUT_S}' — the supervisor did not exit cleanly within the timeout"
fi
container_state="$(docker inspect -f '{{.State.Status}}' "$MAIN_CID")"
[ "$container_state" = "exited" ] || fail "shutdown: container state after stop is '${container_state}', expected 'exited'"
pass "shutdown: the container stops cleanly within ${SHUTDOWN_TIMEOUT_S}s (reaping itself was already proven directly in phase 4d, not inferred from this)"

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
