# Ploinky

Ploinky is a lightweight runtime for AI agents. It is technology‑agnostic: an agent can be implemented in any language as long as it reads from stdin and writes to stdout (a simple console process). Ploinky exposes that process as a terminal (Console) and also as a chat interface — the chat mirrors the same TTY stream for a nicer UX.

Beyond a single agent, Ploinky supports a multi‑agent workspace. Each agent runs in its own container. A local web router serves a simple web app and proxies API calls to the containers, so you can build applications that orchestrate multiple agents. A companion cloud component (in progress) will host multiple such custom apps, each with its own agents and routes.

## Prerequisites
- Node.js 20+
- Docker or Podman
- Git

## Getting started

```bash
# Clone and setup
git clone https://github.com/AssistOS-AI/ploinky.git
cd ploinky
export PATH="$PATH:$(pwd)/bin"

# Start the CLI
p-cli

# Enable an agent and start the workspace
enable agent my-agent
start my-agent 8080

# Browser chat surface
webchat
```

## Usage

You can use Ploinky in two ways:

1.  **From within the project directory:**
    As shown in the "Getting started" section, you can run `p-cli` from within the cloned project directory.

2.  **Globally from any directory:**
    To use `ploinky` from anywhere, you need to add its location to your shell's configuration file (e.g., `.bashrc`, `.zshrc`).

    Add the following line to your `~/.bashrc` or `~/.zshrc` file, replacing `~/path/to/ploinky` with the actual path to your ploinky directory:

    ```bash
    export PATH="$PATH:~/path/to/ploinky/bin"
    ```

    After adding the line, restart your shell or run `source ~/.bashrc` (or `source ~/.zshrc`). You can then use `p-cli` or `ploinky` from any directory. For example:

    ```bash
    ploinky list agents
    ```

By default, the public entrypoint reconciles and starts one managed outer
runtime, then runs Ploinky core inside it. The runtime mounts the local checkout
read-only at `/opt/ploinky` and bind-mounts the canonical host launch directory
read-write at `/workspace`. Ordinary agent containers run one level inside this
runtime and receive that same `/workspace` bind, so host files are immediately
visible to agents and files or directories created there by agents persist on
the host. The dependency cache and nested image cache are bind-mounted from
`<workspace>/.ploinky/box/dependencies` and `<workspace>/.ploinky/box/images`,
so they survive destroy and recreate; nested container state does not. The outer
runtime has exactly four mounts and owns no named volume. Transient Unix
sockets stay under the outer runtime's private
`/run/ploinky` filesystem so the writable host bind remains portable through a
macOS Podman Machine.
Dependency-cache seeding inside the Box likewise uses `cp -a` copies instead
of hard links or Node's recursive copy because shared macOS bind mounts cannot
preserve those operations reliably across the outer and nested containers.

| Invocation | Documented effect |
| --- | --- |
| `ploinky` or `p-cli` | Reconcile/start outer runtime; open Ploinky REPL |
| `ploinky cli` | Reconcile/start outer runtime; open `/bin/bash` as `podman` in `/workspace` |
| `ploinky cli <agent>` | Reconcile/start outer runtime; attach to that agent's manifest CLI |
| `ploinky start ...` | Reconcile/start outer runtime; start the graph behind the fixed boundary |
| `ploinky --port <tcp> --udp-port <udp> start ...` | Select the physical Router TCP and media UDP ports; in-Box targets remain `8080/tcp` and `7882/udp` |
| `ploinky status` | Inspect outer configuration/publishes/health and running core status without mutation |
| `ploinky stop` | Stop core services, then stop outer runtime; keep `.ploinky/box` cache data |
| `ploinky update` / `ploinky update all [PATH]` | Pull the cloned host Ploinky checkout from its configured upstream, refresh in-Box repositories/dependencies/skills, then restart an already configured running workspace |
| `ploinky destroy` | Stop nested agents, then remove the outer container; retain the host workspace and `.ploinky/box` |
| `ploinky destroy --delete-cache` | Remove the outer container without prompting, then delete only `.ploinky/box/dependencies` and `.ploinky/box/images` |
| REPL `status`/`stop`/`destroy` | Core workspace/router/agent scope; outer runtime remains |

