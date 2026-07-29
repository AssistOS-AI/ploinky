---
id: DS005
title: Routing and Web Surfaces
status: implemented
owner: ploinky-team
summary: Defines dual-listener RoutingServer, host-first closed surfaces, immutable route-and-policy generations, HTTP-service targets, private assertions, topology, and browser surfaces.
---

# DS005 Routing and Web Surfaces

## Introduction

The routed interface is the operator-visible face of a running Ploinky workspace. This document defines the responsibilities of the watchdog, the router, the route table, and the prefixed browser surfaces.

## Core Content

The router must be supervised by `cli/server/Watchdog.js`, which launches and
restarts `cli/server/RoutingServer.js`, records restart events, checks detailed
health through an unmounted supervisor Unix socket, and writes watchdog logs
under `.ploinky/logs/watchdog.log`. The router itself must write redacted request
and lifecycle logs under `.ploinky/logs/router.log`.

RoutingServer owns a public/control listener on box port `8080` and a private
listener on `8081`. The outer box maps only the former to a loopback
physical-host port. Inside a marked Box, `8081` binds the Box namespace wildcard
so nested rootless Podman can reach it through the fixed
`host.containers.internal:host-gateway` address contract. Outside a marked Box,
the private listener retains the exact loopback/managed-address bind model. An
exact-capability host-mode runtime can use private box loopback, but network
reachability never replaces policy, assertion, or caller-ACL checks. Private
`8081` is never a physical-host or Cloudflare route, and detailed health is not available over
either TCP listener.

`.ploinky/routing.json`, manifests, and policy files are candidate inputs. They
have no live authorization effect until one coordinator inactivates affected
selectors, captures and digests their exact bytes, validates the complete
route-and-policy candidate, and atomically installs an immutable generation.
Unreadable or corrupt input, a digest mismatch, an interrupted apply, and an
invalid candidate leave the selectors inactive; no prior generation is restored
as a fallback. A missing policy, desired-state, enabled-agent, routing, manifest,
or provider source is unavailable input and is never substituted with an empty
document. A genuinely fresh core command initializes the four persisted source
documents together after creating the workspace directories and before bootstrap
or registry mutation; generic environment setup does not create `agents.json`
independently. Any partial set or retained generation evidence requires explicit
repair. Status exposes generation identity and digest, never source contents.

The core `list routes` command reports the staged `.ploinky/routing.json`
candidate for operator inspection; it does not prove or print the active
immutable generation. Workspace lifecycle operations alone invoke the internal
coordinator that validates candidate state and installs a generation; there is
no public edge-mutation command.

`ploinky reinstall <agent>` creates new private targets and coordinates a new
generation before acknowledging the change. HTTP, SSE, and WebSocket requests
capture one route plan and authorization lease, then revalidate that generation
immediately before opening the upstream connection. A superseded lease returns
`503` without dialing or sending request bytes.

The watchdog container monitor must defer automatic container restarts while a maintenance lock is active for the same container. It must check the lock both when deciding to schedule a restart and immediately before executing a previously scheduled restart, because a reinstall or explicit restart may acquire the lock after the watchdog timer was created. A deferred timer must release the monitor's in-progress restart state so later ticks can reevaluate the live container after maintenance completes.

For an agent whose manifest declares `startup: manual`, its route is also the durable activation marker used by watchdog monitoring. General startup removes the route of a stopped manual agent and the watchdog must ignore that registry entry. If the manual agent is already running, startup retains it and ensures its route. An explicit Marketplace enable or `ploinky cli` invocation recreates the route, after which the watchdog monitors and restarts the agent like any other active runtime. Agents with automatic startup remain watchdog targets without requiring this marker.

The router must provide first-party browser surfaces at `/webchat`, `/dashboard`, and `/status`. Their fallback asset directories live under `cli/server/<surface>/`. `/webchat` relies on the router login flow and the authenticated router session; it does not accept surface-specific token login. `/dashboard` and `/status` are local control surfaces and require a real authenticated local-admin session on an allowed control Host. They do not accept an invitation, component token, Agent Assertion, Router Request, private assertion, LiveKit JWT, or localhost provenance as administrator identity. Every control mutation additionally requires the exact browser Origin and a session-bound CSRF proof. For sliding local sessions, this proof binds to the signed stable session `sid`, not the rotating JWT bytes, so concurrent authenticated reads cannot invalidate a proof while logout and session revocation still do. Dashboard mutations use this stricter control-surface guard directly rather than the route-generation mutation guard used by policy-routed browser endpoints; the control Host has no policy route plan to commit. Asset resolution may also consult the static host root and `webLibs/`, but the documented fallback implementation for the first-party surfaces lives under `cli/server/`.

For `/webchat`, the router must treat `agent` as an explicit agent-selection query parameter and must preserve the remaining query parameters across the browser session endpoints. When a WebChat request selects an explicit agent, the router must forward every additional query parameter except router-reserved stream/session parameters such as `tabId` and `sessionId` to that agent's `ploinky cli <agent>` launch as long-form CLI flags encoded as single `--key=value` tokens. The router must not hardcode ordinary target-agent parameter names for this forwarding behavior; interpretation belongs to the target agent CLI. The reserved alias parameters `workspace-dir`/`workspaceDir` and `workspace-skill-root`/`workspaceSkillRoot` are resolved by WebChat against the Ploinky workspace root and forwarded as absolute `--dir=` and `--skill-root=` values server-side so browser URLs can avoid leaking absolute host paths. The `ploinky cli <agent>` launch path is expected to resolve the agent manifest from workspace repositories and auto-enable missing agents in the standard global enable flow when needed.

