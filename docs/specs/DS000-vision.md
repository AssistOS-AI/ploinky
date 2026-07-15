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

The repository does not own a local skill catalog. Skills supplied by an external agent environment or copied into an operator workspace are tooling rather than Ploinky runtime modules. The host project is the runtime itself: the CLI, the workspace model, the runtime backends, the router, the browser surfaces, the authentication layer, the agent registry, the dependency cache system, and the test harness.

## Core Content

Ploinky must let an operator install and uninstall repositories, discover agents from `manifest.json` in installed repositories, register enabled agents in `.ploinky/agents.json`, and start a workspace whose routing state is written to `.ploinky/routing.json`. The first-class user entry points are the `ploinky` and `p-cli` launchers, the `ploinky-shell` assistant shell, and the router-managed browser surfaces served on the configured static-agent port.

The runtime must treat `.ploinky/` as the boundary for internal workspace state such as the enabled-agent registry, cloned repositories, regenerated dependency caches, logs, keys, routing, and workspace configuration. Persistent agent homes live beside that internal state under `.data/<agent-or-alias>/` and are mounted at `/root` for container agents in every run mode; `destroy` must preserve `.data/` while it removes containers and regenerated dependency caches.

Documentation must remain synchronized with the current branch. The HTML pages under `docs/` explain the system to human readers. The DS files under `docs/specs/` define the stable contract. When wording differs, the DS specifications are authoritative. The repository must keep the DS numbering contiguous and must preserve `DS001-coding-style.md` as the coding-style authority.

All persistent documentation output for this repository must be in English. This includes `AGENTS.md`, `CLAUDE.md`, HTML documentation, DS specifications, and code comments added to support current work.

## Decisions & Questions

### Question #1: Why does the documentation set treat the current branch implementation as the authority?

Response:
The repository already contains stale prose that no longer matches the implementation, including obsolete test paths and browser-surface descriptions. The defensible contract is therefore the code on the current branch plus the synchronized DS set generated from it, not any legacy documentation artifact that survived refactors.

### Question #2: Why are external or workspace-copied skills not expanded into host-project runtime pages?

Response:
The runtime contract exposed to operators is Ploinky itself. Expanding externally supplied or workspace-copied skills into standalone host-product pages would blur the project boundary and would violate the requirement that downstream host projects keep `/docs` focused on the host system rather than on imported skill catalogs.

## Conclusion

Ploinky is specified here as a concrete workspace runtime with synchronized documentation. The repository must continue to document the runtime that exists, keep the DS set authoritative, and preserve a clear boundary between host-project behavior and auxiliary repository-local skill tooling.
