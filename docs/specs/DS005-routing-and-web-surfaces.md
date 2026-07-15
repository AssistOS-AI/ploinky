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

The route table must be persisted in `.ploinky/routing.json`. It must contain the router port, static agent metadata, and the current per-agent route entries resolved during startup. Per-agent route entries provide the upstream host port and metadata such as repository, agent name, container name, alias, and host path. The static-agent metadata identifies the workspace entry agent and container; it is not the router's static-file root.

`ploinky reinstall <agent>` recreates the agent container with a new dynamic host port and rewrites its `.ploinky/routing.json` entry; because the router resolves routes from that file per request, the new port takes effect without a router restart. Reinstall waits for the recreated agent's host port to become ready before returning. If a request still returns 502 immediately after a reinstall (for example a slow container image start), run `ploinky restart`.

The watchdog container monitor must defer automatic container restarts while a maintenance lock is active for the same container. It must check the lock both when deciding to schedule a restart and immediately before executing a previously scheduled restart, because a reinstall or explicit restart may acquire the lock after the watchdog timer was created. A deferred timer must release the monitor's in-progress restart state so later ticks can reevaluate the live container after maintenance completes.

The router must provide first-party browser surfaces at `/webchat`, `/dashboard`, and `/status`. Each surface owns its own session cookie and fallback asset directory under `cli/server/<surface>/`. `/webchat` must rely on the router login flow and the authenticated router session; it does not accept surface-specific token login. `/dashboard` and the read-only `/status` surface continue to support dashboard-token access through `WEBDASHBOARD_TOKEN`. Asset resolution may also consult the static host root and `webLibs/`, but the documented fallback implementation for the first-party surfaces lives under `cli/server/`.

For `/webchat`, the router must treat `agent` as an explicit agent-selection query parameter and must preserve the remaining query parameters across the browser session endpoints. When a WebChat request selects an explicit agent, the router must forward every additional query parameter except router-reserved stream/session parameters such as `tabId` and `sessionId` to that agent's `ploinky cli <agent>` launch as long-form CLI flags encoded as single `--key=value` tokens. The router must not hardcode ordinary target-agent parameter names for this forwarding behavior; interpretation belongs to the target agent CLI. The reserved alias parameters `workspace-dir`/`workspaceDir` and `workspace-skill-root`/`workspaceSkillRoot` are resolved by WebChat against the Ploinky workspace root and forwarded as absolute `--dir=` and `--skill-root=` values server-side so browser URLs can avoid leaking absolute host paths. The `ploinky cli <agent>` launch path is expected to resolve the agent manifest from workspace repositories and auto-enable missing agents in the standard global enable flow when needed.

WebChat must remain a generic transport. It must not hardcode optional catalog agent ids, backend tags, MCP tool names, or domain-specific dispatch logic. Query parameters such as `feature-mode`, `forward-envelope`, or future agent-owned options are ordinary target-agent launch flags once they pass the router-reserved parameter filter. Their interpretation belongs to the selected agent CLI or to an explicitly configured downstream integration, not to Ploinky's router or WebChat handler.

When `/webchat` is launched with `forward-envelope=1`, messages may be written to the target TTY as the WebChat JSON envelope instead of plain text. The envelope may include sanitized attachment metadata, sanitized structured references (currently only `kind: "workspace-path"` records with `path`, `type`, and optional `label`), a sanitized public origin hint derived from the incoming WebChat request (`origin.publicBaseUrl`), and a short-lived router-minted invocation token scoped to the selected chat agent, allowing that agent to perform delegated MCP calls through the router without WebChat naming the downstream provider. The public origin hint must be limited to an `http` or `https` origin and is intended only for same-origin user-facing links back through the router. Reference paths must be workspace-relative; the server must drop entries containing absolute paths, traversal segments, NUL bytes, or reserved secret-file names before forwarding the envelope. Target CLIs that opt into this flag must tolerate `__webchatMessage` envelopes and normalize them before invoking their normal prompt flow; CLIs that do not recognize `references` or `origin` must ignore them safely.

