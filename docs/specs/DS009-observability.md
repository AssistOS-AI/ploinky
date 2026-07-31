---
id: DS009
title: Observability
status: implemented
owner: ploinky-team
summary: Defines redacted edge-generation telemetry, exact engine port evidence, owner-aware listener inventory, Unix-socket health, runtime reporting, release artifacts, and the boundary between operational telemetry and agent-owned conversation and task state.
---

# DS009 Observability

## Introduction

Ploinky exposes operational state through router and watchdog logs, health checks, CLI status, and browser status views. This document defines those observability guarantees and keeps operational telemetry separate from user-owned conversation continuation state.

## Core Content

The watchdog and router must emit structured operational logs under `.ploinky/logs/`. The CLI currently exposes router-log streaming and tail retrieval through `logs tail` and `logs last`, and the browser status surface may shell out to `ploinky status` to present a CLI-consistent view of workspace state. For a compatible running Box, the public host command uses the same read-only workspace renderer as the core command, including SSO, Router, repository, and per-agent runtime details. This status-only entrypoint bypasses core initialization and bootstrap so inspection cannot create workspace state, refresh repositories, or reconcile runtimes. Missing, stopped, incompatible, uninitialized, and transient Box states retain the dependency-free outer summary.

Detailed Router health reports process uptime, PID, memory use, listener state,
active-session counts, route-generation identity, and target status only through
the supervisor-owned unmounted Unix socket. It is absent from both TCP listeners.
Authenticated TCP status is a bounded summary and must not reveal private
targets, caller ACLs, source bytes, tokens, credential handles, or topology
inventory.

Outer status normalizes the container engine's `HostConfig.PortBindings` and
reports contract 5 only when it is exactly loopback selected-host-port to
`8080/tcp` plus wildcard `7882:7882/udp`. The in-box listener inventory records
bind address, protocol, socket owner, owning effective instance, and rationale;
it distinguishes expected private support listeners from unexpected wildcard or
control sockets instead of assuming that the box contains only two sockets.
The startup inventory is evidence, not a lifetime lease: recurring semantic
probe events report success/failure without socket payloads or credentials, and
a failure records selector inactivation plus the exact runtime-generation
replacement outcome.

Supervisor/admin routing status distinguishes the route-and-policy
authorization generation, the topology configuration generation, and the
topology publication generation. It may expose their ids, the active source
digest, inactive selectors, and source-health failures without source contents;
the authenticated browser locator projection exposes only configuration and
publication ids and no inventory. Edge status distinguishes explicit
`local-only`, reconciling, error, and `cloudflare-ready`; it never converts an
invalid Cloudflare state into another mode. TURN mint audit events record exact
caller/generation, outcome, and expiry but never credential material. Browser
and media release-gate artifacts redact cookies, tokens, passwords,
authorization headers, and URLs containing secrets while retaining
participant/publication ids, selected ICE candidate pairs, and source-specific
RTP deltas.

Conversation continuation is agent-owned project data, not Ploinky operational telemetry. WebChat may retain the selected CLI's latest session snapshot in runtime memory for rendering and reconnect recovery, but Ploinky must not write conversation files or expose message bodies through Dashboard analytics.

The same folder may contain selected-CLI-owned task metadata and logs for user-requested asynchronous agent work. This task state is project data rather than router telemetry. WebChat may retain validated task envelopes in runtime memory for the Tasks overlay and EventSource forwarding, but Ploinky must not write the task journal or log files. The selected CLI's persisted metadata must exclude credentials, invocation grants, and raw tool arguments.

Operational logs must not intentionally record raw prompts or assistant replies. An agent-owned session store may contain conversation roles, text, timestamps, attachments, and references, but it remains outside Ploinky observability. The workspace owner remains responsible for the local filesystem trust boundary.

The Dashboard is an operational surface for status, logs, enabled agents, and runtime control. It must not expose conversation history or conversation-rating analytics.

## Decisions & Questions

### Question #1: Why is agent-owned history excluded from operational observability?

Response:
Agent-owned history exists so a user can continue a conversation in the project where it occurred. Treating message bodies as operational telemetry would create an unrelated workspace-wide data surface and blur the boundary between agent state and runtime diagnostics.

### Question #2: Why are raw conversation bodies excluded from logs?

Response:
Prompts and replies may contain credentials, source fragments, personal data, or other sensitive material. Operational diagnosis should use lifecycle events, process state, redacted errors, and health metrics without copying message content into logs.

### Question #3: Why is engine inspection authoritative for the outer port boundary?

Response:
Rootless container publications may be implemented by NAT or a virtual-machine
layer and need not appear as ordinary userspace listeners. Normalizing the
engine's actual `HostConfig.PortBindings` proves what the container requested;
host scans and external probes remain useful supplemental evidence but cannot
replace that contract check.

### Question #4: Why is detailed health Unix-socket-only?

Response:
Detailed health contains process, listener, target, and generation information
that helps a supervisor but widens a remote attacker's inventory. An unmounted
Unix socket lets the box supervisor diagnose and restart Router without adding
an anonymous or assertion-authenticated TCP control surface.

### Question #5: Why record both launch ownership and recurring socket ownership?

Response:
Immutable container labels or sandbox PID records prove which generation was
launched, while an owner-aware socket probe proves what that process owns now.
Neither evidence substitutes for the other, so status and release artifacts
retain both without exposing private targets or credential material.

## Conclusion

Ploinky must continue to expose useful operational logs and health status without taking ownership of raw conversation continuation.
