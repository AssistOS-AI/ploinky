# RoutingServer Agent-Port Convention — Implementation Plan

**Date:** 2026-07-20
**Repo root:** `/Users/danielsava/work/file-parser/ploinky`
**Branch:** `ploinky-proxy`
**Target contract:** `/Users/danielsava/work/file-parser/ploinky/docs/superpowers/specs/2026-07-20-routingserver-unified-browser-proxy-requirements.md`
**Posture:** Greenfield hard cut. No compatibility readers, migration tooling, translation, dual operation, or legacy fallbacks. This document is a plan only; it writes no implementation code.

The convention is not releasable after Phase A alone. Phases A and B build dormant infrastructure, Phase C performs the hard cut, and Phase V is the blocking release verification. This prevents an intermediate deployment that lacks immutable generations, authorization-to-dial leases, or the final socket boundary.

---

## 0. Resolved Decisions

| # | Decision | Consequence |
| --- | --- | --- |
| D1 | **Container-network-namespace only.** The convention is available only for `podman`/`docker` agents with a dedicated container network namespace. Seatbelt, bwrap, and `network.mode: host` remain unavailable and return a bounded `503`. | No host-network relay or host-loopback fallback exists. Confinement is compiled into the active generation, not discovered from request input. |
| D2 | **The reserved prefix is exactly `base-agent-additional-server`.** | A central route-key validator prevents an agent name or alias from registering this prefix. The policy engine may still match the complete conventional path. |
| D3 | **The authenticated port-scan oracle is an accepted risk.** | No rate-limit or uniform-error mitigation is added. Audit events remain mandatory. |
| D4 | **The runtime relay is a Ploinky-owned exec/stdio channel, not AgentServer and not a TCP listener.** RoutingServer starts `/Agent/server/RuntimeHttpRelay.mjs` with `podman exec -i` or `docker exec -i` in the already-selected agent container. A length-delimited authenticated control/data protocol is carried on stdin/stdout. The relay dials only `127.0.0.1:<validated-port>` inside that container's network namespace. | The relay works regardless of `manifest.start` or `manifest.agent`, has no browser-reachable socket, consumes no agent-local TCP port, and never reuses or overwrites `route.hostPort`. Port `7000` remains a valid application selector unless trusted runtime state independently marks it as privileged for that effective instance. |
| D5 | **Agent TCP ports are never host-published in the final state.** Profile `openPorts`, `additionalServerPort`, direct `hostPort` route state, and runtime `-p .../tcp` publication are removed as agent-routing mechanisms. Primary agent HTTP and convention-selected HTTP both use the same runtime relay and route-plan executors. | RoutingServer's public socket is the only externally reachable Ploinky TCP application socket. Media UDP provisioning remains a separate deployment concern and cannot be created from an agent manifest/profile. |
| D6 | **Relay authentication uses a distinct relay-request envelope.** It reuses the per-agent Router Request signing primitive but introduces a relay-specific signed surface and a control-frame carrier; it does not use `Agent Assertion` and does not consume the proxied application's `Authorization` header. | The signed surface binds target principal, effective instance/generation, relay session, HTTP method, canonical agent-local port, rewritten path, query, body mode/hash, expiry, and nonce. Relay auth metadata is removed before application bytes are emitted. |
| D7 | **HTTP/1.1 is the supported upstream protocol in this change.** HTTP/2 absolute-form, h2c, and unsupported upgrade forms fail explicitly before relay checkout. | HTTP, streaming HTTP, SSE, and WebSocket share one HTTP/1.1 route plan and lease. |
| D8 | **Public/private listeners have explicit bindings.** Public `8080` uses the operator-selected public bind. Private `8081` binds exactly to host `127.0.0.1`, never a wildcard or caller-configured address. Container callers use the runtime-owned `host.containers.internal`/`host.docker.internal` mapping only after a startup proof shows that it reaches the loopback-bound listener; a backend that fails this proof leaves `8081` disabled. | Listener class and exact authority are generation inputs. A non-loopback host probe must fail to connect to `8081`; a trusted-runtime probe must still pass its assertion and ACL. |
| D9 | **Convention access defaults to `authenticated`.** The policy evaluator receives the selected owner route key and a convention-specific fallback. The existing generic route-default fallback is not reused. | No absent policy can become `guest`. Explicit trusted policy entries still participate in the complete-path most-restrictive match. |
| D10 | **Response policy is explicit and convention-specific.** | Request sanitization, response sanitization, redirects, Router cookies, application credentials, CORS, caching, and private-origin disclosure are covered by named tasks and tests. The behavior of unrelated proxy routes is not silently changed. |
| D11 | **No migration gate exists.** | Legacy fields and proxy paths are deleted outright in Phase C. Inventory commands prove removal coverage only; they never translate or block on downstream users. |
| D12 | **Release requires A+B+C+V.** | A and B may be developed in parallel while dormant, but no production route recognizes the convention until the atomic Phase-C cut and all Phase-V gates pass. |

### Fixed relay protocol

The exec/stdio relay uses one versioned binary framing model shared by Router and relay:

