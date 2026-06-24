---
id: DS000
title: Vision
status: implemented
owner: ploinky-team
summary: Defines Ploinky as a workspace-local runtime for repository-backed agents, supervised routing, web surfaces, and synchronized documentation.
---

# DS000 Vision

## Introduction

Ploinky must operate as a workspace-local runtime for agents that are discovered from repository checkouts, started through a reproducible runtime layer, and exposed through a supervised local router. The repository does not document an abstract platform concept detached from the code; it documents the implementation that exists on the current branch.

The repository also carries local maintenance skills under `.agents/skills/`, but those skills are not the primary product surface. The host project is the runtime itself: the CLI, the workspace model, the runtime backends, the router, the browser surfaces, the authentication layer, the agent registry, the dependency cache system, and the test harness.

## Core Content

Ploinky must let an operator install and uninstall repositories, discover agents from `manifest.json` in installed repositories, register enabled agents in `.ploinky/agents.json`, and start a workspace whose routing state is written to `.ploinky/routing.json`. The first-class user entry points are the `ploinky` and `p-cli` launchers, the `ploinky-shell` assistant shell, and the router-managed browser surfaces served on the configured static-agent port.

The runtime must treat `.ploinky/` as the persistent boundary for workspace state. Agent working directories, cloned repositories, dependency caches, logs, keys, transcripts, and workspace configuration all live under that root. This repository must not describe alternate storage layouts as if they were equivalent unless they are implemented in code.

Documentation must remain synchronized with the current branch. The HTML pages under `docs/` explain the system to human readers. The DS files under `docs/specs/` define the stable contract. When wording differs, the DS specifications are authoritative. The repository must keep the DS numbering contiguous and must preserve `DS001-coding-style.md` as the coding-style authority.

All persistent documentation output for this repository must be in English. This includes `AGENTS.md`, `CLAUDE.md`, HTML documentation, DS specifications, and code comments added to support current work.

## Decisions & Questions

### Question #1: Why does the documentation set treat the current branch implementation as the authority?

Response:
The repository already contains stale prose that no longer matches the implementation, including obsolete test paths and browser-surface descriptions. The defensible contract is therefore the code on the current branch plus the synchronized DS set generated from it, not any legacy documentation artifact that survived refactors.

### Question #2: Why are repository-local skills summarized but not expanded into host-project runtime pages?

Response:
The skills influence repository maintenance workflows, but the runtime contract exposed to operators is Ploinky itself. Expanding imported or maintenance skills into standalone host-product pages would blur the project boundary and would violate the requirement that downstream host projects keep `/docs` focused on the host system rather than on copied skill catalogs.

## Conclusion

Ploinky is specified here as a concrete workspace runtime with synchronized documentation. The repository must continue to document the runtime that exists, keep the DS set authoritative, and preserve a clear boundary between host-project behavior and auxiliary repository-local skill tooling.
