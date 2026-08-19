#!/usr/bin/env bash
set -euo pipefail

# DS005-Q8 architecture-decision spike (S0) -- coordinator: GREEN, pack,
# install, verify, run.
#
# Active contracts: docs/specs/DS006-runtime-execution-and-isolation.md and
# docs/specs/DS012-testing-and-verification.md. Historical section and line
# annotations below are retained only as provenance for this self-contained spike.
#
# Owns: deterministic GREEN/pack/install/verify/run orchestration, coordinator
# SSH/scanning, immutable transfers, and journals (main plan line 172).
#
# Allowed status transitions (main plan section 9, lines 457-465):
#   architecture-spike-ready
#   architecture-spike-running
#   architecture-spike-blocked
#   candidate-N-evidenced
#   architecture-review-pending
#   architecture-human-accepted
#   architecture-human-rejected
# candidate-N-evidenced never means DR1 is resolved (main plan line 467).
#
# Taxonomy: every stop is classified BLOCKED, SETUP_ERROR, or a Candidate N
# invariant failure (main plan line 449). Setup failure is never converted
# into architecture evidence (main plan line 450).

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/../../.." && pwd)

FROZEN_BASE_SHA="ac39b870d990869616e4882222c78037dc11d07d"
ARTIFACTS_ROOT="/var/tmp/ploinky-ds005-q8-artifacts"
REMOTE_ROOT_TEMPLATE="/var/tmp/ploinky-ds005-q8/candidate-n"
FIXED_PAYLOAD_HEX="44533030352d51382d524f555445522d4f4b0a"

# Exact immutable artifact path templates (main plan section 6.3/6.5/7,
# annex section 3), documented verbatim for traceability:
#   GREEN:        /var/tmp/ploinky-ds005-q8-artifacts/green/candidate-n/<green_receipt_sha>/
#   amd64 source: /var/tmp/ploinky-ds005-q8-artifacts/source/amd64/candidate-n/<manifest_sha>/
#   arm64 source: /var/tmp/ploinky-ds005-q8-artifacts/source/arm64/candidate-n/<manifest_sha>/
#   attempt root: /var/tmp/ploinky-ds005-q8-artifacts/runs/<arch>/candidate-n/<manifest_sha>/<attempt_id>/
#   journal:      /var/tmp/ploinky-ds005-q8-artifacts/runs/<arch>/candidate-n/attempt-journal.jsonl
#   remote root:  /var/tmp/ploinky-ds005-q8/candidate-n/<arch>/<manifest_sha>/<attempt_id>/

NORMATIVE_PATHS=(
  "container/spike/ds005-q8/run-spike.sh"
  "container/spike/ds005-q8/probe.py"
  "container/spike/ds005-q8/stage-source.sh"
  "container/spike/ds005-q8/README.md"
  "tests/unit/ds005Q8SpikeContract.test.mjs"
)

# Exact canonical destination grammar (main plan line 199), documented
# verbatim for traceability. Bash's [[ =~ ]] engine is POSIX ERE and cannot
# parse PCRE non-capturing groups, so DESTINATION_POSIX_ERE below is an
# equivalent POSIX-ERE translation used for the actual runtime match.
# Canonical (PCRE, documentation-only):
#   ^([A-Za-z0-9_][A-Za-z0-9._-]*)@([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)$
DESTINATION_POSIX_ERE='^[A-Za-z0-9_][A-Za-z0-9._-]*@[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$'

# Exact fixed remote executor template (main plan line 213). Positional
# tokens only; static script bytes alone enter stdin (main plan line 217).
REMOTE_EXECUTOR_PREFIX="/usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin BASH_ENV=/dev/null /bin/bash --noprofile --norc -s --"