| Frame | Required content and rule |
| --- | --- |
| `HELLO` / `READY` | Protocol version, immutable container identity, effective agent principal, generation digest, relay-session nonce, canonical trusted deny-set values+digest, and a Router-signed relay-session envelope over all of them. The relay verifies the envelope before `READY`; `READY` echoes the bound identities and digests. Any mismatch terminates the child before a target dial. Request input can neither add nor remove a denied port. |
| `OPEN` | Request id, HTTP/1.1 or WebSocket mode, method, canonical port/path/query, body mode, normalized application headers, limits, and relay-request token. The relay verifies the token and deny set before dialing. |
| `DATA` | Length-delimited request or response bytes for one request id. Aggregate byte limits are enforced incrementally; invalid length, unknown request id, duplicate terminal frame, and limit overflow close that stream. |
| `HALF_CLOSE`, `CANCEL`, `END`, `ERROR` | Explicit lifecycle frames. Cancellation propagates in both directions and releases the route-generation lease and relay stream. |

Body-bound routes buffer the exact bounded bytes, compute `computeRchHttp`, mint the relay request, commit the generation lease, then emit `OPEN`. Routes whose compiled plan permits streaming use a signed `stream-v1` body mode and enforce the compiled incremental byte limit in both Router and relay. Application `Authorization` and permitted application cookies live only in the application-header field and are never used as relay authentication.

### Fixed default limits

Defaults live in `/Users/danielsava/work/file-parser/ploinky/cli/server/proxy/limits.js` and may be overridden only by trusted generation input: 64 KiB request/response headers, 8 MiB buffered body, 64 MiB streamed body, 5 s relay/target connect timeout, 15 s header timeout, 60 s ordinary idle timeout, 30 min SSE/WebSocket lifetime, 1 MiB WebSocket frame, 8 MiB WebSocket message, 64 concurrent streams per agent, and 256 total. Invalid overrides make the candidate generation inactive.

---

## 1. Current-Code Constraints That Shape the Work

| Observation | Evidence and consequence |
| --- | --- |
| AgentServer is only the fallback command; explicit `start` or `agent` commands replace it. | `/Users/danielsava/work/file-parser/ploinky/cli/sandbox/docker/agentServiceManager.js:930-970`. The relay must be launched independently of the agent entry command. |
| The launcher currently accepts profile `openPorts`, including caller-selected host IPs, and emits runtime `-p` arguments. | `/Users/danielsava/work/file-parser/ploinky/cli/sandbox/docker/common.js:329-367`, `/Users/danielsava/work/file-parser/ploinky/cli/sandbox/docker/agentServiceManager.js:798-811`. Final-state enforcement requires deleting this TCP publication path, not merely testing around it. |
| `ensureAgentService` and route writers expose one overloaded `hostPort`. | `/Users/danielsava/work/file-parser/ploinky/cli/sandbox/docker/agentServiceManager.js:1402-1403`, `/Users/danielsava/work/file-parser/ploinky/cli/utils/agents.js:406-416`. Relay identity must be a distinct container/generation descriptor, and final route state must not contain a host dial address. |
| Generic route access currently falls back to `guest`. | `/Users/danielsava/work/file-parser/ploinky/cli/server/authHandlers/authContext.js:201-223`. Convention policy requires a separate authenticated fallback. |
| Existing Router Request verification binds method/path/tool/request hash, while `agentAssertion.mjs` signs the opposite agent-to-Router direction. | `/Users/danielsava/work/file-parser/ploinky/Agent/lib/requestSignedTokens.mjs:14-18`, `/Users/danielsava/work/file-parser/ploinky/Agent/lib/agentAssertion.mjs:8-15`. Relay requests need an explicit Router minter, relay verifier, and non-application-header carrier. |
| The reserved prefix is not currently protected as an agent alias; only `_config` is reserved. | `/Users/danielsava/work/file-parser/ploinky/cli/utils/agents.js:31-61`. Registration-time validation is required in addition to request parsing. |
| `handleHttpServiceUpgrade` is called but not imported by RoutingServer. | `/Users/danielsava/work/file-parser/ploinky/cli/server/RoutingServer.js:631`. Phase 0 repairs and verifies this independent live defect before transport work. |
| On this darwin/Podman workspace, a container request to `host.containers.internal` reached a temporary host HTTP listener bound only to `127.0.0.1`. | **Verified 2026-07-20** with an ephemeral Node listener and `podman run`; the implementation must reproduce this as a startup/integration proof rather than assume it for every backend. |

---

## 2. Phase Sequence and Release Boundary

```text
Phase 0 ──► Phase A (dormant convention + relay) ─┐
                                                  ├──► Phase C (atomic hard cut) ──► Phase V (release gates)
Phase B (generations, leases, private listener) ──┘
```

