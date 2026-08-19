# DS005-Q8 architecture-decision spike (S0)

This directory is the complete, bounded implementation of S0: a native-evidence
spike for **Candidate N** (pasta `-T` / `--tcp-ns` TCP port-8081 confinement),
the sole architecture candidate authorized to resolve DR1. It exists to
resolve one question and nothing else. It does not implement, plan, or
authorize any product runtime, CLI, Router, agent, image, workflow, or
deployment behavior.

Normative source (authority order, descending):

1. `docs/superpowers/plans/2026-07-19-ploinky-box-clean-rebuild.md`, sections
   1-7 and 9, in the outer multi-repo workspace root.
2. `docs/superpowers/plans/2026-07-19-ploinky-box-clean-rebuild-annex-inventory.md`,
   sections 1-4, same location.

Section 8 of the main plan and annex sections 5-6 are non-normative deferred
ledgers and are out of scope for this directory.

## Scope boundary

Only S0 is implementation-ready. This directory owns exactly five paths:

```text
container/spike/ds005-q8/run-spike.sh
container/spike/ds005-q8/probe.py
container/spike/ds005-q8/stage-source.sh
container/spike/ds005-q8/README.md
tests/unit/ds005Q8SpikeContract.test.mjs
```

S0 edits no DS005, matrix, `specsLoader`, or HTML. It does not commit, push,
merge, publish, deploy, or mutate a registry.

## Decision rule

Candidate N becomes eligible for a fresh consequential security review and
explicit human acceptance only if every invariant and gate passes
independently on native amd64 and native arm64.

**Evidence never chooses the architecture.**

A genuine Candidate N invariant failure ends S0 with DR1 unresolved; that
failure, a human rejection, or an inconclusive review authorizes only a
separately reviewed bounded architecture-decision spike or project closure --
never downstream or full-rebuild planning.

`candidate-N-evidenced` never means DR1 is resolved. Only a fresh
consequential security review followed by explicit human acceptance can
resolve it.

## Required coordinator inputs

Nine environment variables gate every native (non-local) operation. If any
is missing, local source implementation and local contract verification
(`green`) may still proceed, but `install`, `verify`, and `run` stop before
touching a native runner and report the native execution gate as `BLOCKED`.

```text
DS005_EXTERNAL_SCANNER_SSH
DS005_AMD64_RUNNER_SSH
DS005_ARM64_RUNNER_SSH
DS005_AMD64_BOX_LAN_IPV4
DS005_ARM64_BOX_LAN_IPV4
DS005_SSH_KNOWN_HOSTS_FILE
DS005_EXTERNAL_SCANNER_IDENTITY_FILE
DS005_AMD64_RUNNER_IDENTITY_FILE
DS005_ARM64_RUNNER_IDENTITY_FILE
```

Destinations are `user@host`, ASCII-only, matching the canonical grammar in
the main plan (section 6.1, line 199); host length at most 253 bytes, labels
at most 63. Known-hosts and identity files must resolve to absolute, regular,
non-symlink, coordinator-owned mode-0600 files with exact pinned unhashed
entries -- no TOFU, no wildcard patterns.

## SSH / SFTP trust and remote executor

SSH: `ssh -F /dev/null -o BatchMode=yes -o ClearAllForwardings=yes -o
IdentitiesOnly=yes -o IdentityAgent=none -o StrictHostKeyChecking=yes -o
GlobalKnownHostsFile=/dev/null -o UserKnownHostsFile="$known_hosts" -i
"$identity" -T -- "$destination" "$remote_executor"`.

SFTP uses the identical option set with `-b "$batch_file"` in place of `-T`.

The remote executor is serialized only from this exact template:
`/usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin BASH_ENV=/dev/null
/bin/bash --noprofile --norc -s -- <phase> candidate-n <arch> <manifest_sha>
<attempt_id> <target_ipv4> <tcp_ports> <udp_ports>` (scanner variant replaces
`candidate-n <arch>` with `scanner-scan scanner`). No PTY, profile, ambient
config, caller text, `eval`, `source`, or `sh -c`. Static owned script bytes
alone enter stdin; dynamic values are positional args only.

## GREEN, pack, install, verify, run

TDD order: direct RED, implement, local GREEN, then pack/install/verify/run.

- `stage-source.sh green candidate-n` runs exactly `node --test
  tests/unit/ds005Q8SpikeContract.test.mjs`, prints one 64-lowercase-hex
  `green_receipt_sha`, and never prints PASS.
