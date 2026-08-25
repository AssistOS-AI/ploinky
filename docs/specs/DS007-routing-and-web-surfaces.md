---
title: DS007-routing-and-web-surfaces
summary: Defines Router listener separation, host-first route selection, mediated agent proxying, browser surfaces, WebChat, and Marketplace behavior.
---

# DS007 Routing and Web Surfaces

## Introduction

The Router is the only Ploinky-owned network mediator between users, applications, and enabled agents. It must select a closed surface from listener class and exact Host before it considers a pathname.

## Core Content

The public/control listener uses in-Box TCP port `8080`; the private managed-agent listener uses `8081` and must not be published outside the Box. Detailed supervisor health belongs on a private Unix socket. Listener reachability, loopback origin, and host-gateway transport are not authorization and must never replace route policy or request credentials.

### Route selection and path rewriting

The Router must select the request surface from the exact normalized `Host` and listener class before interpreting the path. This ordering prevents a path that is valid on the local control host from becoming available automatically on an agent's public hostname.

| Request form | Routing behavior and purpose |
| --- | --- |
| Control hosts `localhost`, `127.0.0.1`, `::1`, and `router.localhost` | Select the Router control closure on the public/control listener. Router-owned endpoints are handled locally, while agent traffic requires an explicit `/<agentName>` prefix. |
| `host.containers.internal` on the managed listener | Gives managed runtimes access to admitted Router transport. Reserved Router browser/control paths are denied; an agent target must be selected by an admitted route form. |
| A compiled public hostname | Selects exactly one enabled root agent. Ordinary unprefixed paths are routed to that agent, while only the Router surfaces explicitly compiled for that hostname remain available. An inactive publication fails before path dispatch. |
| `/` or `/index.html` on a control host | Redirects to `/<staticAgent>/index.html` when the workspace has a static agent. It does not proxy an arbitrary default process. |
| `/<agentName>` or `/<agentName>/` | Selects one exact enabled route and forwards `/` to that agent after admission. Unknown, disabled, ambiguous, or inactive targets fail closed. |
| `/<agentName>/<path>?<query>` | Selects one enabled agent, removes only the first `/<agentName>` segment, preserves the query, and sends `/<path>?<query>` to the admitted upstream. |
| `/mcp` on a control host | Selects the Router-owned aggregate MCP server. It aggregates admitted tools and resources across enabled routes and is not shorthand for the static agent. |
| `/<agentName>/mcp` | Selects one agent's MCP surface and forwards `/mcp` to that exact agent. Browser callers use the selected user-auth policy; agent callers must present a request-bound Agent Assertion. |
| `/mcp` on an agent's dedicated public hostname | Selects that hostname's root agent MCP endpoint only when the compiled `agent-mcp` surface allows it. Host selection makes it different from control-host aggregate `/mcp`. |
| `/base-agent-additional-server/<agentName>/<port>/<path>` | Selects an additional private server owned by an enabled agent and relays HTTP or WebSocket traffic to the canonical port. The route must match declared HTTP access policy; malformed selectors, reserved ports, stale owners, and undeclared paths are rejected. |

For `/<agentName>/<path>`, Ploinky-owned handlers run before generic agent routing. If the path belongs to the selected agent, the Router handles MCP and delegated task/OpenAI flows first, then attempts a traversal-safe static-file read from the captured agent source directory. When no static file matches, it proxies the rewritten path to the agent's registered service port. A default AgentServer repeats a safe static lookup inside `/code` after its own API endpoints, so dedicated-host paths and proxied paths can serve `index.html`, directory indexes, JavaScript, CSS, images, fonts, JSON, and other supported file types without exposing the source directory itself. A custom agent service may implement additional paths, but those paths remain inside the single generic agent route and do not become Router-owned endpoints.

Every routed request must use the active immutable edge generation and the exact agent instance and enable generation. HTTP, SSE, and WebSocket forwarding must revalidate the lease before reading a file or dialing a target, strip caller-supplied Ploinky identity headers, mint trusted forwarding or invocation context only after admission, enforce request limits, and confine the upstream to the captured route or runtime relay.

### Router-owned public and control endpoints