WebChat conversation identity must be scoped to the canonical working directory
resolved from `workspace-dir`/`workspaceDir` or confined `dir`. The router must
create or reuse `<cwd>/.copilot_history/`, store one JSON file per conversation,
and keep the selected conversation id in `.copilot_history/current_session.json`.
Stored messages contain role, text, timestamp, attachments, and references.
Assistant messages created for a user turn may additionally contain `progress`,
whose value must be an ordered array of non-empty strings, and one validated
`taskId` that associates the message with separately persisted task state. Task
status and log content must not be copied into the session JSON. Writes must be atomic,
malformed session files must not appear in the selector, and a symlinked history
directory must be rejected.

When WebChat accepts a non-empty user turn, it must persist the user message and
an immediately following assistant placeholder in one session update before
writing the request to the TTY. The placeholder starts with empty `text` and
empty `progress`. Final output updates the placeholder text, while an interrupted
turn may retain an empty final text and any progress accumulated before
interruption. Legacy messages without `progress` remain valid and must not gain
the property during normalization.

The authenticated session API consists of `GET /webchat/sessions`, `POST /webchat/sessions`, `PUT /webchat/sessions/current`, and `GET /webchat/sessions/<session-id>`. Listing returns the current id and selector metadata without message bodies or counts. Full history is returned only by the per-session GET route. Selector entries expose the first user-message preview and update timestamp; the browser renders that timestamp as relative time.

WebChat's EventSource stream must tolerate brief browser reconnects without killing the target TTY. Runtime identity is the canonical working directory, selected folder session, selected agent, and launch configuration; `tabId` identifies only a browser client and must be recovered from `sessionStorage` on refresh. A runtime may have multiple SSE subscribers and remains alive for the bounded reconnect grace window after the last subscriber leaves. Output produced without a subscriber is recovered from folder history on demand rather than replayed automatically from an in-memory tab buffer.

WebChat must not render existing messages automatically after refresh. A non-empty session presents `Click to load session history` as a centered standalone button inside the scrollable message stream, not as a chat item, while the composer remains usable and new turns append to the current session. This item is browser-only: it must not be written to folder history, sent to the agent, or included in continuation context. Activating it removes it immediately and loads the real history; a failed request may restore it so the user can retry. The `Sessions` header control opens one selector whose first item is the emphasized `New` action; activating it creates and selects an empty session. The remaining items list sessions by recent activity using a first-message preview and relative time, without agent or message-count metadata. Selecting an existing entry makes it current and loads it. Session changes and new turns must be visible to other connected clients using the same working directory.

The `Tasks` and `Sessions` controls in the WebChat header must use a darker green hover fill that remains visually consistent with the green header, rather than inheriting the theme's neutral panel-hover color.

When a folder session has history but no surviving runtime, WebChat must restore
context without replaying historical user inputs as separate TTY commands. The
prior conversation's user content and final assistant text are placed in a
delimited context block before the first new non-slash message. Progress strings
and assistant placeholders with no final content must remain UI-only and must not
enter this continuation context. Slash commands remain unchanged and defer
restoration until a later conversational message. This mechanism must remain
generic for plain-text and WebChat-envelope agents and must not special-case
AchillesCLI or another target agent.

Every WebChat CLI process must receive `PLOINKY_WEBCHAT_HAS_HISTORY=1` when the selected folder session already contains messages, otherwise `0`. This variable is the allowlisted startup contract for local and containerized agents; the folder session id remains router-owned and must not be forwarded through the process environment. Arbitrary router environment variables must not be forwarded with the history flag. Agents that generate new-conversation startup content should skip it when history exists. Ploinky must not expose message bodies or history file paths through the process environment.

WebChat must provide a generic composer autocomplete surface driven by trigger providers. The composer controller owns menu lifecycle, keyboard navigation (Arrow Up/Down, Enter, Tab, Escape), pointer selection, grouped rendering, positioning, and insertion. Arrow Up/Down navigation must keep the active option inside the visible viewport of the scrollable menu. Trigger providers supply suggestions:

