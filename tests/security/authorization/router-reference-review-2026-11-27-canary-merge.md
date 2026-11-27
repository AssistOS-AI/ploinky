# Router source reference review for the canary merge, 2026-11-27

The merge of `origin/master` (`9cd443a3`) into `agent-canary` (`32d7ae70`) retains the blob registrations from both parents. Three merged files add registrations. Each carries every row, statement and anchor from the last registered blob to the merged source line. A row moves only where its statement text, and its anchor where it has one, is on the new line. The baseline, candidate and canonical entries match both parents.

This record is not a substitute for a security review.

| File under `cli/server/` | Last registered (canary / master) | Registered now | Rows moved |
| --- | --- | --- | --- |
| `authHandlers/marketplaceRoutes.js` | `3bafeb6b` / `7526d14b` | `a91b50f1` | All six. From the canary blob by 38 to 44 lines, from the master blob by 29 to 35 lines. Both starting points give the same merged lines |
| `edgeRoutePlan.js` | `ced0b54d` / `62537426` | `bac9ce1a` | All five. From the canary blob by 1 line, from the master blob by 22 to 82 lines. Both starting points give the same merged lines |
| `handlers/webtty.js` | `08ce7191` / `08ce7191` | `1e56909d` | All ten. Seven move by 40 lines (`webtty-ui` and `webtty-ui-slash` from 262, and the assets, discover, discovery-delete, create and stream rows) and `webtty-input`, `webtty-resize` and `webtty-delete` by 50 |

Neither parent had registered all of its current bytes for these files. At `32d7ae70` the canary bytes of `marketplaceRoutes.js` (`44614a72`) and `edgeRoutePlan.js` (`bac9ce1a`) were unregistered, and at `origin/master` the bytes of `edgeRoutePlan.js` (`93c22d79`) and `handlers/webtty.js` (`1e56909d`) were unregistered. `router-source-drift.test.mjs` and `router-live-sessions-inventory.test.mjs` already failed at `32d7ae70` for that reason (5 of 13 tests).

- `marketplaceRoutes.js` merges the canary production gate on Marketplace actions and the permission fields with master's lease commit and persistent SSO cookie renewal in `ensureMarketplaceUser`. The merged bytes equal neither parent.
- `edgeRoutePlan.js` is unchanged by the merge: its merged bytes equal the canary bytes, which add one entry (`/auth/logout-cache`) to a path list before the registered rows.
- `handlers/webtty.js` equals the `origin/master` bytes. Master adds four routes that have no inventory row: `GET /webtty/coding-sessions/readiness`, `POST /webtty/coding-sessions`, `POST /webtty/supervised-pairs` and `GET /webtty/sessions/:id/output`. This record does not add rows for them.

The Live Sessions overlay pins the merged `handlers/webtty.js` blob (`1e56909d`) in place of `08ce7191`. Its five source lines move from 218, 251, 255, 510 and 504 to 220, 291, 295, 560 and 554. Its notes are unchanged.

The canary status overlay in `router-inventory.mjs` keeps its pin on `RoutingServer.js` (`ea829d41`): the merged bytes equal the canary bytes, and `canary-status.get` stays on line 471. The registrations for `RoutingServer.js`, `static/index.js`, `handlers/status.js`, `handlers/webchat/*`, `handlers/blobs.js` and `authHandlers/hardwareLimitsRoutes.mjs` are unchanged, because their merged bytes equal a registered parent blob.

Fingerprint pin in `tests/unit/obsoleteExternalHostRemoval.test.mjs`: `authContext.js` moves from `dcb5d78b` to `aa85b282`. The merged file differs from the canary file by exactly the three master hunks (the `renewPersistentSsoCookie` import and call, the lease commit before a session is admitted in two places, and the session-aware cookie max age). The `ploinky-box/cloudflared/runtime.mjs` pin (`f8d5981092018c3f`) is unchanged, since master does not touch `ploinky-box/`.

The static lease inventory in `tests/unit/activationRecords.test.mjs` finds two `createLease(req)` calls in master's `cli/server/webtty/supervisedPairs.mjs` (lines 64 and 137). They call the WebTTY manager's browser-session auth adapter, as the existing `sessionManager.mjs` entry does, and the file references no workspace lease. The inventory classifies the file with the same `unrelated` entry.