When REPL input is not a Ploinky command, Ploinky attempts that executable
directly using the runtime `PATH`; it does not depend on a separate `which`
utility. Success still depends on the executable being present in the image.
Optional system tools such as `ps` are not part of the Box image contract, while
`ploinky cli` retains the dedicated shell and agent-CLI behavior shown above.

The default outer image is the mutable
`docker.io/assistos/ploinky-box:latest` reference. Set `PLOINKY_BOX_IMAGE` to a
different tag or immutable digest reference when an alternate Box image is
needed; the public `--image` option remains unsupported. The selected image's
labels must be empty, its `/etc/ploinky-box` marker must contain exactly
`assistos/ploinky-box`, and its complete image configuration and capabilities
must match the source-owned allowlist. Ploinky pulls the selected reference only
when creating a missing Box or preparing a validated replacement, validates the
complete image metadata, and starts the captured image ID rather than racing the
mutable tag. Compatible reuse, stopped-box start, status, stop, and destroy do
not pull. Incompatible images or foreign owned resources are rejected before
pulling, cache preparation, restart, upgrade, or replacement. Ploinky does not
migrate, clean, relabel, or adopt them: run `ploinky destroy` explicitly, then
recreate the Box. Ordinary destroy retains `.ploinky/box`;
`--delete-cache` performs an explicit storage reset of exactly those two cache
directories without deleting any other workspace file.

Only reusable content survives replacing the outer Box:

| State | Where it lives | Survives destroy? |
| --- | --- | --- |
| Workspace data | Host bind at `/workspace` | Yes, and no destroy path ever deletes it |
| Pinned dependency cache | Host bind from `.ploinky/box/dependencies` at `/opt/ploinky/node_modules` | Yes, unless `--delete-cache` |
| Nested image cache | Host bind from `.ploinky/box/images` at `/home/podman/.local/share/ploinky-images` | Yes, unless `--delete-cache` |
| Nested container records and writable layers | Box writable layer under `/home/podman/.local/share/containers/storage` | No |
| Inner Podman named volumes | Under the same disposable graphroot | No |
| Transient runtime metadata | `/tmp/storage-run-1000` | No, reset every startup |

Nested container records, writable layers, networks, and inner Podman named
volumes are discarded with the outer Box, so persistent agent data must use
explicit `/workspace` binds. A Box created by an older layout is not recognized
and is not migrated: `ploinky start` reports it as incompatible, and
`ploinky stop` followed by `ploinky destroy` removes it.

Ploinky no longer creates, inspects, or deletes any outer named volume. Named
volumes left over from an earlier layout (`-images`, `-ploinky-deps`,
`-containers`, `-workspace`) are inert: they neither establish ownership nor
block a new Box, and nothing removes them automatically. If you want the disk
space back, back up anything that exists only there, identify the exact owning
engine, and remove only those exact volumes by name:

```bash
ENGINE=podman # or docker, after exact inspection
OLD_INSTANCE=ploinky-box-OLDNAME
$ENGINE volume rm "$OLD_INSTANCE-images" "$OLD_INSTANCE-ploinky-deps"
```

Do not use a broad container or volume prune for this cleanup.

A compatible Box is reused or started when its creation configuration is an
exact normalized match. Changing the selected image reference or requested host
ports performs a transactional replacement after the candidate image and ports
validate; failure restores the previous immutable image and container. Other
mount, device, security, or creation drift fails before registry traffic or
container mutation and requires an explicit `ploinky destroy` followed by
recreation.

The outer container is named from the canonical absolute current directory, and
its cache directories live under that directory's `.ploinky/box`. The workspace
is mounted at `/workspace` rather than copied into engine storage. Ploinky
automatically discovers whether Podman or Docker owns the exact managed
container and fails closed on unreachable, split, or foreign state; there is no
public `--name`, `--engine`, or `PLOINKY_BOX_ENGINE` override. Ordinary
`destroy` removes only the selected outer container, preserving the host
workspace, the nested image cache, and the Ploinky dependency cache for
recreation. The explicit `destroy --delete-cache` form deletes exactly
`.ploinky/box/dependencies` and `.ploinky/box/images` after the outer container
is gone; it never removes the workspace, `.ploinky/master-key`, repositories,
agents, routing state, or secrets.

