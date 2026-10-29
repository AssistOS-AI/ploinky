# Router source reference review, 2026-10-29: private source-protection route

Reviewer scope: the reviewed-registry addition to `router-reference-obligations.json` for `cli/server/edgeRoutePlan.js` and `cli/server/RoutingServer.js` after the private Router operation `POST /api/edge/source-protection` was registered. The registry change is two added blobs; `schema`, `priorInventories`, `canonical`, every existing blob and every existing `baseline`/`candidate` pointer are unchanged, and `router-inventory.mjs` is untouched.

## Blob hashes

| File | Last registered | Registered now |
| --- | --- | --- |
| edgeRoutePlan.js | aa6096ea (SHA-256 `aa6096ea892dff2000d3e904e8610a0dda5ecbf924dbfbab1e125b56e298d924`) | ff2c0a93 (SHA-256 `ff2c0a93948815aa9c932908cad911a4910d929da54accb99f13a49a43cb59a2`) |
| RoutingServer.js | 3c3b3a33 (SHA-256 `3c3b3a3322c631e134620c708cda9afef99243128518cb553804622b8c4a99f4`) | 9ebe45ad (SHA-256 `9ebe45ad3a6daad421fe80d008ae22b3bfd650b4ad54fd7d15e24a29e731853b`) |

`handlers/webtty.js`, `handlers/webchat/runtimeRoutes.js` and every other registered file are byte-identical to the previous registration. `privateRouter.js` is not a registered Router source file, so it needs no blob; its change is reviewed below because the new branch delegates to it.

## What changed

| File | Change | Effect |
|---|---|---|
| edgeRoutePlan.js | A new `pathname === '/api/edge/source-protection'` branch of the private listener, between `runtime-origins` and `turn-credentials` (20 lines inserted before the old line 879). | The exact `POST` with a raw target equal to the bare path plans as the `private-operation` `source-protection`. Any other method, or any query (even an empty `?`), answers 400 `SOURCE_PROTECTION_REQUEST_INVALID`; a fragment is refused earlier as `MALFORMED_SELECTOR`; encoded, dot-segment, trailing-slash and case variants do not match. The branch lies inside the private-listener block, so no other listener plans it. The four existing private rows keep their statements; only `private-turn-credentials.post` moves down by 20 lines. |
| RoutingServer.js | A `source-protection` branch of `processPrivateRequest` between `turn-credentials` and `runtime-origins` (16 lines inserted before the old line 914), and one bottom import of `sendSourceProtection`. | After `authorizePrivateRoutePlan` (verified private agent assertion, current instance and enable generation, replay protection, exact method/path/body binding, and the ACL of `callerAclForPlan`), the route plan is committed (a stale generation answers 503 `edge_generation_changed` with the pre-forward refusal marker, as `turn-credentials` and `workspace-logs` do) and the reply is written by `sendSourceProtection`. The import sits at the bottom, as the file's comment requires, so the registered lines above the insertion keep their positions. |
| privateRouter.js (not registered) | `sendSourceProtection`, `createRouterLiveScope` and three imports. The ACL (`callerAclForPlan`, `sourceProtectionHolderCallers`) already existed at the base and is unchanged. | The ACL admits only the exact current instances of agents whose effective manifest carries a valid `executionProvider` declaration. `sendSourceProtection` builds the source-protection service with the Router's live Box scope and answers with the service's `{status, body}`. The live scope is `null` (the service answers `source_unavailable`, `describe` answers `unavailable`) unless the Router is inside the Box and the engine evidence is consistent with the Box name derived by `ploinky-box/identity.mjs` from the workspace path the Box binds at its own absolute path. |

No dispatch statement of the registered rows changed. `ROUTER_CONTRACT_DRIFT` is not involved: every contract digest, canonical source and anchor is as before.

## Per-row evidence

