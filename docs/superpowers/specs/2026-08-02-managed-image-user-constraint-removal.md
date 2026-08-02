# Managed Image User Constraint Removal — Implementation and Verification Findings

**Date:** 2026-08-02

**Branch:** `ploinky-proxy`

**Base:** `3c347136bf033dbfa5b46d81b3e2ddf3ae3fa56f`

**Verification verdict:** **PARTIAL** — the changed behavior passes focused, full-unit, integration, and live Podman probes; the repository lifecycle harness has the same pre-existing Router-socket ordering failure on the untouched base revision.

## Outcome

Ploinky no longer rejects a managed agent image because its OCI `Config.User`
is empty, symbolic, root, UID-only, or otherwise not an exact numeric non-root
`UID:GID`. Router authority attestation remains mandatory.

The authority probe now runs a separately resolved Node image pinned by digest,
with a fixed `65534:65534` identity, an explicit `node` entrypoint, a read-only
root filesystem, no added capabilities, all capabilities dropped, and
`NoNewPrivs`. It never executes the target image or its entrypoint.

## Findings

| ID | Finding | Resolution |
| --- | --- | --- |
| F1 | The user restriction was not intrinsic to Router authority. It was introduced because the target image itself was reused as the probe helper. | Decoupled helper identity and executable availability from the target image. |
| F2 | Reusing the target image also imposed an undocumented Node.js requirement. The WebMeet STT image is Python-based, while OnlyOffice and Umami use non-probe entrypoints. | The helper uses a pinned Node image and an explicit `node` entrypoint. Target entrypoints never run during attestation. |
| F3 | Without Router attestation, Ploinky could mint credentials before proving the selected generation's network and Host-header behavior. | Retained the nonce-bound, generation-bound two-authority observation. |
| F4 | The first revision returned target evidence from the probe but dropped it from the final attestation envelope. | Added it to the digested envelope and added a behavioral regression assertion. |
| F5 | Exact non-root `UID:GID` images benefit from Podman `keep-id`; other identities cannot be mapped exactly from `Config.User` alone. | Emit exact `keep-id` only when safely derivable; otherwise preserve the image default and omit the override. |
| F6 | PREPARE enables a managed agent before the Router private Unix socket exists, so `npm test` cannot complete lifecycle stages. | Reproduced the same socket failure on the untouched base, proving it is pre-existing. |
| F7 | A target image may declare OCI `VOLUME` paths. Nested Podman then creates anonymous mounts that are outside the exact reviewed manifest contract and correctly fail final managed-mount inspection. | Managed nested Podman launches use `--image-volume=ignore`; explicit Ploinky and manifest binds remain the only mounted paths, and the exact inspection remains fail closed. |

Podman's current `keep-id` behavior is documented in the
[official `podman run` reference](https://docs.podman.io/en/latest/markdown/podman-run.1.html#userns-mode).

## Preserved invariants

| Invariant | Evidence |
| --- | --- |
| No credential minting before Router topology proof | The existing attestation and generation checkpoints remain ordered before signing and credential construction. |
| Immutable image binding | The target reference and helper digest each resolve to immutable local image IDs before the probe starts. |
| Target image is not authority code | Probe creation uses the helper image ID and an explicit `node` entrypoint; target evidence is inspection-only. |
| Helper is non-root and confined | Fixed `65534:65534`, read-only root filesystem, zero effective/bounding capabilities, active `NoNewPrivs`, bounded PID/memory/CPU, no mounts, no published ports, and no Ploinky credentials. |
| Exact network plan | Helper inspection verifies the prepared network set, primary mode, alias-derived attachments, and exact `host.containers.internal` mapping. |
| Exact target launch | Creation, adoption, and final inspection compare the immutable target image ID, target `Config.User`, and optional exact Podman user-namespace annotation. |
| Exact helper cleanup | Stop and removal are authorized by immutable container ID plus the random helper label; absence is proven after removal. |

## Verification record

| Check | Result |
| --- | --- |
| Focused authority/descriptor tests | 19 passed, 0 failed |
| Full unit suite | 2,049 tests; 2,046 passed, 0 failed, 3 skipped |
| Default integration suite | 9 tests; 3 passed, 0 failed, 6 candidate-gated skips |
| Candidate-gated integration invocation | Correctly refused to run because `PLOINKY_BOX_CANDIDATE_DIGEST` was not supplied |
| Live Podman probe with `python:3.12-slim` (`Config.User=""`) | Passed twice-observed authority path and exact cleanup |
| Live Podman probe with Umami (`Config.User="root"`) | Passed twice-observed authority path and exact cleanup |
| Repeated helper cleanup check | Zero authority-helper containers remained |
| Numeric-user Podman check | Exact `1000:1000` produced `keep-id:uid=1000,gid=1000` |
| Empty-user Podman check | Image default was preserved and no userns annotation was added |
| OCI `VOLUME` Podman check | A never-started diagnostic launch reproduced anonymous mounts; the same exact launch with `--image-volume=ignore` produced zero mounts and no new volumes. The diagnostic volumes were removed by exact ID. |
| Diff hygiene | `git diff --check` passed; no stale strict-user wording remained |
| Full `npm test` lifecycle | PREPARE/START/STOP/RESTART failed because the Router private socket was absent; identical PREPARE failure reproduced from untouched base |

The repository's `fileSizesCheck.sh` was not executable on this macOS host
because it requires Bash 4 associative arrays while the system shell is Bash
3.2. Manual line-count and long-line inspection found no new threshold class;
the edited large files were already above the reporting thresholds.
