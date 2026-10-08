# Agent authorization inventory

The checked module is a source inventory, not a passing security report. It contains 27 agent manifests across seven agent repositories: the 16 runtimes enabled by the reviewed manifest graph (`acceptance/expected-runtimes.json`, profile `default`) and 11 disabled agents (seven intentionally disabled, the three optional WebMeet STT, WebMeet scribe and OnlyOffice surfaces, and `proxies/opencode-free`, which is new in the pinned proxies repository and awaits classification review). It lists 336 statically declared MCP tools. The 889 total rows also include common AgentServer routes, explicit custom HTTP operations, manifest policy families and unresolved image-owned route families. Wildcard families are obligations to investigate, not a count of concrete endpoints. The live report supplies actual discovery differences, assertions, failures and gaps.

Router references preserve the complete union of the two prior 128-row inventories in `router-reference-obligations_codex.json`. Their inventory-file SHA-256 values, source references, anchors and complete authority-contract digests remain recorded. The 27 candidate-added anchors remain obligations on both products, yielding 43 anchored rows; each product retains its exact original anchor literals, including asynchronous static handlers in the candidate and their grounded synchronous counterparts in the baseline. The identical overlay checks exact file-blob-bound statements for 73 rows across all nine affected source files. `routerInventoryBaseline` exposes the reviewed canonical references; `routerInventory` selects the actual product references and reports source blob hashes. Unknown file bytes, missing union rows or anchors, changed authority contracts, stale metadata and weakened prior anchors fail. Repository install/uninstall and agent enable references identify dispatch branches rather than assertion-tool selectors; WebTTY UI references select the method-checked branch rather than its earlier path filter. The resolver uses Node built-ins and adds no package dependency. These checks establish source provenance only; live authorization and coverage requirements remain unchanged. Historical evidence for the earlier two-handler overlay is retained and does not verify the corrected union.

| Repository | Manifest agents | Enabled by the graph | Static MCP tools |
| --- | ---: | ---: | ---: |
| AchillesIDE / AssistOSExplorer | 14 | 12 | 266 |
| AchillesCLI | 2 | 1 | 32 |
| copilot-agents | 5 | 0 | 14 |
| OnlyOfficeAgent | 1 | 0 | 0 |
| proxies | 3 | 1 | 3 |
| UmamiAgent | 1 | 1 | 8 |
| local-llms | 1 | 1 | 13 |

Inventory delta from the previous checked inventory (25 agents, 18 enabled): `local-llms/local-llm` added and enabled (inventory and safe protocol checks only, no inference); `proxies/opencode-free` added as disabled; onlyOffice (now in the OnlyOfficeAgent repository), webmeetStt and webmeetScribeAgent reclassified from enabled to disabled because the pinned Explorer manifest does not enable them (Codex Q2); no entry removed; the retired `default-local-llm` stays excluded. Every reclassified agent keeps all of its rows, each marked as a disabled-runtime gap.

`inventoryBaseline` pins all dependency source revisions. `agentCatalog` identifies source, runtime state, declared tool names, manifest HTTP policy, explicit endpoint declarations and additional-server ports. `agentInventory` gives method, Router path or operation selector, owning source line, implementation references, expected role access, policy rationale and an explicit coverage status. `nonAgentRepositories` records the Ploinky runtime, AchillesAgentLib, container-image-builds and AxiFace dependencies, whose root layouts contain no independent first-level Ploinky agent manifest. Agent discovery follows the first-level repository directory rule in `cli/utils/repos.js:183`; live runtime reconciliation fails if a running agent is absent from the manifest inventory.

The generator reads JSON declarations and source text. It does not import executable agent handlers, execute commands from manifests, start agents, or contact any target. Shell command entrypoints and literal handler references are located separately from tool declarations. `handlerSources` identifies evidence to review, not a proof that every code path has been analyzed. Commands whose implementation is generated or image-owned retain an explicit gap. Exact custom HTTP registration is parsed for Soul Gateway; hand-reviewed dispatch shapes expand RoboTeam, UserPersisto, OnlyOffice, STT and browserUse handlers. No regex-only source hit is counted as a successful authorization test.

