---
name: manage-ploinky-agents
description: Use this skill to create, update, review, and secure Ploinky agents, especially when editing manifest.json, mcp-config.json, MCP policy, HTTP service exposure, agent-to-agent communication, JWT signing, or routing behavior.
---

# Manage Ploinky agents safely.

## Use this skill when a Ploinky agent might change.

Use this skill whenever the task touches a Ploinky agent, its runtime configuration, its MCP configuration, its router policy, its public or protected HTTP exposure, its chat completions endpoint, or its agent-to-agent behavior. Treat every change as security-sensitive until the repository proves otherwise.

A Ploinky agent is a repository-owned runtime component discovered from an installed repository. The usual discovery path is `.ploinky/repos/<repo>/<agent>/manifest.json`. The canonical agent id is always `agent:<repo>/<agent>`. A route alias may change the URL prefix used by humans and clients, but an alias must not change the agent id.

## Load only the context that the edit requires.

Start with this file. Open `references/ploinky-agent-reference.md` when the task requires the agent model, runtime surfaces, routing behavior, endpoint behavior, or MCP proxy behavior. Open `references/config-files.md` when the task requires exact `manifest.json`, `mcp-config.json`, service route, policy-state, or example-file shapes. Open `references/security-invariants.md` when the task touches authentication, authorization, JWTs, request signing, policy, HTTP whitelist behavior, public services, or agent-to-agent calls. Open `references/workflows.md` when creating a new agent, updating an existing agent, or reviewing a security-sensitive diff. Open `references/code-examples.md` when implementing a Node.js tool, signing an agent assertion, computing a request hash, or writing a safe HTTP service handler. Run `scripts/validate-ploinky-agent.mjs` whenever a concrete agent directory or policy state is available. Invoke the `gamp-specs` skill against the repository that owns the agent whenever a change must regenerate that repository's specifications and documentation; the DS specifications of that repository are the source of truth, and this skill folder is not.

## Think in three surfaces.

The repository surface is the agent directory that contains `manifest.json`, `mcp-config.json`, tool commands, resource commands, prompts, static files, and optional HTTP or chat handlers. This surface defines what the agent can expose.

The runtime surface is the agent process or the bundled `AgentServer.mjs`. The default bundled runtime is MCP-first, listens on port `7000` inside the container, and is expected to be reachable only through localhost host ports managed by Ploinky.

The router surface is the public `RoutingServer`. The router owns authentication, authorization, route-prefix extraction, aggregate `/mcp`, per-agent `/<agent>/mcp`, service routes, auth routes, upload routes, blob routes, status routes, and UI routes. External clients should see the router for agent application surfaces, not agent container ports; a declared media or data plane (for example a WebRTC SFU) is the narrow exception described under the router-mediated boundary below.

## Preserve the router-mediated public boundary.

Do not expose an agent's application surfaces — its HTTP endpoints, `/<agent>/mcp`, tools, resources, task-status, or chat-completions — on agent container or localhost host ports directly to external clients. For those surfaces the router is the only public entrypoint: agents receive requests only after the router authenticates the caller, applies policy, strips unsafe client-supplied internal headers, mints a short-lived authorization for the target agent, and proxies the request.

A declared media or data plane is the narrow exception. A real-time transport the HTTP router cannot proxy — for example a WebRTC SFU such as LiveKit — may be reached by clients directly on a separate public surface, but only when the access credential is minted by a router-authenticated control-plane call, the plane verifies that credential itself, and the direct exposure is an explicit manifest or spec decision. The router still owns the control plane (credential issuance, policy, auth) for that capability, and the direct surface is usually its own dedicated infrastructure agent rather than the application agent's MCP or HTTP port. Treat that credential as a separate, app-owned token family, not one of the three Ploinky JWT families. Default remains router-only.

## Preserve agent identity.

The agent id is `agent:<repo>/<agent>`. The repository name and agent directory name form durable identity. A route key or alias is a routing label only. Do not change an agent id, route key, alias, or persisted policy identifier unless the user explicitly requested a compatible migration and the migration updates every dependent route, policy entry, test, and caller.

## Preserve secret boundaries.

`PLOINKY_MASTER_KEY` belongs to the router or launcher. It must not be injected into an agent, committed to configuration, copied into examples, printed in logs, or placed in tests. Each agent receives only `PLOINKY_AGENT_ID` and its own `PLOINKY_AGENT_SECRET`. An agent must never receive another agent's secret.

## Preserve the direction of each JWT family.

A User Session JWT goes from client to router and terminates at the router. An Agent Assertion JWT goes from source agent to router and proves the source agent knows its own secret. A Router Request JWT goes from router to target AgentServer and authorizes one concrete internal request. Never forward a raw user session token to an AgentServer.

## Preserve request binding.

Internal JWTs must bind the token to the real operation. The signed claims must include the expected `typ`, `iss`, `aud`, `method`, `path`, optional `tool`, and `rch`. The receiver must recompute the request hash from the actual request and reject mismatches. A valid signature with the wrong type, audience, method, path, tool, or request hash is not valid for execution.

## Preserve router-mediated agent-to-agent communication.

Agent-to-agent direct calls are invalid. A source agent signs an Agent Assertion JWT with its own secret and sends the request to the router. The router verifies the source identity, checks MCP policy for the source agent, target agent, and tool, then signs a Router Request JWT for the target AgentServer. The target AgentServer verifies the router token and request hash before executing the operation.

## Preserve MCP policy separation.

