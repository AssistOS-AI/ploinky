# Managed Ploinky Runtime

Ploinky uses one automatically managed outer container to isolate a workspace
and host nested agent containers. The host requires Node.js 20 or newer and
either Podman (preferred) or Docker. Git is optional on the host: it is useful
for cloning and enables automatic source-branch inference. The outer runtime
mounts the local Ploinky checkout read-only at `/opt/ploinky`; it does not rely
on baked Ploinky source or dependencies.

The public entrypoints are `bin/ploinky` and its `p-cli` alias. Host invocations
delegate to the runtime supervisor. Invocations already inside the managed
runtime execute Ploinky core directly, preventing recursive outer startup.

## Quick start

```bash
git clone https://github.com/AssistOS-AI/ploinky ~/work/ploinky
cd ~/work/myProject
~/work/ploinky/bin/ploinky start explorer
open http://127.0.0.1:8080/status
```

On first use, the supervisor reports
`Ploinky dependencies are not installed. Install them now? [y/N]`. A confirmed
install writes to the named dependency volume; a declined or non-interactive
install exits nonzero. Scripts may set `PLOINKY_BOX_INSTALL_DEPS=1`, or an
operator may invoke `/opt/ploinky/bin/ploinky-install-deps` inside the running
outer runtime.

## Public invocation contract

| Invocation | Documented effect |
| --- | --- |
| `ploinky` or `p-cli` | Reconcile/start outer runtime; open Ploinky REPL |
| `ploinky cli` | Reconcile/start outer runtime; open `/bin/bash` as `podman` in `/workspace` |
| `ploinky cli <agent>` | Reconcile/start outer runtime; attach to that agent's manifest CLI |
| `ploinky start ...` | Reconcile/start outer runtime; start the graph behind the fixed boundary |
| `ploinky status` | Inspect outer configuration/publishes/health and running core status without mutation |
| `ploinky stop` | Stop core services, then stop outer runtime; keep volumes |
| `ploinky destroy` | Confirm exact instance and directly remove its outer container; retain all named volumes |
| REPL `status`/`stop`/`destroy` | Core workspace/router/agent scope; outer runtime remains |

Host lifecycle commands and same-named REPL commands intentionally have
different scopes. Exit the REPL before operating on the outer runtime.

## Runtime image configuration and reconciliation

The required multi-architecture release channel is the mutable reference
`docker.io/assistos/ploinky-box:runtime`. Its image must satisfy the exact
source-owned configuration, including an empty image-label set and this exact
marker content at `/etc/ploinky-box`:

```text
assistos/ploinky-box
```

The configuration also requires user `podman`, working directory `/workspace`, the
`/usr/local/bin/ploinky-box-entrypoint` entrypoint, the exact runtime
environment validated by `runtime-contract.mjs`, and no default command or
image-declared volumes. The image is source-free; the selected Ploinky checkout
is mounted read-only at `/opt/ploinky`.

Creating a missing box unconditionally pulls the selected reference, validates
its complete configuration, resolves its local image ID, and creates the box from
that ID rather than from the mutable tag.
Pull failure never falls back to a cached tag. A running compatible box is
reused, and a stopped compatible box is started, without registry traffic.
Consequently, publishing a new `:runtime` manifest does not roll existing
boxes forward. Explicitly destroy the outer box and run an ordinary command to
pull a refreshed image while reusing its retained named state.

Compatibility is exact after canonical inspection. Any current
creation drift, including a changed Router host port, image, mount, device, or
security option, fails before pull or mutation and reports the differences.
Run `ploinky destroy` explicitly and then recreate; the supervisor has no
automatic replacement, backup rename, or rollback transaction.

Every incompatible or malformed Box fails before pulling, volume creation,
restart, upgrade, or replacement. The supervisor does not read it as compatible state or
automatically migrate, clean, relabel, adopt, or replace it. Run `ploinky
destroy` explicitly, then run an ordinary command to recreate the box from
the validated runtime image while retaining all three named volumes. Legacy basename-only boxes
and volumes are not discoverable through the current identity and remain
untouched for manual inspection or removal.

## Instances, engines, and state

Every non-help host command canonicalizes the current directory with `realpath` and
derives exactly one identity:

```text
ploinky-box-<sanitized-directory-basename>-<first-12-hex-of-SHA256(canonical-path)>
```

The readable basename component replaces characters outside
`[a-zA-Z0-9_.-]` with `_`, falls back to `workspace`, and is capped at 48
characters. The path hash distinguishes same-named directories. There is no
public `--name`, `--engine`, or `PLOINKY_BOX_ENGINE` override.

