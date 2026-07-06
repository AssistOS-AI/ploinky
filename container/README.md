# ploinky-box

Run the entire Ploinky runtime isolated inside one rootless-podman container.
The host needs podman (preferred) or docker, plus Node >= 20 to run the
wrapper — no git, no ploinky checkout. Agents run as nested containers
*inside* the box; nothing they do touches the host filesystem.

## Quick start

    cd ~/work/myProject
    curl -fsSL https://raw.githubusercontent.com/AssistOS-AI/ploinky/master/container/ploinky-box -o ploinky-box
    curl -fsSL https://raw.githubusercontent.com/AssistOS-AI/ploinky/master/container/ploinky-box.mjs -o ploinky-box.mjs
    chmod +x ploinky-box
    ./ploinky-box start webtty    # box 'ploinky-box-myProject': up + start webtty + router probe
    open http://127.0.0.1:8080/status

The agent must exist in a repo known to the box. Ploinky auto-clones its default
repos (basic, AchillesIDE, AchillesCLI, copilot-agents) on first use, so the
box needs outbound network on first `up`; `webtty` ships in `basic`.
`start <agent>` enables the agent automatically when its repo is known to the
box. Agents from non-default repos still need the repo added first (via `cli`).
Pick agents whose image contains node: ploinky's runtime-key probe execs `node`
inside the agent image and node-less images (e.g. plain alpine) fail to start.

## Instances

Every command targets one instance:

| Selector | Instance (container / volume prefix) |
| --- | --- |
| *(nothing)* | Inferred from the current directory basename: `ploinky-box-<basename>` |
| `--name X` | `ploinky-box-X` (explicit, wins over inference) |

Inferred names are sanitized (`[^a-zA-Z0-9_.-]` becomes `_`, capped at 63
chars, case preserved): `~/work/testExplorerFresh` →
`ploinky-box-testExplorerFresh` with volumes
`ploinky-box-testExplorerFresh-workspace` / `-containers`. Directories whose
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

Other in-box ports are unreachable from the host unless you publish them when
creating the box. Use `--publish HOST:BOX` for a specific port, repeat it for
more ports, or use `--webmeet-ports` to publish the local LiveKit/TURN ports
needed by WebMeet rooms/media. Existing boxes keep their original port mappings;
run `ploinky-box update` with the same flags, or recreate the box, when you add
new published ports.

## Commands

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
directory basename), `--port N`, `--publish SPEC`, `--webmeet-ports`,
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
State lives in two named volumes per instance: `<instance>-workspace`
(the Ploinky workspace) and `<instance>-containers` (nested agent images).
`stop`/`update` keep them; only `destroy` deletes them.

Agent containers inside the box are disposable: every box start wipes stale
inner containers (an unclean stop leaves inner podman with false "running"
state) and `run start` recreates them from `.ploinky` state. `stop`/`update`
first attempt a graceful in-box `ploinky stop`.

## Limitations

- In-box `ploinky update` cannot update the baked runtime (read-only,
  `.git` stripped); update the box itself with `ploinky-box update`.
- `additionalServerPort` in `container` mode relies on inspect-derived
  container IPs, which rootless podman does not expose; use `host` mode for
  such agents. Smoke result 2026-07-03 (macOS 26.5.2, podman machine 5.8.2):
  WebSocket/additional-port check skipped because `SMOKE_WS_AGENT` was not set.
- Agents with `lite-sandbox: true` (bwrap/seatbelt) are unsupported inside
  the box in v1.
- On macOS, `--mount` directories must live under the podman-machine /
  Docker Desktop file share (default: your home directory).
- Linux-host smoke not yet executed (verified on macOS only as of 2026-07-03).
- Windows hosts are unsupported.
- The wrapper itself needs Node >= 20 on the host (`ploinky-box` is a thin
  shim around `ploinky-box.mjs`; keep the two files side by side). The box
  and the agents inside it still need nothing but the container engine.

Smoke verified on macOS 26.5.2 / podman machine (podman 5.8.2) on 2026-07-03.

## Image provenance

`docker.io/assistos/ploinky-box:podman-node24`, built by
`publish-ploinky-box-image.yml` in `AssistOS-AI/container-image-builds` from a
submodule-pinned ploinky checkout. Rebuild/publish:

    gh workflow run publish-ploinky-box-image.yml \
      --repo AssistOS-AI/container-image-builds \
      -f source_ref=master -f image_tag=podman-node24
