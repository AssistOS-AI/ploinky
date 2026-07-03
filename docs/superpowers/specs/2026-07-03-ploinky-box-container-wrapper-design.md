# ploinky-box: Run Ploinky Inside a Container — Design

Date: 2026-07-03
Status: Approved (brainstorming session, design sections signed off)

## 1. Purpose and context

Run the entire Ploinky runtime (CLI, router, agents) inside one container so that a
host needs nothing but podman or docker — with **isolation/security as the primary
goal**, winning any trade-off conflict. The wrapper detects the host engine, pulls
`assistos/ploinky-box` from Docker Hub, and runs it rootless. Agents run as *nested*
containers inside the box via rootless podman.

### Code couplings that shape the design (evidence from the feasibility trace)

| Coupling | Evidence | Design consequence |
| --- | --- | --- |
| Runtime detection = `command -v podman` then `docker`, hardcoded order, no env override | `cli/services/docker/common.js:85-104` | Ship podman inside the image; ploinky finds it unmodified |
| Agent `-v` sources are absolute paths on ploinky's own filesystem; workspace is mounted at the **same path** inside agent containers | `cli/services/docker/agentServiceManager.js:696-715`, `README.md:86` | The engine that runs agents must share ploinky's filesystem → nested engine inside the box (socket passthrough ruled out) |
| Router proxies agents at `127.0.0.1:<hostPort>`; agents publish on `127.0.0.1:<random>`; agents call back via `host.containers.internal` / slirp `allow_host_loopback` | `cli/server/routerHandlers.js:102-111`, `cli/services/docker/agentServiceManager.js:339-347,787-792,1308-1314` | Box loopback = "host" loopback for all of it; works unmodified inside the box |
| Router `server.listen(port)` binds **all interfaces** (log string says 127.0.0.1 but no hostname arg is passed) | `cli/server/RoutingServer.js:670-673` | Publishing the router port out of the box works |
| `.ploinky` records absolute paths (`agents.json` projectPath/binds, `routing.json` hostPort/container) | `cli/services/docker/agentServiceManager.js:1001-1023`, `cli/services/agents.js:406-415` | Workspace volume must mount at a **fixed path** (`/workspace`) every run |
| `git` invoked at runtime (`.ploinky/repos` clones, updates) | `cli/services/repos.js:290-305` | Image ships git |
| `achillesAgentLib` is a git submodule pinned by gitlink, but npm `postinstall` clones moving `master`; declared npm bin `p-cloud` doesn't exist; real launchers are `bin/ploinky`, `bin/p-cli`, `bin/psh` | `package.json:7-14`, `.gitmodules`, `bin/ploinky:3-23`, `cli/index.js:19-28` | Bake from a git checkout **with submodules**, `npm install --ignore-scripts`; never `npm install ploinky` from a registry |
| `additionalServerPort` WebSocket path (`container` mode) dials the agent container's bridge IP from `podman inspect` | `cli/server/profileServerProxy.js:26-72` | Known limitation under rootless podman (IPs absent/unroutable); verify in smoke, document `host`-mode workaround |

## 2. Decisions (locked during brainstorming)

| Decision | Choice |
| --- | --- |
| Primary purpose | Isolation / security (wins conflicts) |
| Privileges | Rootless nested podman; **never** `--privileged`, never auto-escalate |
| Wrapper form | Single-file bash script in the ploinky repo (`container/ploinky-box`) |
| Image build | Baked at build time, pinned (submodule checkout; `npm install --ignore-scripts`) |
| Base image | `quay.io/podman/stable` + Node 24 copied from `node:24-bookworm-slim` (Approach A) |
| Persistence | Named volumes (workspace + inner container storage) + opt-in `--mount` escape hatch + `cp` subcommand |
| Instances | Default instance + `--name X` prefix for additional isolated instances |
| Distribution | Full GitHub Actions pipeline in `AssistOS-AI/container-image-builds`, publishing `assistos/ploinky-box` to Docker Hub |

## 3. Deliverable A — image (`container-image-builds` repo)

Follows the repo's external-source pattern (`bwrap-runner`, `livekit-server-agent`,
`soul-gateway`): Dockerfile + workflow live here; source is checked out at build.