WebChat must remain a generic transport. It must not hardcode optional catalog agent ids, backend tags, MCP tool names, or domain-specific dispatch logic. Query parameters such as `feature-mode`, `forward-envelope`, or future agent-owned options are ordinary target-agent launch flags once they pass the router-reserved parameter filter. Their interpretation belongs to the selected agent CLI or to an explicitly configured downstream integration, not to Ploinky's router or WebChat handler.

When `/webchat` is launched with `forward-envelope=1`, messages may be written to the target TTY as the WebChat JSON envelope instead of plain text. The envelope may include sanitized attachment metadata, sanitized structured references (currently only `kind: "workspace-path"` records with `path`, `type`, and optional `label`), a sanitized public origin hint derived from the incoming WebChat request (`origin.publicBaseUrl`), a sanitized `presentation.visible` boolean, and a short-lived router-minted invocation token scoped to the selected chat agent. It must not include conversation history: session persistence and one-time MainAgent hydration belong to the selected CLI. The public origin hint must be limited to an `http` or `https` origin. Reference paths must be workspace-relative; the server must drop entries containing absolute paths, traversal segments, NUL bytes, or reserved secret-file names before forwarding the envelope.

WebChat is a session presentation and transport surface, not the conversation owner. Ploinky must not create conversation files, a current-conversation pointer, or conversation REST routes. A compatible selected CLI may publish version-1 `__webchatSession` line envelopes with `current`, `list`, or `selected` events. `current` and `selected` carry a complete validated session snapshot plus selector summary; `list` carries the current id and bounded summaries. Ploinky must intercept these control lines before ordinary assistant rendering, retain only the latest non-list snapshot in runtime memory, expose them through the `session-state` EventSource event, and replay that snapshot to reconnecting subscribers. It must never persist the supplied conversation data.

The `Sessions` button must remain unavailable until the selected CLI advertises session state. Opening it sends `/session` to the CLI and renders the returned `list`; `New` sends `/session new`; selecting an existing entry sends `/session resume <session-id>`. A compatible structured command catalog may attach session-id argument completions to the `resume` subcommand; WebChat must render each completion's human-readable label while inserting its opaque value. These button-originated commands are silent control actions and must not be rendered as user turns. A `selected` response immediately replaces the browser transcript with the supplied session. The initial `current` response retains lazy history rendering: a non-empty snapshot presents `Click to load session history` as a centered standalone button, and clicking it renders the already received snapshot without a REST request.

WebChat's EventSource stream must tolerate brief browser reconnects without killing the target TTY. Runtime identity is the canonical working directory, selected agent, and launch configuration; conversation selection must not replace the TTY runtime. `tabId` identifies only a browser client and must be recovered from `sessionStorage` on refresh. A runtime may have multiple SSE subscribers and remains alive for the bounded reconnect grace window after the last subscriber leaves. The latest session-state, runtime-state, and pending-interaction snapshots are replayed after reconnect.

Runtime reuse must be conditional on TTY health. A runtime whose child has exited, whose stdin is no longer writable, or whose write operation fails must be disposed and removed from the workspace runtime map. `POST /webchat/input` must write to the selected CLI before broadcasting the optimistic user-message event and must return `409` rather than `204` when delivery fails. A later EventSource reconnect must create a replacement process while preserving the workspace-and-agent runtime identity for healthy processes.

WebChat may accept a generic `__webchatRuntimeState` line envelope from the selected CLI. Version 1 carries only an optional selected `model` string or `null`; the envelope must be intercepted before ordinary assistant output and exposed through the `runtime-state` EventSource event. The current runtime-state snapshot remains memory-only and is sent to reconnecting subscribers. The header may show a non-empty model beside the selected agent name and must hide the badge when the model is `null`. Ploinky must not read an agent-owned settings file, infer an effective provider model, or use a process-instance identifier to coordinate conversation restoration.

At normal desktop widths, the WebChat header must retain its established visible
`Tasks`, `Sessions`, three-dot settings, and `Logout` controls. At widths of 640
CSS pixels or less, `Tasks`, `Sessions`, and `Logout` must move into the
three-dot overflow menu so the selected agent name, current model, working
directory, and connection state remain visible. Returning above that breakpoint
must restore the controls to their original header order without duplicating
them or replacing their event-bound elements. The menu must open on desktop and
mobile, close after a mobile action, close on outside pointer interaction or
Escape, and expose its expanded state through ARIA. At mobile widths the agent
and model remain on the first metadata row, while connection state and the
ellipsized working directory remain visible on the second row. At desktop
widths the working directory must retain its original horizontal and vertical
center position inside the header, with a bounded width and ellipsis preventing
it from escaping the header. The mobile layout must return it to normal flow.

The selected CLI must restore its own conversation state whenever its process starts. Ploinky must not deliver role-separated history, delimited continuation text, a selected conversation id, or a `PLOINKY_WEBCHAT_HAS_HISTORY` environment flag. Slash commands and natural-language prompts travel over the same TTY. Composer submissions default to `presentation.visible: true`, while WebChat-owned control actions use `false`. An invisible control command and its textual acknowledgement or error must not render in the main transcript. The selected CLI decides which visible inputs and outputs enter its presentation transcript and which stored records are supplied to its agent implementation; Ploinky never writes that transcript.

