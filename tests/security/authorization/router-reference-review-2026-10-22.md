# Router source reference review, 2026-10-22

Reviewer scope: reviewed-registry additions to `router-reference-obligations.json` and the Live Sessions overlay (`router-live-sessions-inventory.mjs`) for the `live-sessions` working-tree candidate on top of ploinky `9abb8f22` (WebTTY home profiles, server views, close policy, close intents and close outcomes). As in the 2026-10-08 review, the registry has no notes field on blob entries, so this table is the written review. Registry changes are additions only: `schema`, `priorInventories` (128 rows each), `canonical` (128 rows), the `baseline`/`candidate` pointers, every existing blob and every `contractDigest`-covered field are unchanged.

Every row below was checked two ways. First, the registered statement occurs at the recorded line in the new bytes, and is unique there except for the three rows whose statement already occurred twice at `9abb8f22` (the same occurrence is kept). Second, the code around the statement was read against the diff from the `9abb8f22` bytes (the registered blob for each file). Anchors are carried over from the `9abb8f22` blob unchanged.

## Blob hashes

| File | 9abb8f22 (registered) | Candidate (added) | Diff |
| --- | --- | --- | --- |
| RoutingServer.js | 8622881c | d0197d13d1d9e448... | One import (`WebttyHomeProfileProvider`, line 113) and one constructor option (`homeProfiles`, lines 184-189) of the existing `WebttySessionManager`; no dispatch code changed |
| edgeRoutePlan.js | ec1bdbc2 | 091c5b89aa5a1dcc... | `function agentPortPlan({` becomes `export function agentPortPlan({` (line 196); no other change |
| handlers/webtty.js | a857a64e | b4989945720b02a1... | Live list moved ahead of the availability gate; attach-token body may carry a recovery claim; create body; view-bound streams; two new owner routes; error mapping |

## RoutingServer.js (blob d0197d13, shift +7 on every row)

The added lines sit above every registered statement (import block and the WebTTY manager construction at module load), so every row moves by exactly +7, including the second occurrence for `agent-task-status.get`/`-alias.get` (640) and `agent-additional-websocket.get` (1029). Dispatch order, the internal `__agent` refusal, the reserved-name 404 and the private health listener are untouched. The new provider is reached only from WebTTY discovery and creation after the administrator gate; it adds no listener, port or route.

| Rows | Old line | New line | Holds |
| --- | --- | --- | --- |
| root.get, root-index.get | 800 | 807 | yes |
| health.get | 673 | 680 | yes |
| agent-card.get, agent-card-slash.get | 760 | 767 | yes |
| mcp-browser-client.get/.head | 495 | 502 | yes |
| agent-root-proxy.* | 761 | 768 | yes |
| agent-mcp.post/.get/.delete | 770 | 777 | yes |
| agent-task-status.get, agent-task-status-alias.get | 633 | 640 | yes |
| agent-task-cancel.post | 574 | 581 | yes |
| agent-openai.post | 777 | 784 | yes |
| agent-root-websocket.get | 1060 | 1067 | yes |
| agent-additional-websocket.get | 1022 | 1029 | yes |
| internal-agent-control.* | 510 | 517 | yes |
| reserved--metrics.*, reserved--health-internal.*, reserved--admin.*, reserved--admin-*.* | 812 | 819 | yes |
| unix-health.get | 973 | 980 | yes |

## edgeRoutePlan.js (blob 091c5b89)

| Row id | Line | Statement | Holds | Review |
| --- | --- | --- | --- | --- |
| agent-additional-http.* | 196 | `export function agentPortPlan({` | yes | The function body is unchanged. The export lets the WebTTY home-profile provider build the same plan (route policy, relay opt-out, auth definition) for its own signed request; it does not add a route. The canonical anchor `function agentPortPlan({` is unchanged and is contained in the statement. |
| private-workspace-logs.post, private-workspace-metrics.get, private-runtime-origins.get, private-turn-credentials.post | 808, 826, 844, 865 | unchanged | yes | Same bytes and lines. |

## handlers/webtty.js (blob b4989945)