### 3.1 `images/ploinky-box/Dockerfile`

- `ARG PODMAN_BASE=quay.io/podman/stable` — upstream-maintained rootless-nesting
  config (podman user, subuid/subgid, fuse-overlayfs, storage/containers.conf).
- `ARG NODE_RUNTIME_IMAGE=docker.io/library/node:24-bookworm-slim`; multi-stage
  `COPY --from` of the node runtime (`/usr/local/bin/node`, `/usr/local/lib/node_modules`,
  npm/npx symlinks) — same trick as `images/onlyoffice-agent/Dockerfile`. Bookworm's
  glibc 2.36 binary runs on the newer-glibc Fedora base.
- `dnf install -y git` (agent repo clones at runtime) then clean dnf caches.
- `COPY sources/ploinky /opt/ploinky` (build context is the workflow's checkout,
  which includes the pinned `node_modules/achillesAgentLib` submodule).
- `RUN cd /opt/ploinky && npm install --ignore-scripts` — resolves the `mcp-sdk`
  GitHub dependency; `--ignore-scripts` skips the postinstall that would clone
  achillesAgentLib `master` over the pinned checkout (and would in fact fail —
  `git clone` into an existing non-empty dir errors).
- `ENV PATH=/opt/ploinky/bin:$PATH` (`bin/ploinky` resolves `PLOINKY_ROOT` from its
  own location via `readlink -f`, so `/opt/ploinky` is self-consistent).
- Pre-create `/workspace` and `/home/podman/.local/share/containers`, `chown` both
  to `podman:podman` — named-volume copy-up then gives the volumes correct ownership
  on first use under both engines.
- `USER podman`, `WORKDIR /workspace`.
- `COPY images/ploinky-box/entrypoint.sh /usr/local/bin/ploinky-box-entrypoint`;
  entrypoint runs a self-check (`podman info`, node/git present, `/workspace`
  writable) — on failure prints a named diagnostic (missing `/dev/fuse`, seccomp,
  subuid) and exits nonzero; on success idles (`exec sleep infinity`). Ploinky
  commands arrive via `exec`.

### 3.2 `.github/workflows/publish-ploinky-box-image.yml`

Mirrors `publish-bwrap-runner.yml` with these specifics:

- `workflow_dispatch` inputs: `source_ref` (default `master` — ploinky's verified
  GitHub default branch), `image_tag` (default `podman-node24`).
- Checkout `AssistOS-AI/ploinky` under `sources/ploinky` with **`submodules: true`**
  (pins achillesAgentLib at the recorded gitlink) and
  `token: ${{ secrets.SOURCE_REPO_TOKEN || github.token }}`.
- Resolve short SHA from `sources/ploinky`; tags: `<image_tag>` and `<image_tag>-<sha>`
  via `docker/metadata-action@v5`.
- Build context `.` (repo root) with `file: ./images/ploinky-box/Dockerfile` so the
  Dockerfile can `COPY sources/ploinky` and its own `entrypoint.sh`.
- `platforms: linux/amd64,linux/arm64`, `provenance: false`, Docker Hub login as
  `assistos` with `DOCKERHUB_TOKEN`.
- **Verify step before push** (loads the single-platform image locally, precedent:
  `soul-gateway`, `llm-runtime-cpu` verify steps): run with the real runtime flags
  (`--user podman --device /dev/fuse --security-opt seccomp=unconfined`) and assert
  `node -v`, `git --version`, `podman --version`, `test -x /opt/ploinky/bin/ploinky`,
  `test -d /opt/ploinky/node_modules/achillesAgentLib`,
  `test -d /opt/ploinky/node_modules/mcp-sdk`. Best-effort nested check
  (`podman run --rm docker.io/library/alpine echo nested-ok`) is non-blocking in v1;
  promote to blocking once proven stable on GitHub runners.

### 3.3 Repo bookkeeping

- README image table row: `assistos/ploinky-box:podman-node24` | `AssistOS-AI/ploinky`
  | repo root (checkout under `sources/`) | `images/ploinky-box/Dockerfile` |
  `publish-ploinky-box-image.yml`; plus a Manual Publishing snippet.
