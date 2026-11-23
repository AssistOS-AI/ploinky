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

## Per-user canary routing

The S3 inventory adds three source blobs to the historical reference map. It also pins the local CLI administrator status check to the updated Router source.

| File | S3 SHA-256 prefix | Reviewed references |
| --- | --- | --- |
| RoutingServer.js | 39e999f1 | 23. The root, health, cards, MCP, tasks, WebSockets, reserved paths and Unix health references retain their dispatch statements. The OpenAI row identifies the shared delegated branch that selects either the single-copy or canary dispatcher. Both verify the source assertion against the buffered request. |
| edgeRoutePlan.js | 25b27c42 | 5. The agent-port planner resolves physical members of a published pair. A caller acquires the concrete target after admission. The four private operations retain their listener checks. |
| static/index.js | 53e924c7 | 6. Web library and workspace file dispatch retain their existing references. Agent GET and HEAD can open the selected export under its confined root and recheck the selection before serving its bytes. |

The S3 review also recorded 18 outstanding references in the hardware limits, marketplace and blob handlers. The integrated review below covers those S1 changes.

## Integrated canary routing

The merged status branch starts at `RoutingServer.js:467`. It checks the loopback control host before authentication and retains the local CLI administrator, GET, current lease and no-store checks. The following additions to the historical registry map each previously reviewed statement and anchor through the source diff. The existing S3 references for `edgeRoutePlan.js` and `static/index.js` still match their registered bytes.

| Source | Reviewed → integrated SHA-256 prefix | Rows | Dispatch review |
| --- | --- | ---: | --- |
| RoutingServer.js | 39e999f1 → 522fc225 | 23 | The loopback restriction moves all 23 S3 references by four lines. Task status matches the forwarding branch at 664 and the additional WebSocket matches the upgrade branch at 1055. |
| authHandlers/hardwareLimitsRoutes.mjs | 126e6e8e → 5e7d9679 | 4 | The GET and administrative mutation branches move by one line. Registry reads exclude canary records from ordinary limit proposals, reported instances and GPU qualification. |
| authHandlers/marketplaceRoutes.js | c21698e4 → 68c76924 | 6 | The read and mutation dispatches move by one line. Marketplace enumeration omits secondary canary records. |
| handlers/blobs.js | 87202bbb → ef019340 | 8 | The upload, create and read dispatches move by one line. Blob namespace resolution excludes canary records before selecting an agent. |
| handlers/webchat/index.js | 8421568f → c5758bfc | 13 | The UI and helper statements follow the new runtime branch. A canaried stream requires an admitted target, a matching manifest command and an inspected physical launch. |
| handlers/webchat/runtimeRoutes.js | 90e8d42a → fe90c3ee | 4 | Stream, input, control and interaction begin at 146, 334, 414 and 446. Pooled canary input rechecks the admitted copy and launch before writing to the TTY. |

## Ordinary routes and canary failure handling

The S3 fixes add five source blobs to the registry. Each of the 51 references below still matches its prior dispatch statement and anchor. The local CLI canary-status check remains at RoutingServer line 467.

| Source | Prior → reviewed SHA-256 prefix | References | Change |
| --- | --- | ---: | --- |
| RoutingServer.js | 522fc225 → 57cff3f5 | 23 | Ordinary delegated task-status requests mint inside the existing 401 handler. Canary requests mint after copy selection and refuse an unavailable invocation. |
| edgeRoutePlan.js | 25b27c42 → 5ad000ec | 5 | On a ready public host, a missing or disabled ordinary route reaches the existing 404. A canary route uses copy-aware admission. |
| static/index.js | 53e924c7 → 92005353 | 6 | A stale static-file read returns the retry header only on a canary route. Both lease checks precede file delivery. |
| handlers/webchat/index.js | c5758bfc → b1bf1460 | 13 | A split can select a legacy primary. Stream creation inspects its immutable container identity and verifies the registered launch environment. |
| handlers/webchat/runtimeRoutes.js | fe90c3ee → ca0c6c79 | 4 | Ordinary writable sessions survive republication. Delivery checks the opening launch before giving the TTY a token. Stream input, control and interaction writes on a split check the selected TTY. |
