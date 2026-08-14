---
title: DS010-observability
summary: Defines read-only status and log surfaces, redacted runtime evidence, exact ownership reporting, and operational health boundaries.
---

# DS010 Observability

## Introduction

Operators must be able to determine what Ploinky owns, what is running, which generation is active, and why startup or routing failed without causing mutation or exposing credentials.

## Core Content

Public `ploinky status` and `ploinky logs` are observational commands. They must require an already owned and initialized Box where appropriate and must not create, pull, prepare, repair, restart, or replace runtime state. Status must distinguish absent, foreign, split, incompatible, stopped, transient, and ready states and must report only evidence proven for the exact workspace identity.

Engine publication evidence must come from normalized inspection of the exact owned container. Listener inventories must distinguish process ownership, interface class, transport, and expected target. Rootless publication may use an engine or virtual-machine forwarding layer and therefore must not be inferred solely from a host process scan. Detailed Router health and authority attestation remain on the private Unix socket.

Router and lifecycle telemetry must identify active configuration and publication generations without disclosing authorization-generation identifiers to ordinary browser clients. Logs and diagnostics must redact credentials, request tokens, cookies, master material, provider output values, and reusable relay material. Audit records may retain bounded actor, action, decision, selector, and deny-code data.

Ploinky durably appends Router output to `.ploinky/logs/router.log` and policy decisions to `.ploinky/data/router-security/policy-audit.log`. The enabled `workspaceMonitorAgent` schedules daily UTC maintenance through the private workspace-log capability; Ploinky performs the validated rotation into the Router and Policy archive directories. Retention defaults to 7 days and must remain bounded between 1 and 365 days. The maintenance interface accepts a fixed log kind and never an arbitrary filesystem path.

Agent application output may be passed through as operator-requested log content, but Ploinky control diagnostics must remain bounded and redacted. Log completion must offer one unambiguous reference per enabled record, and each reference must resolve to the exact container id or process-specific file selected for that record. Cancellation must perform bounded child cleanup before returning.

Conversation history, task state, agent-specific checkpoints, and model artifacts are agent-owned state. Ploinky observability may expose transport and lifecycle summaries but must not treat those data sets as Router operational truth or persist them in routing and policy records.

## Conclusion

Observability must explain exact owned state without changing it and must preserve the same workspace, identity, and credential boundaries enforced during mutation.
