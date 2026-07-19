# Ploinky Box Edge Routing and Publication — Adversarial Architecture Review

**Review date:** 2026-07-15  
**Design reviewed:** `ploinky/docs/superpowers/specs/2026-07-15-ploinky-box-edge-routing-and-publication-design.md`  
**Review mode:** Read-only architecture and code review  
**Verdict:** **PASS WITH REQUIRED CHANGES**

The two-mapping target is technically viable:

~~~text
127.0.0.1:<routerHostPort> -> box:8080/tcp
0.0.0.0:7882/udp           -> box:7882/udp
~~~

No transitive Explorer agent inherently requires a third physical-host port. Cloudflare can remain outbound-only, all agent HTTP/SSE/WebSocket listeners can be private RoutingServer targets, and LiveKit can use the single fixed UDP mux.

The design is not safe or complete as written, however. There are no P0 findings, but several P1 and P2 issues must be resolved before implementation.

## 1. Findings

### P0

None.

### P1-1 — Public service hostnames have an unresolved router-control-plane ambiguity

**Failure scenario.** If a configured public hostname sends every path to its selected service, authenticated services lose RoutingServer-owned login/callback/logout endpoints. If existing router-owned dispatch keeps precedence, that hostname also exposes `/health`, administration, marketplace, policy/discovery, and any future TURN broker route independently of the selected service.

**Code evidence.**

- `ploinky/cli/server/RoutingServer.js:402-426` handles health before service resolution.
- `ploinky/cli/server/RoutingServer.js:459-490` handles authentication and administrative routes.
- `ploinky/cli/server/RoutingServer.js:554-594` resolves agent services only afterward.
- `ploinky/cli/server/authHandlers/authContext.js:263-284` supplies router-owned authentication paths.
- `ploinky/docs/superpowers/specs/2026-07-15-ploinky-box-edge-routing-and-publication-design.md:737-761` describes service-host dispatch.

**Affected design section.** Public hostname selection, RoutingServer host dispatch, TURN credential broker.

**Requirement violation.** A hostname must select an existing service, not create access to unrelated router functionality.

**Smallest correction.** Define an explicit per-public-host router-owned allowlist. Permit only the login/callback/logout endpoints required by the selected service’s access mode. Deny health, admin, marketplace, discovery, publication management, and TURN credentials before service dispatch. Prefer a separate private listener or Unix socket for the backend credential broker.

### P1-2 — The current route representation cannot implement `httpServices[].port`

**Failure scenario.** A service selecting OnlyOffice port 8080, GPTResearcher port 8000, or Umami port 3000 is still dialed through the owning agent’s primary 7000 mapping. HTTP and WebSocket routing may also select or authorize the route independently.

**Code evidence.**

- `ploinky/cli/server/httpServiceRoutes.js:240-271` computes a service slug but does not retain a target port in the returned route.
- `ploinky/cli/server/routerHandlers.js:425-502` re-resolves the definition and dials the primary `hostPort`.
- `ploinky/cli/server/wsServiceProxy.js:40-86` and `:103-164` perform separate WebSocket resolution, policy, and dial operations.
- `ploinky/cli/server/profileServerProxy.js:56-168` implements `additionalServerPort` through a separate proxy path.

**Affected design section.** Slim manifest addition, deletion of `additionalServerPort`, unified HTTP/SSE/WebSocket policy.

**Requirement violation.** A named service must determine one exact private target and one policy result for every transport.

**Smallest correction.** Compile one immutable route plan containing hostname selector, route key, service slug, canonical path, rewrite, policy decision, and resolved private target. For bridge networking, create an engine-assigned loopback mapping for the selected container port; for host-mode LiveKit, resolve it to box loopback. Use the same plan for HTTP, SSE, and WebSocket.

The proposed schema addition itself is sufficient; no generic server inventory is needed.

### P1-3 — LiveKit’s current 7880 binding creates a RoutingServer bypass and the target omits its private Twirp plane

**Failure scenario.** LiveKit binds signaling/API port 7880 on all interfaces in the box network namespace. Bridged agents can reach that socket through the box gateway without RoutingServer policy. If it is changed to loopback-only without adding a private service, WebMeet’s `POST /twirp/livekit.RoomService/...` calls stop working because the proposed public signaling service rejects public writes.

**Code evidence.**

- `ploinky/cli/services/docker/agentServiceManager.js:506-515` implements inner host mode as `--network host`.
- `container-image-builds/README.md:145-149` documents bridge access to box services through the gateway.
- `AssistOSExplorer/webmeetAgent/lib/runtime/livekitRuntime.mjs:68-96` issues LiveKit Twirp POST calls.
- `ploinky/cli/server/policy/HttpRouteAccessPolicy.js:46-55` denies public write methods.
- `ploinky/docs/superpowers/specs/2026-07-15-ploinky-box-edge-routing-and-publication-design.md:483-542` defines the target LiveKit service and configuration.

**Affected design section.** LiveKit signaling, all-L7-through-RoutingServer requirement.

**Requirement violation.** Every HTTP-compatible plane, including private inter-agent APIs, must pass through RoutingServer.

**Smallest correction.** Bind LiveKit’s HTTP server to `127.0.0.1:7880`. Define two ordinary named services pointing at port 7880:

1. Public, read-only browser signaling.
2. Agent-authenticated private LiveKit API/Twirp access.

The private route should require a signed agent assertion and an exact caller allowlist through normal policy composition. This requires no new manifest section.