WebChat must provide a generic composer autocomplete surface driven by trigger providers. The composer controller owns menu lifecycle, keyboard navigation (Arrow Up/Down, Enter, Tab, Escape), pointer selection, grouped rendering, positioning, and insertion. Arrow Up/Down navigation must keep the active option inside the visible viewport of the scrollable menu. Trigger providers supply suggestions:

- `/` opens the slash-command provider only when it is the first composer character. Later `/` characters are ordinary command-argument text, including provider-qualified model names. The client queries the selected agent's MCP endpoint (`/<agent>/mcp`) for available tools and sends the Streamable HTTP media contract `Accept: application/json, text/event-stream` on initialization and subsequent MCP requests. When the agent advertises a structured slash-command catalog tool, the provider uses that catalog and may send preserved launch query parameters such as `dir`; otherwise it maps `execute_<skill>` tool names to slash commands. Structured catalogs may declare subcommands, generic argument completions, a generic argument match mode, and a positive per-command result limit without WebChat hardcoding agent-specific command names. Prefix matching remains the default; an agent may request fragment matching for large searchable catalogs. When the agent does not limit results, WebChat keeps every match accessible but progressively adds bounded result batches to the fixed-height scrollable menu as keyboard or pointer navigation approaches the rendered boundary. The initial catalog load must tolerate a selected agent that is still starting: transient transport, readiness, or protocol failures trigger one deduplicated retry sequence with short backoff delays for approximately 30 seconds. A successful catalog, including a valid empty catalog, or an explicit access denial ends the sequence immediately. Typing `/` reads the in-memory catalog and must not start another MCP request. If the bounded initial sequence finishes without a catalog, the slash group remains silent until the page is reloaded.
- `@` opens the workspace-paths provider only. The provider preserves the WebChat launch query when it requests `/webchat/suggestions/files`, so the router resolves the same workspace-confined working directory supplied through `dir`, `workspace-dir`, or `workspaceDir`, with the workspace root as fallback. It shows at most 30 immediate children of the active folder under a `Files and folders` group. Text typed after `@` must continue to request and filter the active folder case-insensitively even when responses for older fragments arrive later. Selecting a folder inserts a cwd-relative token such as `@reports/` and drills into it. Selecting a file inserts a token such as `@reports/summary.md`, records a structured `workspace-path` reference on the outgoing envelope, and closes autocomplete so the next unmodified Enter submits the message. A space typed after a folder token terminates that token and closes autocomplete; moving the caret before that separator may reactivate autocomplete for the path fragment at the caret.
Selected workspace-path tokens should be visually emphasized in the composer and in rendered user messages when their structured reference metadata is available, while preserving the plain textarea value submitted to the selected chat agent.

Assistant messages must enhance recognizable workspace file paths after Markdown
rendering without modifying the raw message supplied by the selected CLI.
Detection must cover cwd-relative paths with supported
document, text, source, image, PDF, or HTML extensions. Inline-code paths may
contain spaces, while fenced code blocks, external links, URLs, traversal paths,
and host-absolute paths must not be rewritten. A compatible selected CLI may
publish version-1 `__webchatWorkspaceFiles` envelopes containing an initial full
snapshot and later added/removed deltas for its active working directory. Ploinky
must intercept these control lines before assistant rendering, validate bounded
normalized relative paths, retain only the latest index in runtime memory, expose
changes through the named `workspace-files` EventSource event, and replay a full
snapshot after reconnect. It must not scan on behalf of the CLI or persist the
index.

The browser must create automatic preview links only for recognized candidates
present in the current CLI-published index. A candidate seen before the first
snapshot or absent from the current index remains ordinary text. Additions must
allow already rendered messages to be enhanced, while removals must turn
previously inferred links back into text without changing stored conversation
content. Existing relative Markdown file links may be normalized to the same
preview route only while their target is indexed. The browser must prefix
cwd-relative candidates with the WebChat working directory's workspace-relative
base and point them at the existing authenticated `/workspace-files/...` route.
Explicit `/workspace-files/...` links remain workspace-root-relative and must not
receive the cwd prefix a second time. Clicking a detected path must open the side
panel: Markdown uses the existing Markdown renderer, text and source content use
an escaped code view, images use an image preview, PDFs use the browser viewer,
and HTML uses a sandboxed iframe. Unknown binary types must not trigger a download
from an automatically detected path. The authenticated file route remains the
final read-time authority even when a path is present in the volatile index.

WebChat must not hardcode optional agent ids, backend tags, or agent-owned tool names for `@` suggestions. It must not offer an `Agents` suggestion group or highlight arbitrary `@word` tokens as provider mentions. Unknown `@word` mentions remain ordinary chat text; semantic provider routing, if any, belongs to the selected chat agent after it receives the message envelope.

Ploinky must not add a research-specific enable command or WebChat availability toggle for optional provider agents. From the framework's perspective, a provider becomes selectable only when the selected chat agent exposes a launcher skill or equivalent agent-owned command for it. Backend health checks and unavailable messages belong to that launcher or downstream relay, not to Ploinky's command registry, composer, or router.

