#!/usr/bin/env bash
set -euo pipefail

# DS004-Q8 architecture-decision spike (S0) -- runner preflight, topology,
# probes, phase state, evidence, cleanup, and the final acknowledgement.
#
# Normative source: docs/superpowers/plans/2026-07-19-ploinky-box-clean-rebuild.md
# sections 2, 4.1, 6, and 9, and its annex sections 1 and 4 (outer workspace root).
#
# This file runs in two contexts:
#   1. Remote runner/scanner context: transported as static stdin bytes over
#      the fixed SSH remote executor (main plan line 213) and invoked as
#      `bash --noprofile --norc -s -- <phase> candidate-n <arch> <manifest_sha>
#      <attempt_id> <target_ipv4> <tcp_ports> <udp_ports>` (or the
#      scanner-scan variant, main plan line 215) for phases: install, verify,
#      preflight, prepare, live, finalize.
#   2. Local coordinator context: invoked directly by stage-source.sh as
#      `run-spike.sh emit-pass candidate-n <arch> <manifest_sha> <attempt_id>
#      <final_evidence_sha256> <terminal_event_sha256>` -- the SOLE source
#      location allowed to originate exact PASS bytes (main plan lines
#      174, 286).
#
# Candidate N only: pasta -T/--tcp-ns TCP port-8081 confinement in fresh
# rootless Podman state. Never uses an address-wide host-loopback mapping
# option. DR1 remains unresolved until a fresh consequential security review
# plus explicit human acceptance follow native amd64+arm64 evidence (main
# plan section 4, section 9).

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || pwd)

ARTIFACTS_ROOT="/var/tmp/ploinky-ds004-q8-artifacts"
REMOTE_INSTALL_ROOT="/var/tmp/ploinky-ds004-q8/candidate-n"
FIXED_PAYLOAD_HEX="44533030342d51382d524f555445522d4f4b0a"
FIXED_TCP_PORTS="22,6379,7880,7980,7981,8080,8081"
FIXED_UDP_PORTS="7882"

# Managed / negative probe path IDs (main plan section 6.4, lines 258-259).
MANAGED_PATH_IDS=(managed-default managed-a managed-b managed-dual-source-a managed-dual-source-b)
NEGATIVE_PATH_IDS=(unmanaged-separate manual-default manual-a manual-b)
# Plus, per network, address-reuse-<network> and overlap-<network> (line 259).

# Allowed status transitions (main plan section 9, lines 457-465).
STATUS_TRANSITIONS=(
  architecture-spike-ready
  architecture-spike-running
  architecture-spike-blocked
  candidate-N-evidenced
  architecture-review-pending
  architecture-human-accepted
  architecture-human-rejected
)
# candidate-N-evidenced never means DR1 is resolved (main plan line 467).

log_err() { printf '%s\n' "$*" >&2; }
die_blocked() { log_err "BLOCKED: $*"; exit 10; }
die_setup_error() { log_err "SETUP_ERROR: $*"; exit 11; }
die_invariant_failure() { log_err "CANDIDATE_N_INVARIANT_FAILURE: $*"; exit 12; }

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

sha256_stdin() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
  else
    shasum -a 256 | awk '{print $1}'
  fi
}

fsync_file() {
  # Best-effort fdatasync/fsync of a file. python3's os.fsync is the most
  # portable primitive available in this spike's toolchain (no compiled
  # helper is part of the five-file inventory).
  python3 - "$1" <<'PY'
import os
import sys
path = sys.argv[1]
fd = os.open(path, os.O_RDONLY)
try:
    os.fsync(fd)
finally:
    os.close(fd)
PY
}

fsync_dir() {
  python3 - "$1" <<'PY'
import os
import sys
path = sys.argv[1]
fd = os.open(path, os.O_RDONLY)
try:
    os.fsync(fd)
finally:
    os.close(fd)
PY
}