The following table is the active Router-owned HTTP surface. Endpoint families with a parameter use angle-bracket placeholders for one validated path segment.

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | Returns the minimal `{ "status": "healthy" }` Router summary. It is a local control endpoint and requires a real administrator control request. |
| `GET /agent-card` | Fans out to enabled agents and returns the successfully collected agent cards plus bounded per-agent errors. This is the aggregate card endpoint on the control surface. |
| `POST /mcp` | Implements aggregate Streamable HTTP MCP. It accepts JSON-RPC `initialize`, `notifications/initialized`, `tools/list`, `resources/list`, `tools/call`, `resources/read`, and `ping`, plus the compatibility command form. Tool/resource results remain filtered by Router MCP policy. |
| `DELETE /mcp` | Ends the aggregate MCP session named by `Mcp-Session-Id`. `GET /mcp` deliberately returns `405` because event-stream transport is not supported. |
| `GET` or `HEAD /MCPBrowserClient.js` | Serves the Router's browser MCP client module used by browser applications to initialize and call MCP endpoints. |
| `GET` or `HEAD /web-libs/<path>` | Serves traversal-safe shared browser libraries from Ploinky's `webLibs` directory. A directory root or path outside that directory is rejected. |
| `GET /auth/logged-out` | Renders the signed-out page and a bounded return link. |
| `GET` or `POST /auth/login` | Renders or submits local login, or starts the configured SSO login flow. The exact host-selected auth context determines which agent policy is used. |
| `GET` or `POST /auth/account` | Renders account information and allows an authenticated local user to update their own username or password with a mutation proof. External-auth accounts are read-only here. |
| `GET /auth/callback` | Completes the configured SSO callback, binds the new session to the current edge generation, and redirects to the validated return path. |
| `GET` or `POST /auth/logout` | Renders logout confirmation or invalidates the session after mutation-proof validation and clears authentication state. |
| `GET` or `POST /auth/token` | Returns the authenticated browser's token metadata, user, session/origin/host-bound browser-mutation proof, current generation metadata, and local admin-control proof when applicable. Route authorization remains separate. `POST` may request an SSO refresh and requires CSRF validation. |
| `/auth/local-users`, `/auth/github/*`, and `POST /auth/agent-token` | Reserved removed surfaces. They return `410` or `404` and must not be reused; user administration and router-mediated agent assertions replace them. |
| `GET /api/agents/<agentName>/settings` | Returns Router login presentation settings for a host-selected agent using local authentication. A local administrator session is required. |
| `PATCH /api/agents/<agentName>/settings` | Updates supported Router login settings after administrator and mutation-proof checks. |
| `GET /api/agents/<agentName>/users` | Lists local users and available roles for the selected agent. |
| `POST /api/agents/<agentName>/users` | Creates a local user for the selected agent. |
| `PATCH /api/agents/<agentName>/users/<userId>` | Updates one local user's identity fields, password, or roles. |
| `DELETE /api/agents/<agentName>/users/<userId>` | Deletes one local user while preserving local-auth invariants such as retaining an administrator. |
| `GET /api/marketplace` | Returns the authenticated caller's repository, agent, enabled-instance, and runtime inventory. A running agent may use an assertion limited to `marketplace.read`. |
| `POST /api/marketplace` | Performs `install_repo`, `uninstall_repo`, `enable_agent`, or `disable_agent` for a local administrator with mutation proof. An asserted agent is restricted to `enable_agent` for an already available agent. |
| `POST /policy/command` | Invokes the administrator-only Router policy command registry. It supports HTTP-route inspection/mutation and MCP-policy inspection/mutation; mutating commands require exact control Origin and CSRF proof. |
| `GET /api/router/openai-agent-discovery` | Returns Router paths and OpenAI-compatible metadata for enabled agents to an asserted agent caller. Browser session authentication is neither sufficient nor required. |
| `POST /api/router/identity/user-api-key` | Mints a Router-signed identity key for the authenticated non-guest user. An administrator may request another valid user subject; ordinary users can mint only their own identity. |
| `GET /status/data` | Returns workspace, server, static-agent, and runtime metrics to a local administrator. |
| `GET /status/data?follow=1` | Streams the same metrics as newline-delimited JSON until the request closes or authorization becomes stale. |
| `POST` or `PUT /upload?path=<workspacePath>` | Streams one bounded upload into a traversal-safe workspace path, replacing the target atomically under upload policy. |
| `POST /blobs` | Stores a bounded shared blob and returns its id, `/shared` path, size, media type, and download URL. |
| `GET` or `HEAD /blobs/<blobId>` | Reads or inspects a shared blob and supports byte-range downloads. |
| `POST /blobs/<agentName>` | Stores a bounded blob in the selected enabled agent's project blob directory. Repository-qualified `repo:agent` selectors resolve ambiguity. |
| `GET` or `HEAD /blobs/<agentName>/<blobId>` | Reads or inspects an agent-owned blob and supports byte ranges. |
| `GET` or `HEAD /workspace-files/<workspacePath>` | Serves a traversal-safe file below the workspace root for authenticated previews and downloads. A directory may resolve `index.html`, `index.htm`, or `default.html`; the bare route is rejected. |

