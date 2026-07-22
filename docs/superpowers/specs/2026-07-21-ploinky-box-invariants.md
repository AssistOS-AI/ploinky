# Ploinky Box Invariants

Date: 2026-07-21

Status: approved invariant register; sole normative input for the ploinky-box
implementation plan

Scope: `ploinky` repository. The box image definition is an external build
artifact; its required properties are stated here as image obligations that
box code validates at runtime. The image is built and published exclusively by
triggering the `publish-ploinky-box-image.yml` GitHub workflow (manual
`workflow_dispatch` with exact 40-character source SHAs) in
`AssistOS-AI/container-image-builds`, which gates both native architectures
before moving the multi-architecture `docker.io/assistos/ploinky-box:runtime`
tag; the `ploinky` repository carries no image build files (N7).

## 1. What ploinky-box is

Ploinky-box packages the entire Ploinky runtime — CLI, RoutingServer, agents —
inside one rootless container (the "box"), so a host machine needs only a
container engine to run a fully isolated Ploinky workspace. Agents run as
nested containers inside the box. The box is a **purely additive layer**: it
wraps today's Ploinky, it does not change it. Existing Ploinky code keeps
working standalone, with no container at all, exactly as it does today.

The box consumes Ploinky core exclusively through the existing public seams
listed in section 4. If a box capability cannot be achieved through those
seams, implementation stops and the gap is recorded as an open question
(section 15) for an explicit owner decision — core is never silently modified.

## 2. Owner decisions

| ID | Decision |
| --- | --- |
| N1 | All box code lives in one new top-level folder `ploinky-box/` inside the `ploinky` repository. |
| N2 | Ploinky remains fully usable as a standalone CLI. The standalone entry point is a new binary `ploinky-local`, which executes today's CLI code path (`cli/index.js`) directly, with no container engine required. |
| N3 | The `ploinky` binary becomes the boxed entry point: its commands pass through the ploinky-box container. Inside the box, forwarded commands execute the direct CLI code path; the passthrough never recurses. |
| N4 | The box container has exactly two published ports by default: one HTTP port for the RoutingServer and one UDP port. No default third mapping exists. |
| N5 | The box is an additive layer. No file under `cli/`, `Agent/`, or `dashboard/` is modified. The only files touched outside `ploinky-box/` are packaging: the `bin/` entry shims and the `package.json` `bin` map. Core is consumed only through the section-4 seams; anything else is an escalation, not an edit. |
| N6 | There is no `ploinky box *` lifecycle namespace. The outer lifecycle is driven by bare `ploinky`, the forwarded `start` command, and the host-special verbs: `ploinky start` brings up the box and the ploinky containers inside it, `ploinky stop` stops the ploinky containers and then the box, `ploinky status` reports the status of the ploinky agents running inside the box, and `ploinky destroy` destroys the entire box container (named volumes survive per VOL-3). Unboxed operation always uses `ploinky-local`; `ploinky` never falls back to direct host execution. |
| N7 | The box image is built and published only by triggering the `publish-ploinky-box-image.yml` workflow in `AssistOS-AI/container-image-builds`. Image sources live in that repository, not here; this register binds the image solely through its runtime-contract obligations (section 8). |

## 3. Status legend

| Status value | Meaning |
| --- | --- |
| `holds-today` | Already true in today's codebase; the plan preserves it and must not regress it |
| `box-scope` | Implemented inside `ploinky-box/` |
| `image-scope` | Property of the box image, validated by box code at runtime |
| `packaging` | Entry-shim or package-metadata change permitted by N5 |
| `deferred` | Valid invariant whose implementation slice is scheduled later; nothing may contradict it meanwhile |
| `open` | Unresolved question requiring an owner decision before its slice can be built |

## 4. Core seams the box consumes

Every seam below exists in today's code and is used as-is.