Each instance owns exactly three persistent volumes:

| Suffix | Purpose |
| --- | --- |
| `-workspace` | Ploinky workspace and core state |
| `-containers` | Nested agent image and container storage |
| `-ploinky-deps` | Dependencies mounted at `/opt/ploinky/node_modules` |

Each named volume carries these ownership labels; no absolute path is stored:

| Label | Value |
| --- | --- |
| `io.assistos.ploinky.path-hash` | The identity's 12-character path hash |
| `io.assistos.ploinky.volume-role` | `workspace`, `containers`, or `ploinky-deps`, matching the exact volume name |

Existing exact-named volumes without matching labels are foreign and are never
attached, rewritten, or removed automatically.

Ploinky discovers every Podman or Docker executable on `PATH` and requires
each installed engine to answer before mutation. It inventories the exact box
and all three labelled volumes on every answering engine, then selects the sole
resource owner. A partial valid set remains on that engine and missing roles
are created only on a later permitted create path. Split ownership, duplicate
boxes, foreign volumes, or an engine whose health/inspection result is unknown
fail closed. Only when neither engine owns any identity resource does Ploinky
prefer Podman over Docker. An engine whose executable is not installed cannot
be inventoried; reinstalling it can expose a split on the next command.

`ploinky help` remains host-local and performs no engine discovery. `ploinky
status` reports partial discovery and exits nonzero when ownership is
unresolved; other commands make no change.
`ploinky stop` preserves the box and all three volumes. `ploinky destroy`
confirms and directly removes only the box, using engine volume cleanup to
remove attached anonymous volumes while retaining all explicitly named
volumes. If the box is absent, destroy reports any retained named volumes and
succeeds without prompting or deleting them.

## Fixed ports and graph-independent start

The outer wrapper constructs the complete physical-host boundary before a
workspace exists. Every create and recreate emits exactly:

```text
127.0.0.1:<selected-host-port>:8080/tcp
0.0.0.0:7882:7882/udp
```

`--port` changes only `<selected-host-port>`. Outer `--publish`, `--expose`, and
`--listen-lan` fail before engine discovery. No workspace, graph, profile,
manifest, readiness result, environment value, label, CLI escape hatch, or
persisted state can add a third physical-host mapping. A pre-existing host owner
of UDP `7882` makes creation fail with an actionable owner diagnostic; Ploinky
does not auto-remap it.

After core starts, physical loopback reaches Router public/control `8080`.
Cloudflared inside the box also uses fixed origin `http://127.0.0.1:8080`,
regardless of the selected physical port. Router private `8081` is never an outer
publication. LiveKit is the sole capability-approved in-box owner of UDP
`7882`; the fixed mapping remains idle when LiveKit is absent.

The Box image includes a pinned multi-architecture `cloudflared` binary
supervised by Ploinky core. Complete credential absence is the explicit
`local-only` mode: no connector process and no public HTTP hostname. Cloudflare
mode requires both an existing-tunnel connector token and a separate
least-privilege API token for DNS/ingress reconciliation. Ploinky creates
neither quick tunnels nor tunnels. Partial, invalid, or unauthorized
configuration fails closed in the selected mode, and connector credentials stay
out of argv, ordinary process environment, logs, status, and diagnostics.

Graph ports stay private. Additional HTTP listeners are reached only through
`/base-agent-additional-server/<agent>/<port>/` and the confined runtime relay;
they receive no host port mapping. A bridged `openPorts` claim overlapping
Router TCP `8080`/`8081` or reserved UDP `7882` is rejected. Redis, Postgres,
Egress, OnlyOffice, Umami, health, storage, AgentServer, and other support
listeners may exist inside private namespaces but never appear in outer
PortBindings.

## Source, dependencies, and isolation

`PLOINKY_BOX_SOURCE=/path/to/checkout` can select a different valid Ploinky
checkout for tests or development. The selected source is mounted read-only at
`/opt/ploinky`, while the dependency volume shadows its host `node_modules`.
Core edits in the selected host checkout are therefore visible without an
outer-image rebuild.

The outer runtime runs as `podman` and contains Bash, Node 24, npm/npx, Git,
and functional rootless nested Podman. It receives the devices and security
configuration required by that nested runtime. An explicit `--mount DIR` is a
writable host grant at `/workspace/mounted`; TCP publication is always the fixed
loopback Router mapping and LAN listen mode does not exist.

