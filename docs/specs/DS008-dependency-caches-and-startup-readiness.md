---
title: DS008-dependency-caches-and-startup-readiness
summary: Defines runtime-keyed dependency caches, graph ordering, coordinated startup generations, readiness gates, and bounded no-wait execution.
---

# DS008 Dependency Caches and Startup Readiness

## Introduction

Dependency preparation and readiness are explicit parts of Ploinky startup. A process id, container state, open port, or written routing candidate is insufficient by itself to declare a workspace ready.

## Core Content

Dependency caches must be keyed by the effective runtime family, platform, architecture, dependency manifest, installer identity, and moving git dependency revisions that affect installed bytes. Global and per-agent caches must use bounded locks, validity stamps, and atomic replacement. A stale, partial, wrong-runtime, or failed cache must not be mounted as valid. Box cache seeding must use copy behavior compatible with shared host mounts and must not depend on hard-link semantics.

Startup must prepare and admit the complete recursive manifest graph before launching its agents. Ploinky must assign or retain exact runtime identities, compile an inactive targetless generation, run the static preinstall hook and startup config providers in the declared order, reload provider-dependent state, and capture the final preparation lease before any target becomes eligible for activation.

Blocking dependencies must start in topological waves. Each node must satisfy its declared readiness protocol and required external health checks before dependents start. Target application must use the same coordinated generation mechanism for every wave, and final readiness requires the complete manifest graph to be ready or to have reached its declared no-wait terminal state. Cycles, malformed dependencies, stale identity, failed hooks, failed providers, failed readiness, and expired leases must fail closed with bounded cleanup.

No-wait agents may continue in detached workers only after the main transaction has prepared their identities and ordering. Their log and status records must be run-scoped, bounded, and atomically published. A detached worker must not activate raw routing candidates, overlap a blocking generation mutation, inherit an invalid predecessor, or hide terminal failure. Sequenced detached work must follow exact predecessor status with bounded timeouts and terminal-publication grace.

The watchdog may restart only a runtime that remains enabled, owns the expected identity, and has left startup coordination. It must repeat semantic readiness after restart and must not convert a stale or intentionally disabled runtime into active routing state.

## Conclusion

Ploinky startup is complete only when dependencies, runtime identities, targets, policy generation, and declared health evidence agree on one active workspace state.
