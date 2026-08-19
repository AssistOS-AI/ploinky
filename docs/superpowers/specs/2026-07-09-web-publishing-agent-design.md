# Web Publishing Agent — Design

Date: 2026-07-09. Branch target: `ploinky-box` across all affected repos.
Status: proposed (planning session; no implementation yet).

> Superseded implementation note (2026-07-09): this archival design was updated
> for terminology only. The implemented runtime contract is Ploinky startup
> config providers (`providesConfig` plus profile `configProviders`), documented
> in `../../specs/DS016-startup-config-providers.md`; the rejected router
> variable-publish architecture below is not the active implementation path.

## Problem

Deployments of AssistOSExplorer (especially inside ploinky-box) currently require
operators to inject public-exposure env vars into the runtime before start:
`ONLYOFFICE_PUBLIC_URL`, `WEB_PUBLISHING_CLOUDFLARED_TUNNEL_TOKEN`, `WEBMEET_PUBLIC_LIVEKIT_URL`,
`WEBMEET_TLS_HOSTNAME`, `WEBMEET_TURN_HOST`, `WEBMEET_TURN_EXTERNAL_IP`,
`WEBMEET_CERT_EMAIL`. The ploinky-box wrapper forwards **no** host env into the box
(`container/ploinky-box.mjs` `buildRunArgs()` passes only
`PLOINKY_WORKSPACE_ROOT`), so today these values must be seeded by running
`ploinky var` inside the box or by CI (`deploy-explorer-qa.yml` `set_var` calls).
`AssistOSExplorer/docs/explorer-qa-env-injection.md` additionally records that
`WEB_PUBLISHING_CLOUDFLARED_TUNNEL_TOKEN` injection is missing from the QA workflow entirely.

Goal: a new **Web Publishing** agent in the `basic` repo that owns public exposure
(nginx reverse proxy and/or Cloudflare Tunnel), is configured through an
admin dashboard, and **generates, persists, and publishes** the env/config values
other Ploinky agents consume — so operators stop passing these env vars into the
Ploinky box container.

## Current state (evidence)

| Fact | Source |
| --- | --- |
| Manifest env resolution order: `.ploinky/.secrets` → `process.env` → `.env` → manifest/profile default; resolved only at container create; recreate driven by `ploinky.envhash` label | `cli/services/secretVars.js:572-583`, `cli/services/docker/agentServiceManager.js:1364-1371`, `cli/services/docker/common.js:486-503` |
| `generatedSecret`/`sharedGeneratedSecret` values are HKDF-derived on the fly (deterministic, never persisted) — they cannot carry runtime-discovered values such as a tunnel token | `cli/services/secretVars.js:559-571`, `cli/services/masterKey.js` (`deriveWorkspaceSecret`/`deriveAgentSecret`) |
| No agent-facing API writes workspace vars today; writers are host-side only (CLI `var`/`vars`/`expose`, settings menu, runtime-resource planner, router component-token seeding) | `cli/commands/envVarCommands.js`, `cli/server/utils/routerEnv.js:6-9` |
| The sanctioned "one component seeds config for others" path is a host `preinstall` hook calling `ploinky var`; WebMeet and OnlyOffice already do this | `cli/services/lifecycleHooks.js:269-281`, `cli/services/workspaceUtil.js:546-548`, `AssistOSExplorer/webmeetAgent/scripts/hooks/preinstall.sh:90-116`, `AssistOSExplorer/onlyOffice/scripts/hooks/preinstall.sh` |
| Agent-only router endpoints authenticated by HTTP Agent Assertions exist; `/api/router/` is a reserved router-owned prefix | `cli/server/openAiAgentDiscovery.js`, `cli/server/RoutingServer.js:187`, `Agent/lib/agentAssertion.mjs` (`signAgentHttpAssertion`) |
| HTTP route access classes `public` (GET/HEAD only) / `guest` / `authenticated` and MCP tool policy `authenticated`/`internal`/`admin` are implemented and fail closed | `docs/specs/DS015-*.md`, `cli/server/policy/HttpRouteAccessPolicy.js:46-57`, `cli/server/policy/McpToolPolicy.js:30-41` |
| `basic/cloudflared` is the direct template: custom image (`assistos/cloudflared-agent:node24-cloudflared` built in `container-image-builds`), supervisor + AgentServer dual process, admin-tagged MCP tools, Explorer settings dashboard via manifest `ideSettings` + `IDE-plugins/cloudflared-settings/`, allowlisted `host.containers.internal:<port>` origins, refuses port 7000 | `basic/cloudflared/*`, `basic/docs/specs/DS004-cloudflared-agent.md`, `container-image-builds/images/cloudflared-agent/Dockerfile` |
| Explorer discovers dashboards from `.ploinky/repos/<repo>/<agent>/IDE-plugins/` automatically; `applicationPlugins` is allow-by-default | `AssistOSExplorer/explorer/utils/ide-plugins.mjs`, `explorer/utils/pluginUtils.core.js`, `docs/specs/DS02-plugin-hosting-and-dependencies.md` |
| Explorer `qa`/`prod` profiles enable `basic/cloudflared global no-wait` today | `AssistOSExplorer/explorer/manifest.json` profiles block |
| nginx precedent image: `container-image-builds/images/livekit-server-agent/Dockerfile` (apt-get nginx + certbot on multi-stage base) | that Dockerfile, lines 14-49 |

