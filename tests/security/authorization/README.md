# Local authorization regression suite

This suite targets only the already accepted deployment at `http://127.0.0.1:8080`, owned by `/Users/danielsava/work/testExplorerFresh`. It does not redeploy, change application code, reset bootstrap, publish ports, activate disabled agents, use host provider credentials, or call external services as security targets.

The final live security run is left to the operator. The development setup run verified fresh public registration and current roles, then stopped before security assertions because a probe adapter was unfinished; its disposable accounts were blocked and the exact Box/source guard passed afterward. That run is not a penetration-test result. Suspected issues below remain unconfirmed until their regression assertions are executed and the private evidence is inspected.

## Run

Use Node.js 22 or newer, the existing authenticated local Podman CLI, and the pinned deployment's existing Playwright/Chromium installation. The suite itself uses Node built-ins and does not install dependencies. It refuses a changed Box ID, generation, image, source revision/upstream/cleanliness, mount mode, publication, or privilege setting. Its host workspace mutation lock prevents concurrent Ploinky lifecycle changes and concurrent suite runs against the same workspace; manual engine operations remain outside that lock and are checked again before mutations.

Run the offline harness regressions first. They exercise mock HTTP, temporary fixtures and source contracts; they make no live deployment requests:

```sh
npm run test:authorization:harness
```

The live suite runs only against an exact, pushed and deployed candidate described by an external pin manifest. The procedure is fixed:

1. Push the candidate and deploy it (Router before Explorer). Nothing in this directory contains a commit SHA.
2. Write `pins.json` outside the source tree (schema below), have it reviewed, then freeze it: `chmod 0444 pins.json` and record `shasum -a 256 pins.json`.
3. Capture deployment evidence, pins first. Any hash, SHA, branch/upstream, containment, cleanliness or policy-digest mismatch exits 1 before the Box is inspected or anything is written:

```sh
node tests/security/authorization/acceptance/evidence-capture.mjs --pins /abs/pins.json --pins-sha256 <hex> --out /abs/new-evidence-dir
```

4. Run the focused offline tests at the pinned commit with TAP bound to that commit (`acceptance/offline-tap.mjs`, one TAP and sidecar per file; the AchillesIDE DPU test runs from the pinned AchillesIDE checkout with `--repo-name AchillesIDE`).
5. Run the full suite through the A7 wrapper, which captures the raw exit code itself and then evaluates the scoped gate:

```sh
AUTHZ_RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
export AUTHZ_DEPLOYMENT_EVIDENCE=/abs/new-evidence-dir
export AUTHZ_CREDENTIAL_DIR=/abs/private-credential-dir
export AUTHZ_OUTPUT_DIR="/Users/danielsava/work/deployment-evidence/authorization-$AUTHZ_RUN_ID"
export AUTHZ_PRIVATE_DIR="/Users/danielsava/work/deployment-private/authorization-$AUTHZ_RUN_ID"
export AUTHZ_PLAYWRIGHT_MODULE=/abs/playwright/index.mjs
export AUTHZ_PINS=/abs/pins.json AUTHZ_PINS_SHA256=<hex>
node tests/security/authorization/acceptance/run-acceptance.mjs --offline-dir /abs/offline-tap-dir
```

`npm run test:authorization` still runs the unchanged full suite with the same environment; it refuses to start without `AUTHZ_PINS` and `AUTHZ_PINS_SHA256`, and records a setup error with no registration request when the pins, the running checkout, the policy digest or the Box identity differ.

`pins.json` (`authz-acceptance-pins/1`): `ploinky` `{commit, branch, upstream}`; `ploinkyCheckout` (absolute real path of the checkout mounted at `/opt/ploinky`, from which the suite must run); `workspace`; `repositories[]` `{name, path (workspace-relative), commit, branch, upstream}` for every repository in `acceptance/policy.json` `inventoryRepositories`; `policyDigest` (`node tests/security/authorization/acceptance/digest.mjs`); `box` `{id, name, startedAt, imageId, imageDigest}`; `agentlib` `{mode: image|local, sourceRelativePath?}`.

`AUTHZ_TARGET` is optional and, if set, must equal the exact loopback origin above. Alternative hostnames, ports and origins are refused. Candidate, dependency and Box identities come only from the frozen pin manifest; the guard compares the captured evidence with it and applies the fixed Box confinement policy (`assertBoxConfinement`, derived from `ploinky-box/contract/container.mjs` and `constants.mjs`), so a captured snapshot can never widen what is accepted.

