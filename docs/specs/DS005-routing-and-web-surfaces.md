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

For an agent whose manifest declares `startup: manual`, its route is also the durable activation marker used by watchdog monitoring. General startup removes the route of a stopped manual agent and the watchdog must ignore that registry entry. If the manual agent is already running, startup retains it and ensures its route. An explicit Marketplace enable or `ploinky cli` invocation recreates the route, after which the watchdog monitors and restarts the agent like any other active runtime. Agents with automatic startup remain watchdog targets without requiring this marker.

The router must provide first-party browser surfaces at `/webchat`, `/dashboard`, and `/status`. Each surface owns its own session cookie and fallback asset directory under `cli/server/<surface>/`. `/webchat` must rely on the router login flow and the authenticated router session; it does not accept surface-specific token login. `/dashboard` and the read-only `/status` surface continue to support dashboard-token access through `WEBDASHBOARD_TOKEN`. Asset resolution may also consult the static host root and `webLibs/`, but the documented fallback implementation for the first-party surfaces lives under `cli/server/`.

For `/webchat`, the router must treat `agent` as an explicit agent-selection query parameter and must preserve the remaining query parameters across the browser session endpoints. When a WebChat request selects an explicit agent, the router must forward every additional query parameter except router-reserved stream/session parameters such as `tabId` and `sessionId` to that agent's `ploinky cli <agent>` launch as long-form CLI flags encoded as single `--key=value` tokens. The router must not hardcode ordinary target-agent parameter names for this forwarding behavior; interpretation belongs to the target agent CLI. The reserved alias parameters `workspace-dir`/`workspaceDir` and `workspace-skill-root`/`workspaceSkillRoot` are resolved by WebChat against the Ploinky workspace root and forwarded as absolute `--dir=` and `--skill-root=` values server-side so browser URLs can avoid leaking absolute host paths. The `ploinky cli <agent>` launch path is expected to resolve the agent manifest from workspace repositories and auto-enable missing agents in the standard global enable flow when needed.

WebChat must remain a generic transport. It must not hardcode optional catalog agent ids, backend tags, MCP tool names, or domain-specific dispatch logic. Query parameters such as `feature-mode`, `forward-envelope`, or future agent-owned options are ordinary target-agent launch flags once they pass the router-reserved parameter filter. Their interpretation belongs to the selected agent CLI or to an explicitly configured downstream integration, not to Ploinky's router or WebChat handler.

When `/webchat` is launched with `forward-envelope=1`, messages may be written to the target TTY as the WebChat JSON envelope instead of plain text. The envelope may include sanitized attachment metadata, sanitized structured references (currently only `kind: "workspace-path"` records with `path`, `type`, and optional `label`), a sanitized public origin hint derived from the incoming WebChat request (`origin.publicBaseUrl`), and a short-lived router-minted invocation token scoped to the selected chat agent. It must not include conversation history: session persistence and one-time MainAgent hydration belong to the selected CLI. The public origin hint must be limited to an `http` or `https` origin. Reference paths must be workspace-relative; the server must drop entries containing absolute paths, traversal segments, NUL bytes, or reserved secret-file names before forwarding the envelope.

WebChat is a session presentation and transport surface, not the conversation owner. Ploinky must not create conversation files, a current-conversation pointer, or conversation REST routes. A compatible selected CLI may publish version-1 `__webchatSession` line envelopes with `current`, `list`, or `selected` events. `current` and `selected` carry a complete validated session snapshot plus selector summary; `list` carries the current id and bounded summaries. Ploinky must intercept these control lines before ordinary assistant rendering, retain only the latest non-list snapshot in runtime memory, expose them through the `session-state` EventSource event, and replay that snapshot to reconnecting subscribers. It must never persist the supplied conversation data.