WebChat must expose `GET /webchat/suggestions/files` for the workspace-paths provider. The endpoint must require the same authenticated browser session as the surface and resolve a workspace-confined working directory from the same launch parameters used for `--dir` forwarding (`workspace-dir`/`workspaceDir`, with alias support for confined `dir`, falling back to the workspace root). The `query` parameter is a cwd-relative folder and leaf fragment: the endpoint lists only immediate children of that folder, applies case-insensitive fragment filtering to the leaf, caps results at 30, and sorts stronger matches first with directories before files at the same match rank. Result `displayPath`, `relativePath`, `queryPath`, and `path` values must be relative to the resolved WebChat working directory; `workspacePath` must be relative to the workspace root. The endpoint must reject absolute caller paths, traversal (`..`), NUL bytes, symlink escapes outside the resolved working directory, Ploinky runtime state, dependency directories, and reserved secret files such as `.secrets` and `*.secrets`. Host absolute paths must never appear in the response.

WebChat must expose an authenticated working-directory destination picker before a browser-selected file, folder, or camera capture becomes a pending composer attachment. The picker starts at the resolved WebChat working directory, treats its current directory as the upload destination, supports breadcrumb navigation and directory creation, displays regular files as non-selectable context, and must never return host absolute paths. A cancelled picker must discard only the new browser selection. The actual upload remains deferred until the composer message is sent.

The picker uses two authenticated directory routes. `GET /webchat/directories?path=<cwd-relative-path>` returns the current cwd-relative path, its parent, and immediate regular file and directory entries with folders sorted first. `POST /webchat/directories` accepts `{ "path": "<cwd-relative-path>" }` and creates one directory whose parent already exists. Both routes must reject absolute paths, traversal, NUL bytes, symlinks, Ploinky runtime state, dependency directories, and reserved secret names. Files may be displayed but must not be selectable as upload destinations.

`POST /webchat/uploads` accepts raw file bytes and writes directly below the chosen working-directory destination. `X-File-Name` carries the original filename, `X-Relative-Path` carries the file or browser folder-relative path, `X-Destination-Path` carries the selected cwd-relative directory, and `X-Mime-Type` carries the transient MIME value returned to the client. The server must not create a session upload directory, hashed storage directory, persistent upload id, or MIME metadata file. Each file must be staged in a temporary sibling file and committed only after the request body finishes; failed or aborted requests must remove that temporary file.

Existing targets must return `409 target_exists` unless the browser sends `X-Overwrite: 1` after an explicit collision confirmation. Confirmed file collisions replace that file. Confirmed folder collisions merge the uploaded tree into the existing directory, replacing colliding files while preserving unrelated existing files. A file-versus-directory type conflict must remain rejected. The response contains `ok`, `filename`, cwd-relative `relativePath` and `localPath`, workspace-relative `workspacePath`, a `downloadUrl` under the authenticated `/workspace-files/...` route, `size`, and `mime`; it must never contain a host absolute path. `GET` and `HEAD` are not supported on `/webchat/uploads`, and legacy session-upload links are not retained by this contract.

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

WebChat may also receive generic `__webchatTask` list, view, lifecycle, log, and action envelopes from a selected CLI. These envelopes must be intercepted before conversation rendering, validated, retained only as volatile runtime state, and forwarded through the existing EventSource stream as `task-update` events. A new subscriber to a surviving runtime must receive a revalidated, non-empty cached task-list snapshot before later live updates so a reconnecting browser can render known task metadata without waiting for another CLI publication. Logs remain CLI-owned and must not be included in that cached list. Ploinky must not persist task metadata or logs, hardcode target-agent ids or tool names, or expose task data/action REST routes. It retains only authenticated `GET /webchat/tasks/<task-id>/view`, which serves the generic HTML task page. The selected CLI owns task storage, log retention, reattachment, and actions.

An asynchronous tool may advertise a generic continuation tool. Its structured
result may return a versioned opaque continuation handle even when execution
fails after the provider session was created. The selected CLI stores that
handle with the target agent and tool name. A completed or failed task carrying
that capability must show a message input in its authenticated task view. The
view sends `/task continue <task-id> <prompt>` to the selected CLI through the
parent WebChat command bridge; it must not invoke a task REST route.
The continuation input must submit on unmodified Enter, preserve a newline on
Ctrl/Cmd+Enter or Shift+Enter, disable manual textarea resizing, and grow
upward with its content to the same bounded height as the main WebChat
composer. Beyond that height its own content must scroll, and deleting content
must shrink it again.
The provider invocation creates a new remote AgentServer task, but the selected
CLI must retain the exact same local `taskId`, increment its positive `turn`, replace its
current `remoteTaskId`, set the task back to `ongoing`, and append subsequent
logs to the same task log. Before remote output is appended, the CLI must append
the submitted continuation prompt to the durable log and publish that exact
delta and its resulting offset so an already open task view shows the prompt in
sequence. The shared browser presentation must normalize historical `User:`
prompt lines and current `you>` prompt lines to `you> <prompt>`, then render
them with a bold, accented prompt style that remains visually distinct from
provider output. Late lifecycle events from an older turn or remote
task id must not overwrite the current turn. The original task description and
creation time remain stable, while `executionStartedAt` tracks the current turn.
Task-log regions must reserve a persistent scrollbar gutter and render a
high-contrast, theme-aware scrollbar so long histories remain visibly and
directly navigable in both the Tasks overlay and authenticated task view.
The active embedded-parent or standalone generic stream remains the live update
path. If the stored agent is installed
but has no ready route, including after a general restart left a
`startup: manual` provider stopped, the selected CLI must activate that exact
agent in global mode through `AgentMcpClient.ensureAgentRunning()` and wait for
readiness before invoking it. Startup or readiness failure must remain explicit
instead of changing the local task identity or silently selecting another
provider.