- `stage-source.sh pack candidate-n <arch> <green_receipt_sha>` verifies the
  receipt against current source, builds in a private mode-0700 temp
  directory, validates the exact five-path git status before and after, and
  publishes an immutable source package. Local-only; no SSH required.
- `stage-source.sh install candidate-n <arch> <manifest_sha>` and `verify` are
  native-runner gates. In this five-file spike they fail closed before
  collecting native evidence; they also stop with `BLOCKED` and empty stdout if
  the nine coordinator inputs are unavailable.
- `stage-source.sh run candidate-n <arch> <manifest_sha> <attempt_id>`
  transports the already-originated PASS acknowledgement bytes unchanged only
  after the complete local evidence set and terminal journal chain validate; it
  never constructs PASS itself.

## PASS ordering

No PASS byte may reach coordinator stdout before final artifact
retrieval/validation, the self-hashed journal append, journal
fdatasync/fsync, and parent fsync. Only `run-spike.sh emit-pass` may
originate the exact bytes `PASS candidate-n <arch> <manifest_sha>
<attempt_id>\n`, after revalidating local evidence, IDs, and hashes.
`stage-source.sh run` only transports those bytes unchanged after complete
local evidence validation, terminal journal validation, and exact-byte
validation.

Coordinator phases are monotonic: preflight, prepare, live, finalize,
retrieval + journal append, emit-pass acknowledgement, run transport.
Finalize writes only the non-success verdict `ELIGIBLE` to evidence -- never
PASS.

## Probe matrix

Managed path IDs: `managed-default`, `managed-a`, `managed-b`,
`managed-dual-source-a`, `managed-dual-source-b`. Negative path IDs:
`unmanaged-separate`, `manual-default`, `manual-a`, `manual-b`, every
engine-permitted `address-reuse-<network>`, and every engine-permitted
`overlap-<network>`.

Every runnable path probes both alias (`http://host.containers.internal:<port>`)
and literal (`http://<validated_transport_ipv4>:<port>`) destination forms at
port `8081` and every fixed/discovered/decoy TCP port, with the fixed payload
hex `44533030352d51382d524f555445522d4f4b0a` and `--source-ipv4
<validated_source_ipv4>`. Only managed/`8081` must `CONNECTED` with exact
payload; every other runnable cell must be actual `REFUSED`.

Fixed TCP scanner ports: `22,6379,7880,7980,7981,8080,8081` plus every
discovered/decoy TCP port. Fixed UDP: `7882` plus every discovered UDP port.
Outer owner inventory runs `sudo -n ss -H -lntp` and `sudo -n ss -H -lunp`
before activation, live, and after cleanup, with `/proc/<pid>` UID/cgroup/netns
validation for every socket.

## Failure taxonomy and status

Every stop is classified `BLOCKED`, `SETUP_ERROR`, or a Candidate N invariant
failure. Setup failure (missing tools, Podman mistakes, SSH/scanner failures,
harness bugs) is never converted into architecture evidence.

Allowed status transitions:

```text
architecture-spike-ready
architecture-spike-running
architecture-spike-blocked
candidate-N-evidenced
architecture-review-pending
architecture-human-accepted
architecture-human-rejected
```

A success attempt has the complete phase-ordered file set and no
`failure.json`. A controlled failure has only its completed strict phase
prefix plus immutable `failure.json`. An abrupt interruption leaves only a
strict prefix and is visibly `BLOCKED`, never resumable or passable. Nothing
is ever rewritten or deleted: evidence, journals, packages, and attempts are
immutable once written.

## Recovery and cleanup

Recovery is limited to human-reviewed actions against recorded run-label
objects and recorded child PIDs after ownership is revalidated. There is no
prune, reset, broad kill, automatic worktree repair, rollback, migration, or
adoption path. Cleanup targets only exact run-label objects and recorded PIDs
after ID/UID/label/ownership revalidation.

## Known limitation of this environment

This spike was implemented and locally verified on a non-Linux development
host without rootless Podman, pasta, or reachable native amd64/arm64
runners. `green` and `pack` are fully exercised locally. `install`, `verify`,
`run`, and the native `prepare` / `live` / `finalize` / `scanner-scan` evidence
phases are exercised only for their `BLOCKED` fail-closed paths; incomplete
native phase scaffolds do not write success evidence or authorize PASS. The
actual native pasta/Podman evidence this spike exists to produce has not been
collected, and DR1 remains unresolved.