- `/` opens the slash-command provider only when it is the first composer character. Later `/` characters are ordinary command-argument text, including provider-qualified model names. The client queries the selected agent's MCP endpoint (`/<agent>/mcp`) for available tools and sends the Streamable HTTP media contract `Accept: application/json, text/event-stream` on initialization and subsequent MCP requests. When the agent advertises a structured slash-command catalog tool, the provider uses that catalog and may send preserved launch query parameters such as `dir`; otherwise it maps `execute_<skill>` tool names to slash commands. Structured catalogs may declare subcommands, generic argument completions, a generic argument match mode, and a positive per-command result limit without WebChat hardcoding agent-specific command names. Prefix matching remains the default; an agent may request fragment matching for large searchable catalogs. When the agent does not limit results, WebChat keeps every match accessible but progressively adds bounded result batches to the fixed-height scrollable menu as keyboard or pointer navigation approaches the rendered boundary. If the catalog fetch fails or returns no tools, the slash group remains silent.
- `@` opens the workspace-paths provider only. The workspace-paths provider queries `/webchat/suggestions/files` and shows files/folders under a `Files and folders` group scoped to the current WebChat session upload directory (`<cwd>/uploads/<sessionId>`, where `sessionId` is the value of the `webchat_sid` cookie minted by the authenticated WebChat session). Bare path searches such as `@rep` return matches inside that session upload directory only; explicit folder browsing such as `@file:reports/` drills further into the same session scope. Sibling session upload directories never appear. Selecting a file inserts a stable cwd-relative `@file:uploads/<sessionId>/<path>` token and records a structured `workspace-path` reference on the outgoing envelope.
Selected `@file:` path mentions should be visually emphasized in the composer while preserving the plain textarea value that is submitted to the selected chat agent.

WebChat must not hardcode optional agent ids, backend tags, or agent-owned tool names for `@` suggestions. It must not offer an `Agents` suggestion group or highlight arbitrary `@word` tokens as provider mentions. Unknown `@word` mentions remain ordinary chat text; semantic provider routing, if any, belongs to the selected chat agent after it receives the message envelope.

Ploinky must not add a research-specific enable command or WebChat availability toggle for optional provider agents. From the framework's perspective, a provider becomes selectable only when the selected chat agent exposes a launcher skill or equivalent agent-owned command for it. Backend health checks and unavailable messages belong to that launcher or downstream relay, not to Ploinky's command registry, composer, or router.

WebChat must expose `GET /webchat/suggestions/files` for the workspace-paths provider. The endpoint must require the same authenticated browser session as the surface, resolve a workspace-confined working directory from the same launch parameters used for `--dir`/`--skill-root` forwarding (`workspace-dir`/`workspaceDir`, with alias support for confined `dir`, falling back to the workspace root), derive the current WebChat session id from the `webchat_sid` cookie, and list only files and folders that live under `<cwd>/uploads/<sessionId>`. The session upload directory must be created lazily on first reference so a fresh session returns an empty result set rather than an error. Result `displayPath`, `relativePath`, and `queryPath` values are relative to the session upload root, result `path` is relative to the resolved WebChat working directory (for example, `uploads/<sessionId>/notes.md`) so inserted `@file:` tokens remain cwd-relative, and result `workspacePath` is relative to the workspace root. The endpoint must accept folder drill-down queries in either session-relative form (`reports/`) or cwd-relative token form (`uploads/<sessionId>/reports/`) and normalize both to the current session upload root before listing. The endpoint must reject absolute caller paths, traversal (`..`), NUL bytes, symlink escapes outside both the workspace root and the session upload root, and reserved secret files such as `.secrets` and `*.secrets`. Sibling session upload directories under the same `uploads/` parent must never appear in results. Results must be capped and sorted with directories before files. Host absolute paths must never appear in the response.

WebChat must also expose authenticated upload routes scoped to the same session upload directory:

- `POST /webchat/uploads` — accepts the request body as raw file bytes and writes the result to `<cwd>/uploads/<sessionId>/<relativePath>`. Required request metadata: `X-File-Name` carries the original display filename, `X-Relative-Path` carries an optional browser-supplied relative path (used for folder uploads via `webkitdirectory`), and `X-Mime-Type` carries the MIME type. Missing `X-Relative-Path` falls back to the sanitized filename. Existing files are stored without overwrite by appending a deterministic ` (n)` suffix to the leaf name. The JSON response contains `ok`, `filename`, `relativePath` (relative to the session upload root), `localPath` (relative to the WebChat working directory, e.g. `uploads/<sessionId>/<relativePath>`), `workspacePath` (relative to the workspace root), `downloadUrl` (the `/webchat/uploads?path=...` route), `size`, and `mime`. Host absolute paths must never appear in the response.
- `GET /webchat/uploads?path=<session-relative-path>` and `HEAD /webchat/uploads?path=<session-relative-path>` — stream the previously uploaded file. The `path` query parameter is relative to the session upload root and must use the same sanitization rules as upload writes. Responses set `Content-Type` from stored MIME metadata, `X-Content-Type-Options: nosniff`, and support `Range` for byte-range reads. MIME metadata is stored under the same working directory's `uploads/.webchat-upload-metadata/<sessionId>/` metadata area rather than inside the user-visible session upload tree.

The session upload directory is a per-session UX convenience scope. It must not be relied on as a security boundary between hostile sessions; the operator-controlled workspace trust model from DS011 still applies.

WebChat must also expose a Cancel button during active agent processing. The Cancel button sends a raw control sequence (ESC, `\x1b`) to the agent's TTY session via a dedicated `/webchat/control` endpoint. The agent must interpret this as an interrupt signal and abort the current operation. The Cancel button replaces the Send button while processing is active and reverts when the agent produces output or the session closes.

WebChat may receive structured progress metadata from chat agents through the
same stdout/SSE stream. For a valid `__webchatProgress` envelope associated with
the active assistant placeholder, WebChat must append only the trimmed,
non-empty `reason` string to that message's `progress` array. It must not persist
`tool`, `type`, `stepIndex`, or other envelope metadata. The browser must render
live progress as in-progress status and render persisted progress as a
collapsible block above the final answer. A progress-only placeholder may render
that block without an empty text bubble. Progress remains UI metadata rather
than assistant text and must not enter continuation context.

WebChat may also receive generic `__webchatTask` lifecycle envelopes from a selected CLI. These envelopes must be intercepted before conversation rendering and history capture. Ploinky must store workspace-scoped task metadata as append-only JSON lines in `<cwd>/.copilot_history/agent_tasks`, store bounded per-task logs separately under `.copilot_history/task_logs/`, and expose authenticated `GET /webchat/tasks` and `GET /webchat/tasks/<task-id>/log` routes. Browser updates must use the existing EventSource stream with a `task-update` event; Ploinky must not hardcode target-agent ids or tool names.

The first `started` envelope for a user turn must attach its task id to that
turn's existing assistant placeholder. Live correlation may include the folder
session id and assistant message index on the EventSource event, but this
transient routing data must not be duplicated in the task journal. The browser
must render the task as a collapsible module at the bottom of the ordinary
assistant bubble, keep collecting updates while collapsed, and recover the same
module after history loading by resolving `message.taskId` against the task and
log routes. The module must show the exact target-agent id, description, status,
and elapsed whole seconds. It remains available after terminal completion; a
missing task record renders as unavailable.

The Tasks overlay and inline task module must share one presentation policy.
Pending work is shown as `QUEUED`, active work as `RUNNING`, and terminal states
as `COMPLETED`, `STOPPED`, or `FAILED`. Raw task log files remain unchanged and
are written only by task-event ingestion. Browser rendering strips stream and
runner prefixes such as `[opencode stdout]`, `[opencode stderr]`, and
`[opencodeAgent/execute-task]`; stdout remains primary and stderr uses a less
prominent text color. Runner start/exit diagnostics are omitted because duration
is displayed separately, while timeout and crash information remains visible.