The session-owning CLI is responsible for inserting a task reference immediately
after the active assistant placeholder and may include the resulting session id
and task-item index on the first `started` envelope. Ploinky forwards that
correlation on the EventSource event without altering conversation state or
persisting task state. The browser must render every task item as its own compact
incoming-style chat item. Its first row must show the exact target-agent id,
description, status, and elapsed whole seconds, and its second row must expose a
`View task details` link without inline expansion controls or logs. The browser
must recover the same item after history loading by resolving its `taskId`
against the selected CLI's `/tasks` list envelope. A live task
item may appear before final assistant text arrives; indexed insertion must
still produce the stable history order `user -> assistant -> task items`. The
item remains available after terminal completion; a missing task record renders
as unavailable. Task items are UI references and must not enter
the continuation context. The selected CLI must persist a task reference created
by a visible slash-command turn in that same durable session, so a refresh can
restore the command, its response, and every associated task item from one
ordered snapshot. Silent Tasks/session UI queries do not create transcript
records. Legacy assistant-message `taskId` properties are
ignored rather than rendered or migrated.

The task link must use WebChat's generic side-panel link mechanism to open the
authenticated task view. That page must reproduce the task header, error, and
live-log presentation previously available in the expanded chat item. When
embedded, it loads initial state by asking the parent to send
`/task view <task-id>` and receives later updates for the active task through a
same-origin `postMessage` bridge fed by the parent's existing EventSource.
When opened directly in a browser tab, it must preserve the selected agent and
workspace query, attach to the generic authenticated WebChat EventSource with
its own browser tab id, and send the same command invisibly through the generic
input route. The standalone view must request the snapshot immediately, repeat
the request after stream reconnection, and retry bounded `409` startup races.
Until a task or terminal loading failure is received it must show a loading
state rather than claiming that task data is unavailable. Neither mode may
fetch task data through a task-specific REST endpoint.
If a task-log delta does not begin at the task view's current offset, the view
must request one complete `/task view` snapshot and wait for that response. It
must not recursively reapply the same mismatched delta while the snapshot is
pending.

The task page must expose a direct `Stop` action while the current remote task
is queued or running. It sends `/task stop <task-id>` to the selected CLI; the
browser must not supply a target agent or remote task id. The selected CLI
resolves both values from its own store and signs a request-bound Agent
Assertion for the router's `POST /<agent>/task/cancel` path. The router verifies
the assertion and mints a target-scoped Router Request; no browser session token
reaches the target AgentServer. Queued work becomes `cancelled` without starting.
Running work first becomes `cancelling`, receives graceful termination, and is
force-terminated after a two-second cleanup grace period if it has not exited.
Repeated stop requests and requests against terminal work are idempotent. The
local task remains `ongoing` while remote cleanup is in progress and becomes
`stopped` when the remote task reports `cancelled`.

Cancellation never creates a replacement local task. If a running provider
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
composer. At mobile widths the panel must remain full-width but anchor to the
WebChat content area below the primary header. Its own title row and close
action must remain visible and operable instead of being covered by the primary
header, and the close action must provide a coarse-pointer-friendly target.

The Tasks overlay, compact task item, and task view must share one presentation policy.
Pending work is shown as `QUEUED`, active work as `RUNNING`, and terminal states
as `COMPLETED`, `STOPPED`, or `FAILED`. Raw task log files remain unchanged and
are written only by the selected CLI's task-event ingestion. The terminal task envelope may carry
the final MCP result as presentation metadata, but ingestion must never append
or duplicate that result in the log. Instead, it locates the last identical
range already present in the persisted raw log and stores only its offset and
length in its task journal. Continuation clears that range until the next terminal
result. The Tasks overlay and task view render log lines outside the range with
the secondary grey text color and lines intersecting it with the primary text
color, so intermediate provider activity remains visibly distinct from the
final answer. If no exact range is available, the raw output remains visible
with the intermediate style. Browser rendering strips ANSI control sequences
and retains presentation compatibility for historical logs that contain
recognized stream and runner prefixes; new raw provider output remains
otherwise unchanged.

When an ongoing task becomes terminal, WebChat may show the existing transient
task toast. That toast must include an accessible close button on its right so
the operator can dismiss it immediately without waiting for automatic expiry.

When a WebChat runtime has no SSE subscribers but has received a task whose materialized state is `ongoing`, reconnect cleanup must retain that runtime so the selected CLI can continue router-mediated polling and log collection. Once its tasks become terminal, the normal reconnect grace and disposal behavior resumes. If the runtime is recreated after a wider process restart, the selected CLI reattaches from its workspace task journal. Initial task identity is derived from target agent and remote task id; after continuation, the stable local task id plus its monotonically increasing turn select the current remote task. A PID is optional diagnostics only.

The router must also expose:

- authenticated, non-detailed health summary on the local control surface; detailed health is Unix-socket-only.
- `/api/marketplace` for the first-party agent marketplace. This route is router-owned and returns JSON rather than proxied agent content. Browser callers use the existing local or SSO session: authenticated users may read Marketplace state, non-admin clients use the returned permissions to hide management controls, and only an authenticated local administrator may perform the full `install_repo`, `uninstall_repo`, `enable_agent`, and `disable_agent` action set. An already-running Ploinky agent may also call the same endpoint with a request-bound Agent Assertion targeted at `ploinky-router`: `GET` uses the synthetic tool `marketplace.read`, while `POST` is restricted to `enable_agent` and uses `marketplace.enable_agent`. Agent assertions must be bound to the exact method, path, query, and raw body, and must be replay-protected. Agent callers cannot install repositories, uninstall repositories, disable agents, or gain browser admin permissions. The read response reports the caller-facing Marketplace state, predefined repositories, installed repositories, remembered repository sources, repository kind, discoverable agents, enabled-agent registry state, recorded runtime backend, and backend-aware liveness. Bubblewrap and Seatbelt use their tracked process PIDs; Docker and Podman use OCI state. Repository installation must require a URL, accept an optional name and branch, clone the checkout, and record source metadata including repository kind. Repository uninstall must match the CLI repository contract: it disables enabled agents that came from that repository by runtime key, removes their runtimes through the normal disable helper, preserves agent work directories, removes the installed repository checkout, and preserves the source metadata so the repository remains available for reinstall in the correct Marketplace repo category. Agent enablement must use the standard enable path. Agent disablement is marketplace-specific: the route removes the enabled-agent registry record before removing the agent runtime with the normal removal helper, so the watchdog does not restart the runtime while the admin operation is in progress. This marketplace behavior must not change the conservative direct `ploinky disable agent` CLI contract, which still refuses to remove records while runtime state exists.
- `/upload` and `/blobs` for workspace and agent blob flows.
- `/workspace-files/...` for authenticated, workspace-confined file reads owned
  by the router. Responses must derive `Content-Type` from the file extension,
  attach UTF-8 charsets to supported text formats, set
  `Content-Disposition: inline`, and set `X-Content-Type-Options: nosniff` so
  WebChat can preview content without an automatic download.
- `/webchat/directories` and `/webchat/uploads` for destination selection, directory creation, and direct writes below the resolved WebChat working directory.
- `/agent-card` for aggregate discovery of routable agents that expose capability metadata. The router must query each active route's internal `/agent-card` endpoint, include successful responses without validating their field shape, and report per-agent errors separately.
- `/mcp` for router-level MCP aggregation.
- manifest-declared HTTP service prefixes and exact service-host aliases for downstream HTTP services.
- `POST /policy/command` is the single administrative endpoint for the router's access-control policy (DS014). It is authenticated, never route-policy-controlled, and handles `http.route.*` and `mcp.policy.*` namespaces.
- `http://<service-slug>.localhost:<routerPort>/` for each uniquely slugged enabled HTTP service. Slugless services remain prefix-only. Dedicated hosts canonicalize the request to the selected service's `externalPrefix` and cannot select another service through the path or query.
- `/<agent>/...` for transparent per-agent proxying after the router-owned paths above have been considered. The router strips the `/<agent>` mount prefix and forwards the remaining path and query string to the route's upstream host port. The target agent owns paths such as `/index.html`, `/agent-card`, `/v1/models`, `/v1/chat/completions`, `/task`, and any custom HTTP endpoints. `/<agent>/mcp` remains the special MCP proxy path because the router must preserve MCP session mediation and per-agent Router Request minting (DS013) plus MCP tool policy enforcement (DS014) for tool and resource operations. Agent-to-agent task-status polling for async MCP tasks is also router-mediated: a delegated caller presents an Agent Assertion for `GET /task` or `GET /getTaskStatus`, and the router mints a target-scoped Router Request before proxying the status read. Agent-to-agent OpenAI-compatible calls also have path-exact delegated handling for `POST /<agent>/v1/chat/completions` and `GET /<agent>/v1/models`; both use HTTP Agent Assertions and target-scoped Router Requests rather than direct container access.

Listener/interface class and exact normalized Host are resolved before pathname
dispatch. Local control, configured service, configured agent-root, and managed
private traffic are distinct classes. Unknown, malformed, suffix-confusable,
stale, and mismatched tuples fail without proxying. A dedicated service host has
a closed surface containing only its selected service and the exact auth
transaction paths that service needs. An agent-root host has only the root/mounts
and explicitly validated named `routerSurfaces` capabilities. Health, admin,
policy, discovery, aggregate MCP, dashboard, status, WebChat, broker, and private
service routes are absent unless the selected class and closed allowlist permit
them. Raw capability names are invalid configuration.

When an agent-root host selects `agent-mcp`, the active edge generation compiles
an exact MCP route allowlist containing the selected root route and the
transitive closure of enabled routes named by its active manifest dependency
graph. Root `/mcp`, `/<routeKey>/mcp` for that compiled closure, and the
browser MCP support assets are admitted. An enabled route outside the closure
cannot become the MCP target. Non-MCP dependency-looking paths remain ordinary
selected-root application paths, so the capability does not expose another
agent's arbitrary content.

Router-owned paths such as `/policy/command`, `/auth/*`, `/admin/*`, `/metrics`,
and `/__agent/*` never become reachable merely because a caller supplies a local
or configured Host. Every TCP admin/control/status handler still requires a real
admin session; Agent Assertions, LiveKit JWTs, delegations, and network provenance
are not admin credentials. Mutations also require Origin and CSRF validation.
The router evaluates the HTTP route access policy (DS014) before transparent
agent HTTP proxying and declared HTTP-service dispatch. Public decisions allow
anonymous `GET`/`HEAD` only; guest decisions prefer an existing local or SSO user
session and otherwise mint a scoped guest session; authenticated decisions
require a user-authenticated route or static-agent auth policy.