Credential input is a private, operator-owned `admin-storage-state.json` in `AUTHZ_CREDENTIAL_DIR`, captured after a normal Google or verified-email administrator sign-in. An absent or expired administrator session stops the suite; refresh that private storage state before retrying. Do not paste codes, cookies or tokens into commands. A fresh private log capture is attached to the exact current UserPersisto container to read only development email codes for newly generated `example.test` addresses. Browser requests are restricted to the selected origin; Google sign-in is never attempted.

| Principal | Creation and independent verification | Expected access |
| --- | --- | --- |
| anonymous | Empty cookie jar; actual agent/Router requests | Public protocol/assets only |
| selfRegistered | New public email registration; verified code; Router token and persisted UserPersisto listing/profile agree | Own account; no workspace/admin access |
| userA | Separate public registration, administrator grants `user`, fresh sign-in | Ordinary workspace access and own private resources |
| userB | Separate public registration and grant; distinct persisted ID from userA | Same ordinary role, used for horizontal probes |
| admin | Existing administrator session from normal passwordless sign-in; current Router role verified | Administrative positive controls |

The historical member/selfRegistered storage state is never used: that account was promoted. No guest is accepted as a selfRegistered substitute. The first-account bootstrap rule is intended behavior; pre-setup, unverified, concurrent-claim, restart and later-account regressions live in Explorer's isolated UserPersisto tests, not in a reset of this deployed fixture.

## Results and coverage

| Output | Meaning |
| --- | --- |
| `AUTHZ_OUTPUT_DIR/report.json` | Sanitized checks, principal hashes/roles, request statuses/body hashes, route/tool discovery, source pins, gaps and cleanup |
| `endpoint-coverage.json` / `.md` | Every inventory row, source, role expectation, matching concrete requests and named assertions, including unexercised rows |
| `AUTHZ_PRIVATE_DIR/response-*.json` | Private raw responses for diagnosing a failure; may contain credentials/data; never publish or commit |
| private `principals.json`, cookies and `userpersisto.log` | Disposable identity/session and development delivery evidence; never publish or commit |

Exit `1` means an assertion, setup, cleanup, interruption or ownership error. Exit `2` means executed assertions had no failures but explicit gaps remain. Exit `0` is reserved for an executed run without reported failures or gaps. No empty run, missing endpoint, 404, redirect, malformed request or unavailable backend can produce an authorization pass. A failing assertion is not automatically a confirmed product vulnerability: inspect its authorized control, exact request, response content and side effects first. Failures are retained, not rewritten to match deployed behavior.

## Scoped A6 acceptance

The raw suite result is never reinterpreted: exit 2 stays `NO_FAILURES_WITH_GAPS`. `acceptance/verify-acceptance.mjs` separately returns ACCEPT or REJECT with every reason. It ACCEPTs only when the raw exit code (captured by the wrapper) matches `report.verdict` and is 2; FAIL and ERROR are 0; there is no setup error or interruption; every cleanup, `finalOwnership` and the lock release passed; the report is bound to the reviewed pins hash, policy digest, Box identity and repository commits; the four principals have their reviewed roles; the live runtime set equals `acceptance/expected-runtimes.json` exactly; every entry of `acceptance/mandatory-checks.json` occurs the expected number of times, all PASS, with a passing positive control; every offline mandatory TAP was produced at the pinned commit on a clean tree with nothing failed, skipped, cancelled or todo; and the gap list equals `acceptance/expected-gaps.json` exactly by identity and typed evidence.

| File | Content |
| --- | --- |
| `acceptance/policy.json` | Root agent, reviewed profile (`default`, with its source), inventory repositories, Box/mount policy inputs, changed boundary rows (U3/U6/U7), boundary statuses, exit-code map, principal roles |
| `acceptance/expected-runtimes.json` | Derived by `expected-runtime-graph.mjs` from manifests read with `git show <sha>` and the explicit profile; `--check` must equal it. An empty profile exits 1 |
| `acceptance/expected-gaps.json` | Exact gap identities with category, cited source, reason, affected obligations, justification and a typed evidence rule. Unavailable positives, transport errors, timeouts, 503, pagination, `agent.username-admin.*`, fixture-unavailable and admin-unavailable outcomes never match |
| `acceptance/mandatory-checks.json` | Enumerated by `mandatory-checks.mjs --check` from the probe definitions crossed with actors, never from a run report |