When a WebChat runtime has no SSE subscribers but owns a task whose materialized state is `ongoing`, reconnect cleanup must retain that runtime so its agent can continue router-mediated polling and log collection. Once its tasks become terminal, the normal reconnect grace and disposal behavior resumes. If the runtime is recreated after a wider process restart, the selected CLI may reattach from the workspace task journal. Task identity must be based on the target agent and remote task id; a PID is optional diagnostics only.

The router must also expose:

- `/health` for health status.
- `/api/marketplace` for the first-party agent marketplace. This route is router-owned and returns JSON rather than proxied agent content. `GET /api/marketplace` must require an authenticated local or SSO user and must report the caller identity, caller marketplace permissions, predefined repositories, installed repositories, remembered repository sources, repository kind, discoverable agents, enabled-agent registry state, and runtime status derived from live Ploinky containers. Non-admin clients must use the returned permissions to hide management controls. `POST /api/marketplace` must require an authenticated local administrator and accepts `install_repo`, `uninstall_repo`, `enable_agent`, and `disable_agent` actions. Repository installation must require a URL, accept an optional name and branch, clone the checkout, and record source metadata including repository kind. Repository uninstall must match the CLI repository contract: it disables enabled agents that came from that repository by container key, removes their runtime containers through the normal disable helper, preserves agent work directories, removes the installed repository checkout, and preserves the source metadata so the repository remains available for reinstall in the correct Marketplace repo category. Agent enablement must use the standard enable path. Agent disablement is marketplace-specific: the route removes the enabled-agent registry record before removing the agent runtime with the normal container removal helper, so the watchdog container monitor does not restart the runtime while the admin operation is in progress. This marketplace behavior must not change the conservative direct `ploinky disable agent` CLI contract, which still refuses to remove records while runtime state exists.
- `/upload` and `/blobs` for workspace and agent blob flows.
- `/workspace-files/...` for authenticated, workspace-confined file reads owned by the router.
- `/webchat/uploads` for WebChat session-scoped file storage and download under `<cwd>/uploads/<sessionId>`.
- `/agent-card` for aggregate discovery of routable agents that expose capability metadata. The router must query each active route's internal `/agent-card` endpoint, include successful responses without validating their field shape, and report per-agent errors separately.
- `/mcp` for router-level MCP aggregation.
- manifest-declared HTTP service prefixes for downstream HTTP services.
- `POST /policy/command` is the single administrative endpoint for the router's access-control policy (DS014). It is authenticated, never route-policy-controlled, and handles `http.route.*` and `mcp.policy.*` namespaces.
- `http://<agent>.localhost:<routerPort>/` for the active profile's `additionalServerPort` when declared. The router must use the request host to select the route key, preserve the root-relative path and query string, and proxy the request to the configured HTTP server. For container-local declarations, the launcher must publish the declared container port on `127.0.0.1` with an ephemeral host port and write the resolved host-mode upstream into routing state; the router then proxies to that host URL rather than relying on container IP reachability. This root-mounted host-based surface is for agent-owned browser services and must not replace the default AgentServer route used for MCP, agent-card, and runtime control paths.
- `/<agent>/...` for transparent per-agent proxying after the router-owned paths above have been considered. The router strips the `/<agent>` mount prefix and forwards the remaining path and query string to the route's upstream host port. The target agent owns paths such as `/index.html`, `/agent-card`, `/v1/models`, `/v1/chat/completions`, `/task`, and any custom HTTP endpoints. `/<agent>/mcp` remains the special MCP proxy path because the router must preserve MCP session mediation and per-agent Router Request minting (DS013) plus MCP tool policy enforcement (DS014) for tool and resource operations. Agent-to-agent task-status polling for async MCP tasks is also router-mediated: a delegated caller presents an Agent Assertion for `GET /task` or `GET /getTaskStatus`, and the router mints a target-scoped Router Request before proxying the status read. Agent-to-agent OpenAI-compatible calls also have path-exact delegated handling for `POST /<agent>/v1/chat/completions` and `GET /<agent>/v1/models`; both use HTTP Agent Assertions and target-scoped Router Requests rather than direct container access.