Ordinary agent images intentionally contain neither Podman nor Docker and are
not granted control of sibling containers. Inside a marked box, every
Ploinky-managed agent, helper, and sidecar container is forced through nested
Podman; Docker fallback and bwrap/Seatbelt host-sandbox selection are disabled
even if older workspace state enabled them. Outside a box, existing runtime
selection behavior remains unchanged.

Every Ploinky-owned nested container carries the exact label
`io.assistos.ploinky.managed=1`. Box boot enumerates that exact key/value and
retires only non-running records whose immutable registry ownership is exact,
including complete predecessor lifecycle pairs, or legacy helper records whose
only Ploinky label is the historical managed marker. Running, paused,
transitional, partially labelled, ambiguous, and foreign records fail the Box
self-check without removal. Unlabelled containers, other values or near-name
labels, nested images, nested named volumes, and retained workspace data remain
untouched. Enumeration failure also fails the self-check. Manual containers are
outside Ploinky lifecycle ownership and are not promised automatic restart or
repair.

Before Podman opens the retained graph root, the entrypoint removes only its
transient `/tmp/storage-run-<uid>` and `/tmp/podman-run-<uid>` process/lock
state from the outer container filesystem. These paths are not the named
nested-storage volume; container records, images, and nested named volumes stay
retained. Failure to clear stale run state aborts boot.

Box boot requires rootless Podman 5.4 or newer, the Netavark network
backend, and an operational `pasta` executable. Any failed prerequisite aborts
self-check; managed networking has no `slirp4netns` fallback. The image is
built from an immutable `quay.io/podman/stable` index digest that contains both
the native amd64 and arm64 Podman 5.8.2 manifests.

Managed `default` mode creates one private `isolate=true` bridge for the
effective agent instance. Managed `bridge` mode attaches the container to the
declared logical bridges, exactly one of which is primary. Peers on the same
bridge can communicate by their derived alias, different managed bridges cannot
route directly by IP, and outbound NAT remains available. `host` uses the
outer-box namespace; `none` has no network and cannot use a router endpoint or
network-dependent readiness.

Every managed `default` or `bridge` container is created with exactly
`--hosts-file=none --add-host
host.containers.internal:host-gateway`. Its router endpoint is injected as
`PLOINKY_ROUTER_HOST=host.containers.internal`, the validated
`PLOINKY_ROUTER_PORT`, and the matching `PLOINKY_ROUTER_URL`. Consumers also
receive `PLOINKY_INTERNAL_ROUTER_URL` and the read-only non-secret snapshot named
by `PLOINKY_EDGE_TOPOLOGY_FILE` before start. Capability-approved `host` mode
uses box loopback; `none` receives no Router endpoint. Router owns public/control
TCP `8080`, managed-private `8081`, and detailed health on an unmounted
supervisor Unix socket.

The mounted topology distinguishes three values: the immutable route-and-policy
authorization generation revalidated before dial, a content-derived
configuration generation for stable non-secret consumer inputs, and a monotonic
publication generation for readiness/publication state. Its browser projection
is authenticated and `no-store`, returns only one active locator plus
configuration/publication ids, and reveals no authorization id or inventory.
Long-term TURN material stays in Ploinky core; the private broker returns only
rate-limited short-lived credentials and expiry to exact current-generation
consumers.

Network reachability does not inherit router authentication. Private service
calls require compiled authenticated policy plus an exact current-instance and
current-generation assertion; TCP admin/control still requires a real admin
session and mutations require Origin/CSRF. Routed MCP
calls continue to enforce the router's JWT issuer/audience, policy, request
binding, expiry, and replay checks. The historical `ploinky-router` network
alias is no longer reserved; `ploinky-router` remains the authentication
issuer/audience identity where specified.

## Status, shutdown, and destruction

`ploinky status` is strictly read-only. It reports missing, stopped, compatible,
unsupported, and unhealthy outer state, normalized exact publications, the observed image
contract, and core status only when the outer runtime is already running. It
does not pull, create, start, stop, remove, or reconcile.

`ploinky stop` skips reconciliation. It attempts core shutdown first and then
stops the outer runtime even when core shutdown fails, reporting both phases.
Repeated stop is an idempotent success. `ploinky destroy` also skips
reconciliation, directly removes the selected outer container and its attached
anonymous volumes, and retains the three managed named volumes.

Commands entered in the Ploinky REPL stay at core workspace/router/agent scope.
REPL `stop` leaves outer runtime state and volumes in place; REPL `destroy`
clears workspace agent runtimes and regenerated core dependency caches while
the outer runtime remains alive.