MCP policy is explicit and fail-closed. Missing policy means deny. Tags in `mcp-config.json` are defaults used to bootstrap policy only when no persisted policy exists for the same `agent + tool`. Persisted admin policy wins over tag defaults.

A tool with missing tags or an empty tag list is `authenticated`, which means it is callable by authenticated users when policy permits. A tool tagged `internal` is agent-only. A tool tagged `admin` is user-admin-only. A tool must not combine `internal` and `admin`. Unknown tags are invalid. An admin user does not automatically get internal access, and an agent does not get admin access.

## Preserve HTTP route safety.

HTTP whitelist behavior is separate from MCP policy. HTTP whitelist decisions use a normalized path and readonly methods. MCP policy decisions use `agent + tool`. Query strings must not decide whitelist access. A wildcard is valid only as a suffix in the form `/*`. Internal routes such as `/auth/*`, `/whitelist/command`, `/__agent/*`, `/<agent>/__agent/*`, `/metrics`, and `/health/internal` must not be whitelisted.

## Preserve chat completions as a non-privileged surface.

An OpenAI-compatible `/v1/chat/completions` endpoint does not receive implicit access to `admin` or `internal` tools. If an administrative operation is needed, expose it as a properly tagged MCP tool and let the router enforce policy. Do not hide privileged work behind a chat-completions command.

## Map identity before editing.

Before changing files, identify the installed repository name, agent directory name, canonical agent id, route key, alias, runtime mode, public paths, service routes, tool names, resource names, prompt names, and persisted policy entries. Locate `manifest.json`, `mcp-config.json`, tool commands, service handlers, chat handlers, tests, routing state, and policy state when they exist.

## Classify the requested change before editing.

Decide whether the task is config-only, code-changing, or security-sensitive. Config-only work usually touches manifests, MCP config, profiles, dependencies, service routes, or policy state. Code-changing work touches tool commands, resource commands, HTTP handlers, chat handlers, or runtime startup. Security-sensitive work touches JWT logic, request hashes, auth headers, policy, whitelist entries, public services, guest mode, or agent-to-agent calls.

## Treat the owning repository's specs as the source of truth.

A Ploinky agent and the Ploinky runtime are governed by the DS specifications of the repository that owns them. Before changing behavior, read the relevant DS specifications together with `manifest.json` and `mcp-config.json`, and treat the specifications as authoritative when documented intent and code disagree. State the intended behavior in specification terms first, then make the smallest code or configuration change that satisfies it. If the owning repository has no specification structure yet, treat that as a gap to close with `gamp-specs` rather than a reason to skip specs.

## Edit the smallest safe surface.

Prefer minimal diffs. Preserve existing agent ids, route keys, aliases, tool names, public paths, and persisted policy entries unless the user asked for a migration. Prefer the bundled AgentServer for MCP-first agents unless the custom runtime is necessary. When using a custom `start`, `agent`, or `commands.run`, make `readiness.protocol` explicit. Keep generated secrets out of `manifest.json`, `mcp-config.json`, source files, examples, and tests.

## Validate configuration after editing.

`manifest.json` must remain valid JSON and must describe runtime intent clearly. `mcp-config.json` may define `tools`, `resources`, and `prompts`. Tool names must be unique inside the agent. Commands must be explicit. Input schemas should be narrow. Tool tags must be valid and non-ambiguous. `httpServices` should be protected unless the intended exposure is different. `publicServices` should be anonymous only when anonymous exposure is safe.

## Validate authorization after editing.

For user requests, the router verifies the User Session JWT, applies policy, computes the request hash, and emits a Router Request JWT for the target agent. For agent requests, the source agent emits an Agent Assertion JWT, the router verifies source identity and MCP policy, and the router emits a Router Request JWT for the target agent. The target AgentServer verifies `router-request`, `iss: ploinky-router`, `aud` equal to its own agent id, method, path, optional tool, expiration, and `rch` before execution.

## Run deterministic checks.

When an agent directory is available, run the bundled validator from the skill directory.

```bash
node scripts/validate-ploinky-agent.mjs --agent-dir <agent-dir> --policy-state <policy-state.json>
```

When working inside a real Ploinky repository, also run the repository tests that cover routing, MCP proxying, authentication, policy, and the changed agent. Prefer focused tests for the changed modules before broad test suites. Report any check that could not be run.

## Resynchronize the specs after every change.

After any change to a Ploinky agent or to the Ploinky runtime, bring the owning repository's specifications and documentation back into sync by invoking the `gamp-specs` skill against that repository. Run it against the edited repository, never against this skill folder. Regenerate or update the DS specifications and HTML documentation for the affected agent and runtime surfaces, record the interface, routing, policy, and security changes in the relevant DS files, regenerate `docs/specs/matrix.md` from DS metadata, and run that repository's documentation link verification. The change is not finished while the specifications still describe the previous behavior. When the repository has no specification structure yet, use `gamp-specs` to initialize one so the next change has an authoritative baseline to edit.

## Finish with a risk-focused summary.

A change is done when the agent is discoverable from `manifest.json`, the MCP config is valid, tool tags are intentional, policy behavior is explicit, agent identity is stable, router-mediated exposure is preserved (agent application surfaces stay behind the router and any direct media or data plane is a declared, control-plane-gated exception), agent-to-agent calls go through the router, public HTTP exposure is readonly and intentional, the owning repository's specifications and documentation have been resynchronized with `gamp-specs` so the specifications remain the source of truth, and no raw secrets or full JWTs were added to code, config, logs, tests, or examples. The final response should call out security-impacting changes, validation results, the specification resynchronization status, and any assumption made because repository code or runtime state was unavailable.
