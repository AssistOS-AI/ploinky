# Ploinky Box Cloudflared Module — Design Proposal

Date: 2026-07-28

Status: proposal for review — not yet approved, nothing implemented

Scope: `ploinky` only (`ploinky-box/`, `cli/sandbox/`, `cli/server/`, `tests/unit/`)

Relation: extends [`2026-07-15-ploinky-box-edge-routing-and-publication-design.md`](./2026-07-15-ploinky-box-edge-routing-and-publication-design.md).
It does not amend that design's decision register. Per `ploinky/CLAUDE.md`, every
behavioral claim below is derived from executable code and tests, not from DS specs.

## 1. Requirement

Give `ploinky-box` a dedicated `cloudflared/` module that owns Cloudflare Tunnel
integration, with the operational behavior of the `basic/cloudflared` reference
agent but integrated directly into Ploinky:

| Condition | Behavior |
| --- | --- |
| A Cloudflare tunnel connector token is provided | The RoutingServer is exposed through a Cloudflare Tunnel (`cloudflared` runs inside the box, dials out, terminates public hostnames at the router origin `http://127.0.0.1:8080`). |
| No token is provided | The box behaves exactly as today: one loopback TCP publication to router `8080`, one `0.0.0.0` UDP `7882` media publication, no public HTTP hostname. |

## 2. Current state (code-derived)

Ploinky already contains most of the machinery; it is scattered and lacks a
token-only activation path.

| Layer | What exists | Evidence |
| --- | --- | --- |
| Box image contract | `cloudflared` is baked into the box image and version-gated at boot (`EXPECTED_CLOUDFLARED_VERSION=2026.7.1`, `--token-file` support required). | `ploinky-box/entrypoint/ploinky-box-entrypoint:8,107-123,137` |
| Router-integrated publication runtime | `startCloudflarePublicationRuntime` is started by the in-box RoutingServer once both listeners are up. It polls the active edge-routing generation and reconciles `desired.cloudflare` + `desired.hosts`. | `cli/server/RoutingServer.js:86,819-832,1018,1046`; `cli/sandbox/cloudflarePublicationRuntime.js:185-421` |
| Controller | Full reconcile pipeline: scope validation → ingress PUT → DNS upsert/teardown with ownership checks → remote verify → route commit → connector start → connection + external hostname proofs → ready; bounded restart (5/60s window, 1s→30s backoff). | `cli/sandbox/cloudflarePublication.js:192-793` |
| Connector | Spawns `cloudflared tunnel --no-autoupdate run --token-file <file>`; token written `0600`/`wx` under `/run/ploinky/cloudflared/connector-*`, minimal env (PATH/SSL_CERT_*/TZ), output redaction, SIGTERM→SIGKILL stop. | `cli/sandbox/cloudflarePublicationConnector.js:13-28,30-38,110-224` |
| Secrets | No plaintext env token. The edge-desired `cloudflare` tuple names two secret handles (`tunnelTokenSecret`, `apiTokenSecret`) resolved from the encrypted store (`.ploinky/.secrets`); handles must both resolve and be distinct. | `cli/sandbox/cloudflarePublication.js:109-141`; `cli/utils/config.js:69` |
| Desired-state schema | `cloudflare` tuple keys: `accountId`, `zoneId`, `tunnelId`, `tunnelTokenSecret`, `apiTokenSecret`. Per-key validation in `edgeGeneration.js` is presence-optional, but plan normalization requires all five, so today Cloudflare mode always needs the API token. | `cli/sandbox/edgeGeneration.js:610-631`; `cli/sandbox/cloudflarePublicationPlan.js:4-17` |
| Box port contract | Exactly two publications: `127.0.0.1:<hostPort>:8080/tcp` + `0.0.0.0:7882:7882/udp`; enforced byte-for-byte against owned containers. Router origin for the tunnel is `CLOUDFLARE_ORIGIN = http://127.0.0.1:8080`. | `ploinky-box/ports.mjs:145-150`; `ploinky-box/contract/container.mjs:117-149`; `cli/sandbox/cloudflarePublicationPlan.js:4` |
| Guardrails | `runtimeSourceAbsence.test.mjs` scans `ploinky-box/`, `cli/`, `container/`, `docs/` (excluding `docs/superpowers`), and the READMEs, and fails on tokens of the retired standalone approach and on retired version strings. Separately, `edgeDesiredApplyCli.test.mjs` asserts edge mutation is **not** a public CLI command. | `tests/unit/runtimeSourceAbsence.test.mjs:8-58,84-98,121-132`; `tests/unit/edgeDesiredApplyCli.test.mjs:19-33` |

