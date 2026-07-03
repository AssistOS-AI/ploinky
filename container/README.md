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
    # inside: enable agent demo
    # inside: start demo 8080
    open http://127.0.0.1:8080/status

## The one rule about ports

The wrapper publishes host port `--port N` (default 8080) to **container port
8080**. Inside the box, always start the router on 8080:
`start <agent> 8080`. Any other in-box port is unreachable from the host.

## Commands

| Command | Effect |
| --- | --- |
| `up` | Create/start the box; pulls the image on first use |
| `cli` | Interactive `p-cli` console inside the box |
| `run <args>` | One-shot ploinky command (`run start demo 8080`, `run list agents`) |
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
--security-opt seccomp=unconfined` (plus `label=disable` whenever the engine
reports SELinux enabled — e.g. the podman-machine VM on macOS, even though the
Mac itself has no SELinux). The only crossings of the boundary are: the published router port
(loopback-only unless `--listen-lan`), explicit `cp`, and the opt-in `--mount DIR`
(bind-mounted read-write at `/workspace/mounted` — you are piercing the sandbox).
State lives in two named volumes per instance: `<instance>-workspace`
(the Ploinky workspace) and `<instance>-containers` (nested agent images).
`stop`/`update` keep them; only `destroy` deletes them.

## Limitations

- In-box `ploinky update` cannot update the baked runtime (read-only,
  `.git` stripped); update the box itself with `ploinky-box update`.
- `additionalServerPort` in `container` mode relies on inspect-derived
  container IPs, which rootless podman does not expose; use `host` mode for
  such agents. (Smoke-test outcome recorded below.)
- Agents with `lite-sandbox: true` (bwrap/seatbelt) are unsupported inside
  the box in v1.
- On macOS, `--mount` directories must live under the podman-machine /
  Docker Desktop file share (default: your home directory).
- Windows hosts are unsupported.

## Image provenance

`docker.io/assistos/ploinky-box:podman-node24`, built by
`publish-ploinky-box-image.yml` in `AssistOS-AI/container-image-builds` from a
submodule-pinned ploinky checkout. Rebuild/publish:

    gh workflow run publish-ploinky-box-image.yml \
      --repo AssistOS-AI/container-image-builds \
      -f source_ref=master -f image_tag=podman-node24
