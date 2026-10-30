# Router source reference review, 2026-10-30: private helper-ticket route

Reviewer scope: the reviewed-registry addition to `router-reference-obligations.json` for `cli/server/edgeRoutePlan.js` and `cli/server/RoutingServer.js` after the private Router operation `POST /api/edge/target-helper-ticket` was registered (mint route spec 2026-10-30 with plan-review dispositions R1-R3). The registry change is two added blobs; `schema`, `priorInventories`, `canonical`, every existing blob and every existing `baseline`/`candidate` pointer are unchanged, and `router-inventory.mjs` is untouched.

## Blob hashes

| File | Last registered | Registered now |
| --- | --- | --- |
| edgeRoutePlan.js | ff2c0a93 (SHA-256 `ff2c0a93948815aa9c932908cad911a4910d929da54accb99f13a49a43cb59a2`) | 7c5936b2 (SHA-256 `7c5936b22f5fbebfbc657c526d54df8fc630c048ee2b6439de76f2767debe4d0`) |
| RoutingServer.js | 9ebe45ad (SHA-256 `9ebe45ad3a6daad421fe80d008ae22b3bfd650b4ad54fd7d15e24a29e731853b`) | ece55566 (SHA-256 `ece555665b03d3f324c4de8c4a3b193dca6968692045f9912762e492fbc04ca6`) |

Every other registered file is byte-identical to the previous registration. `privateRouter.js` is not a registered Router source file, so it needs no blob; its change is reviewed below because the new branch delegates to it.

## What changed

| File | Change | Effect |
|---|---|---|
| edgeRoutePlan.js | A new `pathname === '/api/edge/target-helper-ticket'` branch of the private listener, between `source-protection` and `turn-credentials` (20 lines inserted before the old line 899). | The exact `POST` with a raw target equal to the bare path plans as the `private-operation` `target-helper-ticket`. Any other method, or any query (even an empty `?`), answers 400 `TARGET_HELPER_TICKET_REQUEST_INVALID`; a fragment is refused earlier as `MALFORMED_SELECTOR`; encoded, dot-segment, trailing-slash and case variants do not match. The branch lies inside the private-listener block, so no other listener plans it. Only `private-turn-credentials.post` moves down by 20 lines. |
| RoutingServer.js | A `target-helper-ticket` branch of `processPrivateRequest` between `source-protection` and `runtime-origins` (13 lines inserted before the old line 930), and one bottom import of `sendTargetHelperTicket`. | After `authorizePrivateRoutePlan` (verified private agent assertion, current instance and enable generation, replay protection, exact method/path/body binding, and the ACL of `callerAclForPlan`), the reply is written by `sendTargetHelperTicket`. Unlike the source-protection branch, this branch does not commit the route plan itself: the handler reads all asynchronous evidence first, then commits, then mints synchronously (R2). The import sits at the bottom, as the file's comment requires, so the registered lines above the insertion keep their positions. |
| privateRouter.js (not registered) | `targetHelperTicketCallers`, the `target-helper-ticket` case of `callerAclForPlan`, `sendTargetHelperTicket` with its evidence readers, the process-wide service and eight imports (three of the execution-target tree, pinned by `executionTargetPreservation`). | The ACL admits only the exact current instance of the single agent whose effective manifest carries a valid `executionProvider` declaration; with none or two or more such agents nobody may call (403 `PRIVATE_CALLER_DENIED`). `sendTargetHelperTicket` re-checks that rule, then resolves the live Box scope, the worker's source-protection generation pointer, the active registry record of the named target container, one exact ownership-checked `podman container inspect` of that container, the provisioning record's helper facts and the controller-private ticket secret; then commits the route plan (a changed edge generation answers 503 `edge_generation_changed` with nothing minted and no helper nonce consumed); then mints and replies with `Cache-Control: no-store` and no `await` in between. Bodies over 65536 bytes answer 413, unparsable bodies 400 `invalid_request`, more than 60 requests per minute by the exact caller 429 `capacity_exceeded`; every other refusal is a 200 `{ok:false,error:{code}}` from the minter. Outside a Box there is no live scope and every request is `target_scope_mismatch`. The audit records `target_helper_ticket_minted` (caller, kid, jti, exp) and `target_helper_ticket_refused` (caller, code) only; the ticket and the session key appear in the response body and nowhere else. |

No dispatch statement of the registered rows changed. `ROUTER_CONTRACT_DRIFT` is not involved: every contract digest, canonical source and anchor is as before.

## Per-row evidence

Rows whose line did not change are listed in the JSON only. The rows that moved, each checked by asserting that the registered statement equals the trimmed line at the new line and that the anchor occurs on it (the registry update script maps each old line by the insertion offset and fails on any mismatch; `routerSourceDrift()` repeats the check on the checkout bytes):

