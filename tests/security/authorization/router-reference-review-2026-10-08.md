# Router source reference review, 2026-10-08

Reviewer scope: reviewed-registry additions to `router-reference-obligations.json` for the source bytes at ploinky `d94f62fd` (the integration candidate that includes the U3, U6 and U7 changes and the WebChat eviction race fixes). The registry has no notes field on blob entries, so this table is the written review. Registry changes are additions only: `schema`, `priorInventories` (128 rows each), `canonical` (128 rows), every existing blob and every `contractDigest`-covered field are unchanged.

Every row below was checked two ways. First, the registered statement occurs exactly once in the new bytes (mechanical, scripted) and sits at the recorded line. Second, the code around that statement was read and the retained obligation was judged against the U3/U6/U7 diffs (`git diff 7336ed34 d94f62fd` for each file). Anchors are carried over from each family's candidate blob unchanged; the four `runtimeRoutes.js` rows have no anchor and stay `null`.

## Blob hashes

| File | 2df5bca9 | 7336ed34 | 58b509a7 | d94f62fd (registered) |
| --- | --- | --- | --- | --- |
| authHandlers/marketplaceRoutes.js | b6a1ed20 (registered) | 8c999186 (registered) | 929c7610 | 929c7610c72c09dd... |
| static/index.js | 5e216d42 (registered) | c347aa27 (registered) | 503cc169 | 503cc16989efd2c0... |
| webchat/index.js | 5ea7c553 (registered) | 2874a4e8 (registered) | 2c1399c1 | 2c1399c1f147f93... (same bytes at 58b509a7 and d94f62fd) |
| webchat/runtimeRoutes.js | 894d28db (new family) | 894d28db (identical blob) | 90e8d42a | 90e8d42a687352c3... |

`runtimeRoutes.js` was not a registered family. Its four rows named lines 73/243/319/348 in `router-inventory.mjs`, so no check compared them with the code. It is now a family: `baseline` and `candidate` both name 894d28db (the bytes at 2df5bca9 and 7336ed34, where the four statements are at the registered lines, checked), plus the new blob 90e8d42a.

## marketplaceRoutes.js (blob 929c7610, shift +12 on every row)

| Row id | Old line | New line | Holds | Review |
| --- | --- | --- | --- | --- |
| marketplace-repos-read.get | 740 | 752 | yes | `marketplacePayload` is only called after `authorizeRead()` (lines 739 and 755) or after the POST admin and mutation gate; the catalog read wrapper is unchanged by U3. |
| marketplace-agents-read.get | 712 | 724 | yes | Same call chain. U3 changes `readMarketplaceEnableModes(agent)` (line 429) to reuse the manifest already parsed by the summary. The response object (lines 540-554) still lists fields explicitly; the parsed `manifest` is not copied into it. `manifestPath` and `pid` exposure is unchanged. |
| marketplace-install_repo.post | 812 | 824 | yes | POST: `ensureAdmin` (765) then the public or control Origin and CSRF decision (770-771) run before the body is read (781) and before the action dispatch at 824. The new `PLOINKY_MARKETPLACE_REPOSITORY_RETRY` entry (line 54, a 503) is only reachable through `sendLifecycleError` in the catch (871), which is after that gate. |
| marketplace-uninstall_repo.post | 812 | 824 | yes | Same statement as install_repo (shared `else if`); same gate. |
| marketplace-enable_agent.post | 838 | 850 | yes | Same gate; agent-assertion path still restricted to `enable_agent` by the `agentAllowed` check. |
| marketplace-disable_agent.post | 840 | 852 | yes | Same gate; agent requests cannot reach it (`agent_action_forbidden`). |

## static/index.js (blob 503cc169, shift +73 on every row)

| Row id | Old line | New line | Holds | Review |
| --- | --- | --- | --- | --- |
| web-libs.get / .head | 721 | 794 | yes | The `serveWebLibRequest` body is not in any diff hunk. Its `sendFile` call (828) passes no `templateAware`, so it keeps `templateAware: false`. |
| workspace-file-read.get / .head | 684 | 757 | yes | Body unchanged. It reaches `sendFileStream` (783), which passes `authenticated: true` and no `templateAware`; conditional and cache behavior for non-template files is unchanged. |
| agent-static.get / .head | 840 | 913 | yes | `templateAware: true` appears only at lines 936-940, inside this function, after `beforeRead` (the route commit, `RoutingServer.js:765-769`) has returned true. A 304 for a fetched template is produced only on that path. Navigations (not `Sec-Fetch-Dest: empty`) ignore validators and always get 200, which is stricter than before. Other `sendFile` callers (373, 414, 828, 969, 975) keep the default `false`. |