Enabled agent manifests may also declare `routerAccess.httpRoutes`. The router expands each agent-relative declaration to `/<routeKey><path>` using the active route key or alias, then evaluates those declarations beside persisted `httpRoutes` and declared HTTP-service prefixes. Manifest entries require `path`; `access` may be omitted and then defaults to `authenticated`. When `access` is present it must be exactly `public`, `guest`, or `authenticated`; removed aliases are invalid and skipped for that agent. Public entries allow anonymous read-only access, guest entries ensure a guest or user session identity, and authenticated entries require a user-authenticated router session for every method. Authenticated entries prefer the owning route user-auth policy, fall back to the static route user-auth policy when the route is otherwise `none` or `guest`, and fail closed with `authenticated_http_route_auth_not_configured` if neither policy can authenticate a user. Guest auth mode and guest sessions do not satisfy authenticated route access. When entries overlap, the most restrictive access wins. Manifest declarations do not make internal `__agent` control-plane paths reachable. Because manifest paths are agent-relative before expansion, `/auth/...`, `/admin/...`, and `/metrics` inside a manifest are ordinary agent paths under `/<routeKey>/...`, not router-root reserved paths.

Agent-to-agent callers may access `/agent-card` and direct per-agent HTTP routes without router-level endpoint-specific logic; the target agent decides whether to accept or reject the request once proxying reaches it. Orchestrators can discover remote agents via `PloinkyAgentSkillsSubsystem` and include them as tools through `## Allowed Agents` declarations.

Agent MCP sessions are runtime-owned and ephemeral. Clients that finish with a session should send `DELETE /mcp` with the `mcp-session-id` header so the agent runtime can close the SDK transport immediately. The shared `AgentServer` must also reap idle sessions defensively for clients that disconnect without a delete, but it must treat any session with an open HTTP response as active so long-running tool calls and SSE streams are not closed by idle cleanup.

HTTP service routes must be declared by the target agent rather than hard-coded
into router handlers. An enabled agent may provide `httpServices` entries with a
validated `slug`, external prefix, internal upstream prefix, optional integer
`port`, and `access`, where the only valid values are `public`, `guest`, and
`authenticated`. An omitted port retains the owning agent's primary target. The
launcher creates or reuses one private mapping for every distinct explicit TCP
port. The prelaunch generation intentionally contains exact identities and
targetless routes; only the later coordinated runtime apply records resolved
targets in an installed generation. Invalid, ambiguous,
or unresolved entries leave affected selectors inactive; HTTP, SSE, and
WebSocket never rediscover a target from mutable route state.

The Host-selected service is canonicalized to its `externalPrefix` before
`createHttpServiceProvider` participates in `HttpRouteAccessPolicy`. The provider
and the effective policy independently decide admission, so hostname
publication cannot override `public`, `guest`, or `authenticated` ownership.
Public services run without router identity and remain read-only under existing
policy semantics. Guest declarations prefer an authenticated user and otherwise
mint a service-scoped guest. Authenticated declarations require user identity
and may retain current conditional delegations. Invocation-bearing service
requests keep the bounded exact-body hashing and signed internal-path contract;
caller-supplied forwarding, authorization, cookie, and `x-ploinky-*` identity
headers are stripped and authoritative values are synthesized from the selected
topology and authenticated request.

Private service calls use the same compiled canonical service policy on listener
`8081`, but they additionally require an exact current-instance/current-enable-
generation caller ACL and a short-lived replay-protected assertion. Assertions
bind audience, caller, generation, method, path, body, and nonce; they never mint
a user or guest identity and never satisfy admin authentication. The assertion
header is stripped before dialing while a service-specific upstream
`Authorization` header may be preserved.

Ploinky publishes a box-owned topology snapshot before consumers start. It
names three deliberately different generations: the route-and-policy
`authorizationGeneration` that is revalidated before dial, a content-derived
`configurationGeneration` for stable non-secret consumer configuration, and a
monotonic `publicationGeneration` for readiness/publication changes. The
snapshot contains only non-secret logical locators—never raw target ports,
private listeners, credential handles, or product-specific fields. Readiness
changes advance only publication state. Browsers use one authenticated,
`no-store` locator projection that returns no inventory or authorization
generation and reports `503` while the requested locator is inactive; dedicated
service hosts cannot access it.

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
The target AgentServer owns the actual delegated process, while the selected chat CLI owns router-mediated polling and task persistence. Retaining that CLI runtime while work remains ongoing preserves live diagnostics across a closed browser tab without making the browser, Ploinky, or its `tabId` the task owner.

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

### Question #13: Why must interface and exact Host resolve before pathname dispatch?

Response:
A path is meaningful only inside a selected transport and host namespace. If a
generic handler sees the path first, a managed caller can spoof a public or
localhost Host and reach a control route that was never part of its surface.
Classifying the tuple first gives every service and agent-root host a closed
allowlist and guarantees rejection before an upstream target is observable.

### Question #14: Why does every transport hold an authorization-to-dial generation lease?