Every managed box has exactly two engine publications, independent of graph or
workspace state: `127.0.0.1:<selectedRouterHostPort>:8080/tcp` and
`0.0.0.0:<selectedMediaHostPort>:7882/udp`. `--port` changes only the physical
Router port. `--udp-port` changes only the physical media UDP port and defaults
to `7882`; the in-Box LiveKit listener remains fixed on wildcard UDP `7882`.
For example, `ploinky --port 9090 --udp-port 12345 start explorer` publishes
host TCP `9090` to in-Box TCP `8080` and host UDP `12345` to in-Box UDP `7882`.
`--publish`, `--expose`, and `--listen-lan` are rejected. Agent `openPorts`,
HTTP-service targets, readiness, profiles, manifests, labels, and retained state
remain private and cannot add a third mapping. A managed Box creates its sole
core master key at `.ploinky/master-key` with mode `0600`. Host environment and
`.env` values cannot override that key; `.env` remains application-owned and is
never created, changed, or consulted for managed-key resolution. Missing,
malformed, or unsafe managed-key state fails closed before core readiness.

The box image includes pinned multi-architecture `cloudflared`, supervised by
Ploinky core. No Cloudflare credentials selects explicit `local-only` mode: the
connector is absent and no public HTTP hostname exists. Cloudflare mode may use
an existing tunnel, run only an existing connector whose routes are maintained
externally, or explicitly opt into a Ploinky-managed tunnel. The managed form
uses `accountId`, `zoneId`, `tunnelName`, and `apiTokenSecret`; Ploinky creates a
uniquely owned remotely configured tunnel, obtains its connector token only in
memory, and reconciles ingress and DNS. `deleteTunnelOnTeardown` defaults to
`false`; when set to `true`, teardown deletes the tunnel only when the durable
ownership registry proves Ploinky created it. Invalid or partial configuration
fails closed without changing modes. Quick tunnels are never used, and the
connector origin is always in-box `http://127.0.0.1:8080`.
Managed names are 1-48 characters; Ploinky appends a unique ownership suffix.
Changing the requested name retains the previous tunnel until that name is
selected with an explicit empty-host teardown.

Ordinary agent images intentionally contain neither Podman nor Docker. Every
Ploinky-managed agent and helper container runs through nested Podman inside the
managed outer runtime. Managed networking requires rootless Podman
5.4 or newer with Netavark and an operational `pasta`; there is no
`slirp4netns` fallback. Managed `default` and `bridge` agents receive only the
exact `host.containers.internal:host-gateway` mapping, private Router locator,
and non-secret topology snapshot. Host mode requires an exact current-generation
capability; `none` receives no Router endpoint.

Topology is box-owned and mounted before consumers start. It distinguishes the
immutable route-and-policy authorization generation, a content-derived
configuration generation, and a monotonic readiness/publication generation.
The authenticated browser projection returns only one active `no-store` locator
plus configuration/publication ids, never the authorization id or inventory.

Before updating a legacy direct/core installation, run the
old checkout's core entry directly:

```sh
node cli/index.js destroy
node cli/index.js network prune
```

Do not use the public `ploinky` wrapper for this step: outside a box it controls
the outer runtime rather than the old core workspace. Inspect or resolve any
foreign resources reported by the core prune. After confirming no container
still references them, one-time cleanup may remove the exact stale
`.ploinky/run/router.sock` and `.ploinky/run/managed-hosts` paths and the now
unreferenced cached image
`docker.io/assistos/ploinky-network-gateway:1@sha256:68c47ce93d16ea1a2d03944f7b50ce82e6f2f9a26b183d2c9c7fbabcc828fb7e`.
Before activation, revoke the retired publication connector/API tokens and
delete its plaintext retained state; the current runtime contains no migration or cleanup
reader. Do not use a broad container, image, volume, or network prune for this
cutover.

For local core development without entering the managed runtime, run the CLI
entry directly from your checkout:

```bash
node cli/index.js <args>
```

## Core commands (in p-cli)

- `enable agent <name> [as <alias>]`: register an agent in `.ploinky/agents.json` (creates a minimal manifest if missing). Use `as <alias>` to spin up additional instances with unique container names.
- `update [folderPath]`: update the Ploinky checkout, refresh `node_modules/achillesAgentLib`, update managed repos, refresh `AchillesCopilotBasicSkills` in eligible managed repos, and refresh discovered project repositories and default skills.
- `start <staticAgent> 8080`: first core start requires a static agent; subsequent runs can just use `start`.
  - Ensures all enabled agents are running and launches the fixed inner Router on `8080`. On the host-facing public wrapper, `ploinky start <agent> <port>` treats that positional port only as the loopback physical-host selection and still forwards inner `8080` to core.
  - Serves static files from the repository of `<staticAgent>`; non `/<agent>/...` paths are static.