- New test block in `tests/image-definitions.test.mjs` asserting the workflow/Dockerfile
  invariants above (see §7).

## 4. Deliverable B — wrapper (`ploinky` repo)

`container/ploinky-box` — single-file bash, no dependencies beyond the engine;
curl-able onto a bare host. `container/README.md` documents usage and limitations.

### 4.1 Engine detection

`PLOINKY_BOX_ENGINE` env or `--engine podman|docker` override; otherwise probe
`podman` then `docker` (mirrors ploinky's own order). macOS preflight: for podman,
`podman machine inspect` must show a running machine; for docker, `docker info`
must succeed. Failures print the exact start command.

### 4.2 Container run profile (isolation contract)

```
<engine> run -d --init --name ploinky-box[-NAME] \   # --init: reap zombies from detached in-box processes
  --user podman \
  --device /dev/fuse \
  --security-opt seccomp=unconfined \
  [--security-opt label=disable]           # only when the ENGINE reports SELinux enabled (engine info query, never client getenforce)
  -p 127.0.0.1:<PORT>:8080 \               # 0.0.0.0 only with --listen-lan
  -v <instance>-workspace:/workspace \
  -v <instance>-containers:/home/podman/.local/share/containers \
  [-v HOSTDIR:/workspace/mounted]          # only with explicit --mount HOSTDIR
  -e PLOINKY_WORKSPACE_ROOT=/workspace \   # pins state location regardless of exec cwd
  assistos/ploinky-box:podman-node24
```

No `--privileged`, ever. If the engine rejects the flags, the wrapper reports the
engine/version requirement and exits — it must not weaken the sandbox to proceed.

### 4.3 Subcommands

| Command | Behavior |
| --- | --- |
| `up [--name X] [--port N] [--image I] [--mount DIR] [--listen-lan] [--engine E]` | Preflight, pull image if absent, create volumes + container, wait for entrypoint self-check to pass (container stays running + `exec true` succeeds); surface self-check diagnostics verbatim on failure |
| `cli [--name X]` | `exec -it` interactive ploinky console (`p-cli`) in `/workspace` |
| `run [--name X] <args…>` | One-shot `ploinky <args>` inside the box (e.g. `run start demoAgent 8080`) |
| `cp [--name X] <src> <dst>` | Engine `cp` in/out; the sanctioned isolation crossing (`box:` prefix marks the container side) |
| `status [--name X]` | Container state + `curl -sf http://127.0.0.1:<port>/status` result |
| `logs [--name X]` | Tail router log from the workspace volume (`.ploinky/logs`) |
| `stop [--name X]` | Stop container; volumes untouched |
| `update [--name X]` | Pull newer image, recreate container with same flags; volumes survive; note that agents must be resumed with `run start` |
| `destroy [--name X]` | y/N confirmation, then remove container **and both volumes** |

Naming is deterministic: the instance name is `ploinky-box` by default and
`ploinky-box-X` with `--name X`; the container is named exactly the instance name,
and the volumes are `<instance>-workspace` and `<instance>-containers`
(e.g. `ploinky-box-workspace`, or `ploinky-box-X-workspace`). Each instance needs
its own `--port`.

## 5. Runtime behavior

- First use: `up` then `cli` → `enable repo/agent`, `start <agent> 8080` — ploinky
  writes `.ploinky/` on the workspace volume, spawns Watchdog → RoutingServer as
  node processes inside the box, starts agents via inner rootless podman.
- Inner networking is stock ploinky: agents publish on box-loopback random ports;
  router proxies `127.0.0.1:<hostPort>`; agent→router callbacks resolve to box
  loopback (`host.containers.internal` / slirp `allow_host_loopback=true`).
- Agent images are pulled by inner podman into the `X-containers` volume — first
  agent start is slow, later starts warm; survives `stop`/`update`/reboot.
- Resume semantics: identical to native ploinky. Workspace state (absolute paths
  under `/workspace`) is stable across container recreation, so
  `ploinky-box run start` restarts previously enabled agents.
- Isolation crossings are explicit only: published router port (loopback by default),
  `cp`, and opt-in `--mount` (documented as isolation-piercing; on macOS the host
  dir must be inside the podman-machine/Docker Desktop share).

## 6. Error-handling policy

Fail loud with remediation; never degrade isolation silently (§4.2). The
entrypoint self-check is the single source of in-box diagnostics so `up` can
surface root causes verbatim. Specific cases:

| Failure | Handling |
| --- | --- |
| No engine on host | Exit with install pointers; `--engine`/`PLOINKY_BOX_ENGINE` respected |
| macOS engine VM not running | Print the exact start command (`podman machine start` / start Docker Desktop) |
| Image pull fails | Name the fix: `gh workflow run publish-ploinky-box-image.yml --repo AssistOS-AI/container-image-builds`, or `--image` override; no local-build fallback in v1 |
| Nested podman broken inside box | Entrypoint self-check exits nonzero naming the missing piece (`/dev/fuse`, seccomp, subuid); `up` health-wait surfaces it verbatim |
| Container name collision | Detect existing container; offer restart instead of erroring blindly |
| Host port busy | Detect and suggest `--port` |
| Engine rejects rootless flags | Report engine/version requirement and exit — never fall back to `--privileged` |

## 7. Testing and acceptance criteria (runnable)

1. **Definition tests** — `container-image-builds`: `node --test tests/` passes,
   including a new `ploinky-box` block asserting: workflow has
   `repository: AssistOS-AI/ploinky`, `submodules: true`, `path: sources/ploinky`,
   `file: ./images/ploinky-box/Dockerfile`, `IMAGE_NAME: assistos/ploinky-box`,
   `docker/login-action@v3`, `docker/build-push-action@v6`,
   `platforms: linux/amd64,linux/arm64`; Dockerfile has
   `ARG PODMAN_BASE=quay.io/podman/stable`, a `COPY --from` node runtime line,
   `npm install --ignore-scripts`, `USER podman`, `/opt/ploinky`.
2. **Workflow verify step** — blocking assertions listed in §3.2 run in CI on the
   built image before push.
3. **End-to-end smoke** — `ploinky/container/smoke-box.sh` on a real machine
   (macOS + podman machine, and a Linux host):
   `up` → `run` enable+start of a demo agent → `curl -sf http://127.0.0.1:8080/status`
   → `cp` round-trip → `stop` → `up` → verify resumed state → `destroy`.
   All steps exit 0; the script prints PASS/FAIL per step.
4. **WebSocket check** — within the smoke run, exercise an agent with
   `additionalServerPort` in `container` mode; record outcome in `container/README.md`
   (expected: works only in `host` mode under rootless inner podman).

## 8. Known limitations and risks (to verify during implementation)

- Rootless-in-rootless (host rootless podman/podman machine → box → inner rootless
  podman) is the least-tested stack; the smoke test on macOS is the gate. Fallback
  knob if inner storage misbehaves: switch inner storage driver to `vfs` via a
  mounted `storage.conf` (slow but correct).
- `additionalServerPort` `container` mode dials inspect-derived bridge IPs —
  expected unavailable under rootless inner podman (parity with rootless hosts,
  not a box regression); `host` mode is the workaround.
- GitHub runner support for the nested `podman run` verify step is unproven —
  starts non-blocking.
- `npm install --ignore-scripts` also skips `mcp-sdk`'s own lifecycle scripts if it
  has any. The workflow verify step only asserts presence
  (`test -d /opt/ploinky/node_modules/mcp-sdk`); the end-to-end smoke (§7.3) is the
  authoritative check that ploinky actually runs with the scripts-skipped install.
- `lite-sandbox: true` agents resolve to bwrap on Linux (`cli/services/docker/common.js:634-663`);
  bwrap inside the box would need nested userns — out of scope; documented as
  unsupported in the box for v1.

## 9. Out of scope (v1)

- Local image build fallback in the wrapper (Dockerfile lives in `container-image-builds`).
- Multi-instance registry/list UX beyond `--name` prefixes.
- Auto-start of agents on `up` (explicit `run start` keeps behavior predictable).
- Docker-in-Docker / `--privileged` mode of any kind.
- Windows hosts.
