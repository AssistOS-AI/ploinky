---
title: DS012-testing-and-verification
summary: Defines Ploinky's layered verification strategy, stage harness, boundary tests, security regression expectations, and documentation checks.
---

# DS012 Testing and Verification

## Introduction

Ploinky coordinates filesystems, processes, container engines, browser sessions, authentication, and network routing. Verification must therefore cover pure contracts, subsystem integration, and observable end-to-end boundaries.

## Core Content

`tests/test_all.sh` is the stage-oriented regression harness, and `tests/run-all.sh` is its dispatcher. Stage mutation belongs in `tests/do*.sh`; stage validation belongs in `tests/testsAfter*.sh`; reusable shell assertions belong in `tests/test-functions/`; focused Node coverage belongs in `tests/unit/`; multi-subsystem coverage belongs in `tests/integration/`; and public Box process coverage belongs in `tests/e2e/`. `tests/runFailingFast.sh` may replay recorded failures in a fresh fixture but must not replace a required full run.

Tests must prefer isolated temporary workspaces and exact resource labels. Cleanup must target only resources created by the test and must preserve evidence needed to diagnose failure. Tests must not depend on a developer's existing workspace, global container inventory, credentials, browser profile, or unrelated repositories.

Changes to Box identity, image validation, publications, mounts, storage, locking, lifecycle, or engine discovery require public-supervisor and contract coverage. Changes to manifests, graph ordering, provider execution, caches, readiness, or watchdog behavior require unit coverage plus a graph-level integration path. Changes to Router admission, identity, tokens, policy, HTTP/SSE/WebSocket proxying, browser mutation, uploads, or administrative surfaces require negative tests that prove stale, malformed, replayed, unauthorized, oversized, and cross-generation inputs fail closed.

WebChat behavior must be tested at the protocol and browser-model boundaries for session scoping, reconnect replay, tasks, interactions, skills, workspace paths, uploads, and mutation proofs. Core tests must preserve WebChat's generic behavior and must not encode optional downstream agent identities or tools.

Documentation changes must regenerate `docs/specs/matrix.md` from DS frontmatter and validate contiguous numbering, exact titles, the required DS sections, DS links, specification-loader targets, and the absence of unsupported metadata. Site-wide verification may additionally validate HTML navigation and assets, but a DS-only change must report pre-existing HTML failures without rewriting HTML outside the requested scope.

The cross-repository `ploinky-proxy` deployment and Playwright gate is separate from ordinary verification and must run only when the user explicitly requests it. When requested, the exact branch, repository, image, workspace, deployment, and evidence requirements in `CLAUDE.md` are mandatory.

Verification must prove the narrow unit contract and the real boundary at which Ploinky exposes lifecycle, routing, security, or browser behavior to a user or consuming system.
