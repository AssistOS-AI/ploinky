# Router Request launch binding

A Router Request JWT binds the agent principal, request surface and content hash. For a new container it also signs the selected registry record's `launchId`. The receiving process compares that claim to `PLOINKY_LAUNCH_ID` after signature verification. A container created before launch binding can still accept a valid token with or without the claim.

## Router minting sites

| Request | Source | Coverage |
| --- | --- | --- |
| Shared issuer | `resolveRouteTargetRecord` and `buildRouterRequest` in `cli/server/mcp-proxy/invocationMinter.js`, `cli/server/security/tokens/RouterRequestTokenService.js:206` | The minter signs the selected `targetRecord`. With a selection generation it checks the digest, route key and container against active routing before resolving the record. A caller with its selection snapshot may identify a unique record by principal. Multiple records sharing a principal require an exact selection. |
| Protected or guest agent-port HTTP, SSE and WebSocket | `cli/server/RoutingServer.js:754`, `cli/server/RoutingServer.js:1077`, `cli/server/routerHandlers.js:503`, `cli/server/routerHandlers.js:520` | The route definition identifies the container. Callers that supply only a raw route must still present the current frozen route object. For a split dispatch, pass the chosen record in the signer's `targetRecord` option. Public routes without auth-info mint no JWT. |
| WebTTY home-profile resolution | `cli/server/webtty/homeProfileProvider.mjs:395` | Signs through the same HTTP route helper with the selected provider's plan. |
| Direct user and delegated MCP | `cli/server/mcp-proxy/index.js:446`, `cli/server/mcp-proxy/index.js:477`, `cli/server/mcp-proxy/index.js:738` | Both branches sign for the selected route’s container record. Pooled and unpooled calls carry the MCP request’s route and lease snapshot. |
| Continuation, task status and cancellation | `cli/server/mcp-proxy/index.js:272`, `cli/server/mcp-proxy/index.js:305`, `cli/server/mcp-proxy/index.js:363`, `cli/server/mcp-proxy/index.js:614`, `cli/server/RoutingServer.js:604` | The task helpers pass their dial route. Delegated task status supplies the route key and checks the edge plan before forwarding. Per-copy task dispatch must supply the task owner’s selected record. |
| Aggregate MCP | `cli/server/routerHandlers.js:804`, `cli/server/routerHandlers.js:818`, `cli/server/routerHandlers.js:836` | Aggregate entries retain the route and snapshot used to build their client. |
| WebChat input | `cli/server/handlers/webchat/messageEnvelope.js`, `cli/server/handlers/webchat/runtimeRoutes.js` | At dispatch, WebChat resolves the authorized route key and container in the bound generation and signs for that record. The pooled TTY must match the selected container and launch. A stale binding or mint failure is logged and returns HTTP 503 before any input or transcript echo. Reconnecting opens a new TTY when the launch has changed. |
| Agent-to-agent OpenAI chat completions and model listing | `cli/server/agentOpenAiDelegation.js:210` | Verifies the source assertion and signs for the forwarded route’s container record. |
| Public-share authorization callback | `cli/server/policy/HttpShareAuthorizer.js:33`, `cli/server/policy/HttpShareAuthorizer.js:94` | The owning route, callback port, and signing record come from one active snapshot. |

## Verification and runtime identity