log_err() { printf '%s\n' "$*" >&2; }
die_blocked() { log_err "BLOCKED: $*"; exit 10; }
die_setup_error() { log_err "SETUP_ERROR: $*"; exit 11; }

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
  mode=$(stat -c '%a' "$path" 2>/dev/null || stat -f '%Lp' "$path" 2>/dev/null || echo "")
  [ "$mode" = "$expected_mode" ] || [ "$mode" = "$normalized_mode" ] \
    || die_setup_error "artifact mode mismatch for $path: got ${mode:-unknown}, expected $expected_mode"
  owner_uid=$(stat -c '%u' "$path" 2>/dev/null || stat -f '%u' "$path" 2>/dev/null || echo "")
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
# identically everywhere they appear, so the check is centralized once here
# rather than repeated per verb.
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

journal_path() {
  local arch="$1"
  printf '%s/runs/%s/candidate-n/attempt-journal.jsonl' "$ARTIFACTS_ROOT" "$arch"
}

journal_append() {
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
  local arch="$1" manifest_sha="$2" attempt_id="$3" phase="$4" verdict="$5" artifact_hash="$6"
  local jpath jdir
  jpath=$(journal_path "$arch")
  jdir=$(dirname "$jpath")
  [ -f "$jpath" ] || die_blocked "terminal journal is absent"
  python3 - "$jpath" "$jdir" "$manifest_sha" "$attempt_id" "$phase" "$verdict" "$artifact_hash" <<'PY'
import fcntl
import hashlib
import json
import os
import re
import sys

jpath, _jdir, manifest_sha, attempt_id, phase, verdict, artifact_hash = sys.argv[1:]
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
    with open(jpath, "r", encoding="utf-8") as fh:
        for lineno, raw in enumerate(fh, 1):
            raw = raw.rstrip("\n")
            if not raw:
                fail(f"line {lineno} is empty")
            last = validate_event(raw, prev, lineno)
            prev = last["eventSha256"]
    if last is None:
        fail("journal is empty")
    expected = {
        "manifestSha256": manifest_sha,
        "attemptId": attempt_id,
        "phase": phase,
        "verdict": verdict,
        "artifactSha256": artifact_hash,
    }
    for key, value in expected.items():
        if last[key] != value:
            fail(f"terminal {key} mismatch")
finally:
    fcntl.flock(lock_fd, fcntl.LOCK_UN)
    os.close(lock_fd)
PY
}

# --- coordinator input contract (main plan section 6.1) ---------------------

require_coordinator_inputs() {
  local missing=()
  local v
  for v in DS005_EXTERNAL_SCANNER_SSH DS005_AMD64_RUNNER_SSH DS005_ARM64_RUNNER_SSH \
           DS005_AMD64_BOX_LAN_IPV4 DS005_ARM64_BOX_LAN_IPV4 DS005_SSH_KNOWN_HOSTS_FILE \
           DS005_EXTERNAL_SCANNER_IDENTITY_FILE DS005_AMD64_RUNNER_IDENTITY_FILE DS005_ARM64_RUNNER_IDENTITY_FILE; do
    if [ -z "${!v:-}" ]; then missing+=("$v"); fi
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    die_blocked "native execution gate BLOCKED, missing coordinator inputs: ${missing[*]}"
  fi
}

validate_destination() {
  local dest="$1" label="$2"
  [[ "$dest" =~ $DESTINATION_POSIX_ERE ]] || die_setup_error "$label fails destination grammar: $dest"
  local host="${dest#*@}"
  [ "${#host}" -le 253 ] || die_setup_error "$label host exceeds 253 bytes"
  if [[ "$host" =~ ^[0-9.]+$ ]]; then
    is_ipv4 "$host" || die_setup_error "$label numeric host is not a valid IPv4 address: $host"
  fi
}

