# Router source reference review, 2026-11-23

The canary status change on top of `9632872b` moves 23 historical dispatch references. The base already has 37 unresolved references across four other files. Each of the 60 entries below maps a line in the last reviewed blob to the same statement in the candidate. The trimmed statement and its original anchor were checked against the new line. The five SHA-256 entries are additions to the registry. Both 128-row historical inventories retain their contract digests, source references and anchors.

| File | Last reviewed SHA-256 prefix | Candidate SHA-256 prefix | Rows |
| --- | --- | --- | ---: |
| RoutingServer.js | 0ed76407 | acee67c7 | 23 |
| authHandlers/marketplaceRoutes.js | 40669dc5 | c21698e4 | 6 |
| handlers/blobs.js | 4fdb5efc | 87202bbb | 8 |
| handlers/webchat/index.js | bd69996d | 8421568f | 13 |
| handlers/webtty.js | c048c0fc | 08ce7191 | 10 |

## Canary status

`GET /api/router/canary/status` matches the exact path on a control host at `RoutingServer.js:459`. The handler calls `ensureAuthenticated` with the selected route plan and checks the administrator role. The local CLI session branch in `authHandlers/authContext.js` validates the session cookie, its signed CLI channel and the `local:admin` identity. The status handler requires both `authMode === 'local'` and `authChannel === 'cli'`. It checks the method, commits the selected generation and returns status with `Cache-Control: no-store`. A stale lease produces 503.

The new inventory row denies all four browser principals, including a signed-in browser administrator. Its fifth expectation admits the local CLI administrator. The current inventory contains 134 rows. These are source obligations. Live authorization evidence requires exercising the endpoint.

## Existing dispatch references

| Source | Rows and reviewed lines | Authorization review |
| --- | --- | --- |
| RoutingServer | All 23 entries move by +20. These cover root and index, health, aggregate cards, MCP client and agent MCP, proxy and task dispatch, delegated OpenAI, both WebSocket paths, the internal control segment, four reserved paths and Unix health. | The import and the exact control-host status branch precede all 23 dispatch statements. The existing branches and their gates retain their statements. |
| Marketplace | Repository and agent reads 937→996 and 907→966. Install and uninstall 1010→1083. Enable 1036→1109. Disable 1038→1133. | Catalog reads still call `authorizeRead`. Operation polling on the agents endpoint separately requires an administrator and a matching activation scope. Browser mutations check admin and Origin/CSRF before reading the body. Agent actions retain the action allowlist and assertion checks. Asynchronous enable requires an admitted non-agent request and a stable activation scope. |
| Blobs | Workspace upload 437, shared and agent create 498 and 507, shared and agent reads 522 and 532. Both upload methods and both read methods retain those lines. | The data directory and the agent-local path now include `.data/agents/`. The registered dispatch and the selected agent key validation are unchanged. |
| WebChat | UI aliases 266, assets 202, removed token auth 192, logout 200, suggestions 233, upload 237, directory list 250, directory create 256. | The page template gains an HTML-escaped auth route key from the request context. All 13 route statements precede the insertion. |
| WebTTY | UI aliases 262, assets 277, discover 296, discovery delete 327, create 344, stream 382, input 426, resize 450. Delete moves 503→517. | Resize validates dimensions, optional literal `claim:true` and optional view ID before session authorization and the generation check. A personal terminal is owner-controlled. A local CLI terminal can be shared with other administrators on the same control route. A controller can explicitly claim its size. |

The WebTTY overlay pins the current handler and moves its close-intent and close-policy call sites from 490 and 496 to 504 and 510. The list, attach-token and attachment statements stay at 218, 251 and 255. The administrator gate, mutation proofs, lease checks and five explicit route obligations remain in the overlay.

## Loopback control host restriction

The status handler at `RoutingServer.js:459` now allows the four exact loopback control names classified in `edgeRoutePlan.js`. A configured public control alias receives 403 even with a signed local CLI administrator session. The handler sets `Cache-Control: no-store` before invoking authentication so it also applies to the anonymous response.

Relative to `270dc5ba`, this block moves all 23 RoutingServer references by four lines. The source registry adds blob `a1619ac4` alongside `acee67c7`. Each candidate statement and anchor was checked against the corresponding prior statement. The 128-row historical contracts and the 134 current obligations retain their identifiers and principal expectations.