| Runtime or request | Source | Coverage |
| --- | --- | --- |
| Shared verifier | `Agent/lib/invocationAuth.mjs:111`, `Agent/lib/invocationAuth.mjs:120`, `Agent/lib/requestSignedTokens.mjs:21` | Checks the launch claim on the verified payload. Existing audience, request hash, time and replay checks still apply. |
| AgentServer MCP tools and resources | `Agent/server/AgentServer.mjs:52`, `Agent/server/AgentServer.mjs:1329`, `Agent/server/AgentServer.mjs:1436`, `Agent/server/AgentServer.mjs:1456` | Covered through the shared verifier. |
| AgentServer task status and cancel | `Agent/server/AgentServer.mjs:1610`, `Agent/server/AgentServer.mjs:1639` | Both endpoints use the shared verifier. Continuation tools use the MCP path. |
| AgentServer delegated OpenAI | `Agent/server/AgentServer.mjs:696`, `Agent/server/AgentServer.mjs:715`, `Agent/lib/invocationAuth.mjs:245`, `Agent/lib/invocationAuth.mjs:294` | Both chat and model listing check the signed request for this launch. |
| Agent-owned HTTP servers | `Agent/lib/invocationAuth.mjs:187` | Servers using the shared HTTP auth-info helper inherit the check. U15 remains open for Bizanso and other separately deployed repositories. Their server sources are outside this worktree. |
| Docker and Podman | `cli/utils/security/agentIdentityEnv.js:53`, `cli/sandbox/docker/agentServiceManager.js:2226`, `cli/sandbox/docker/agentServiceManager.js:2428`, `cli/sandbox/docker/agentServiceManager.js:2717`, `cli/sandbox/docker/agentServiceManager.js:3046`, `cli/sandbox/docker/agentServiceManager.js:4808` | Every creation supplies a fresh ID. Managed containers reuse their signed descriptor's per-creation UUID. Host-network and network-disabled containers receive a fresh UUID without additional credentials. The initial and final registry records carry that ID. |
| Adoption | `cli/sandbox/docker/agentServiceManager.js:1242`, `cli/sandbox/docker/agentServiceManager.js:2483`, `cli/sandbox/docker/agentServiceManager.js:4506` | The env hash omits the ID and its provenance marker. Reuse validates the inspected env against the record and, on managed networks, the signed descriptor. The live two-start check in U16 remains pending. |
| Bwrap and Seatbelt | `cli/sandbox/bwrap/bwrapServiceManager.js:879`, `cli/sandbox/bwrap/bwrapServiceManager.js:886`, `cli/sandbox/seatbelt/seatbeltServiceManager.js:666`, `cli/sandbox/seatbelt/seatbeltServiceManager.js:1162`, `Agent/lib/invocationAuth.mjs:104` | Both are process sandboxes. Seatbelt uses the bwrap env builder. It strips reserved configured values and provides a non-secret principal. These processes get neither a container launch ID nor a reusable request secret. A Router Request presented without the agent secret is refused. |
| Host lifecycle hooks | `cli/utils/runtime/lifecycleHooks.js:156`, `cli/utils/security/agentIdentityEnv.js:132` | Configured launch identity is stripped with the reserved runtime variables. |

## Probes and relay tokens

| Site | Source | Coverage |
| --- | --- | --- |
| Direct readiness | `cli/server/utils/agentReadiness.js:111`, `cli/server/utils/agentReadiness.js:186`, `cli/server/utils/agentReadiness.js:224` | The TCP probe checks the port. The MCP probe initializes a session and lists tools. Neither operation mints or consumes a Router Request JWT. |
| Readiness over the private relay | `cli/server/utils/agentReadiness.js:324`, `cli/server/runtimeRelay/RuntimeRelayManager.js:444`, `cli/server/runtimeRelay/RuntimeRelayManager.js:641` | Readiness uses the same container-bound relay session and request proofs as other relay traffic. |
| Relay token mint and verification | `cli/server/runtimeRelay/relayRequestMinter.js:59`, `cli/server/runtimeRelay/relayRequestMinter.js:102`, `Agent/server/RuntimeHttpRelay.mjs:327`, `Agent/server/RuntimeHttpRelay.mjs:386`, `Agent/lib/relayRequestAuth.mjs:31`, `Agent/lib/relayRequestAuth.mjs:58` | Both relay token types already bind the immutable container ID, instance, enable generation, routing generation and relay session. A protected HTTP request carried inside the relay has its own Router Request launch check. |
| Script readiness and liveness | `cli/sandbox/docker/healthProbes.js:108`, `Agent/server/HealthProbeRunner.sh:531`, `Agent/server/HealthProbeRunner.sh:641` | The health-probe broker uses its own request token to identify the control directory and probe process. |
| Source assertions and user delegations | `cli/server/security/tokens/AgentAssertionService.js:107`, `Agent/lib/requestSignedTokens.mjs:61`, `cli/server/routerHandlers.js:478`, `cli/server/mcp-proxy/mcpDelegations.js:144` | These identify the source caller or its delegated authority. The Router separately mints the target's launch-bound Router Request. |
