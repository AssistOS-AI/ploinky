---
id: DS001
title: Coding Style
status: implemented
owner: ploinky-team
summary: Defines the authoritative coding, layout, documentation, and test-organization rules for this repository.
---

# DS001 Coding Style

## Introduction

This document is the coding-style authority for the repository. Future agents and contributors must treat it as the canonical source for formatting, source layout expectations, documentation synchronization rules, file-size guidance, and test-organization rules.

## Core Content

JavaScript and Node modules must use ES module syntax with `import` and `export`. Indentation must remain four spaces in repository JavaScript files. Multi-line literals and object expressions should keep trailing commas when the surrounding file already uses them, because that is the dominant style in the implemented services and handlers.

Shell scripts must remain explicit and defensive. New shell entry points and test helpers should use `set -euo pipefail` unless a file has a documented reason to relax one of those modes. Existing shell scripts in `bin/` and `tests/` show that repository operations favor deterministic failure handling and explicit state passing.

JSON files that are edited directly in the repository should use two-space indentation. This applies to repository-managed documentation metadata, manifests, workspace examples, and other hand-maintained JSON content.

Source files should stay close to the subsystem they extend. Router and browser-surface logic belongs under `cli/server/`. CLI command handlers belong under `cli/commands/`. Cross-subsystem utilities belong under `cli/utils/`, with cohesive dependency, runtime, and security helpers grouped in subdirectories. Runtime backend implementations belong under `cli/sandbox/`, whose immediate children are `bwrap/`, `docker/`, and `seatbelt/`. Shared agent payload belongs under `Agent/`. Test shell fragments belong under `tests/`, using the existing stage, helper, and unit-test split.

Documentation is part of the style contract. When behavior changes, the change set must update the affected HTML pages under `docs/`, the relevant DS files under `docs/specs/`, and `docs/ploinky-overview.md` when CLI or LLM helper behavior changed. `docs/specs/matrix.md` must be regenerated instead of edited manually.

The repository must use `fileSizesCheck.sh` as the canonical file-size and long-line checker. New large documentation or generated-content changes should be validated with that script when the change materially expands HTML, Markdown, shell, or JavaScript content. Long prose should still aim for readable terminal widths even though the checker only warns on much longer lines.

The active test layout is:

- `tests/test_all.sh` for the full stage-oriented regression harness.
- `tests/run-all.sh` as the thin dispatcher to the main harness.
- `tests/runFailingFast.sh` for replaying only the previously failing checks.
- `tests/do*.sh` for stage actions.
- `tests/testsAfter*.sh` for stage validations.
- `tests/test-functions/` for reusable shell verification helpers.
- `tests/unit/` for Node unit tests run through `node --test`.

All new documentation, specifications, and code comments must be written in English. Comments should explain non-obvious reasoning, not restate mechanically obvious statements.

## Decisions & Questions

### Question #1: Why does this file, rather than `AGENTS.md`, define the coding style?

Response:
`AGENTS.md` is the repository entry point, but it is intentionally short and procedural. The DS set is the authoritative contract, so coding style, documentation synchronization, file-size policy, and test layout live here where the repository can reference them normatively from both `AGENTS.md` and the HTML docs.

### Question #2: Why is the current `tests/` structure specified explicitly instead of preserving older smoke-suite conventions?

Response:
The current branch does not implement the older `tests/smoke/` and `tests/cli/` split described in stale guidance. The implemented harness is stage-based and lives under `tests/` with `do*.sh`, `testsAfter*.sh`, `test-functions/`, and `unit/`. The style authority must document the structure that actually exists.

## Conclusion

This file defines the authoritative rules for how the repository is written and maintained. Any contributor changing code, tests, or documentation must follow these conventions and keep the synchronized documentation set up to date.
