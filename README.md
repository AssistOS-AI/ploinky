# Ploinky

Ploinky is a lightweight runtime for AI agents. It is technology‑agnostic: an agent can be implemented in any language as long as it reads from stdin and writes to stdout (a simple console process). Ploinky exposes that process as a terminal (Console) and also as a chat interface — the chat mirrors the same TTY stream for a nicer UX.

Beyond a single agent, Ploinky supports a multi‑agent workspace. Each agent runs in its own container. A local web router serves a simple web app and proxies API calls to the containers, so you can build applications that orchestrate multiple agents. A companion cloud component (in progress) will host multiple such custom apps, each with its own agents and routes.

See [local instruction skills](docs/local-instruction-skills.md) for launch scope metadata, RoboTeam's catalog boundary, and skill installation that preserves local edits. Default and manifest skills use relative symlinks. During update, skills removed from a readable source are also removed from manifest selections and unchanged managed links.

## Prerequisites

The public `ploinky` command requires Node.js 22 or newer and rootless Podman.
Native Linux hosts use a supported baseline of Podman 5.4.0 or newer; macOS
uses Podman Machine. Docker and arbitrary remote engines are unsupported for
the outer Box. Git is needed to clone and update the host checkout.

Run `ploinky diagnose` from the workspace to check the host environment:

| Requirement | What must be available |
| --- | --- |
| Rootless runtime | A regular login account, `newuidmap` and `newgidmap`, working user namespaces, and at least 65,536 contiguous mapped container UIDs and GIDs starting at zero |
| Nested devices | Read/write access to the `/dev/fuse` and `/dev/net/tun` character devices |
| Confinement | Seccomp support |
| Runtime helpers | The executable conmon and OCI runtime paths selected by `podman info` |
| Networking | The configured `pasta` (provided by `passt`) or `slirp4netns` executable, and the selected Netavark executable when applicable |
| Storage | The configured overlay mount helper, if one is selected; native overlay does not require host `fuse-overlayfs` |

The current Box runs nested Podman with cgroups disabled and sets no outer CPU
quota. Startup therefore does not require a particular host cgroup version or
delegated `cpu`, `memory`, or `pids` controllers.

The general host prerequisite survey runs when `ploinky diagnose` or
`ploinky repair` is requested. Commands such as `ploinky start explorer` attempt their deployment
directly; a deployment failure retains its original error and exit code and
suggests running `ploinky diagnose`. The Node launcher guard, immutable image
contract, ownership, isolation and runtime readiness checks still apply to the
operations they protect. Ploinky never installs host packages or changes host
security configuration automatically.

For a Debian/Ubuntu installation, start with
`sudo apt-get update && sudo apt-get install podman uidmap passt conmon crun catatonit`.
Verify `podman --version` meets the minimum: an older distribution may need an
OS upgrade or a supported newer package source. Install other helpers only when
diagnostics report they are missing from the selected configuration.
Catatonit supplies the usual `--init` helper; a custom configured init path is
resolved by Podman rather than rejected because catatonit is absent from PATH.
Subordinate UID/GID ranges must be allocated by an administrator without
overlapping other users' ranges. After changing existing mappings, stop your
containers and run `podman system migrate` as your normal user before retrying.