## Decision summary (the 12 design questions)

### 1. One agent or control-plane/data-plane split?

**One agent: `basic/web-publishing`.** A single container runs three processes
under a supervisor (nginx, cloudflared, plus the standard AgentServer MCP
sidecar), mirroring `basic/cloudflared`'s `start` + `agent` dual-command manifest.
Rationale: Ploinky's restart/env/policy unit is the agent; nginx route changes
are applied by in-container `nginx -s reload` (no agent restart), so there is no
operational win from separate containers; a split would add a startup-graph
dependency and a second image for no security gain (same trust domain, same
operator). The Explorer-facing dashboard is not a served surface at all — it is
an Explorer settings plugin calling the agent's admin MCP tools through the
router (cloudflared precedent), so there is no "dashboard container" to split out.

`basic/cloudflared` stays untouched for standalone use; Explorer's `qa`/`prod`
profiles switch to `basic/web-publishing` (see §10 and Migration).

### 2. How does Web Publishing persist generated/public config for others?

Three layers:

1. **Agent-local config store** (`/root/web-publishing/config.json` +
   `status.json`, i.e. `.data/web-publishing/` on the host): the operator's
   dashboard-entered configuration (mode, base domain, exposures, Cloudflare
   credentials reference). Follows cloudflared's `routes.json`/`status.json`
   pattern.
2. **Startup config provider outputs** — the new Ploinky runtime feature (§3): the
   agent pushes the *derived consumer-facing values* (`ONLYOFFICE_PUBLIC_URL`,
   `WEBMEET_*`, `WEB_PUBLISHING_CLOUDFLARED_TUNNEL_TOKEN`) to a router-owned, encrypted
   startup-config-providers store that manifest env resolution consults.
3. **Existing generated secrets stay untouched**: `WEBMEET_LIVEKIT_API_KEY/SECRET`,
   `WEBMEET_TURN_PASSWORD`, `PLOINKY_WEBMEET_MASTER_KEY`, `ONLYOFFICE_JWT_SECRET`
   remain `generatedSecret`/`sharedGeneratedSecret` — Web Publishing does not own
   or see them.

### 3. New runtime feature or existing mechanisms?

**A new, narrow runtime feature is required**: "agent-published workspace
variables". Evidence: no supported path lets a *running agent* write values that
other agents' manifest env resolution consumes; host `preinstall` hooks can call
`ploinky var` but cannot serve runtime-discovered values (tunnel token created
via Cloudflare API, dashboard reconfiguration). The feature has four parts:

1. **Manifest allowlist**: a new manifest field `publishesVars: ["NAME", ...]`
   (agent self-declaration, same trust class as `routerAccess.httpRoutes` —
   trusted manifest power, reviewed at enable time).
2. **Router endpoint**: `POST /api/router/startup-config-providers` under the existing
   router-owned `/api/router/` prefix, authenticated by an HTTP Agent Assertion
   (`tool: "__published_vars__"`, `computeRchHttp` over the exact body — the
   `openAiAgentDiscovery.js` pattern). The router verifies the source agent,
   loads its manifest, and accepts only names in that agent's `publishesVars`,
   rejecting reserved names (`PLOINKY_*`, `WEBDASHBOARD_TOKEN`) atomically.
3. **Encrypted store**: `.ploinky/data/startup-config-providers.enc`, AES-256-GCM under a
   **new HKDF purpose label `storage/startup-config-providers`** (per DS012's "new
   persistent secret ⇒ fresh purpose label" rule). Entries record
   `{value, publisher, updatedAt}`.
4. **Resolution integration**: `cli/services/secretVars.js` consults the
   published store **after** `.secrets`/`process.env`/`.env` and **before**
   manifest defaults, and marks provenance `PLOINKY_ENV_SOURCE_<NAME>=published`.
   Because `computeEnvHash` builds from the same resolution, a published change
   automatically triggers container recreate on the next `ploinky start`/restart
   — no new propagation machinery.

Precedence is the security spine: **operator sources always win** (an operator
`ploinky var` shadows a published value; the endpoint reports `shadowed` names so
the dashboard can warn). Published values only beat manifest defaults.

### 4. Avoiding env-into-the-box while preserving secret boundaries

Nothing new crosses the box boundary. User-owned inputs (Cloudflare API token or
tunnel token, base domain, hostnames, cert email) are entered once in the
admin dashboard → travel browser → router (session terminates at router) →
admin MCP tool (Router Request) → agent → startup-config-providers endpoint (Agent
Assertion) → encrypted store inside the workspace volume. `PLOINKY_MASTER_KEY`
remains router/launcher-only (in-box it resolves to the generated
`.ploinky/master-key` fallback); the publish endpoint denylists `PLOINKY_*` so
the feature cannot be used to inject identity/master material. Raw user JWTs
never reach the agent (DS014 flow unchanged).

### 5. Value ownership

| Class | Values | Source |
| --- | --- | --- |
| User-owned (dashboard inputs) | `WEB_PUBLISHING_CLOUDFLARE_API_TOKEN` + `WEB_PUBLISHING_CLOUDFLARE_ACCOUNT_ID` + `WEB_PUBLISHING_CLOUDFLARE_ZONE_ID` (API mode), or `WEB_PUBLISHING_CLOUDFLARED_TUNNEL_TOKEN` (token mode), base domain, per-service hostname overrides, `WEBMEET_CERT_EMAIL`, LAN host/IP override | Entered in dashboard, persisted in agent config store; secrets kept out of status output |
| Generated/derived and published by Web Publishing | `ONLYOFFICE_PUBLIC_URL`, `WEBMEET_PUBLIC_LIVEKIT_URL`, `WEBMEET_TLS_HOSTNAME`, `WEBMEET_TURN_HOST`, `WEBMEET_TURN_EXTERNAL_IP`, `WEBMEET_CERT_EMAIL`, `WEB_PUBLISHING_CLOUDFLARED_TUNNEL_TOKEN` (API mode mints it) | Derived from base domain + exposure map + detected/entered host IP; written via startup-config-providers |
| Untouched (Ploinky-generated) | `WEBMEET_LIVEKIT_API_KEY`, `WEBMEET_LIVEKIT_API_SECRET`, `WEBMEET_TURN_PASSWORD`, `PLOINKY_WEBMEET_MASTER_KEY`, `ONLYOFFICE_JWT_SECRET`/`JWT_SECRET`, `DPU_MASTER_KEY`, agent identity vars | Existing `generatedSecret`/`sharedGeneratedSecret`/DS014 injection |
| Optional/defaulted (not published in v1) | `WEBMEET_LIVEKIT_URL`, `ONLYOFFICE_INTERNAL_URL`, `ONLYOFFICE_CALLBACK_BASE_URL`, TURN ports/realm/user | Manifest profile defaults + existing preinstall seeding |
| Forbidden | `PLOINKY_MASTER_KEY` (never in any agent), `PLOINKY_*` names via publish API | Endpoint denylist + existing DS014 guarantees |

Note (correctness): WebRTC media (LiveKit UDP, TURN) **cannot** transit
Cloudflare Tunnel (HTTP/WS only). In tunnel deployments the WEBMEET topology
values still point at the real LiveKit host (its own nginx+certbot TLS stack in
`liveKitServerAgent`); Web Publishing is the *single pane* where the operator
enters them once, and the publisher of record — not a media proxy.

### 6. Cloudflare API mode (credentials provided)

Dashboard collects API token + account id (+ zone id + base domain). The
`web_publishing_tunnel_provision` admin tool: `POST
/accounts/{account}/cfd_tunnel` (create, `config_src: "cloudflare"`), `GET
/accounts/{account}/cfd_tunnel/{id}/token` (fetch connector token), `PUT
/accounts/{account}/cfd_tunnel/{id}/configurations` (ingress: hostname →
allowlisted local origin), and CNAME upsert `{hostname} → {tunnelId}.cfargotunnel.com`
(reusing `basic/cloudflared/lib/cloudflare-api.mjs` logic, extended with
create/token endpoints). The fetched token is stored in the agent config store
and published as `WEB_PUBLISHING_CLOUDFLARED_TUNNEL_TOKEN`; the supervisor (re)starts
cloudflared with it.

### 7. Tunnel-token mode (no API credentials)

Operator pastes an existing tunnel token (+ the hostnames that tunnel serves,
since ingress is managed on the Cloudflare side for remotely-managed tunnels).
The agent starts cloudflared with the token, publishes the operator-entered
hostnames as the derived URLs, and clearly reports "ingress managed in
Cloudflare dashboard" in status. Tokens are write-only in the UI (never echoed),
mirroring the cloudflared agent's redaction rules.

### 8. nginx-only mode

nginx listens on the container port declared in profile `openPorts`
(default profile `127.0.0.1:8081:8081`; a `lan` profile binds `0.0.0.0:8081:8081`
— explicit non-local binds are an intentional, reviewable manifest decision per
DS012). Server blocks are generated per exposure: `server_name <hostname>`,
`proxy_pass` to an **allowlisted origin** — the Ploinky router
(`http://host.containers.internal:8080`) by default, plus explicitly declared
data planes (OnlyOffice `8082`, LiveKit ports) — with WebSocket upgrade headers
and `X-Forwarded-*`. Port `7000` (raw AgentServer/MCP) is refused, same as
cloudflared. v1 is HTTP-only (LAN or behind an existing TLS terminator);
certbot TLS termination is a documented phase-2 extension (the image ships with
nginx only; the livekit image shows the certbot pattern when needed). Rootless
runtimes cannot bind host ports <1024, hence container port 8081 with the
host-side mapping left to the operator/profile.

### 9. nginx + Cloudflare mode

Both children run. cloudflared ingress targets nginx
(`http://localhost:8081` in-container) or the router directly, per exposure;
nginx serves the same exposures on the LAN. Published URLs are chosen per
exposure (`publishAs`: tunnel hostname or LAN URL), so internet users get
`https://onlyoffice.<domain>` while LAN-only deployments publish
`http://<lan-ip>:8081`.

### 10. Explorer discovery and use

Explorer's `qa`/`prod` profile `enable[]` entries switch from
`basic/cloudflared global no-wait` to
`{"agent": "basic/web-publishing no-wait", "profile": "default"}` (isolated run
mode — least privilege; the agent needs no workspace-root mount, unlike the
`global` mode cloudflared uses today). The dashboard is auto-discovered: the
manifest `ideSettings` entry + `IDE-plugins/web-publishing-settings/` are picked
up by Explorer's plugin scanner from `.ploinky/repos/basic/web-publishing/`
(no Explorer code change). `applicationPlugins` is allow-by-default, so no
policy entry is required.

### 11. Dashboard exposure through the router

The dashboard is an **Explorer settings panel** (`ideSettings` with
`adminOnly: true`), served by the router's `/workspace-files/...` static path
and talking to `/web-publishing/mcp` via `/MCPBrowserClient.js` — exactly the
cloudflared pattern. All mutations are **admin-tagged MCP tools**, so the router
enforces admin policy (DS015) end to end; there is no agent-served HTTP config
surface, no `routerAccess.httpRoutes`, no `httpServices`, and no public route in
v1 (trivially satisfying "public = GET/HEAD readonly": there are none).

### 12. Concrete artifact list

See the implementation plan
(`docs/superpowers/plans/2026-07-09-web-publishing-agent.md`) for exact files,
code, tests, and commands. Summary: ploinky (startup-config-providers store + endpoint +
resolution + CLI display + Agent client + tests + DS spec updates),
container-image-builds (Dockerfile + workflow + tests + README row), basic
(manifest, mcp-config with 4 admin tools, supervisor, nginx/cloudflare/publish
libs, IDE plugin, tests, DS spec via gamp-specs), AssistOSExplorer (manifest
profile switch, the two env docs, DS06/DS02 sync).

## Architecture

```
Browser (admin user)
  └─ Explorer settings panel  ── /web-publishing/mcp ──►  Ploinky Router
       (IDE-plugins, adminOnly)                             │  (admin MCP policy, Router Request)
                                                            ▼
                                                   basic/web-publishing container
                                                   ├─ AgentServer (MCP sidecar, readiness)
                                                   ├─ supervisor
                                                   │    ├─ nginx        (reverse proxy: LAN/data planes)
                                                   │    └─ cloudflared  (tunnel connector)
                                                   ├─ tools/web-publishing-tool.mjs (admin tools)
                                                   └─ lib: config store · nginx conf gen · Cloudflare API · publisher
                                                            │ Agent Assertion (`__published_vars__`)
                                                            ▼
                                              Router  POST /api/router/startup-config-providers
                                                            │ allowlist: manifest publishesVars
                                                            ▼
                                            .ploinky/data/startup-config-providers.enc  (AES-GCM, storage/startup-config-providers)
                                                            │ consulted by secretVars resolution
                                                            ▼
                            consumer agents (onlyOffice, webmeetAgent, liveKitServerAgent, explorer)
                                 env resolved at container (re)create → envhash change → recreate on next start
```

Data flow for a value change: dashboard apply → admin tool → config store +
nginx reload/cloudflared restart + publish call → store updated → dashboard
shows "restart required for: onlyOffice, webmeetAgent…" → operator runs
`ploinky restart` (or `ploinky start <static>`) → envhash mismatch recreates the
consumers with the new values.

## Error handling

| Failure | Behavior |
| --- | --- |
| Publish call with undeclared/reserved name | Router rejects the whole batch 403 (atomic), logs names only |
| Publish while operator var shadows the name | Write succeeds, response lists `shadowed`; dashboard warns |
| Corrupt/undecryptable published store | Resolution treats store as absent (defaults apply); CLI `ploinky vars` reports the corrupt store; deleting the file is the documented recovery (mirrors DS015 policy-state remediation) |
| Cloudflare API failure | Tool returns the API error (redacted); no partial state published; config store keeps last-applied |
| Missing tunnel token in tunnel mode | Supervisor writes `missing-token` status and idles (cloudflared-agent behavior) |
| nginx config regeneration invalid | `nginx -t` gate before reload; tool fails with validation output, previous conf stays active |
| Agent Assertion invalid/replayed | Opaque 401 (`agent_assertion_required`), no reason echo |

## Testing

- ploinky: unit tests for store round-trip + precedence (operator > published >
  default), endpoint auth/allowlist/denylist/atomicity, envhash change on
  publish, CLI display; existing `tests/unit/agentEnvInjection.test.mjs` must
  stay green (no `PLOINKY_MASTER_KEY` leakage).
- basic: manifest invariant test (mirrors `cloudflaredManifest.test.mjs`:
  forbidden fields, loopback default `openPorts`, exact `publishesVars`,
  secret-pattern scan), nginx conf generator tests (`nginx -t`-shaped
  assertions), Cloudflare API tests with stubbed `fetch` (create/token/ingress/DNS),
  publisher mapping tests, dashboard parse/normalize tests.
- container-image-builds: `image-definitions.test.mjs` case + workflow smoke
  (`nginx -v && cloudflared --version && node --version`).
- Skill validator: `node scripts/validate-ploinky-agent.mjs --agent-dir
  basic/web-publishing` (manage-ploinky-agents).
- End-to-end smoke (manual, scripted in the plan): local-test profile boot,
  publish via tool, `ploinky vars` shows published entries, consumer stub
  restart picks the value up (`podman exec <consumer> env | grep`).

## Migration

1. Additive ploinky feature ships first (no behavior change for existing
   workspaces: store absent ⇒ resolution unchanged).
2. Explorer `qa`/`prod` switch cloudflared → web-publishing. Existing
   deployments keep working because operator-set vars (including
   `WEB_PUBLISHING_CLOUDFLARED_TUNNEL_TOKEN`) win over published values; the agent consumes the
   same var name for its own cloudflared child.
3. `deploy-explorer-qa.yml` is left unchanged in v1 (operator vars still
   authoritative for CI); making `EXPLORER_QA_ONLYOFFICE_PUBLIC_URL` optional is
   a documented follow-up once web-publishing is the QA default.
4. The two env docs gain a "Web Publishing-published" classification column/rows.

## Rollback

- Revert Explorer manifest profiles to `basic/cloudflared global no-wait`.
- `ploinky disable agent web-publishing` (or remove from enable list).
- `rm .ploinky/data/startup-config-providers.enc` — resolution falls back to operator
  vars/defaults; consumers revert on next restart.
- The ploinky feature is additive (new files + one guarded resolution branch);
  reverting the ploinky commits restores prior behavior byte-for-byte.

## Risks / open questions

1. **First-boot ordering**: Explorer's deps are siblings in one dependency wave,
   so on a fresh workspace the first `ploinky start` may create consumer
   containers before the operator ever configures Web Publishing. Contract:
   configure → apply → restart. LAN auto-detection preinstall seeding (WebMeet
   precedent) is included for dev convenience but same-wave ordering with
   sibling consumers is not guaranteed — acceptable? (Design accepts it.)
2. **`basic/cloudflared` fate**: kept standalone here; deprecation/merge is a
   separate decision. Duplicated Cloudflare API lib code (copied, not shared)
   will drift — acceptable for v1?
3. **Rootless <1024 ports**: nginx LAN mode uses container port 8081; operators
   map 80/443 externally (box `--expose`, host firewall, or sysctl). Confirm
   acceptable for target deployments.
4. **Token-only mode cannot manage ingress** (Cloudflare-side for
   remotely-managed tunnels) — operator maintains hostname routes in the
   Cloudflare dashboard. Acceptable?
5. **Run mode**: chose `isolated` (vs cloudflared's `global`) for least
   privilege; needs smoke confirmation that nothing requires the workspace
   mount.
6. **`webmeetInfra/liveKitServerAgent` manifest** is not in the local checkout
   (cloned at deploy); its `WEBMEET_TLS_HOSTNAME`/TURN consumption is taken from
   `explorer-qa-env-injection.md`, not source — verify during implementation.
7. **Shadowing UX**: operator vars silently win; surfaced only via dashboard
   warnings and `ploinky vars` provenance — enough?
8. **Cloudflare API surface**: tunnel create/token endpoints are added beyond
   the existing ingress/DNS code; API contract verified against Cloudflare v4
   docs during implementation (not from memory).