## webchat/index.js (blob 2c1399c1, shift +1 on every row)

The only diff against the 7336ed34 bytes is the import of `renderModulePreloadLinks` (line 30) and one added template key at line 186. `modulePreload.js` renders a constant list of asset names with HTML attribute escaping and takes no request input. No ordering changed: `/assets/` still precedes the session check, and `authorized(req)` (line 131) still precedes tasks, suggestions, uploads, directories, the index page and runtime dispatch.

| Row id | Old line | New line | Holds |
| --- | --- | --- | --- |
| webchat-removed-token-auth.post | 108 | 109 | yes |
| webchat-logout.post | 116 | 117 | yes |
| webchat-assets.get | 118 | 119 | yes (public asset serve, `sendFile` without `templateAware`) |
| webchat-suggestions.get / .head | 149 | 150 | yes |
| webchat-upload.post / .put | 153 | 154 | yes |
| webchat-directories-list.get / .head | 166 | 167 | yes |
| webchat-directories-create.post | 172 | 173 | yes |
| webchat-ui.get / webchat-ui-no-slash.get / webchat-index.get | 182 | 183 | yes (the added preload links come after `authorized(req)`) |

## runtimeRoutes.js (family added; old blob 894d28db, new blob 90e8d42a)

| Row id | Registered line (894d28db) | New line | Holds | Review |
| --- | --- | --- | --- | --- |
| webchat-stream.get | 73 | 119 | yes | `/stream` is dispatched by `webchat/index.js:212` after `authorized(req)`. U6: a principal-scoped agent without an authenticated user gets 403 (lines 112-116); the runtime key includes a hash of `authMode` and the user id, never a query value (`runtimeState.js:771-783`); admission is bounded to 3 per principal and agent with oldest-idle eviction, else 429 (lines 134-137), synchronously before insertion. Reserved launch keys (`sso-*`, `webchat-runtime-scope`) are dropped in `launchOptions.js`. The race fixes (`runtimeState.js` `deleteIfCurrent` on disposal, late output and task events from a disposed tab dropped) sit behind this branch. The router session id is no longer included in the SSO user object passed to `ttyFactory.create` (lines 149-154). The signed `runtimeScope` is not on this path. |
| webchat-input.post | 243 | 294 | yes | Same dispatch and principal key (line 298). The browser mutation proof (Origin and CSRF) for non-GET requests with `local`/`sso` auth is enforced in `RoutingServer.js:677-692`, before `/webchat` is dispatched at `RoutingServer.js:731`; this branch itself has no CSRF code. Signed `runtimeScope`: `serializeWebchatEnvelopeForAgent` (call at line 326) builds `__webchat_message__` arguments through `buildWebchatInvocationArgs`, which adds `runtimeScope: "principal"` only from the manifest-derived `effectiveConfig` (`messageEnvelope.js:73-87`, token built at `:90-100`). |
| webchat-control.post | 319 | 370 | yes | Principal key at line 371. It still has no `sid`/`tabId` subscriber check (unchanged by U6; recorded, not introduced here). Its stop message (line 381) carries no invocation token, so signed `runtimeScope` is not on this path; isolation here relies on the principal-keyed lookup only. |
| webchat-interaction.post | 348 | 399 | yes | Principal key at line 403; the subscriber ownership check (`sid`, `tabId`, `pageInstanceId`) is unchanged. Signed `runtimeScope` is not on this path (the response is parsed and answered through the tab found by the principal key). |

Limits kept honest: the per-principal runtime key applies only to agents whose manifest declares `webchat.runtimeScope: "principal"`. Agents with the default `shared` scope keep one runtime per workspace, agent and launch query, so the cross-account runtime gap recorded in the unchanged gap text still stands for them. These additions only bind the rows to the right lines; they do not close any gap.

## Findings outside the four files (not changed here)

Two existing registry entries cannot prove their line: `cli/server/RoutingServer.js` blob 27fb848d `internal-agent-control.*` (line 481) and `cli/server/handlers/webtty.js` blob 0c0d70d8 `webtty-input.post` (line 326) both record an empty statement, and several other 0c0d70d8 entries record a bare `}` where the baseline blob records the dispatch statement. The registry is Codex-owned and out of scope; `router-probes.test.mjs` now pins the two blank entries so a third cannot appear unnoticed.
