# Local authorization regression suite

This suite targets only the already accepted deployment at `http://127.0.0.1:8080`, owned by `/Users/danielsava/work/testExplorerFresh`. It does not redeploy, change application code, reset bootstrap, publish ports, activate disabled agents, use host provider credentials, or call external services as security targets.

The final live security run is left to the operator. The development setup run verified fresh public registration and current roles, then stopped before security assertions because a probe adapter was unfinished; its disposable accounts were blocked and the exact Box/source guard passed afterward. That run is not a penetration-test result. Suspected issues below remain unconfirmed until their regression assertions are executed and the private evidence is inspected.

## Run

Use Node.js 22 or newer, the existing authenticated local Podman CLI, and the pinned deployment's existing Playwright/Chromium installation. The suite itself uses Node built-ins and does not install dependencies. It refuses a changed Box ID, generation, image, source revision/upstream/cleanliness, mount mode, publication, or privilege setting. Its host workspace mutation lock prevents concurrent Ploinky lifecycle changes and concurrent suite runs against the same workspace; manual engine operations remain outside that lock and are checked again before mutations.

Run the offline harness regressions first. They exercise mock HTTP, temporary fixtures and source contracts; they make no live deployment requests:

```sh
npm run test:authorization:harness
```

From this Ploinky checkout, run the full local suite with fresh artifact directories:

```sh
AUTHZ_RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
export AUTHZ_DEPLOYMENT_EVIDENCE=/Users/danielsava/work/deployment-evidence/userpersisto-merge-20260913-nkg3NN
export AUTHZ_CREDENTIAL_DIR=/Users/danielsava/work/deployment-private/userpersisto-merge-20260913-nkg3NN
export AUTHZ_OUTPUT_DIR="/Users/danielsava/work/deployment-evidence/authorization-$AUTHZ_RUN_ID"
export AUTHZ_PRIVATE_DIR="/Users/danielsava/work/deployment-private/authorization-$AUTHZ_RUN_ID"
export AUTHZ_PLAYWRIGHT_MODULE=/Users/danielsava/work/testExplorerFresh/AssistOSExplorer/tests/smoke/node_modules/playwright/index.mjs
npm run test:authorization
```

`AUTHZ_TARGET` is optional and, if set, must equal the exact loopback origin above. Alternative hostnames, ports and origins are refused. The selected baseline is Ploinky `706d9b65dbbf39c33a403cdfecf075bf2b529855`, Explorer `f3590932f3fce75fcb8c290590b114397a9181ae`, and Box `209c0ce14c3f9ff7ef7ecddde77006408dc08c7119a2a45161adcb2f84366871`. The preflight carries all other dependency and immutable image pins. Suite-only commits can run against these unchanged application revisions.

Credential input consists of private, operator-owned `accounts.json` (`adminPassword`) and `admin-storage-state.json` in `AUTHZ_CREDENTIAL_DIR`. An expired administrator session triggers the real configured-password sign-in. Do not paste passwords, codes, cookies or tokens into commands. A fresh private log capture is attached to the exact current UserPersisto container to read only development email codes for newly generated `example.test` addresses. Browser requests are restricted to the selected origin; Google sign-in is never attempted.

| Principal | Creation and independent verification | Expected access |
| --- | --- | --- |
| anonymous | Empty cookie jar; actual agent/Router requests | Public protocol/assets only |
| selfRegistered | New public email registration; verified code; Router token and persisted UserPersisto listing/profile agree | Own account; no workspace/admin access |
| userA | Separate public registration, administrator grants `user`, fresh sign-in | Ordinary workspace access and own private resources |
| userB | Separate public registration and grant; distinct persisted ID from userA | Same ordinary role, used for horizontal probes |
| admin | Existing configured administrator session or recovery sign-in; current Router role verified | Administrative positive controls |

The historical member/selfRegistered storage state is never used: that account was promoted. No guest is accepted as a selfRegistered substitute. The first-account bootstrap rule is intended behavior; pre-setup, unverified, concurrent-claim, restart and later-account regressions live in Explorer's isolated UserPersisto tests, not in a reset of this deployed fixture.

## Results and coverage

| Output | Meaning |
| --- | --- |
| `AUTHZ_OUTPUT_DIR/report.json` | Sanitized checks, principal hashes/roles, request statuses/body hashes, route/tool discovery, source pins, gaps and cleanup |
| `endpoint-coverage.json` / `.md` | Every inventory row, source, role expectation, matching concrete requests and named assertions, including unexercised rows |
| `AUTHZ_PRIVATE_DIR/response-*.json` | Private raw responses for diagnosing a failure; may contain credentials/data; never publish or commit |
| private `principals.json`, cookies and `userpersisto.log` | Disposable identity/session and development delivery evidence; never publish or commit |

Exit `1` means an assertion, setup, cleanup, interruption or ownership error. Exit `2` means executed assertions had no failures but explicit gaps remain. Exit `0` is reserved for an executed run without reported failures or gaps. No empty run, missing endpoint, 404, redirect, malformed request or unavailable backend can produce an authorization pass. A failing assertion is not automatically a confirmed product vulnerability: inspect its authorized control, exact request, response content and side effects first. Failures are retained, not rewritten to match deployed behavior.

The inventories contain 122 Router rows and 832 agent rows across 26 manifests, including 19 enabled runtimes and 310 declared MCP tools. Rows include unresolved wildcard/image-owned families; they are not a count of all concrete endpoints. Tools/list contact never counts as a tools/call assertion. Even a row with recorded assertions does not imply complete role, resource, argument, alias or protocol coverage.

Generate the complete matrix without contacting the deployment:

```sh
npm run authorization:inventory -- --out /Users/danielsava/work/deployment-evidence/authorization-inventory-review
```

Use a new export directory if those output files already exist; exports refuse to overwrite prior evidence or follow output-file symlinks.

See [inventory-notes.md](inventory-notes.md) for repository totals, source regeneration and detailed unresolved families. The checked [Router inventory](router-inventory.mjs) records dispatch order, top-level administrative APIs, proxy paths, static serving, callbacks, SSE/WS and private listener boundaries. The [agent inventory](agent-inventory.mjs) records manifests, actual dispatch references, tool arguments, disabled agents and custom additional servers. Live registry and tools/resources/prompts discovery are reconciled separately.

| Implemented probe family | Controls and limits |
| --- | --- |
| User/role administration | Existing disposable target; admin update positive; anonymous/selfRegistered/both users denied; persisted roles checked after attempted escalation; dashboard and Router paths |
| CSRF and identity forgery | Exact positive mutation; missing/foreign Origin and missing/invalid CSRF; forged user/role/delegation headers; profile arguments cannot select another actor |
| Router routing and catalog | Admin API positive controls; raw encoded/dot/duplicate-slash paths; method override/forwarding headers; marketplace metadata regression |
| Terminal and workspace routes | Test-owned directory; valid Box terminal target/session; harmless printf marker; same existing session SSE/input/resize/delete denials; workspace-file selector and bounded upload checks |
| MCP | Actual agent requests, initialized sessions, discovery vs invocation, administrative/ordinary read controls, two-user aggregate session deletion and valid-session SSE isolation |
| Confidential data | Owner create/read; distinct-user read/write/delete denied; forged identity; read grant positive; denied ACL escalation; immediate revoke using existing session |
| Files, tasks and Git | Disposable workspace/backlog/local Git fixtures; shared ordinary positives; restricted read/write denial; existing-path traversal boundary; no Git network operation |
| WebMeet | Disposable administrator room; ordinary shared-room positives; forbidden rename/delete; side-effect verification |
| Stale sessions | Ordinary role demotion and existing session access; logout and replay of previously valid cookies, after resource cleanup |

## Source candidates requiring live confirmation

| Candidate | Sanitized reproduction implemented | Expected / potential impact |
| --- | --- | --- |
| Marketplace path metadata | Restricted account GET `/api/marketplace`; inspect `skillSource.source`/origin and runtime path fields | Catalog visibility must not disclose privileged filesystem metadata. Potential local-layout disclosure. `cli/server/authHandlers/marketplaceRoutes.js`, `cli/utils/skillRepositorySource.js` |
| Query-selected workspace auth | Anonymous/selfRegistered GET `/workspace-files/<owned-fixture>/fixture.txt?agent=authorization-suite-nonexistent` and `?agent=userPersistoAgent`, compared with owner marker | Workspace data requires granted access. Potential unauthenticated read; a bounded owned upload is attempted only after confirmed read exposure. `cli/server/authHandlers/authContext.js`, `cli/server/static/index.js` |
| Cross-account MCP deletion | userA deletes userB's real initialized `/mcp` session; verify userB ping still succeeds | One account must not invalidate another account's session. `cli/server/routerHandlers.js:734` |
| Username administrator shortcuts | Disposable ordinary profile tries username `admin`; verify persisted role remains `user`; inspect Monitor and WebMeet admin projections; restore name | Authorization must use persisted roles/capabilities. Existing username uniqueness may prevent reproduction. Explorer `workspaceMonitorAgent/lib/admin.mjs`, `webmeetAgent/lib/store/accessPolicy.mjs`, `dpuAgent/lib/dpu-store.mjs` |

## Explicit gaps

Image-owned OnlyOffice DocumentServer, LiveKit/Twirp, Umami and disabled research-agent route namespaces are not completely enumerated. Signed OnlyOffice callback/share/document sessions, LiveKit room-scoped WebSocket tokens, long-lived stream revocation, joined WebMeet participant/chat/media isolation, robot/job ownership and optional browser/desktop backends still require dedicated positive fixtures. The suite inventories these obligations and reports them as gaps; it does not publish extra ports or relax confinement to make them pass.

Global marketplace install/enable/disable/uninstall, provider/secret rotation, broad policy writes and runtime lifecycle mutations are inventoried but are not exercised on business resources. No arbitrary provider inference, Git fetch/push, OAuth provider attack, password brute force or denial-of-service load is included. Private listener/Unix authority routes remain private; their absent public handlers are not positive authorization evidence.

## Cleanup and interruption

Cleanup runs in reverse fixture order before logout/role-demotion tests. It removes owned temporary folders, confidential objects, WebMeet rooms, terminal resources and initialized MCP sessions; restores a changed disposable username; and blocks the three newly created accounts through the supported UserPersisto delete API. Account cleanup is armed before registration so a failed browser redirect or token check still triggers exact-email account recovery. That API retains blocked account/audit records; physical erasure is not claimed. The preexisting administrator and ordinary member accounts are preserved.

The suite records cleanup failures and exits nonzero. SIGINT/SIGTERM requests bounded cleanup after the current request. Hard termination, host failure or ownership drift can prevent cleanup; retain the private evidence and inspect exact recorded fixture IDs. Never use wildcard business-data deletion to compensate. Raw/private artifacts remain for operator diagnosis; remove them only when no longer needed. Existing artifact directories cannot be reused for a live run.

Harness regressions cover wrong principals/roles, guest substitution, missing endpoints/redirects, contradictory MCP error envelopes, empty/non-authorization denial bodies, false tool coverage, path/shell injection, output symlinks/nesting, interrupted/final-ownership outcomes, bounded trickling responses and credential redaction.