This blob replaces the intermediate candidate blob c75a74a6, which was never committed; the registry names only bytes a commit can carry. The administrator gate (`requireAdministrator`, line 212) still precedes every route. Only `GET /webtty/live-sessions` (line 218) now runs before `requireAvailable` (line 226); it keeps lease validation in the manager and, while WebTTY is disabled, returns only retained close outcomes with a top-level `available: false`. Every other route still follows the availability gate.

| Row id | Old line | New line | Holds | Review |
| --- | --- | --- | --- | --- |
| webtty-ui.get, webtty-ui-slash.get | 233 | 262 | yes | Unchanged branch. |
| webtty-assets.get | 248 | 277 | yes | Unchanged fixed allowlist. |
| webtty-discover.post | 267 | 296 | yes | Unchanged: mutation proof before the body (297), body exactly `{dir}` or `{dir, profile: {provider, id}}`; the browser never supplies a HOME path. |
| webtty-discovery-delete.delete | 293 | 327 | yes | Unchanged mutation proof and commit (328-329). |
| webtty-create.post | 310 | 344 | yes | Mutation proof before the body (345); body exactly `{launch, cols, rows, closePolicy}` (352), `closePolicy` keep or stop; the response adds a top-level server view `{id}`. Stricter than before. |
| webtty-stream.get | 346 | 382 | yes | The query must be exactly one `?view=` (383, else 400) before `authorize` (387); `streamView` (389) refuses a view of another principal, or one ended by a close intent or superseded by a recovery claim (409), before the SSE response. Stricter than before. |
| webtty-input.post | 370 | 411 | yes | Unchanged owner check (426) and commit (429). |
| webtty-resize.post | 394 | 435 | yes | Unchanged owner check (448) and commit (451). |
| webtty-delete.delete | 416 | 488 | yes | Unchanged mutation proof and commit (489-490). |

## Live Sessions overlay (`router-live-sessions-inventory.mjs`)

`HANDLER_SHA256` names blob b4989945. Its three existing additions move to lines 218, 251 and 255:

| Row id | Line | Statement change | Review |
| --- | --- | --- | --- |
| webtty-live-sessions.get | 218 | none | Notes refreshed for the availability-gate order and the disabled-state outcomes. |
| webtty-attach-token.post | 251 | `sendJson(res, 201, { ok: true, ...await manager.createAttachToken({` (the call now spans lines) | Mutation proof before the body (230), then the body must be exactly `{}` or `{supersedes: <32-character view id>}` (239-246, else 400 `invalid_attachment_request`) before the commit (248). The claim is only format-checked and bound into the single-use attach record (`launchRecords.mjs` `createAttachment`); it is a hint, never a credential. At attach the session manager applies it only when the attaching principal is the owner and the named view is a retained, not yet superseded owner view of the same shell; otherwise the attach proceeds unchanged and `webtty_view_supersede_ignored` is audited with a fixed reason and no view id. |
| webtty-attachment.post | 255 | `const { view, ...session } = await manager.attach({ req, routePlan, ...body });` | The response lifts the new view to the top level. The attachment body itself stays exactly `{attach, cols, rows}`; a claim cannot be added there. |

Two administrator-only rows are added, each anchored on its own dispatch statement inside the shared branch at line 457 (mutation proof 458, exact body 459-470, commit 472):

| Row id | Line | Policy | Review |
| --- | --- | --- | --- |
| webtty-close-policy.post | 481 | admin | Body exactly `{policy}`; the manager authorizes `control`, which requires the owner principal (other administrators get 403). |
| webtty-close-intents.post | 475 | admin | Body exactly `{view, policy}`; owner principal only; a foreign, unknown, already ended or superseded view is 409 with no effect. |

Notes are refreshed through the overlay's amendments, never the historical rows (their contract digests are unchanged): `webtty-create.post` (new body and view), `webtty-stream.get` (view-bound), `webtty-live-sessions.get` (answered before the availability gate, disabled-state outcomes), `webtty-attach-token.post` (optional recovery claim) and `webtty-attachment.post` (returns a view; a plain view never cancels a pending stop). The current inventory has 133 rows: the 128 historical rows plus five Live Sessions rows.

These additions only bind the rows to the right lines and describe the current gates. Live proof still requires a dedicated terminal fixture; source and unit evidence do not establish deployment acceptance.
