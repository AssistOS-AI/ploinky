# Boxed Ploinky Runtime

Run the entire Ploinky runtime isolated inside one rootless-podman container.
The host needs podman (preferred) or docker, Node >= 20 to run the wrapper,
and a local ploinky checkout: the box does not bake Ploinky core -- the wrapper
bind-mounts your checkout read-only at `/opt/ploinky` inside the box. Agents
run as nested containers *inside* the box; nothing they do touches the host
filesystem.

`ploinky` is the preferred public entrypoint when using this checkout. It runs
normal Ploinky commands through the boxed runtime by default, with `ploinky
destroy` reserved for host-side box teardown. `ploinky-box` remains as a
diagnostic command for the wrapper itself.

## Quick start

    git clone https://github.com/AssistOS-AI/ploinky ~/work/ploinky
    cd ~/work/myProject
    ~/work/ploinky/bin/ploinky start webtty   # box 'ploinky-box-myProject': up + start webtty + router probe
    open http://127.0.0.1:8080/status

On the first run the box has no Ploinky dependencies yet; the wrapper asks
`Ploinky dependencies are not installed. Install them now? [y/N]` and installs
them into the box's dependency volume when you confirm. Decline (or run
without a terminal) and ploinky exits non-zero with a warning until you
install. Set `PLOINKY_BOX_INSTALL_DEPS=1` to opt into automatic install in
scripts, or run the installer yourself:
`<engine> exec -it <instance> /opt/ploinky/bin/ploinky-install-deps`.

## Instances

Every command targets one instance:

| Selector | Instance (container / volume prefix) |
| --- | --- |
| *(nothing)* | Inferred from the current directory basename: `ploinky-box-<basename>` |
| `--name X` | `ploinky-box-X` (explicit, wins over inference) |

Inferred names are sanitized (`[^a-zA-Z0-9_.-]` becomes `_`, capped at 63
chars, case preserved): `~/work/testExplorerFresh` →
`ploinky-box-testExplorerFresh` with volumes
`ploinky-box-testExplorerFresh-workspace` / `-containers` / `-ploinky-deps`.
Directories whose
basename has no ASCII letters or digits at all cannot be inferred — pass
`--name`. Two directories with the same basename map to the SAME instance
(inference reads only the basename); disambiguate with `--name`. Explicit
`--name` values are passed to the engine unsanitized. Every command resolves
the instance the same way, including `destroy` — the confirmation prompt names
the exact container and volumes it is about to remove, so read it.

Older wrapper versions created a bare instance named `ploinky-box`. The new
wrapper no longer addresses it. If you intentionally want to delete that old
box and its workspace/image volumes, first copy out anything you need, then run
the matching engine command, for example:
`<engine> rm -f ploinky-box && <engine> volume rm ploinky-box-workspace ploinky-box-containers`.

## The one rule about ports

The wrapper publishes host port `--port N` (default 8080) to **container port
8080**. Inside the box, always start the router on 8080:
`start <agent> 8080`. `ploinky-box start <agent> [port]` obeys the rule for you:
`[port]` (or `--port`) picks the HOST side, the router inside is always started
on 8080.

### Graph-driven Explorer publishes

When the public wrapper starts Explorer, the outer box derives additional `-p`
flags from the enabled Explorer graph instead of carrying an Explorer-specific
port list. `explorer`, `AchillesIDE/explorer`, and
`AssistOSExplorer/explorer` select the same graph.

Each enabled agent's effective profile `openPorts` entries have two roles: they
declare what that agent exposes into the box, and they make the corresponding
box-side sockets eligible for publication through the outer box. A workspace
profile applies across the graph; when a manifest does not define that profile,
the planner uses that manifest's `default` profile. An explicit profile on an
individual `enable` edge must exist on the child manifest or planning fails.

`openPorts` is intentionally the only manifest field for default outer box
publishes. Internal-only services, Redis, databases, MCP/control and application
surfaces, private health and signaling listeners, identity providers, LLM APIs,
document-server ports, and router-mediated HTTP services must not be listed in
default `openPorts`.

Generated graph claims are checked before box creation. Two claims may not
overlap on the same box-side port or range and protocol, even when they declare
different bind addresses; a failure identifies both owning agents, profiles,
aliases, binds, and original declarations. An exact duplicate within the same
effective graph node is emitted once.

