# Router source reference review, 2026-10-28

Reviewer scope: the reviewed-registry addition to `router-reference-obligations.json` for `cli/server/edgeRoutePlan.js` after the execution-provider routing change (provider-port denial, coordinator-path denial and the reserved `/task-refs` mount). The registry change is one added blob; `schema`, `priorInventories`, `canonical`, every existing blob and every existing `baseline`/`candidate` pointer are unchanged.

## Drift

Base: `[]`. Candidate (`edgeRoutePlan.js` SHA-256 `0fd2eab9a31846961a1854827128ce61152ec7a99f52b11cb727ea85ac86f353`, last reviewed blob `091c5b89...`): the five rows `agent-additional-http.*`, `private-workspace-logs.post`, `private-workspace-metrics.get`, `private-runtime-origins.get`, `private-turn-credentials.post`. `RoutingServer.js`, `handlers/webtty.js` and `handlers/webchat/runtimeRoutes.js` are byte-identical to base. Without this registry addition the harness goes from 285/2 fail/1 skip to 9 fail; the 7 new failures are all drift-caused (three router-source-drift tests, the inventory identity, union and stale-metadata tests, and the Live Sessions overlay test, whose count falls back to the historical-only inventory).

## Behavior of the changed file

| Change in edgeRoutePlan.js | Effect |
|---|---|
| `agentPortPlan`: provider denial after the denied-port parse, before the relay opt-out and every access decision | Only tightens `agent-additional-http.*`: whole provider port (also another host-network route's selector to a host-network provider's port), declared coordinator scope (matched ignoring case and `;parameters` of each request segment; declared coordinator paths may not contain `;`, and the declared segments are folded the same way as defence), malformed declaration. Other routes plan as before. |
| `agentRootPlan`: denial after route resolution, before the policy decision | Same refusals for agent-root, the root-application owner mount and the WebSocket root proxy, plus a host-network route whose own target is a host-network provider's port. |
| `resolveEdgeRoutePlan`: `/task-refs` reservation after host classification, before `agentPortPlan` and the private branch | `/task-refs` and its encoded or undecodable-tail spellings answer 503 `task_reference_unavailable` on every listener. **Private listener: `/task-refs*` changes from 404 `PRIVATE_ROUTE_SURFACE_DENIED` to 503.** The four `private-*` operations are unchanged. |
| two `export` keywords, one bottom import | No behavior change. |

No dispatch statement of the five registered rows changed; only line numbers shift (see the JSON).

## Exact bytes

The added blob registers the five rows at lines 196, 822, 840, 858 and 879 of `edgeRoutePlan.js` SHA-256 `0fd2eab9a31846961a1854827128ce61152ec7a99f52b11cb727ea85ac86f353`, each statement equal to the trimmed line and each anchor occurring on it. `routerSourceDrift()` reports 5 entries without the blob and `[]` with it. Any further edit to `edgeRoutePlan.js` requires a new blob.

## New obligations: deferred

Adding rows to `routerInventoryBaseline` would break `normalizeRouterInventory`'s row-count equality with every `priorInventories` stage, so the obligations below are not added as rows; the registry change adds the blob only. They are recorded in this note and are to be added later under a new `priorInventories` stage. Each is covered by named tests (all in `tests/unit`):

| Obligation | Tests |
|---|---|
| provider port denied for any caller, listener, transport, including host-network sibling selectors and root applications | `executionProviderRouting`: "a baseline external provider-port route is usable until the declaration denies the whole port...", "the provider port is denied through every root alias...", "host network: another host-network agent cannot reach a host-network provider port, directly or as a root application" |
| coordinator scopes unavailable on every request-derived planner | "coordinator paths are unavailable on every planner, listener and transport, including encoded spellings", "coordinator matching ignores case and ;parameters...", "the WebSocket root proxy closes a coordinator or task-reference upgrade without dialing" |
| `/task-refs` reserved incl. encoded and undecodable spellings; `/task-refs-extra` unrelated | "the reserved task-reference mount precedes every dispatch...", "undecodable spellings cannot hide the reserved task-reference mount (HTTP and WebSocket)" |
| malformed declaration or unresolvable routed root denies the route | "a malformed active declaration denies the route in the agent-port and agent-root planners", "agent-root denies a routed root that is the provider port or cannot be resolved" |
| internal planner: fixed grammar, no request input, lease rechecked at checkout and OPEN, relay opt-out does not remove the contract | `executionProviderEndpointPlan` tests "the operation grammar is fixed...", "a generation change before checkout...", "...between checkout and OPEN...", and `executionProviderRouting` "coordinator matching ignores case..." (relay opt-out part) |