| Phase | Entry gate | Exit gate |
| --- | --- | --- |
| **0. WebSocket defect** | None. | Existing HTTP-service WebSocket e2e passes. |
| **A. Dormant convention and relay** | Phase 0 complete for WS work. | Parser, registration guard, relay protocol, container-confined relay, policy, rewrite, trust policy, and transports pass tests, but production dispatch remains disabled. |
| **B. Immutable routing core** | B1 may start independently and in parallel with A; B2-B5 integrate only after their named A-task dependencies complete. | Generations, leases, private listener/assertions, and generation-bound locator pass race and exposure tests. |
| **C. Atomic greenfield hard cut** | A and B complete. | One activation changes primary/conventional traffic to generation-backed relays and deletes `hostPort`, TCP `openPorts`, `additionalServerPort`, and profile-server behavior. There is no compatibility or dual-operation interval. |
| **V. Release verification** | C complete. | Full suite, container confinement, socket-boundary scan, real-browser base-path suite, and LiveKit signaling/media suite all pass. Failure in any gate blocks release. |

---

## 3. Task Breakdown

All commands run from `/Users/danielsava/work/file-parser/ploinky`.

### Phase 0 — Existing WebSocket defect

| Task | Files and change | Dependencies | Verification |
| --- | --- | --- | --- |
| **0.1 Import the upgrade handler** | Modify `/Users/danielsava/work/file-parser/ploinky/cli/server/RoutingServer.js`: import `handleHttpServiceUpgrade` from `./wsServiceProxy.js`. No other behavior change. | — | Before the fix, `node --test tests/unit/wsProxyE2e.test.mjs` reproduces the reset. After it, `node --test tests/unit/wsServiceProxy.test.mjs tests/unit/wsProxyE2e.test.mjs` passes. |

### Phase A — Dormant agent-port convention and runtime relay