The `Sessions` button must remain unavailable until the selected CLI advertises session state. Opening it sends `/session` to the CLI and renders the returned `list`; `New` sends `/session new`; selecting an existing entry sends `/session resume <session-id>`. A compatible structured command catalog may attach session-id argument completions to the `resume` subcommand; WebChat must render each completion's human-readable label while inserting its opaque value. These commands are control actions and must not be rendered as user turns. A `selected` response immediately replaces the browser transcript with the supplied session. The initial `current` response retains lazy history rendering: a non-empty snapshot presents `Click to load session history` as a centered standalone button, and clicking it renders the already received snapshot without a REST request.

WebChat's EventSource stream must tolerate brief browser reconnects without killing the target TTY. Runtime identity is the canonical working directory, selected agent, and launch configuration; conversation selection must not replace the TTY runtime. `tabId` identifies only a browser client and must be recovered from `sessionStorage` on refresh. A runtime may have multiple SSE subscribers and remains alive for the bounded reconnect grace window after the last subscriber leaves. The latest session-state, runtime-state, and pending-interaction snapshots are replayed after reconnect.

Runtime reuse must be conditional on TTY health. A runtime whose child has exited, whose stdin is no longer writable, or whose write operation fails must be disposed and removed from the workspace runtime map. `POST /webchat/input` must write to the selected CLI before broadcasting the optimistic user-message event and must return `409` rather than `204` when delivery fails. A later EventSource reconnect must create a replacement process while preserving the workspace-and-agent runtime identity for healthy processes.

WebChat may accept a generic `__webchatRuntimeState` line envelope from the selected CLI. Version 1 carries only an optional selected `model` string or `null`; the envelope must be intercepted before ordinary assistant output and exposed through the `runtime-state` EventSource event. The current runtime-state snapshot remains memory-only and is sent to reconnecting subscribers. The header may show a non-empty model beside the selected agent name and must hide the badge when the model is `null`. Ploinky must not read an agent-owned settings file, infer an effective provider model, or use a process-instance identifier to coordinate conversation restoration.

The `Tasks` and `Sessions` controls in the WebChat header must use a darker green hover fill that remains visually consistent with the green header, rather than inheriting the theme's neutral panel-hover color.

The selected CLI must restore its own conversation state whenever its process starts. Ploinky must not deliver role-separated history, delimited continuation text, a selected conversation id, or a `PLOINKY_WEBCHAT_HAS_HISTORY` environment flag. Slash commands and natural-language prompts travel over the same TTY, while the selected CLI decides which inputs are conversational and when stored history is supplied to its agent implementation.

WebChat must provide a generic composer autocomplete surface driven by trigger providers. The composer controller owns menu lifecycle, keyboard navigation (Arrow Up/Down, Enter, Tab, Escape), pointer selection, grouped rendering, positioning, and insertion. Arrow Up/Down navigation must keep the active option inside the visible viewport of the scrollable menu. Trigger providers supply suggestions:

- `/` opens the slash-command provider only when it is the first composer character. Later `/` characters are ordinary command-argument text, including provider-qualified model names. The client queries the selected agent's MCP endpoint (`/<agent>/mcp`) for available tools and sends the Streamable HTTP media contract `Accept: application/json, text/event-stream` on initialization and subsequent MCP requests. When the agent advertises a structured slash-command catalog tool, the provider uses that catalog and may send preserved launch query parameters such as `dir`; otherwise it maps `execute_<skill>` tool names to slash commands. Structured catalogs may declare subcommands, generic argument completions, a generic argument match mode, and a positive per-command result limit without WebChat hardcoding agent-specific command names. Prefix matching remains the default; an agent may request fragment matching for large searchable catalogs. When the agent does not limit results, WebChat keeps every match accessible but progressively adds bounded result batches to the fixed-height scrollable menu as keyboard or pointer navigation approaches the rendered boundary. The initial catalog load must tolerate a selected agent that is still starting: transient transport, readiness, or protocol failures trigger one deduplicated retry sequence with short backoff delays for approximately 30 seconds. A successful catalog, including a valid empty catalog, or an explicit access denial ends the sequence immediately. Typing `/` reads the in-memory catalog and must not start another MCP request. If the bounded initial sequence finishes without a catalog, the slash group remains silent until the page is reloaded.
- `@` opens the workspace-paths provider only. The provider preserves the WebChat launch query when it requests `/webchat/suggestions/files`, so the router resolves the same workspace-confined working directory supplied through `dir`, `workspace-dir`, or `workspaceDir`, with the workspace root as fallback. It shows at most 30 immediate children of the active folder under a `Files and folders` group. Text typed after `@` must continue to request and filter the active folder case-insensitively even when responses for older fragments arrive later. Selecting a folder inserts a cwd-relative token such as `@reports/` and drills into it. Selecting a file inserts a token such as `@reports/summary.md`, records a structured `workspace-path` reference on the outgoing envelope, and closes autocomplete so the next unmodified Enter submits the message. A space typed after a folder token terminates that token and closes autocomplete; moving the caret before that separator may reactivate autocomplete for the path fragment at the caret.
Selected workspace-path tokens should be visually emphasized in the composer and in rendered user messages when their structured reference metadata is available, while preserving the plain textarea value submitted to the selected chat agent.

Assistant messages must enhance recognizable workspace file paths after Markdown
rendering without modifying the raw message supplied by the selected CLI.
Detection must cover cwd-relative paths with supported
document, text, source, image, PDF, or HTML extensions. Inline-code paths may
contain spaces, while fenced code blocks, external links, URLs, traversal paths,
and host-absolute paths must not be rewritten. Existing relative Markdown file
links may be normalized to the same preview route. The browser must prefix
cwd-relative candidates with the WebChat working directory's workspace-relative
base and point them at the existing authenticated `/workspace-files/...` route.
Explicit `/workspace-files/...` links remain workspace-root-relative and must not
receive the cwd prefix a second time. Clicking a detected path must open the side
panel: Markdown uses the existing Markdown renderer, text and source content use
an escaped code view, images use an image preview, PDFs use the browser viewer,
and HTML uses a sandboxed iframe. Unknown binary types must not trigger a download
from an automatically detected path.

WebChat must not hardcode optional agent ids, backend tags, or agent-owned tool names for `@` suggestions. It must not offer an `Agents` suggestion group or highlight arbitrary `@word` tokens as provider mentions. Unknown `@word` mentions remain ordinary chat text; semantic provider routing, if any, belongs to the selected chat agent after it receives the message envelope.

Ploinky must not add a research-specific enable command or WebChat availability toggle for optional provider agents. From the framework's perspective, a provider becomes selectable only when the selected chat agent exposes a launcher skill or equivalent agent-owned command for it. Backend health checks and unavailable messages belong to that launcher or downstream relay, not to Ploinky's command registry, composer, or router.

WebChat must expose `GET /webchat/suggestions/files` for the workspace-paths provider. The endpoint must require the same authenticated browser session as the surface and resolve a workspace-confined working directory from the same launch parameters used for `--dir` forwarding (`workspace-dir`/`workspaceDir`, with alias support for confined `dir`, falling back to the workspace root). The `query` parameter is a cwd-relative folder and leaf fragment: the endpoint lists only immediate children of that folder, applies case-insensitive fragment filtering to the leaf, caps results at 30, and sorts stronger matches first with directories before files at the same match rank. Result `displayPath`, `relativePath`, `queryPath`, and `path` values must be relative to the resolved WebChat working directory; `workspacePath` must be relative to the workspace root. The endpoint must reject absolute caller paths, traversal (`..`), NUL bytes, symlink escapes outside the resolved working directory, Ploinky runtime state, dependency directories, and reserved secret files such as `.secrets` and `*.secrets`. Host absolute paths must never appear in the response.

WebChat must also expose authenticated upload routes scoped to the same session upload directory:

- `POST /webchat/uploads` — accepts the request body as raw file bytes and writes the result to `<cwd>/uploads/<sessionId>/<relativePath>`. Required request metadata: `X-File-Name` carries the original display filename, `X-Relative-Path` carries an optional browser-supplied relative path (used for folder uploads via `webkitdirectory`), and `X-Mime-Type` carries the MIME type. Missing `X-Relative-Path` falls back to the sanitized filename. Existing files are stored without overwrite by appending a deterministic ` (n)` suffix to the leaf name. The JSON response contains `ok`, `filename`, `relativePath` (relative to the session upload root), `localPath` (relative to the WebChat working directory, e.g. `uploads/<sessionId>/<relativePath>`), `workspacePath` (relative to the workspace root), `downloadUrl` (the `/webchat/uploads?path=...` route), `size`, and `mime`. Host absolute paths must never appear in the response.
- `GET /webchat/uploads?path=<session-relative-path>` and `HEAD /webchat/uploads?path=<session-relative-path>` — stream the previously uploaded file. The `path` query parameter is relative to the session upload root and must use the same sanitization rules as upload writes. Responses set `Content-Type` from stored MIME metadata, `X-Content-Type-Options: nosniff`, and support `Range` for byte-range reads. MIME metadata is stored under the same working directory's `uploads/.webchat-upload-metadata/<sessionId>/` metadata area rather than inside the user-visible session upload tree.

The session upload directory is a per-session UX convenience scope. It must not be relied on as a security boundary between hostile sessions; the operator-controlled workspace trust model from DS011 still applies.

WebChat must also expose a Cancel button during active agent processing. The Cancel button sends a raw control sequence (ESC, `\x1b`) to the agent's TTY session via a dedicated `/webchat/control` endpoint. The agent must interpret this as an interrupt signal and abort the current operation. The Cancel button replaces the Send button while processing is active and reverts when the agent produces output or the session closes.

WebChat may receive a generic `__webchatInteraction` line envelope from the selected CLI while a turn is running. Version 1 carries a unique interaction id, a kind, bounded title/message/detail text, an ordered list of option ids and labels, and one default option id. The runtime must intercept valid envelopes before transcript rendering, retain only the currently pending interaction in memory, emit it as a named `interaction-request` SSE event, and replay the pending snapshot after EventSource reconnect. A matching `__webchatInteractionResolved` envelope clears that volatile state and emits `interaction-resolved`.

While an interaction is active, the browser must disable ordinary prompt submission and show a dedicated choice selector above the composer. Arrow Up/Down moves through the agent-declared order with wrapping, Enter submits the selected option, and pointer selection submits the clicked option. The default choice must be selected on first render. The selector is control UI: its text and response must not become chat messages.

The browser submits the decision to authenticated `POST /webchat/interaction` with the active tab id, interaction id, and option id. The route must require an active subscriber for the same authenticated runtime, reject unknown or stale interactions and undeclared options, and write a structured interaction response to the selected CLI's TTY. The first valid response clears the browser-visible pending state; later responses for that interaction are rejected and cannot cause duplicate execution. Ploinky transports declared choices generically and must not assign semantics to option ids such as approval or denial.

WebChat may receive structured progress metadata from chat agents through the
same stdout/SSE stream. Ploinky must render a valid `__webchatProgress` envelope
as live status but must not persist it. A session-owning CLI may include the
ordered progress strings in its later `__webchatSession` snapshot, allowing the
browser to render them as a collapsible block above the final answer after
history is loaded. Progress remains UI metadata rather than assistant text.

WebChat may also receive generic `__webchatTask` lifecycle envelopes from a selected CLI. These envelopes must be intercepted before conversation rendering. Ploinky must store workspace-scoped task metadata as append-only JSON lines in `<cwd>/.copilot_history/agent_tasks`, store per-task logs separately under `.copilot_history/task_logs/`, and expose authenticated `GET /webchat/tasks`, `GET /webchat/tasks/<task-id>/log`, and `GET /webchat/tasks/<task-id>/view` routes. Logs are bounded by default; an asynchronous tool may explicitly declare full retention for tasks whose complete multi-turn transcript must survive. Browser updates must use the existing EventSource stream with a `task-update` event; Ploinky must not hardcode target-agent ids or tool names.

