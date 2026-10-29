# Router source reference review, 2026-10-28 (task-reference admission hop)

Reviewer scope: the reviewed-registry addition to `router-reference-obligations.json` for `cli/server/RoutingServer.js`, `cli/server/edgeRoutePlan.js` and `cli/server/handlers/webchat/runtimeRoutes.js` after the coordinator admission hop, the task-reference descriptor and operation routes, MCP origin delivery and the `runtime-open` envelope. The registry change is three added blobs; `schema`, `priorInventories`, `canonical`, every existing blob and every existing `baseline`/`candidate` pointer are unchanged. It follows the earlier review of the same date (`router-reference-review-2026-10-28.md`).

## Drift

Pre-S3a integrated candidate (S2 + S6a + the 2026-10-28 amendment): `[]`. Final S3a bytes without this registry addition: 32 `UNREVIEWED_ROUTER_SOURCE` entries: 23 rows of `cli/server/RoutingServer.js` (SHA-256 `3c3b3a3322c631e134620c708cda9afef99243128518cb553804622b8c4a99f4`), 5 of `cli/server/edgeRoutePlan.js` (`aa6096ea892dff2000d3e904e8610a0dda5ecbf924dbfbab1e125b56e298d924`) and 4 of `cli/server/handlers/webchat/runtimeRoutes.js` (`20ae2046864f43cfb14359ae4307f05e0cb9ecb43cf31cc3bd0d82602be5c123`, unchanged since r1). Without this registry addition the authorization harness reports 7 failures, all drift-caused.

With the three blobs registered, `routerSourceDrift()` returns `[]` and the authorization harness reports 285 tests, 284 pass, 0 fail, 1 skip. The skip is the base skip: the RoboFlow and RoboTeam probes need the perf-lanes AssistOSExplorer checkout.

## Behavior of the changed registered files

| File | Change | Effect on registered rows |
|---|---|---|
| `edgeRoutePlan.js` | `agentPortPlan` passes `listener, transport, req` to `providerAgentPortDenial` (line 270). The S2 reserved-mount denial becomes `taskReferenceRoutePlan(...)` (lines 805-806), which also receives the request's canonical forwarding metadata (`canonicalForwardingMetadata`), so a browser POST is bound to its routed origin by the mutation proof. The import moves to the bottom. | `agent-additional-http.*`: on the private listener, over HTTP, without `Upgrade`, an exact declared coordinator scope now plans. The private step then admits only declared coordinator principals, verifies an optional owner grant (source, target, tool, `execution:owner`, signed lifetime at most 30 s, no `jti` consumed) and signs the forward. Every other listener, transport and spelling still gets `coordinator_route_unavailable`. `/task-refs`: only the exact canonical spelling of the five operations plans, as kind `task-reference`, on every listener and over HTTP only. A known shape with a malformed id or events query gets 400; a wrong method gets 405; every other spelling (encoded, undecodable, dot or empty segments, unknown shape, upgrade) still gets 503 `task_reference_unavailable`. It still precedes agent-port, private-operation and root-application dispatch. The four `private-*` rows are unchanged. |
| `RoutingServer.js` | Public: before the agent-port forward (lines 728-730), a `task-reference` plan goes to `handleTaskReferenceRequest`. That is after the session gate and the browser mutation proof, which therefore apply to POST control and lookup. The gate now resolves a `task-reference` plan to the workspace user session (`authContext.js` `resolveTaskReferenceAuthContext`) whatever `routing.static` names. Private: before any body is read (lines 872-877), a `task-reference` plan goes to the same handler instead of `authorizePrivateRoutePlan`; the handler reads at most 64 KiB. It verifies a `__task_ref__` agent assertion with replay protection, the caller's current enablement and its hardware availability. The assertion binds `{provider, op, id | originRequestId}`, plus the body's SHA-256 for control and lookup and the canonical query for events (interface §2.3, amended 2026-10-28). The private agent-port forward gains `trustedHeadersFactory` (line 955), a no-op for ordinary routes. Two imports are at the bottom. | No dispatch statement of a registered row changed. Rows after line 727 shift by 3 to 10 lines. The handler forwards only through `planProviderEndpoint` (fresh active generation, fixed grammar, runtime and lease checks, relay checkout recheck), with a provider-audience `__task_ref__` Router Request bound to method, path, query and body hash. The descriptor reuses `filterTools` visibility and returns one 404 body for hidden, unknown and unavailable-provider tools. |
| `handlers/webchat/runtimeRoutes.js` | Unchanged since r1: the `/stream` runtime creation registers the `runtime-open` announcer. | `webchat-stream.get` writes one signed hidden `runtime-open` envelope per runtime creation after `ready`. The other rows only shift lines. |