Rows whose line did not change are listed in the JSON only. The rows that moved, each checked by asserting that the registered statement equals the trimmed line at the new line and that the anchor occurs on it (the registry update script maps each old line by the insertion offset and fails on any mismatch; `routerSourceDrift()` repeats the check on the checkout bytes):

| File | Row id | Old line | New line | Statement (unchanged) |
|---|---|---|---|---|
| edgeRoutePlan.js | private-turn-credentials.post | 879 | 899 | `if (pathname === '/api/edge/turn-credentials') {` |
| RoutingServer.js | agent-root-websocket.get | 1083 | 1099 | `const handled = await handleAgentRootUpgrade({ req, socket, head, parsedUrl: routePlan.parsedUrl, routePlan });` |
| RoutingServer.js | agent-additional-websocket.get | 1045 | 1061 | `if (routePlan.kind === 'agent-port') {` |
| RoutingServer.js | unix-health.get | 996 | 1012 | `sendJsonResponse(res, 200, detailedHealthData(), { 'Cache-Control': 'no-store' });` |

The other 4 edgeRoutePlan.js rows (`agent-additional-http.*` 196, `private-workspace-logs.post` 822, `private-workspace-metrics.get` 840, `private-runtime-origins.get` 858) and the other 20 RoutingServer.js rows are all above the insertion points and keep their lines. `if (routePlan.kind === 'agent-port') {` also occurs in `processPrivateRequest`; the new line was derived from the old line by offset, not by searching for the statement.

## New obligation: deferred

The new route is not added as an inventory row. `normalizeRouterInventory` and `assertRouterInventoryObligations` require every `priorInventories` stage to have exactly the row count of the inventory (128), `routerReferenceMapErrors` needs a stage pointer in every registered file family, and the count 128 is also asserted by `router-source-drift.test.mjs`, `router-live-sessions-inventory.test.mjs` and `router-probes.test.mjs`. A row and a new stage therefore need a change to those pass/fail checks, which needs its own independent review, as the 2026-10-28 record anticipated. This record follows that precedent: the blob is registered, the obligation is recorded here and covered by named tests (all in `tests/unit`), and the stage is to be added with the harness change.

| Obligation | Tests |
|---|---|
| `POST /api/edge/source-protection` plans only as the exact private operation; other methods, queries and spellings are refused or unmatched; the public and managed listeners never serve it | `executionTargetSourceProtectionWiring`: "P5 route: /api/edge/source-protection resolves only as the exact private POST operation" |
| reachable with the verified private identity of an execution-provider agent; refused for a current agent without a declaration (403 `PRIVATE_CALLER_DENIED`), a stale instance or enable generation, an unsigned request, a request signed for another path or body, a forged identity header, and a generation without a declaration | "P5 route: reachable with the verified private identity of an execution-provider agent, refused for every other caller" |
| without a Box scope (outside a Box, missing or foreign engine evidence) the service answers `unavailable` or `source_unavailable`, never the store; with no store on disk nothing is created | "P5 route: without a Box scope the service is unavailable, never permissive" |
| RoutingServer commits the plan before the service runs, passes only the verified identity, the workspace root and its own Box-marker fact, and imports only `sendSourceProtection` | "P5 route: RoutingServer dispatches the operation after the commit, with exactly the reviewed Router import" |
| the real Router child process serves it to the provider only | `sourceProtectionRealRouter` (needs the Router's dependencies, `mcp-sdk`, like `taskReferenceRealRouter`) |
| the live scope is the real derived `{workspaceId, boxIdentity, boxGeneration}` in a Box-like fixture and `null` outside or on any inconsistency; the test seam cannot override the identity facts | `executionTargetLiveScope`: "P3 Router live scope: ..." |
| the Router imports exactly the service and live-scope modules, once each | `executionTargetPreservation`: the `ROUTER_GLUE` call site |

Not verified here: the live scope inside a real Podman Box. The container ID comes from `/proc/self/mountinfo` and the Box name from the identity module, as observed on Podman 5.7 for the P3 provider; a deployed Box run is a separate gate.