The 26 checked agent configurations declare no MCP resources or prompts. That source observation does not prove that image-owned or runtime-generated discovery exposes none. The suite separately requests `resources/list`, `resources/templates/list` and `prompts/list` alongside `tools/list`. Unsupported methods and continuation cursors produce explicit gaps; the bounded first page does not imply complete discovery.

The enabled flags come from the reviewed manifest graph, never from live state. Derive the identity set first, then regenerate the inventory from the same clean pinned checkouts, giving the generator a runtime summary built from `acceptance/expected-runtimes.json` and a preflight listing `ploinky` (path `.`) plus every repository in `acceptance/policy.json` `inventoryRepositories` at its pinned commit. The generator refuses mismatched revisions; it reads working trees, so they must be clean.

```sh
node tests/security/authorization/acceptance/expected-runtime-graph.mjs --pins /abs/pins.json --check
node tests/security/authorization/inventory-generate.mjs \
  --preflight /abs/preflight.json \
  --workspace /Users/danielsava/work/testExplorerFresh \
  --explorer-source /Users/danielsava/work/testExplorerFresh/.ploinky/repos/AchillesIDE \
  --ploinky-source "$PWD" \
  --runtime-summary /abs/runtime-summary-from-expected-runtimes.json \
  --out tests/security/authorization/agent-inventory.mjs
node --test tests/security/authorization/inventory-probes.test.mjs
```

Before pins exist, `expected-runtime-graph.mjs --workspace-heads /Users/danielsava/work/testExplorerFresh --check` derives the set from the clean fixture HEADs; it must be rerun with `--pins` against the frozen pin manifest.

## Expected access and live controls

The expected principal matrix uses anonymous, a real selfRegistered account, two distinct ordinary user accounts and an administrator. The accepted product rule permits selfRegistered account/dashboard functions and excludes workspace operations until an administrator grants access. A manifest that checks only authentication does not redefine that product requirement. UserPersisto self-service operations remain actor-bound; administrative user, policy, provider and billing operations require their persisted capabilities. `internal` MCP tags require a verified agent assertion, including when the browser caller is administrator. Public protocol exceptions (OAuth/OIDC, OnlyOffice editor transport and LiveKit signaling) require their separate bound proofs; a browser administrator session cannot substitute for those proofs.

MCP `tools/list` is recorded separately from `tools/call`: visible tool metadata alone does not establish execution permission. Authenticated calls use a valid initialized session, route-bound browser proof and schema-valid read operation. Anonymous calls send initialization directly to the actual agent endpoint without borrowing another principal's proof or session. Preparation failures from `/auth/token` cannot stand in for agent-route results. Reports identify whether the actual agent rejected initialization or reached the requested MCP method; an initialization denial does not claim handler-level execution coverage.

Every forbidden call requires a working administrator positive control. HTTP and MCP read controls validate source-derived payload shapes and applicable principal/role projections. An HTTP 200 containing an error or contradictory failure envelope cannot establish success. Successful same-role ordinary controls prevent blanket denial from passing. Tool-level errors must identify an authorization decision; redirects, missing resources/endpoints, input validation and unavailable backends are not accepted as denials. SSE cross-session checks run only after an actual event-stream response from an initialized administrator session.

## Boundaries and unresolved coverage