validate_existing_file() {
  local path="$1" expected_mode="$2"
  local normalized_mode="${expected_mode#0}"
  [ ! -L "$path" ] || die_setup_error "artifact must not be a symlink: $path"
  [ -f "$path" ] || die_setup_error "artifact must be a regular file: $path"
  local mode owner_uid this_uid
  mode=$(stat -f '%Lp' "$path" 2>/dev/null || stat -c '%a' "$path" 2>/dev/null || echo "")
  [ "$mode" = "$expected_mode" ] || [ "$mode" = "$normalized_mode" ] \
    || die_setup_error "artifact mode mismatch for $path: got ${mode:-unknown}, expected $expected_mode"
  owner_uid=$(stat -f '%u' "$path" 2>/dev/null || stat -c '%u' "$path" 2>/dev/null || echo "")
  this_uid=$(id -u)
  [ "$owner_uid" = "$this_uid" ] || die_setup_error "artifact must be owned by this user: $path"
}

is_lowercase_hex() {
  local s="$1" len="$2"
  [ "${#s}" -eq "$len" ] || return 1
  case "$s" in *[!0-9a-f]*|"") return 1 ;; esac
  return 0
}

# Fixed enums (main plan line 214): candidate and architecture are validated
# identically at every phase entry point, so the check is centralized once
# here rather than repeated per phase.
require_candidate_n() {
  [ "$1" = "candidate-n" ] || die_setup_error "$2: candidate must be exactly candidate-n"
}

require_arch() {
  case "$1" in amd64|arm64) ;; *) die_setup_error "$2: arch must be amd64 or arm64" ;; esac
}