| Seam | Location today | How the box uses it |
| --- | --- | --- |
| Direct CLI entry | `cli/index.js` (invoked by today's `bin/ploinky`) | The passthrough execs the standard CLI inside the box; `ploinky-local` execs it on the host |
| Router port | `PORT` environment variable, default `8080` (`cli/server/RoutingServer.js`) | The in-box router stays on `8080`; the box maps a host port onto it |
| Router bind address | `PLOINKY_PUBLIC_BIND` (default `127.0.0.1`) and companion `PLOINKY_PUBLIC_AUTHORITY` (`cli/server/RoutingServer.js:81`) | The box sets both at container launch so the engine port-forward can reach the listener; on a wildcard bind the authority variable is mandatory, which the box supplies |
| Private listener port | `PRIVATE_LISTENER_PORT = 8081` (`cli/server/privateListener.js`) | The box treats `8081` as reserved and never publishes it |
| Host-sandbox kill switch | `PLOINKY_DISABLE_HOST_SANDBOX=1` (`cli/utils/runtime/sandboxRuntime.js`) | Baked into the box image environment so bwrap/seatbelt can never activate inside the box |
| Engine selection | PATH probe, podman before docker (`cli/sandbox/docker/common.js:87`) | The image ships only podman, so core selects nested podman with no configuration |
| Nested container naming | `ploinky_<repo>_<agent>_<projectDir>_<cwdHash>` (`cli/sandbox/docker/common.js:201`) | The box entrypoint cleans stale Ploinky-created nested containers by this name prefix |
| Dependency presence check | `achillesAgentLib` check in the entry shim and `cli/index.js` | The box satisfies it through the mounted dependency volume |
| Workspace state | `.ploinky/` under the current working directory | Lives in the box workspace volume; core reads and writes it unchanged |

## 5. Layout and binaries

| ID | Invariant | Status |
| --- | --- | --- |
| LAY-1 | Every box artifact — supervisor, runtime contract, engine client, argument parser, entrypoint assets, publish formatter, box smoke tests — lives under `ploinky-box/`. | box-scope |
| LAY-2 | Dependency direction is one-way: `ploinky-box/` may spawn the core CLI as a child process inside the container, but no module under `cli/`, `Agent/`, or `dashboard/` imports from `ploinky-box/`. | box-scope |
| LAY-3 | `ploinky-box/` duplicates no routing, policy, or proxy logic. The box is packaging and boundary enforcement; all request handling stays in `cli/server/`. | box-scope |
| LAY-4 | The box supervisor has zero external npm dependencies and imports cleanly with an empty `node_modules` — it runs before dependencies can be installed. | box-scope |
| BIN-1 | `bin/ploinky-local` preserves today's `bin/ploinky` behavior byte-for-byte: the `achillesAgentLib` presence check, the `-shell`/`sh`/`--shell` routing to `bin/ploinky-shell`, and direct execution of `cli/index.js`. | packaging |
| BIN-2 | `bin/ploinky` becomes a thin shim that executes the passthrough under `ploinky-box/`; it contains no logic beyond locating the repository root and the passthrough entry. | packaging |
| BIN-3 | `ploinky-local` requires no container engine, performs no engine discovery, never pulls an image, and never creates or inspects a box. Standalone operation is a first-class mode, not a fallback. | holds-today |
| BIN-4 | A marker baked into the box image identifies the in-box environment. `ploinky` invoked inside a box executes the direct CLI path instead of recursing into engine commands. One marker, one detection helper inside `ploinky-box/`; no scattered environment sniffing. | box-scope + image-scope |
| BIN-5 | The `package.json` `bin` map is corrected in the same change: the stale `p-cloud` entry (pointing at a file that does not exist) is removed; `ploinky` and `ploinky-local` are published. | packaging |
| BIN-6 | Auxiliary binaries `bin/p-cli`, `bin/psh`, and `bin/ploinky-shell` keep working. Each is explicitly assigned boxed or local routing in the plan and tested; none may break silently. | packaging |

## 6. Outer port contract

| ID | Invariant | Status |
| --- | --- | --- |
| PRT-1 | Every managed box has exactly two engine publications, constructed unconditionally by box code: `127.0.0.1:<routerHostPort>:8080/tcp` and `0.0.0.0:7882:7882/udp`. `<routerHostPort>` defaults to `8080`. | box-scope |
| PRT-2 | The TCP publication binds physical-host loopback by default. Public HTTP, when ever enabled, reaches the router only through an outbound tunnel connector (section 12); no wildcard host TCP bind exists. | box-scope |
| PRT-3 | The UDP publication is an unconditional reserved slot owned by the box contract. It exists even when nothing listens behind it; an idle mapping that drops packets is accepted. This keeps the boundary constant regardless of workspace content. | box-scope |
| PRT-4 | Box creation reads no workspace, profile, manifest, or agent state to compute publications. The mapping set is constant before any workspace exists. | box-scope |
| PRT-5 | No manifest field, route record, policy record, readiness result, environment variable, CLI flag, or persisted state can add, remove, or change an outer mapping. The runtime config has no extra-publication field of any kind. | box-scope |
| PRT-6 | The passthrough rejects `--publish`, `--expose`, and any LAN-exposure flag. `--port` selects only the physical-host TCP side (`<routerHostPort>`); the box-side listener port stays `8080`. | box-scope |
| PRT-7 | Config merge preserves both constructor-owned mappings exactly and accepts no caller override of the UDP reservation. | box-scope |
| PRT-8 | If physical-host `7882/udp` is already owned by another process or container, box creation fails with an explicit fixed-port collision diagnostic naming the owner where available. The box never remaps to another host port. | box-scope |
| PRT-9 | The private RoutingServer listener (`8081/tcp`) is never published at the box boundary and is unreachable through the box's outer-facing interface. | box-scope |
| PRT-10 | The box launches the router with `PLOINKY_PUBLIC_BIND` set to the box interfaces and `PLOINKY_PUBLIC_AUTHORITY` set to the canonical authority, so the engine port-forward is reachable. Standalone `ploinky-local` inherits today's defaults (loopback bind) untouched. | box-scope |
| PRT-11 | Port numbers `8080`, `8081`, and `7882` are pinned as constants inside `ploinky-box/`, matching the router's documented listener contract. Box code never parses them out of core source. | box-scope |

## 7. Box identity and host-engine discovery

| ID | Invariant | Status |
| --- | --- | --- |
| IDN-1 | Box identity derives deterministically from the exact current working directory: `canonicalPath = realpath(cwd)`, `pathHash = first 12 lowercase hex of SHA-256(canonicalPath)`, `slug = sanitized bounded basename`, `instance = ploinky-box-<slug>-<pathHash>`. | box-scope |
| IDN-2 | Symlinked paths to the same physical directory resolve to the same instance; equal basenames at different paths resolve to different instances; a moved or renamed folder is a new identity whose old resources remain for manual recovery. | box-scope |
| IDN-3 | There is no public instance-name or engine-selection flag and no engine-selection environment override. Engine selection is always automatic. | box-scope |
| IDN-4 | Engine discovery probes every installed engine (podman, docker) independently, each with exactly one result: `owns`, `absent`, or `unknown`. Installed-but-unreachable is `unknown`, never `absent`. | box-scope |
| IDN-5 | While any installed engine is `unknown`: `help` stays local, `status` reports partial state and exits nonzero, and every other public command fails before pull, start, exec, stop, destroy, or any mutation. | box-scope |
| IDN-6 | The box and its named volumes form one engine-owned resource set. The sole resource owner wins regardless of engine preference; split or foreign ownership fails closed with both inventories; podman-first applies only to a completely empty identity. | box-scope |
| IDN-7 | Ownership metadata lives only in labels (identity schema version, path hash, volume role); the cleartext absolute path is never stored in container or volume metadata. | box-scope |
| IDN-8 | Create, start, stop, destroy, replacement, and reconciliation for one box identity are serialized through a host-side per-identity mutation lock. Stale-lock recovery removes a lock only after proving the recorded owner process is gone. `help` and `status` never acquire the mutation lock. | box-scope |

## 8. Box image and runtime-contract validation

| ID | Invariant | Status |
| --- | --- | --- |
| IMG-1 | The box image carries a versioned contract label. The supervisor validates every field of one authoritative metadata table — user, home, workspace, PATH, entrypoint, empty command, no image-declared volumes, required environment including the host-sandbox kill switch — field by field with field-specific errors; the label alone is never sufficient. | box-scope + image-scope |
| IMG-2 | An unsupported contract version fails closed with an explicit destroy-and-recreate instruction. There is no migration, translation, dual-read, volume adoption, or automatic destructive action. | box-scope |
| IMG-3 | Pull policy: pull unconditionally before create and before intentional replacement; never pull for reuse of a running compatible box, start of a stopped compatible box, `status`, `stop`, or `destroy`. Pull failure never falls back to a cached tag. | box-scope |
| IMG-4 | After pull and validation the supervisor runs the resolved image ID, not the mutable tag, and records the requested logical reference in a supervisor-owned label. Compatible existing boxes stay pinned to their inspected image ID; tag refresh is explicit destroy-and-recreate. | box-scope |
| IMG-5 | Replacement is transactional: resolve desired config, pull, validate, stop core gracefully, remove the old box, create from the validated ID with the same named volumes, validate health; on failure remove the replacement and restore the prior image ID and full creation configuration. | box-scope |
| IMG-6 | Ploinky core is host-mounted into the box read-only (`/opt/ploinky`), with a dedicated writable named volume for `node_modules`. The image is runtime-only and bakes no Ploinky source. | box-scope + image-scope |
| IMG-7 | The image entrypoint proves at boot: expected unprivileged user identity, writable workspace, executable mounted core, required tools (bash, node, npm, git, podman), `/dev/fuse` and `/dev/net/tun`, functional rootless podman with full subordinate UID/GID mappings, and nested container execution. The box never runs `--privileged`. | image-scope, validated box-scope |
| IMG-8 | The image bakes the environment that drives core through its existing seams: the host-sandbox kill switch, the in-box marker, and a PATH containing only podman as a container engine. Forcing nested podman is achieved entirely through image content plus core's existing podman-first probe. | image-scope |
| IMG-9 | The runtime contract holds identically on native amd64 and arm64: nested rootless podman, the exact two-publication boundary, and the boot self-checks pass native smoke gates on both architectures before the `runtime` tag moves. Architecture support is never inferred from a successful image build alone. | image-scope, enforced at the build gate |

## 9. Volumes, persistence, and destroy

| ID | Invariant | Status |
| --- | --- | --- |
| VOL-1 | Exactly three managed named volumes exist per instance: `<instance>-workspace` at `/workspace`, `<instance>-containers` at the nested-storage home, `<instance>-ploinky-deps` at `/opt/ploinky/node_modules`. Each is explicitly created with the full ownership-label set before first attachment. | box-scope |
| VOL-2 | An exact-named volume with missing, malformed, or mismatched ownership labels is foreign: it is never attached, relabelled, migrated, or deleted automatically. | box-scope |
| VOL-3 | `destroy` confirms, then directly force-removes only the outer box and its attached anonymous volumes. All named volumes survive with labels intact, and the confirmation prompt says so. Missing-box destroy is idempotent and never prompts. | box-scope |
| VOL-4 | Recreation after destroy reattaches the retained named volumes, so workspace state, nested image cache, and installed core dependencies survive a box replacement. | box-scope |
| VOL-5 | Box boot removes only stale nested containers matching Ploinky's own deterministic `ploinky_` name prefix (section 4). Other nested containers, nested images, and nested named volumes are never removed; enumeration or removal failure fails the entrypoint loudly. | box-scope + image-scope |

## 10. Nested agent runtime inside the box

| ID | Invariant | Status |
| --- | --- | --- |
| NST-1 | Inside the box, agents run under nested podman because the image ships no other engine and bakes the host-sandbox kill switch. Core's runtime selection is not modified; outside the box, today's selection (`cli/sandbox/docker`, `cli/sandbox/bwrap`, `cli/sandbox/seatbelt`) is untouched. | image-scope |
| NST-2 | Agents keep standalone-mode behavior inside the box: same manifests, same `Agent/` payload, same readiness, same environment injection from core. The box adds nothing agent-visible; from core's perspective the box is just another host. | box-scope (proof obligation) |
| NST-3 | The host container-engine socket is never mounted into the box, and nested agent containers get no control over sibling containers. | box-scope |
| NST-4 | Nested-podman behavior is tuned only through image-baked podman configuration files. If a nested-runtime issue cannot be solved at the image level, it becomes an open question for an owner decision; core is not patched for it. | image-scope; escalation per N5 |

## 11. Command routing and argument grammar

| ID | Invariant | Status |
| --- | --- | --- |
| CMD-1 | Grammar: `ploinky [OUTER_OPTION ...] [--] [CORE_COMMAND [CORE_ARGUMENT ...]]`. Outer options are recognized only before the first core command token; a pre-command `--` ends outer parsing explicitly. | box-scope |
| CMD-2 | Every post-command token is forwarded to the in-box CLI byte-for-byte in spelling and order. Outer option names appearing after the command are ordinary downstream payload. | box-scope |
| CMD-3 | Bare `ploinky` reconciles/starts the box and opens the in-box Ploinky REPL. Parameterless `ploinky cli` opens interactive bash in `/workspace`. `ploinky cli AGENT ARGS...` forwards to the nested agent CLI attachment exactly as the direct CLI does today. | box-scope |
| CMD-4 | `help`, `status`, `stop`, and `destroy` are host-special (N6). `help` renders locally without starting a box. `status` is read-only, never pulls or reconciles, and reports the status of the ploinky agents running inside the box (forwarded core `status`) together with outer box state; when the box is absent or stopped it reports that state without starting anything. `stop` gracefully stops in-box core services and nested agent containers within a bounded timeout, then stops the outer box container; it is idempotent and preserves the box container and every named volume. `destroy` destroys the entire box container per VOL-3. | box-scope |
| CMD-5 | For `start`, accepted router-port forms are prefix `ploinky --port PORT start AGENT` and positional `ploinky start AGENT PORT`; the tail forms `start AGENT --port PORT` and `--port=PORT` are rejected before any mutation, with both accepted replacements printed. Non-`start` post-command `--port` stays a downstream token. | box-scope |
| CMD-6 | Because the outer contract is fixed (section 6), no command needs publication planning or box replacement to change ports. The only reasons to replace a box are image or configuration changes; command forwarding never mutates the mapping set. | box-scope |
| CMD-7 | `ploinky-local` is today's CLI, unchanged: it knows nothing about outer options, boxes, or engines, and its argument handling is whatever `cli/index.js` does today. | holds-today |
| CMD-8 | The host-special verbs shadow same-named core commands only at the `ploinky` passthrough. Core `status`, `stop`, and `destroy` semantics stay reachable through `ploinky-local` on an unboxed workspace and through the in-box REPL or `ploinky cli` shell. A missing, incompatible, or broken box is an explicit `ploinky` failure, never a fallback to direct host execution. | box-scope |

## 12. Publication and tunnel connector (deferred slice)

The two-port default (N4) is complete without any tunnel. This group binds the
future public-HTTP slice; nothing in the base plan may contradict it.

| ID | Invariant | Status |
| --- | --- | --- |
| PUB-1 | Local-only is the default operating mode: no connector process, no public hostname, router reachable only through the host-loopback TCP mapping. It is a mode selection, not a failure state. | deferred |
| PUB-2 | Public HTTP, when configured, is served exclusively by an in-box connector making outbound connections to the fixed in-box router address; no inbound Internet-facing TCP socket is added. The box image owns the connector binary; desired state, credentials, reconciliation, and health belong to the publication slice's own design. | deferred |
| PUB-3 | Incomplete or invalid publication configuration fails closed with the connector stopped; the runtime never silently reselects local-only, and loopback administration stays available. | deferred |
| PUB-4 | Ploinky never creates tunnels, accounts, or zones; it operates only an explicitly supplied existing tunnel with separate least-privilege connector and management credentials, stored encrypted, materialized only as ephemeral mode-0600 token files, and never echoed in argv, environment dumps, logs, status, or API reads. | deferred |
| PUB-5 | Hostname configuration is deployment state selecting existing router routes; it never appears in agent manifests and never carries a raw port or access override. | deferred |

## 13. Existing invariants the box must not violate

These hold in today's codebase. The box wraps them; it must not create a second
path around any of them. The current routing contract is specified in
`docs/superpowers/specs/2026-07-20-routingserver-unified-browser-proxy-requirements.md`.

| ID | Invariant | Today's anchor | Status |
| --- | --- | --- | --- |
| RTE-1 | All browser HTTP, streaming HTTP, SSE, WebSocket, and WebRTC-signaling traffic flows through RoutingServer's single proxy abstraction; only the media UDP socket bypasses it. | `cli/server/proxy/RoutePlan.js`, `executeHttpPlan.js`, `executeWebSocketPlan.js` | holds-today |
| RTE-2 | Secondary agent listeners are reached only through the reserved agent-port convention with runtime-confined relays; there is no manifest endpoint catalog, no per-service host port, and no raw host-port dial. | `cli/server/agentPortConvention/*`, `Agent/server/RuntimeHttpRelay.mjs` | holds-today |
| RTE-3 | Authorization uses immutable content-addressed generations with an authorization-to-dial lease committed immediately before the first upstream byte or dial; staged file edits have no runtime effect until coordinated apply; failures leave selectors inactive with no previous-generation fallback. | `cli/server/generation/*` | holds-today |
| RTE-4 | Caller-controlled forwarding, identity, authorization, and delegation headers are stripped and canonical values synthesized from trusted state before proxying. | `cli/server/proxy/sanitizeRequestHeaders.js` | holds-today |
| RTE-5 | Unknown hosts, inactive routes, invalid selectors, and unhealthy targets fail closed with bounded errors; no request falls through to a different agent or port. | `cli/server/proxy/recordProxyOutcome.js`, `limits.js` | holds-today |
| RTE-6 | Machine-to-machine calls use the private listener with caller assertions and exact ACLs; reachability is never authorization. | `cli/server/privateListener.js`, `Agent/lib/machineCallAssertion.mjs` | holds-today |
| RTE-7 | The box never terminates, rewrites, or re-proxies router traffic itself. The engine port-forward from host loopback to box `8080` is the only transport the box adds. | — | box-scope |
| MAN-1 | Agent manifests carry no publication surface: no port-publication fields exist in today's manifest contract and the box introduces none. No manifest value is ever an input to the outer mapping set. | verified absent from `cli/` and `Agent/` | holds-today |
| MAN-2 | Ploinky core and box code contain no hardcoded optional agent, product, or backend identifiers; any future capability grants are data-driven box configuration keyed by effective instance. | repository invariant | holds-today, preserved |

## 14. Exclusions

The box layer must never grow these behaviors; reviews treat any appearance as
a defect.

| Excluded behavior | Rule |
| --- | --- |
| Graph- or manifest-driven outer publication planning | The mapping set is constant (PRT-1, PRT-4); no planner, no coverage computation, no publication provenance tracking exists |
| Manifest port-publication fields | No `openPorts`-style or per-service port field is added to the manifest contract |
| Extra outer publications | No `--publish`/`--expose`/LAN flags, no config field, no persisted state can create a third mapping |
| Stable host ports for individual agent services | Every agent HTTP surface is a router target; direct host ports for services violate PRT-1 |
| Publication by agents | No agent owns a tunnel connector, reverse proxy, or public hostname; publication is a box/runtime concern |
| Core modifications | No edits under `cli/`, `Agent/`, or `dashboard/` (N5); packaging files only |
| Engine socket passthrough | The host engine socket is never mounted into the box (NST-3) |
| Silent mode fallbacks | No automatic switch between local-only and published modes in either direction (PUB-3) |
| Migration and compatibility layers | Unsupported boxes and foreign volumes fail closed with explicit recreate instructions (IMG-2, VOL-2); nothing is auto-migrated |
| Secret material in engine-visible surfaces | No secret value ever appears in outer-engine argv, inspectable container environment, labels, image metadata, `status` output, dry-run output, or logs; secrets entering the box use a narrowly scoped runtime transport and are cleaned up on failure (VER-15) |

## 15. Open questions

| # | Question | Constraint from this register |
| --- | --- | --- |
| Q1 | How does a bridge-networked nested agent reach the private listener `8081` under rootless nested podman without the private listener binding the box's outer-facing interface? This question belongs to the routing layer and exists independently of the box; the box neither causes nor solves it. | Bridge-mode private machine calls are not declared supported until resolved; no outer-interface bind without an explicit reviewed decision. |
| Q2 | Runtime-contract version value for the box image. The published `runtime` tag carried contract label `3` when inspected on 2026-07-21, the publish workflow's gates require `5`, and the workflow's source gates still reference the retired `container/` layout, which no longer exists on this branch. | New code mints its own version; IMG-2 hard-cut semantics apply to every previously published box image (contract `3` and `5` alike); the publish workflow's gate paths move to `ploinky-box/` in the same change that mints the new version. |
| Q3 | Routing of `p-cli` and `psh` (boxed or local). | BIN-6 requires explicit assignment and tests either way. |
| Q4 | Is the in-box REPL today's `cli/index.js` REPL invoked as-is, or wrapped for prompt/UX? | CMD-3 fixes observable behavior; implementation choice is free within LAY-2 and N5. |
| Q5 | Sequencing of the UDP media consumer (the engine that will eventually listen on `7882`). | PRT-3 requires the reserved mapping from day one regardless of media timing. |
| Q6 | If a nested-podman issue cannot be fixed through image-baked podman configuration (NST-4), what is the escalation? | Stop, document the exact failure, and obtain an owner decision; the additive-layer rule (N5) is not silently broken. |

## 16. Verification obligations for the plan

Every task in the derived plan must map to at least one of these checks,
runnable in this repository's test layout (`tests/unit`, `tests/integration`,
`tests/e2e`, `npm test` → `tests/run-all.sh`).