## Exact bytes

`gen/generate.mjs` maps every row of the reviewed pre-S3a blob of each file through a `git diff --no-index -U0` line map. The pre-S3a blobs are `RoutingServer.js` `1e5d6a45…` (HEAD), `runtimeRoutes.js` `90e8d42a…` (HEAD) and `edgeRoutePlan.js` `0fd2eab9…`. The last is the S2 bytes, reconstructed from the frozen r1 file with its one S3a line reverted; the generator checks that its hash is a reviewed blob. The generator refuses a row in any of three cases: its reviewed line changed, the trimmed final line differs from the reviewed statement, or the anchor is missing from the line. `generation-report.json` has every row.

| File | Rows | Reviewed line | New line | Statement occurrences |
|---|---|---|---|---|
| RoutingServer.js | `root.get`, `root-index.get` | 813 | 816 | 1 |
| RoutingServer.js | `health.get` | 686 | 686 | 1 |
| RoutingServer.js | `agent-card.get`, `agent-card-slash.get` | 773 | 776 | 1 |
| RoutingServer.js | `mcp-browser-client.get`, `mcp-browser-client.head` | 508 | 508 | 1 |
| RoutingServer.js | `agent-root-proxy.*` | 774 | 777 | 1 |
| RoutingServer.js | `agent-mcp.post`, `agent-mcp.get`, `agent-mcp.delete` | 783 | 786 | 1 |
| RoutingServer.js | `agent-task-status.get`, `agent-task-status-alias.get` | 646 | 646 | 2 (pre-existing duplicate) |
| RoutingServer.js | `agent-task-cancel.post` | 587 | 587 | 1 |
| RoutingServer.js | `agent-openai.post` | 790 | 793 | 1 |
| RoutingServer.js | `agent-root-websocket.get` | 1073 | 1083 | 1 |
| RoutingServer.js | `agent-additional-websocket.get` | 1035 | 1045 | 2 (pre-existing duplicate) |
| RoutingServer.js | `internal-agent-control.*` | 523 | 523 | 1 |
| RoutingServer.js | `reserved--metrics.*`, `reserved--health-internal.*`, `reserved--admin.*`, `reserved--admin-*.*` | 825 | 828 | 1 |
| RoutingServer.js | `unix-health.get` | 986 | 996 | 1 |
| runtimeRoutes.js | `webchat-stream.get` | 119 | 120 | 1 |
| runtimeRoutes.js | `webchat-input.post` | 294 | 300 | 1 |
| runtimeRoutes.js | `webchat-control.post` | 370 | 376 | 1 |
| runtimeRoutes.js | `webchat-interaction.post` | 399 | 405 | 1 |
| edgeRoutePlan.js | `agent-additional-http.*` | 196 | 196 | 1 |
| edgeRoutePlan.js | `private-workspace-logs.post` | 822 | 822 | 1 |
| edgeRoutePlan.js | `private-workspace-metrics.get` | 840 | 840 | 1 |
| edgeRoutePlan.js | `private-runtime-origins.get` | 858 | 858 | 1 |
| edgeRoutePlan.js | `private-turn-credentials.post` | 879 | 879 | 1 |

The duplicated statements had the same duplicates in the reviewed pre-S3a bytes. The line map, not a text search, selects the reviewed line. Any further edit to these three files requires regenerating the blobs.

## Observation: reserved mounts are case-sensitive

`/TASK-REFS/…` is not the reserved mount. Like every reserved Router mount (`/WEBCHAT/` behaves the same; `edgeRoutePlan.js` reserved-surface checks are case-sensitive), it falls through to ordinary dispatch. On a root-application host that means the root application; the wire verifier saw a 502 from the relay, with nothing reaching the task-reference provider. No change was made.

## New obligations: deferred, to be added under a new `priorInventories` stage

Adding rows to `routerInventoryBaseline` now would break the row-count equality that `normalizeRouterInventory` enforces with every `priorInventories` stage, so this registry change adds blobs only. The obligations below are introduced by S3a. Each is covered by named tests in `tests/unit`.

