# Managed Ploinky Runtime

Ploinky uses one automatically managed outer container to isolate a workspace
and host nested agent containers. The host requires Node.js 20 or newer and
rootless Podman on Linux or macOS Podman Machine. Git is optional on the host: it is useful
for cloning and enables automatic source-branch inference. The outer runtime
mounts the local Ploinky checkout read-only at `/opt/ploinky`; it does not rely
on baked Ploinky source or dependencies.

The public entrypoints are `bin/ploinky` and its `p-cli` alias. Host invocations
delegate to the runtime supervisor. Invocations already inside the managed
runtime execute Ploinky core directly, preventing recursive outer startup.

## Quick start

```bash
git clone https://github.com/AssistOS-AI/ploinky ~/work/file-parser/ploinky
cd ~/work/myProject
~/work/file-parser/ploinky/bin/ploinky start explorer
open http://127.0.0.1:8080/status
```

On first use, the supervisor reports
`Ploinky dependencies are not installed. Install them now? [y/N]`. A confirmed
install writes to the workspace-backed dependency cache; a declined or non-interactive
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
| `ploinky stop` | Stop core services, then stop outer runtime; retain the Box and `.ploinky/box` cache data |
| `ploinky destroy` | Stop nested agents and remove the exact outer container; retain the workspace and `.ploinky/box` cache data |
| `ploinky destroy --delete-cache` | Remove the exact outer container, then delete only `.ploinky/box/dependencies` and `.ploinky/box/images` |
| REPL `status`/`stop`/`destroy` | Core workspace/router/agent scope; outer runtime remains |

Host lifecycle commands and same-named REPL commands intentionally have
different scopes. Exit the REPL before operating on the outer runtime.

## Runtime image configuration and reconciliation

The default multi-architecture release channel is the mutable reference
`docker.io/assistos/ploinky-box:latest`. `PLOINKY_BOX_IMAGE` selects a different
image reference when needed. The selected image must satisfy the exact
source-owned configuration, including an empty image-label set and this exact
marker content at `/etc/ploinky-box`:

```text
assistos/ploinky-box
```

The configuration also requires user `podman`, working directory `/workspace`, the
`/usr/local/bin/ploinky-box-entrypoint` entrypoint, the exact runtime
environment validated by `ploinky-box/contract/image.mjs`, and no default
command or image-declared volumes. The image is source-free; the selected
Ploinky checkout is mounted read-only at `/opt/ploinky`.

Creating a missing box unconditionally pulls the selected reference, validates
its complete configuration, resolves its local image ID, and creates the box from
that ID rather than from the mutable tag.
Pull failure never falls back to a cached tag. A running compatible box is
reused, and a stopped compatible box is started, without registry traffic.
Consequently, publishing a new `:latest` manifest does not roll existing
boxes forward. Explicitly destroy the outer box and run an ordinary command to
pull a refreshed image while reusing its retained workspace-backed caches.

Compatibility is exact after canonical inspection. Any current
creation drift, including a changed Router host port, image, durable bind,
`/tmp` tmpfs, device, or security option, fails before pull or mutation and
reports the differences.
Run `ploinky destroy` explicitly and then recreate; the supervisor has no
automatic replacement, backup rename, or rollback transaction.

Every incompatible or malformed Box fails before pulling, cache preparation,
restart, upgrade, or replacement. The supervisor does not read it as compatible state or
automatically migrate, clean, relabel, adopt, or replace it. Run `ploinky
destroy` explicitly, then run an ordinary command to recreate the box from
the validated runtime image while retaining both workspace-backed cache
directories. Legacy basename-only boxes and volumes are not discoverable
through the current identity and remain untouched for manual inspection or
removal.

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

Each instance has four durable host binds and one transient `/tmp` tmpfs:

| Host source or type | Box destination | Mode and lifetime |
| --- | --- | --- |
| Ploinky repository root | `/opt/ploinky` | Read-only durable bind |
| Canonical workspace root | `/workspace` | Read-write durable bind |
| `<workspace>/.ploinky/box/dependencies` | `/opt/ploinky/node_modules` | Read-write durable bind |
| `<workspace>/.ploinky/box/images` | `/home/podman/.local/share/ploinky-images` | Read-write durable bind |
| tmpfs | `/tmp` | `rw,exec,nosuid,nodev,mode=1777,notmpcopyup`; recreated empty on every outer boot |

Nested container records, writable layers, networks, and inner Podman named
volumes are deliberately not persisted. They live on the outer container's
writable layer under `/home/podman/.local/share/containers/storage` and are
discarded when the outer container is removed, so persistent agent data must use
explicit `/workspace` binds.

The outer Box owns no engine volume. Retired labelled volumes are inert and are
never attached, rewritten, or removed automatically. Ploinky inventories the
exact outer container in the supported rootless Podman engine and also rejects
an exact-name conflict in Docker. Duplicate containers, foreign labels, or an
engine whose health or inspection result is unknown fail closed.

`ploinky help` remains host-local and performs no engine discovery. `ploinky
status` reports partial discovery and exits nonzero when ownership is
unresolved; other commands make no change.
`ploinky stop` preserves the outer Box and both cache directories. Restarting a
compatible stopped Box captures its cumulative logs before start, reuses the
same immutable container ID without pulling, and accepts only a fresh exact
`PLOINKY_BOX_READY` line while inspection proves the container is running.
`ploinky destroy` removes only the outer container and retains the workspace
and cache directories. `ploinky destroy --delete-cache` additionally deletes
exactly the dependency and image cache directories after container removal.