| Surface | Source/expected boundary | Explicit limitation |
| --- | --- | --- |
| Common AgentServer | `Agent/server/AgentServer.mjs:1248-1415`: health/card, task status/cancel, MCP session/discovery/call, OpenAI compatibility, static files | A custom agent server can replace these routes. Each must have an actual live positive control before its denial is counted. Agent-card is absent unless configured. |
| Router agent aliases | `cli/server/RoutingServer.js`, static serving and `edgeRoutePlan.js` | Inventory paths use canonical agent names. Additional live registry keys, exact roots, static aliases and normalization variants must be reconciled with Router inventory/live evidence. No complete alias claim follows from one canonical route. |
| Explorer / DPU | Workspace capability, confined paths and private DPU owner/grant ACL | Shared ordinary workspace files are not automatically account-private. Confidential files, documents, secret projections and participant media require valid disposable resources for horizontal checks. |
| Tasks / Git | Task backlog/history files and Git operations are workspace-scoped; GitHub credentials bind to current caller | No external Git/network actions, credential borrowing or mutation of real repositories. Per-user IDOR cannot be inferred merely from documented shared workspace data. |
| RoboTeam | `server/http-server.mjs`: create/delete/terminal/skillset changes require admin; ordinary workspace roles may use shared robots | GUI/browser backend setup has known permission failures. Session/control authorization remains a separate obligation; failed optional tools do not prove denial. Workspace robots and homes are robot-scoped, not implicitly user-owned. |
| WebMeet | `tools/webmeet_tool.mjs`, room access/participant policies | Authenticated non-guest rooms are workspace-shared; guest tokens must be scoped to a room, participant ID and resource. LiveKit media/signaling positive control needs a real scoped token and active disposable room. |
| OnlyOffice | Authenticated control on 7000; public editor proxy on 8080; storage callbacks on private 9100 | GET control creates an editing session. DocumentServer binary HTTP/WS namespace is not enumerated from agent source. Valid signed callback/session token plus disposable document is required for positive callback tests. |
| LiveKit | Public signaling transport plus provider JWT; Twirp service policy and signed grant | Concrete methods within pinned image-owned RoomService/AgentDispatchService namespaces remain unresolved. Private supervisor `/ready` listens only on 17000 loopback. |
| Umami | Authenticated Router dashboard ingress on 3000; explicit eight read-only MCP adapters | Next/Umami 3.2.0 image supplies dashboard/API/share/tracking endpoints; agent repository owns only wildcard ingress. Upstream account/website/team CRUD/share route enumeration remains a gap. Do not claim all endpoints covered. |
| UserPersisto OIDC | Public protocol delegation to pinned oidc-provider | Exact generated token, authorization, interaction, logout, device and discovery variants need library-level enumeration and a disposable local client. Google provider itself is outside scope. |
| Soul Gateway | All registered management HTTP/SSE/WS routes wrap verified admin authority; public `/v1` additionally requires API credential | No inference or external provider lifecycle probes. Key/model/provider-ID operations require bounded disposable resources; global configuration mutation is not justified by an empty/malformed denial. |
| Disabled agents | Intentional: GPTResearcher, browserUseAgent, copilotProviderRelay, openInterpreterAgent, research-agents, webSearchAgent, searchAgent. Optional: webmeetStt, webmeetScribeAgent, onlyOffice. Unclassified: opencode-free | Sources and tools are inventoried; none is enabled by this suite. GPTResearcher upstream HTTP/WS routes and disabled backend functionality remain unavailable. |
| Additional services and static assets | Manifest declarations, actual startup scripts and HTTP handlers | Image-owned listeners and dynamic/static filenames are open namespaces. The checked inventory labels them as families. Internal-only listeners must never be published to improve testability. |

The source review found legacy username-based administrator shortcuts in Workspace Monitor (`lib/admin.mjs:10`), WebMeet (`lib/store/accessPolicy.mjs:30`) and DPU audit (`lib/dpu-store.mjs:207`). The live suite attempts the bounded disposable username change through UserPersisto, verifies the current persisted ordinary role, checks admin projections, then restores the original username. Username uniqueness can make this unreachable in an already-claimed deployment. A rejected name is recorded honestly as a coverage limitation; a source shortcut alone is not reported as a confirmed live exploit.

Raw responses, session IDs, request proofs and profiles stay in private run artifacts. Checked source and sanitized reports contain no account credentials, email codes, cookies, JWTs or provider secrets. Run the top-level suite command documented alongside the harness for ownership guards, fixture setup/cleanup and the combined endpoint coverage report.
