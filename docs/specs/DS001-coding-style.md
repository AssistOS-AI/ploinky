---
title: DS001-coding-style
summary: Defines the canonical source layout, coding conventions, file-size policy, and modular test organization for Ploinky.
---

# DS001 Coding Style

## Introduction

This specification is the coding-style authority for Ploinky. Changes must preserve the repository's subsystem boundaries and must keep implementation, tests, DS specifications, and affected explanatory documentation synchronized.

## Core Content

JavaScript and Node.js modules must use ES module syntax and four-space indentation. New code must follow the surrounding module's established trailing-comma and naming conventions, keep exact public identifiers stable, and place non-obvious rationale in comments without restating mechanically evident code. Shell entry points and test helpers should use `set -euo pipefail` unless their control-flow contract requires a documented exception. Hand-maintained JSON must use two-space indentation.

Code must remain close to the subsystem it extends. Public Box supervision belongs under `ploinky-box/`; CLI command handlers belong under `cli/commands/`; routing, policy, authentication, proxy, and WebChat code belongs under `cli/server/`; shared workspace and runtime utilities belong under `cli/utils/`; runtime backends belong under `cli/sandbox/`; shared agent-side protocol code belongs under `Agent/`; and container-image support belongs under `container/`.

Modules must remain cohesive and reviewable. `fileSizesCheck.sh` is the repository's canonical file-size and code-line-length check and must be run when a change materially expands source or documentation. DS and HTML prose must remain unwrapped in source so its renderer can use the full width of the containing box; executable source should retain readable line lengths and be split by responsibility when growth indicates more than one concern.

Tests must be organized by scope. Node unit tests belong under `tests/unit/`, integration tests under `tests/integration/`, end-to-end Box tests under `tests/e2e/`, reusable shell assertions under `tests/test-functions/`, stage mutations in `tests/do*.sh`, and stage validation in `tests/testsAfter*.sh`. `tests/run-all.sh` dispatches the main `tests/test_all.sh` harness, while `tests/runFailingFast.sh` provides targeted replay of recorded failures. New behavior must receive the narrowest useful unit coverage plus integration or end-to-end coverage when it crosses a process, network, engine, or browser boundary.

Changes must preserve unrelated user work in the tree. Runtime and security code must remain generic, fail closed at uncertain ownership or authorization boundaries, avoid logging secrets, and use exact resource identities instead of broad discovery or cleanup operations.

## Conclusion

Ploinky code must remain modular, evidence-backed, security-conscious, and testable at the boundary where each behavior becomes observable.