An asynchronous tool may advertise a generic continuation tool. Its structured
result may return a versioned opaque continuation handle even when execution
fails after the provider session was created. Ploinky stores that handle with
the target agent and tool name in the task record. A completed or failed task
carrying that capability must show a message input in its authenticated task
view. `POST /webchat/tasks/<task-id>/continue` invokes only
the stored target and stored tool with that opaque handle and the new message,
through normal MCP policy evaluation and a newly minted request-bound Router
Request; it must never forward the browser session token to the target agent.
The continuation input must submit on unmodified Enter, preserve a newline on
Ctrl/Cmd+Enter or Shift+Enter, disable manual textarea resizing, and grow
upward with its content to the same bounded height as the main WebChat
composer. Beyond that height its own content must scroll, and deleting content
must shrink it again.
The provider invocation creates a new remote AgentServer task, but WebChat must
retain the exact same local `taskId`, increment its positive `turn`, replace its
current `remoteTaskId`, set the task back to `ongoing`, and append subsequent
logs to the same task log. Late lifecycle events from an older turn or remote
task id must not overwrite the current turn. The original task description and
creation time remain stable, while `executionStartedAt` tracks the current turn.
The task view may poll an authenticated refresh route while the continued turn
is active; parent-stream updates remain the normal live path. If the stored
agent is installed but has no ready route, including after a general restart
left a `startup: manual` provider stopped, the task route must activate that
exact agent in global mode through Ploinky's internal enable lifecycle, publish
its route, and wait for readiness before invoking or polling it. Concurrent
requests for the same provider must share one activation. Startup or readiness
failure must remain explicit instead of changing the local task identity or
silently selecting another provider.

The session-owning CLI is responsible for inserting a task reference immediately
after the active assistant placeholder and may include the resulting session id
and task-item index on the first `started` envelope. Ploinky forwards that
correlation on the EventSource event without altering conversation state or
duplicating it in the task journal. The browser must render every task item as its own compact
incoming-style chat item. Its first row must show the exact target-agent id,
description, status, and elapsed whole seconds, and its second row must expose a
`View task details` link without inline expansion controls or logs. The browser
must recover the same item after history loading by resolving its `taskId`
against the task route. A live task
item may appear before final assistant text arrives; indexed insertion must
still produce the stable history order `user -> assistant -> task items`. The
item remains available after terminal completion; a missing task record renders
as unavailable. Task items are UI references and must not enter
the continuation context. Legacy assistant-message `taskId` properties are
ignored rather than rendered or migrated.

The task link must use WebChat's generic side-panel link mechanism to open the
authenticated task view. That page must reproduce the task header, error, and
live-log presentation previously available in the expanded chat item. It must
load its initial task and log state through the authenticated task APIs, then
receive updates for the active task from the parent WebChat page through a
same-origin `postMessage` bridge fed by the parent's existing EventSource. It
must not open another EventSource or create a task-specific live transport.
Missing log offsets must be recovered through the existing log route. Direct
navigation may show the current authenticated snapshot without a parent live
bridge.

The task page must expose a direct `Stop` action while the current remote task
is queued or running. The authenticated WebChat route resolves the already
stored target agent and remote task id; it must not accept either value from the
browser, silently choose another provider, or activate an unavailable agent.
It sends a request-bound Router Request to the target AgentServer
`POST /task/cancel` surface. Queued work becomes `cancelled` without starting.
Running work first becomes `cancelling`, receives graceful termination, and is
force-terminated after a two-second cleanup grace period if it has not exited.
Repeated stop requests and requests against terminal work are idempotent. The
local task remains `ongoing` while remote cleanup is in progress and becomes
`stopped` when the remote task reports `cancelled`.