### P1-4 — The proposed policy snapshot does not meet its own no-stale-authorization guarantee

**Failure scenario.** An out-of-band edit corrupts or revokes a policy input immediately after the last bounded rehash. Until the next scan, a request can obtain a lease from the old compiled snapshot and dial upstream. The authorization-to-dial lease closes races only after a changed input is known; it cannot detect an unseen change.

Current code is weaker still: malformed JSON or manifest policy can be skipped while remaining inputs continue to authorize.

**Code evidence.**

- `ploinky/cli/server/policy/HttpRouteProviders.js:10-16` turns provider JSON failures into absent input.
- `ploinky/cli/server/policy/HttpRouteProviders.js:78-95` skips malformed manifest providers.
- `ploinky/cli/server/policy/HttpRouteProviders.js:98-142` caches using `mtime:size`.
- `ploinky/cli/server/policy/HttpRouteAccessPolicy.js:97-133` continues policy composition with available inputs.
- `ploinky/docs/superpowers/specs/2026-07-15-ploinky-box-edge-routing-and-publication-design.md:829-844` permits bounded detection latency.
- `ploinky/docs/superpowers/specs/2026-07-15-ploinky-box-edge-routing-and-publication-design.md:846-858` then claims stale input never authorizes.

**Affected design section.** Content-addressed policy snapshot, durable epoch, bounded rehash, authorization-to-dial lease.

**Requirement violation.** Missing, corrupt, stale, or unreadable public-host policy must fail closed.

**Smallest correction.** Make a core-owned transactional policy store authoritative:

1. Stage and fully validate candidate inputs.
2. Compile a complete route/policy generation.
3. Atomically swap the active generation.
4. Acquire a generation read lease during route selection.
5. Revalidate or commit that lease immediately before writing the request to an upstream connection or issuing the WebSocket dial.

A content digest remains useful for audit and tamper reporting. A durable epoch is needed only for coordinated multi-process writes and restart recovery. A bounded full rehash is not sufficient for immediate out-of-band revocation; either raw files must be non-authoritative staging inputs, or they must be synchronously hashed before each new dial.

### P1-5 — Host networking is currently an unrestricted manifest capability

**Failure scenario.** Any enabled agent can select `network.mode: host`, bind box ports 8080 or 7882 before RoutingServer/LiveKit, access loopback-only Redis, storage, or the TURN broker, or impersonate a trusted loopback client.

**Code evidence.**

- `ploinky/cli/services/networkContract.js:3-45` accepts unrestricted host mode.
- `ploinky/cli/services/docker/agentServiceManager.js:506-515` directly emits host networking.
- `ploinky/docs/superpowers/specs/2026-07-15-ploinky-box-edge-routing-and-publication-design.md:269-275` grants LiveKit host mode.

**Affected design section.** Fixed UDP handoff and reserved box-side ports.

**Requirement violation.** LiveKit must be the only process receiving the raw UDP capability, and inner agents must not capture reserved sockets.

**Smallest correction.** Enforce a box-security allowlist for the exact enabled LiveKit instance and enable-generation. Reject host mode for every other managed agent regardless of manifest content. Verify socket ownership/readiness for 8080 and 7882 and fail closed on conflicts.

Host mode should otherwise remain unchanged: it avoids a second nested UDP NAT/userland-forwarding layer and is the recommended Docker shape for LiveKit media. A fixed inner bridge publication would provide more namespace isolation but adds another latency-sensitive UDP translation and is not materially superior once the host-mode capability is narrowly constrained.

