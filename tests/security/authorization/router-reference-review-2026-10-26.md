# Router source reference review, 2026-10-26

Reviewer scope: reviewed-registry additions to `router-reference-obligations.json` for the source bytes at ploinky origin/master `15295cca` plus the JWT replay-protection candidate. Commit `56595943` ("Serve a root application beside the host owner on public hosts") changed `RoutingServer.js` and `edgeRoutePlan.js` without registry updates for those two files (it did add blob 4c1d5fc9 for `static/index.js`), so the reviewed-source check refused origin/master. The JWT candidate changes `marketplaceRoutes.js`. Registry changes are additions only: `schema`, `priorInventories` (128 rows each), `canonical`, every existing blob and every existing `baseline`/`candidate` pointer are unchanged.

Every row below was checked two ways. First, the registered statement equals the trimmed line at the recorded line of the new bytes, and the anchor occurs on that line (mechanical, scripted against the exact bytes). Second, the dispatch code around it was read against `git diff b1aab900 56595943` (RoutingServer.js, edgeRoutePlan.js) or the JWT candidate diff (marketplaceRoutes.js), and the retained obligation was judged. "Control host" means the loopback control origin that this suite targets.

## Blob hashes

| File | Last reviewed | Registered now |
| --- | --- | --- |
| RoutingServer.js | fd33e338 (b1aab900) | 3b6493c7 (56595943 through 15295cca; unchanged by the JWT candidate) |
| authHandlers/marketplaceRoutes.js | 58e75450 (afac65d7 through 15295cca) | e38c339b (JWT candidate) |
| edgeRoutePlan.js | not a registered family; rows held at fixed inventory lines | new family: ca3a2b27 (bytes at 2df5bca9 and 7336ed34, identical) and ec1bdbc2 (56595943 through 15295cca) |

`edgeRoutePlan.js` becomes a family because `56595943` moved its five rows (`agent-additional-http.*` by +1 and the four private-listener rows by +51), and `normalizeRouterInventory` forbids changing their inventory source lines. Its `baseline` and `candidate` both name ca3a2b27, as for `runtimeRoutes.js` on 2026-10-08.

## RoutingServer.js (blob 3b6493c7, one 9-line insertion after line 439)

The insertion answers `kind: 'mount-redirect'` with a generation-committed, uncached 302 to `/<owner>/`. `edgeRoutePlan.js` produces that plan only for HTTP GET/HEAD on the exact owner path of a public host whose edge entry has `rootApplication`; WebSocket requests for it are denied with 404, and it is never produced on the control or private listener. Rows at or above line 439 are unchanged; the rest shift by +9. `internal-agent-control.*` is now bound to its guard statement `if (hasInternalAgentSegment(pathname)) {` (line 501) instead of a blank line, so the blank-statement list in `router-probes.test.mjs` is not extended.

| Row id | Old line | New line | Holds | Review |
| --- | --- | --- | --- | --- |
| root.get, root-index.get | 771 | 780 | Control host yes | `/` and `/index.html` still redirect to the static agent (`RoutingServer.js:791-799`). On a root-application host they reach the application (`edgeRoutePlan.js:950-965`); see Limits. |
| health.get | 644 | 653 | Yes | TCP `/health` (`:664`) is not in the diff; agent-root hosts still deny it as reserved (`edgeRoutePlan.js:943`). |
| agent-card.get, agent-card-slash.get | 332 | 332 | Yes | `handleRoutedAggregateAgentCard` (`:343`, dispatched at `:751`) is unchanged. |
| mcp-browser-client.get, .head | 477 | 486 | Yes | `:486-489` still runs before session auth; on root-application hosts the path is a Router surface or denied as reserved. |
| agent-root-proxy.* | 433 | 433 | Control host yes | Agent-root dispatch (`:752-787`) is unchanged. On a root-application host the owner is reachable only at `/<owner>/...`. |
| agent-mcp.post, .delete, .get | 742 | 751 | Yes | `handleAgentMcpRequest` (`:761-765`); an unqualified `/mcp` stays with the owner (`edgeRoutePlan.js:582`). |
| agent-task-status.get, agent-task-status-alias.get | 604 | 613 | Yes | The delegated branch (`:574`) and `ensureHttpRouteAccess` (`:612-615`) are unchanged. |
| agent-task-cancel.post | 546 | 555 | Yes | The delegated cancel branch (`:565`) is unchanged. |
| agent-openai.post | 589 | 598 | Yes | The path-exact bypass (`:608-611`) and `:767-771` are unchanged. |
| agent-root-websocket.get | 955 | 964 | Control host yes | The upgrade handler (`:1002-1012`) accepts only `agent-root`/`agent-port`; a mount redirect on an upgrade is denied with 404. |
| agent-additional-websocket.get | 986 | 995 | Control host yes | On a root-application host, upgrades reach `executeWebSocketPlan` (`:1013-1027`) without the prefix, through the same `agentPortPlan` decision as the prefixed form. |
| internal-agent-control.* | 481 (blank) | 501 | Yes | `hasInternalAgentSegment(pathname)` also checks the root-application `policyPath`. Rebound from the blank line to the guard. |
| reserved--metrics.*, reserved--health-internal.* | 251 | 251 | Yes | Still denied as reserved (`edgeRoutePlan.js:607-631,943`). |
| reserved--admin.*, reserved--admin-*.* | 251 | 251 | Control host yes | On a root-application host, `/admin*` reaches the application only when its manifest declares that path (`edgeRoutePlan.js:942,301-305`); see Limits. |
| unix-health.get | 926 | 935 | Yes | `processDetailedHealthRequest` (`:956-965`) is not in the diff. |