The prior standalone-agent approach (`basic/` reference implementation with a
plaintext `TUNNEL_TOKEN` env, admin MCP tools, and an Explorer settings panel)
was retired from Ploinky runtime source by the 2026-07-15 design and is actively
forbidden by the absence test. This proposal ports its *operational idea*
(token → tunnel up; no token → unchanged), not its code or its plaintext-env
secret handling.

## 3. Gaps this proposal closes

| # | Gap | Consequence today |
| --- | --- | --- |
| G1 | No token-only activation path: plan normalization requires the full five-field tuple, so a connector token alone cannot bring the tunnel up. | Operators who manage ingress/DNS in the Cloudflare dashboard cannot use the integrated runtime at all. |
| G2 | Cloudflared sources live in `cli/sandbox/` mixed with edge-generation code; `ploinky-box/` has only the entrypoint version gate. | No single owned home for the box control-plane tunnel component the 2026-07-15 design describes ("supervised as part of the box control plane"). |
| G3 | No documented end-to-end operator workflow for enabling the tunnel (edge mutation is deliberately not a CLI command; no in-repo writer of the `cloudflare` tuple exists). | Feature is effectively unreachable without reading source. |

## 4. Proposed decisions

| Question | Decision |
| --- | --- |
| Where does the code live? | New module directory `ploinky-box/cloudflared/`. The six `cli/sandbox/cloudflarePublication*.js` files move there (renamed, see §5). Precedent for `cli/server` importing box modules already exists: `RoutingServer.js:88` imports `ploinky-box/lib/boxMarker.mjs`. |
| Where does the process run? | Unchanged: inside the box container, spawned and supervised by the in-box RoutingServer via the existing connector/controller. The host-side `ploinky-box/supervisor.mjs` stays a container-transaction manager and never touches cloudflared. |
| How is "token provided" expressed? | Explicitly, in the workspace `edge-desired.json` `cloudflare` stanza — never inferred from the environment. A new `management` discriminator selects the mode (§6). This preserves the 2026-07-15 posture: mode selection, not fallback. |
| What happens with no token/stanza? | `local-only` mode, byte-identical to today. |
| What happens with a broken token or failed reconcile? | Fail closed with a visible error and bounded restart — not a silent fall back to local-only. (Matches the approved design's "incomplete or invalid → fails closed".) |
| New host ports? | None. The port contract is untouched; `cloudflared` dials out from inside the container to Cloudflare and connects to the router over box-internal loopback. |
| What is *not* ported from the retired standalone agent? | Plaintext `TUNNEL_TOKEN` env delivery, admin MCP tools, the Explorer settings panel, and `host.containers.internal` origins. Status stays observable via `/health` (`edgePublication`) and the publication status file. |

## 5. Module layout

```
ploinky/ploinky-box/cloudflared/
    README.md          # module doc (mind §8 forbidden tokens)
    plan.mjs           # ← cli/sandbox/cloudflarePublicationPlan.js
    controller.mjs     # ← cli/sandbox/cloudflarePublication.js
    api.mjs            # ← cli/sandbox/cloudflarePublicationApi.js
    connector.mjs      # ← cli/sandbox/cloudflarePublicationConnector.js
    journal.mjs        # ← cli/sandbox/cloudflarePublicationJournal.js
    runtime.mjs        # ← cli/sandbox/cloudflarePublicationRuntime.js
```

Moves are content-preserving (extension change to `.mjs` matches ploinky-box
convention). `edgeGeneration.js` and `coordinatedEdgeApply.js` stay in
`cli/sandbox/` — they are edge-routing infrastructure, not Cloudflare-specific,
and `runtimeSourceAbsence.test.mjs:189-195` hard-codes the `edgeGeneration.js`
path.

Import updates required by the move:

| File | Change |
| --- | --- |
| `cli/server/RoutingServer.js:86` | `../sandbox/cloudflarePublicationRuntime.js` → `../../ploinky-box/cloudflared/runtime.mjs` |
| `tests/unit/cloudflarePublication{Plan,Controller,Runtime,Infrastructure}.test.mjs` | Update module paths (files may be renamed to match, e.g. `boxCloudflared*.test.mjs`). |
| Intra-module imports | `runtime.mjs` keeps reaching back into `cli/` for `edgeGeneration.js`, `coordinatedEdgeApply.js`, `maintenanceLocks.js`, `logger.js`, `config.js`; `controller.mjs` for `encryptedSecretsFile.js`. |

## 6. New mode: `management: "remote"` (token-only)

### 6.1 Desired-state schema

`edge-desired.json` gains an optional `cloudflare.management` key:

```jsonc
// Full management (current behavior, default when "management" is absent):
"cloudflare": {
    "management": "api",              // optional; "api" is the default
    "accountId": "…", "zoneId": "…", "tunnelId": "…",
    "tunnelTokenSecret": "cloudflare/tunnel-token",
    "apiTokenSecret": "cloudflare/api-token"
}

// Token-only (new): ingress + DNS are managed by the operator in the
// Cloudflare dashboard; Ploinky only runs and supervises the connector.
"cloudflare": {
    "management": "remote",
    "tunnelTokenSecret": "cloudflare/tunnel-token"
}
```

Validation (in `edgeGeneration.js` normalization and `plan.mjs`):

| Rule | `api` (default) | `remote` |
| --- | --- | --- |
| Required keys | all of `accountId`, `zoneId`, `tunnelId`, `tunnelTokenSecret`, `apiTokenSecret` (unchanged) | exactly `tunnelTokenSecret` |
| Forbidden keys | — | `accountId`, `zoneId`, `tunnelId`, `apiTokenSecret` (fail closed on ambiguity) |
| `hosts` map | non-empty (unchanged) | non-empty — the router routes by exact host selector, so at least one public hostname must be declared |

### 6.2 Controller behavior in `remote` mode

Reuses the existing reconcile skeleton; the delta is only which steps run:

| Step (current `api` pipeline) | `remote` mode |
| --- | --- |
| Resolve secrets (`resolveSecretPair`) | Resolve `tunnelTokenSecret` only; no distinctness pair check. |
| `validateScope`, `putTunnelIngress`, DNS upsert/teardown, `verifyRemote` | Skipped — zero Cloudflare API calls. A stub/absent API object asserts this in tests. |
| Route commit (`reconciling`, canonical scheme `https`) | Unchanged. |
| Connector start (`--token-file`, `0600`, redaction, minimal env) | Unchanged — same `connector.mjs`. |
| Connection proof (`listTunnelConnections` polling) | Replaced: requires the API token, so unavailable. Readiness = connector output signal (registered-connection log line under cloudflared 2026.7.1 — exact format to be pinned during implementation) with a bounded process-alive grace fallback. |
| External hostname proof (`/.well-known/ploinky-edge-proof/<generation>`) | Kept, mandatory. This proves the operator's dashboard ingress actually reaches *this* router for *this* generation before the final commit — remote mode stays verified, not fire-and-forget. One authenticated connector remains alive through a bounded proof window so edge propagation can converge; every stale generation, wrong status/body/application, timeout, or connector exit remains fail-closed. |
| Final commit `ready` + journal + status file | Unchanged. |
| Exit handling / bounded restart (5 per 60s, 1s→30s backoff) | Unchanged. |

### 6.3 Failure semantics

| Situation | Behavior |
| --- | --- |
| No `cloudflare` stanza | `local-only`; connector never starts. Unchanged from today. |
| Stanza present, secret handle unresolved | Reconcile fails closed: error state in status file + `/health.edgePublication`, connector stopped, scheduled retry with backoff. No silent downgrade to `local-only`. |
| Connector crashes while `ready` | Existing `onConnectorExit` path: generation inactivated, bounded restart, error surfaced. |
| Hostname proof fails (dashboard ingress absent/wrong) | Fail closed pre-`ready` with `CLOUDFLARE_HOST_PROBE_FAILED`; retried with backoff. |

Implementation must pin (with a test) that a failed `remote` reconcile leaves
the loopback admin surfaces (`/dashboard`, `/health`, private listener) serving
exactly as in `local-only` mode — see Open Question Q3.

## 7. Operator workflow (documented in the module README)

| Step | Action |
| --- | --- |
| 1 | In the Cloudflare dashboard, select an **existing** tunnel (workspace policy forbids creating quick/new tunnels from automation) and copy its connector token. |
| 2 | Store the token in the encrypted workspace secret store under a handle, e.g. `cloudflare/tunnel-token` (handle syntax per `SECRET_HANDLE`, `plan.mjs`). Exact CLI verb to be confirmed in implementation — see Open Question Q1. Never in env, argv, or files in the repo. |
| 3 | Author `<workspace anchor>/edge-desired.json` with the `hosts` map and the `management: "remote"` stanza (§6.1). There is deliberately no CLI mutation command for this file (`edgeDesiredApplyCli.test.mjs`). |
| 4 | In the Cloudflare dashboard, point the tunnel's ingress for each declared hostname at the router origin `http://127.0.0.1:8080` (the origin as seen from inside the box) and create the CNAME records. |
| 5 | `ploinky-box start …` — the box stages `edge-desired.json` into the container (`ploinky-box/edgeDesired.mjs`), the in-box runtime reconciles, and the tunnel comes up once the hostname proof passes. |

## 8. Constraints and guardrails the implementation must respect

| Constraint | Source | Implication |
| --- | --- | --- |
| Forbidden source tokens | `runtimeSourceAbsence.test.mjs:44-58` scans `ploinky-box/` and friends for the retired component names (the `basic/`-agent path string, the `…-agent` image compound, "standalone" + the binary name, the web-publishing tokens) | The new `ploinky-box/cloudflared/` files — including `README.md` and comments — must never contain those strings. `docs/superpowers/` is exempt (`:92`), which is why this proposal can name them. |
| Retired version tokens | same test, `:60-82` (e.g. `contract-5`, `contract 5`, `runtimeV5`) | Keep such strings out of every new/edited file under the scanned roots. |
| Port contract is closed | `ploinky-box/contract/container.mjs:117-149` | No new publication for the tunnel; no `--publish` additions. |
| Edge mutation is not a CLI command | `tests/unit/edgeDesiredApplyCli.test.mjs:19-33` | Do not add a `ploinky edge …` or `ploinky-box tunnel …` mutation command; the operator authors `edge-desired.json`. |
| Token hygiene | `connector.mjs` (`--token-file`, `0600`, `wx`, redaction, minimal env) | `remote` mode reuses the connector unchanged; no env/argv token delivery. |
| Only explicitly selected existing tunnels | workspace operating policy | `remote` mode consumes a token for a tunnel the operator selected; nothing in Ploinky creates tunnels, zones, or DNS in `remote` mode (it makes zero API calls). |
| Router port fixed at 8080 in-box | `cli/server/RoutingServer.js:93,102-104` | `CLOUDFLARE_ORIGIN` stays a constant; no configuration surface needed. |

## 9. Implementation plan

| Phase | Content | Files |
| --- | --- | --- |
| P1 — module extraction | Create `ploinky-box/cloudflared/`, move + rename the six modules, update importers, keep tests green with path-only changes. No behavior change. | §5 table |
| P2 — `remote` mode | Schema (`management` key) in `edgeGeneration.js` + `plan.mjs`; controller branch per §6.2; connector-output readiness signal; journal/status phases for the new mode. | `cli/sandbox/edgeGeneration.js`, `ploinky-box/cloudflared/{plan,controller,runtime}.mjs` |
| P3 — tests + docs | New unit tests (below); module `README.md` with the §7 workflow; update `README.md` / `container/README.md` prose if needed (mind §8 tokens). | `tests/unit/`, `ploinky-box/cloudflared/README.md` |

New tests (P3):

| Test | Cases |
| --- | --- |
| plan/schema | `remote` + token handle only → valid; `remote` + any api-management key → rejected; `remote` + empty `hosts` → rejected; absent `management` ≡ `api` (all five required, unchanged). |
| controller `remote` reconcile | Stub API object whose every method throws → full reconcile succeeds without touching it; connector started with token file; hostname proof called; commit `ready`. |
| controller `remote` failures | Unresolved secret handle → error state, connector never spawned, retry scheduled; connector exit while ready → bounded restart path; hostname proof failure → no `ready` commit. |
| loopback invariant | Failed `remote` reconcile leaves local admin surfaces responding as in `local-only` (pins Open Question Q3's answer). |

## 10. Verification criteria (runnable)

All from `/Users/danielsava/work/file-parser/ploinky`:

```bash
node --test tests/unit/runtimeSourceAbsence.test.mjs tests/unit/networkHardCutSourceAbsence.test.mjs
```

```bash
node --test tests/unit/cloudflarePublicationPlan.test.mjs tests/unit/cloudflarePublicationController.test.mjs tests/unit/cloudflarePublicationRuntime.test.mjs tests/unit/cloudflarePublicationInfrastructure.test.mjs
```

(Paths per the P1 renames if tests are renamed.)

```bash
node --test tests/unit/edgeGenerationHardCut.test.mjs tests/unit/ploinkyBoxEdgeDesired.test.mjs tests/unit/edgeDesiredApplyCli.test.mjs
```

Acceptance:

| # | Criterion |
| --- | --- |
| A1 | All commands above exit 0 after each phase (P1 must be green with zero behavior change). |
| A2 | With no `cloudflare` stanza, a box start produces a desired state with no `cloudflare` tuple (existing smoke assertions in `container/smoke-runtime.mjs:546-549` and `ploinky-box/smoke/graph.mjs:73` stay green). |
| A3 | With `management: "remote"` + resolvable token + dashboard ingress configured, `/health` reports `edgePublication.state === "ready"`, `mode === "cloudflare"`, and the declared hostname serves the router over the tunnel (manual e2e against a dedicated test tunnel + test zone only). |
| A4 | With `management: "remote"` and a deliberately unresolvable handle, `/health` reports an error state, the router keeps serving loopback, and no `cloudflared` process exists in the box (`pgrep cloudflared` inside the container is empty). |

## 11. Open questions

| # | Question | Recommendation |
| --- | --- | --- |
| Q1 | Exact operator command that writes a handle into the encrypted `.ploinky/.secrets` (the `encryptedSecretsFile.js` read was permission-blocked during this investigation; the `ploinky var` verb is memory/README-derived, unverified). | Verify during P2; document the confirmed verb in the module README. |
| Q2 | Reliable connector readiness signal without the API (`cloudflared` 2026.7.1 registered-connection log format). | Pin the exact line in a fixture test; fall back to a bounded process-alive grace period. |
| Q3 | What exactly do loopback/admin surfaces serve while the selected generation is inactive after a failed `remote` reconcile? | Answer empirically in P2 and pin with the loopback-invariant test; requirement is "identical to `local-only`". |
| Q4 | Should `remote` mode later gain an optional `tunnelId` for status display only? | Defer; adds an unvalidatable field with no behavior. |