Router-owned names are closed namespaces. `/auth`, `/policy`, `/admin`, `/__agent`, `/api/edge`, `/api/agents`, `/api/marketplace`, `/api/router`, `/status`, `/webchat`, `/web-libs`, `/workspace-files`, `/upload`, `/blobs`, `/health`, `/metrics`, `/agent-card`, `/mcp`, and `MCPBrowserClient.js` must not fall through to an agent when their Router surface is absent or disallowed. Any `__agent` path segment is internal control plane and returns a generic `404` on the public listener.

### WebChat endpoints

WebChat is a Router-owned browser application for one selected enabled agent. The optional `agent=<routeKey-or-alias>` query selects its CLI; workspace-directory and CLI launch options remain bounded by the WebChat launch resolver and are propagated consistently to its subrequests.

| Endpoint | Purpose |
| --- | --- |
| `GET /webchat` or `GET /webchat/index.html` | Renders the authenticated chat application for the selected agent and embeds its runtime, workspace, asset, and envelope configuration. |
| `GET /webchat/assets/<path>` | Serves WebChat JavaScript, CSS, images, and other traversal-safe application assets. |
| `POST /webchat/logout` | Disposes the browser WebChat session and redirects through the Router logout flow. |
| `GET /webchat/tasks/<taskId>/view` | Serves the isolated task-detail view for ids matching the versioned task-id grammar. Task data continues to arrive through the authenticated runtime stream. |
| `GET` or `HEAD /webchat/suggestions/files` | Returns bounded workspace file-path suggestions for composer completion without exposing `.secrets` or paths outside the admitted workspace base. |
| `POST` or `PUT /webchat/uploads` | Accepts bounded file or folder uploads into the selected workspace base and returns workspace-file URLs for accepted entries. |
| `GET` or `HEAD /webchat/directories` | Lists a bounded destination directory beneath the selected workspace base for the upload dialog. |
| `POST /webchat/directories` | Creates an admitted destination directory beneath the selected workspace base. |
| `GET /webchat/stream` | Opens the Server-Sent Events channel for one authenticated tab/runtime. It sends live CLI output and validated runtime, session, task, workspace-file, skills, and interaction snapshots, then keeps the connection alive. |
| `POST /webchat/input` | Sends one user message to the selected CLI. It writes newline-terminated text by default or a versioned `__webchatMessage` envelope when the agent manifest enables `webchat.forwardEnvelope`. |
| `POST /webchat/control` | Sends bounded raw control input to the existing selected CLI runtime for browser controls that are not ordinary visible user messages. |
| `POST /webchat/interaction` | Resolves one pending CLI interaction after verifying the session, runtime, tab, optional page instance, interaction id, and declared option or input bounds; the CLI receives a versioned `__webchatInteractionResponse` record. |
| `POST /webchat/auth` | Removed token-auth endpoint. It returns `410`; WebChat uses the Router login and session flow. |

WebChat must remain generic and must not hardcode optional agent ids, provider tags, downstream tool names, or domain-specific dispatch. State-changing browser requests must carry the Router mutation proof and remain bound to the active user session, selected workspace runtime, and current edge generation.

CLI control output must use one complete newline-delimited JSON record with a recognized versioned WebChat marker. The Router must validate accepted session, task, runtime-state, workspace-file, skills, and interaction records before converting them into named SSE events or reconnect snapshots; unaccepted records must not mutate browser state.

Slash-command suggestions must remain agent-defined. During page initialization, WebChat must call the selected agent's Router-mediated `/<agentName>/mcp` endpoint, complete MCP initialization, request `tools/list`, and call the optional `list_achilles_cli_commands` tool. The browser caches the returned command catalog for local completion and sends it only when initialization or an explicit post-skills-change refresh requires it. When that structured tool is absent, WebChat may derive a fallback catalog only from the selected agent's admitted `execute_*` MCP tools.

### AgentServer endpoints behind an agent route

These endpoint paths exist on the default AgentServer. From a control host they are reached as `/<agentName><endpoint>`; on an admitted dedicated hostname the root agent may receive the endpoint without the explicit prefix. Custom agent services may replace this endpoint set, but they remain constrained by the same Router route and access policy.