Gap evidence is typed (`ctx.recordGap(id, reason, evidence)`): only enumerated scalars and sorted names are kept, never error text. A discovery exclusion requires an initialized administrator session, the actual stage equal to the requested method, HTTP 200 and RPC -32601; an initialization -32601 or an unavailable positive under the same ID rejects. A raw-path boundary gap requires its `routerCoverage` row to be `BOUNDARY_REJECTED_ONLY` with a reviewed status; such an entry may instead be absent only if the explicit denial check PASSed. A selfRegistered metadata-visibility exclusion requires exact equality with the reviewed visible-tool list; none is listed yet, so any such gap rejects. Raw users-list paths follow the traced D2 matrix: dot-segment, parent-segment, encoded-parent and encoded-owner must be explicit 401/403 denials for all four restricted actors; duplicate-slash, encoded-resource, encoded-slash and double-encoded-slash must be denials for anonymous and selfRegistered and exactly-404 boundary gaps for userA/userB; every denial is linked to its exact `routerCoverage` record. The comparator recomputes the mandatory list from the enumerator and re-derives the runtime graph from the pinned manifests, and verifies the Box image digest.

WebChat (U6) evidence uses the real pinned DPU protocol: each visible unsupported slash command produces the generic acknowledgement `This command is not supported by DPU Research.` (AchillesIDE `dpuAgent/src/index.mjs:250-263`), attributed by stream and freshness, plus the unique Router `user-message` marker. Copied-ID operations count only when B's own runtime acknowledges them and A's DPU process (pid plus kernel start time, attributed by its router-issued `--sso-user-id`, inspected inside the pinned DPU container) is unchanged; 503, 409, 400 and missing-resource outcomes never count. No pending interaction can be created without inference, so `report.liveLimitations` records that limitation exactly and the actual-module `webchat-interaction-isolation.test.mjs` is mandatory offline evidence. Cleanup verifies runtime removal on every path.

Browser origin and registration: UserPersisto restarts login on its canonical loopback origin, so the browser treats `http://127.0.0.1:8080` and `http://localhost:8080` as the same selected Router and aborts every other origin; a login that lands anywhere else fails setup. The raw Client still dials only 127.0.0.1:8080, and `AUTHZ_TARGET` must still equal `http://127.0.0.1:8080`. Disposable principals are registered through the deployment's advertised path from `/service/auth/setup`: password sign-up when open sign-up needs no verification, otherwise the development email code; with neither, setup fails closed. Roles are assigned and accounts blocked through the same administrator APIs as before. The administrator is the already-claimed task-owned account from its private 0600 storage state; the suite never performs a first-run claim.

Fixture prerequisite: the task-owned test administrator must not hold the username `admin` (the username-shortcut probe renames a disposable user to `admin`); prepare it with a unique username through the normal fixture setup. Capability partition (`policy.json` `capabilities`, r2b_remediation_decisions_codex.md D3/D4) is separate from enabled/readiness membership: LiveKit stays an enabled runtime but has no MCP surface (start_only, no primary port), so its four discovery methods and GET transport are non-applicable; Soul Gateway serves no upstream `/mcp`, so only its Router-forwarded `tools/list` and `resources/list` are non-applicable while its Router-local initialize, `-32601` defaults and GET 405 contract stay asserted. Each classification is bound to pinned file bytes, manifest facts and Ploinky route anchors, re-verified by `expected-runtime-graph.mjs` (drift is `CAPABILITY_CONTRACT_DRIFT`); the report lists non-applicable surfaces in `capabilityNonApplicable`, never as tested authorization; and retained real-service controls (LiveKit route without a primary port, pinned image, public 7880 signaling positive, Twirp anonymous denial, administrator 404 corroboration; Soul health with database) are mandatory, alongside the existing Soul management positives and denials.

New live controls: U3 protected/public template revalidation and navigation (`boundary-probes.mjs`), U7 marketplace unknown-action admission with a 400 positive, explicit denials and a normalized no-effect listing digest (`boundary-probes.mjs`), and the bounded per-user U6 WebChat probe (`webchat-probes.mjs`). The U7 positive relies on the request-path lease `commit()` being write-free, which `lease-readonly.test.mjs` proves on a real edge generation.

The inventories contain 128 Router rows and 889 agent rows across 27 manifests, including the 16 runtimes enabled by the reviewed manifest graph and 336 declared MCP tools. Rows include unresolved wildcard/image-owned families; they are not a count of all concrete endpoints. Tools/list contact never counts as a tools/call assertion. Even a row with recorded assertions does not imply complete role, resource, argument, alias or protocol coverage.

Generate the complete matrix without contacting the deployment:

```sh
npm run authorization:inventory -- --out /Users/danielsava/work/deployment-evidence/authorization-inventory-review
```

Use a new export directory if those output files already exist; exports refuse to overwrite prior evidence or follow output-file symlinks.

The written per-row review of the 2026-10-08 router source reference additions is [router-reference-review-2026-10-08_claude.md](router-reference-review-2026-10-08_claude.md).

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
