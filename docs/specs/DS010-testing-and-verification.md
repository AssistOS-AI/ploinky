---
id: DS010
title: Testing and Verification
status: implemented
owner: ploinky-team
summary: Defines the active regression harness, unit-test layout, failing-fast replay flow, and required documentation verification steps.
---

# DS010 Testing and Verification

## Introduction

The repository’s test surface is stage-oriented and closely tied to the runtime model. This document defines the current harness layout and the verification requirements that accompany code and documentation changes.

## Core Content

Runtime-state coverage must verify that the shared status collector reports Bubblewrap and Seatbelt from their tracked PIDs, merges Docker and Podman inspection results, retains stopped enabled runtimes, and supplies Marketplace with the same backend and liveness values shown by the CLI.

The main end-to-end harness is `tests/test_all.sh`. It must orchestrate the prepare, start, stop, start-again, restart, destroy, and unit-test flow, while preserving the ability to summarize failures instead of aborting on the first non-fatal verification error. `tests/run-all.sh` is a dispatch wrapper around that main script.

Test stages are intentionally split. Action scripts such as `tests/doPrepare.sh`, `tests/doStart.sh`, and `tests/doRestart.sh` create the runtime state transitions. Verification scripts such as `tests/testsAfterStart.sh` inspect the resulting state. Shared shell assertions live in `tests/test-functions/`, and Node unit tests live in `tests/unit/` and are run through `node --test`.

`tests/runFailingFast.sh` must remain a targeted rerun path that creates one fresh workspace and replays only the checks that failed during the previous full suite. This script is part of the documented iteration workflow for runtime changes because the full suite is materially slower.

The harness may create a temporary git worktree for another branch when `PLOINKY_BRANCH` is set. This branch-testing behavior is part of the current implementation and must not be documented away as an incidental test detail.

Browser-surface changes require a targeted smoke test in addition to shell and unit checks. For WebChat composer/autocomplete changes, the smoke must run against an authenticated `/webchat` session for a selected chat agent and verify workspace file/folder suggestions without exposing agent tag suggestions. Slash-catalog unit coverage must verify transient startup retries, configured backoff order, bounded exhaustion, immediate acceptance of a valid empty catalog, immediate termination on access denial, and deduplication of concurrent initial refresh calls. A research-relay integration smoke may use generic launch parameters such as `forward-envelope=1` and `workspace-dir`, but the WebChat implementation itself must remain generic: optional relay agent ids, backend tags, and downstream tool names belong to the selected chat agent, not to Ploinky core. The browser smoke must prove that selecting a cwd-relative `@path` records a structured `workspace-path` reference, selected path tokens are visually emphasized from their reference metadata, arbitrary `@word` tokens are ordinary chat text, and provider routing is not triggered by Ploinky WebChat.

WebChat header changes require focused coverage of responsive overflow-menu
placement and lifecycle. Tests must verify that Tasks, Skills, Sessions, and Logout keep
their established positions in the desktop header, move as the same DOM elements
into the three-dot menu at the 640-pixel mobile breakpoint, and return in their
original order above it. Tests must also verify that the menu toggles its ARIA
expanded state, closes after mobile actions, outside pointer interaction, and
Escape, and that the mobile header keeps the agent name, current model, and
ellipsized working directory visible.

Workspace-skill controls require focused protocol and browser-model coverage. Tests must verify strict `__webchatSkills` validation and interception, volatile snapshot replay through `skills-state`, rejection of absolute or escaping paths and unsupported types, total/enabled counts, tree construction that stops at skill directories and compacts directory-only chains, tri-state folder drafts, individual canonical-name commands, plural relative-directory commands, folder-before-exception ordering, no commands before Save, final authoritative refresh, and slash-catalog reload after a completed Save. Header coverage must keep the Skills control between Tasks and Sessions on desktop and move the same bound element through the mobile overflow menu.

Assistant workspace-file preview coverage must verify candidate extraction,
rejection of traversal and host-absolute paths, cwd-prefix construction,
preservation of already workspace-relative URLs, MIME and inline response
headers, Markdown rendering, escaped text rendering, and sandboxing of HTML
previews. Tests must also prove that the raw assistant message is not rewritten
and that unsupported automatically detected file types do not initiate
downloads.

Folder-session changes require focused store and surface tests. Tests must verify first-open creation, refresh reuse, invalid-pointer repair, malformed-file exclusion, symlink rejection, selector metadata without message bodies or counts, relative-time formatting, stable `sessionStorage` tab identity, multi-subscriber SSE delivery, lazy history rendering, and reservation of `tabId`/`sessionId` from agent CLI arguments. Continuation coverage must also verify that an envelope-aware recreated runtime receives ordered user/assistant history exactly once with the current message kept separate, browser-supplied history is ignored, UI-only records are excluded, slash commands defer restoration, and plain-text agents retain the legacy fallback. An integration smoke should additionally verify the `Sessions` selector, its first-item `New` action, the `Click to load session history` action, and reuse of a surviving runtime after refresh.

Interactive-control changes require focused runtime, route, and browser tests. Coverage must verify that structured requests and resolutions are intercepted before history, pending state is replayed on reconnect, the endpoint requires the matching active subscriber/session/request/option, replay is rejected, the declared default is selected, Arrow Up/Down wraps, Enter submits, and ordinary composer submission remains disabled while the selector is active.

Agent lifecycle changes require backend-aware unit coverage. Enable tests must prove that container runtimes use container liveness while Bubblewrap and Seatbelt use their tracked process PID without consulting the container daemon. Disable tests must prove that a captured registry record still selects sandbox teardown after the live registry entry has been removed.

When the local workspace includes an application plugin that embeds Ploinky WebChat behavior, a cross-surface smoke should verify parity with the canonical WebChat flow: open the application surface, verify file/folder suggestions, submit text such as `@open-interpreter` through the UI send path, and confirm the application persists the chat content through its own storage. This cross-repository smoke belongs to the integration runbook in the application repository; Ploinky's responsibility is to keep WebChat generic and to preserve the authenticated routing, envelope, reference, and suggestion-endpoint behavior that the application smoke depends on.

Documentation changes require verification alongside code changes. After updating the DS set or HTML pages, the repository must:

- regenerate `docs/specs/matrix.md`;
- copy `docs/specsLoader.html` from the GAMP asset;
- verify HTML links and specs-loader references;
- run the static-site verifier against the generated `docs/` directory.

## Decisions & Questions

### Question #1: Why does the test harness keep separate action and verification scripts?

Response:
The runtime performs long-lived state transitions such as prepare, start, restart, and destroy. Splitting actions from validations keeps the orchestration readable, allows shared helpers to be reused across stages, and matches the current structure implemented in `tests/test_all.sh`.

### Question #2: Why is documentation verification part of the repository testing contract?

Response:
The repository explicitly treats HTML docs, DS specs, and `docs/ploinky-overview.md` as synchronized deliverables. If docs are normative inputs or operator-facing guidance, broken links or stale matrices are regressions in their own right and must be caught before the change is considered complete.

### Question #3: Why does a WebChat smoke test avoid research-relay agent tags?

Response:
Ploinky WebChat is a transport surface. It should prove workspace-path references, envelopes, highlighting, and routing work end to end, while semantic interpretation of provider-looking text such as `@open-interpreter` remains owned by the selected chat agent.

## Conclusion

The testing contract covers both runtime behavior and documentation integrity. Ploinky must preserve the stage-based harness, the failing-fast replay workflow, and the post-generation documentation verification steps as part of ordinary repository maintenance.
