---
id: DS009
title: Observability
status: implemented
owner: ploinky-team
summary: Defines router and watchdog logging, runtime health reporting, and the boundary between operational telemetry and agent-owned conversation and task state.
---

# DS009 Observability

## Introduction

Ploinky exposes operational state through router and watchdog logs, health checks, CLI status, and browser status views. This document defines those observability guarantees and keeps operational telemetry separate from user-owned conversation continuation state.

## Core Content

The watchdog and router must emit structured operational logs under `.ploinky/logs/`. The CLI currently exposes router-log streaming and tail retrieval through `logs tail` and `logs last`, and the browser status surface may shell out to `ploinky status` to present a CLI-consistent view of workspace state.

The router health endpoint at `/health` must report process uptime, PID, memory usage, and active-session counts for first-party browser surfaces and agent MCP sessions. This endpoint is part of the watchdog's health-check loop and therefore forms part of the runtime stability contract.

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

## Conclusion

Ploinky must continue to expose useful operational logs and health status without taking ownership of raw conversation continuation.