## Fixed targets and graph-independent start

The outer wrapper constructs the complete physical-host boundary before a
workspace exists. Every create and recreate emits exactly:

```text
127.0.0.1:<selected-host-port>:8080/tcp
0.0.0.0:<selected-media-host-port>:7882/udp
```

`--port` changes only `<selected-host-port>` and `--udp-port` changes only
`<selected-media-host-port>`; they default to `8080` and `7882`, respectively.
The in-Box Router and LiveKit targets remain fixed. Outer `--publish`, `--expose`, and
`--listen-lan` fail before engine discovery. No workspace, graph, profile,
manifest, readiness result, environment value, label, CLI escape hatch, or
persisted state can add a third physical-host mapping. A pre-existing owner of
the selected UDP host port makes creation fail with an actionable diagnostic;
Ploinky never auto-remaps it.

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
`/opt/ploinky`, while the dependency-cache bind shadows its host `node_modules`.
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
or superseded predecessors whose name and stable labels are exact and whose
immutable ID and complete lifecycle pair were both replaced in the registry.
It also retires legacy helper records whose only Ploinky label is the
historical managed marker. Running, paused,
transitional, partially labelled, ambiguous, and foreign records fail the Box
self-check without removal. Unlabelled containers, other values or near-name
labels, nested images, nested named volumes, and retained workspace data remain
untouched. Enumeration failure also fails the self-check. Manual containers are
outside Ploinky lifecycle ownership and are not promised automatic restart or
repair.

Before the first inner Podman call, the entrypoint resets transient
`/tmp/storage-run-<uid>` and `/tmp/podman-run-<uid>` state and writes the exact
user `storage.conf`. The full `/tmp` parent is a fresh outer tmpfs on each boot;
the child cleanup protects repeated preparation during one boot. Downloaded
image content uses the workspace-backed
`/home/podman/.local/share/ploinky-images` cache. The graphroot remains on the
outer container writable layer, so nested container records, writable layers,
networks, and inner named volumes survive stop/start but are discarded when the
outer container is removed. Failure to configure or validate this separation
aborts boot.

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

`ploinky status` is strictly read-only. It validates the outer state without
mutation. Missing, stopped, unsupported, and unhealthy states use the
dependency-free Box summary; when the outer runtime is compatible, initialized,
and already running, the command prints the same detailed SSO, Router,
repository, and per-agent runtime view as the core status command. The
status-only core entrypoint bypasses workspace initialization and bootstrap. It
does not pull, create, start, stop, remove, refresh, or reconcile.

`ploinky stop` skips reconciliation. It attempts core shutdown first and then
stops the outer runtime even when core shutdown fails, reporting both phases.
Repeated stop is an idempotent success. `ploinky destroy` also skips
reconciliation, stops nested agents when the Box is running, and then removes
the selected outer container while retaining the workspace and both
workspace-backed cache directories. The explicit `--delete-cache` form deletes
only those two cache directories after removing the outer container.

Commands entered in the Ploinky REPL stay at core workspace/router/agent scope.
REPL `stop` leaves outer runtime state and cache data in place; REPL `destroy`
clears workspace agent runtimes and regenerated core dependency caches while
the outer runtime remains alive.

For a deliberate complete reset after accepting data loss, run:

```bash
ploinky destroy --delete-cache
```

If boot cleanup fails because nested storage is corrupt, destroy and recreate
the outer box: nested container records and inner volumes live on its writable
layer and are discarded with it, so the failure cannot repeat across a
recreation. The workspace-backed dependency and image caches survive ordinary
destroy, and `--delete-cache` discards those two directories too.

The path-hashed supervisor does not target a legacy basename-only box. To
release its ports, identify its owning engine and remove that exact old
container directly without a volume-cleanup flag:

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

The real engine-backed candidate gates are
`tests/integration/ploinkyBoxNative.test.mjs` and
`tests/e2e/ploinkyBox/publicCli.test.mjs`. With
`PLOINKY_BOX_REQUIRE_PODMAN=1` and one immutable
`PLOINKY_BOX_CANDIDATE_DIGEST`, they exercise the public entrypoints, exact
publications, rootless nested Podman, running destroy, recreation, disposable
nested state, and durable image and dependency caches.

`.github/workflows/verify-ploinky-box-candidate.yml` is the mandatory reusable
release gate. It accepts only an immutable Box digest and exact 40-character
revisions for the canonical Explorer graph, then runs both complete suites on
dedicated rootless Podman runners labelled `macOS`, `ARM64`, and
`ploinky-box-candidate`, or `Linux`, `X64`, and `ploinky-box-candidate`.
Repositories in that graph are checked out with the read-only
`PLOINKY_CANDIDATE_REPOSITORY_TOKEN` secret. Each suite must produce one
redacted JSON evidence file proving the candidate digest, rootless runtime,
same outer container ID across stop/start, one executable `/tmp` tmpfs, and no
pull, create, or remove during restart. Missing runners, inputs, evidence, or a
failing canonical graph block the release job; they are never downgraded to a
warning or a reduced smoke target.

Publication may move the mutable `:latest` channel only after native amd64 and
arm64 candidates pass the contract and runtime gates. Each native job emits its
Podman, Netavark, and `pasta` evidence before release promotion. The supervisor
consults that channel only for create and keeps existing boxes pinned to their
inspected IDs.

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
