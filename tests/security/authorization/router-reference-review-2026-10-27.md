# Router source reference review, 2026-10-27

Reviewer scope: the reviewed-registry addition to `router-reference-obligations.json` for `cli/server/RoutingServer.js` after the Router-authored pre-forward refusal marker (`X-Ploinky-Refusal`). The registry change is one added blob; `schema`, `priorInventories`, `canonical`, every existing blob and every existing `baseline`/`candidate` pointer are unchanged.

## Blob hash

| File | Last registered | Registered now |
| --- | --- | --- |
| RoutingServer.js | d0197d13 | 1e5d6a45 (the marker change on top of the bytes that hash to d0197d13) |

## What changed in RoutingServer.js

Only response headers. The change adds one import (`refusalHeaders`, `routeRefusalCause` from `./proxy/refusalMarker.js`), spreads `refusalHeaders('route', ...)` into the header argument of the route-plan refusal and of seven stale-lease 503 answers that are written before anything is dispatched, and expands the route-plan refusal's header literal over six lines (a five-line growth). One stale-lease answer, after the agent-card fan-out, is deliberately left unmarked. No dispatch statement, guard, access decision, status code or response body changes.

## Per-row evidence

All 23 registered rows keep their statement and their anchor unchanged. Every row shifts by exactly +6 lines: the import adds one line and the route-plan refusal expansion adds five, both above every registered row (the lowest old line is 502). The new line of each row was checked two ways, by diff-mapping the old line to the new bytes and by asserting that the registered statement equals the trimmed line at the new line and that the anchor occurs on it.

| Row id | Old line | New line | Statement (unchanged) |
| --- | --- | --- | --- |
| root.get | 807 | 813 | `if (pathname === '/' \|\| pathname === '/index.html') {` |
| root-index.get | 807 | 813 | `if (pathname === '/' \|\| pathname === '/index.html') {` |
| health.get | 680 | 686 | `if (pathname === '/health') {` |
| agent-card.get | 767 | 773 | `return handleRoutedAggregateAgentCard(req, res, routePlan);` |
| agent-card-slash.get | 767 | 773 | `return handleRoutedAggregateAgentCard(req, res, routePlan);` |
| mcp-browser-client.get | 502 | 508 | `if (pathname === '/MCPBrowserClient.js') {` |
| mcp-browser-client.head | 502 | 508 | `if (pathname === '/MCPBrowserClient.js') {` |
| agent-root-proxy.* | 768 | 774 | `} else if (agentName && isActiveAgentRootPlan(routePlan)) {` |
| agent-mcp.post | 777 | 783 | `if (isAgentMcpRoute) {` |
| agent-mcp.get | 777 | 783 | `if (isAgentMcpRoute) {` |
| agent-mcp.delete | 777 | 783 | `if (isAgentMcpRoute) {` |
| agent-task-status.get | 640 | 646 | `&& isAgentTaskStatusProxyPath(agentProxyPath)` |
| agent-task-status-alias.get | 640 | 646 | `&& isAgentTaskStatusProxyPath(agentProxyPath)` |
| agent-task-cancel.post | 581 | 587 | `} else if (isDelegatedAgentTaskCancelRoute) {` |
| agent-openai.post | 784 | 790 | `return handleDelegatedAgentOpenAiCall(req, res, route, agentName, agentProxyPath, {` |
| agent-root-websocket.get | 1067 | 1073 | `const handled = await handleAgentRootUpgrade({ req, socket, head, parsedUrl: routePlan.parsedUrl, routePlan });` |
| agent-additional-websocket.get | 1029 | 1035 | `if (routePlan.kind === 'agent-port') {` |
| internal-agent-control.* | 517 | 523 | `if (hasInternalAgentSegment(pathname)) {` |
| reserved--metrics.* | 819 | 825 | `return res.end('Not Found');` |
| reserved--health-internal.* | 819 | 825 | `return res.end('Not Found');` |
| reserved--admin.* | 819 | 825 | `return res.end('Not Found');` |
| reserved--admin-*.* | 819 | 825 | `return res.end('Not Found');` |
| unix-health.get | 980 | 986 | `sendJsonResponse(res, 200, detailedHealthData(), { 'Cache-Control': 'no-store' });` |

The dispatch code around each row was not modified, so each retained obligation holds as reviewed on 2026-10-22 (the base blob d0197d13 is reviewed in router-reference-review-2026-10-22.md): control-host behaviour, session-auth order and reserved-path denial are untouched.
