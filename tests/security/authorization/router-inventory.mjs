/**
 * Executable Router inventory, reviewed against the pinned merged source.
 * Concrete deployed agent aliases/endpoints are added by the agent inventory.
 * A row is an inventory obligation, not a claim that a live test passed.
 */
const access = {
  public: { anonymous: 'allow', selfRegistered: 'allow', user: 'allow', admin: 'allow' },
  session: { anonymous: 'deny', selfRegistered: 'allow', user: 'allow', admin: 'allow' },
  explorer: { anonymous: 'deny', selfRegistered: 'deny', user: 'allow', admin: 'allow' },
  admin: { anonymous: 'deny', selfRegistered: 'deny', user: 'deny', admin: 'allow' },
  private: { anonymous: 'deny', selfRegistered: 'deny', user: 'deny', admin: 'deny' },
  route: { anonymous: 'manifest/policy', selfRegistered: 'manifest/capability', user: 'manifest/capability', admin: 'manifest/capability' },
};
const rows = [];
function add(id, methods, path, source, policy, notes, extra = {}) {
  for (const method of methods.split('|')) rows.push({
    id: `${id}.${method.toLowerCase()}`, method, path, source,
    expected: { ...access[policy] }, notes,
    coverage: 'inventoried; live evidence required', ...extra,
  });
}