Primary documentation: [LiveKit deployment guide](https://docs.livekit.io/transport/self-hosting/deployment/).

### P1-6 — Current agent identity cannot enforce the proposed exact TURN-consumer boundary

**Failure scenario.** A stale assertion from a disabled instance, or one issued before an alias was rebound or an agent re-enabled, remains valid because the current identity is repository/agent based and its secret is stable. Replay prevention is optional. The broker therefore cannot prove “this exact currently enabled backend instance.”

**Code evidence.**

- `ploinky/cli/services/agentIdentity.js:12-20` defines identity principally by repository and agent name.
- `ploinky/cli/services/workspaceDependencyGraph.js:203-253` handles aliases and effective instances separately.
- `ploinky/cli/services/masterKey.js:222-246` derives stable secrets from the long-lived master key.
- `ploinky/cli/server/security/tokens/AgentAssertionService.js:74-118` does not check the current enabled generation.
- `Agent/lib/agentAssertion.mjs:27-57` makes replay checking optional.

**Affected design section.** TURN credential broker and topology credential endpoint.

**Requirement violation.** Credentials must be issued only to exact configured, currently enabled backend identities.

**Smallest correction.** Add an effective instance ID and enable-generation to the launched identity, derive or rotate a per-generation assertion secret, validate the caller against the live registry, require a fixed broker audience/target/path/body digest, make replay rejection mandatory, and apply TTL, rate, audit, and rotation controls. Keep the consumer ACL in box configuration, not manifests.

### P1-7 — LiveKit will advertise an unusable private candidate

**Failure scenario.** Physical UDP 7882 reaches LiveKit, but clients are told to send media to the box/container-local IP because `use_external_ip` is false and `node_ip` is absent. Signaling succeeds while ICE fails outside the host network.

**Code evidence.**

- `ploinky/docs/superpowers/specs/2026-07-15-ploinky-box-edge-routing-and-publication-design.md:523-542` sets `use_external_ip: false` without `node_ip`.
- `webmeetInfra/liveKitServerAgent/scripts/hooks/preinstall.sh:206-220` currently writes `node_ip`.
- `container-image-builds/images/livekit-server-agent/Dockerfile:8-11` pins LiveKit 1.11.0.

**Affected design section.** LiveKit candidate advertisement and runtime topology.

**Requirement violation.** The fixed public IPv4 must be advertised to clients.

**Smallest correction.** Require a validated literal `media.publicIPv4`, write it as `rtc.node_ip`, retain `use_external_ip: false`, and fail publication if absent. Explicitly constrain or test IPv4-only candidate generation so IPv6 candidates do not advertise an unreachable path.

Primary source references:

- [LiveKit v1.11 configuration](https://github.com/livekit/livekit/blob/v1.11.0/pkg/config/config.go#L451-L479)
- [WebRTC address selection](https://github.com/livekit/mediatransportutil/blob/0fcb3771c3d5/pkg/rtcconfig/webrtc_config.go#L88-L191)

### P1-8 — Ten-minute TURN credentials are issued only once

**Failure scenario.** A meeting lasts longer than ten minutes and then experiences a network switch, ICE restart, or reconnect. The client retries using the original expired TURN username/password and cannot allocate a relay.

**Code evidence.**

- `ploinky/docs/superpowers/specs/2026-07-15-ploinky-box-edge-routing-and-publication-design.md:994-1004` proposes a 600-second cap.
- `AssistOSExplorer/webmeetAgent/lib/store/rtcConfig.mjs:48-97` builds RTC configuration once.
- `AssistOSExplorer/webmeetAgent/lib/services/roomParticipants.mjs:553-618` includes it once in the join response.
- `AssistOSExplorer/webmeetAgent/IDE-plugins/webmeet-room-livekit.js:125-172` passes it once to the browser SDK.

**Affected design section.** External TURN credentials and WebMeet integration.

**Requirement violation.** External TURN is not a reliable fallback over supported session lifetimes.

**Smallest correction.** Add an application-controlled refresh/rejoin flow that obtains fresh credentials before expiry and after a network transition. Until that exists, the credential lifetime must cover the supported maximum session plus reconnect window.

External TURN remains the correct architectural choice. Coturn requires its own listener and relay range, so it belongs on separate infrastructure, not behind the Ploinky box’s single UDP mapping.

Primary source references:

- [LiveKit client SDK 2.18.3 reconnect path](https://github.com/livekit/client-sdk-js/blob/v2.18.3/src/room/RTCEngine.ts#L743-L787)
- [Coturn server documentation](https://github.com/coturn/coturn/blob/master/README.turnserver)

### P1-9 — Topology activation and restart semantics can leave stale consumers and destroy active sessions

**Failure scenario.** Agents start against a reconciling snapshot without active URLs. Readiness then activates URLs without changing the configuration digest, but agents that read configuration once never observe the change. Conversely, restarting every enabled agent for each consumer-visible revision terminates active OnlyOffice editing sessions and loses in-memory callback/session state.

**Code evidence.**

- `ploinky/docs/superpowers/specs/2026-07-15-ploinky-box-edge-routing-and-publication-design.md:1116-1130` separates revision content from readiness.
- `ploinky/docs/superpowers/specs/2026-07-15-ploinky-box-edge-routing-and-publication-design.md:1134-1145` requires start, activation, and restart-all sequencing.
- `AssistOSExplorer/onlyOffice/src/index.mjs:235-248` reads configuration during startup.
- `AssistOSExplorer/onlyOffice/src/session-store.mjs:129-210` keeps sessions in an in-memory map.
- `AssistOSExplorer/onlyOffice/src/index.mjs:303-324` closes services without a document-drain protocol.

**Affected design section.** Runtime topology lifecycle and restart ordering.

**Requirement violation.** Consumers must see atomic active state without stale URLs or unnecessary destructive restarts.

**Smallest correction.** Separate immutable configuration generation from mutable publication/readiness generation. Atomically replace the snapshot and require consumers to read it when creating each browser session/request, or provide one generic watch/helper API. Readiness activation should not restart agents. Configuration changes that genuinely require restart need dependency-aware draining and explicit OnlyOffice save/close acknowledgement.

### P1-10 — GPTResearcher and Umami are not currently valid subpath-mounted services

**Failure scenario.** The page loads at `/services/gpt-researcher/` or `/services/umami/`, but absolute asset, API, redirect, or WebSocket URLs escape the prefix and hit another router route or return 404. Umami’s proposed port 3001 also does not currently exist.

**Code evidence.**

- `AchillesCLI/GPTResearcher/scripts/install-gpt-researcher.sh:7-16` clones and installs GPTResearcher without a pinned commit.
- `AchillesCLI/GPTResearcher/scripts/start-gpt-researcher.sh:23-28` launches it at its root without a base-path option.
- `container-image-builds/images/umami-agent/Dockerfile:1-25` uses a floating source/image pipeline.
- `UmamiAgent/umamiAgent/scripts/start-umami-agent.sh:102-106` starts the dashboard with `PORT` but no `BASE_PATH`.

**Affected design section.** GPTResearcher and Umami HTTP service selectors.

**Requirement violation.** A route prefix and rewrite alone do not make a root-oriented application safe under a subpath.

**Smallest correction.** Pin commits/images. Configure Umami with the exact `BASE_PATH`, preserving the prefix upstream. Patch or configure every GPTResearcher HTTP, static, API, redirect, and WebSocket URL for its prefix. Implement and test the proposed 3001 telemetry proxy rather than declaring a nonexistent target.

Primary documentation: [Umami environment variables](https://docs.umami.is/docs/environment-variables).

### P1-11 — The `basic/web-publishing` hard cut is under-scoped

**Failure scenario.** Core code stops launching the agent, but Explorer deployment still requires its variables, provider, image, probes, or fallback URL. A clean installation fails or silently reconstructs the deleted architecture.

**Code evidence.**

- `AssistOSExplorer/explorer/manifest.json:70-83` enables and selects web-publishing as a configuration provider.
- `AssistOSExplorer/.github/workflows/deploy-skills-explorer.yml:84-129` and `:669-764` contain web-publishing-specific deployment configuration and probes.
- `AssistOSExplorer/onlyOffice/scripts/hooks/preinstall.sh:26-94` contains web-publishing fallback/migration logic.
- `container-image-builds/.github/workflows/publish-web-publishing-agent-image.yml:1-39` still publishes its image.
- `ploinky/cli/services/docker/common.js:150-152` retains fallback knowledge.

**Affected design section.** Removal of `basic/web-publishing`.

**Requirement violation.** This is not yet a clean hard cut.

**Smallest correction.** Make deletion repository-wide and add CI rejecting `basic/web-publishing`, `WEB_PUBLISHING_*`, fallback/generated-public-URL readers, its image workflow, and tests expecting that provider. Do not add migration or compatibility behavior.

### P2-1 — The static publication boundary needs a new runtime contract and a larger deletion set

**Failure scenario.** A cached contract-v4 box remains accepted and can still consume graph-derived publications, or one of the secondary coverage/preflight paths rejects an otherwise valid static box after the planner is removed.

**Code evidence.**

- `ploinky/container/runtime-contract.mjs:8-12` requires contract version 4.
- `ploinky/container/runtime-contract.mjs:21-29` and `:563-707` model arbitrary publication labels and mappings.
- `container-image-builds/images/ploinky-box/Dockerfile:46-57` declares contract version 4.
- `ploinky/bin/ploinky:18-30` wires outer publication options into the CLI.
- `ploinky/container/runtime-supervisor.mjs:1097-1349` runs the planner and records provenance.
- `ploinky/cli/services/workspaceUtil.js:1424-1522` performs workspace publication preflights.
- `ploinky/cli/services/docker/agentServiceManager.js:1427-1480` checks coverage while launching agents.
- `ploinky/cli/server/authHandlers/marketplaceRoutes.js:331-337` and `ploinky/cli/server/containerMonitor.js:543-555` retain coverage-related checks.
- `ploinky/cli/services/boxStartPublishPlan.js:641-737` serializes `openPorts`, network mode, and implicit AgentServer claims.

**Affected design section.** Outer wrapper static publication contract.

**Requirement violation.** An old graph-aware contract could survive the hard cut.

**Smallest correction.** Introduce the next runtime contract version with exactly the router and fixed UDP capabilities, reject v4 boxes, and delete planner/coverage options and calls from all listed paths. Preserve graph processing inside core for launch, restart, private target resolution, route building, and topology.

`additionalServerPort` does not directly add an outer publication today, but its route, readiness, sandbox, and private-mapping branches must still be removed to eliminate the divergent proxy path.

### P2-2 — The current LiveKit Egress configuration assigns two listeners to port 7980

**Failure scenario.** Egress v1.9.1 starts its health server and template server on the same address, so one fails to bind. Recording/Egress readiness can fail even though neither port is public.

**Code evidence.**

- `container-image-builds/images/livekit-server-agent/Dockerfile:8-20` pins Egress v1.9.1.
- `webmeetInfra/liveKitServerAgent/scripts/hooks/preinstall.sh:177-180` sets `health_port: 7980` but no distinct template port.
- `container-image-builds/.github/workflows/publish-livekit-server-agent.yml:70-89` still requires target-deleted TURN inputs.

**Affected design section.** Private Egress/health listeners and LiveKit image cleanup.

**Requirement violation.** Private-only does not make listener collisions harmless.

**Smallest correction.** Assign distinct private health and template ports, probe both, and remove embedded TURN build inputs and tests. Neither port should be physically published.

Primary source: [LiveKit Egress v1.9.1 configuration](https://github.com/livekit/egress/blob/v1.9.1/pkg/config/service.go#L41-L108).

### P2-3 — OnlyOffice’s port separation is sound, but the current security and isolation controls are inadequate

**Failure scenario.** A public editor request supplies spoofed forwarded headers or an unapproved origin; a callback URL redirects to an internal service or returns an unbounded response; a signed editor configuration remains reusable indefinitely; or another bridged agent directly reaches DocumentServer port 80 and bypasses the narrow proxy allowlist.

**Code evidence.**

- `AssistOSExplorer/onlyOffice/src/routes/storage.mjs:32-67` and `:86-153` follow callback redirects and buffer responses without adequate limits.
- `AssistOSExplorer/onlyOffice/src/onlyoffice-config.mjs:54-84` lacks explicit `iat`, `nbf`, and `exp` controls.
- `AssistOSExplorer/onlyOffice/src/routes/editor-proxy.mjs:38-65` preserves supplied origin/forwarding context.
- `AssistOSExplorer/onlyOffice/src/routes/editor-proxy.mjs:67-89` and `:118-176` filter HTTP and WebSocket paths separately.
- `AssistOSExplorer/onlyOffice/docs/design/confidential-doc-e2e-debug-handoff.md:285-301` records a wildcard DocumentServer Nginx listener.
- `container-image-builds/images/onlyoffice-agent/Dockerfile:1-6` permits the base version to be overridden rather than digest-pinned.

**Affected design section.** OnlyOffice browser transport, storage/callback server, and embedded DocumentServer isolation.

**Requirement violation.** A `public` transport route is not application authorization, and port 80 is not private to the agent while wildcard-bound on a shared bridge.

**Smallest correction.** Pin the exact image digest; bind DocumentServer and bundled support services to loopback or a dedicated isolated inner network; enforce the exact configured Origin; overwrite forwarded host/proto from trusted route state; add expiring editor JWTs; validate callback JWT algorithm/body/time; cap body, time, and redirects; revalidate every redirect hop against the SSRF policy.

Primary documentation:

- [OnlyOffice opening flow](https://api.onlyoffice.com/docs/docs-api/get-started/how-it-works/opening-file/)
- [OnlyOffice callback flow](https://api.onlyoffice.com/docs/docs-api/usage-api/callback-handler/)
- [OnlyOffice security model](https://api.onlyoffice.com/docs/docs-api/get-started/how-it-works/security/)

### P2-4 — Browser consumers cannot directly use the proposed mounted topology file

**Failure scenario.** The server-side Umami agent sees the topology file, but its browser plugin still uses stale local storage or hardcoded localhost values. A new public URL becomes active without reaching the browser.

**Code evidence.**

- `UmamiAgent/umamiAgent/IDE-plugins/umami-settings/umami-settings.js:1-19` initializes from local storage/default values.
- `UmamiAgent/umamiAgent/IDE-plugins/umami-settings/umami-settings.js:156-178` and `:248-268` derive URLs locally.
- `UmamiAgent/umamiAgent/scripts/start-umami-agent.sh:128-153` starts the MCP listener with a port but no explicit loopback host.

**Affected design section.** Runtime topology consumers and Umami.

**Requirement violation.** Mounting a file into a backend is not a generic browser-delivery mechanism.

**Smallest correction.** Add an authenticated, router-owned projection of active non-secret `(route key, service slug) -> browser URL` data, or have each backend expose that projection through its existing authenticated service. Do not expose raw targets or secrets. Pin the MCP implementation and explicitly bind it to loopback/private networking.

### P3

No standalone P3 findings. Style-only and speculative observations were omitted.

## 2. Invariant matrix

“Proven” means the target can be established against the current architecture after the required implementation work; it does not mean current main already satisfies it.

| Invariant | Status | Assessment |
|---|---|---|
| Exactly two outer mappings | Proven | No discovered transitive service needs a third physical port. |
| Outer wrapper independent of graph/manifests | Proven | Feasible after deleting the full planner/coverage surface and advancing the runtime contract. |
| No extra agent HTTP publication | Violated | Current LiveKit wildcard binding is an intra-box HTTP bypass; current `openPorts` also create many physical publications. |
| One fixed LiveKit UDP mux | Proven | LiveKit 1.11 supports `udp_port: 7882` without a range; candidate advertisement still needs correction. |
| External TURN sufficient for fallback | Violated | External TURN is architecturally sufficient, but current WebMeet credentials expire without refresh. |
| OnlyOffice works through routed HTTP/WebSocket only | Uncertain | The flow is structurally viable, but exact pinned path coverage and DocumentServer isolation are not yet proven. |
| Hostname selection does not bypass policy | Violated | Router-owned path precedence is undefined for service hostnames. |
| Local-only and publication-error semantics | Proven | The three-state model is coherent if public URLs and `cloudflared` remain inactive on error. |
| Manifests remain slim | Proven | `httpServices[].port` plus existing service policy fields is sufficient, including a second LiveKit service on the same port. |
| Removal of web-publishing is complete | Violated | Explorer profiles, workflows, hooks, image build, tests, and Ploinky fallback references remain. |

## 3. Dependency graph and current-versus-target port inventory

The transitive enabled graph contains 22 unique agents in the default profile, including Explorer and `basic/web-publishing`; the target has 21 after deletion.

~~~text
AssistOSExplorer/explorer
├─ 14 direct agents
│  ├─ gitAgent, dpuAgent, soplangAgent, tasksAgent
│  ├─ AchillesCLI/achilles-cli
│  ├─ basic/webtty
│  ├─ webmeetInfra/liveKitServerAgent
│  ├─ webmeetStt, webmeetAgent, multimedia
│  ├─ onlyOffice
│  ├─ proxies/soul-gateway
│  ├─ webAssist
│  └─ UmamiAgent/umamiAgent
├─ AchillesCLI/achilles-cli
│  └─ opencodeAgent, piAgent, codexAgent, GPTResearcher, proxies/searchAgent
├─ webmeetAgent
│  └─ liveKitServerAgent (duplicate)
├─ proxies/soul-gateway
│  └─ default-local-llm
└─ default profile
   └─ basic/web-publishing (deleted in target)
~~~

Evidence:

- `AssistOSExplorer/explorer/manifest.json:25-43`
- `AchillesCLI/achilles-cli/manifest.json:15-20`
- `AssistOSExplorer/webmeetAgent/manifest.json:12-17`
- `proxies/soul-gateway/manifest.json:39-41`

The current implicit host numbers below are the deterministic default canonical-graph results of `ploinky/container/box-publish-planner.mjs:11-16`. Aliases, explicit overrides, and profiles can alter them—one reason they should disappear.

| Agent | Current listeners | Current physical-host publication | Target classification and publication |
|---|---|---|---|
| Explorer | AgentServer `7000/tcp` | `127.0.0.1:20403->7000` | Routed HTTP; none |
| gitAgent | AgentServer `7000/tcp` | `127.0.0.1:33946->7000` | Routed/private AgentServer; none |
| dpuAgent | AgentServer `7000/tcp` | `127.0.0.1:22907->7000` | Routed/private AgentServer; none |
| soplangAgent | AgentServer `7000/tcp` | `127.0.0.1:44081->7000` | Routed/private AgentServer; none |
| tasksAgent | AgentServer `7000/tcp` | `127.0.0.1:48461->7000` | Routed/private AgentServer; none |
| Achilles CLI | AgentServer `7000/tcp`; CLI subprocesses outbound | `127.0.0.1:44884->7000` | Routed control/outbound-only subprocesses; none |
| opencodeAgent | AgentServer `7000/tcp`; outbound model/API traffic | `127.0.0.1:51390->7000` | Routed/private plus outbound; none |
| piAgent | AgentServer `7000/tcp`; outbound model/API traffic | `127.0.0.1:45131->7000` | Routed/private plus outbound; none |
| codexAgent | AgentServer `7000/tcp`; outbound model/API traffic | `127.0.0.1:32263->7000` | Routed/private plus outbound; none |
| GPTResearcher | AgentServer `7000/tcp`; UI/API/WS `8000/tcp` | `127.0.0.1:23893->7000`; 8000 via special secondary proxy | Both listeners routed by named services; none |
| searchAgent | AgentServer `7000/tcp`; local browser services `8888` and `8890` | `127.0.0.1:47460->7000` | 7000 routed; 8888/8890 process-local; none |
| WebTTY | HTTP/WS `7681/tcp` | `127.0.0.1:7681->7681` | Routed authenticated HTTP/WS; none |
| LiveKit server agent | Signaling/API `7880`; ICE/TCP `7881`; UDP `7882-7892`; health `17000`; Egress `7980`; Redis `6379`; TURN `3478`; TURN relay `20000-20010`; production Nginx `80/443` | Implicit `127.0.0.1:58451->7000` despite no ordinary AgentServer; plus all listed manifest publications, including wildcard TCP/UDP | `7880` routed; `7882/udp` fixed direct; health/Egress/Redis private; ICE/TCP/range/TURN/Nginx/Certbot obsolete and deleted |
| webmeetStt | STT HTTP `9000/tcp` | `127.0.0.1:19000->9000` | Private inter-agent only; none |
| webmeetAgent | AgentServer `7000/tcp` | Default `127.0.0.1:30699->7000`; production profile currently uses 17001 | Routed HTTP; none |
| multimedia | AgentServer `7000/tcp` | `127.0.0.1:33131->7000` | Routed/private; none |
| OnlyOffice | Control `7000`; editor proxy `8080`; storage/callback `9100`; embedded DocumentServer `80`; bundled PostgreSQL/RabbitMQ support sockets | `127.0.0.1:17002->7000`, `127.0.0.1:8082->8080` | 7000 authenticated routed; 8080 narrowly public routed; 9100 process-local; port 80/support sockets private to agent; none |
| soul-gateway | AgentServer `7000/tcp` | `127.0.0.1:31573->7000` | Routed/private plus outbound upstream; none |
| default-local-llm | AgentServer `7000`; model endpoint `8080` loopback | `127.0.0.1:56657->7000` | 7000 routed/private; 8080 process-local; none |
| webAssist | AgentServer `7000/tcp` | `127.0.0.1:49240->7000` | Routed/private plus outbound browser/API work; none |
| Umami | AgentServer `7000`; dashboard `3000`; MCP `7301`; PostgreSQL `5432`; proposed telemetry proxy `3001` absent | `127.0.0.1:33214->7000`; 3000 through secondary proxy | 7000/3000/3001 routed as applicable; MCP and PostgreSQL private/process-local; none |
| basic/web-publishing | AgentServer `7000`; HTTP `8081`; outbound `cloudflared` | `127.0.0.1:49417->7000`, `127.0.0.1:8081->8081` | Deleted |

Ordinary AgentServer’s default is port 7000 at `Agent/server/AgentServer.mjs:1294`, and current implicit publication is introduced during launch at `ploinky/cli/services/docker/agentServiceManager.js:1465-1480`.

No target row requires another physical-host publication. External TURN requires listeners and relay sockets on the separate TURN infrastructure, not on the Ploinky host.

## 4. Dependency and request flows

### Current outer-box creation

~~~text
bin/ploinky
  -> runtime-supervisor
  -> start temporary/running box planner
  -> mount/read workspace and registry
  -> resolve enabled dependency graph and profiles
  -> serialize openPorts + network mode + implicit AgentServer claims
  -> generate arbitrary docker -p arguments
  -> create/reconcile outer box
  -> pass publication coverage back into Ploinky core
  -> re-check coverage during agent launch/readiness
~~~

Physical publication composition happens at `ploinky/container/runtime-contract.mjs:624-767`. The supervisor executes the workspace-aware planner at `ploinky/container/runtime-supervisor.mjs:1200-1349`, then creates/reconciles the box at `ploinky/container/runtime-supervisor.mjs:1595-1662`.

The target outer flow should instead be:

~~~text
wrapper arguments + runtime-contract-vNext
  -> validate routerHostPort and fixed UDP 7882 availability
  -> create exactly two static mappings
  -> start box
~~~

It must not mount or inspect a workspace. Manifest and graph processing begins only inside the running box.

### Current HTTP/SSE/WebSocket routing

~~~text
0.0.0.0:8080
  -> router-owned health/auth/admin/marketplace handlers
  -> path-based service lookup
  -> HttpRouteAccessPolicy evaluation
  -> HTTP handler re-resolves route
  -> owning agent's primary hostPort
~~~

SSE uses the HTTP streaming proxy at `ploinky/cli/server/routerHandlers.js:102-133`. WebSockets take a separate upgrade path at `ploinky/cli/server/RoutingServer.js:633-650`. `additionalServerPort` takes another policy/proxy path.

The target should be one plan:

~~~text
exact Host
  -> configured selector for an enabled service slug
  -> effective route key/path/method
  -> one HttpRouteAccessPolicy decision
  -> authorization generation lease
  -> exact selected service container port
  -> engine-assigned box-loopback target
  -> rewrite and trusted invocation/auth headers
  -> upstream HTTP, SSE, or WebSocket commit
~~~

Host configuration participates only in the first two steps. It must not add a public/guest/authenticated grant.

### LiveKit signaling and media

The correct target data path is:

~~~text
Browser HTTPS/WSS
  -> Cloudflare tunnel or local router mapping
  -> RoutingServer
  -> public LiveKit signaling service
  -> 127.0.0.1:7880

WebMeet backend Twirp POST
  -> RoutingServer private authenticated service
  -> 127.0.0.1:7880

Browser ICE UDP
  -> physicalHostPublicIPv4:7882/udp
  -> outer fixed UDP mapping
  -> box namespace:7882
  -> LiveKit host-network UDP mux
~~~

For LiveKit 1.11:

- Single-port UDP mux operation is valid.
- Explicit `tcp_port: 0` prevents creation of the 7881 ICE/TCP listener; omission retains the normal 7881 default.
- No media range is needed when `udp_port` is configured.
- Signaling 7880 should sit behind the HTTP/TLS proxy rather than being exposed directly.
- Redis, Egress, and health do not require public ingress.
- Embedded TURN would require additional 3478/5349 and relay sockets and therefore must remain disabled.

Primary sources:

- [LiveKit ports and firewall documentation](https://docs.livekit.io/transport/self-hosting/ports-firewall/)
- [LiveKit v1.11 listener construction](https://github.com/livekit/livekit/blob/v1.11.0/pkg/service/server.go#L216-L238)

IPv4-only operation, correct NAT forwarding, one managed box per physical host, and the inability of direct UDP to traverse every NAT/firewall must be stated as operational limitations.

### Cloudflare

The Cloudflare decisions are correct:

- A connector token runs an existing remotely managed tunnel. See [Cloudflare tunnel run parameters](https://developers.cloudflare.com/tunnel/advanced/run-parameters/).
- Reconciliation of ingress and DNS requires API access beyond the connector token, including tunnel/connector and zone DNS permissions. See [Cloudflare remote tunnel API guide](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel-api/).
- `cloudflared` is outbound-only and needs no physical inbound TCP mapping.
- The remotely managed ingress must be reconciled to exact hostnames with a terminal non-routing catch-all.
- Cloudflare Access can add an outer control but cannot replace `HttpRouteAccessPolicy`.

| State | Required behavior |
|---|---|
| No Cloudflare credentials | Explicit `local-only`; no connector |
| Complete valid connector and API credentials | `cloudflare`; reconcile then activate |
| Partial, invalid, revoked, or broken configuration | `publication-error`; stop or inactivate public URLs, no fallback |

### TURN

The broker boundary is appropriate for WebMeet if P1-6 is corrected:

~~~text
WebMeet backend
  -> signed exact-target agent assertion
  -> private RoutingServer broker
  -> current enabled-generation ACL
  -> short-lived TURN REST username/password
  -> browser join response
~~~

The topology snapshot should include TURN URLs but not long-term secrets. The browser-facing join payload necessarily contains its own short-lived credential. A general browser broker endpoint is not needed.

### OnlyOffice

The target flow is structurally viable without another port:

~~~text
1. Browser -> authenticated control service on routed port 7000
2. Control server creates signed, expiring editor configuration
3. Browser loads DocumentServer api.js/assets through routed port 8080
4. Browser WebSocket upgrade uses the same 8080 route and policy
5. Editor proxy forwards only pinned-version-required paths to loopback port 80
6. DocumentServer downloads the opaque document URL from loopback port 9100
7. DocumentServer sends callback to loopback port 9100
8. Integrator validates callback, fetches the edited file, persists it, and returns {"error": 0}
~~~

Because DocumentServer and the Node integration run inside the same agent container, port 9100 and DocumentServer port 80 can be loopback-only. That assumption must remain explicit; splitting them into separate containers would require a dedicated private network rather than loopback.

## 5. Missing or inadequate acceptance tests

| Area | Required tests |
|---|---|
| Outer contract | Contract-vNext rejects v4; inspect `PortBindings` and prove exactly two mappings; prove no workspace read; enable/disable agents without changing mappings; fail when UDP 7882 is owned; fail a second managed box; reject inner attempts to capture 8080/7882. |
| Routing | Multi-port HTTP service resolution; unknown/disabled slug fails closed; invalid port fails closed; exact hostname selection; router-owned allowlist; HTTP/SSE/WS use identical service, rewrite, and policy generation; no `additionalServerPort` path remains. |
| Policy | Missing/corrupt/unreadable provider makes affected public hosts inactive; revocation races before new HTTP write, pooled HTTP write, SSE establishment, and WebSocket dial; out-of-band mutation semantics match the documented guarantee. |
| Listener boundary | Runtime `ss`/engine inspection for all 21 target agents; external scan of the physical host; cross-agent negative probes for LiveKit 7880, OnlyOffice 80/9100, Redis, Egress, PostgreSQL, MCP, and local model/search ports. |
| Cloudflare | All three credential states; partial credentials never fall back; exact ingress and DNS reconciliation; terminal catch-all; connector stopped on policy/publication failure; each configured hostname reaches only its selected service. |
| LiveKit | Effective config has `node_ip`, `tcp_port: 0`, `udp_port: 7882`, no range, no embedded TURN; only UDP 7882 candidate advertised; bridge agent cannot dial 7880 directly; signed Twirp route works; IPv4/NAT probe; rootless/nested UDP load test. |
| Egress | Health and template listeners use different ports; Egress can join/record through private Redis and signaling; neither listener is externally reachable. |
| TURN | Wrong source/alias/generation/audience/path/body/replay rejected; disabled caller rejected; rate/audit/rotation behavior; network switch and reconnect after the original credential expires; UDP TURN and TLS/TCP TURN against the selected external provider. |
| OnlyOffice | Real pinned DocumentServer browser load, all assets, WS, download and callback; expired editor/outbox JWTs; Origin and forwarded-header spoofing; callback redirect SSRF; response size/time caps; direct cross-agent port 80/9100 rejection; safe drain during an active edit. |
| GPTResearcher/Umami | Real-browser subpath tests covering redirects, assets, APIs, WebSockets, login, telemetry; ensure no root URL escapes; explicit MCP loopback binding. |
| Topology | Atomic replace; truncated/unknown schema; reconciling-to-active observed without restart; failed revision stays inactive; no secret/raw-target fields; browser projection updates; active OnlyOffice session survives readiness-only changes. |
| Hard cut | Repository-wide CI rejects `basic/web-publishing`, `WEB_PUBLISHING_*`, planner/coverage options, `additionalServerPort`, compatibility aliases, and deprecated URL fallback readers. |

## 6. Final decision list

### Decisions that should remain unchanged

- Exactly two static outer mappings.
- Fixed UDP 7882 for every box, with conflict failure and no remapping.
- One managed box per physical host under the current addressing model.
- Outer wrapper independence from manifests, graph, `openPorts`, and workspace state.
- Retaining graph/manifests inside Ploinky core.
- `openPorts` having private-inner meaning only.
- `httpServices[].port` as the sole networking schema addition.
- Deleting `additionalServerPort`.
- One route/policy path for HTTP, SSE, and WebSocket.
- Cloudflared as a core-supervised outbound connector, not an agent.
- Separate connector and least-privilege management credentials.
- Explicit `local-only`, `cloudflare`, and `publication-error` states.
- Complete deletion of `basic/web-publishing`.
- LiveKit host networking, single UDP mux, explicit `tcp_port: 0`, no UDP range, no embedded TURN, and external TURN.
- Private Redis, Egress, and health.
- OnlyOffice’s 7000/8080/9100/80 plane separation.
- Box-owned non-secret topology with no raw targets or credentials.
- Backend-only TURN broker with a box-configured consumer ACL.

### Decisions requiring revision

- Define exact router-owned paths allowed on a service hostname.
- Preserve service slug and port in one immutable route plan.
- Add a private authenticated LiveKit API service and bind 7880 to loopback.
- Require `rtc.node_ip` and explicit IPv4 candidate behavior.
- Make host networking a narrowly authorized box capability.
- Replace bounded-rehash security claims with an authoritative transactional policy generation or weaken the stated guarantee.
- Extend identity with effective instance and enable-generation semantics.
- Add TURN credential refresh/rejoin behavior.
- Split topology configuration revision from readiness/publication state and eliminate readiness-triggered restart-all.
- Pin and correctly subpath-configure GPTResearcher and Umami.
- Add a generic authenticated browser topology projection.
- Allocate distinct Egress health/template ports.
- Strengthen OnlyOffice pinning, callback validation, origin enforcement, JWT expiry, and socket isolation.
- Advance the outer runtime contract and remove every planner/coverage call site.
- Expand the web-publishing deletion across workflows, hooks, images, tests, and fallback code.

### Unresolved questions

- The exact listener set of the final digest-pinned OnlyOffice and Umami/MCP images, including bundled PostgreSQL/RabbitMQ support ports.
- Whether `webmeetStt` is still used by any supported WebMeet path; no definitive current consumer was found.
- The approved immutable commits/digests for GPTResearcher, Umami, and OnlyOffice.
- The selected external TURN provider’s REST-secret rotation model, rate limits, relay range, TLS policy, and maximum supported meeting lifetime.
- The real physical NAT/IPv4 configuration and rootless/nested UDP throughput of deployment hosts.
- Whether Cloudflare can express the desired management token at exact tunnel resource granularity; the documented baseline is account-level tunnel/connector permission plus zone-scoped DNS permission.
- The required OnlyOffice drain timeout, maximum callback body, redirect policy, and failure-recovery behavior.
- Whether IPv6 is deliberately unsupported or must receive its own explicit candidate/publication design.

---

This review was produced from repository code and primary vendor documentation. No implementation changes were made as part of the review.
