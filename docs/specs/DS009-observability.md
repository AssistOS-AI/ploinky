---
id: DS009
title: Observability
status: implemented
owner: ploinky-team
summary: Defines router and watchdog logging, runtime health reporting, and the boundary between operational telemetry and folder-local WebChat continuation state.
---

# DS009 Observability

## Introduction

Ploinky exposes operational state through router and watchdog logs, health checks, CLI status, and browser status views. This document defines those observability guarantees and keeps operational telemetry separate from user-owned conversation continuation state.

## Core Content

The watchdog and router must emit structured operational logs under `.ploinky/logs/`. The CLI currently exposes router-log streaming and tail retrieval through `logs tail` and `logs last`, and the browser status surface may shell out to `ploinky status` to present a CLI-consistent view of workspace state.

The router health endpoint at `/health` must report process uptime, PID, memory usage, and active-session counts for first-party browser surfaces and agent MCP sessions. This endpoint is part of the watchdog's health-check loop and therefore forms part of the runtime stability contract.

WebChat continuation state under `<cwd>/.copilot_history/` is folder-local project data, not operational telemetry. Its session files support selection, lazy history rendering, and context restoration. Ploinky must not duplicate that content into a separate workspace-level conversation store or expose it through Dashboard analytics.

Operational logs must not intentionally record raw prompts or assistant replies. Folder-history files may contain conversation roles, text, timestamps, attachments, and references because they are the explicit continuation data selected by the user. The generated `.gitignore` reduces accidental publication, but the workspace owner remains responsible for the local filesystem trust boundary.

The Dashboard is an operational surface for status, logs, enabled agents, and runtime control. It must not expose conversation history or conversation-rating analytics.

## Decisions & Questions

### Question #1: Why is folder history excluded from operational observability?

Response:
Folder history exists so a user can continue a conversation in the project where it occurred. Treating message bodies as operational telemetry would create an unrelated workspace-wide data surface and would blur the ownership boundary between project state and runtime diagnostics.

### Question #2: Why are raw conversation bodies excluded from logs?

Response:
Prompts and replies may contain credentials, source fragments, personal data, or other sensitive material. Operational diagnosis should use lifecycle events, process state, redacted errors, and health metrics without copying message content into logs.

## Conclusion

Ploinky must continue to expose useful operational logs and health status while keeping raw conversation continuation in the folder-scoped history explicitly controlled by WebChat users.
