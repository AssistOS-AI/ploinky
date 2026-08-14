---
title: DS002-workspace-and-repository-model
summary: Defines canonical workspace identity, workspace-owned state, repository acquisition, branch selection, and durable data boundaries.
---

# DS002 Workspace and Repository Model

## Introduction

Every Ploinky operation must resolve one canonical workspace before it reads or mutates runtime state. Repository installation and agent discovery extend that workspace without allowing one workspace to adopt or report another workspace's resources.

## Core Content

The public Box identity must be derived from the canonical absolute launch directory and must include a readable slug plus a path-derived hash. The host supervisor must capture filesystem identity, serialize mutations with the workspace lock, and revalidate immutable identity before mutation. Missing, foreign, ambiguous, split-engine, or changed ownership evidence must fail closed.

Workspace control state belongs under `.ploinky/`. This includes enabled-agent and configuration records, installed repositories, repository source metadata, routing candidates and active-generation records, dependency caches, logs, run-state files, encrypted secrets, keys, provider metadata, and service data. Agent-owned persistent homes belong under `.data/<agent-or-alias>/`. The outer Box caches belong specifically under `.ploinky/box/dependencies` and `.ploinky/box/images`; ordinary Box destruction must preserve them, and `destroy --delete-cache` may delete only those two validated paths after the Box has been removed.

Repository installation must place managed checkouts under `.ploinky/repos/<name>` and must persist sufficient source, branch, and repository-kind metadata to update or repair the checkout without guessing. Repository names and derived paths must remain confined to the managed repository root. Manifest-declared repository dependencies must be acquired before the complete agent graph is admitted.

Branch-aware startup must resolve an explicit per-repository branch before a start-wide branch, then manifest or persisted choices according to the implemented precedence. A missing candidate branch must follow the selected fallback policy. Dirty managed checkouts must refuse destructive branch changes unless the operator explicitly authorizes repository reset. Core logic must not hardcode optional repository or agent identities.

Update operations must refresh the Ploinky AchillesAgentLib checkout actually loaded at runtime, managed repositories, eligible copied default skills, and discovered project repositories according to their separate failure policies. Managed dependency failures are command failures; an unreachable remote for an independently discovered project repository may be reported and skipped without changing that repository.

Manifest volumes are explicit operator grants. Relative host paths resolve from the canonical workspace, absolute host paths remain exact operator-selected paths, and runtime-managed persistent service storage should use `.ploinky/data/`. No cleanup path may expand from these declared locations into a broad workspace, home-directory, engine, container, image, volume, or network prune.

## Conclusion

The workspace model must make every repository, runtime record, cache, secret, and cleanup target attributable to one exact workspace before it can affect execution.
