---
title: DS004-agent-manifest-and-registry
summary: Defines manifest discovery, profile composition, enabled-agent identity, dependency directives, runtime admission, and endpoint declarations.
---

# DS004 Agent Manifest and Registry

## Introduction

Ploinky discovers runnable agents from repository `manifest.json` files and records operator-selected instances in the workspace registry. The manifest describes an agent's inputs and dependencies; the registry identifies the exact enabled instance that lifecycle and routing operations may control.

## Core Content

Agent lookup must support repository-qualified references and may accept an unqualified name only when it resolves uniquely. Enabling an agent must persist its repository, manifest agent name, optional alias, runtime mode, authentication selection, instance identity, and enable generation. Aliases create independent runtime identities and persistent homes; they must not collapse into the base agent record.

The active profile may refine commands, environment, mounts, runtime mode, readiness, dependencies, and provider selection. Profile composition must follow explicit manifest semantics, validate accepted values, and strip Ploinky-reserved identity or credential names before authoritative runtime values are injected. A manifest or profile must not grant itself reusable credentials or alter Box-owned Router, topology, or edge-publication locators.

Manifest dependency directives must resolve into one recursive graph before startup. Repository directives may acquire missing sources, and agent enable directives may add graph nodes. Cycles, malformed references, ambiguous agents, incompatible network requests, and invalid runtime policies must fail before launch. Authentication-dependent providers must be included only when the selected authentication mode requires them.

Endpoint declarations such as agent routes, `openPorts`, HTTP services, MCP tools, readiness probes, and Router surfaces describe private in-Box targets. They must never add an outer Box publication. Host networking is an exceptional runtime placement that requires an exact current-generation capability; `none` networking receives no Router endpoint. Managed default and bridge networking must use the approved private Router transport.

Disabling or replacing an agent must target the captured registry record and exact runtime identity. The operation must not select a similarly named process or container, and removing a registry record must coordinate with watchdog behavior so a deliberately disabled runtime is not recreated.

## Conclusion

Manifests define portable agent intent, while the registry binds that intent to one exact workspace instance and generation. Runtime and routing code must require both layers before acting.