| Task | Files and change | Dependencies | Verification |
| --- | --- | --- | --- |
| **A1. Relay protocol and signed surface** | Create `/Users/danielsava/work/file-parser/ploinky/cli/server/runtimeRelay/protocol.js`, `/Users/danielsava/work/file-parser/ploinky/cli/server/runtimeRelay/relayRequestMinter.js`, `/Users/danielsava/work/file-parser/ploinky/Agent/lib/relayRequestAuth.mjs`, and shared hash additions in `/Users/danielsava/work/file-parser/ploinky/Agent/lib/requestHash.mjs`. Implement the fixed frames and D6 binding. The signed session envelope carries the generation-compiled deny set and its digest; each signed `OPEN` binds the same session. Use dedicated control frames rather than `Authorization`; never use `agentAssertion.mjs`. | — | `node --test tests/unit/runtimeRelayProtocol.test.mjs tests/unit/relayRequestAuth.test.mjs` passes malformed length, unknown frame, wrong agent/container/generation/session/deny-set/port/path/query/body-mode/hash, expiry, replay, request attempts to alter the deny set, and application-Authorization preservation cases. |
| **A2. Runtime-owned in-container relay** | Create `/Users/danielsava/work/file-parser/ploinky/Agent/server/RuntimeHttpRelay.mjs`. It has no `listen()` call, reads only framed stdin, verifies `HELLO` and every `OPEN`, validates the trusted deny set, and dials only numeric `127.0.0.1:<port>`. It proxies bounded HTTP byte streams and WS byte streams with cancellation and no fallback. | A1 | `node --test tests/unit/runtimeHttpRelay.test.mjs` passes. `rg -n -e "listen\\(" -e "createServer\\(" Agent/server/RuntimeHttpRelay.mjs` returns no hits. |
| **A3. Confined relay manager** | Create `/Users/danielsava/work/file-parser/ploinky/cli/server/runtimeRelay/RuntimeRelayManager.js` and `/Users/danielsava/work/file-parser/ploinky/cli/server/runtimeRelay/confinement.js`. Resolve an exact immutable container id, verify dedicated container networking, and launch `podman exec -i`/`docker exec -i /Agent/server/RuntimeHttpRelay.mjs`. Seatbelt, bwrap, host networking, name-only/stale containers, and identity mismatch fail closed. Relay checkout is allowed only after policy admission and is lease-gated in B2. | A1, A2 | `node --test tests/unit/runtimeRelayManager.test.mjs tests/integration/runtimeRelayContainer.test.mjs` passes, including an explicit-start fixture with no AgentServer and a target bound to container loopback. A host-only listener and another container's listener remain unreachable. |
| **A4. Parser, deny set, and reserved route key** | Create `/Users/danielsava/work/file-parser/ploinky/cli/server/agentPortConvention/parseSelector.js` and `/Users/danielsava/work/file-parser/ploinky/cli/utils/runtime/reservedRouteKeys.js`; use the validator from `/Users/danielsava/work/file-parser/ploinky/cli/utils/agents.js`, `/Users/danielsava/work/file-parser/ploinky/cli/commands/noWaitWorker.js`, `/Users/danielsava/work/file-parser/ploinky/cli/commands/workspaceUtil.js`, `/Users/danielsava/work/file-parser/ploinky/cli/commands/cli.js`, and `/Users/danielsava/work/file-parser/ploinky/cli/utils/runtime/manifestStartup.js`. Enforce the exact grammar and canonical path rules. The deny set comes only from compiled runtime metadata; generic convention code contains no application/control-port literal. Port 7000 is an explicit accepted test case. Do not add the prefix to `HttpRouteAccessPath.ROUTER_OWNED_FIRST_SEGMENTS`, because the full conventional path must remain policy-matchable. | — | `node --test tests/unit/agentPortSelector.test.mjs tests/unit/reservedRouteKeys.test.mjs` passes at least 30 parser cases and proves that agent names/aliases equal to the prefix are rejected through every route writer. |
| **A5. Unified immutable route-plan shape** | Create `/Users/danielsava/work/file-parser/ploinky/cli/server/proxy/RoutePlan.js`, `/Users/danielsava/work/file-parser/ploinky/cli/server/agentPortConvention/resolveConvention.js`, and `/Users/danielsava/work/file-parser/ploinky/cli/server/proxy/limits.js`. The pre-admission plan contains all §9 fields, an immutable relay descriptor rather than a host port, the trusted deny set, exact authority/listener, effective owner instance, policy slot, unmatched suffix, limits, origin, generation digest, and audit id. It does not yet contain a rewritten target path. Phase-A tests use immutable fixtures; production dispatch stays unregistered until C. | A3, A4 | `node --test tests/unit/agentPortRoutePlan.test.mjs tests/unit/proxyLimits.test.mjs` passes identical owner/port/relay/policy selection for GET/HEAD/POST/SSE/WS and rejects invalid limits and authority ambiguity. |
| **A6. Convention-specific authenticated policy default** | Modify `/Users/danielsava/work/file-parser/ploinky/cli/server/policy/HttpRouteAccessPolicy.js` and `/Users/danielsava/work/file-parser/ploinky/cli/server/authHandlers/authContext.js` so evaluation accepts a trusted surface kind and selected owner route key. For the convention only, no explicit match yields `authenticated`; it never calls the generic guest fallback. Explicit entries are matched against the complete pre-rewrite path and the most restrictive result wins. | A5 | `node --test tests/unit/agentPortPolicy.test.mjs tests/unit/httpRouteAccessPolicy.test.mjs` proves the authenticated fallback rejects missing/guest identity, explicit public GET/HEAD succeeds while public write fails, guest identity is route-scoped and expires, authenticated access succeeds, most-restrictive composition wins, equal-rank access-metadata conflict prevents activation, and no relay process/socket/request byte exists before successful admission. |
| **A7. Rewrite after authorization** | Add the canonical rewrite to `/Users/danielsava/work/file-parser/ploinky/cli/server/agentPortConvention/resolveConvention.js`. Strip exactly prefix/agent/port after admission, preserve valid query, and produce `/` for the empty suffix. | A5, A6 | `node --test tests/unit/agentPortRewrite.test.mjs` passes root, nested, query, encoded-separator, dot-segment, and prefix-lookalike cases. |
| **A8. Convention request and response trust policy** | Create `/Users/danielsava/work/file-parser/ploinky/cli/server/proxy/sanitizeRequestHeaders.js` and `/Users/danielsava/work/file-parser/ploinky/cli/server/proxy/sanitizeResponseHeaders.js`. Strip forwarding, Router identity/assertion, hop-by-hop and `Connection`-named headers; parse `Cookie` and remove only Router session cookies; preserve application `Authorization`/cookies only when the compiled plan allows them. Regenerate trusted origin/identity. Enforce explicit `Location`, `Set-Cookie`, CORS, cache, and private-origin rules on responses. Do not broaden `routerHandlers.stripRouterIdentityHeaders` globally. | A5, A6 | `node --test tests/unit/agentPortHeaders.test.mjs tests/unit/agentPortResponsePolicy.test.mjs tests/unit/routerHandlers.test.mjs` proves spoof removal; separation of Router, machine, delegation, and application credentials; permitted app credentials survive; Router cookies never survive; private redirects never leak; and unrelated routes retain existing behavior. |
| **A9. HTTP/SSE/WS executors, diagnostics, and mutation protection** | Create `/Users/danielsava/work/file-parser/ploinky/cli/server/proxy/executeHttpPlan.js`, `/Users/danielsava/work/file-parser/ploinky/cli/server/proxy/executeWebSocketPlan.js`, and `/Users/danielsava/work/file-parser/ploinky/cli/server/proxy/recordProxyOutcome.js`; wire test-only, unregistered adapters in `/Users/danielsava/work/file-parser/ploinky/cli/server/RoutingServer.js`. Consume only A5 plans finalized by A6/A7 and A3 relay streams. Enforce exact Origin+CSRF on cookie-authenticated mutations and explicit WebSocket Origin before relay checkout. Apply D7 limits, body-bound buffering, allowed streaming, backpressure, initial WS `head`, cancellation, subprotocols, ping/pong/close, and bounded lifetimes. Emit one redacted generation-aware event with the §18 fields for success, denial, relay failure, target failure, timeout, and cancellation. | 0.1, A2, A3, A5, A6, A7, A8 | `node --test tests/unit/agentPortTransports.test.mjs tests/unit/agentPortMutationProtection.test.mjs tests/unit/proxyOutcomeAudit.test.mjs tests/unit/agentPortConventionE2e.test.mjs` passes GET, HEAD, bounded POST, streamed upload/download, SSE events/reconnect, WS text/binary/subprotocol/ping/pong/close, cancellation, limits, CSRF/Origin failures, application Authorization, redacted diagnostics, and no-dial-on-failure cases. No production dispatch recognizes the convention. |

