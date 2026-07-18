# Packet 1 Report: Outer Publication Boundary

## What Changed

Added Packet 1 characterization coverage in `container/runtime-supervisor-tests.mjs`:

- `start` with `--port 19192` must create exactly `127.0.0.1:19192:8080/tcp` and `0.0.0.0:7882:7882/udp`.
- The selected host port is not passed as the in-box Router port; the core start command receives `8080`.
- The status surface reports the loopback Router mapping and fixed UDP mapping, while excluding Router private port `8081` and product service ports `3000`, `3001`, and `7000`.

The existing production implementation already satisfied these requirements, so no production files were changed.

## Tests

Required command, run for the red phase after adding tests:

```text
node --test container/runtime-supervisor-tests.mjs
```

Result: pass, 146 tests passed, 0 failed. The new tests passed immediately, so this packet is characterization evidence rather than a production behavior change.

Required green command, rerun after the review:

```text
node --test container/runtime-supervisor-tests.mjs
```

Result: pass, 146 tests passed, 0 failed, 0 skipped.

Additional check: `git diff --check` passed with no whitespace errors.

## Files Changed

- `container/runtime-supervisor-tests.mjs`
- `.superpowers/sdd/task-1-report.md`

## Self-Review Findings

The test asserts the exact ordered two-entry `-p` mapping list, verifies the selected host port maps only to container port `8080`, checks that the inner start command receives `8080` rather than `19192`, and rejects private/product ports from the status output. No runtime contract, supervisor, manifest, bootstrap, Router, or publication escape-hatch production code was modified.

The work remains within Packet 1. No Packet 2 or later requirements were implemented.

## Concerns

None for Packet 1. The real-engine smoke and broader harness are intentionally deferred to Packet 5 and were not run as part of this packet's exact verification command.