validate_trust_file() {
  # Absolute, regular, non-symlink, coordinator-owned mode-0600 (main plan line 204).
  local path="$1" label="$2"
  [ -n "$path" ] || die_blocked "$label is empty"
  case "$path" in /*) ;; *) die_setup_error "$label must be an absolute path: $path" ;; esac
  if [ -L "$path" ]; then die_setup_error "$label must not be a symlink: $path"; fi
  [ -e "$path" ] || die_blocked "$label does not exist: $path"
  [ -f "$path" ] || die_setup_error "$label must be a regular file: $path"
  local mode
  mode=$(stat -c '%a' "$path" 2>/dev/null || stat -f '%Lp' "$path" 2>/dev/null || echo "")
  [ "$mode" = "600" ] || die_setup_error "$label must be mode 0600, got ${mode:-unknown}: $path"
  local owner_uid this_uid
  owner_uid=$(stat -c '%u' "$path" 2>/dev/null || stat -f '%u' "$path" 2>/dev/null || echo "")
  this_uid=$(id -u)
  [ "$owner_uid" = "$this_uid" ] || die_setup_error "$label must be coordinator-owned: $path"
}

# --- SSH / SFTP invocation (main plan section 6.1) --------------------------

# Exact fixed SSH options (main plan line 208). No pseudo-terminal, no shell
# profile, no ambient config, no caller-controlled script text, and no
# dynamic command interpretation of any kind (main plan line 218).
ssh_invoke() {
  local destination="$1" known_hosts="$2" identity="$3" remote_executor="$4" script_path="$5"
  ssh -F /dev/null \
      -o BatchMode=yes \
      -o ClearAllForwardings=yes \
      -o IdentitiesOnly=yes \
      -o IdentityAgent=none \
      -o StrictHostKeyChecking=yes \
      -o GlobalKnownHostsFile=/dev/null \
      -o UserKnownHostsFile="$known_hosts" \
      -i "$identity" \
      -T -- "$destination" "$remote_executor" < "$script_path"
}

# Exact fixed SFTP options (main plan line 210).
sftp_invoke() {
  local destination="$1" known_hosts="$2" identity="$3" batch_file="$4"
  sftp -F /dev/null \
       -o BatchMode=yes \
       -o ClearAllForwardings=yes \
       -o IdentitiesOnly=yes \
       -o IdentityAgent=none \
       -o StrictHostKeyChecking=yes \
       -o GlobalKnownHostsFile=/dev/null \
       -o UserKnownHostsFile="$known_hosts" \
       -i "$identity" \
       -b "$batch_file" -- "$destination"
}

build_remote_executor() {
  # <phase> candidate-n <arch> <manifest_sha> <attempt_id> <target_ipv4> <tcp_ports> <udp_ports>
  local phase="$1" arch="$2" manifest_sha="$3" attempt_id="$4" target_ipv4="$5" tcp_ports="$6" udp_ports="$7"
  printf '%s %s candidate-n %s %s %s %s %s %s' \
    "$REMOTE_EXECUTOR_PREFIX" "$phase" "$arch" "$manifest_sha" "$attempt_id" "$target_ipv4" "$tcp_ports" "$udp_ports"
}

build_scanner_executor() {
  # <phase> scanner-scan scanner <manifest_sha> <attempt_id> <target_ipv4> <tcp_ports> <udp_ports>
  local phase="$1" manifest_sha="$2" attempt_id="$3" target_ipv4="$4" tcp_ports="$5" udp_ports="$6"
  printf '%s %s scanner-scan scanner %s %s %s %s %s' \
    "$REMOTE_EXECUTOR_PREFIX" "$phase" "$manifest_sha" "$attempt_id" "$target_ipv4" "$tcp_ports" "$udp_ports"
}

# --- green: node --test tests/unit/ds005Q8SpikeContract.test.mjs -----------

cmd_green() {
  local candidate="${1:-}"
  require_candidate_n "$candidate" "green"

  local out_file
  out_file=$(mktemp -t ds004q8-green-XXXXXX)

  local exit_code=0
  ( cd "$REPO_ROOT" && node --test tests/unit/ds005Q8SpikeContract.test.mjs ) > "$out_file" 2>&1 || exit_code=$?

  if [ "$exit_code" -ne 0 ]; then
    log_err "green: contract test failed (exit $exit_code), see captured output below"
    cat "$out_file" >&2
    exit "$exit_code"
  fi

  local canonical_source_hash
  canonical_source_hash=$(sha256_file "$REPO_ROOT/tests/unit/ds005Q8SpikeContract.test.mjs")
  local raw_output_hash
  raw_output_hash=$(sha256_file "$out_file")

  # The receipt identity is derived from candidate + command + canonical
  # source hash + exit code only -- deterministic and stable across repeat
  # runs of unchanged source. It deliberately excludes the captured test
  # output bytes: node --test's own output embeds a wall-clock duration, so
  # two runs of byte-identical source never produce byte-identical output.
  # Excluding it is what lets a second `green` invocation on unchanged
  # source reproduce the same green_receipt_sha (required by the exact
  # cross-arch equality assertions in main plan section 7).
  local receipt_input
  receipt_input="candidate-n|node --test tests/unit/ds005Q8SpikeContract.test.mjs|${canonical_source_hash}|${exit_code}"
  local green_receipt_sha
  green_receipt_sha=$(printf '%s' "$receipt_input" | sha256_stdin)

  local receipt_dir="$ARTIFACTS_ROOT/green/candidate-n/$green_receipt_sha"
  local receipt_parent
  receipt_parent=$(dirname "$receipt_dir")
  mkdir -p "$receipt_parent"
  if mkdir "$receipt_dir" 2>/dev/null; then
    chmod 0700 "$receipt_dir"
    cp "$out_file" "$receipt_dir/green-test.out"
    chmod 0400 "$receipt_dir/green-test.out"
    cat > "$receipt_dir/green-receipt.json" <<JSON
{
  "greenReceiptSha256": "$green_receipt_sha",
  "candidate": "candidate-n",
  "command": "node --test tests/unit/ds005Q8SpikeContract.test.mjs",
  "canonicalSourceSha256": "$canonical_source_hash",
  "exitCode": $exit_code,
  "rawOutputSha256": "$raw_output_hash"
}
JSON
    chmod 0400 "$receipt_dir/green-receipt.json"
    fsync_file "$receipt_dir/green-test.out"
    fsync_file "$receipt_dir/green-receipt.json"
    fsync_dir "$receipt_dir"
    fsync_dir "$receipt_parent"
  else
    [ -d "$receipt_dir" ] || die_setup_error "GREEN receipt path exists but is not a directory: $receipt_dir"
    # Identical source/command/output reuses only byte-identical immutable
    # GREEN evidence (main plan line 243): a repeat run with the same
    # identity does not overwrite the first captured evidence.
    if [ ! -f "$receipt_dir/green-receipt.json" ] || [ ! -f "$receipt_dir/green-test.out" ]; then
      die_setup_error "existing GREEN receipt dir is incomplete: $receipt_dir"
    fi
    validate_existing_file "$receipt_dir/green-receipt.json" "0400"
    validate_existing_file "$receipt_dir/green-test.out" "0400"
    local existing_green_output_hash stored_green_output_hash stored_green_source_hash
    existing_green_output_hash=$(sha256_file "$receipt_dir/green-test.out")
    stored_green_output_hash=$(sed -n 's/.*"rawOutputSha256": "\([^"]*\)".*/\1/p' "$receipt_dir/green-receipt.json")
    stored_green_source_hash=$(sed -n 's/.*"canonicalSourceSha256": "\([^"]*\)".*/\1/p' "$receipt_dir/green-receipt.json")
    [ "$stored_green_source_hash" = "$canonical_source_hash" ] || die_setup_error "existing GREEN receipt source hash differs"
    [ "$existing_green_output_hash" = "$stored_green_output_hash" ] || die_setup_error "existing GREEN output bytes do not match receipt"
  fi

  rm -f "$out_file"
  printf '%s\n' "$green_receipt_sha"
}