### Phase B — Immutable generations, leases, private listener, and locator

| Task | Files and change | Dependencies | Verification |
| --- | --- | --- | --- |
| **B1. Content-addressed generation compiler** | Create `/Users/danielsava/work/file-parser/ploinky/cli/server/generation/compileGeneration.js`, `/Users/danielsava/work/file-parser/ploinky/cli/server/generation/activateGeneration.js`, and `/Users/danielsava/work/file-parser/ploinky/cli/server/generation/GenerationStore.js`. Capture exact bytes, validate complete agent/container identities, relay descriptors, trusted deny sets, host/listener surfaces, policies, limits, origins, and private caller ACLs, then atomically activate. Request code never reads staging files. Candidate state containing a host TCP target, TCP `openPorts`, `additionalServerPort`, ambiguous authority, or incomplete policy is inactive. | — | `node --test tests/unit/generationCompile.test.mjs tests/unit/generationActivation.test.mjs` passes same-size/same-mtime mutations, corrupt/missing state, conflicting policies, forbidden host targets, inactive startup, and atomic replacement. |
| **B2. Authorization-to-dial leases** | Create `/Users/danielsava/work/file-parser/ploinky/cli/server/generation/lease.js`; integrate it with A3 relay checkout and A9 executors. Commit immediately before relay process use, pooled stream reuse, or first upstream byte. Invalidation cancels uncommitted work. | B1, A3, A9 | `node --test tests/unit/generationLease.test.mjs` pauses fresh HTTP, pooled HTTP, SSE, and WS immediately before target use; generation replacement yields bounded `503` and zero relay/target activity. |
| **B3. Private listener and dedicated machine assertion** | Create `/Users/danielsava/work/file-parser/ploinky/cli/server/privateListener.js`, `/Users/danielsava/work/file-parser/ploinky/cli/server/privateListenerBindings/containerLoopbackBinding.js`, `/Users/danielsava/work/file-parser/ploinky/cli/server/security/tokens/MachineCallAssertionService.js`, and `/Users/danielsava/work/file-parser/ploinky/Agent/lib/machineCallAssertion.mjs`. Do not reuse `agentAssertion.mjs`. Bind exactly to `127.0.0.1:8081`; the binding adapter launches a container-side proof through the runtime-owned host alias and disables the listener surface if that proof fails. Assertions bind caller principal+enable generation, Router audience, target, method/path/body hash, active generation, iat/expiry/nonce; exact policy and ACL both gate A9 execution. | B1, B2, A6, A8, A9 | `node --test tests/unit/privateMachineCall.test.mjs tests/unit/privateListenerBinding.test.mjs tests/integration/privateListenerExposure.test.mjs` rejects missing/wildcard/wrong/stale/replayed/spoofed assertions, strips the assertion before proxying, preserves independently permitted app credentials, proves a trusted-runtime request succeeds, and proves a non-loopback client cannot connect to 8081. |
| **B4. Bind convention and primary routes to generations** | Modify `/Users/danielsava/work/file-parser/ploinky/cli/server/RoutingServer.js`, `/Users/danielsava/work/file-parser/ploinky/cli/server/httpServiceRoutes.js`, and `/Users/danielsava/work/file-parser/ploinky/cli/server/authHandlers/authContext.js` so all public/private route resolution uses only the captured generation. Bind A5 plans to B1 relay descriptors and B2 leases. | B1, B2, A5, A6, A9 | `node --test tests/unit/generationBackedRouting.test.mjs tests/unit/agentPortRoutePlan.test.mjs` passes and an `rg`-based assertion proves request handlers do not call `loadRoutingConfig`/`readRouting`. |
| **B5. Generation-bound browser locator** | Create `/Users/danielsava/work/file-parser/ploinky/cli/server/agentPortConvention/locator.js` and one Router-owned endpoint in `/Users/danielsava/work/file-parser/ploinky/cli/server/RoutingServer.js`. Require a real authenticated user, re-evaluate GET policy, derive the single locator from the active generation, and return `no-store`; never return inventory or relay topology. | B1, B4, A6 | `node --test tests/unit/agentPortLocator.test.mjs` passes authenticated one-locator success; guest/machine/app-token denial; atomic generation swap; inactive, reconciling, stale, failed, missing, and malformed `503`; no-store; no cached or retired locator; and no inventory, relay/private address, ephemeral host port, private-listener, secret, connector, or ACL disclosure. |

### Phase C — Atomic hard cut and legacy deletion

There is no inventory-and-migrate task. Repository-wide searches below are deletion-completeness checks only.

