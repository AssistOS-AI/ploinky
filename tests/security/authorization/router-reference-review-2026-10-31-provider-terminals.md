# Router source reference review, 2026-10-31: provider terminals and the removal of home profiles

Reviewer scope: the reviewed-registry addition to `router-reference-obligations.json` for `cli/server/RoutingServer.js` and `cli/server/handlers/webtty.js`, and the matching pin in `router-live-sessions-inventory.mjs`, after WebTTY gained provider terminals (targets served by any agent whose manifest declares `executionProvider.terminals`) and lost its agent-nominated home profiles. The registry change is two added blobs; `schema`, `priorInventories`, `canonical`, every existing blob and every existing `baseline`/`candidate` pointer are unchanged, and `router-inventory.mjs` is untouched.

## Blob hashes

| File | Last registered | Registered now |
| --- | --- | --- |
| RoutingServer.js | 900fc2c6 (SHA-256 `900fc2c6e2285fa6999838fc34b82d7a0b55d2571efe92f5cff16a51d2c01c3a`) | de8c720d (SHA-256 `de8c720d45bc7f35a8d315b3ae6e5208032b298ee908c8ebf826c17b8525bde3`) |
| handlers/webtty.js | c048c0fc (SHA-256 `c048c0fc0bda861e98c10130019a640e23cbba3c1ca31a0d7d9f90e967fb2d5e`) | 78569d92 (SHA-256 `78569d92913f5520d6dbc6539d7c1ef6a72e4af3c85c8989c4e29f957fd2722a`) |

Every other registered file is byte-identical to the previous registration.

## What changed

| File | Change | Effect |
|---|---|---|
| RoutingServer.js | The `WebttyHomeProfileProvider` import and its `homeProfiles` option are gone. Four imports (`validateBrowserSessionLease`, `ProviderTerminalHub`, `ProviderTerminalTargets`, `RouterServiceTokenService`) replace it; a `ProviderTerminalHub` is constructed with the existing `runtimeRelayManager` before the `WebttySessionManager` and passed to it with a `ProviderTerminalTargets`; `beforeClose` awaits `webttyProviderHub.shutdown()` after `webttySessionManager.closeAll()`. | No dispatch statement changed. The hub and the target discovery reach providers only through `planProviderEndpoint` and the private relay, as the task-reference route does; no listener, port or credential is added. Every registered row below the constructor moves by +10 lines. |
| handlers/webtty.js | The `validateHomeProfileRequest` import is gone. A discovery body that carries a `profile` key now answers `410 legacy_terminal_profile` before the manager is called; every other body must be exactly `{dir}` (400 `invalid_discovery_request` otherwise). `mapOperationError` drops `WEBTTY_PROFILE_UNAVAILABLE` (409) and answers `WEBTTY_PROVIDER_LAUNCH_REFUSED` with 409 `terminal_launch_refused`, adding the provider's `reason` only when it is a lowercase token of at most 64 characters. | The handler's gate is unchanged: `requireAdministrator` still runs first for every `/webtty` path, and the mutation Origin and CSRF check still runs before the body is read. The 410 comes after both, like the 400 it replaces for those payloads, and creates no discovery record and no launch. While WebTTY is unavailable the availability gate answers first (503), as for every other `/webtty` mutation. |
| router-live-sessions-inventory.mjs | `HANDLER_SHA256` is the new handler blob, and the lines of the five Live Sessions additions follow the handler (219, 252, 256, 499, 493 instead of 218, 251, 255, 496, 490). Statements and notes are unchanged. | The overlay still resolves every one of its five routes against the checkout bytes. |

No dispatch statement of the registered rows changed. `ROUTER_CONTRACT_DRIFT` is not involved: every contract digest, canonical source and anchor is as before.

## Per-row evidence

Each moved row was mapped through the unchanged line blocks between the two blobs (a line diff of the registered bytes against the checkout), then checked by asserting that the registered statement equals the trimmed line at the new line and that every anchor occurs on it. `routerSourceDrift()` repeats the check on the checkout bytes.

