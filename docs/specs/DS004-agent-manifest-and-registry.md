---
title: DS004-agent-manifest-and-registry
summary: Defines manifest discovery, profile composition, enabled-agent identity, dependency directives, runtime admission, and endpoint declarations.
---

# DS004 Agent Manifest and Registry

## Introduction

Ploinky discovers runnable agents from repository `manifest.json` files and records operator-selected instances in the workspace registry. The manifest describes an agent's inputs and dependencies; the registry identifies the exact enabled instance that lifecycle and routing operations may control.

## Core Content

Agent lookup must support repository-qualified references and may accept an unqualified name only when it resolves uniquely. Enabling an agent must persist its repository, manifest agent name, optional alias, runtime mode, authentication selection, instance identity, and enable generation. Aliases create independent runtime identities and persistent homes; they must not collapse into the base agent record.

`enable agent` is an activation operation: after validation it prepares the instance directories and source links, records the exact identity and generation, starts the selected runtime, waits for its readiness, and only then publishes the route. `disable agent` must first withdraw the route, then stop and remove only the captured runtime and registry record. It must preserve the instance's `.data/<agent-or-alias>` home so a later enablement can reuse persistent state. Enabling an auxiliary agent does not replace the workspace static agent selected by `start`.

The manifest startup policy is `automatic` unless it explicitly declares `startup: "manual"`. During an ordinary workspace start, a stopped manual agent outside the static dependency graph remains stopped and has no active route; a running manual agent remains running. The static agent and every explicit dependency must start regardless of the manual setting. `restart <agent-or-alias>` is the explicit activation path for a stopped manual instance and must complete runtime creation or start, readiness, and route restoration in that order.

The active profile may refine commands, environment, mounts, runtime mode, readiness, dependencies, and provider selection. Profile composition must follow explicit manifest semantics, validate accepted values, and strip Ploinky-reserved identity or credential names before authoritative runtime values are injected. A manifest or profile must not grant itself reusable credentials or alter Box-owned Router, topology, or edge-publication locators.

Runtime-owned environment includes the manifest name, workspace path, canonical workspace root, persistent home, MCP configuration location, prepared Node module path, and generated agent principal, instance, and enable-generation identifiers. Manifest and profile values may not override those names. Every enabled mode receives a persistent `.data/<agent-or-alias>` directory as its home at `/root`; isolated mode uses it as the workspace too, while global mode mounts the selected workspace and development mode mounts the selected repository as the working project. The agent source is mounted at `/code`, the Agent library at read-only `/Agent`, and shared workspace files at `/shared`; prepared dependencies are read-only where used.

Manifest dependency directives must resolve into one recursive graph before startup. Repository directives may acquire missing sources, and agent enable directives may add graph nodes. Cycles, malformed references, ambiguous agents, incompatible network requests, and invalid runtime policies must fail before launch. Authentication-dependent providers must be included only when the selected authentication mode requires them.

Endpoint declarations such as agent routes, `openPorts`, HTTP services, MCP tools, readiness probes, and Router surfaces describe private in-Box targets. They must never add an outer Box publication. Host networking is an exceptional runtime placement that requires an exact current-generation capability; `none` networking receives no Router endpoint. Managed default and bridge networking must use the approved private Router transport.

When no custom `start`, `agent`, or `commands.run` service is supplied, the default AgentServer loads `mcp-config.json` through the runtime-owned MCP configuration path and serves its tools, resources, and prompts through the private routed MCP surface. Configured tool commands receive structured JSON input on standard input and return text on standard output. Tool access tags map to the authenticated, admin, or internal policy classes; untagged tools default to authenticated, invalid tag combinations fail closed, and persisted Router policy remains authoritative.

Disabling or replacing an agent must target the captured registry record and exact runtime identity. The operation must not select a similarly named process or container, and removing a registry record must coordinate with watchdog behavior so a deliberately disabled runtime is not recreated.

## Conclusion

Manifests define portable agent intent, while the registry binds that intent to one exact workspace instance and generation. Runtime and routing code must require both layers before acting.
