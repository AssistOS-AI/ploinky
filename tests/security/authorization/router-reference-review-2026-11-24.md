# Router source reference review, 2026-11-24

Reviewer scope: registry additions to `router-reference-obligations.json` for Router source that changed after the last registration, and a re-pin of the Live Sessions overlay in `router-live-sessions-inventory.mjs`. Registry changes are additions only: new blobs, and every existing blob and every `baseline`/`candidate`/`canonical` entry is unchanged. Each new blob carries every row of the previous reviewed blob to its shifted line; no registered statement or anchor changed.

This record is not a substitute for a security review of the change. A reviewer must still read the candidate diff and confirm or refuse it.

## Master drift

On master at `9632872b`, `router-source-drift.test.mjs` reported 37 mismatches in four files that five commits had changed without registering. These blobs match master's bytes, so the Router source in `origin/master` (`f015af60`) also resolves with no drift.

| File | Last reviewed | Registered now | Commits |
| --- | --- | --- | --- |
| handlers/webtty.js | c048c0fc | 08ce7191 | `0839c1d9` (2026-11-20) |
| handlers/webchat/index.js | bd69996d | 8421568f | `02d64bde` (2026-11-04) |
| handlers/blobs.js | 4fdb5efc | 87202bbb | `dc02417c` (2026-11-16) |
| authHandlers/marketplaceRoutes.js | 40669dc5 | c21698e4 | `f54a65ad` (2026-10-30), `02d64bde` (2026-11-04), `bd29e863` (2026-11-05) |

### handlers/webtty.js (blob 08ce7191)

The resize branch now accepts `{cols, rows}` plus an optional `claim`, which must be exactly `true`, and an optional `view`, which must match the view-id pattern. Any other key is refused with 400. It still runs `verifyMutationBeforeBody` before reading the body and `manager.authorize(..., 'resize')` and `commitMutation` before acting, then calls `manager.requestResize` instead of `manager.resize`. Only `webtty-delete.delete` moved (503 to 517).

The Live Sessions overlay pins this blob now. Its close-intents and close-policy additions moved from 490 and 496 to 504 and 510; the other three additions keep 218, 251 and 255.

The same commit changed who controls a shell, in `cli/server/webtty/sessionManager.mjs`, which the registry does not cover. A shell opened by the signed local CLI operator (`local:admin` on the `cli` channel) is shared: `controls()` treats every administrator on the same host-route as its owner. That applies to input, resize, close policy, close intents, recovery claims and attach. `authorize()` still validates an administrator lease before the `controls()` check, so the role expectations (administrator only) are unchanged. The overlay notes that said "owner principal only" or "other administrators cannot type" now state the shared-shell exception, and the resize note names the new body and the size-holder rule.

### handlers/webchat/index.js (blob 8421568f)

The WebChat page template gains `__AUTH_ROUTE_KEY__`: the HTML-escaped route key of the request's auth context, or an empty string on a host bound to one route. It is an output value only; no row moved and no gate changed.

### handlers/blobs.js (blob 87202bbb)

Agent blob storage moved from `.data/<agent>/blobs` to `.data/agents/<agent>/blobs`, in the upload path and in the reported local path. The agent key is still validated by `validateAgentDataKey`. No row moved and no gate changed.

### authHandlers/marketplaceRoutes.js (blob c21698e4)

| Row | Line |
| --- | --- |
| marketplace-agents-read.get | 907 to 966 |
| marketplace-repos-read.get | 937 to 996 |
| marketplace-install_repo.post, marketplace-uninstall_repo.post | 1010 to 1083 |
| marketplace-enable_agent.post | 1036 to 1109 |
| marketplace-disable_agent.post | 1038 to 1133 |

Two request surfaces are new. Neither has its own inventory row.

| Surface | Gate |
| --- | --- |
| `GET /api/marketplace/agents?operation=<id>` | `ensureAdmin` before any read, then exactly one well-formed id, then a lookup scoped to the caller's auth mode, user id, origin and host route. It is stricter than its row `marketplace-agents-read.get`, whose policy is `session` |
| `POST /api/marketplace/agents` `enable_agent` with `Prefer: respond-async`, browser callers only | Runs after the unchanged POST gates (administrator, exact Origin and CSRF, then the body, then the lease commit). It answers 202 with an operation id, or 429 when the bounded queue is full, and the background job keeps only the admitted lease, not the request |

