# Router source reference review, 2026-10-31: private runtime-sources route

Reviewer scope: the reviewed-registry addition to `router-reference-obligations.json` for `cli/server/edgeRoutePlan.js` and `cli/server/RoutingServer.js` after the private Router operation `GET /api/edge/runtime-sources` was registered. The registry change is two added blobs; `schema`, `priorInventories`, `canonical`, every existing blob and every existing `baseline`/`candidate` pointer are unchanged, and `router-inventory.mjs` is untouched.

## Blob hashes

| File | Last registered | Registered now |
| --- | --- | --- |
| edgeRoutePlan.js | ff2c0a93 (SHA-256 `ff2c0a93948815aa9c932908cad911a4910d929da54accb99f13a49a43cb59a2`) | 9c682810 (SHA-256 `9c682810dead1c2060853528e3b513f66809cc19d263f5622e1eee129105cf4d`) |
| RoutingServer.js | 9ebe45ad (SHA-256 `9ebe45ad3a6daad421fe80d008ae22b3bfd650b4ad54fd7d15e24a29e731853b`) | 900fc2c6 (SHA-256 `900fc2c6e2285fa6999838fc34b82d7a0b55d2571efe92f5cff16a51d2c01c3a`) |

Every other registered file is byte-identical to the previous registration. `privateRouter.js` and the new `runtimeSources.mjs` are not registered Router source files; their part is described below because the new branches delegate to them.

## What changed

| File | Change | Effect |
|---|---|---|
| edgeRoutePlan.js | A new `pathname === '/api/edge/runtime-sources'` branch of the private listener, placed after the `turn-credentials` branch (21 lines from line 914). | The exact `GET` whose raw target equals the bare path plans as the `private-operation` `runtime-sources`. Any other method, or any query (even an empty `?`), answers 400 `RUNTIME_SOURCES_REQUEST_INVALID`; dot-segment and other spellings do not match. The branch lies inside the private-listener block, so no other listener plans it. It sits below every registered row of this file, so no row moves. |
| RoutingServer.js | A `runtime-sources` branch of `processPrivateRequest` between `runtime-origins` and `workspace-metrics` (12 lines from line 939), and one bottom import of `sendRuntimeSources`. | After `authorizePrivateRoutePlan` (verified private agent assertion, current instance and enable generation, replay protection, exact method/path/body binding, and the ACL of `callerAclForPlan`), `sendRuntimeSources` builds the answer from the exact lease snapshot and revalidates the lease (`commitRoutePlan`) immediately before writing it; a stale generation answers 503 `edge_generation_changed`. The import sits at the bottom, as the file's comment requires. |
| privateRouter.js (not registered) | `callerAclForPlan` gains `runtime-sources`: `callers: sourceProtectionHolderCallers(plan.snapshot)`, `methods: ['GET']`, `paths: ['/api/edge/runtime-sources']`. | Only the exact current instances of agents whose effective manifest carries a valid `executionProvider` declaration may call it; any other current agent gets 403 `PRIVATE_CALLER_DENIED`. |
| runtimeSources.mjs (new, not registered) | The builder and sender. | Workspace-relative source roots from route `hostPath`s, `/code` and `/Agent` binds, link-install checkouts recorded at launch, the Router's own Ploinky root and the local AgentLib checkout; paths outside the workspace are only counted; a source equal to or containing the workspace root, malformed recorded data or an over-bound answer gives 503 and never a partial list. No child process; audit events carry counts only. |

No dispatch statement of the registered rows changed. `ROUTER_CONTRACT_DRIFT` is not involved: every contract digest, canonical source and anchor is as before.

## Per-row evidence

Rows whose line did not change are listed in the JSON only. The moved rows, each checked by asserting that the registered statement equals the trimmed line at the new line and that the anchor occurs on it (lines were mapped through the unchanged line blocks between the two blobs; `routerSourceDrift()` repeats the check on the checkout bytes):

| File | Row id | Old line | New line | Statement (unchanged) |
|---|---|---|---|---|
| RoutingServer.js | agent-root-websocket.get | 1099 | 1111 | `const handled = await handleAgentRootUpgrade({ req, socket, head, parsedUrl: routePlan.parsedUrl, routePlan });` |
| RoutingServer.js | agent-additional-websocket.get | 1061 | 1073 | `if (routePlan.kind === 'agent-port') {` |
| RoutingServer.js | unix-health.get | 1012 | 1024 | `sendJsonResponse(res, 200, detailedHealthData(), { 'Cache-Control': 'no-store' });` |

The 5 edgeRoutePlan.js rows and the other 20 RoutingServer.js rows keep their lines. With these blobs, `routerSourceDrift()` on the candidate reports the same 4 rows as on the base commit `de673ce8` (the unreviewed `handlers/webchat/runtimeRoutes.js` blob `54aec1f0`), and none for these two files.

## New obligation: deferred, as on 2026-10-29

The route is not added as an inventory row, for the reason the 2026-10-29 record gives: `normalizeRouterInventory` and `assertRouterInventoryObligations` require every `priorInventories` stage to have exactly the inventory's row count (128), which `router-source-drift.test.mjs`, `router-live-sessions-inventory.test.mjs` and `router-probes.test.mjs` also assert. A row needs a new stage and a change to those pass/fail checks, with its own review. The obligation is recorded here and covered by named tests in `tests/unit`.

| Obligation | Tests |
|---|---|
| `GET /api/edge/runtime-sources` plans only as the exact private operation; a query, another spelling, another method or a body is refused; the public and managed listeners never serve it | `runtimeSourcesOperation`: "AC7: a query, an alias spelling, another method or a body gets 400 before any source is computed" |
| reachable with the verified private identity of an execution-provider agent; a current agent without a declaration gets 403, an unsigned request 401 | "AC7: a non-holder current agent is refused with 403; an unsigned caller with 401" |
| the answer comes from the exact lease; a generation change before the reply gives 503 and no list | "AC7: a lease change before the reply, or a plan without the exact lease, gives 503 and no list" |
| content, counting of outside roots, and fail-closed 503 cases | "AC7: a holder reads the active sources …", "AC7 (F3 delta): a source equal to or containing the workspace root …", "AC7: a malformed recorded link-install list gives 503 …" |
| link-install sources are the ones each launch recorded, never re-resolved | "AC8: …" (two tests) |
| the agent-side reader validates the envelope strictly and retries once on a generation race | `runtimeSourcesClient` (5 tests) |

Not verified here: the operation in a deployed Box (the live check of the consuming slice).