# --- pack: local-only, git-status-validated, immutable source package ------

cmd_pack() {
  local candidate="${1:-}" arch="${2:-}" green_receipt_sha="${3:-}"
  require_candidate_n "$candidate" "pack"
  require_arch "$arch" "pack"
  is_lowercase_hex "$green_receipt_sha" 64 || die_setup_error "pack: green_receipt_sha must be 64 lowercase-hex"

  local receipt_dir="$ARTIFACTS_ROOT/green/candidate-n/$green_receipt_sha"
  [ -f "$receipt_dir/green-receipt.json" ] || die_setup_error "pack: no GREEN receipt at $receipt_dir"

  local canonical_source_hash current_hash
  canonical_source_hash=$(sed -n 's/.*"canonicalSourceSha256": "\([^"]*\)".*/\1/p' "$receipt_dir/green-receipt.json")
  current_hash=$(sha256_file "$REPO_ROOT/tests/unit/ds005Q8SpikeContract.test.mjs")
  [ "$canonical_source_hash" = "$current_hash" ] || die_setup_error "pack: GREEN receipt no longer matches current source"

  # Validate exact five-path git status before build (main plan line 245).
  local before after
  before=$(cd "$REPO_ROOT" && git status --porcelain=v1 -- "${NORMATIVE_PATHS[@]}")

  local worktree_head
  worktree_head=$(cd "$REPO_ROOT" && git rev-parse HEAD)
  [ "$worktree_head" = "$FROZEN_BASE_SHA" ] || die_setup_error "pack: worktree HEAD is not the frozen base SHA"

  local build_dir
  build_dir=$(mktemp -d -t ds004q8-pack-XXXXXX)
  chmod 0700 "$build_dir"

  # git bundle create refuses a bare non-ref SHA as an "empty bundle"; HEAD
  # is asserted immediately above to equal FROZEN_BASE_SHA, so bundling HEAD
  # is exactly bundling the frozen base.
  ( cd "$REPO_ROOT" && git bundle create "$build_dir/frozen-base.bundle" HEAD >/dev/null 2>&1 ) \
    || die_setup_error "pack: unable to create frozen-base.bundle"

  local overlay_list="$build_dir/overlay-list.txt"
  : > "$overlay_list"
  local p
  for p in "${NORMATIVE_PATHS[@]}"; do
    printf '%s\n' "$p" >> "$overlay_list"
  done
  ( cd "$REPO_ROOT" && tar --files-from="$overlay_list" -cf "$build_dir/overlay.tar" ) \
    || die_setup_error "pack: unable to create overlay.tar"

  local bundle_hash overlay_hash
  bundle_hash=$(sha256_file "$build_dir/frozen-base.bundle")
  overlay_hash=$(sha256_file "$build_dir/overlay.tar")

  {
    printf '{\n'
    printf '  "frozenBaseSha": "%s",\n' "$FROZEN_BASE_SHA"
    printf '  "greenReceiptSha256": "%s",\n' "$green_receipt_sha"
    printf '  "bundleSha256": "%s",\n' "$bundle_hash"
    printf '  "archiveSha256": "%s",\n' "$overlay_hash"
    printf '  "overlay": [\n'
    local n=${#NORMATIVE_PATHS[@]} i=0
    for p in "${NORMATIVE_PATHS[@]}"; do
      i=$((i + 1))
      local fp="$REPO_ROOT/$p" fh fs fm
      fh=$(sha256_file "$fp")
      fs=$(wc -c < "$fp" | tr -d ' ')
      fm=$(stat -c '%a' "$fp" 2>/dev/null || stat -f '%Lp' "$fp" 2>/dev/null || echo "")
      printf '    {"path": "%s", "action": "add", "mode": "%s", "size": %s, "sha256": "%s"}%s\n' \
        "$p" "$fm" "$fs" "$fh" "$([ "$i" -lt "$n" ] && printf ',')"
    done
    printf '  ]\n'
    printf '}\n'
  } > "$build_dir/source-manifest.json"

  local manifest_sha
  manifest_sha=$(sha256_file "$build_dir/source-manifest.json")

  after=$(cd "$REPO_ROOT" && git status --porcelain=v1 -- "${NORMATIVE_PATHS[@]}")
  [ "$before" = "$after" ] || die_setup_error "pack: five-path git status changed during build"

  local dest_dir="$ARTIFACTS_ROOT/source/$arch/candidate-n/$manifest_sha"
  local dest_parent
  dest_parent=$(dirname "$dest_dir")
  mkdir -p "$dest_parent"
  if mkdir "$dest_dir" 2>/dev/null; then
    chmod 0700 "$dest_dir"
    cp "$build_dir/frozen-base.bundle" "$dest_dir/frozen-base.bundle"
    cp "$build_dir/overlay.tar" "$dest_dir/overlay.tar"
    cp "$build_dir/source-manifest.json" "$dest_dir/source-manifest.json"
    chmod 0400 "$dest_dir"/*.bundle "$dest_dir"/*.tar "$dest_dir"/*.json
    fsync_file "$dest_dir/frozen-base.bundle"
    fsync_file "$dest_dir/overlay.tar"
    fsync_file "$dest_dir/source-manifest.json"
    fsync_dir "$dest_dir"
    fsync_dir "$dest_parent"
  else
    [ -d "$dest_dir" ] || die_setup_error "source package path exists but is not a directory: $dest_dir"
    local existing_hash manifest_bundle_hash manifest_overlay_hash existing_bundle_hash existing_overlay_hash
    [ -f "$dest_dir/source-manifest.json" ] || die_setup_error "pack: existing package missing source-manifest.json: $dest_dir"
    [ -f "$dest_dir/frozen-base.bundle" ] || die_setup_error "pack: existing package missing frozen-base.bundle: $dest_dir"
    [ -f "$dest_dir/overlay.tar" ] || die_setup_error "pack: existing package missing overlay.tar: $dest_dir"
    validate_existing_file "$dest_dir/source-manifest.json" "0400"
    validate_existing_file "$dest_dir/frozen-base.bundle" "0400"
    validate_existing_file "$dest_dir/overlay.tar" "0400"
    existing_hash=$(sha256_file "$dest_dir/source-manifest.json")
    [ "$existing_hash" = "$manifest_sha" ] || die_setup_error "pack: existing package at $dest_dir does not match (never overwrite)"
    manifest_bundle_hash=$(sed -n 's/.*"bundleSha256": "\([^"]*\)".*/\1/p' "$dest_dir/source-manifest.json")
    manifest_overlay_hash=$(sed -n 's/.*"archiveSha256": "\([^"]*\)".*/\1/p' "$dest_dir/source-manifest.json")
    [ "$manifest_bundle_hash" = "$bundle_hash" ] || die_setup_error "pack: existing package bundleSha256 differs from current build"
    [ "$manifest_overlay_hash" = "$overlay_hash" ] || die_setup_error "pack: existing package archiveSha256 differs from current build"
    existing_bundle_hash=$(sha256_file "$dest_dir/frozen-base.bundle")
    existing_overlay_hash=$(sha256_file "$dest_dir/overlay.tar")
    [ "$existing_bundle_hash" = "$manifest_bundle_hash" ] || die_setup_error "pack: existing frozen-base.bundle bytes do not match source-manifest.json"
    [ "$existing_overlay_hash" = "$manifest_overlay_hash" ] || die_setup_error "pack: existing overlay.tar bytes do not match source-manifest.json"
  fi

  rm -rf "$build_dir"
  printf '%s\n' "$manifest_sha"
}

# --- install / verify: require native runner SSH access --------------------

cmd_install() {
  require_coordinator_inputs
  validate_destination "$DS005_AMD64_RUNNER_SSH" "DS005_AMD64_RUNNER_SSH"
  validate_trust_file "$DS005_SSH_KNOWN_HOSTS_FILE" "DS005_SSH_KNOWN_HOSTS_FILE"
  die_blocked "install: native runner install is not exercised in this environment (no native amd64/arm64 runner reachable)"
}

cmd_verify() {
  require_coordinator_inputs
  die_blocked "verify: native runner verification requires the amd64/arm64 runner and is not exercised in this environment"
}

# --- run: local emit-pass acknowledgement, transported unchanged -----------

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
    [ -f "$attempt_dir/$f" ] || die_blocked "run: required attempt artifact missing: $f"
    validate_existing_file "$attempt_dir/$f" "0400"
  done
}