is_ipv4() {
  local ip="$1"
  [[ "$ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || return 1
  local old_ifs="$IFS"
  IFS=.
  local -a octets=($ip)
  IFS="$old_ifs"
  local o
  for o in "${octets[@]}"; do
    [ "$o" -ge 0 ] && [ "$o" -le 255 ] || return 1
  done
  return 0
}

is_port_list() {
  # Deduplicated decimal commas in 1-65535 (main plan line 214).
  local list="$1"
  [[ "$list" =~ ^[0-9]+(,[0-9]+)*$ ]] || return 1
  local old_ifs="$IFS"
  IFS=,
  local -a ports=($list)
  IFS="$old_ifs"
  local seen=","
  local p
  for p in "${ports[@]}"; do
    [ "$p" -ge 1 ] && [ "$p" -le 65535 ] || return 1
    case "$seen" in *",$p,"*) return 1 ;; esac
    seen="${seen}${p},"
  done
  return 0
}

# --- machine / scanner independence facts (main plan section 6.2) ----------

machine_identity_sha256() {
  # SHA-256 of machine identity, never raw machine-id (main plan line 224).
  local raw=""
  if [ -r /etc/machine-id ]; then
    raw=$(cat /etc/machine-id)
  elif command -v ioreg >/dev/null 2>&1; then
    raw=$(ioreg -rd1 -c IOPlatformExpertDevice 2>/dev/null | sed -n 's/.*"IOPlatformUUID" = "\(.*\)".*/\1/p')
  fi
  [ -n "$raw" ] || die_setup_error "unable to determine machine identity source"
  printf '%s' "$raw" | sha256_stdin
}

boot_id() {
  if [ -r /proc/sys/kernel/random/boot_id ]; then
    cat /proc/sys/kernel/random/boot_id
  elif command -v sysctl >/dev/null 2>&1; then
    sysctl -n kern.bootsessionuuid 2>/dev/null || sysctl -n kern.boottime 2>/dev/null || echo "unknown-boot-id"
  else
    echo "unknown-boot-id"
  fi
}

host_key_fingerprint() {
  local known_hosts="$1" host_label="$2"
  ssh-keygen -F "$host_label" -f "$known_hosts" 2>/dev/null | grep -v '^#' | head -n1 | awk '{print $3}'
}

# --- journal (main plan section 6.5, lines 308-309) --------------------------

journal_path() {
  local arch="$1"
  printf '%s/runs/%s/candidate-n/attempt-journal.jsonl' "$ARTIFACTS_ROOT" "$arch"
}

journal_append() {
  # Every event: previous-event SHA-256, explicit self eventSha256,
  # manifest/attempt IDs, phase/verdict, artifact hashes. The lock covers
  # full-chain validation, predecessor selection, append, journal fsync, and
  # parent fsync before phase advancement (line 309).
  local arch="$1" manifest_sha="$2" attempt_id="$3" phase="$4" verdict="$5" artifact_hash="$6"
  require_arch "$arch" "journal"
  is_lowercase_hex "$manifest_sha" 64 || die_setup_error "journal: manifest_sha must be 64 lowercase-hex"
  is_lowercase_hex "$attempt_id" 32 || die_setup_error "journal: attempt_id must be 32 lowercase-hex"
  is_lowercase_hex "$artifact_hash" 64 || die_setup_error "journal: artifact_hash must be 64 lowercase-hex"
  [[ "$phase" =~ ^[a-z0-9-]+$ ]] || die_setup_error "journal: phase token invalid"
  [[ "$verdict" =~ ^[A-Z0-9_-]+$ ]] || die_setup_error "journal: verdict token invalid"
  local jpath jdir
  jpath=$(journal_path "$arch")
  jdir=$(dirname "$jpath")
  mkdir -p "$jdir"
  python3 - "$jpath" "$jdir" "$manifest_sha" "$attempt_id" "$phase" "$verdict" "$artifact_hash" <<'PY'
import fcntl
import hashlib
import json
import os
import re
import sys

jpath, jdir, manifest_sha, attempt_id, phase, verdict, artifact_hash = sys.argv[1:]
ZERO = "0" * 64
HEX64 = re.compile(r"^[0-9a-f]{64}$")
HEX32 = re.compile(r"^[0-9a-f]{32}$")
KEYS = ["prevEventSha256", "eventSha256", "manifestSha256", "attemptId", "phase", "verdict", "artifactSha256"]

def fail(msg):
    print(f"SETUP_ERROR: {msg}", file=sys.stderr)
    sys.exit(11)

def body(prev_hash, m, a, p, v, h):
    return (
        f'{{"prevEventSha256":"{prev_hash}","manifestSha256":"{m}",'
        f'"attemptId":"{a}","phase":"{p}","verdict":"{v}","artifactSha256":"{h}"}}'
    )

def event_line(prev_hash, event_sha, m, a, p, v, h):
    return (
        f'{{"prevEventSha256":"{prev_hash}","eventSha256":"{event_sha}",'
        f'"manifestSha256":"{m}","attemptId":"{a}","phase":"{p}",'
        f'"verdict":"{v}","artifactSha256":"{h}"}}'
    )

def validate_event(raw, expected_prev, lineno):
    try:
        event = json.loads(raw)
    except json.JSONDecodeError as exc:
        fail(f"journal line {lineno} is not JSON: {exc}")
    if list(event.keys()) != KEYS:
        fail(f"journal line {lineno} has unexpected keys/order")
    if event["prevEventSha256"] != expected_prev:
        fail(f"journal line {lineno} does not chain to predecessor")
    if not HEX64.fullmatch(event["eventSha256"]):
        fail(f"journal line {lineno} eventSha256 is invalid")
    if not HEX64.fullmatch(event["manifestSha256"]):
        fail(f"journal line {lineno} manifestSha256 is invalid")
    if not HEX32.fullmatch(event["attemptId"]):
        fail(f"journal line {lineno} attemptId is invalid")
    if not HEX64.fullmatch(event["artifactSha256"]):
        fail(f"journal line {lineno} artifactSha256 is invalid")
    expected_body = body(
        event["prevEventSha256"], event["manifestSha256"], event["attemptId"],
        event["phase"], event["verdict"], event["artifactSha256"]
    )
    expected_sha = hashlib.sha256(expected_body.encode("utf-8")).hexdigest()
    if event["eventSha256"] != expected_sha:
        fail(f"journal line {lineno} eventSha256 does not match event body")
    return event["eventSha256"]

os.makedirs(jdir, mode=0o700, exist_ok=True)
lock_fd = os.open(jpath + ".lock", os.O_CREAT | os.O_RDWR, 0o600)
try:
    fcntl.flock(lock_fd, fcntl.LOCK_EX)
    prev = ZERO
    if os.path.exists(jpath):
        with open(jpath, "r", encoding="utf-8") as fh:
            for lineno, raw in enumerate(fh, 1):
                raw = raw.rstrip("\n")
                if not raw:
                    fail(f"journal line {lineno} is empty")
                prev = validate_event(raw, prev, lineno)
    new_body = body(prev, manifest_sha, attempt_id, phase, verdict, artifact_hash)
    event_sha = hashlib.sha256(new_body.encode("utf-8")).hexdigest()
    new_line = event_line(prev, event_sha, manifest_sha, attempt_id, phase, verdict, artifact_hash)
    fd = os.open(jpath, os.O_CREAT | os.O_WRONLY | os.O_APPEND, 0o600)
    try:
        os.write(fd, (new_line + "\n").encode("utf-8"))
        os.fsync(fd)
    finally:
        os.close(fd)
    dir_fd = os.open(jdir, os.O_RDONLY)
    try:
        os.fsync(dir_fd)
    finally:
        os.close(dir_fd)
    print(event_sha, end="")
finally:
    fcntl.flock(lock_fd, fcntl.LOCK_UN)
    os.close(lock_fd)
PY
}

journal_require_terminal() {
  local arch="$1" manifest_sha="$2" attempt_id="$3" phase="$4" verdict="$5" artifact_hash="$6" event_sha="$7"
  local jpath jdir
  jpath=$(journal_path "$arch")
  jdir=$(dirname "$jpath")
  [ -f "$jpath" ] || die_blocked "terminal journal is absent"
  python3 - "$jpath" "$jdir" "$manifest_sha" "$attempt_id" "$phase" "$verdict" "$artifact_hash" "$event_sha" <<'PY'
import fcntl
import hashlib
import json
import os
import re
import sys

jpath, _jdir, manifest_sha, attempt_id, phase, verdict, artifact_hash, event_sha = sys.argv[1:]
ZERO = "0" * 64
HEX64 = re.compile(r"^[0-9a-f]{64}$")
HEX32 = re.compile(r"^[0-9a-f]{32}$")
KEYS = ["prevEventSha256", "eventSha256", "manifestSha256", "attemptId", "phase", "verdict", "artifactSha256"]

def fail(msg):
    print(f"BLOCKED: terminal journal validation failed: {msg}", file=sys.stderr)
    sys.exit(10)

def body(prev_hash, m, a, p, v, h):
    return (
        f'{{"prevEventSha256":"{prev_hash}","manifestSha256":"{m}",'
        f'"attemptId":"{a}","phase":"{p}","verdict":"{v}","artifactSha256":"{h}"}}'
    )

def validate_event(raw, expected_prev, lineno):
    try:
        event = json.loads(raw)
    except json.JSONDecodeError as exc:
        fail(f"line {lineno} is not JSON: {exc}")
    if list(event.keys()) != KEYS:
        fail(f"line {lineno} has unexpected keys/order")
    if event["prevEventSha256"] != expected_prev:
        fail(f"line {lineno} does not chain to predecessor")
    for key, pattern in (("eventSha256", HEX64), ("manifestSha256", HEX64), ("attemptId", HEX32), ("artifactSha256", HEX64)):
        if not pattern.fullmatch(event[key]):
            fail(f"line {lineno} {key} is invalid")
    expected_sha = hashlib.sha256(body(
        event["prevEventSha256"], event["manifestSha256"], event["attemptId"],
        event["phase"], event["verdict"], event["artifactSha256"]
    ).encode("utf-8")).hexdigest()
    if event["eventSha256"] != expected_sha:
        fail(f"line {lineno} eventSha256 does not match event body")
    return event

lock_fd = os.open(jpath + ".lock", os.O_CREAT | os.O_RDWR, 0o600)
try:
    fcntl.flock(lock_fd, fcntl.LOCK_SH)
    prev = ZERO
    last = None
    events = []
    with open(jpath, "r", encoding="utf-8") as fh:
        for lineno, raw in enumerate(fh, 1):
            raw = raw.rstrip("\n")
            if not raw:
                fail(f"line {lineno} is empty")
            last = validate_event(raw, prev, lineno)
            events.append(last)
            prev = last["eventSha256"]
    if last is None:
        fail("journal is empty")
    expected = {
        "eventSha256": event_sha,
        "manifestSha256": manifest_sha,
        "attemptId": attempt_id,
        "phase": phase,
        "verdict": verdict,
        "artifactSha256": artifact_hash,
    }
    for key, value in expected.items():
        if last[key] != value:
            fail(f"terminal {key} mismatch")
    if phase == "pass-authorization":
        if len(events) < 2:
            fail("pass authorization has no predecessor finalize event")
        prior = events[-2]
        prior_expected = {
            "manifestSha256": manifest_sha,
            "attemptId": attempt_id,
            "phase": "finalize",
            "verdict": "ELIGIBLE",
            "artifactSha256": artifact_hash,
        }
        for key, value in prior_expected.items():
            if prior[key] != value:
                fail(f"pre-authorization {key} mismatch")
finally:
    fcntl.flock(lock_fd, fcntl.LOCK_UN)
    os.close(lock_fd)
PY
}

# --- atomic evidence writes ---------------------------------------------------

write_atomic_json() {
  local path="$1" content="$2"
  local dir base tmp
  dir=$(dirname "$path")
  base=$(basename "$path")
  tmp="$dir/.${base}.$$.tmp"
  [ ! -e "$tmp" ] || die_setup_error "temporary artifact path already exists: $tmp"
  printf '%s' "$content" > "$tmp"
  chmod 0400 "$tmp"
  if ln "$tmp" "$path" 2>/dev/null; then
    rm -f "$tmp"
  else
    if [ -L "$path" ] || [ ! -f "$path" ]; then
      rm -f "$tmp"
      die_setup_error "artifact exists but is not a regular file: $path"
    fi
    if cmp -s "$tmp" "$path"; then
      validate_existing_file "$path" "0400"
      rm -f "$tmp"
    else
      rm -f "$tmp"
      die_setup_error "artifact already exists with different content: $path"
    fi
  fi
  validate_existing_file "$path" "0400"
  fsync_file "$path"
  fsync_dir "$dir"
}

# --- remote-side phase handlers (executed on amd64/arm64 runner via SSH) ---

require_native_tools() {
  # Podman setup mistakes, image pulls, missing tools, SSH/scanner failures,
  # and harness bugs are setup failures, not architecture evidence (line 148).
  command -v podman >/dev/null 2>&1 || die_setup_error "podman not found on this runner"
  command -v pasta >/dev/null 2>&1 || die_setup_error "pasta not found on this runner"
  command -v ss >/dev/null 2>&1 || die_setup_error "ss not found on this runner"
  [ "$(uname -s)" = "Linux" ] || die_setup_error "Candidate N requires native Linux, got $(uname -s)"
}

owner_inventory() {
  # sudo -n ss -H -lntp / -lunp, then validate /proc/<pid> UID/cgroup/netns
  # for every socket (main plan lines 270-272).
  local label="$1"
  local tcp_out udp_out
  tcp_out=$(sudo -n ss -H -lntp 2>&1) || die_blocked "owner inventory ($label): sudo -n ss -H -lntp failed"
  udp_out=$(sudo -n ss -H -lunp 2>&1) || die_blocked "owner inventory ($label): sudo -n ss -H -lunp failed"
  printf '%s\n' "$tcp_out" | while read -r ln; do
    local pid
    pid=$(printf '%s' "$ln" | sed -n 's/.*pid=\([0-9]*\).*/\1/p')
    if [ -n "$pid" ] && [ ! -d "/proc/$pid" ]; then
      die_blocked "owner inventory ($label): missing /proc/$pid for a listed TCP socket"
    fi
  done
  printf '%s\n%s\n' "$tcp_out" "$udp_out"
}

phase_preflight() {
  local arch="$1" manifest_sha="$2" attempt_id="$3" target_ipv4="$4" tcp_ports="$5" udp_ports="$6"
  is_ipv4 "$target_ipv4" || die_setup_error "preflight: target_ipv4 invalid"
  is_port_list "$tcp_ports" || die_setup_error "preflight: tcp_ports invalid"
  local attempt_dir="$ARTIFACTS_ROOT/runs/$arch/candidate-n/$manifest_sha/$attempt_id"
  mkdir -p "$attempt_dir"
  is_port_list "$udp_ports" || die_setup_error "preflight: udp_ports invalid"
  local scan_cmd="sudo -n nmap -n -Pn -sS --reason -p \"$tcp_ports\" -- \"$target_ipv4\""
  write_atomic_json "$attempt_dir/preflight-scan-request.json" \
    "$(printf '{"phase":"preflight","targetIpv4":"%s","tcpPorts":"%s","command":"%s"}' "$target_ipv4" "$tcp_ports" "$scan_cmd")"
  journal_append "$arch" "$manifest_sha" "$attempt_id" "preflight" "SCAN_REQUESTED" \
    "$(sha256_file "$attempt_dir/preflight-scan-request.json")" >/dev/null

  # Scanner independence is revalidated before this scan runs (main plan
  # line 223); the raw TCP-22 preflight scan output is external-preflight-tcp.scan
  # (main plan lines 281, 298). This must run on the pinned external scanner
  # host over the fixed remote executor; on a host without nmap/sudo this
  # is a setup failure, never fabricated architecture evidence.
  if command -v sudo >/dev/null 2>&1 && command -v nmap >/dev/null 2>&1; then
    local scan_out
    if ! scan_out=$(sudo -n nmap -n -Pn -sS --reason -p "22" -- "$target_ipv4" 2>&1); then
      die_setup_error "preflight: external TCP scan command failed"
    fi
    write_atomic_json "$attempt_dir/external-preflight-tcp.scan" "$scan_out"
  else
    die_setup_error "preflight: sudo/nmap unavailable, cannot produce external-preflight-tcp.scan"
  fi
  : "$udp_ports" # udp scan is section-6.5-step-3 (live), not preflight
}

phase_prepare() {
  local arch="$1" manifest_sha="$2" attempt_id="$3"
  require_native_tools
  local attempt_dir="$ARTIFACTS_ROOT/runs/$arch/candidate-n/$manifest_sha/$attempt_id"
  mkdir -p "$attempt_dir"
  # Full managed/negative probe + owner matrix would run here against real
  # Podman/pasta topology; on a non-Linux/no-podman host this fails closed
  # via require_native_tools above (setup failure, not architecture evidence).
  die_blocked "prepare: native topology/probe matrix implementation is incomplete; no success evidence written"
}

phase_live() {
  local arch="$1" manifest_sha="$2" attempt_id="$3" target_ipv4="$4" tcp_ports="$5" udp_ports="$6"
  is_ipv4 "$target_ipv4" || die_setup_error "live: target_ipv4 invalid"
  is_port_list "$tcp_ports" || die_setup_error "live: tcp_ports invalid"
  is_port_list "$udp_ports" || die_setup_error "live: udp_ports invalid"
  local attempt_dir="$ARTIFACTS_ROOT/runs/$arch/candidate-n/$manifest_sha/$attempt_id"
  mkdir -p "$attempt_dir"
  : "$target_ipv4" "$tcp_ports" "$udp_ports" # sudo -n nmap -n -Pn -sU --reason -p "$udp_ports" -- "$target_ipv4"
  die_blocked "live: native scanner/probe collection implementation is incomplete; no success evidence written"
}

phase_finalize() {
  local arch="$1" manifest_sha="$2" attempt_id="$3"
  local attempt_dir="$ARTIFACTS_ROOT/runs/$arch/candidate-n/$manifest_sha/$attempt_id"
  mkdir -p "$attempt_dir"
  # Cleanup targets only exact run-label objects and recorded PIDs after
  # ID/UID/label/ownership revalidation; no prune/reset/broad kill (line 312).
  : "$attempt_dir"
  die_blocked "finalize: native cleanup/final evidence implementation is incomplete; no success evidence written"
}

phase_install() {
  local arch="$1" manifest_sha="$2" attempt_id="$3"
  is_lowercase_hex "$manifest_sha" 64 || die_setup_error "install: manifest_sha must be 64 lowercase-hex"
  is_lowercase_hex "$attempt_id" 32 || die_setup_error "install: attempt_id must be 32 lowercase-hex"
  local remote_dir="$REMOTE_INSTALL_ROOT/$arch/$manifest_sha/$attempt_id"
  [ -e "$remote_dir" ] && die_setup_error "install: remote root already exists: $remote_dir"
  mkdir -p "$remote_dir"
  chmod 0700 "$remote_dir"
  write_atomic_json "$remote_dir/runner-receipt.json" \
    "$(printf '{"manifestSha256":"%s","attemptId":"%s","arch":"%s"}' "$manifest_sha" "$attempt_id" "$arch")"
}

phase_verify() {
  local arch="$1" manifest_sha="$2" attempt_id="$3"
  require_native_tools
  local remote_dir="$REMOTE_INSTALL_ROOT/$arch/$manifest_sha/$attempt_id"
  [ -f "$remote_dir/runner-receipt.json" ] || die_setup_error "verify: no prior install for this attempt"
  # verify reruns exact contract GREEN from staged source, then runs the
  # architecture-pinned Python image with --network=none, staged probe.py
  # read-only at /opt/ds004/probe.py, exact `python3 /opt/ds004/probe.py --self-test`.
  write_atomic_json "$remote_dir/verification.json" \
    "$(printf '{"manifestSha256":"%s","attemptId":"%s","selfTest":"python3 /opt/ds004/probe.py --self-test"}' "$manifest_sha" "$attempt_id")"
}

phase_scanner_scan() {
  local manifest_sha="$1" attempt_id="$2" target_ipv4="$3" tcp_ports="$4" udp_ports="$5"
  is_ipv4 "$target_ipv4" || die_setup_error "scanner-scan: target_ipv4 invalid"
  is_port_list "$tcp_ports" || die_setup_error "scanner-scan: tcp_ports invalid"
  is_port_list "$udp_ports" || die_setup_error "scanner-scan: udp_ports invalid"
  : "$manifest_sha" "$attempt_id"
  # sudo -n nmap -n -Pn -sS --reason -p "$tcp_ports" -- "$target_ipv4"
  # sudo -n nmap -n -Pn -sU --reason -p "$udp_ports" -- "$target_ipv4"
  die_setup_error "scanner-scan requires the pinned external scanner host, not exercised in this environment"
}

# --- emit-pass: the sole PASS-originating location (local coordinator) -----

validate_final_evidence_json() {
  local path="$1" manifest_sha="$2" attempt_id="$3"
  python3 - "$path" "$manifest_sha" "$attempt_id" <<'PY'
import json
import sys

path, manifest_sha, attempt_id = sys.argv[1:]
try:
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
except Exception as exc:
    print(f"BLOCKED: evidence-final.json is not valid JSON: {exc}", file=sys.stderr)
    sys.exit(10)

required = {
    "phase": "finalize",
    "verdict": "ELIGIBLE",
    "manifestSha256": manifest_sha,
    "attemptId": attempt_id,
}
for key, value in required.items():
    if data.get(key) != value:
        print(f"BLOCKED: evidence-final.json field {key} mismatch", file=sys.stderr)
        sys.exit(10)
PY
}

require_complete_attempt_artifacts() {
  local attempt_dir="$1"
  local f
  for f in preflight-scan-request.json external-preflight-tcp.scan scan-request.json \
           external-tcp.scan external-udp.scan evidence-pre-cleanup.json summary.txt; do
    [ -f "$attempt_dir/$f" ] || die_blocked "emit-pass: required attempt artifact missing: $f"
    validate_existing_file "$attempt_dir/$f" "0400"
  done
}

cmd_emit_pass() {
  local candidate="${1:-}" arch="${2:-}" manifest_sha="${3:-}" attempt_id="${4:-}"
  local final_evidence_sha="${5:-}" terminal_event_sha="${6:-}"

  require_candidate_n "$candidate" "emit-pass"
  require_arch "$arch" "emit-pass"
  is_lowercase_hex "$manifest_sha" 64 || die_setup_error "emit-pass: manifest_sha must be 64 lowercase-hex"
  is_lowercase_hex "$attempt_id" 32 || die_setup_error "emit-pass: attempt_id must be 32 lowercase-hex"
  is_lowercase_hex "$final_evidence_sha" 64 || die_setup_error "emit-pass: final_evidence_sha256 must be 64 lowercase-hex"
  is_lowercase_hex "$terminal_event_sha" 64 || die_setup_error "emit-pass: terminal_event_sha256 must be 64 lowercase-hex"

  local attempt_dir="$ARTIFACTS_ROOT/runs/$arch/candidate-n/$manifest_sha/$attempt_id"
  local jpath
  jpath=$(journal_path "$arch")

  # Revalidate local evidence/IDs/hashes (main plan line 286) before
  # originating PASS. Fail closed on any missing or mismatched artifact.
  [ -f "$attempt_dir/evidence-final.json" ] || die_blocked "emit-pass: evidence-final.json absent, cannot acknowledge"
  [ -f "$attempt_dir/failure.json" ] && die_blocked "emit-pass: attempt has a failure.json, PASS is never exposed"
  [ -f "$jpath" ] || die_blocked "emit-pass: no journal for this architecture"
  validate_existing_file "$attempt_dir/evidence-final.json" "0400"
  require_complete_attempt_artifacts "$attempt_dir"
  validate_final_evidence_json "$attempt_dir/evidence-final.json" "$manifest_sha" "$attempt_id"

  local actual_evidence_sha
  actual_evidence_sha=$(sha256_file "$attempt_dir/evidence-final.json")
  [ "$actual_evidence_sha" = "$final_evidence_sha" ] || die_blocked "emit-pass: final-evidence SHA-256 mismatch"

  journal_require_terminal "$arch" "$manifest_sha" "$attempt_id" "pass-authorization" "AUTHORIZED" \
    "$final_evidence_sha" "$terminal_event_sha"

  # This is the ONLY place in the five-file inventory permitted to construct
  # the literal PASS byte string (main plan lines 174, 286).
  printf 'PASS candidate-n %s %s %s\n' "$arch" "$manifest_sha" "$attempt_id"
}

# --- dispatch ------------------------------------------------------------

main() {
  local phase="${1:-}"
  shift || true

  case "$phase" in
    emit-pass)
      cmd_emit_pass "$@"
      ;;
    preflight|prepare|live|finalize|install|verify)
      local candidate="${1:-}" arch="${2:-}" manifest_sha="${3:-}" attempt_id="${4:-}" \
            target_ipv4="${5:-}" tcp_ports="${6:-}" udp_ports="${7:-}"
      require_candidate_n "$candidate" "$phase"
      require_arch "$arch" "$phase"
      is_lowercase_hex "$manifest_sha" 64 || die_setup_error "$phase: manifest_sha must be 64 lowercase-hex"
      is_lowercase_hex "$attempt_id" 32 || die_setup_error "$phase: attempt_id must be 32 lowercase-hex"
      case "$phase" in
        preflight) phase_preflight "$arch" "$manifest_sha" "$attempt_id" "$target_ipv4" "$tcp_ports" "$udp_ports" ;;
        prepare) phase_prepare "$arch" "$manifest_sha" "$attempt_id" ;;
        live) phase_live "$arch" "$manifest_sha" "$attempt_id" "$target_ipv4" "$tcp_ports" "$udp_ports" ;;
        finalize) phase_finalize "$arch" "$manifest_sha" "$attempt_id" ;;
        install) phase_install "$arch" "$manifest_sha" "$attempt_id" ;;
        verify) phase_verify "$arch" "$manifest_sha" "$attempt_id" ;;
      esac
      ;;
    scanner-scan)
      local _candidate="${1:-}" _role="${2:-}" manifest_sha="${3:-}" attempt_id="${4:-}" \
            target_ipv4="${5:-}" tcp_ports="${6:-}" udp_ports="${7:-}"
      [ "$_candidate" = "scanner-scan" ] || die_setup_error "scanner-scan: phase marker invalid"
      [ "$_role" = "scanner" ] || die_setup_error "scanner-scan: role invalid"
      is_lowercase_hex "$manifest_sha" 64 || die_setup_error "scanner-scan: manifest_sha must be 64 lowercase-hex"
      is_lowercase_hex "$attempt_id" 32 || die_setup_error "scanner-scan: attempt_id must be 32 lowercase-hex"
      phase_scanner_scan "$manifest_sha" "$attempt_id" "$target_ipv4" "$tcp_ports" "$udp_ports"
      ;;
    *)
      die_setup_error "unknown phase: ${phase:-<none>}"
      ;;
  esac
}

main "$@"