| File | Row id | Old line | New line | Statement (unchanged) |
|---|---|---|---|---|
| edgeRoutePlan.js | private-turn-credentials.post | 899 | 919 | `if (pathname === '/api/edge/turn-credentials') {` |
| RoutingServer.js | agent-root-websocket.get | 1099 | 1112 | `const handled = await handleAgentRootUpgrade({ req, socket, head, parsedUrl: routePlan.parsedUrl, routePlan });` |
| RoutingServer.js | agent-additional-websocket.get | 1061 | 1074 | `if (routePlan.kind === 'agent-port') {` |
| RoutingServer.js | unix-health.get | 1012 | 1025 | `sendJsonResponse(res, 200, detailedHealthData(), { 'Cache-Control': 'no-store' });` |

The other 4 edgeRoutePlan.js rows (`agent-additional-http.*` 196, `private-workspace-logs.post` 822, `private-workspace-metrics.get` 840, `private-runtime-origins.get` 858) and the other 20 RoutingServer.js rows are all above the insertion points and keep their lines. `if (routePlan.kind === 'agent-port') {` also occurs in `processPrivateRequest`; the new line was derived from the old line by offset, not by searching for the statement.

## New obligation: deferred

The new route is not added as an inventory row, for the reason recorded on 2026-10-29 for the source-protection route: a row needs a new `priorInventories` stage, and the row count 128 is asserted by `router-source-drift.test.mjs`, `router-live-sessions-inventory.test.mjs` and `router-probes.test.mjs`, so it needs a separately reviewed harness change. The obligation is recorded here and covered by named tests.

| Obligation | Tests |
|---|---|
| `POST /api/edge/target-helper-ticket` plans only as the exact private operation; other methods, queries and spellings are refused or unmatched; the public and managed listeners never serve it | `executionTargetHelperTicketRoute`: "U2 route: ..." |
| reachable with the verified private identity of the single execution-provider agent; refused for a current agent without a declaration (403), a stale instance or enable generation (401), an unsigned request, a request signed for another path or body, a forged identity header, two providers or none (403); refused callers read no evidence | "U3 the single execution provider is admitted ...", "U3 two execution providers, or none, ..." |
| every bound fact is Router-asserted: unknown principal, unregistered container, other incarnation or instance, unprovisioned target (`target_mismatch`); stopped, failed or timed-out inspection, foreign ownership labels (`target_not_eligible`); missing or other store pointer (`caller_mismatch`); a target rotated between evidence and mint, or a symlinked secret (`secret_unavailable`); no live scope (`target_scope_mismatch`) | "U5 ..." (four tests) |
| evidence first, then commit, then a synchronous mint (R2): a generation change answers 503 with nothing minted and the same nonce mints afterwards; twenty parallel mints for one lease and epoch produce one ticket | "R2 an edge generation change ...", "R2 twenty parallel mints ...", "sendTargetHelperTicket commits after every await ..." |
| a minted ticket verifies with the helper-side secret and carries the A11.5 session key; the audit, the `.ploinky` tree and the Box tmpfs never hold the ticket, its signature or the session key | "U4/U7 a minted ticket ..."; the minter's byte-for-byte reproduction of `session-fixture-v1.json` in `executionTargetHelperTicket` |
| two registry records of the provider principal (for example a staged `NAME__candidate_<12hex>` key beside the current record) leave the operation with no caller: 403 `PRIVATE_CALLER_DENIED`, no handler call and no evidence read. This is a deliberate fail-closed decision and intentionally differs from the worker-mailbox holder rule, where same-principal records count as one holder; `targetHelperTicketCallers` requires exactly one entry of `sourceProtectionHolderCallers`, which lists one entry per record | "F2 two registry records of the provider principal ..." |
| refused callers (U3) and rate-limited requests (429) read no evidence: counting spies on every reader (live scope, store pointer, registry, manifest, inspection, helper facts) and on `useSecret` stay at zero; a scratch mutation moving the rate-limit check after the readers fails the test | "U3 the single execution provider is admitted ...", "probes: ..." |
| R1 lease ownership by principal only | `executionTargetHelperTicket`: "R1 a lease is bound to the principal ..." |
| RoutingServer dispatches after authorization without committing first, with exactly the reviewed Router import | "RoutingServer dispatches the operation after authorization ..." |
| the real Router child process serves it to the provider only and mints nothing outside a Box | `helperTicketRealRouter` (needs the Router's dependencies, `mcp-sdk`, like `sourceProtectionRealRouter`) |
| the Router imports exactly the reviewed new-tree names, once each; the agent-side transport has no production importer | `executionTargetPreservation` |

Not verified here: the route inside a real Podman Box (live scope from `/proc/self/mountinfo`, the Router's euid and Box tmpfs view of the provisioning record and the secret copy, a real `podman container inspect`). That is the L1 apparatus gate of the mint route spec.