For a deliberate complete reset, first destroy the box, then remove the named
volumes from their owning engine after accepting data loss:

```bash
ENGINE=podman # or docker, as reported by status
INSTANCE=ploinky-box-WORKSPACE-PATHHASH
$ENGINE volume rm "$INSTANCE-workspace" "$INSTANCE-containers" "$INSTANCE-ploinky-deps"
```

A failed first create may leave only labelled instance volumes. Remove an exact
volume with the same engine command only when its retained state is not needed.
If boot cleanup repeatedly fails because nested storage is corrupt, inspect and
back up `$INSTANCE-containers`, remove the outer box, and
remove only that volume when its cached images, container records, and nested
volumes may be lost; ordinary destroy/recreate deliberately preserves it and
can repeat the failure.

The path-hashed supervisor does not target a legacy basename-only box. To
release its ports while preserving its volumes, identify its owning engine and
remove that exact old container directly without a volume-cleanup flag:

```bash
ENGINE=podman # or docker
LEGACY_INSTANCE=ploinky-box-OLDNAME
$ENGINE rm -f "$LEGACY_INSTANCE"
```

For a legacy direct/core cutover, invoke the old checkout's core entry
directly before installing or invoking the new release:

```sh
node cli/index.js destroy
node cli/index.js network prune
```

Do not use the public `ploinky` wrapper for this step: outside a box it controls
the outer runtime, not the old core workspace. Inspect and resolve any foreign
resources rather than adopting them. After confirming no container references
them, remove only the exact stale `.ploinky/run/router.sock` and
`.ploinky/run/managed-hosts` paths and the unreferenced cached image
`docker.io/assistos/ploinky-network-gateway:1@sha256:68c47ce93d16ea1a2d03944f7b50ce82e6f2f9a26b183d2c9c7fbabcc828fb7e`.
Before activation, revoke the retired publication connector/API tokens and
delete its plaintext retained state. The current runtime has no migration or cleanup
reader for it. Do not use a broad container, image, volume, or network prune.

## Smoke and release ordering

`node container/smoke-runtime.mjs` is the real engine-backed public-entrypoint
smoke. After initial create and explicit recreate it normalizes exhaustive
`HostConfig.PortBindings` and `podman port` output and requires exactly loopback
selected-port to `8080/tcp` plus wildcard `7882:7882/udp`. It also proves
loopback Router reachability, LAN refusal, absence of private `8081` and all
forbidden third mappings, actionable UDP-owner conflict, and profile-specific
in-box `ss -H -lntup` ownership. The script accepts
`SMOKE_IMAGE` and `SMOKE_PORT` overrides; engine selection remains automatic.

The publication workflow moves the mutable `:runtime` channel only after
native amd64 and arm64 candidates both pass contract, integrated pinned
cloudflared, exact-port, network-isolation, router-restart, and nested-Podman
gates. Each native job
emits its Podman, Netavark, and `pasta` evidence before release promotion.
The supervisor consults that channel only for create and keeps
existing boxes pinned to their inspected IDs.

The principal functional release gate runs the existing Explorer two-account
WebMeet smoke against a freshly built Box:

```bash
cd ../AssistOSExplorer/tests/smoke
SMOKE_BASE_URL=http://127.0.0.1:8080 \
SMOKE_WEBMEET_MEDIA=1 \
SMOKE_WEBMEET_SCREEN=1 \
SMOKE_TEST_TIMEOUT_MS=240000 \
npm test -- --headed --project=chromium specs/30-webmeet-room-chat.spec.mjs
```

With screen mode enabled, missing or identical accounts are failures, not
skips. The test must use two isolated browser contexts and prove screen-share
publication, remote screen-track attachment/readiness, and screen-specific RTP
growth in both directions through real Router signaling, LiveKit, and the box
UDP mapping. The runner uses a deterministic virtual display when the host has
no usable display and retains redacted trace/video/screenshot, selected ICE
pair, publication, and RTP diagnostics on failure.

A separate infrastructure gate runs on native Linux amd64 and arm64 with two
browsers on distinct external networks. It must select the configured public
IPv4 at UDP `7882`, never TCP `7881` or a discovered/private alternative, then
repeat with direct SFU UDP blocked to prove external TURN/UDP and with a
TCP/TLS-only network to prove external TURN/TLS. Absent architectures, distinct
networks, test accounts, Cloudflare resources, or TURN credentials block release
rather than weakening or skipping these lanes.