User-supplied `--publish` and `--expose` values remain authoritative engine
syntax: the wrapper preserves each value byte-for-byte and in order. It parses
only the terminal container port or range plus protocol into a canonical target
for generated-claim suppression. When an explicit target overlaps a generated
target for the same protocol, the whole generated claim is omitted; the
explicit value is neither rewritten nor split.

Web Publishing owns the default HTTP/WebSocket entrypoint through nginx on
`127.0.0.1:8081:8081`. HTTP and WebSocket application surfaces such as router
paths, OnlyOffice, WebTTY, and LiveKit signaling should flow through that
consolidation layer. Nginx always binds port 8081 inside Web Publishing and a
pristine zero-route configuration returns 404 through its default server.
Deployment probes must use the generated external `ONLYOFFICE_PUBLIC_URL` and
`WEBMEET_PUBLIC_LIVEKIT_URL` values, not direct host assumptions for private
ports 8082 or 17000.

LiveKit/TURN media-plane ports cannot be proxied by nginx and remain direct
`openPorts` when the LiveKit server agent is enabled.

Other in-box ports are unreachable from the host unless you publish them when
creating the box. Use `--publish HOST:BOX` for a specific port, or use its alias
`--expose HOST:BOX`; repeat either flag for more ports. Existing boxes keep the
publish set they were created with. In particular, host port 8081 cannot be
assumed when an earlier command created the box before a graph-aware Explorer
start. Changing `openPorts` or `--profile` affects the desired run arguments for
a newly created box only. Existing boxes are not reconciled; recreate the box to
apply changed outer port mappings.

## Host-mounted core and the dependency volume

