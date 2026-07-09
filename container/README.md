# Boxed Ploinky Runtime

Run the entire Ploinky runtime isolated inside one rootless-podman container.
The host needs podman (preferred) or docker, Node >= 20 to run the wrapper,
and a local ploinky checkout: the box does not bake Ploinky core -- the wrapper
bind-mounts your checkout read-only at `/opt/ploinky` inside the box. Agents
run as nested containers *inside* the box; nothing they do touches the host
filesystem.

`ploinky` is the preferred public entrypoint when using this checkout. It runs
normal Ploinky commands through the boxed runtime by default. `ploinky-box`
remains as a compatibility and diagnostic command for the wrapper itself.

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

`ploinky start explorer` also publishes Explorer's default local
browser/data-plane surfaces on host loopback: Web Publishing nginx `8081`,
OnlyOffice `8082`, webtty `7681`, LiveKit signaling `7880`, LiveKit TCP `7881`,
TURN `3478/tcp` and `3478/udp`, LiveKit UDP media `7882-7892/udp`, and TURN
relay `20000-20010/udp`. These are loopback-only outer box publishes; use
explicit `--publish` entries when you intentionally want different host
addresses or ports.

Other in-box ports are unreachable from the host unless you publish them when
creating the box. Use `--publish HOST:BOX` for a specific port, or use its alias
`--expose HOST:BOX`; repeat either flag for more ports. Existing boxes keep their
original port mappings; run `ploinky-box update` with the same flags, or recreate
the box, when you add new published ports.

## Host-mounted core and the dependency volume

The box mounts your ploinky checkout read-only at `/opt/ploinky` (resolved
from the wrapper's own location; override with `PLOINKY_BOX_SOURCE=/path`).
Core code edits on the host are visible inside the running box immediately --
no image rebuild. Because the source is read-only, npm dependencies live in a
writable named volume `<instance>-ploinky-deps` mounted at
`/opt/ploinky/node_modules`; host-side `node_modules` content is shadowed and
never used in-box. `stop`/`update` keep the volume; `destroy` removes it.

There is no direct-mode escape and no legacy env-var routing: on hosts
`ploinky` always drives the box, and inside the box image the same `ploinky`
script is the direct CLI. The preferred signal is the marker file
`/etc/ploinky-box`, baked by the Dockerfile; older images that lack it are also
recognized when the source is mounted at `/opt/ploinky` and the workspace is
`/workspace`. For CLI development on the host without the box, run
`node cli/index.js` from the checkout.

## Public `ploinky` Command

Bare `ploinky ...` commands keep their existing Ploinky meaning and execute
inside the box:

```bash
ploinky start explorer
ploinky status
ploinky stop
ploinky destroy
ploinky logs
ploinky install ...
```

When the host Ploinky checkout is on a non-main branch, `ploinky start ...`
forwards that branch to the in-box CLI unless you pass explicit branch flags.
This keeps branch-scoped stacks reproducible from the ordinary command:
`ploinky start explorer` on branch `ploinky-box` behaves like an explicit
`--branch ploinky-box`. Set `PLOINKY_BOX_AUTO_BRANCH=0` to disable inference, or
`PLOINKY_BOX_BRANCH=<branch>` to force a branch for wrapper tests and scripted
runs.

Outer box lifecycle commands use the explicit `box` namespace:

```bash
ploinky box status
ploinky box stop
ploinky box update
ploinky box destroy
```

`ploinky destroy` runs the normal in-box Ploinky destroy command. `ploinky box
destroy` removes the outer container and the three named volumes for the selected
instance.

Box selector flags such as `--name` and `--port` can appear before or after a
public command. Put `--dry-run` before the command for wrapper dry-run; after
the command it is forwarded to the in-box Ploinky CLI.

## `ploinky-box` Compatibility Commands

These commands remain available for direct wrapper diagnostics and standalone
downloads; public users should prefer `ploinky ...` and `ploinky box ...`.
This is the ploinky-box compatibility reference for scripts that still call the
wrapper directly.

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

The box runs **without `--privileged`**: `--user podman --device /dev/fuse
--device /dev/net/tun --security-opt seccomp=unconfined` (plus `label=disable` whenever the engine
reports SELinux enabled — e.g. the podman-machine VM on macOS, even though the
Mac itself has no SELinux). The only crossings of the boundary are: published ports
(loopback-only unless `--listen-lan`), explicit `cp`, and the opt-in `--mount DIR`
(bind-mounted read-write at `/workspace/mounted` — you are piercing the sandbox).
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