| Task | Files and change | Dependencies | Verification |
| --- | --- | --- | --- |
| **C1. Remove manifest-driven host publication** | Delete `parseManifestPorts` and its exports/consumers in `/Users/danielsava/work/file-parser/ploinky/cli/sandbox/docker/common.js`, `/Users/danielsava/work/file-parser/ploinky/cli/sandbox/docker/agentServiceManager.js`, `/Users/danielsava/work/file-parser/ploinky/cli/sandbox/bwrap/bwrapServiceManager.js`, `/Users/danielsava/work/file-parser/ploinky/cli/sandbox/seatbelt/seatbeltServiceManager.js`, and `/Users/danielsava/work/file-parser/ploinky/cli/utils/agents.js`. Remove profile `openPorts` merge/schema behavior. Agent launchers emit no TCP `-p` mapping. Media UDP remains outside this manifest/profile path. | A9, B4 | `node --test tests/unit/agentLaunchNoPublishedTcp.test.mjs tests/unit/profileSystem.test.mjs` passes. Container integration asserts `podman port <fixture>`/`docker port <fixture>` has no TCP entries. `rg -n -e "openPorts" -e "parseManifestPorts" cli/ Agent/` returns zero runtime hits. |
| **C2. Delete `additionalServerPort` and profile-server behavior outright** | Delete `/Users/danielsava/work/file-parser/ploinky/cli/utils/runtime/profileServer.js` and `/Users/danielsava/work/file-parser/ploinky/cli/server/profileServerProxy.js`; remove all resolution, publication, persistence, `<agent>.localhost`, HTTP, and WS branches from the sandbox managers, `/Users/danielsava/work/file-parser/ploinky/cli/server/RoutingServer.js`, `/Users/danielsava/work/file-parser/ploinky/cli/utils/agents.js`, `/Users/danielsava/work/file-parser/ploinky/cli/commands/noWaitWorker.js`, `/Users/danielsava/work/file-parser/ploinky/cli/commands/workspaceUtil.js`, `/Users/danielsava/work/file-parser/ploinky/cli/commands/cli.js`, and `/Users/danielsava/work/file-parser/ploinky/cli/server/containerMonitor.js`. Delete `/Users/danielsava/work/file-parser/ploinky/tests/unit/profileServer.test.mjs` and only the obsolete cases from `/Users/danielsava/work/file-parser/ploinky/tests/unit/profileSystem.test.mjs`. No legacy value is read or translated. | A9, B4 | `rg -n -e "additionalServerPort" -e "profileServerProxy" -e "profileServerHostAgentName" cli/ Agent/ tests/` returns zero hits. `node --test tests/unit/profileSystem.test.mjs tests/unit/containerMonitorMaintenance.test.mjs` passes. |
| **C3. Remove direct `hostPort` routing and unify primary traffic** | Replace browser and Router-to-agent `route.hostPort` consumers with B4 generation route plans and A3 relay streams in `/Users/danielsava/work/file-parser/ploinky/cli/server/RoutingServer.js`, `/Users/danielsava/work/file-parser/ploinky/cli/server/routerHandlers.js`, `/Users/danielsava/work/file-parser/ploinky/cli/server/wsServiceProxy.js`, `/Users/danielsava/work/file-parser/ploinky/cli/server/mcp-proxy/index.js`, `/Users/danielsava/work/file-parser/ploinky/cli/server/agentOpenAiDelegation.js`, `/Users/danielsava/work/file-parser/ploinky/cli/server/openAiAgentDiscovery.js`, `/Users/danielsava/work/file-parser/ploinky/cli/server/policy/HttpShareAuthorizer.js`, `/Users/danielsava/work/file-parser/ploinky/cli/server/utils/agentReadiness.js`, and relevant WebChat handlers. Remove host-port persistence/status in CLI writers and monitor code. The launcher emits a trusted primary-service descriptor only for runtime-owned primary services; explicit custom agents without one remain convention-only. | C1, C2, B4 | `node --test tests/unit/primaryRouteViaRelay.test.mjs tests/unit/mcpProxyRelay.test.mjs tests/unit/agentReadinessRelay.test.mjs` passes. `rg -n "\\bhostPort\\b" cli/server/ cli/commands/ cli/utils/` returns zero runtime hits. |
| **C4. Register the greenfield resolver in the hard-cut release** | Modify `/Users/danielsava/work/file-parser/ploinky/cli/server/RoutingServer.js` and `/Users/danielsava/work/file-parser/ploinky/cli/server/generation/activateGeneration.js`. Register the generation-backed primary/conventional resolver only after C1-C3 invariants validate. There is no old/new mode flag, dormant production flag, compatibility branch, or fallback. | C1, C2, C3 | `node --test tests/unit/hardCutActivation.test.mjs tests/unit/agentPortConventionE2e.test.mjs` proves invalid legacy state installs no route, valid greenfield state activates once, and no request takes a legacy branch. |
| **C5. Documentation hard cut** | Update `/Users/danielsava/work/file-parser/ploinky/docs/ploinky-overview.md`, `/Users/danielsava/work/file-parser/ploinky/docs/code-derived-agent-lifecycle.md`, `/Users/danielsava/work/file-parser/ploinky/docs/runtime.html`, `/Users/danielsava/work/file-parser/ploinky/docs/http-route-access-security-model.md`, `/Users/danielsava/work/file-parser/ploinky/docs/interfaces.html`, and `/Users/danielsava/work/file-parser/ploinky/docs/operations.html`. Document exec/stdio relays, authenticated convention defaults, exact socket boundary, private listener binding, and removal—not migration—of legacy fields. | C4 | `rg -n -e "additionalServerPort" -e "profileServerProxy" -e "<agent>\\.localhost" -e "openPorts" docs/ --glob '!docs/superpowers/**'` returns zero stale-behavior hits. `./fileSizesCheck.sh` completes without a new failure. |