| Obligation (method, path, listener) | Expected policy | Tests |
|---|---|---|
| Coordinator scope on the private listener (`agent-additional-http.*`, exact declared path, HTTP) | private: declared coordinator principals only. Optional owner grant with source, target, tool, scope and a lifetime of at most 30 s; present-but-invalid is refused. The forward is signed `__coordinator_admission__`. Every other listener, transport and spelling: 503. | `coordinatorHop.test.mjs`: "private listener: only an exact declared coordinator scope over HTTP plans…", "coordinator-route ACL admits only the declared coordinator…", "a declared coordinator forward carries a provider-audience __coordinator_admission__ Router Request…", "owner grants are refused for a missing tool marker, expiry…", "owner grant lifetime: a valid 30-second grant is admitted; signed, unexpired 31 s and 3600 s grants are refused before forwarding", "a coordinator forward without recorded admission fails before the relay…", "a provider cannot declare its own /mcp endpoint as a coordinator route"; `executionProviderRouting.test.mjs` "coordinator paths are unavailable on every planner, listener and transport except the exact private HTTP hop, including encoded spellings" |
| `GET /webchat/stream` (`webchat-stream.get`) `runtime-open` | One signed envelope per runtime creation after `ready`, only for a declaring, envelope-forwarding agent. A browser envelope cannot set `event`. | `webchatRuntimeOpen.test.mjs`: "the runtime-open envelope is written exactly once per runtime creation…", "runtime-open: none for a failed startup…", "a browser envelope cannot produce the runtime-open event", "a respawn after a ready runtime closes yields exactly one runtime creation and one runtime-open; a failed close stays terminal" |
| `GET /task-refs/descriptor?agent=&tool=` (public session, private assertion) | session (non-guest) or private `__task_ref__` assertion. `filterTools` visibility. One 404 for hidden, unknown and unavailable-provider tools. Never contacts the provider. | `taskReferenceRoutes.test.mjs` "descriptor: a visible tool returns its provider; hidden, unknown and unavailable-provider tools share one 404" |
| `GET /task-refs/<provider>/<id>`, `GET …/<id>/events`, `POST …/<id>/control`, `POST /task-refs/<provider>/lookup` (public session, private assertion) | the workspace session (guests refused; the browser mutation proof on POST) or a private `__task_ref__` assertion bound to the operation, the control and lookup body hash and the events query, replay-protected, from an enabled and available caller; bodies at most 64 KiB. Forwarded only to the declared provider path and port, with a request-bound `__task_ref__` Router Request. Lookup carries the direct-caller `originKey`. | `taskReferenceRoutes.test.mjs`: "all four operations reach the declared provider path…", "lookup is bound to the verified direct caller…", "refusals never reach the provider…", "forged inbound auth-info and Authorization are not forwarded; private assertions are replay-protected and operation-bound", "a generation change before dispatch refuses the request without forwarding"; `taskReferenceRoutes.test.mjs` "private assertions bind the control and lookup body and the events query…", "a private task-reference body larger than 64 KiB is refused before authentication"; `taskReferenceRouter.test.mjs` "the real Router puts task-reference operations behind the session gate and keeps aliases reserved"; `taskReferenceRealRouter.test.mjs` "D2a: a browser session reaches read, events and descriptor without routing.static…", "D2b: POST control and lookup pass the browser mutation proof…", "guest: a guest-role session is refused…", "private listener: assertions bind the control body and events query (F3); bodies over 64 KiB are refused (R10)", and "real Router with routing.static: the session and the mutation proof behave the same" |
| `/task-refs` reservation and aliases (all listeners) | Non-canonical spellings: 503 `task_reference_unavailable`; malformed operations: 400; never dispatched to an agent or a root application | `executionProviderRouting.test.mjs` "the reserved task-reference mount precedes every dispatch on every listener, host and transport", "undecodable spellings cannot hide the reserved task-reference mount (HTTP and WebSocket)" |
| `POST /mcp` and `POST /<agent>/mcp` tools/call to a task-reference tool (not a new route; a new credential on existing rows) | A provider-bound 30 s origin token in trusted `x-ploinky-auth-info.taskRefOrigin`, minted from the serving agent's listing and the verified direct caller. Inbound auth-info is never forwarded. | `taskReferenceForwarding.test.mjs` (all five tests); `taskReferenceOrigin.test.mjs`; `taskReferenceRealRouter.test.mjs` "D1: pooled per-agent MCP calls deliver each caller its own origin token…" and "the debug logs of the Router and AgentServer contain no delivered token" |