| ID | Check |
| --- | --- |
| VER-1 | With no workspace, an empty workspace, and a fully enabled workspace, the box create path emits exactly two `-p` mappings: `127.0.0.1:<routerHostPort>:8080/tcp` and `0.0.0.0:7882:7882/udp`; `--port` changes only `<routerHostPort>`; `--publish`, `--expose`, and LAN flags are rejected. |
| VER-2 | Additive-layer check: the box change produces an empty `git diff` over `cli/`, `Agent/`, and `dashboard/`; the only files changed outside `ploinky-box/` are the approved packaging files (`bin/*`, `package.json`). Static import check: no module under `cli/` or `Agent/` imports from `ploinky-box/`; no module under `ploinky-box/` reads workspace, manifest, or profile state on the create path. |
| VER-3 | The existing CLI test surface passes unchanged when driven through `ploinky-local` with no container engine on `PATH`. |
| VER-4 | `ploinky` with an engine present routes each command per section 11; forwarded argv is byte-exact (collision matrix over outer option names appearing as downstream payload). |
| VER-5 | In-box marker test: forwarded commands execute the direct CLI path; invoking `ploinky` inside the box does not recurse. |
| VER-6 | Image contract validation rejects a fixture image failing any single metadata field with a field-specific error; unsupported contract versions instruct destroy-and-recreate and mutate nothing. |
| VER-7 | Pull matrix: create and replacement pull then run by image ID; reuse, stopped-start, `status`, `stop`, and `destroy` perform no registry traffic. |
| VER-8 | Destroy retains all three labelled named volumes with labels intact and removes only the box plus anonymous volumes; recreation reattaches retained state; boot cleanup removes only `ploinky_`-prefixed nested containers while other containers, nested images, and nested volumes survive. |
| VER-9 | Engine matrix: unknown-engine blocking (IDN-5), sole-owner selection, split/foreign fail-closed, podman-first only on an empty identity. |
| VER-10 | Reserved-socket guards: private `8081` has no outer mapping and is unreachable from the outer interface; host `7882/udp` occupancy fails box creation with the collision diagnostic. |
| VER-11 | Router reachability wiring: the box launches core with `PLOINKY_PUBLIC_BIND` and `PLOINKY_PUBLIC_AUTHORITY` set such that a request to host loopback `<routerHostPort>` reaches the in-box router; `ploinky-local` keeps today's loopback default bind. |
| VER-12 | End-to-end smoke: from an empty directory, `ploinky start <agent>` creates the box, starts the router inside it, and a request through host loopback `<routerHostPort>` reaches an agent route through the standard proxy pipeline; `ploinky-local start <agent>` on the host reaches the same route without any box. |
| VER-13 | Multi-architecture release gate: native amd64 and arm64 smoke runs prove the exact image contract, non-root outer execution, functional nested rootless podman, no host engine socket, the exact two publications, loopback router health, in-box direct-CLI invocation, and persistent state across recreation. |
| VER-14 | Mutation-lock matrix: concurrent mutating invocations for one identity serialize; a stale lock is removed only after the recorded owner is proven gone; `status` and `help` run without acquiring the mutation lock. |
| VER-15 | Secret canaries: exact canary values supplied to the box never appear in engine argv, inspected container environment, labels, image metadata, `status` output, dry-run output, or logs. |
| VER-16 | Stop matrix: `ploinky stop` stops in-box core services before the outer box within the bounded timeout; repeated `stop` is a no-op success; the box container and all three named volumes survive `stop`. With a running box, `ploinky status` includes the in-box agents status; after `stop` it reports the stopped box without reconciling. |