The other changes are error messages (a recovery instruction after a timed-out or failed worker) and the repository kind, which now comes from `resolveRepoKind`.

## Cloudflare cache branch

The `cloudflare-cache` branch (`da84e0d0`) changed four registered files. The follow-up commit `1bb1ac73` changed none of them.

| File | Last reviewed | Registered now | Rows moved |
| --- | --- | --- | --- |
| RoutingServer.js | 0ed76407 | b46fb2c3 | all 23, by 3 to 9 lines |
| authHandlers/marketplaceRoutes.js | c21698e4 | caca9686 | all 6, by 9 lines |
| static/index.js | 4c1d5fc9 | 647fc532 | all 6, by 1 or 2 lines |
| edgeRoutePlan.js | e1a96459 | 62537426 | all 5: 196 to 207, and the four private routes by 28 lines |

### RoutingServer.js (blob b46fb2c3)

`handleAsyncRequest`, which wraps the public, private and detailed-health servers, installs the CDN response hook before the request is processed. The hook only sets the `Cloudflare-CDN-Cache-Control` response header from the route's access and cache mark. `serveMcpBrowserClient` marks its public asset to keep a cacheable header. The agent-root proxy call passes the route's access (`authenticated` for delegated task status) and the route plan to the proxy, which uses them only for that header. Every WebSocket refusal written to the raw socket carries `Cloudflare-CDN-Cache-Control: no-store`. No gate moved or changed order.

The private listener sends a `private-operation` plan with operation `cache` to `handlePrivateCacheRequest` (`privateRouter.js`). That plan is resolved only for an exact `POST /api/edge/cache` with no query. The handler refuses anything not on the private listener, not a POST to that exact path, or not from a loopback peer. It then requires the current lease and a signed cache-operator request, with replay refusal, before it reads the operation.

### authHandlers/marketplaceRoutes.js (blob caca9686)

`/api/marketplace/cache` is dispatched beside `hardware-limits`, with the same `ensureAdmin` and Origin/CSRF guards. `handleCacheRoutes` refuses any bearer (agent) request with 403 and any method other than GET and POST with 405, then calls `ensureAdmin`. It then requires the current lease, and for POST an unexpired, unrevoked session and Origin/CSRF proof, before it reads the body and again before it answers. `hardware-limits` keeps its own lease check unchanged.

### static/index.js (blob 647fc532)

`serveWebLibRequest` marks the public library asset to keep a cacheable header. No gate changed.

### edgeRoutePlan.js (blob 62537426)

Agent-port and agent-root plans gain response-policy fields: the route access, the manifest cache class and whether the request carried a credential, which is read on ingress. They decide only the cache header. The private listener resolves the cache operation plan described under RoutingServer.js before its other private routes.

## Merge of master b1c9e62f

The branch merged `origin/master` at `b1c9e62f` (commit `fbc051dc`). Master commit `b1c9e62f` ("add validated browser entry routing and guard logout submission", 2026-11-24) changed one registered file without registering it.

| File | Last reviewed | Registered now | Rows moved |
| --- | --- | --- | --- |
| RoutingServer.js | b46fb2c3 | 8a4be1c5 | all 23, by 1 or 8 lines |

### RoutingServer.js (blob 8a4be1c5)

The root redirect (`root.get`, `root-index.get`, now line 815) sends a static root agent to `resolveBrowserEntryPath` (`cli/server/browserEntryPath.js`) instead of the fixed `/<route>/index.html`. Without `routerAccess.entryPath` the location is unchanged. With it, the path must be an exact router-relative route path without `?`, `#` or `%`, owned by the agent and matched by one of its enabled HTTP routes; otherwise the Router answers 503 `browser_entry_invalid` with `no-store`. The generation loader (`cli/sandbox/edgeGeneration.js`) refuses an invalid entry path. The redirect is still 302 with `Cache-Control: no-store`, and the cache hook adds CDN `no-store` to both answers. No gate moved or changed order.

## Surfaces without an inventory row

| Surface | Source | Expected access |
| --- | --- | --- |
| `GET /api/marketplace/agents?operation=<id>` | master `02d64bde` | administrator |
| `GET` and `POST /api/marketplace/cache` | `cloudflare-cache` | administrator; POST also needs Origin/CSRF |
| `POST /api/edge/cache` | `cloudflare-cache` | private listener, loopback, signed cache operator; no user role |

The baseline inventory is frozen at 128 rows and the Live Sessions overlay adds five, so a row for any of these needs its own overlay and a harness review.