In addition to the surfaces above, the router reserves a set of internal, router-owned paths that are never proxied to an agent and never route-policy-controlled: `/policy/command`, `/auth/*`, `/admin/*`, `/metrics`, `/health/internal`, the router-level `/__agent/*`, and any agent-level `/<agent>/__agent/*` control-plane path (reached only by the router via a Router Request; transparent proxying strips caller-supplied identity headers). The router evaluates the HTTP route access policy (DS014) before transparent agent HTTP proxying and declared HTTP-service dispatch. Public decisions allow anonymous `GET`/`HEAD` only; guest decisions prefer an existing local or SSO user session and otherwise mint a scoped guest session; authenticated decisions require a user-authenticated route or static-agent auth policy.

Enabled agent manifests may also declare `routerAccess.httpRoutes`. The router expands each agent-relative declaration to `/<routeKey><path>` using the active route key or alias, then evaluates those declarations beside persisted `httpRoutes` and declared HTTP-service prefixes. Manifest entries require `path`; `access` may be omitted and then defaults to `authenticated`. When `access` is present it must be exactly `public`, `guest`, or `authenticated`; removed aliases are invalid and skipped for that agent. Public entries allow anonymous read-only access, guest entries ensure a guest or user session identity, and authenticated entries require a user-authenticated router session for every method. Authenticated entries prefer the owning route user-auth policy, fall back to the static route user-auth policy when the route is otherwise `none` or `guest`, and fail closed with `authenticated_http_route_auth_not_configured` if neither policy can authenticate a user. Guest auth mode and guest sessions do not satisfy authenticated route access. When entries overlap, the most restrictive access wins. Manifest declarations do not make internal `__agent` control-plane paths reachable. Because manifest paths are agent-relative before expansion, `/auth/...`, `/admin/...`, and `/metrics` inside a manifest are ordinary agent paths under `/<routeKey>/...`, not router-root reserved paths.

Agent-to-agent callers may access `/agent-card` and direct per-agent HTTP routes without router-level endpoint-specific logic; the target agent decides whether to accept or reject the request once proxying reaches it. Orchestrators can discover remote agents via `PloinkyAgentSkillsSubsystem` and include them as tools through `## Allowed Agents` declarations.

Agent MCP sessions are runtime-owned and ephemeral. Clients that finish with a session should send `DELETE /mcp` with the `mcp-session-id` header so the agent runtime can close the SDK transport immediately. The shared `AgentServer` must also reap idle sessions defensively for clients that disconnect without a delete, but it must treat any session with an open HTTP response as active so long-running tool calls and SSE streams are not closed by idle cleanup.

HTTP service routes must be declared by the target agent rather than hard-coded into router handlers. An enabled agent may provide `httpServices` entries with an external prefix, internal upstream prefix, and `access`, where the only valid values are `public`, `guest`, and `authenticated`. Retired service fields are invalid; an invalid service declaration is logged and that one service is not mounted. The router resolves valid declarations from the route table and agent manifest, then forwards matching requests to the owning agent route. Public service declarations intentionally run without router identity. Guest declarations follow the normal guest policy: an existing user-authenticated session takes precedence, otherwise the router mints a scoped guest session. Authenticated declarations must establish a user-authenticated router identity before proxying: the router prefers the owning route's user-auth policy, falls back to the static route's user-auth policy when the service-owning agent is otherwise unauthenticated or guest-authenticated, and rejects the request when no user-auth policy is available. Only authenticated service declarations may configure delegations, optionally with `when: { queryParam, pathRoots }`; the router normalizes the decoded query-parameter value and only mints that delegation when it is exactly the configured root or below it by path boundary. Authenticated and guest HTTP services receive a scoped `__http_service__` invocation token by default unless the manifest entry explicitly sets `invocation: false`. For routes that mint that token, the router buffers at most `PLOINKY_HTTP_SERVICE_INVOCATION_MAX_BODY_BYTES` bytes (default 10 MiB), hashes the exact request body bytes it forwards, and signs the HTTP request surface with `computeRchHttp({method, path, query, bodyHash})`. The signed `path` is the rewritten internal path the service actually receives, while `externalPath` remains route context in the auth-info payload. The auth-info payload carries method, signed path, external path, search string, route key, and the matching `bodyHash`. Oversized buffered bodies fail closed with `413 http_service_body_too_large` before the router proxies the request. Router-owned identity headers are stripped from caller input and regenerated by the router for authenticated or guest service requests. If a service route requests invocation minting but the owning route cannot be resolved to an installed-agent principal, the router fails the request closed instead of forwarding unsigned identity metadata.