## marketplaceRoutes.js (blob e38c339b, shift +10 on every row)

The JWT candidate adds an import, partitions the agent-assertion replay cache per verified issuer, and maps refusals that follow a valid signature to 429 (`replay_quota_exhausted`) or 503 (`replay_capacity_exhausted`). A missing, forged or expired token, a wrong audience, an invalid issuer key and a replay of a valid token still answer 401. Dispatch order, `ensureAdmin`, Origin/CSRF checks and `agentAllowed` are not in the diff, and no row's expected status for an unauthenticated or unauthorized caller changes.

| Row id | Old line | New line | Holds | Review |
| --- | --- | --- | --- | --- |
| marketplace-repos-read.get | 923 | 933 | Yes | Reached only after `authorizeRead()` (`:867-878`); a refused agent request stops there (`:936`). |
| marketplace-agents-read.get | 893 | 903 | Yes | Same gate. |
| marketplace-install_repo.post, marketplace-uninstall_repo.post | 996 | 1006 | Yes | The `agentAllowed` 403 (`:981-985`) still runs before `ensureMarketplaceAgentRequest`, and a false return ends the request (`:986-992`). |
| marketplace-enable_agent.post | 1022 | 1032 | Yes | Same. |
| marketplace-disable_agent.post | 1024 | 1034 | Yes | Agent callers are still refused with 403 before verification. |

## edgeRoutePlan.js (new family)

The private-listener block (`:807-881` in ec1bdbc2) is textually unchanged; earlier hunks shift it by +51.

| Row id | ca3a2b27 line | ec1bdbc2 line | Holds | Review |
| --- | --- | --- | --- | --- |
| private-workspace-logs.post | 757 | 808 | Yes | The private branch returns (`:880`) before any root-application code; `rootMount` defaults to false (`:207`). |
| private-workspace-metrics.get | 775 | 826 | Yes | Same. |
| private-runtime-origins.get | 793 | 844 | Yes | Same. |
| private-turn-credentials.post | 814 | 865 | Yes | Same. |
| agent-additional-http.* | 195 | 196 | Prefixed form yes | For the prefixed form the `requestTarget` default equals the old expression (`:206`). The `/admin` guard and `forwardedPrefix: ''` apply only under `rootMount` (`:301,372`). |

## Live Sessions merge reconciliation

The merge of master `a2965b603a391e4d2505bd7553139bf7775a1b80` and Live Sessions `66cfe40a576f5b331eca6fed446e1a2f09e6ffb5` retains both registries' blobs, stage pointers, canonical rows and historical contract digests unchanged. The merged `RoutingServer.js`, `edgeRoutePlan.js` and WebTTY handler match already registered incoming blobs exactly. Only `marketplaceRoutes.js` has new source bytes: `40669dc57fd19edc2168181b3b9b97c1739f0345d1e64ad45168f7cfd90939a6`.

Compared with master's `e38c339b` blob, that file adds the authenticated-request observer import and three notifications after successful browser-session validation. Each notification follows assignment of the validated user, session, session id and authentication mode. The observer publishes only identity, roles, mode and decision time; listener failures are contained. It does not change the marketplace allow decision. The agent assertion path retains master's replay cache and post-verification quota/capacity refusals. `authorizeRead`, the administrator and mutation proof gates, the agent action allowlist, and the route dispatch branches are unchanged.

The six references below retain their statements and anchors and move by exactly four lines. Each statement was checked at its explicit destination line, and the authentication and dispatch code was inspected; no first-match discovery or inventory contract regeneration was used.

| Row | Master line | Merged line | Retained gate |
| --- | --- | --- | --- |
| marketplace-repos-read.get | 933 | 937 | GET calls `authorizeRead` before the payload |
| marketplace-agents-read.get | 903 | 907 | Same GET gate; display projection keeps role-based permissions |
| marketplace-install_repo.post | 1006 | 1010 | Browser administrator and CSRF, or allowed agent action plus verified assertion |
| marketplace-uninstall_repo.post | 1006 | 1010 | Browser administrator and CSRF; refused for agent callers |
| marketplace-enable_agent.post | 1032 | 1036 | Browser administrator and CSRF, or allowed agent action plus verified assertion |
| marketplace-disable_agent.post | 1034 | 1038 | Browser administrator and CSRF; refused for agent callers |

The inventory keeps the 128 historical obligations separately from the 133-row Live Sessions overlay. Source drift remains an aggregated mandatory failure before deployment observation or requests. If source drift prevents constructing the overlay, importing the inventory retains unresolved historical rows so independent checks can run; mandatory source-drift and overlay assertions still fail. These are source and harness claims, not live acceptance evidence.

## Limits

The RoutingServer.js pins carry the fd33e338 statements over by offset (+0 or +9), except for the `internal-agent-control.*` rebind. Many of them (`}`, `res,`, `return;`, the detailed-health response) prove only blob identity and line position, not the dispatch statement. The Review column records the judgement on the real dispatch code; it is not what the pin itself proves.

These additions bind rows to statements on the control host, the only host this suite targets. They do not make the suite cover root-application hosts. On a public host with `rootApplication`, `/`, `/index.html` and unclaimed paths reach the application through `agentPortPlan`. `/admin*` reaches the application only through an explicit manifest policy, and the bare owner mount redirects. No Router row covers these paths; only `tests/unit/edgeAdditionalServerRoot.test.mjs` proves them, and that file is not in `acceptance/mandatory-checks.json`.

The review also recorded one source finding that is present at origin/master and was not introduced here: on such a host, an owner whose route key is `admin` is reachable at `/admin/*` without the manifest gate (`edgeRoutePlan.js:942-957,967-979`).