| AgentServer endpoint | Purpose |
| --- | --- |
| `GET /health` | Reports that the private default AgentServer is accepting requests. Through the Router this is `/<agentName>/health`; it is separate from Router control `GET /health`. |
| `GET /agent-card` | Returns the selected agent's configured card metadata. Through the Router this is `/<agentName>/agent-card`; aggregate control `/agent-card` fans out to this endpoint. |
| `POST /mcp` | Creates or uses a Streamable HTTP MCP session and executes the agent's configured tools, resources, and prompts after Router policy and secure-wire checks. |
| `GET` or `DELETE /mcp` | Continues or closes an existing MCP transport session identified by `Mcp-Session-Id`. Router-facing MCP adapters deliberately reject browser-style event-stream `GET` even though AgentServer can service an SDK-managed session request. |
| `GET /task?taskId=<id>` and `GET /getTaskStatus?taskId=<id>` | Return one asynchronous MCP task after verification of a Router-minted invocation token. The Router handles authenticated browser polling and asserted agent-to-agent polling before reaching this endpoint. |
| `POST /task/cancel` | Cancels one asynchronous MCP task after exact invocation-token verification. |
| `POST /v1/chat/completions` | Implements the OpenAI-compatible chat-completions endpoint through a configured command or the default agentic responder. Exact agent-to-agent calls use an Agent Assertion that the Router replaces with a target-bound invocation token. |
| `GET /v1/models` | Returns the selected agent's configured or fallback OpenAI-compatible model list. |
| `GET` or `HEAD /<staticPath>` | Serves a traversal-safe file below `/code`, including directory index files, after all AgentServer API endpoints have had priority. Missing files return `404`. |
| Any other method/path | Returns `404` in the default AgentServer. A custom agent service may implement its own API, SSE, or WebSocket behavior, reached through the generic Router proxy. |

### Private and supervisor-only endpoints

The private `8081` listener accepts only exact request-bound assertions from a currently enabled agent identity. The detailed-health Unix socket is available only to local supervisors. Neither surface is an alternate public API.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/edge/workspace-metrics?follow=1` on `8081` | Streams workspace metrics to any exact current agent caller whose private assertion binds the method, path, query, instance, and enable generation. |
| `POST /api/edge/workspace-logs` on `8081` | Executes a bounded workspace-log operation only for agents compiled into `routerAccess.workspaceLogs`. |
| `POST /api/edge/turn-credentials` on `8081` | Mints short-lived TURN credentials for an exact allowlisted current agent caller, subject to topology availability and per-caller rate limits. |
| `/base-agent-additional-server/<agentName>/<port>/<path>` on `8081` | Relays an authenticated-policy additional agent server only after the caller assertion, route ownership, method, path, body hash, instance, and generation all match. |
| `GET /health` on the Router health Unix socket | Returns detailed supervisor health: uptime, timestamp, process and memory data, active Router sessions, and edge-publication status. |
| `POST /authority-attestations` on the Router health Unix socket | Registers a bounded nonce and expected edge generation for supervisor authority observation. |
| `GET /authority-attestations/<nonce>` on the Router health Unix socket | Consumes a completed authority observation and returns the recorded listener/route evidence, or a generic incomplete/not-found result. |

The Router must return generic errors to unauthenticated, unauthorized, or guest callers where target disclosure would reveal private state. A malformed Host, unavailable compiled surface, missing route or policy, inactive runtime, changed generation, invalid assertion, or failed lease commit must stop dispatch before an upstream connection or file read occurs. Every user surface must converge on the same Router-owned workspace, route generation, authentication context, and exact private target without publishing an agent listener directly.

### Routing and publication rationale

| Decision | Reason |
| --- | --- |
| Mediate browser and agent traffic through the Router instead of publishing agent listeners | Authentication, authorization, limits, generation checks, and redaction have one enforceable boundary. Agents cannot independently expose the physical host. |
| Select the listener and exact Host before interpreting the path | A path that is valid on the local control surface must not become reachable merely because the same path is requested on an agent hostname. Host-first selection prevents cross-surface route confusion. |
| Separate public port `8080` from private agent port `8081` | Network reachability inside the Box is not authority. The private listener can require request-bound agent proofs without exposing those capabilities to browsers or the host network. |
| Route agent HTTP and MCP services by agent identity and internal port convention | The manifest stays focused on the agent contract, Ploinky remains service-agnostic, and new agent services do not require new outer host publications. |
| Keep edge publication under Ploinky core ownership | Public hostnames, connector credentials, route generations, health, replacement, and teardown must change together. Giving an agent or configuration provider that authority would let workload code redefine its own trust boundary. |
| Support an explicit local-only mode | Isolation, routing, and agent collaboration remain useful without a public edge, and the absence of publication credentials is not treated as a partially configured deployment. |