| File | Rows | Old line | New line |
|---|---|---|---|
| RoutingServer.js | all 23 rows | 508 to 1111 | +10 each (for example `root.get` 816 to 826, `unix-health.get` 1024 to 1034, `agent-root-websocket.get` 1111 to 1121) |
| handlers/webtty.js | webtty-ui.get, webtty-ui-slash.get, webtty-assets.get, webtty-discover.post | 262, 262, 277, 296 | 263, 263, 278, 297 |
| handlers/webtty.js | webtty-discovery-delete.delete, webtty-create.post, webtty-stream.get, webtty-input.post, webtty-resize.post, webtty-delete.delete | 327, 344, 382, 426, 450, 503 | 330, 347, 385, 429, 453, 506 |

With these blobs, `routerSourceDrift()` on the candidate reports the same 4 rows as on the base commit `5918f322` (the unreviewed `handlers/webchat/runtimeRoutes.js` blob `54aec1f0`), and none for these two files. Those 4 rows keep the drift list non-empty, which stops `routerSourceDrift()` before it checks the Live Sessions overlay. The overlay was therefore checked separately: in scratch copies of both the base and the candidate, with only that `runtimeRoutes.js` blob registered (never applied to this tree), `router-source-drift`, `router-live-sessions-inventory` and `router-probes` pass 28 of 28 on each. With the old overlay pin the candidate fails with `LIVE_SESSIONS_SOURCE_DRIFT: UNREVIEWED_LIVE_SESSIONS_SOURCE`.

## Obligations

No inventory row is added: no public or private HTTP route was added. The terminal control WebSocket and `POST <terminals.path>/targets` are provider endpoints that the Router alone reaches through the internal planner (`providerEndpointPlan.mjs`), and they are covered by named tests in `tests/unit`.

| Obligation | Tests |
|---|---|
| a request that still names a home profile gets 410 `legacy_terminal_profile`, creates nothing, and the discovery body is otherwise exactly `{dir}` | `webttyHandler`: "discovery accepts exactly {dir}; the removed profile payload gets 410 legacy_terminal_profile and creates nothing" |
| a provider's final refusal is a 409 with its reason, never a retryable error; an uncertain launch stays a retryable 503 | `webttyHandler`: "a provider launch refusal is a final 409 terminal_launch_refused"; `webttyProviderTerminalLifecycle`: "a delivered launch refusal is final and says why"; `webttyProviderTerminalHub`: "a worker refusal reaches the caller as a final refusal with its reason, through a real session worker" |
| launch evidence is minted only from the revalidated administrator of the creating request, never from hub state; a non-administrator, a failed revalidation, another user or a request that does not match gets none | `webttyProviderTerminalHub`: the three launch-evidence tests |
| the target request is signed as the admitted administrator for the exact method, path and body; a provider failure is a notice, never a row | `webttyProviderTerminalTargets` |
| the provider connection is opened through the checked-out private relay with the Router-only upgrade header, a bounded codec, no extension and no fragmentation | `webttyProviderTerminalTransport` |
| the hub connects with backoff, keeps ownership across a channel loss or a routing change by rotating, and replaces a client only after its own shutdown | `webttyProviderTerminalHub` |
| a provider over its share of the dialog (128 targets, 256 in all) is an `inventory_too_large` notice and never fails the discovery; the browser row carries the opaque `targetId` and nothing else of the provider's identity | `webttyProviderTerminalTargets`: "a provider over its share is a notice"; `webttyLaunchRecords`: "a provider row is listed with its provider name" |
| the signed actor carries `admin` exactly when the administrator check passes, lowercased as that check reads it | `webttyProviderTerminalTargets` and `webttyProviderTerminalHub`: the role tests |
| competing demand and a flapping channel cannot make the hub reconnect faster than its backoff; a slow launch is retried with the same operation id within the launch window | `webttyProviderTerminalHub`: "competing demand", "a flapping channel", "a slow launch", "a launch that never answers" |
| a provider session keeps no recovery record, never disables WebTTY, and ends with cause shutdown when its client is shut down | `webttySessionManager` (provider terminals) |

Not verified here: the operations against a deployed worker (the live checks of the consuming slice).
