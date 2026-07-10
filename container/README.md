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
| `ploinky start ...` | Reconcile/start outer runtime; preserve graph publishes and router readiness |
| `ploinky status` | Inspect outer contract/publishes/health and running core status without mutation |
| `ploinky stop` | Stop core services, then stop outer runtime; keep volumes |
| `ploinky destroy` | Confirm exact instance and remove its container plus three volumes |
| REPL `status`/`stop`/`destroy` | Core workspace/router/agent scope; outer runtime remains |

Host lifecycle commands and same-named REPL commands intentionally have
different scopes. Exit the REPL before operating on the outer runtime.

## Runtime image contract and reconciliation

The required outer image is the immutable multi-architecture reference
`docker.io/assistos/ploinky-box:podman-node24-runtime-v1`. It must carry the
exact label:

```text
io.assistos.ploinky.runtime-contract=1
```

Ordinary commands create a missing runtime, start a stopped compatible runtime,
or reuse a running compatible runtime. Before replacing an incompatible
runtime, the supervisor obtains and validates the replacement image, captures
the old image and normalized creation configuration, gracefully stops core
services, and replaces only the outer container. A replacement creation or
health failure reconstructs the prior container from the captured image and
configuration. Workspace, nested-container-storage, and dependency volumes are
never removed by reconciliation.

When creation flags are omitted, reconciliation preserves the inspected image,
router publish, extra publishes, source and optional host mounts, listening
scope, user, devices, security settings, environment, and named-volume
attachments. Explicit `--port`, `--publish`/`--expose`, `--image`, `--mount`,
or `--listen-lan` values intentionally change their corresponding desired
settings.

Only the known legacy official references
`docker.io/assistos/ploinky-box:podman-node24` and
`assistos/ploinky-box:podman-node24` migrate to the required immutable image
when `--image` is omitted. A different incompatible custom reference stays
selected, is force-pulled and contract-validated before the current runtime is
stopped, and fails without mutation if the pulled image still lacks contract
1. A compatible custom image is preserved when the flag is omitted.

## Instances and state

Every host command resolves one instance:

| Selector | Instance |
| --- | --- |
| omitted | `ploinky-box-<sanitized-current-directory-basename>` |
| `--name X` | `ploinky-box-X` |

Inferred suffixes replace characters outside `[a-zA-Z0-9_.-]` with `_`, retain
case, and are capped at 63 characters. A basename with no ASCII letter or digit
cannot be inferred. Two directories with the same basename target the same
instance unless `--name` disambiguates them.

Each instance owns exactly three persistent volumes:

| Suffix | Purpose |
| --- | --- |
| `-workspace` | Ploinky workspace and core state |
| `-containers` | Nested agent image and container storage |
| `-ploinky-deps` | Dependencies mounted at `/opt/ploinky/node_modules` |

`ploinky stop` preserves all three. `ploinky destroy` names the exact selected
container and volumes in its confirmation and removes them only after an
affirmative answer.

## Ports and graph-aware start

The selected host router port maps to container port 8080. Core always receives
`ploinky start <agent> 8080`; after that command succeeds, the supervisor probes
`http://127.0.0.1:<selected-host-port>/status`. A failed core start does not run
the router probe.

### Graph-driven Explorer publishes

For Explorer starts, the supervisor walks the enabled manifest graph and reads
the active profile's `openPorts`. A child that lacks the workspace profile uses
its `default` profile; an explicit edge-local profile must exist. The accepted
Explorer spellings `explorer`, `AchillesIDE/explorer`, and
`AssistOSExplorer/explorer` select the same graph. Branch flags are forwarded
unchanged, and an inferred source branch is appended exactly once only when no
explicit branch flag is present.

Generated TCP and UDP examples include `8081:8081`, `3478:3478`,
`3478:3478/udp`, `7882-7892:7882-7892/udp`, and
`20000-20010:20000-20010/udp`. Internal databases, MCP/control surfaces,
private health and signaling endpoints, identity providers, LLM APIs, direct
document-server ports, and router-mediated HTTP services do not belong in
default `openPorts`. LiveKit/TURN media traffic is a reviewed exception because
nginx cannot proxy it.

Explicit publish values remain byte-for-byte engine syntax in their original
order. Ploinky canonicalizes only the terminal target interval and protocol for
conflict detection. An explicit `0.0.0.0:3478:3478/udp`, for example,
suppresses the overlapping generated UDP claim while leaving the TCP claim.
Generated wildcard/specific-bind overlaps and other same-protocol interval
conflicts fail before runtime mutation.

## Source, dependencies, and isolation

`PLOINKY_BOX_SOURCE=/path/to/checkout` can select a different valid Ploinky
checkout for tests or development. The selected source is mounted read-only at
`/opt/ploinky`, while the dependency volume shadows its host `node_modules`.
Core edits in the selected host checkout are therefore visible without an
outer-image rebuild.

The outer runtime runs as `podman` and contains Bash, Node 24, npm/npx, Git,
and functional rootless nested Podman. It receives the devices and security
configuration required by that nested runtime. An explicit `--mount DIR` is a
writable host grant at `/workspace/mounted`; published ports are loopback-only
unless `--listen-lan` is explicit.

Ordinary agent images intentionally contain neither Podman nor Docker and are
not granted control of sibling containers. Agent isolation continues to come
from manifest-selected container or host-sandbox policy; the privileged nested
runtime belongs only to the outer supervisor boundary.

## Status, shutdown, and destruction

`ploinky status` is strictly read-only. It reports missing, stopped, compatible,
outdated, and unhealthy outer state, configured publishes, the observed image
contract, and core status only when the outer runtime is already running. It
does not pull, create, start, stop, remove, or reconcile.

`ploinky stop` skips reconciliation. It attempts core shutdown first and then
stops the outer runtime even when core shutdown fails, reporting both phases.
Repeated stop is an idempotent success. `ploinky destroy` also skips
reconciliation and is the only supervisor path that removes the three named
volumes.

Commands entered in the Ploinky REPL stay at core workspace/router/agent scope.
REPL `stop` leaves outer runtime state and volumes in place; REPL `destroy`
clears workspace agent runtimes and regenerated core dependency caches while
the outer runtime remains alive.

## Smoke and release ordering

`node container/smoke-runtime.mjs` is the real engine-backed public-entrypoint
smoke. It checks that help creates nothing, an ordinary command starts the
runtime, nested `podman version` and `podman info` work, combined status works,
stop is idempotent, and confirmed destruction removes the selected container
and its three volumes. The script accepts only `SMOKE_IMAGE`, `SMOKE_ENGINE`,
and `SMOKE_PORT` overrides.

Release ordering is manual: build and publish the immutable runtime reference,
verify its contract label and nested Podman behavior independently, and only
then change Ploinky to require that exact reference. The supervisor does not
poll or adopt a moving image tag during ordinary commands.