Cancellation never creates a replacement WebChat task. If a running provider
created and persisted a continuation handle before it stopped, the same local
task remains continuable: a later message increments its turn and starts a new
remote execution exactly as failed-task continuation does. A queued task
cancelled before provider execution has no provider session and therefore no
continuation input. The continuation field is capability-driven, not granted
merely because a task has `stopped` status.

The generic side panel used by task views and every other delegated link must
remain vertically bounded above WebChat's floating composer. Its available
height must follow the composer height dynamically when the textarea expands
or attachment previews appear. The panel header remains fixed within that
bounded region, while its content area and embedded iframe use the remaining
height and provide their own scrolling instead of extending underneath the
composer.

The Tasks overlay, compact task item, and task view must share one presentation policy.
Pending work is shown as `QUEUED`, active work as `RUNNING`, and terminal states
as `COMPLETED`, `STOPPED`, or `FAILED`. Raw task log files remain unchanged and
are written only by task-event ingestion. The terminal task envelope may carry
the final MCP result as presentation metadata, but ingestion must never append
or duplicate that result in the log. Instead, it locates the last identical
range already present in the persisted raw log and stores only its offset and
length in `agent_tasks`. Continuation clears that range until the next terminal
result. The Tasks overlay and task view render log lines outside the range with
the secondary grey text color and lines intersecting it with the primary text
color, so intermediate provider activity remains visibly distinct from the
final answer. If no exact range is available, the raw output remains visible
with the intermediate style. Browser rendering strips ANSI control sequences
and retains presentation compatibility for historical logs that contain
recognized stream and runner prefixes; new raw provider output remains
otherwise unchanged.

When a WebChat runtime has no SSE subscribers but owns a task whose materialized state is `ongoing`, reconnect cleanup must retain that runtime so its agent can continue router-mediated polling and log collection. Once its tasks become terminal, the normal reconnect grace and disposal behavior resumes. If the runtime is recreated after a wider process restart, the selected CLI may reattach from the workspace task journal. Initial task identity is derived from target agent and remote task id; after continuation, the stable local task id plus its monotonically increasing turn select the current remote task. A PID is optional diagnostics only.

The router must also expose:

- `/health` for health status.
- `/api/marketplace` for the first-party agent marketplace. This route is router-owned and returns JSON rather than proxied agent content. Browser callers use the existing local or SSO session: authenticated users may read Marketplace state, non-admin clients use the returned permissions to hide management controls, and only an authenticated local administrator may perform the full `install_repo`, `uninstall_repo`, `enable_agent`, and `disable_agent` action set. An already-running Ploinky agent may also call the same endpoint with a request-bound Agent Assertion targeted at `ploinky-router`: `GET` uses the synthetic tool `marketplace.read`, while `POST` is restricted to `enable_agent` and uses `marketplace.enable_agent`. Agent assertions must be bound to the exact method, path, query, and raw body, and must be replay-protected. Agent callers cannot install repositories, uninstall repositories, disable agents, or gain browser admin permissions. The read response reports the caller-facing Marketplace state, predefined repositories, installed repositories, remembered repository sources, repository kind, discoverable agents, enabled-agent registry state, and runtime status derived from live Ploinky containers. Repository installation must require a URL, accept an optional name and branch, clone the checkout, and record source metadata including repository kind. Repository uninstall must match the CLI repository contract: it disables enabled agents that came from that repository by container key, removes their runtime containers through the normal disable helper, preserves agent work directories, removes the installed repository checkout, and preserves the source metadata so the repository remains available for reinstall in the correct Marketplace repo category. Agent enablement must use the standard enable path. Agent disablement is marketplace-specific: the route removes the enabled-agent registry record before removing the agent runtime with the normal container removal helper, so the watchdog container monitor does not restart the runtime while the admin operation is in progress. This marketplace behavior must not change the conservative direct `ploinky disable agent` CLI contract, which still refuses to remove records while runtime state exists.
- `/upload` and `/blobs` for workspace and agent blob flows.
- `/workspace-files/...` for authenticated, workspace-confined file reads owned
  by the router. Responses must derive `Content-Type` from the file extension,
  attach UTF-8 charsets to supported text formats, set
  `Content-Disposition: inline`, and set `X-Content-Type-Options: nosniff` so
  WebChat can preview content without an automatic download.
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

