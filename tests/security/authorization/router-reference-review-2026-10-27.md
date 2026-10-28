# Router source reference review, 2026-10-27

Reviewer scope: registry additions to `router-reference-obligations.json` for the agent-exec candidate, which adds the private route `/api/edge/agent-exec` (RoboTeam runs robot workflow phases in global-mode agent containers). Registry changes are additions only: two new blobs, every existing blob and every `baseline`/`candidate` pointer unchanged. The blob rows were derived mechanically from `git diff -U0` line mapping against the reviewed HEAD blobs and checked against the new bytes (statement equals the trimmed line, anchor on that line).

This record is not a substitute for a security review of the new route. A reviewer must still read the candidate diff below and confirm or refuse it.

## Blob hashes

| File | Last reviewed | Registered now |
| --- | --- | --- |
| RoutingServer.js | d0197d13 | 8c8a211c (one 2-line insertion before `req.edgeBufferedBody = body;` in `processPrivateRequest`) |
| edgeRoutePlan.js | 091c5b89 | 68cb2543 (a private-listener block after `turn-credentials`, plus the `AGENT_EXEC_PATH` constant after the late import) |

## RoutingServer.js (blob 8c8a211c)

The insertion dispatches `kind: 'private-operation', operation: 'agent-exec'` to `cli/server/agentExec/agentExecRoute.js`, loaded lazily so the other rows keep their lines. It runs after `readPrivateRequestBody` and `authorizePrivateRoutePlan`, so the caller ACL (`agentExecConsumersOf`, derived from the verified generation's manifests with `routerAccess.agentExec`), the request binding and replay checks apply unchanged. Rows before the insertion keep their lines; `agent-root-websocket.get` (1067 → 1069), `agent-additional-websocket.get` (1029 → 1031) and `unix-health.get` (980 → 982) shift by +2.

## edgeRoutePlan.js (blob 68cb2543)

The block is inserted after the existing private routes and before the private `PRIVATE_ROUTE_SURFACE_DENIED` fallback, so the five registered rows keep their lines (196, 808, 826, 844, 865). It matches only `POST /api/edge/agent-exec` (no query), `GET /api/edge/agent-exec/<32 hex>/stream` (optional `?from=<digits>`), `POST /api/edge/agent-exec/<32 hex>/input` and `DELETE /api/edge/agent-exec/<32 hex>`; anything else under the prefix is denied with 400 `AGENT_EXEC_REQUEST_INVALID`. The block is reachable only on the private listener.

## Not yet in the frozen inventory

`normalizeRouterInventory` requires exactly the 128 prior rows, so the new route has no inventory row yet. Adding `private-agent-exec.{post,get,delete}` (anchor `pathname === AGENT_EXEC_PATH`, edgeRoutePlan.js line 880) needs a new reviewed prior-inventory snapshot.