### Phase V — Blocking release verification

| Task | Files and change | Dependencies | Verification |
| --- | --- | --- | --- |
| **V1. Full automated regression** | Add an `e2e:routing-proxy` script to `/Users/danielsava/work/file-parser/ploinky/package.json` that invokes the new container and browser harness without mutating production state. | C5 | `npm test` passes, then `npm run e2e:routing-proxy` passes. |
| **V2. Capacity, socket-boundary, and confinement harness** | Create `/Users/danielsava/work/file-parser/ploinky/tests/e2e/routingProxy/networkBoundary.test.mjs`, `/Users/danielsava/work/file-parser/ploinky/tests/e2e/routingProxy/capacityAndFailure.test.mjs`, and fixtures under `/Users/danielsava/work/file-parser/ploinky/tests/fixtures/routing-proxy/`. Start an explicit-command multi-port agent with no AgentServer. Probe host/non-loopback/container namespaces, inspect runtime publishes, and combine slow uploads/downloads, SSE, and WebSockets under failure and drain. | V1 | The harness observes exactly one externally reachable Ploinky TCP socket (RoutingServer), no relay/agent TCP publish, private 8081 unreachable externally, selected loopback port reachable only through the authenticated relay, and—when the media fixture is enabled—exactly one external media UDP socket. It also proves bounded backpressure/concurrency/time/size behavior, cancellation, graceful drain, fresh authorized reconnect, isolated unhealthy targets, and topology-free errors. |
| **V3. Real-browser base-path conformance** | Create `/Users/danielsava/work/file-parser/ploinky/tests/e2e/routingProxy/browserBasePath.test.mjs` using Playwright. Enumerate every mounted browser application in the fixture generation and exercise its HTML, relative/absolute assets, APIs, redirects, application cookies, CORS, SSE, and WebSocket URLs under the conventional prefix; an untested mounted application fails the gate. | V1, V2 | `npm run e2e:routing-proxy -- --browser` passes for every mounted application with no request to a private address, relay, host port, or route outside the selected prefix. |
| **V4. LiveKit signaling and media gate** | Create `/Users/danielsava/work/file-parser/ploinky/tests/e2e/routingProxy/livekitRouting.test.mjs` plus deployment fixture configuration under `/Users/danielsava/work/file-parser/ploinky/tests/fixtures/routing-proxy/livekit/`. Product identifiers and ports remain confined to fixtures/tests, never generic core. | V2, V3 | `npm run e2e:routing-proxy -- --livekit` proves UI and signaling HTTP/WS use RoutingServer convention URLs, the browser never receives/dials a private signaling address, a real screen-share publication produces a remote track and media-counter increase only on the direct UDP plane, and private control calls require the 8081 assertion+ACL. |

---

## 4. Test Plan Mapped to the Requirements §19 Matrix

| Requirements section | Concrete owners and files | Blocking command/evidence |
| --- | --- | --- |
| **§19.1 Convention and generation compilation** | A4 `agentPortSelector.test.mjs` + `reservedRouteKeys.test.mjs`; B1 `generationCompile.test.mjs` + `generationActivation.test.mjs`. | The named `node --test` commands in A4/B1 pass canonical, malformed, stale, corrupt, collision, exact-byte, deny-set, and port-boundary cases. |
| **§19.2 Unified transports** | A5 `agentPortRoutePlan.test.mjs`; A9 `agentPortTransports.test.mjs` + `agentPortConventionE2e.test.mjs`; V4 real signaling. | HTTP GET/HEAD/POST, streamed upload, SSE, WS, and real signaling select the same owner, port, relay, policy, rewrite, headers, limits, generation, and audit identity. |
| **§19.3 Host, path, and surface isolation** | A4 parser/registration tests; A5 route-plan tests; B4 `generationBackedRouting.test.mjs`; V2 `networkBoundary.test.mjs`. | Unknown/stale/conflicting authorities, prefix lookalikes, encoded separators, invalid aliases, cross-agent ports, and private/public listener mismatch cause zero relay/target activity. |
| **§19.4 Policy and credential isolation** | A6 `agentPortPolicy.test.mjs`; A8 request/response tests; A9 mutation-protection tests. | Authenticated default, most-restrictive matching, Router-cookie/header removal, permitted app credentials, Origin/CSRF, redirects, CORS, caching, and no-dial-on-denial all pass. |
| **§19.5 Generation races** | B2 `generationLease.test.mjs`. | Fresh HTTP, pooled HTTP, SSE, and WS paused before target use all fail with `503` and zero upstream bytes after generation replacement. |
| **§19.6 Private calls** | B3 unit and integration tests. | Exact caller+generation+ACL succeeds; every missing, wildcard, wrong, disabled, stale, expired, replayed, or spoofed assertion fails before relay checkout. |
| **§19.7 Application conformance** | V3 `browserBasePath.test.mjs`. | Real-browser HTML/assets/APIs/redirects/cookies/CORS/SSE/WS remain under the selected conventional prefix and reveal no private origin. |
| **§19.8 Capacity, failure, and network boundary** | A3 container confinement; A9 limits/cancellation; V2 socket scan. | Backpressure, cancellations, concurrency/time/size limits, relay crash, refused port, and combined load remain bounded; exactly one public Ploinky TCP and, when enabled, one media UDP socket are observed. |
| **LiveKit media gate** | V4 `livekitRouting.test.mjs`. | UI and signaling HTTP/WS traverse RoutingServer, media bypasses it over UDP, and private control requires the private listener's assertion+ACL. |