### Question #7: Why is WebChat conversation state agent-owned instead of tab-scoped?

Response:
The selected CLI must provide the same session behavior when launched directly, while a browser tab is transient. Agent-owned sessions let CLI and WebChat launches restore the same conversation without giving the router a second persistence implementation. `tabId` remains useful for subscriber ownership and remote-user rendering, but it does not select history or own the target process.

### Question #8: Why does WebChat retain a disconnected runtime with ongoing tasks?

Response:
The target AgentServer owns the actual delegated process, but the selected chat CLI owns router-mediated polling and conversion of bounded task tails into workspace logs. Retaining that watcher while work remains ongoing preserves live diagnostics across a closed browser tab without making the browser or its `tabId` the task owner.

### Question #9: Why must the watchdog recheck maintenance state when a restart timer fires?

Response:
A restart timer can be scheduled immediately before an operator command acquires the container maintenance lock. Checking only when the timer is created leaves that already-scheduled callback free to recreate the same container concurrently with reinstall or explicit restart. Rechecking at execution time makes the scheduled callback defer to the active maintenance owner.

### Question #10: Why does WebChat treat progress as agent-owned session metadata?

Response:
The progress `reason` is the only part of the envelope rendered as conversational
status. Ploinky renders it live without creating durable conversation state. A
session-owning CLI can preserve the ordered strings in its own snapshot while
excluding them from MainAgent hydration, keeping final answers distinct from
UI-only execution status.

### Question #11: Why may WebChat retain a large argument catalog while progressively rendering its entries?

Response:
Keeping agent-provided completions in memory makes local filtering immediate and avoids another authenticated request for every keystroke. The fixed-height viewport keeps the composer compact, while bounded progressive DOM batches make every result reachable through the scrollbar and Arrow Up/Down without inserting the complete catalog into the document at once. Optional fragment matching still lets users narrow catalogs containing hundreds of entries without WebChat learning what those entries represent.

### Question #12: Why does the selected model reach the header through runtime state instead of session history or direct settings access?

Response:
The selected CLI owns the meaning and persistence of its model setting, while Ploinky owns only the generic browser transport. A volatile runtime-state envelope lets any compatible agent publish current UI metadata without extending the conversation schema or coupling WebChat to an agent-specific path. Retaining the latest state in the live runtime also restores the header after a brief EventSource reconnect without claiming that the value describes the effective model used for every response.

### Question #13: Why may an agent enable another agent through Marketplace?

Response:
Optional workers must remain outside the root manifest dependency graph or they are recursively started with the primary application. Reusing the existing Marketplace enable action gives launchers one lifecycle path instead of a second startup implementation. The agent assertion is deliberately limited to state reads and installed-agent enablement, bound to the exact request, and replay-protected; repository changes, disablement, and browser administrator authority remain unavailable.

### Question #14: Why is each background task a separate conversation item?

Response:
A single assistant turn may start several independent tasks, so one `taskId` on
the assistant message cannot represent the complete result. Dedicated reference
items preserve every task and its start order without duplicating task state or
logs in conversation history. They also keep assistant text semantically clean
while letting the browser render task progress immediately and later place final
assistant output before the already visible task items.

### Question #15: Why does a manual agent route act as an activation marker?

Response:
The enabled-agent registry describes installed workspace intent and must survive periods when an optional worker is stopped. Routing state already identifies runtimes that were explicitly made reachable. Reusing that state lets the watchdog distinguish an intentionally dormant manual agent from an explicitly activated one without adding a second lifecycle store.