Response:
Authentication may complete before a concurrent policy, target, or enablement
change. Revalidating one captured immutable generation immediately before the
HTTP, SSE, or WebSocket connection commits prevents an already-authorized but
not-yet-dialed request from sending bytes to a stale or newly unauthorized
target. A mutable file timestamp cannot provide that property.

### Question #15: Why are private Router and topology separate from outer publication?

Response:
The private listener carries exact current-generation service calls, while the
topology snapshot tells consumers which logical locator is active. Neither is a
new physical-host edge: listener `8081` stays unpublished, topology contains no
raw target or secret, and the outer contract remains exactly loopback Router TCP
plus LiveKit UDP 7882.

### Question #16: Why does topology distinguish authorization, configuration, and publication generations?

Response:
They protect different transitions. The authorization generation proves that
the exact route, target, policy, and caller ACL validated together and is the
lease checked before dial. The configuration generation changes only when the
stable non-secret consumer inputs change. The publication generation advances
when readiness or publication state changes without pretending the underlying
configuration changed. The browser needs only the latter two; withholding the
authorization id and inventory avoids turning the locator projection into a
routing oracle.

### Question #17: Why may an agent enable another agent through Marketplace?

Response:
Optional workers must remain outside the root manifest dependency graph or they are recursively started with the primary application. Reusing the existing Marketplace enable action gives launchers one lifecycle path instead of a second startup implementation. The agent assertion is deliberately limited to state reads and installed-agent enablement, bound to the exact request, and replay-protected; repository changes, disablement, and browser administrator authority remain unavailable.

### Question #18: Why is each background task a separate conversation item?

Response:
A single assistant turn may start several independent tasks, so one `taskId` on
the assistant message cannot represent the complete result. Dedicated reference
items preserve every task and its start order without duplicating task state or
logs in conversation history. They also keep assistant text semantically clean
while letting the browser render task progress immediately and later place final
assistant output before the already visible task items. Persisting only the
reference in the CLI-owned session lets refresh reconstruct the same transcript,
while the CLI-owned task journal remains the authority for current task state.

### Question #19: Why does a manual agent route act as an activation marker?

Response:
The enabled-agent registry describes installed workspace intent and must survive periods when an optional worker is stopped. Routing state already identifies runtimes that were explicitly made reachable. Reusing that state lets the watchdog distinguish an intentionally dormant manual agent from an explicitly activated one without adding a second lifecycle store.

### Question #16: Why is ordinary text equality insufficient for WebChat echo detection?

Response:
An agent may legitimately answer with the same text the user submitted. Treating
that equality as terminal echo evidence discards a valid assistant response and
leaves the browser waiting on an empty placeholder. Echo suppression therefore
uses explicit transport markers, including WebChat envelopes and the `you>`
readline prompt, rather than conversational text equality.

### Question #17: Why does an embedded task view reuse its parent stream while a standalone view attaches to the generic stream?

Response:
The parent WebChat runtime already receives every `task-update` event and owns
the selected CLI lifecycle, so forwarding only the active task through a
same-origin `postMessage` bridge preserves one live transport for the embedded
page. A directly navigated tab has no parent bridge; attaching it to the same
workspace-and-agent runtime key preserves CLI ownership and makes the existing
generic input and EventSource routes sufficient. Replaying cached, revalidated
task metadata gives that tab immediate context, while an idempotent hidden
`/task view <task-id>` request obtains the authoritative log and recovers after
startup or reconnect races without adding a task data REST API.

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

### Question #22: Why does the selected CLI publish workspace file state while the router still validates reads?

Response:
The selected CLI owns working-directory semantics and can refresh the index at
startup, periodically, and immediately before it emits an answer. Ploinky can
therefore stay a generic transport while the browser avoids turning nonexistent
textual candidates into links. The index is only an untrusted presentation hint:
the authenticated router-owned file route still performs canonical confinement
and existence checks when the user opens a preview. This separation neither
grants the agent another filesystem capability nor changes stored assistant text.

### Question #23: Why does the selected CLI own conversation restoration?

Response:
The CLI can also run directly without WebChat and is the only component that knows how to recreate its agent session safely. Keeping persistence and one-time hydration there gives terminal and browser launches identical semantics. WebChat only transports prompts and validated session-state snapshots, so a browser reconnect cannot accidentally replay history or become a second source of truth.

### Question #24: Why does WebChat verify delivery before broadcasting input acceptance?

Response:
A successful HTTP response and server-originated user-message event tell connected browsers that the selected CLI accepted the prompt. Returning success after writing to a closed or detached stdin leaves the interface waiting for output that cannot exist. Health-aware writes make that acknowledgement truthful, remove the stale runtime immediately, and let the existing EventSource reconnect create a fresh CLI process without changing conversation ownership.

### Question #25: Why does task-log gap recovery wait for a complete snapshot?

Response:
A delta whose starting offset differs from the browser's current offset cannot
be merged safely. The selected CLI already provides an authoritative full-log
snapshot through `/task view`, so one pending snapshot request is sufficient.
Immediately retrying the same delta before that asynchronous response arrives
repeats the same mismatch and can create an unbounded browser microtask loop.

## Conclusion

Ploinky’s routed interface depends on a supervised dual-listener Router, closed
host surfaces, immutable route-and-policy generations, and stable prefixed
browser surfaces. Candidate files describe desired state, but only coordinated
generation apply authorizes a route or target.