The default workspace entry paths `/` and `/index.html` redirect to the configured static agent's routed `/<agent>/index.html` URL. The router does not read application assets from `static.hostPath`; the target agent server is responsible for serving `index.html` and related static resources from its own runtime code root. The shared `AgentServer` serves static files from `PLOINKY_CODE_DIR` or `/code` after its built-in API endpoints, while agents with custom `manifest.agent` commands must implement equivalent static serving themselves.

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

### Question #6: Why are manifest HTTP route declarations evaluated before the normal agent auth gate?

Response:
They are route-access declarations for transparent proxy paths, not service rewrites. Evaluating them before the normal auth gate lets an agent intentionally expose read-only content to anonymous callers or tighten selected paths under an otherwise unauthenticated route, while preserving the router-owned path checks and the regular route authentication fallback for anything not explicitly declared public.

### Question #7: Why is WebChat conversation state folder-scoped instead of tab-scoped?

Response:
The working directory is the durable project context shared by CLI agents, while a browser tab is transient. Folder-scoped JSON sessions let refreshes, later visits, and concurrent clients select the same conversation without agent-specific assumptions. `tabId` remains useful for client diagnostics and echo suppression, but it does not select history or own the target process.

### Question #8: Why does WebChat retain a disconnected runtime with ongoing tasks?

Response:
The target AgentServer owns the actual delegated process, but the selected chat CLI owns router-mediated polling and conversion of bounded task tails into workspace logs. Retaining that watcher while work remains ongoing preserves live diagnostics across a closed browser tab without making the browser or its `tabId` the task owner.

### Question #9: Why must the watchdog recheck maintenance state when a restart timer fires?

Response:
A restart timer can be scheduled immediately before an operator command acquires the container maintenance lock. Checking only when the timer is created leaves that already-scheduled callback free to recreate the same container concurrently with reinstall or explicit restart. Rechecking at execution time makes the scheduled callback defer to the active maintenance owner.

### Question #10: Why does persisted progress contain only strings and stay out of continuation context?

Response:
The progress `reason` is the only part of the envelope rendered as conversational
status. Persisting only that ordered string array keeps folder history compatible
and avoids turning transient tool metadata into a new message schema. Excluding
progress and empty placeholders from continuation context preserves the
distinction between the agent's final answer and UI-only execution status.

### Question #11: Why may WebChat retain a large argument catalog while progressively rendering its entries?

Response:
Keeping agent-provided completions in memory makes local filtering immediate and avoids another authenticated request for every keystroke. The fixed-height viewport keeps the composer compact, while bounded progressive DOM batches make every result reachable through the scrollbar and Arrow Up/Down without inserting the complete catalog into the document at once. Optional fragment matching still lets users narrow catalogs containing hundreds of entries without WebChat learning what those entries represent.

## Conclusion

Ploinky’s routed interface depends on a supervised router, a persisted route table, and stable prefixed browser surfaces. The implementation and the documentation must continue to describe those route families and their current fallback asset locations accurately.