### Question #16: Why is ordinary text equality insufficient for WebChat echo detection?

Response:
An agent may legitimately answer with the same text the user submitted. Treating
that equality as terminal echo evidence discards a valid assistant response and
leaves the browser waiting on an empty placeholder. Echo suppression therefore
uses explicit transport markers, including WebChat envelopes and the `you>`
readline prompt, rather than conversational text equality.

### Question #17: Why does the task view reuse the parent WebChat stream instead of opening its own EventSource?

Response:
The parent WebChat runtime already receives every `task-update` event and owns
the selected CLI lifecycle. Opening the general WebChat stream from the task
view could create or retain another runtime merely to inspect logs. Forwarding
only the active task through a same-origin `postMessage` bridge preserves one
live transport, while the authenticated task and log routes provide initial
state and offset-gap recovery.

### Question #18: Why are `@` path suggestions rooted at the WebChat working directory?

Response:
The launch `dir` is already the generic working-directory contract shared by
WebChat and the selected CLI. Returning paths relative to that directory lets
any compatible agent resolve the same reference without learning a host
absolute path or requiring an agent-specific prefix. Immediate-folder listing
with explicit drill-down keeps lookup bounded and makes a plain token such as
`@src/index.js` unambiguous once WebChat records its structured
`workspace-path` reference.

### Question #19: Why does continuation increment `turn` instead of creating another local task?

Response:
The user is continuing one piece of work and expects its title, history, and
logs to remain together. AgentServer still needs a new remote execution record
for each asynchronous invocation, so `turn` separates those executions without
changing the WebChat identity. Binding updates to both turn and current remote
task id also prevents a delayed poll from the prior execution from regressing
the continued task.

### Question #20: Why may task continuation activate a manual provider?

Response:
The continuation handle is already bound to one installed provider, while a
general workspace restart intentionally leaves unrelated `startup: manual`
agents stopped and removes their routes. Treating the user's continuation
request as explicit activation restores that exact provider through the normal
global enable lifecycle. Deduplicating activation and waiting for readiness
avoid duplicate starts and immediate calls to an MCP server that is not ready.

### Question #21: Why does a WebChat interaction use a dedicated endpoint and SSE events?

Response:
An interaction response controls an already running CLI request and is not a new user prompt. A dedicated authenticated endpoint can bind it to the active tab, runtime, request id, and declared option, while named SSE events keep the transient selector out of conversation history and allow it to recover after a transport reconnect.

### Question #22: Why does assistant file-link enhancement reuse `/workspace-files` without pre-validating every candidate?

Response:
The assistant may describe files using several ordinary textual forms, and the
browser can recognize those forms without changing the conversation schema or
making a request during every streaming update. Reusing the authenticated
router-owned file route keeps canonical path validation at the read boundary. A
syntactic false positive therefore becomes at most a failed preview after an
explicit user click, while the agent receives no additional filesystem
capability and the stored assistant text remains unchanged.

### Question #23: Why does the selected CLI own conversation restoration?

Response:
The CLI can also run directly without WebChat and is the only component that knows how to recreate its agent session safely. Keeping persistence and one-time hydration there gives terminal and browser launches identical semantics. WebChat only transports prompts and validated session-state snapshots, so a browser reconnect cannot accidentally replay history or become a second source of truth.

### Question #24: Why does WebChat verify delivery before broadcasting input acceptance?

Response:
A successful HTTP response and server-originated user-message event tell connected browsers that the selected CLI accepted the prompt. Returning success after writing to a closed or detached stdin leaves the interface waiting for output that cannot exist. Health-aware writes make that acknowledgement truthful, remove the stale runtime immediately, and let the existing EventSource reconnect create a fresh CLI process without changing conversation ownership.

## Conclusion

Ploinky’s routed interface depends on a supervised router, a persisted route table, and stable prefixed browser surfaces. The implementation and the documentation must continue to describe those route families and their current fallback asset locations accurately.