Use the official [Node.js downloads](https://nodejs.org/en/download),
[Podman installation guide](https://podman.io/docs/installation), and
[rootless setup guide](https://github.com/containers/podman/blob/main/docs/tutorials/rootless_tutorial.md)
for your distribution. The packages inside the Box are checked separately by
its immutable image contract and entrypoint; they need not all be installed on
the physical host.

## Diagnose a failed deployment

```bash
cd /path/to/workspace
ploinky diagnose
ploinky --port 8082 --udp-port 7001 diagnose
ploinky diagnose --json > diagnosis.json
```

Run diagnostics as the normal deployment account on the physical host. The
report lists `PASS`, `FAIL`, `WARN` and `SKIP` checks, the actual commands and
exit codes, bounded redacted errors, and a next step for each failure. Independent
checks continue after a failure; dependent probes explain why they were skipped.
Progress goes to stderr, so `--json` produces a machine-readable stdout report.
Exit status is `0` for completed probes, `1` for failures and `2` when required
probes cannot be completed. A warning about unreadable loaded AppArmor policy
does not pretend that installed profile text proves kernel behavior.

Each failed or warning check links to remediation actions with explicit
privilege and automation labels:

| Label | How to proceed |
| --- | --- |
| `AUTO (no sudo)` | Run `ploinky repair` to apply the supported action after fresh safety checks |
| `MANUAL (no sudo)` | Follow the instructions as your normal user; the action needs your choice or review |
| `SUDO REQUIRED` | Ask an administrator to perform the listed system change or inspection |
| `MANUAL (privilege undetermined)` | Inspect the reported cause first; the evidence does not yet establish which privilege is needed |

Required administrator actions are grouped separately from optional
administrator diagnostics. An unreadable AppArmor policy or a missing literal
source rule alone is not a deployment blocker. A confirmed policy denial needs
administrator review. Installing system packages, allocating subordinate IDs,
and changing host device or security policy require administrator privileges.
Personal PATH, connection, port and storage choices remain manual user actions.

Diagnostics inspect Node/PATH, Podman and its selected helpers, subordinate
identity mappings, devices, storage driver/configuration, login/cgroup context,
seccomp, SELinux and AppArmor. They check the selected TCP/UDP ports, accounting
only for the existing owned Box's reservations. Installed profile checks cover
the nested namespace and FUSE cleanup paths that can block container startup.

Runtime probes create a temporary workspace on the selected filesystem and use
the normal image verification and Box lifecycle. They may pull the configured
Box image if it is missing, then export its verified immutable image for the
isolated inner stores. Host registry credentials are not copied into containers.
The probes exercise image loading, container creation/start/exec/removal,
mounted-file write/rename/read/unlink, registry DNS/HTTPS and a deeper Podman
engine using the existing nested-container confinement options. This can take
several minutes and needs temporary disk space for the image archives/stores.

The active deployment is not stopped, restarted or repaired. Temporary resources
are removed only after their identities are revalidated; cleanup failure is a
failed diagnostic with retained-resource information. No host profile, firewall,
storage driver or credentials are changed. Commands referencing removed test
containers are evidence of that attempt; rerun `ploinky diagnose` to reproduce
them. Diagnosis checks deployment infrastructure; it does not replay arbitrary
agent install hooks, start user workloads or replace application E2E tests.

## Repair user-level deployment issues

```bash
cd /path/to/workspace
ploinky repair --dry-run
ploinky repair
ploinky --port 8082 --udp-port 7001 repair
ploinky repair --json > repair.json
```

Run repair on the physical host as the regular deployment account. It rejects
execution as root and never invokes `sudo`. It first inspects the current
environment, applies eligible actions under the selected workspace's mutation
lock, then runs the full deployment diagnostics to verify the result. The
supported automatic actions are:

| Action | Eligibility and scope |
| --- | --- |
| Restrict saved Router binding permissions | Remove group/other permission bits from the exact validated, user-owned binding file. Shared-writable records, unsafe paths, and foreign ownership require manual review. File content stays intact. |
| Download a missing Box image | Pull the configured qualified registry reference only after confirming it is absent and the rootless engine is usable. Cached images are not refreshed. |
| Start an existing Podman Machine on macOS | Start the selected stopped Machine only after verifying its rootless settings and unchanged selection. No Machine is created or reconfigured. |

`--dry-run` previews those actions using inspection only: no repairs, mutation
lock, or temporary deployment probes. `ploinky --dry-run repair` is equivalent.
The regular command runs full diagnostic probes after its repairs, even if no
automatic action was eligible. These probes have the temporary-resource and
image-download behavior described above; a preview does not prove deployment
readiness.

The final report shows each repair outcome and the remaining actions, including
a separate list of required administrator steps. Run those steps separately,
then rerun `ploinky diagnose`. Optional administrator inspections stay optional.
An unresolved manual user action can still block deployment even when no sudo
steps remain. Repair exits nonzero if an action failed, verification failed, or
required probes could not be completed. The JSON report includes `before`,
`after`, `outcomes`, `remainingActions`, `sudoRequired`, and `exitCode`.

Repair never restarts the active workspace, edits host profiles, resets Podman
storage, terminates conflicting listeners, changes registry credentials, or
executes diagnostic hint text as shell commands. Ordinary deployment commands
suggest `ploinky diagnose` on failure; they do not invoke repairs automatically.

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

# Browser chat surface (after Router login)
# http://localhost:8080/webchat/
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
read-only at `/opt/ploinky` and bind-mounts the selected host workspace
read-write at that same absolute path. The workspace path is also the runtime
working directory and its `PLOINKY_WORKSPACE_ROOT`, so a workspace at
`/home/user/project` is `/home/user/project` on the host, in the runtime, and in
the project grant of global and development agents. Ordinary agent containers
run one level inside this runtime and receive their project at that same path, so
host files are immediately visible to agents and files or directories created
there by agents persist on the host. Isolated agents keep their private project
and home at `/root`.

The workspace path must be mountable at itself: it is rejected before any Box
change if it contains `:`, a backslash, or a control character, ends with whitespace, or
replaces, contains, or lies inside a Box-owned location such as `/opt/ploinky`,
`/usr`, `/etc`, `/tmp` itself, the Box home configuration and stores, or the
`/Agent`, `/code`, `/shared`, `/root`, and `/home/agent` agent runtime paths.
Directories below `/tmp` or `/var/tmp` remain valid workspaces. `ploinky
diagnose` reports this check. Boxes and runtime images from the former fixed
`/workspace` layout are incompatible: they are rejected, not migrated, and a
Box must be recreated from an image whose working directory is `/` and whose
environment has no workspace root. The dependency cache and nested image cache are bind-mounted from
`<workspace>/.ploinky/box/dependencies` and `<workspace>/.ploinky/box/images`,
so they survive destroy and recreate; nested container state does not. The outer
runtime has four durable host binds and one transient `/tmp` tmpfs created with
`rw,exec,nosuid,nodev,mode=1777,notmpcopyup`; it owns no named volume. The tmpfs
is empty on every outer boot, so inner Podman runtime metadata cannot survive a
stop/start. Transient Unix sockets stay under the outer runtime's private
`/run/ploinky` filesystem so the writable host bind remains portable through a
macOS Podman Machine.
Dependency-cache seeding inside the Box likewise uses `cp -a` copies instead
of hard links or Node's recursive copy because shared macOS bind mounts cannot
preserve those operations reliably across the outer and nested containers.
The lock-pinned MCP SDK source is sealed into `ploinky-box` at image-build time.
On startup the Box verifies that immutable bundle and copies it into
`/opt/ploinky/node_modules`; a fresh workspace therefore performs no MCP SDK
Git or npm operation and needs no GitHub credentials.

Automatic repository bootstrap prepares `AchillesIDE`, `AchillesCLI`, and `copilot-agents`, reusing matching workspace checkouts before cloning missing repositories into `.ploinky/repos`. Explorer's manifest declares its additional repositories and uses `AchillesIDE/liveKitServerAgent` for LiveKit. The `basic` repository is optional: install it explicitly with `ploinky install repo basic` when needed.

### Agent repositories in the workspace

You can keep agent repositories directly inside your [workspace](docs/wiki.html#definition-workspace). Every operation that selects an agent repository's source prefers the matching workspace checkout over `.ploinky/repos/<repository>`. This includes discovery, installed/active lists, Marketplace inventory, manifest and dependency preparation, and source selection for new runtimes.

For example, when Ploinky runs in `work`, it can use `work/AssistOSExplorer` for the registered repository `AchillesIDE` because its Git origin matches the registered URL. The cached `work/.ploinky/repos/AchillesIDE` is then unused for source selection. The agent still has the identity `AchillesIDE/explorer`.

A matching folder named after the registered repository takes priority; otherwise Ploinky matches Git origins among direct workspace children containing agent manifests. With no local match, it uses `.ploinky/repos`. Automatic preparation reuses the local checkout without switching its branch. An explicit repository update can pull into that checkout; uninstalling it unregisters it while preserving its files. Already running instances retain their selected source until a lifecycle transition creates a new runtime. See [repository selection and lifecycle details](docs/operations.html#workspace-agent-repositories).

| Invocation | Documented effect |
| --- | --- |
| `ploinky` or `p-cli` | Reconcile/start outer runtime; open Ploinky REPL |
| `ploinky cli` | Reconcile/start outer runtime; open `/bin/bash` as `podman` in the workspace directory, at its host path |
| `ploinky cli <agent>` | Reconcile/start outer runtime; attach to that agent's manifest CLI |
| `ploinky start ...` | Reconcile/start outer runtime; start the graph behind the fixed boundary |
| `ploinky --port <tcp> --udp-port <udp> start ...` | Select the physical Router TCP and media UDP ports; in-Box targets remain `8080/tcp` and `7882/udp` |
| `ploinky bind [ADDRESS:PORT:8080]` | Publish the public Router on this machine's IPv4 `ADDRESS` (`0` for all interfaces) and TCP `PORT`; recreate the Box and restart the configured graph when the mapping changes; save the binding for later lifecycle commands |
| `ploinky bind 127.0.0.1:PORT:8080` | Restore local-only Router access |
| `ploinky status` | Inspect outer configuration/publishes/health and running core status without mutation |
| `ploinky diagnose [--json]` | Run host prerequisite/settings checks and isolated deployment command probes; report failures, commands, and actions labelled by privilege and automation eligibility |
| `ploinky repair [--dry-run] [--json]` | Apply supported normal-user fixes, verify with diagnostics, and list remaining manual and sudo-required actions; `--dry-run` only inspects and previews |
| `ploinky stop` | Stop core services, then stop outer runtime; keep `.ploinky/box` cache data |
| `ploinky update` / `ploinky update all [PATH]` | Pull Ploinky with `--rebase --autostash` only when its checkout is inside the selected folder (or the command is run from inside that checkout); still refresh AgentLib, agents, repositories, dependencies, and skills, then restart an already configured running workspace |
| `ploinky destroy` | Without prompting, stop nested agents and remove the outer container; retain the host workspace and `.ploinky/box` |
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
not pull. A stopped compatible Box is started with the same immutable outer
container ID; only readiness output appended during that start is accepted,
and the final inspection must still prove the Box is running. Incompatible
images or foreign owned resources are rejected before
pulling, cache preparation, restart, upgrade, or replacement. Ploinky does not
migrate, clean, relabel, or adopt them: run `ploinky destroy` explicitly, then
recreate the Box. Ordinary destroy retains `.ploinky/box`;
`--delete-cache` performs an explicit storage reset of exactly those two cache
directories without deleting any other workspace file.

Cross-repository release candidates must align the AgentLib commit in
`ploinky-box/dependencies.lock.json` with the selected AgentLib source and the
release manifest. Run the offline release-bundle verifier before recreating a
test workspace. AgentLib is direct-mounted, not bundled into the Box image;
an AgentLib-only policy-pin change does not change the bundled MCP SDK or its
dependency-cache fingerprint. Changes to actual image inputs still require
image-contract verification and a matching immutable image.

Prepared dependency caches bind both `achillesAgentLib` and `ploinky-agent-lib`
to that same admitted source. After npm completes, Ploinky replaces hoisted,
scoped, and nested copies of either package with source links and verifies them
before admitting the cache. This also covers dependencies that use the package
name `ploinky-agent-lib`, such as ALA. Older cache adapters are repaired under
the cache lock without reinstalling unrelated packages. Linked local packages
are inspected without changing their source. If they contain or resolve a
different AgentLib, install those dependencies as package copies so Ploinky can
adapt the owned cache. Runtime caches and the selected library remain read-only.

State follows these stop/start and destroy boundaries:

| State | Where it lives | Survives stop/start? | Survives destroy? |
| --- | --- | --- | --- |
| Workspace data | Host bind at the workspace's own absolute path | Yes | Yes; no destroy path deletes it |
| Pinned dependency cache | Host bind from `.ploinky/box/dependencies` at `/opt/ploinky/node_modules` | Yes | Yes, unless `--delete-cache` |
| Nested image cache | Host bind from `.ploinky/box/images` at `/home/podman/.local/share/ploinky-images` | Yes | Yes, unless `--delete-cache` |
| Nested container records and writable layers | Box writable layer under `/home/podman/.local/share/containers/storage` | Yes | No |
| Inner Podman named volumes | Under the same disposable graphroot | Yes | No |
| Transient runtime metadata | Tmpfs path `/tmp/storage-run-1000` | No; `/tmp` is fresh each boot | No |

## WebTTY terminal targets

Explorer's folder menu can open a terminal at that folder in the Ploinky Box or
in an eligible live agent. The Router discovers targets with
`POST /webtty/target-discoveries`, creates the selected terminal with
`POST /webtty/sessions`, streams output over SSE, and accepts bounded input and
resize POSTs. Discovery returns only safe display data and random launch IDs;
container identities, translated paths, shell arguments, users, environment,
and runtime flags remain server-controlled.

The launch ID is carried to `/webtty/` only in the URL fragment and is removed
from browser history before the page creates a session. It is short-lived,
bound to the administrator login and active route generation, single-use, and
invalidates its sibling target choices when consumed. All mutations require the
same-origin, session-bound browser CSRF proof.

Rejected authentication-lease checks during agent-terminal startup emit a
server-only `webtty_auth_lease_rejected` audit entry with the fixed
`before_agent_prepare` or `after_agent_ready` phase and an allowlisted validation
reason. Unknown reasons are recorded as `unknown`; no credentials, session
fingerprints, or raw authentication data are included. These categories identify
the rejecting check, not necessarily its underlying cause, and do not change
authentication responses or startup cleanup.

An exception while confirming terminal reclamation emits a server-only
`webtty_reclamation_check_failed` audit entry containing only the target kind
(`box` or `agent`) and a fixed reason. Known reasons distinguish bounded proc
scan/file limits, access or I/O failures, malformed process evidence, and
identity changes; all other exceptions become `unknown`. Raw exceptions and
process or session identifiers are never included. Audit failures cannot delay
cleanup or change its result. This event identifies a failed check; it does not
prove the underlying cause or relax fail-closed cleanup and record retention.

WebTTY records exact Box or agent process evidence in the transient
`/run/ploinky/webtty` recovery directory using the v2 target-discriminated
schema. Startup recovery runs before the surface becomes available. Ambiguity
confined to one immutable agent target quarantines only that target; systemic
agent-provider evidence failure disables agent targets while leaving Box
terminals available. Unclassifiable or Box cleanup ambiguity fails all WebTTY
closed. Quarantines are never cleared by a timer. If retained evidence cannot
be reclaimed safely, recreate the exact managed Box with `ploinky destroy`
followed by the normal `ploinky start` workflow; recreation discards both the
ephemeral recovery records and nested runtime state while preserving the host
workspace and retained caches.

Box session enumeration overlaps at most four process-stat visits at a time.
It retains the one-second scan deadline, 8,192-entry limit, 64 KiB per-file
limit, and before/after process-start checks. A failed or expired scan cannot
start another batch or another stat read; pending file and directory handles
are still closed when their operations finish. Directory cleanup does not
extend the scan deadline. Agent startup-client enumeration remains serial.
This reduces serial I/O latency without treating incomplete process evidence
as successful reclamation.

Nested container records, writable layers, networks, and inner Podman named
volumes are discarded with the outer Box, so persistent agent data must use
explicit workspace binds. A Box created by an older layout, including the former
fixed `/workspace` mount, is not recognized and is not migrated: `ploinky start`
reports it as incompatible, and `ploinky stop` followed by `ploinky destroy`
removes it. For a `/workspace`-layout Box, `stop` still stops the outer Box but
reports that its in-Box stop could not run at the workspace path.

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
is mounted at its own absolute path rather than copied into engine storage. Ploinky
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
`0.0.0.0:<selectedMediaHostPort>:7882/udp`. Only an explicit `ploinky bind`
replaces the Router's loopback address with `0.0.0.0` or one IPv4 address of this
host, as described in
[Publishing the Router on a host network interface](#publishing-the-router-on-a-host-network-interface).
`--port` changes only the physical Router port. `--udp-port` changes only the physical media UDP port and defaults
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

Ploinky uses `<workspace>/achillesAgentLib` when that directory is present and
valid. It mounts the source read-only for the Box and all consumers, and never
pulls or rewrites the local checkout. An invalid local directory is an error.
When the directory is absent, the Box uses its bundled AchillesAgentLib copy at
`/opt/ploinky-agentlib`; the host does not clone a fallback repository. The bundle
must match `ploinky-box/dependencies.lock.json` and pass content verification.
An older image without a compatible bundle must be rebuilt or replaced, or a
valid local checkout supplied. Direct host `ploinky-local` development requires
a local checkout because the image bundle is available only inside the Box.

Start, full restart, and update select the source again. Adding or removing a
local checkout replaces the Box when the source changes. A targeted agent
restart keeps the admitted source. Bundled library updates require a new Box
image matching the required pin; general repository branch options do not
change the bundled revision.

## Publishing the Router on a host network interface

By default the public Router is reachable only through loopback on the machine
that runs Ploinky. To reach it from another computer without an SSH tunnel,
publish it on an interface of that machine:

```sh
ploinky bind                          # all IPv4 interfaces, current host port
ploinky bind 0:8083:8080              # all IPv4 interfaces, host TCP 8083
ploinky bind 192.168.1.50:8083:8080   # one IPv4 address assigned to this host
ploinky bind 127.0.0.1:8083:8080      # restore local-only access
ploinky --dry-run bind 0:8083:8080    # print the plan without changing anything
```

The mapping is `BIND_ADDRESS:HOST_TCP_PORT:IN_BOX_ROUTER_PORT`, and `0` means
`0.0.0.0`. A specific address must be a canonical IPv4 address assigned to the
machine running Ploinky, never the browser machine's address (the example
address above is illustrative). Host names are not resolved and IPv6 is not
supported. The last field must be `8080`, the public Router inside the Box; the
private Router port `8081` and agent ports are rejected. `8081` remains a valid
physical-host port, for example `0:8081:8080`.

Bind requires a configured workspace graph, so run `ploinky start AGENT` once
first. It keeps the graph's static agent and launch scope, the current Box
image, the mounted AchillesAgentLib generation, and the UDP media port. A
changed mapping recreates the Box through the normal replacement lifecycle,
because Podman cannot change the publications of an existing container. The
graph then restarts, briefly interrupting traffic, and bind waits until
`/health` answers through the bound address before it saves the binding. A
stopped graph or Box is started. Repeating an effective binding only verifies
health. Bind never pulls images; without an existing Box it uses the locally
present image. When a step fails, the previous publication, Box running state,
graph, and saved binding are restored. Before the old Box is replaced, other
listeners on the requested port are rejected, including listeners on other
interfaces when widening from loopback to `0.0.0.0` on the same port.

The binding is saved for this exact workspace as
`~/.ploinky-box/router-bindings/<box-instance>.json` with mode `0600`. It lives
outside the workspace because agents can write the workspace bind. `ploinky
start`, `restart`, `update`, commands that create a missing Box, and recreation
after `destroy` reuse it. A later `ploinky --port PORT start` keeps the saved
address and saves the new port. Without a saved binding a workspace stays
loopback-only; an unsafe or malformed saved binding fails closed. Ploinky refuses
workspace or writable cache paths that overlap its host control-state directory,
including symlinks and filesystem aliases, before admitting or creating a Box.

Publishing the port alone is not enough, because the Router rejects unknown
`Host` headers with `421 UNKNOWN_HOST`. For a non-loopback binding the host
supervisor records the exact outer host names the Router may accept in the Box
environment as `PLOINKY_PUBLIC_ROUTER_HOSTS`: the bound address, or for
`0.0.0.0` every non-loopback IPv4 address outside container bridges, plus this
machine's host name, its short name, and `<short>.local`. Those names reach the
same control surface as loopback. Other hosts are still rejected, and request
headers, the Box's own addresses, workspace `.env` or secret files, and agent
configuration cannot extend the list. Sessions, per-origin CSRF proofs,
agent-port WebSocket origins, and preserved application redirects bind to the
exact browser origin, for example `http://192.168.1.50:8083`. Because the
trusted names are part of the Box configuration, a later `start`, `restart`, or
`update` recreates the Box when this machine's addresses or name change. A
specific address that is no longer assigned must be bound again.

On native Linux when Podman selects pasta, the Box explicitly uses IPv4-only
pasta networking. This keeps an IPv4 wildcard binding from also accepting IPv6
`localhost` connections that the IPv4 Router cannot serve. Existing Boxes using
default pasta are recreated by the next lifecycle reconciliation; status and
teardown remain available, and a failed replacement can restore the previous
network contract. Podman Machine and configured slirp4netns retain their engine
network defaults.

Each routing generation captures that host list together with the selected outer
Router port as immutable source input, so a rebind, port change, or rollback
produces a different generation. The Router refuses an active generation that was
captured for another host list with `503 EDGE_GENERATION_RUNTIME_MISMATCH` until
the restarted graph commits its own. From the same inputs Ploinky derives the
exact direct-binding origins, for example `http://192.168.1.50:8083` and
`http://<hostname>:8083`, and publishes them as the sorted `routerOrigins` array
in the agent-readable edge topology. A loopback-only binding publishes an empty
array, the wildcard itself is never an origin, and a generation captured before
this field existed publishes none. The topology file is advisory, because it is
written before the routing selector commits. An agent that relies on these
origins for a decision reads them from the private listener with a fresh private
assertion, for example through `/Agent/lib/runtimeRouterOrigins.mjs`:
`GET /api/edge/runtime-origins` answers only from the active routing lease with
`{ schemaVersion, authorizationGeneration, activationId, routerOrigins }` and
`Cache-Control: no-store`, and fails closed with `503` while routing is inactive
or changing. Ploinky only reports these origins; each agent decides whether to
trust them. Cloudflare agent-root host names are not included.

After an in-place Ploinky source update, `ploinky start` checks the running
Router's generation-reader compatibility through its existing local health
socket. If the reader is older or cannot be verified, startup stops it and
verifies a replacement before preparing the new routing generation. A compatible
Router is reused. If replacement fails, startup leaves routing inactive and
does not publish the new generation format. A full `ploinky restart` also reloads
the Router; adding an agent alone is not a legacy-generation migration.

WebChat creates its tab and page identities with cryptographic browser randomness
on both loopback and plain-HTTP LAN origins; it does not require the
secure-context-only `crypto.randomUUID()` method.

Successful bind, `start`, `restart`, and `update` commands and `ploinky status`
print the effective binding and browser URLs; `0.0.0.0` is shown as the listen
address but never offered as a URL. The bind address is not a client access
rule: Router traffic is plain HTTP without TLS, so restrict who can reach the
port with the host firewall or a trusted network. Bind does not change firewall
rules, DNS, tunnels, or authentication settings, and it does not rewrite callback
URLs registered with an SSO provider.

## Core commands (in p-cli)

- `enable agent <name> [as <alias>]`: register an agent in `.ploinky/agents.json` (creates a minimal manifest if missing). Use `as <alias>` to spin up additional instances with unique container names.
- `update [folderPath]`: use the current directory as the update folder, or `folderPath` when supplied. A Ploinky checkout is pulled only when it is inside that folder or contains the launch folder. Ploinky being out of scope does not stop managed repositories, discovered project repositories, dependencies, or default skills from being refreshed. AchillesAgentLib is revalidated from the local checkout or the pinned Box bundle; update never pulls a local library checkout or clones a host fallback.
- `start <staticAgent> 8080`: first core start requires a static agent; subsequent runs can just use `start`.
  - Ensures all enabled agents are running and launches the fixed inner Router on `8080`. On the host-facing public wrapper, `ploinky start <agent> <port>` treats that positional port only as the physical-host port selection (loopback unless `ploinky bind` saved another address) and still forwards inner `8080` to core.
  - Serves static files from the repository of `<staticAgent>`; non `/<agent>/...` paths are static.
- `cli`: from the managed runtime, open `/bin/bash` as `podman` in the workspace directory (`PLOINKY_WORKSPACE_ROOT`).
- `cli <name> [args...]`: run the agent’s manifest CLI command interactively.
- `shell <name>`: open interactive `/bin/sh` in the agent container.
- WebChat is served by the running Router at `/webchat/`; the retired `webchat [--rotate]` CLI access command is no longer registered.
- `client tool <toolName> [--agent <agent>] [--parameters <params>] [-key value...]`: call an MCP tool exposed by an enabled agent.
- `client list tools|resources`: list MCP tools or resources exposed by enabled agents.
- `client status <agent>`: check agent health status.
- `logs tail [router|agent] [--startup]`: follow the Ploinky-owned Router file by default, or one agent from its current no-wait startup log through the automatic handoff to verified application output. `--startup` applies only to agents.
- `logs last [<N>] [router|agent] [--startup]`: show the last `N` lines (default 200, maximum 10000) for Router by default or one agent. Reading logs never creates, starts, or repairs a runtime.

Log completion offers one reference per enabled record and every offered reference round-trips to that record. Docker/Podman readers use immutable container IDs, while Bubblewrap/Seatbelt readers pin process-specific files; pre-cut sandbox processes require one restart and never fall back to legacy names. Application bytes are intentionally passed through unredacted, but control diagnostics are bounded and redact credentials. Cancellation waits for bounded TERM/KILL child cleanup before returning.
- `stop`: stop containers recorded in `.ploinky/agents.json` (do not remove).
- `shutdown`: stop and remove containers recorded in `.ploinky/agents.json`.
- `destroy`: stop the router, remove workspace containers, and clear `.ploinky/deps` while preserving isolated agent data in `.data/<agent-or-alias>`.
- `deps prepare [<repo>/<agent>]`: build the prepared node_modules cache for the current runtime.
- `deps status`: list prepared global and per-agent caches with their runtime keys and validity.
- `deps clean <repo>/<agent>|--global|--all`: remove a cache directory.

The `/status` TCP control surface requires a real router-authenticated
local-admin session on an exact local-control Host. A
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

The browser enables message and attachment submission only after the current
agent runtime reports that it is ready. Starting, failed, or disconnected
sessions cannot accept new input. A message marked `Sending…` is still awaiting
server admission; rejected input keeps its draft and selected attachments for
correction or retry instead of appearing as successfully sent.
Control requests such as cancellation consume the HTTP response before their
promise completes, including empty responses, so the browser can finish the
request before a caller navigates away. The response status is unchanged.

- WebChat sends structured message envelopes over stdin. Agents that want a reliable chat experience should expose a real CLI process that reads stdin continuously and writes replies to stdout.
- A manifest `cli` that points to a plain shell such as `"/bin/sh"` or `"/bin/bash"` does not become conversational by itself. In that setup WebChat mirrors raw input to the shell, and the shell may simply echo or mis-handle the incoming payload.
- The recommended pattern is a dedicated CLI entrypoint such as `node /code/main.mjs` that parses WebChat input and keeps running for the full session.
- `ploinky cli <agent>` and WebChat share the same manifest `cli`, so the same command must be suitable for both interactive terminal use and WebChat streaming input.
- At WebChat startup, the CLI receives `PLOINKY_WEBCHAT_HAS_HISTORY=1` when the selected conversation already contains messages, otherwise `0`. Agents that emit a new-conversation introduction should omit it when the value is `1`; Ploinky supplies the prior conversation context with the next normal user message.

## Cloud (preview)

The cloud component will allow hosting multiple custom apps built on Ploinky, each with its own agents and routes.

## License

MIT License - see [LICENSE](LICENSE)

Repository consumers can use the shared workspace-first discovery and symlink installation API described in [local instruction skills](docs/local-instruction-skills.md#shared-repository-installation).
