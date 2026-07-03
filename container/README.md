# ploinky-box

Run the entire Ploinky runtime isolated inside one rootless-podman container.
The host needs nothing but podman (preferred) or docker — no node, no git, no
ploinky checkout. Agents run as nested containers *inside* the box; nothing
they do touches the host filesystem.

## Quick start

    curl -fsSL https://raw.githubusercontent.com/AssistOS-AI/ploinky/master/container/ploinky-box -o ploinky-box
    chmod +x ploinky-box
    ./ploinky-box up
    ./ploinky-box cli          # interactive Ploinky console
    # inside: enable agent webtty
    # inside: start webtty 8080
    open http://127.0.0.1:8080/status

The agent must exist in an enabled repo — ploinky auto-clones its default
repos (basic, AchillesIDE, AchillesCLI, copilot-agents) on first use, so the
box needs outbound network on first `up`. `webtty` ships in `basic`. Pick
agents whose image contains node: ploinky's runtime-key probe execs `node`
inside the agent image and node-less images (e.g. plain alpine) fail to start.

## The one rule about ports

The wrapper publishes host port `--port N` (default 8080) to **container port
8080**. Inside the box, always start the router on 8080:
`start <agent> 8080`. Any other in-box port is unreachable from the host.

## Commands

| Command | Effect |
| --- | --- |
| `up` | Create/start the box; pulls the image on first use |
| `cli` | Interactive `p-cli` console inside the box |
| `run <args>` | One-shot ploinky command (`run start webtty 8080`, `run list agents`) |
| `cp A B` | Copy in/out; container side uses the `box:` prefix |
| `status` | Container state + router probe |
| `logs` | Recent `.ploinky` logs |
| `stop` | Stop the box; workspace and agent images survive |
| `update` | Pull newer image, recreate the box (pass the same flags as `up`) |
| `destroy` | Remove the box AND its volumes (asks first) |

Flags: `--name X` (extra isolated instance), `--port N`, `--image I`,
`--mount DIR`, `--listen-lan`, `--engine podman|docker`, `--dry-run`.
`PLOINKY_BOX_ENGINE` overrides engine detection.

## Isolation contract

The box runs **without `--privileged`**: `--user podman --device /dev/fuse
--device /dev/net/tun --security-opt seccomp=unconfined` (plus `label=disable` whenever the engine
reports SELinux enabled — e.g. the podman-machine VM on macOS, even though the
Mac itself has no SELinux). The only crossings of the boundary are: the published router port
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

Smoke verified on macOS 26.5.2 / podman machine (podman 5.8.2) on 2026-07-03.

## Image provenance

`docker.io/assistos/ploinky-box:podman-node24`, built by
`publish-ploinky-box-image.yml` in `AssistOS-AI/container-image-builds` from a
submodule-pinned ploinky checkout. Rebuild/publish:

    gh workflow run publish-ploinky-box-image.yml \
      --repo AssistOS-AI/container-image-builds \
      -f source_ref=master -f image_tag=podman-node24