---

## 5. Acceptance Mapping

| ID | Owning tasks | Release evidence |
| --- | --- | --- |
| P01–P04 | A2-A9, B1-B4, C1-C4, V2 | One pipeline and one external TCP; relay/targets/private listener are not externally reachable. |
| P05–P06 | A4, C1-C2 | No manifest endpoint/additional-server/open-port declaration; selector accepts only canonical agent+port+suffix. |
| P07 | A5, B1, B4 | Listener/authority classified from the captured generation before path dispatch. |
| P08 | A6, A9, B2 | Policy/auth complete before relay checkout, lease commit, or target byte. |
| P09–P10 | B1-B2, C4 | Convention cannot activate without immutable generations and authorization-to-dial leases. |
| P11–P12 | B3, A8 | Exact machine assertion+ACL; credentials and provenance are never interchangeable. |
| P13 | A2-A3, A9 | Bounded no-fallback relay/target failure with redacted diagnostics. |
| P14 | V3 | Real-browser application base-path gate is implemented and blocking. |
| P15 | V4 | LiveKit signaling and media gate is implemented and blocking. |
| P16 | C1-C3 | `additionalServerPort`, profile proxy, TCP `openPorts`, direct `hostPort`, and transport-specific selection are absent. |
| P17 | A4-A9, V4 | Generic code has no product/agent/application-port constants; examples exist only in tests. Review command: `rg -n -e "livekit" -e "collaboration" -e "3000" -e "7000" -e "7880" cli/server/agentPortConvention cli/server/proxy cli/server/runtimeRelay Agent/server/RuntimeHttpRelay.mjs` returns zero hits. |
| P18 | V1-V4 | Full unit, integration, boundary, browser, and LiveKit matrices pass before release. |
| P19 | B5 | One authenticated no-store generation-bound locator with no topology disclosure. |

---

## 6. Dependency Audit

```text
0.1 ──────────────────────────────────────────────────────────────► A9

A1 ─► A2 ─► A3 ───────────────┐
       A4 ─► A5 ─► A6 ─► A7 ──┼─► A9
              ├──────► A8 ─────┘

B1 ─────────► B2 ─► B4 ─► B5
A3 + A9 ────► B2
B2 ────────────────► B3
A6 + A8 + A9 ─────► B3

(A9 + B4) ─► C1/C2 ─► C3 ─► C4 ─► C5 ─► V1 ─► V2 ─► V3 ─► V4
```

The task tables are authoritative and match this graph: A5 requires confinement and parser state; A9 requires the actual relay plus request/response trust; production activation requires B1/B2 and the Phase-C deletions.

---

## 7. Risks and Fail-Closed Handling

| Risk | Handling |
| --- | --- |
| Authenticated users can infer listening ports from status/timing. | Accepted by D3; every attempt is audited with agent, canonical port, policy result, latency bucket, and redacted outcome. |
| Container runtime exec/stdio framing is corrupted or the relay exits. | Bounded `502/503`; cancel the request, discard the relay channel, never retry another relay/port/generation. |
| Container identity changes under the same name. | Generation stores immutable runtime/container identity; `HELLO` and lease commit reject name reuse. |
| Streaming mode cannot bind a complete body hash before dial. | Only routes whose compiled plan explicitly permits `stream-v1` may stream; both ends enforce the same aggregate limit. All other bodied routes buffer exact bytes before commit. |
| Private 8081 cannot be reached from a backend without a wildcard host bind. | The backend leaves the private listener unavailable and its callers inactive. It never widens the bind. |
| Existing manifests or persisted files contain removed fields. | Candidate generation is invalid and installs no selectors. No reader translates, ignores into active state, or migrates those fields. |
| Browser/application escapes its base path. | V3 fails release; the proxy does not rewrite arbitrary application content to conceal non-conformance. |

---

## 8. Done

Done means 0, A, B, C, and V are all complete. A browser reaches every Ploinky HTTP-family application surface through RoutingServer; the selected agent-local port is reached through a current-generation authenticated exec/stdio relay in that agent's container network namespace; primary traffic uses the same plan and transport; no agent TCP port or relay is host-published; the private listener is proven non-public; legacy schemas and proxies are absent without migration code; and the full unit, race, boundary, browser, and LiveKit gates pass.