cmd_run() {
  require_coordinator_inputs
  local candidate="${1:-}" arch="${2:-}" manifest_sha="${3:-}" attempt_id="${4:-}"
  require_candidate_n "$candidate" "run"
  require_arch "$arch" "run"
  is_lowercase_hex "$manifest_sha" 64 || die_setup_error "run: manifest_sha must be 64 lowercase-hex"
  is_lowercase_hex "$attempt_id" 32 || die_setup_error "run: attempt_id must be 32 lowercase-hex"

  local attempt_dir="$ARTIFACTS_ROOT/runs/$arch/candidate-n/$manifest_sha/$attempt_id"
  [ -f "$attempt_dir/evidence-final.json" ] || die_blocked "run: no locally-retrieved evidence-final.json for this attempt"
  [ -f "$attempt_dir/failure.json" ] && die_blocked "run: attempt is a controlled failure, PASS is never exposed"
  validate_existing_file "$attempt_dir/evidence-final.json" "0400"
  require_complete_attempt_artifacts "$attempt_dir"
  validate_final_evidence_json "$attempt_dir/evidence-final.json" "$manifest_sha" "$attempt_id"

  local final_evidence_sha terminal_event_sha
  final_evidence_sha=$(sha256_file "$attempt_dir/evidence-final.json")
  local jpath
  jpath=$(journal_path "$arch")
  [ -f "$jpath" ] || die_blocked "run: no attempt journal found, cannot acknowledge"
  journal_require_terminal "$arch" "$manifest_sha" "$attempt_id" "finalize" "ELIGIBLE" "$final_evidence_sha"
  terminal_event_sha=$(journal_append "$arch" "$manifest_sha" "$attempt_id" "pass-authorization" "AUTHORIZED" "$final_evidence_sha")

  # `if ! var=$(cmd)` (rather than `var=$(cmd); check $?`) is required here:
  # under `set -e`, a failing command substitution assigned outside a
  # conditional exits the script immediately, before any exit-code check
  # could run.
  local ack_out
  if ! ack_out=$(bash --noprofile --norc "$SCRIPT_DIR/run-spike.sh" emit-pass candidate-n "$arch" \
    "$manifest_sha" "$attempt_id" "$final_evidence_sha" "$terminal_event_sha"); then
    journal_append "$arch" "$manifest_sha" "$attempt_id" "pass-acknowledgement" "BLOCKED" "$final_evidence_sha" >/dev/null
    die_blocked "run: emit-pass acknowledgement failed, no PASS transported"
  fi

  # stage-source.sh run transports the already-originated bytes unchanged;
  # it never constructs PASS itself (main plan lines 174-175). Validate
  # exact-byte shape before transporting.
  local expected_pattern="^PASS candidate-n ${arch} ${manifest_sha} ${attempt_id}\$"
  if [[ "$ack_out" =~ $expected_pattern ]]; then
    printf '%s\n' "$ack_out"
  else
    journal_append "$arch" "$manifest_sha" "$attempt_id" "pass-acknowledgement" "BLOCKED" "$final_evidence_sha" >/dev/null
    die_blocked "run: acknowledgement output did not match the exact PASS byte contract"
  fi
}

# --- dispatch ----------------------------------------------------------------

main() {
  local verb="${1:-}"
  shift || true
  case "$verb" in
    green) cmd_green "$@" ;;
    pack) cmd_pack "$@" ;;
    install) cmd_install "$@" ;;
    verify) cmd_verify "$@" ;;
    run) cmd_run "$@" ;;
    *) die_setup_error "unknown verb: ${verb:-<none>} (expected green|pack|install|verify|run)" ;;
  esac
}

main "$@"