The box mounts your ploinky checkout read-only at `/opt/ploinky` (resolved
from the wrapper's own location; override with `PLOINKY_BOX_SOURCE=/path`).
Core code edits on the host are visible inside the running box immediately --
no image rebuild. Because the source is read-only, npm dependencies live in a
writable named volume `<instance>-ploinky-deps` mounted at
`/opt/ploinky/node_modules`; host-side `node_modules` content is shadowed and
never used in-box. `stop`/`update` keep the volume; `destroy` removes it.

On hosts `ploinky` always drives the box, and inside the box image the same
`ploinky` script is the direct CLI. The box image carries the marker file
`/etc/ploinky-box`; the wrapper also bind-mounts the source-controlled
`container/ploinky-box-marker` there so host-mounted source runs have the same
runtime signal. For CLI development on the host without the box, run
`node cli/index.js` from the checkout.

## Public `ploinky` Command

Bare `ploinky ...` commands keep their existing Ploinky meaning and execute
inside the box, except `destroy`, which removes the selected outer box:

```bash
ploinky start explorer
ploinky start AchillesIDE/explorer --profile dev
ploinky status
ploinky stop
ploinky logs
ploinky install ...
```

```bash
ploinky destroy
```

When the host Ploinky checkout is on a non-main branch, `ploinky start ...`
forwards that branch to the in-box CLI unless you pass explicit branch flags.
This keeps branch-scoped stacks reproducible from the ordinary command:
`ploinky start explorer` on branch `ploinky-box` behaves like an explicit
`--branch ploinky-box`. Set `PLOINKY_BOX_AUTO_BRANCH=0` to disable inference, or
`PLOINKY_BOX_BRANCH=<branch>` to force a branch for wrapper tests and scripted
runs.

`ploinky start <agent> [port] [--profile <name>]` is the public profile boundary.
The boxed entrypoint accepts `--profile <name>` or `--profile=<name>` anywhere
in the start arguments and forwards the selected profile into the box. If it is
omitted, the public boxed entrypoint selects and forwards `default`; a direct
in-box `ploinky start` with no profile may instead retain the profile already
stored in `.ploinky/profile`.

Outer box lifecycle commands can also use the explicit `box` namespace:

```bash
ploinky box status
ploinky box stop
ploinky box update
ploinky box destroy
```

`ploinky destroy` and `ploinky box destroy` both remove the outer container and
the three named volumes for the selected instance. They do not start the box and
do not propagate an in-box `ploinky destroy`.

Box selector flags such as `--name` and `--port` can appear before or after a
public command. Put `--dry-run` before the command for wrapper dry-run; after
the command it is forwarded to the in-box Ploinky CLI.

## `ploinky-box` Diagnostic Commands

These commands remain available for direct wrapper diagnostics and standalone
downloads; public users should prefer `ploinky ...` and `ploinky box ...`.
This is the direct wrapper command reference.

| Command | Effect |
| --- | --- |
| `up` | Create/start the box; pulls the image on first use |
| `start <agent> [port]` | `up` + in-box `ploinky start <agent> 8080` + router probe; `[port]` = host port (default 8080). On an existing box the original port mapping wins (recreate via `update` to change it) |
| `cli` | Interactive `p-cli` console inside the box |
| `run <args>` | One-shot ploinky command (`run start webtty 8080`, `run list agents`) |
| `cp A B` | Copy in/out; container side uses the `box:` prefix |
| `status` | Container state + router probe |
| `logs` | Recent `.ploinky` logs |
| `stop` | Stop the box; workspace and agent images survive |
| `update` | Pull newer image, recreate the box (pass the same flags as `up`) |
| `destroy` | Remove the box AND its volumes (asks first) |

Flags: `--name X` (explicit instance; default: inferred from the current
directory basename), `--port N`, `--publish SPEC`, `--expose SPEC`,
`--image I`, `--mount DIR`, `--listen-lan`,
`--engine podman|docker`, `--dry-run`.
`PLOINKY_BOX_ENGINE` overrides engine detection.

## Isolation contract

The outer box runs with `--privileged` so nested Podman can create and attach
manifest-declared named networks for private agent-to-agent service aliases. It
still runs as the `podman` user inside the box and keeps host crossings explicit:
published ports (loopback-only unless `--listen-lan`), explicit `cp`, and the
opt-in `--mount DIR` (bind-mounted read-write at `/workspace/mounted` — you are
piercing the sandbox). The wrapper also passes `/dev/fuse`, `/dev/net/tun`,
`seccomp=unconfined`, and `label=disable` whenever the engine reports SELinux
enabled.
The ploinky source mount is read-only and is not a crossing: nothing in the box
can write through it. State lives in three named volumes per instance:
`<instance>-workspace` (the Ploinky workspace), `<instance>-containers` (nested
agent images), and `<instance>-ploinky-deps` (Ploinky's npm dependencies).
`stop`/`update` keep them; only `destroy` deletes them.

Agent containers inside the box are disposable: every box start wipes stale
inner containers (an unclean stop leaves inner podman with false "running"
state) and `run start` recreates them from `.ploinky` state. `stop`/`update`
first attempt a graceful in-box `ploinky stop`.

## Limitations

- Ploinky core is supplied by the host checkout (mounted read-only), so
  in-box `ploinky update` cannot modify core code either -- update the
  checkout on the host with git; running boxes see edits immediately.
  `ploinky box update` still refreshes the runtime image itself.
- On macOS, the ploinky checkout (like `--mount` directories) must live under
  the podman-machine / Docker Desktop file share (default: your home
  directory).
- `additionalServerPort` in `container` mode relies on inspect-derived
  container IPs, which rootless podman does not expose; use `host` mode for
  such agents. Smoke result 2026-07-03 (macOS 26.5.2, podman machine 5.8.2):
  WebSocket/additional-port check skipped because `SMOKE_WS_AGENT` was not set.
- Agents with `lite-sandbox: true` (bwrap/seatbelt) are unsupported inside
  the box in v1.
- Linux-host smoke not yet executed (verified on macOS only as of 2026-07-03).
- Windows hosts are unsupported.
- The wrapper itself needs Node >= 20 on the host (`ploinky-box` is a thin
  shim around `ploinky-box.mjs`; keep the two files side by side). The box
  and the agents inside it still need nothing but the container engine.

Smoke verified on macOS 26.5.2 / podman machine (podman 5.8.2) on 2026-07-03.

## Image provenance

`docker.io/assistos/ploinky-box:podman-node24`, built by
`publish-ploinky-box-image.yml` in `AssistOS-AI/container-image-builds`. The
image is runtime-only (Node 24, npm, git, nested podman, slirp4netns, plus
the `/etc/ploinky-box` marker file): it contains no Ploinky source; the
wrapper supplies core code via the read-only host mount. Rebuild/publish:

    gh workflow run publish-ploinky-box-image.yml \
      --repo AssistOS-AI/container-image-builds \
      -f image_tag=podman-node24