- `cli`: from the managed runtime, open `/bin/bash` as `podman` in `/workspace`.
- `cli <name> [args...]`: run the agent’s manifest CLI command interactively.
- `shell <name>`: open interactive `/bin/sh` in the agent container.
- `webchat [--rotate]`: print the WebChat access URL for the router login flow.
- `client tool <toolName> [--agent <agent>] [--parameters <params>] [-key value...]`: call an MCP tool exposed by an enabled agent.
- `client list tools|resources`: list MCP tools or resources exposed by enabled agents.
- `client status <agent>`: check agent health status.
- `stop`: stop containers recorded in `.ploinky/agents.json` (do not remove).
- `shutdown`: stop and remove containers recorded in `.ploinky/agents.json`.
- `destroy`: stop the router, remove workspace containers, and clear `.ploinky/deps` while preserving isolated agent data in `.data/<agent-or-alias>`.
- `deps prepare [<repo>/<agent>]`: build the prepared node_modules cache for the current runtime.
- `deps status`: list prepared global and per-agent caches with their runtime keys and validity.
- `deps clean <repo>/<agent>|--global|--all`: remove a cache directory.

The `/dashboard` and `/status` TCP control surfaces require a real
router-authenticated local-admin session on an exact local-control Host. A
component token, invitation, agent assertion, media credential, or loopback
source is not administrator identity. Mutations also require exact Origin and a
session-bound CSRF proof.

## Dependency caches

Node-based agents consume a prepared, runtime-keyed dependency cache. `ploinky start` prepares or reuses the cache before launching the runtime; `ploinky deps prepare` lets operators warm or refresh the same cache explicitly.

- Global deps come from `ploinky/globalDeps/package.json` and land in `.ploinky/deps/global/<runtime-key>/node_modules/`.
- Per-agent deps merge global + `<agent>/package.json` and land in `.ploinky/deps/agents/<repo>/<agent>/<runtime-key>/node_modules/`.
- The runtime key is `<family>-<platform>-<arch>-node<major>` for host runtimes and may include a Linux container libc variant when needed, for example `container-linux-x64-musl-node20` or `container-linux-x64-glibc-node20`.
- Agents mount the cache read-only. Startup checks the cache stamp (runtime key + merged-package hash) and prepares the cache when it is missing or stale, which may require npm, git, network access, and native build tools.
- `bwrap`, `seatbelt`, and container runtimes all consume prepared caches now. Container caches are prepared in a short-lived install container that matches the target runtime image, then mounted read-only into the runtime container.

## Notes

- Containers run with the workspace directory mounted read‑write at the same path inside the container.
- Ploinky’s `Agent` tools directory is mounted read‑only at `/Agent` in every container, providing a supervisor script and helpers.
- If an agent manifest lacks an `agent` command, the container runs `/Agent/AgentServer.sh` which supervises the default AgentServer and restarts it if it exits.

## WebChat agent requirements

- WebChat sends structured message envelopes over stdin. Agents that want a reliable chat experience should expose a real CLI process that reads stdin continuously and writes replies to stdout.
- A manifest `cli` that points to a plain shell such as `"/bin/sh"` or `"/bin/bash"` does not become conversational by itself. In that setup WebChat mirrors raw input to the shell, and the shell may simply echo or mis-handle the incoming payload.
- The recommended pattern is a dedicated CLI entrypoint such as `node /code/main.mjs` that parses WebChat input and keeps running for the full session.
- `ploinky cli <agent>` and WebChat share the same manifest `cli`, so the same command must be suitable for both interactive terminal use and WebChat streaming input.
- At WebChat startup, the CLI receives `PLOINKY_WEBCHAT_HAS_HISTORY=1` when the selected conversation already contains messages, otherwise `0`. Agents that emit a new-conversation introduction should omit it when the value is `1`; Ploinky supplies the prior conversation context with the next normal user message.

## Cloud (preview)

The cloud component will allow hosting multiple custom apps built on Ploinky, each with its own agents and routes.

## License

MIT License - see [LICENSE](LICENSE)