add('root', 'GET', '/', 'cli/server/RoutingServer.js:771', 'explorer', 'Redirects to selected static agent; redirect is not an authorization success. Also /index.html.');
add('root-index', 'GET', '/index.html', 'cli/server/RoutingServer.js:771', 'explorer', 'Same static-agent redirect as /.');
add('auth-login', 'GET', '/auth/login', 'cli/server/authHandlers/authRoutes.js:172', 'public', 'Begins generation-bound SSO PKCE login; requires browser binding on callback. Query agent/returnTo/prompt. Login state creation only, no account claim.');
add('auth-callback', 'GET', '/auth/callback', 'cli/server/authHandlers/authRoutes.js:223', 'public', 'Only verified, bound SSO callback may establish identity. Invalid/unverified state must not claim administrator. Real registration lives in UserPersisto additional server.', { gap: 'Successful callback exercised by fixture creation; isolated bootstrap cases owned by UserPersisto tests.' });
add('auth-logged-out', 'GET', '/auth/logged-out', 'cli/server/authHandlers/authRoutes.js:160', 'public', 'Informational page; normalizes next to relative path.');
add('auth-logout-confirmation', 'GET', '/auth/logout', 'cli/server/authHandlers/authRoutes.js:280', 'public', 'Confirmation only for current session; no-session response is logged-out page.');
add('auth-logout', 'POST', '/auth/logout', 'cli/server/authHandlers/authRoutes.js:280', 'session', 'Existing session logout requires Origin/CSRF and current generation; no-session page is idempotent.', { gap: 'Use a disposable fixture session and verify revocation afterward.' });
add('auth-token', 'GET', '/auth/token', 'cli/server/authHandlers/authRoutes.js:383', 'session', 'Returns current persisted/provider user, browser mutation proof and private tokens. Readable by selfRegistered to support access-request dashboard. Never record response values.');
add('auth-token-refresh', 'POST', '/auth/token', 'cli/server/authHandlers/authRoutes.js:417', 'session', 'refresh boolean, browser Origin + bound CSRF required; stale/revoked provider session must not gain access.', { gap: 'Session fixture owns refresh/revocation checks.' });
add('removed-auth-account', '*', '/auth/account', 'cli/server/authHandlers/authRoutes.js:205', 'private', 'Deliberately removed: 404 local_auth_disabled for every role. 404 is removal evidence only.');
add('removed-auth-local-users', '*', '/auth/local-users', 'cli/server/authHandlers/authRoutes.js:210', 'private', 'Deliberately removed: 410 local_users_endpoint_removed.');
add('removed-auth-github', '*', '/auth/github/*', 'cli/server/authHandlers/authRoutes.js:219', 'private', 'Deliberately removed: 404 github_auth_removed; do not contact GitHub OAuth.');
add('removed-auth-agent-token', 'POST', '/auth/agent-token', 'cli/server/authHandlers/authRoutes.js:501', 'private', 'Deliberately removed: 410 agent_token_flow_removed.');
add('users-list', 'GET', '/api/agents/:agent/users', 'cli/server/authHandlers/userAdminRoutes.js:259', 'admin', 'forceRemote SSO validation plus admin.users.manage; supports bounded pagination and search/role filters. Each enabled alias may own this surface.');
add('users-create', 'POST', '/api/agents/:agent/users', 'cli/server/authHandlers/userAdminRoutes.js:304', 'admin', 'admin.users.manage and exact control/browser CSRF. Provider may disallow account creation; real public registration is a separate flow.', { gap: 'No real-user creation or password assignment; only test-owned fixture when provider supports it.' });
add('users-update', 'PATCH', '/api/agents/:agent/users/:userId', 'cli/server/authHandlers/userAdminRoutes.js:327', 'admin', 'Can change username/name/displayName/email/roles as supported by provider. Non-admin role spoof and horizontal target must fail before mutation.', { gap: 'Requires valid disposable existing user, positive control and persisted after-check.' });
add('users-delete', 'DELETE', '/api/agents/:agent/users/:userId', 'cli/server/authHandlers/userAdminRoutes.js:352', 'admin', 'Provider delete; admin.users.manage, CSRF, lease. Never delete a non-fixture account.', { gap: 'Fixture cleanup only; no broad deletion.' });
add('removed-settings', '*', '/api/agents/:agent/settings', 'cli/server/authHandlers/userAdminRoutes.js:173', 'private', 'Reserved removed route returns 404 before session resolution; provider settings live in UserPersisto.');
add('marketplace-read', 'GET', '/api/marketplace', 'cli/server/authHandlers/marketplaceRoutes.js:510', 'session', 'All authenticated roles can discover catalog; canManage derives from real administrator. Assertion callers require bound marketplace-read authority. Audit skillSource.source/origin, manifestPath, pid and containerName separately from catalog access.');
for (const action of ['install_repo', 'uninstall_repo', 'enable_agent', 'disable_agent']) {
  add(`marketplace-${action}`, 'POST', '/api/marketplace', 'cli/server/authHandlers/marketplaceRoutes.js:534', 'admin', `Body action=${action}. Browser admin + Origin/CSRF. A verified agent may only enable installed agents with dedicated assertion.`, { body: { action }, gap: 'Lifecycle/global repository operations require valid disposable ownership and positive control; never run against a business runtime.' });
}
for (const command of ['http.route.list', 'http.route.check', 'http.route.set', 'http.route.remove', 'mcp.policy.list', 'mcp.policy.get', 'mcp.policy.set']) {
  const mutates = ['http.route.set', 'http.route.remove', 'mcp.policy.set'].includes(command);
  add(`policy-${command}`, 'POST', '/policy/command', 'cli/server/policy/PolicyCommandInvoker.js:39', 'admin', `command=${command}. Invoker rejects ALL non-admin sessions before command dispatch (including obsolete share-authorizer branches). ${mutates ? 'Origin and administrator CSRF required.' : 'Read-only command; CSRF not required.'}`, { body: { command }, ...(mutates ? { gap: 'Disposable policy entry only; no broad/global authorization policy mutation.' } : {}) });
}
add('health', 'GET', '/health', 'cli/server/RoutingServer.js:644', 'admin', 'Only healthy summary on TCP; detailed health is Unix-only.');
add('status', '*', '/status/data', 'cli/server/handlers/status.js:80', 'admin', 'Handler accepts any HTTP method after Router gates; returns runtime metadata. Probe GET; other method behavior is a separate coverage obligation.');
add('status-follow', 'GET', '/status/data?follow=1', 'cli/server/handlers/status.js:94', 'admin', 'NDJSON subscription. Initial admin check; streamWorkspaceMetrics defaults isAuthorized to always true here. Live stale/revoked-session continuation needs dedicated test.', { transport: 'ndjson', gap: 'Bounded stream authorization and post-revocation continuation check.' });
add('identity-user-key', 'POST', '/api/router/identity/user-api-key', 'cli/server/userIdentityKeyRoute.js:21', 'explorer', 'User key subject derives from real caller; non-admin body.userId is ignored; administrator can request another subject. Never persist returned key.', { gap: 'Compare returned subjectId to current principal and a valid second fixture user.' });
add('openai-agent-discovery', 'GET', '/api/router/openai-agent-discovery', 'cli/server/openAiAgentDiscovery.js:194', 'private', 'Browser session neither necessary nor sufficient. Exact HTTP Agent Assertion, audience, request hash, active identity and replay cache; no signed agent credentials borrowed for testing.', { gap: 'Browser/forged assertion rejection only; positive assertion and replay covered by isolated unit/integration tests.' });
add('agent-card', 'GET', '/agent-card', 'cli/server/RoutingServer.js:332', 'public', 'Public aggregate of enabled agent cards; /agent-card/ alias. Inspect cards for private secrets and runtime paths. Fanout transport failures are not authorization success.');
add('agent-card-slash', 'GET', '/agent-card/', 'cli/server/RoutingServer.js:332', 'public', 'Alias of public aggregate card.');
add('mcp-browser-client', 'GET|HEAD', '/MCPBrowserClient.js', 'cli/server/RoutingServer.js:466', 'public', 'Public SDK asset; handled before session authentication.');
add('web-libs', 'GET|HEAD', '/web-libs/:asset', 'cli/server/static/index.js:544', 'public', 'Confined public library assets; traversal/private-file probes require actual existing asset positive control.');
for (const method of ['initialize', 'notifications/initialized', 'tools/list', 'tools/call', 'resources/list', 'resources/read', 'ping']) {
  add(`mcp-rpc-${method}`, 'POST', '/mcp', 'cli/server/routerHandlers.js:1037', 'explorer', `JSON-RPC ${method}; /mcp/ alias. Discovery and invocation apply persisted MCP access tags; admin tools excluded for user, internal tools excluded for every browser role. Resources are authenticated-class without per-resource policy.`, { rpcMethod: method, gap: method === 'tools/call' || method === 'resources/read' ? 'Every concrete tool/resource needs valid arguments/resource, policy expectation, and side-effect check.' : undefined });
}
for (const command of ['methods', 'list_tools', 'tools', 'list_resources', 'resources', 'tool', 'resources/read', 'status', 'ping']) {
  add(`mcp-legacy-${command}`, 'POST', '/mcp', 'cli/server/routerHandlers.js:753', 'explorer', `Executable command alias ${command}; same policy as JSON-RPC. Maintain coverage of command aliases independently.`, { body: { command }, gap: 'Legacy command aliases may not all receive live probes.' });
}
add('mcp-session-delete', 'DELETE', '/mcp', 'cli/server/routerHandlers.js:1210', 'explorer', 'Deletes mcp-session-id from aggregate session map; inspect cross-user protocol-session ownership with two initialized disposable sessions.', { gap: 'Horizontal deletion of MCP protocol session requires two valid session IDs.' });
add('mcp-sse-unsupported', 'GET', '/mcp', 'cli/server/routerHandlers.js:1204', 'explorer', 'Authenticated request returns 405 event_stream_not_supported; this explicitly proves no aggregate SSE transport, not successful authorization to a stream.');
add('webtty-ui', 'GET', '/webtty', 'cli/server/handlers/webtty.js:196', 'admin', 'Administrator-only terminal UI; /webtty/ alias. Availability failure is not an authorization result.');
add('webtty-ui-slash', 'GET', '/webtty/', 'cli/server/handlers/webtty.js:196', 'admin', 'Terminal UI alias.');
add('webtty-assets', 'GET', '/webtty/assets/:asset', 'cli/server/handlers/webtty.js:207', 'admin', 'Only fixed allowlisted terminal assets after administrator gate.');
add('webtty-discover', 'POST', '/webtty/target-discoveries', 'cli/server/handlers/webtty.js:225', 'admin', 'Body {dir}; administrator plus browser CSRF, owned runtime discovery. Creates bounded launch records.', { gap: 'Disposable directory and runtime ownership required; do not start optional unavailable backend as a bypass.' });
add('webtty-discovery-delete', 'DELETE', '/webtty/target-discoveries/:discoveryId', 'cli/server/handlers/webtty.js:250', 'admin', 'Cancels owned discovery; generation/session ownership + CSRF.', { gap: 'Requires existing test-owned discovery.' });
add('webtty-create', 'POST', '/webtty/sessions', 'cli/server/handlers/webtty.js:268', 'admin', 'Body {launch,cols,rows}; single-use 32-character launch proof; exact session/generation binding + CSRF.', { gap: 'Positive control opens a shell; dedicated fixture cleanup mandatory.' });
add('webtty-stream', 'GET', '/webtty/sessions/:sessionId/stream', 'cli/server/handlers/webtty.js:304', 'admin', 'SSE after validateOwnership; last-event-id replay is scoped to terminal session.', { transport: 'sse', gap: 'Existing owned terminal plus second-account ownership/revocation probe.' });
add('webtty-input', 'POST', '/webtty/sessions/:sessionId/input', 'cli/server/handlers/webtty.js:326', 'admin', 'Body {data}; administrator, Origin/CSRF, exact session ownership. Arbitrary shell input must never be reachable by ordinary roles.', { gap: 'Existing fixture terminal; bounded harmless marker only.' });
add('webtty-resize', 'POST', '/webtty/sessions/:sessionId/resize', 'cli/server/handlers/webtty.js:351', 'admin', 'Body {cols,rows}; administrator/session ownership/CSRF.', { gap: 'Existing fixture terminal required.' });
add('webtty-delete', 'DELETE', '/webtty/sessions/:sessionId', 'cli/server/handlers/webtty.js:375', 'admin', 'Closes owned terminal only, with CSRF.', { gap: 'Fixture cleanup only.' });
add('webchat-ui', 'GET', '/webchat/', 'cli/server/handlers/webchat/index.js:151', 'explorer', 'Also /webchat and /webchat/index.html. agent query can change auth/service-route selection and command factory; enforce both selected route required capabilities.');
add('webchat-ui-no-slash', 'GET', '/webchat', 'cli/server/handlers/webchat/index.js:151', 'explorer', 'No-trailing-slash WebChat entrypoint alias.');
add('webchat-index', 'GET', '/webchat/index.html', 'cli/server/handlers/webchat/index.js:151', 'explorer', 'Explicit WebChat entrypoint alias.');
add('webchat-assets', 'GET', '/webchat/assets/:asset', 'cli/server/handlers/webchat/index.js:89', 'explorer', 'Router authenticates/capability-checks before UI assets.');
add('webchat-removed-token-auth', 'POST', '/webchat/auth', 'cli/server/handlers/webchat/index.js:79', 'explorer', 'After Router auth/CSRF returns 410 surface_token_auth_removed.');
add('webchat-logout', 'POST', '/webchat/logout', 'cli/server/handlers/webchat/index.js:87', 'explorer', 'Browser CSRF; closes subscriptions associated with webchat_sid and deletes UI session.', { gap: 'Disposable WebChat UI session; do not log out shared admin during other probes.' });
add('webchat-suggestions', 'GET|HEAD', '/webchat/suggestions/files', 'cli/server/handlers/webchat/index.js:118', 'explorer', 'Workspace file index scoped by dir/agent query; test private path and traversal controls.');
add('webchat-upload', 'POST|PUT', '/webchat/uploads', 'cli/server/handlers/webchat/index.js:122', 'explorer', 'Router browser CSRF plus workspace upload confinement/admission; disposable marker only.', { gap: 'Fixture upload ownership, private paths and cleanup required.' });
add('webchat-directories-list', 'GET|HEAD', '/webchat/directories', 'cli/server/handlers/webchat/index.js:135', 'explorer', 'Workspace directory listing; dir query is not itself an authorization boundary.');
add('webchat-directories-create', 'POST', '/webchat/directories', 'cli/server/handlers/webchat/index.js:140', 'explorer', 'CSRF and confined upload directory creation.', { gap: 'Test-owned directory with after-check/cleanup required.' });
add('webchat-task-view', 'GET', '/webchat/tasks/:taskId/view', 'cli/server/handlers/webchat/taskRoutes.js:11', 'explorer', 'task_[24 hex] path serves a generic view template. A 200 template does not prove access to task data.');
add('webchat-stream', 'GET', '/webchat/stream', 'cli/server/handlers/webchat/runtimeRoutes.js:73', 'explorer', 'SSE startup can instantiate runtime; parameters select workspace/runtime/tab/task. This is not a harmless read.', { transport: 'sse', gap: 'Only disposable runtime; two-user runtime/task isolation and revoked active stream need dedicated fixture.' });
for (const [name, line] of [['input', 243], ['control', 319], ['interaction', 348]]) add(`webchat-${name}`, 'POST', `/webchat/${name}`, `cli/server/handlers/webchat/runtimeRoutes.js:${line}`, 'explorer', 'Browser CSRF; runtime/task selection and UI-session association must not permit another account to inject commands or task decisions.', { gap: 'Existing test-owned runtime and positive control; no arbitrary commands in shared work.' });
add('workspace-upload', 'POST|PUT', '/upload?path=:path', 'cli/server/handlers/blobs.js:396', 'explorer', 'Confined workspace raw upload; overwrites existing destination after CSRF. No per-user owner in handler; shared workspace semantics must not expose private Explorer/DPU paths.', { gap: 'Disposable marker only; test private/encoded path confinement and side effects.' });
add('blob-shared-create', 'POST', '/blobs', 'cli/server/handlers/blobs.js:450', 'explorer', 'Creates blob in shared record; input admission and CSRF.', { gap: 'Disposable blob fixture and cleanup.' });
add('blob-agent-create', 'POST', '/blobs/:agent', 'cli/server/handlers/blobs.js:459', 'explorer', 'Creates blob in selected enabled agent storage; no per-user ownership in this handler.', { gap: 'Disposable blob fixture for a valid enabled agent.' });
add('blob-shared-read', 'GET|HEAD', '/blobs/:blobId', 'cli/server/handlers/blobs.js:474', 'explorer', 'Reads shared blob, not an account-private object. Valid fixture ID is mandatory.');
add('blob-agent-read', 'GET|HEAD', '/blobs/:agent/:blobId', 'cli/server/handlers/blobs.js:484', 'explorer', 'Reads agent-scoped blob; no per-user ownership in this handler. Do not claim account isolation from an unknown ID.');
add('workspace-file-read', 'GET|HEAD', '/workspace-files/:path', 'cli/server/static/index.js:507', 'explorer', 'Confined workspace static file access, with private-prefix and symlink controls. Handler itself has no method guard; Router mutation proof precedes unsafe methods.');
add('agent-root-proxy', '*', '/:routeKey/*', 'cli/server/RoutingServer.js:433', 'route', 'Every route registry key is a proxy alias. Active-generation route policy and requiredCapability; static attempt precedes upstream proxy. Canonical source agent name is not an extra alias unless actually registered. Manifest handlers must be inventoried separately.', { gap: 'Expanded from live runtime + each deployed manifest/handler inventory.' });
add('agent-static', 'GET|HEAD', '/:routeKey/:staticPath', 'cli/server/static/index.js:668', 'route', 'Served only after route auth, using declared static source root; public asset exceptions derive from manifest policy, not file extension alone.', { gap: 'Expand real static roots/public exceptions and test existing fixtures.' });
add('agent-mcp', 'POST|DELETE|GET', '/:routeKey/mcp', 'cli/server/RoutingServer.js:742', 'route', 'Browser route/capability then per-tool policy; Bearer delegates to verified assertion flow. Subpath /mcp/ accepted by dispatcher. Reconcile tools/config/handlers separately.');
add('agent-task-status', 'GET', '/:routeKey/task?taskId=:taskId', 'cli/server/RoutingServer.js:604', 'route', 'readAuthenticatedAgentTask performs authenticated provider call; delegated bearer uses task-bound assertion. Also /getTaskStatus.', { gap: 'Existing account-owned task and second same-role account required.' });
add('agent-task-status-alias', 'GET', '/:routeKey/getTaskStatus?taskId=:taskId', 'cli/server/RoutingServer.js:604', 'route', 'Alias of /task with identical ownership requirement.');
add('agent-task-cancel', 'POST', '/:routeKey/task/cancel', 'cli/server/RoutingServer.js:546', 'route', 'Delegated assertion path-exact bypass; browser falls through route auth/CSRF. Task ownership must be enforced.', { gap: 'Existing test-owned task; no business-task cancellation.' });
add('agent-openai', 'POST', '/:routeKey/v1/chat/completions', 'cli/server/RoutingServer.js:589', 'route', 'Path-exact delegated-agent assertion branch; browser remains route-authenticated. Malformed/forged delegation must never bypass.', { gap: 'No paid/external model calls; local positive backend only if available.' });
add('agent-additional-http', '*', '/base-agent-additional-server/:routeKey/:port/*', 'cli/server/edgeRoutePlan.js:182', 'route', 'Exact canonical selector, declared endpoint/port, active container/generation/lease, route policy, capability and trusted identity header rewriting. Includes public UserPersisto/OnlyOffice/provider callbacks defined by manifests.', { gap: 'Expand every declared additional server + all its handlers. Never connect directly to agent ports.' });
add('agent-startup-probe', 'GET', '/:routeKey/*', 'cli/server/agentStartupPage.js:158', 'route', 'X-Ploinky-Agent-Startup-Probe: 1 selects readiness/state response on the same agent-root route. Must apply captured policy/capability before any on-demand lifecycle observation.', { gap: 'Exercise enabled and disabled/on-demand route states without starting a non-fixture optional runtime.' });
add('agent-root-websocket', 'GET', '/:routeKey/*', 'cli/server/RoutingServer.js:955', 'route', 'Upgrade with exact route policy, session/capability and generation; route must support WS. 404/failed upgrade is not authorization proof.', { transport: 'websocket', gap: 'Existing valid live endpoint + successful authorized handshake required.' });
add('agent-additional-websocket', 'GET', '/base-agent-additional-server/:routeKey/:port/*', 'cli/server/RoutingServer.js:982', 'route', 'Same selector/policy as HTTP; executeWebSocketPlan strips forged identity and applies Origin protections.', { transport: 'websocket', gap: 'Valid declared WS endpoint and authorized handshake required.' });
add('internal-agent-control', '*', '/*/__agent/*', 'cli/server/RoutingServer.js:481', 'private', 'Any literal or repeatedly percent-encoded __agent segment is refused on public listener before proxy. Expected 404 intentionally conceals control route. This is boundary evidence, not a negative check against a missing endpoint.');
for (const [id, method, path, line] of [
  ['private-workspace-logs', 'POST', '/api/edge/workspace-logs', 689],
  ['private-workspace-metrics', 'GET', '/api/edge/workspace-metrics?follow=1', 707],
  ['private-turn-credentials', 'POST', '/api/edge/turn-credentials', 725],
]) add(id, method, path, `cli/server/edgeRoutePlan.js:${line}`, 'private', 'Private listener only, generation-bound agent assertion, ACL and replay. Public TCP has no handler; user roles including admin cannot use private API.', { gap: 'Only public-boundary negative probe; never expose/connect private 8081 or borrow agent credentials.' });
for (const path of ['/metrics', '/health/internal', '/admin', '/admin/*']) add(`reserved-${path.replaceAll('/', '-')}`, '*', path, 'cli/server/RoutingServer.js:251', 'private', 'Reserved/router-owned name, but no executable public handler. Not counted as a tested live authorization endpoint.');
add('unix-health', 'GET', '/health', 'cli/server/RoutingServer.js:926', 'private', 'Separate detailed-health Unix listener, never public TCP. This row documents a different transport from the authenticated TCP health summary.', { transport: 'private-unix', gap: 'Do not connect to or expose private control socket; covered by Router authority isolated tests.' });
add('unix-authority-create', 'POST', '/authority-attestations', 'cli/server/routerAuthorityAttestationRegistry.js:275', 'private', 'Detailed-health Unix listener only; register generation-bound authority nonce. No public route.', { transport: 'private-unix', gap: 'Not exercised on deployed private Unix surface.' });
add('unix-authority-read', 'GET', '/authority-attestations/:nonce', 'cli/server/routerAuthorityAttestationRegistry.js:317', 'private', 'Detailed-health Unix listener only; fetch live authority observation for registered nonce. No public route.', { transport: 'private-unix', gap: 'Not exercised on deployed private Unix surface.' });

export const routerInventory = Object.freeze(rows.map(row => Object.freeze(row)));

export const routerAuthorizationOrder = Object.freeze([
  'Exact Host + origin-form request target; select public/managed interface and immutable edge snapshot.',
  'Resolve canonical agent-root/additional-server plan and commit generation before side effects/dial.',
  'Public SDK/library and aggregate card exceptions; refuse any __agent control segment.',
  'Auth/user-admin/marketplace/policy/agent-discovery dispatch with dedicated security checks.',
  'Authorize no-wait/on-demand startup before runtime lifecycle observation.',
  'Browser session or narrowly scoped verified delegation; HTTP route policy + required capability.',
  'Owner-bound task status; real administrator for health/status/terminal; mutation Origin + CSRF.',
  'Additional server relay with sanitized untrusted headers and trusted current principal.',
  'Router file/WebChat/MCP handlers or agent static/proxy; MCP invocation applies per-tool policy.',
  'WS uses separate upgrade dispatch with matching generation/auth policy; stream revalidation is endpoint-specific.',
]);
