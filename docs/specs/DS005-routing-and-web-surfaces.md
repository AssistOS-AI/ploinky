---
id: DS005
title: Routing and Web Surfaces
status: implemented
owner: ploinky-team
summary: Defines the router, watchdog, route table, static serving rules, and browser surfaces exposed by Ploinky.
---

# DS005 Routing and Web Surfaces

## Introduction

The routed interface is the operator-visible face of a running Ploinky workspace. This document defines the responsibilities of the watchdog, the router, the route table, and the prefixed browser surfaces.

## Core Content

The router must be supervised by `cli/server/Watchdog.js`, which launches and restarts `cli/server/RoutingServer.js`, records restart events, performs health checks against `/health`, and writes watchdog logs under `.ploinky/logs/watchdog.log`. The router itself must write request and lifecycle logs under `.ploinky/logs/router.log`.

The route table must be persisted in `.ploinky/routing.json`. It must contain the router port, the static agent metadata, and the current per-agent route entries resolved during startup. Static requests for `/`, `/index.html`, and static-agent entry aliases must resolve against the configured static host path from that file.

The router must provide first-party browser surfaces at `/webtty`, `/webchat`, `/webmeet`, `/dashboard`, and `/status`. Each surface owns its own session cookie and fallback asset directory under `cli/server/<surface>/`. `/webtty`, `/webchat`, and `/webmeet` must rely on the router login flow and the authenticated router session; they no longer accept surface-specific token login. `/dashboard` and the read-only `/status` surface continue to support dashboard-token access through `WEBDASHBOARD_TOKEN`. Asset resolution may also consult the static host root and `webLibs/`, but the documented fallback implementation for the first-party surfaces lives under `cli/server/`.

For `/webchat`, the router must treat `agent` as an explicit agent-selection query parameter and must preserve the remaining query parameters across the browser session endpoints. When a WebChat request selects an explicit agent, the router must forward every additional query parameter except router-reserved stream/session parameters such as `tabId` to that agent's `ploinky cli <agent>` launch as long-form CLI flags encoded as single `--key=value` tokens. The router must not hardcode ordinary target-agent parameter names for this forwarding behavior; interpretation belongs to the target agent CLI. The reserved compatibility parameters `workspace-dir`/`workspaceDir` and `workspace-skill-root`/`workspaceSkillRoot` are resolved by WebChat against the Ploinky workspace root and forwarded as absolute `--dir=` and `--skill-root=` values server-side so browser URLs can avoid leaking absolute host paths.

WebChat must remain a generic transport. It must not hardcode optional catalog agent ids, backend tags, MCP tool names, or domain-specific dispatch logic. Query parameters such as `feature-mode`, `forward-envelope`, or future agent-owned options are ordinary target-agent launch flags once they pass the router-reserved parameter filter. Their interpretation belongs to the selected agent CLI or to an explicitly configured downstream integration, not to Ploinky's router or WebChat handler.

When `/webchat` is launched with `forward-envelope=1`, messages may be written to the target TTY as the WebChat JSON envelope instead of plain text. The envelope may include sanitized attachment metadata, sanitized structured references (currently only `kind: "workspace-path"` records with `path`, `type`, and optional `label`), a sanitized public origin hint derived from the incoming WebChat request (`origin.publicBaseUrl`), and a short-lived router-minted invocation token scoped to the selected chat agent, allowing that agent to perform delegated MCP calls through the router without WebChat naming the downstream provider. The public origin hint must be limited to an `http` or `https` origin and is intended only for same-origin user-facing links back through the router. Reference paths must be workspace-relative; the server must drop entries containing absolute paths, traversal segments, NUL bytes, or reserved secret-file names before forwarding the envelope. Target CLIs that opt into this flag must tolerate `__webchatMessage` envelopes and normalize them before invoking their normal prompt flow; CLIs that do not recognize `references` or `origin` must ignore them safely.

WebChat's EventSource stream must tolerate brief browser reconnects without killing the target TTY. When a stream disconnects while the TTY is still running, WebChat keeps the tab alive for a bounded reconnect grace window and buffers outgoing SSE events in memory for replay on reconnect. Logout, explicit tab disposal, and normal process exit still release the TTY and transcript resources.

WebChat must provide a generic composer autocomplete surface driven by trigger providers. The composer controller owns menu lifecycle, keyboard navigation (Arrow Up/Down, Enter, Tab, Escape), pointer selection, grouped rendering, positioning, and insertion. Trigger providers supply suggestions:

- `/` opens the slash-command provider. The client queries the selected agent's MCP endpoint (`/<agent>/mcp`) for available tools. When the agent advertises a structured slash-command catalog tool, the provider uses that catalog and may send preserved launch query parameters such as `dir`; otherwise it maps `execute_<skill>` tool names to slash commands. Structured catalogs may declare subcommands and generic argument completions without WebChat hardcoding agent-specific command names. If the catalog fetch fails or returns no tools, the slash group remains silent.
- `@` opens the workspace-paths provider only. The workspace-paths provider queries `/webchat/suggestions/files` and shows files/folders under a `Files and folders` group scoped to the current WebChat session upload directory (`<cwd>/uploads/<sessionId>`, where `sessionId` is the value of the `webchat_sid` cookie minted by the authenticated WebChat session). Bare path searches such as `@rep` return matches inside that session upload directory only; explicit folder browsing such as `@file:reports/` drills further into the same session scope. Sibling session upload directories never appear. Selecting a file inserts a stable cwd-relative `@file:uploads/<sessionId>/<path>` token and records a structured `workspace-path` reference on the outgoing envelope.
Selected `@file:` path mentions should be visually emphasized in the composer while preserving the plain textarea value that is submitted to the selected chat agent.

WebChat must not hardcode optional agent ids, backend tags, or agent-owned tool names for `@` suggestions. It must not offer an `Agents` suggestion group or highlight arbitrary `@word` tokens as provider mentions. Unknown `@word` mentions remain ordinary chat text; semantic provider routing, if any, belongs to the selected chat agent after it receives the message envelope.

Ploinky must not add a research-specific enable command or WebChat availability toggle for optional provider agents. From the framework's perspective, a provider becomes selectable only when the selected chat agent exposes a launcher skill or equivalent agent-owned command for it. Backend health checks and unavailable messages belong to that launcher or downstream relay, not to Ploinky's command registry, composer, or router.

WebChat must expose `GET /webchat/suggestions/files` for the workspace-paths provider. The endpoint must require the same authenticated browser session as the surface, resolve a workspace-confined working directory from the same launch parameters used for `--dir`/`--skill-root` forwarding (`workspace-dir`/`workspaceDir`, with compatibility support for confined `dir`, falling back to the workspace root), derive the current WebChat session id from the `webchat_sid` cookie, and list only files and folders that live under `<cwd>/uploads/<sessionId>`. The session upload directory must be created lazily on first reference so a fresh session returns an empty result set rather than an error. Result `displayPath`, `relativePath`, and `queryPath` values are relative to the session upload root, result `path` is relative to the resolved WebChat working directory (for example, `uploads/<sessionId>/notes.md`) so inserted `@file:` tokens remain cwd-relative, and result `workspacePath` is relative to the workspace root. The endpoint must accept folder drill-down queries in either session-relative form (`reports/`) or cwd-relative token form (`uploads/<sessionId>/reports/`) and normalize both to the current session upload root before listing. The endpoint must reject absolute caller paths, traversal (`..`), NUL bytes, symlink escapes outside both the workspace root and the session upload root, and reserved secret files such as `.secrets` and `*.secrets`. Sibling session upload directories under the same `uploads/` parent must never appear in results. Results must be capped and sorted with directories before files. Host absolute paths must never appear in the response.

WebChat must also expose authenticated upload routes scoped to the same session upload directory:

- `POST /webchat/uploads` — accepts the request body as raw file bytes and writes the result to `<cwd>/uploads/<sessionId>/<relativePath>`. Required request metadata: `X-File-Name` carries the original display filename, `X-Relative-Path` carries an optional browser-supplied relative path (used for folder uploads via `webkitdirectory`), and `X-Mime-Type` carries the MIME type. Missing `X-Relative-Path` falls back to the sanitized filename. Existing files are stored without overwrite by appending a deterministic ` (n)` suffix to the leaf name. The JSON response contains `ok`, `filename`, `relativePath` (relative to the session upload root), `localPath` (relative to the WebChat working directory, e.g. `uploads/<sessionId>/<relativePath>`), `workspacePath` (relative to the workspace root), `downloadUrl` (the `/webchat/uploads?path=...` route), `size`, and `mime`. Host absolute paths must never appear in the response.
- `GET /webchat/uploads?path=<session-relative-path>` and `HEAD /webchat/uploads?path=<session-relative-path>` — stream the previously uploaded file. The `path` query parameter is relative to the session upload root and must use the same sanitization rules as upload writes. Responses set `Content-Type` from stored MIME metadata, `X-Content-Type-Options: nosniff`, and support `Range` for byte-range reads. MIME metadata is stored under the same working directory's `uploads/.webchat-upload-metadata/<sessionId>/` metadata area rather than inside the user-visible session upload tree.

The session upload directory is a per-session UX convenience scope. It must not be relied on as a security boundary between hostile sessions; the operator-controlled workspace trust model from DS011 still applies.

WebChat must also expose a Cancel button during active agent processing. The Cancel button sends a raw control sequence (ESC, `\x1b`) to the agent's TTY session via a dedicated `/webchat/control` endpoint. The agent must interpret this as an interrupt signal and abort the current operation. The Cancel button replaces the Send button while processing is active and reverts when the agent produces output or the session closes.

WebChat may receive structured progress metadata from chat agents through the same stdout/SSE stream. Lines containing `__webchatProgress` are UI metadata, not assistant text: the browser must render them as in-progress status, keep them out of normal transcript capture, and attach them as a collapsible progress block above the next assistant answer.

The router must also expose:

- `/health` for health status.
- `/upload` and `/blobs` for workspace and agent blob flows.
- `/webchat/uploads` for WebChat session-scoped file storage and download under `<cwd>/uploads/<sessionId>`.
- `/agent-card` for aggregate discovery of routable agents that expose capability metadata. The router must query each active route's internal `/agent-card` endpoint, include successful responses without validating their field shape, and report per-agent errors separately.
- `/<agent>/agent-card` for direct proxy access to one agent's capability metadata.
- `/<agent>/v1/chat/completions` for OpenAI-compatible chat-completions requests routed to one agent. The request body controls normal JSON versus SSE streaming through its `stream` field.
- `/mcp` for router-level MCP aggregation.
- `/<agent>/mcp` for agent MCP proxying.
- `/<agent>/task` for task-status passthrough.
- manifest-declared HTTP service prefixes for downstream HTTP services.

Agent-to-agent callers may access `/agent-card`, `/<agent>/agent-card`, and `/<agent>/v1/chat/completions` without router-level authentication; the target agent decides whether to accept or reject the request. The router acts as a transparent proxy for these endpoints. Orchestrators can discover remote agents via `PloinkyAgentSkillsSubsystem` and include them as tools through `## Allowed Agents` declarations.

Agent MCP sessions are runtime-owned and ephemeral. Clients that finish with a session should send `DELETE /mcp` with the `mcp-session-id` header so the agent runtime can close the SDK transport immediately. The shared `AgentServer` must also reap idle sessions defensively for clients that disconnect without a delete, but it must treat any session with an open HTTP response as active so long-running tool calls and SSE streams are not closed by idle cleanup.

HTTP service routes must be declared by the target agent rather than hard-coded into router handlers. An enabled agent may provide `httpServices` entries with an external prefix, internal upstream prefix, and auth mode. The router resolves those declarations from the route table and agent manifest, then forwards matching requests to the owning agent route. Public service declarations with `auth: "none"` intentionally run without router identity; `auth: "guest"` follows the normal guest policy, honoring an existing local session unless the declaration explicitly sets `forceGuest: true`, and otherwise mints a scoped guest session. Protected declarations must establish an authenticated router identity before proxying: the router prefers the owning route's auth policy, falls back to the static route's authenticated policy when the service-owning agent is otherwise unauthenticated, and rejects the request when no authenticated policy is available. Protected and guest HTTP services receive a scoped `__http_service__` invocation token by default unless the manifest entry explicitly sets `invocation: false`. Router-owned identity headers are stripped from caller input and regenerated by the router for protected or guest service requests. If a service route requests invocation minting but the owning route cannot be resolved to an installed-agent principal, the router fails the request closed instead of forwarding unsigned identity metadata.

When the static agent is not yet ready to serve its own static assets, the router may serve a temporary bootstrap page that reloads until the agent becomes ready. This bootstrap behavior is part of the current user-facing contract and should remain documented.

## Decisions & Questions

### Question #1: Why does the repository document `cli/server/dashboard/` as the active dashboard surface instead of the root-level `dashboard/` directory?

Response:
The current router handlers resolve the active dashboard fallback from `cli/server/dashboard/`. The root-level `dashboard/` directory is present in the repository but is not the fallback path used by the routed `/dashboard` implementation on this branch, so the documentation must follow the active handler path.

### Question #2: Why does Ploinky expose both router-level and agent-level MCP routes?

Response:
The router-level path aggregates tools and resources across agents, while the agent-level paths proxy directly to a single provider. The split allows the browser or CLI to either ask for a workspace-wide MCP surface or to target one agent explicitly without collapsing those two responsibilities into one endpoint.

### Question #3: Why special-case workspace-relative WebChat launch parameters?

Response:
Most WebChat query parameters belong to the selected agent CLI and should be forwarded unchanged. Workspace-relative launch parameters are different because their purpose is to keep absolute host filesystem paths out of browser URLs while preserving the absolute `--dir` and `--skill-root` values expected by local CLIs such as AchillesCLI.

### Question #4: Why forbid hardcoded optional agent ids in WebChat?

Response:
Ploinky is the framework layer. If a first-party surface hardcodes a catalog agent, the framework takes ownership of that agent's lifecycle, tags, tool names, and security policy by accident. Agent-specific workflows must be declared by manifests, query parameters, plugins, or the selected agent's own runtime. WebChat may carry generic envelopes and invocation grants, but it must not decide that a particular message belongs to a particular catalog agent.

### Question #5: Why avoid a Ploinky research enable command?

Response:
Provider availability is an agent-owned skill contract, not framework state.
Adding `ploinky enable research` or a similar WebChat toggle would make Ploinky
responsible for optional provider policy. Keeping the boundary at launcher
skill discovery lets AchillesCLI or another selected chat agent decide which
providers it can launch while Ploinky remains a generic transport.

## Conclusion

Ploinky’s routed interface depends on a supervised router, a persisted route table, and stable prefixed browser surfaces. The implementation and the documentation must continue to describe those route families and their current fallback asset locations accurately.
