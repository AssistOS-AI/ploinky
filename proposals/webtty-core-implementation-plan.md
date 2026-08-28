# Implementation Plan: Return WebTTY to Ploinky Core

Status: proposed; no implementation has been performed.

Plan date: 2026-08-27.

Implementation baseline: Ploinky default branch `master` at `021d9a91626d50486e32d95b0897efdb7fe8d819` (`Merge agentlib-direct-mount into master`).

This is a hard cut. It deliberately provides no compatibility route, migration, deprecated manifest, fallback image, or dual-running period. `basic/webtty` and its separately published image are deleted once the replacement Box build is proven. The supported end state is a Ploinky Router-owned administrative terminal whose native `node-pty` dependency is part of `ploinky-box` and whose shell sees the same complete workspace bind from which Ploinky was started.

## 1. Prerequisite and baseline

The requested prerequisite is already satisfied:

| Check | Verified state |
| --- | --- |
| Ploinky default branch | `master` |
| Current checkout | `master` at `021d9a91626d50486e32d95b0897efdb7fe8d819` |
| Merge commit subject | `Merge agentlib-direct-mount into master` |
| Feature tip | `agentlib-direct-mount` at `9ab08acf84dcb43090e6b0af860597f947b668ec` |
| Ancestry | `agentlib-direct-mount` is an ancestor of `master` |
| Additional merge needed | No |

The merged branch changes agent runtime mount/authentication behavior but does not introduce a WebTTY runtime, change Watchdog's one-Router-child model, or change the Box's `/workspace` bind. This plan therefore uses the merged behavior as its starting point without adding a redundant merge commit.

Before any implementation edit, fetch the current default branch, switch to `master`, update it by fast-forward only, and re-prove that `agentlib-direct-mount` remains an ancestor. Then create and switch to a new `feature/webtty-core` branch from that verified `master` tip. Put every Ploinky implementation commit for this plan on that branch; do not implement directly on `master`. Record the exact branch point in the cross-repository revision map because `master` may have advanced beyond the planning baseline by implementation time.

## 2. Required outcome

The implementation is accepted only when all of these statements are true:

1. The physical directory passed to Ploinky as its workspace remains mounted read/write at `/workspace` inside `ploinky-box`. It is the same filesystem content at a translated container path, not a copy.
2. Opening a terminal without `dir` starts at `/workspace`. Opening one for Explorer directory `src/api` starts at `/workspace/src/api` after server-side canonicalization and containment checks.
3. The shell can read and write the entire workspace bind, including all repositories and workspace-owned hidden state allowed to the Box user. It cannot see arbitrary physical-host paths that were not mounted into the Box.
4. The shell runs as the existing unprivileged `podman` Box user. WebTTY adds no root process, privileged container, host engine socket, additional bind, Linux capability, or widened publication.
5. `node-pty` is compiled natively on every supported architecture and installed directly in the immutable `assistos/ploinky-box` filesystem. It is not installed at workspace startup, placed in the mutable dependency cache, or supplied by a helper image.
6. `RoutingServer` owns `/webtty`, browser authentication, administrator authorization, mutation security, terminal quotas, output streaming, route-generation binding, and terminal lifecycle.
7. Each terminal uses a small Router child worker connected through Node's private built-in IPC channel. The worker owns one `node-pty` instance. There is no long-lived WebTTY broker, Unix-socket HTTP service, TCP listener, or Watchdog state-machine expansion.
8. A Router shutdown or crash closes its IPC pipes; workers terminate their PTYs and exit. Router startup also reclaims only precisely verified stale WebTTY processes recorded in the Box's ephemeral runtime directory.
9. Explicit logout/revocation, session expiry, loss of the administrator role, route-generation replacement, terminal timeout, browser close, worker failure, and Box shutdown all invalidate the affected terminal within defined bounds.
10. `basic/webtty`, the port-7681 route, the `assistos/webtty-agent` source/workflow, Explorer's WebTTY agent dependency, and stale listener-profile entries are gone with no fallback.
11. An old `ploinky-box` that lacks the immutable native runtime contract is rejected during Box admission before Router starts. The workspace must rebuild, pull, and recreate the Box with a compatible image; Ploinky never downloads or compiles the missing addon at runtime. This strict incompatibility is intentional for the hard cut. Compatibility remains keyed only to the stable WebTTY native contract, so unrelated Ploinky source commits do not require a new Box image.

## 3. Filesystem and trust boundary

Current Box mount behavior establishes the access model:

| Host or source location | Box location | Mode | WebTTY consequence |
| --- | --- | --- | --- |
| Resolved Ploinky workspace | `/workspace` | Read/write | The administrative shell sees the entire selected workspace |
| Ploinky source checkout | `/opt/ploinky` | Read-only | Router and worker JavaScript come from the running checkout |
| Workspace dependency cache | `/opt/ploinky/node_modules` | Read/write bind | Native WebTTY files must not be installed here because image contents would be hidden and mutable |
| Image-owned WebTTY runtime | `/usr/local/lib/ploinky/webtty` | Immutable image layer | Correct location for `node-pty` and its production dependencies |
| Image-owned runtime metadata | `/usr/local/share/ploinky/webtty/runtime-contract.json` | Immutable image layer | Self-contained admission evidence for the native bundle |
| Ephemeral WebTTY records | `/run/ploinky/webtty` | Box-local, mode `0700` | Crash-recovery metadata only; never workspace-persistent |

An administrator receiving this shell is a trusted Box/workspace operator. The shell can also inspect other Box-visible paths and invoke tools already available to the `podman` user, including rootless nested-container commands. This design is not a containment boundary against a malicious administrator. It does not give access to unmounted host files or the outer container engine. A future requirement for “workspace files and nothing else” would require a separate mount namespace or sandbox and is outside this plan.

## 4. Verified history and cutover boundary

| Date | Repository and commit | Change |
| --- | --- | --- |
| 2025-09-08 | Ploinky `9d362fc66da8020d099ef24e70bf7dd45494a7b7` | Introduced the original core WebTTY server, UI, and `node-pty` dependency |
| 2026-06-23 | `basic` `3ec8378ed9d748ff29f74cb879a78531869f548b` | Introduced `basic/webtty` as an agent |
| 2026-06-23 | `container-image-builds` `629402f25a883c47729be0f125af50f733b525f2` | Added the independently published WebTTY agent image |
| 2026-06-23 | Explorer `912f739e797ce9273e66a9aa6efde173b64c806c` | Added **Open Terminal Here** through the agent-port route |
| 2026-06-23 | Ploinky `704fbea071f08b1f49949db6f08e88400ea32c24` | Removed core WebTTY, its Router surface, dependency, UI, commands, and tests |

The current `basic/webtty` manifest mounts `.` at `/workspace`. In an Explorer deployment, that resolves to the overall Ploinky workspace, so the old agent already sees the full workspace bind rather than only the `basic/webtty` source directory. It sees that bind plus its own container filesystem; it does not see arbitrary host paths or every filesystem layer of other containers. The new design preserves the intended full-workspace access while eliminating the separate agent/container and its independent cookie/TCP trust model.

## 5. Target architecture

```text
authenticated administrator browser
              |
              | same-origin HTTPS /webtty/*
              v
RoutingServer inside ploinky-box
  - named/reserved Router surface
  - authentication, admin authorization, CSRF/generation checks
  - session ownership, quotas, SSE buffering, auth-lease validation
              |
              | child_process.fork; private Node IPC; one worker/terminal
              v
terminal-worker.mjs inside the same Box
  - scrubbed environment
  - loads immutable /usr/local/lib/ploinky/webtty/node_modules/node-pty
  - owns exactly one PTY and no browser credentials
              |
              v
/bin/bash as unprivileged Box user
  cwd=/workspace/<validated relative directory>
```

The process split is crash and cleanup isolation, not a security boundary. The Router remains authoritative. A worker accepts only a small typed IPC protocol and has no listener, cookie parser, routing state, or permission to create additional terminal sessions.

This intentionally does not add a Watchdog-owned broker. Current `Watchdog` supervises one child, `RoutingServer`, and its restart/backoff/shutdown state assumes that shape. `RoutingServer` already owns and cleans up other child sessions through its lifecycle hooks. Per-terminal workers preserve native-addon isolation without rewriting Watchdog or keeping an idle service alive.

## 6. Repository ownership and source layout

| Repository | Responsibility after the cut |
| --- | --- |
| `ploinky` | Native runtime contract expected by source, terminal worker/protocol, Router manager/API/UI, auth leases, route surface, lifecycle, Box admission, tests |
| `container-image-builds` | Compile and install the locked native addon in `ploinky-box`; delete the independent WebTTY image/workflow |
| `AssistOSExplorer` | Same-origin launcher, administrator-only presentation, selected `webtty` Router surface; remove `basic` dependency if no other use remains |
| `basic` | Delete the WebTTY agent, tests, and current documentation entries |

Recommended Ploinky layout:

```text
core-services/webtty/
  package.json                  # private; exact node-pty dependency
  package-lock.json
  worker-protocol.mjs           # typed messages, protocol ID, limits
  native-runtime.mjs            # absolute loader and image-contract validation
  terminal-worker.mjs           # one PTY per process
  cwd.mjs                       # realpath containment rules
  environment.mjs               # explicit worker/shell env allowlists
  process-identity.mjs          # /proc identity and safe group cleanup

cli/server/webtty/
  sessionManager.mjs            # Router-owned sessions, quotas, streams, cleanup
  workerClient.mjs              # bounded IPC adapter
  authLease.mjs                 # continuous auth/session/admin validation
  runtimeRecords.mjs            # atomic ephemeral orphan records/recovery
  webtty.html
  webtty.css
  webtty.js
  vendor/                       # pinned xterm assets, checksums, licenses

cli/server/handlers/
  webtty.js                     # public same-origin Router handler
```

Names may follow existing local conventions during implementation. The ownership boundaries may not change: Router owns authority and browser state; each worker owns one PTY; the Box image owns only the native dependency; Watchdog continues to own only Router.

## 7. Step 1 — freeze the source and native contracts

Create `worker-protocol.mjs` before runtime code. Give every message a protocol identifier, exact type, terminal correlation ID, and bounded payload. Permit only these directions:

| Direction | Message | Purpose |
| --- | --- | --- |
| Router to worker | `init` | Supply validated cwd, dimensions, shell config, terminal ID, and shell environment exactly once |
| Router to worker | `input` | Write one bounded string after initialization |
| Router to worker | `resize` | Apply bounded integer rows/columns |
| Router to worker | `close` | Begin idempotent graceful termination |
| Worker to Router | `ready` | Report native-contract success and the verified PTY identity |
| Worker to Router | `output` | Deliver one bounded output chunk with monotonically increasing sequence |
| Worker to Router | `exit` | Report exit code/signal and cleanup category once |
| Worker to Router | `error` | Report a redacted category; never terminal data, environment values, or stack details to the browser |

Reject unknown message types, extra fields where practical, pre-init messages, duplicate init, oversized input/output, invalid resize values, and protocol mismatches. `disconnect`, parent IPC EOF, uncaught exception, unhandled rejection, and termination signals all enter the same idempotent cleanup path.

Keep the native contract distinct from the full Ploinky commit. The image build records its source SHA for provenance, but runtime compatibility is based on a stable WebTTY runtime schema, Node module ABI, OS/architecture, exact `node-pty` version, package-lock SHA-256, and native artifact SHA-256. Unrelated Ploinky commits must not require a new Box; a native dependency/ABI contract change must.

Start the implementation spike with the retired image's exact `node-pty` `1.0.0` dependency, not a caret range. Keep it only if native Fedora/Node 24 tests pass on amd64 and arm64. If it fails, select a specific proven version, update and review the lockfile, and record the evidence. Never resolve a version dynamically during image build.

Exit gate: protocol tests reject malformed/out-of-order/oversized messages, and a native spike proves the selected exact dependency on both architectures before cleanup repositories are changed.

## 8. Step 2 — package `node-pty` inside `ploinky-box`

Restructure `container-image-builds/images/ploinky-box/Dockerfile` into explicit stages:

1. `prepared-rootfs-base` retains the current Fedora/Podman rootfs, pinned Node 24 runtime, required runtime libraries, Box user, entrypoint, environment, and directories.
2. `webtty-builder` starts from that exact rootfs, adds only the native compiler toolchain and npm build prerequisites, copies `sources/ploinky/core-services/webtty/package.json` and its lockfile, and runs `npm ci --omit=dev` natively.
3. The builder runs a real native probe: absolute import, spawn shell, read marker, write input, resize, observe exit, and verify no test PTY remains.
4. `prepared-rootfs` receives only the production dependency tree at `/usr/local/lib/ploinky/webtty/node_modules` plus a self-contained probe and immutable `runtime-contract.json`. It receives no compiler, headers, npm cache, credentials, Git data, or build workspace.
5. The final `FROM scratch` stage copies the prepared rootfs exactly as today. Add no WebTTY `EXPOSE`, port publication, volume, label, entrypoint, or environment variable.

The publishing workflow already checks out an exact Ploinky revision beneath `sources/ploinky` and builds natively on amd64 and arm64, so the Dockerfile can consume the committed lockfile without a helper repository or helper image. Preserve that exact-source provenance in the generated runtime contract.

The current Box rootfs already creates `/usr/local/bin/npm` and `/usr/local/bin/npx` symlinks to the copied Node distribution. The builder can therefore invoke `npm ci` directly; do not install a second npm, add a network-time bootstrap, or introduce an alternate invocation fallback.

Update the existing source-boundary assertions deliberately. `tests/box-transport-entrypoint.test.mjs` currently requires the Dockerfile to consume only Ploinky's canonical entrypoint; change that invariant to allow only the canonical entrypoint plus the exact WebTTY package, lockfile, and self-contained native probe inputs. It must still reject copying Router/application source into the image. Update the matching assertions in `tests/image-definitions.test.mjs` and the README's source-contract description.

Preserve the existing versionless Box-identity guard rails while doing so: the `assistos/ploinky-box` marker remains unversioned, final `Config.Labels` remains empty, and the third `box-transport-entrypoint` test continues to forbid `runtime-contract` coupling in `reproduce-ploinky-box-private-routing.yml`. The in-image WebTTY contract file is private capability evidence, not a public Box version, label, tag, or identity. Do not put WebTTY contract logic in the reproduce workflow.

The per-architecture native evidence runs inside the Dockerfile build on the existing native amd64 and arm64 publication runners. Preserve the successful probe in each native build log/provenance record. Keep the publication workflow free of a separate ad hoc behavioral step: the native PTY smoke is a required image-build invariant, so a failed smoke prevents that architecture's digest from being produced.

Add a dedicated Box admission probe rather than overloading the existing binary-list probe. `ploinky-box/contract/image.mjs` should execute the image-owned probe with networking disabled and compare:

| Field or behavior | Required proof |
| --- | --- |
| Runtime schema | Exact supported schema |
| Node ABI/major | Matches the Box Node runtime expected by the worker |
| Platform/architecture | Matches the running Box image |
| Package lock | Exact SHA-256 of the Ploinky WebTTY lockfile |
| `node-pty` | Exact version and successful absolute import |
| Native artifact | Recorded SHA-256 exists and matches the installed `.node` file |
| PTY operation | Create, input, output, resize, exit, reap all succeed |
| Image metadata | Existing user/workdir/entrypoint/env/labels/volumes contract is unchanged |
| Network boundary | Still only Router loopback TCP and LiveKit UDP are publishable |

Run this validation for newly pulled/built images and for an already-present image before it is admitted for the current runtime contract. Extend `inspectAndValidateExistingImage()` in `ploinky-box/contract/image.mjs`, which currently checks configuration and immutable image identity without executing the container probe, and exercise that seam through `validateExistingImage` transaction tests. Recheck that the probed image ID is the exact inspected/admitted ID; never replace an existing-image validation with a tag-only check.

A missing, tampered, or incompatible bundle is a Box-admission error. No Router is started and no route from that Box is served until a compatible image is built or pulled and the Box is recreated. Emit expected-versus-observed contract categories and the immutable image identity, never an instruction to run npm. The check does not compare the complete Ploinky source SHA: once the stable native contract matches, unrelated source commits continue to use the admitted image.

Exit gate: both native architectures pass the image probe and image-definition tests prove there is no compiler/cache residue or new publication.

## 9. Step 3 — implement the one-PTY worker

`terminal-worker.mjs` is launched only after the outer Box lifecycle has admitted the native bundle and Router has started. It must:

1. Start via `child_process.fork` with `detached: false`, one IPC descriptor, ignored stdin, and bounded/captured diagnostics. It must not inherit Router's ordinary environment.
2. Load `node-pty` through an absolute `createRequire` rooted in `/usr/local/lib/ploinky/webtty`; do not use `NODE_PATH` or upward module resolution.
3. Accept exactly one `init`, create exactly one PTY, and reject every operation after terminal exit or close begins.
4. Use `/bin/bash` and the validated cwd. Do not accept an executable, argv, environment key, command string, or physical path from the browser.
5. Give the shell only an explicit allowlist such as `HOME`, `USER`, `LOGNAME`, `SHELL`, a fixed minimal `PATH`, `TERM`, `COLORTERM`, `LANG`/`LC_ALL`, and `PLOINKY_WORKSPACE_ROOT`. Never spread `process.env`; never pass routing credentials, tunnel tokens, session cookies, auth headers, agent credentials, npm credentials, or arbitrary workspace variables.
6. Chunk output to the protocol bound. Honor Router pause/resume backpressure if supported by the selected `node-pty`; otherwise terminate the session on a hard high-water violation rather than allocate unbounded memory.
7. Report PTY PID plus Linux process start token/session/group evidence. Treat this as cleanup evidence, never as browser-visible data.
8. On close or IPC EOF, stop input, dispose/kill the PTY, wait a bounded grace interval, and kill only a process group whose PID, start token, session/group relationship, and recorded terminal identity are still proven.

Before relying on group cleanup, add a Linux/Fedora spike that records the actual `forkpty` PID/session/group topology for the selected `node-pty`. Use its native process-group behavior if proven. Add a fixed launcher only if the spike demonstrates it is necessary; do not assume that `setsid` flags produce the desired leader identity. Never send a negative-PID signal without revalidating the group leader immediately before the signal.

Ordinary terminal descendants in the verified PTY session/group must be reaped. A trusted administrator can deliberately daemonize into a new session or start a persistent nested container; process-group cleanup is not a security boundary and must not be described as one.

Exit gate: worker component tests cover init, input, resize, output, normal exit, signal exit, malformed IPC, Router disconnect, worker crash, bounded diagnostics, environment scrubbing, and verified safe cleanup.

## 10. Step 4 — add Router session management and crash recovery

Add one `WebttySessionManager` to `RoutingServer` global state. It creates workers lazily, so there is no WebTTY service process when no terminal exists. Register `closeAll()` through the existing process-lifecycle `beforeClose` hook; do not modify Watchdog's child/restart model. Treat `beforeClose` only as an opportunistic graceful-shutdown fast path: uncaught exceptions do not currently guarantee shutdown through that hook, and SIGKILL cannot run it. Worker cleanup on parent IPC EOF and verified startup recovery records are the authoritative crash-safety paths.

Resolve the starting directory before allocating a quota slot or forking a worker, and repeat the containment check in the worker immediately before `node-pty.spawn`:

1. The browser parses the query with `URLSearchParams` once and sends the resulting string in JSON. The Router treats that JSON value as already decoded and never performs a second percent-decoding pass.
2. Missing, empty, and `.` mean the workspace root. Apply a fixed UTF-8 byte-length limit before filesystem work.
3. Reject NUL, backslash ambiguity, POSIX absolute paths, Windows drive/UNC forms, and any `..` segment before normalization. The browser cannot supply an executable, argv, environment, or physical host path.
4. Resolve and cache the real path of the fixed Box root `/workspace`. Resolve the lexical candidate beneath that root, call `realpath`, require a directory, and accept only when the result equals the workspace real path or starts with `${workspaceReal}${path.sep}`. This rejects a starting-directory symlink that escapes the workspace.
5. Preserve a normalized relative form for audit/UI and pass that form—not a browser-supplied absolute path—to the worker. The worker repeats the root/candidate `realpath` and containment proof to catch changes between request validation and spawn.

This check selects a safe initial cwd; it is not a filesystem sandbox after the trusted administrator receives a shell. Tests must distinguish literal percent characters from double-encoded traversal attempts and must cover a directory or symlink changed between the Router and worker checks.

For every terminal, keep a Router-memory record containing only:

| Binding | Purpose |
| --- | --- |
| Random public session ID | Unguessable browser handle; never a PID or worker ID |
| Authenticated user and auth-session fingerprint | Enforce same principal and same login session |
| Auth lease | Revalidate expiry, revocation, and administrator role continuously |
| Public route host/key and edge generation | Prevent cross-host and stale-generation reuse |
| Router epoch | Invalidate every ID after Router restart |
| Worker child identity and PTY process evidence | Exact cleanup without PID-only killing |
| Cwd relative form | Audit and display without leaking a host path |
| Output sequence/ring buffer and stream owner | Bounded SSE reconnect without creation |
| Timers/counters | Idle, absolute lifetime, rate, and quota enforcement |

Use per-auth-session, per-user, and Box-global terminal limits plus creation/input rate limits. Count a session before forking and release the slot exactly once on every failure path. Bound IPC queues, SSE buffers, replay buffers, diagnostics, request bodies, and terminal dimensions. One live stream per terminal is sufficient; a reconnect can replace the previous stream after the same ownership checks. `Last-Event-ID` may replay only still-buffered sequence numbers; a gap produces an explicit reset/close rather than unbounded history.

Write one minimal recovery record per live worker beneath `/run/ploinky/webtty`, using a real mode-`0700` parent, atomic create/rename, mode `0600`, current-UID ownership, no symlinks, and no secrets. Record Router epoch, worker PID/start token, PTY PID/start token/session/group, and a random internal marker. Remove it after verified cleanup.

Before accepting WebTTY sessions on Router startup, scan only that exact directory. Reclaim a recorded worker/group only when record ownership/mode/schema, `/proc` start token, process identity, and process-group relationship all still match. Never kill from a stale PID alone. If a live or ambiguous record cannot be proven, leave the record and process untouched, fail only WebTTY readiness with operator evidence, and keep unrelated Router routes running. Do not quarantine, overwrite, or delete an unproven record merely to re-enable the feature. The recovery action is to stop and recreate the owning Box, which terminates the Box PID namespace and discards its ephemeral `/run` state, then retry with a clean startup scan; merely restarting Router is insufficient. Remove only safely proven dead records. This closes the narrow worker-and-Router-simultaneous-crash gap without adding a persistent broker.

Exit gate: tests cover quota accounting under races, IPC backpressure, SSE reconnect, worker failure, Router graceful close, Router SIGKILL/IPC EOF, verified startup reclamation, stale PID reuse refusal, and no WebTTY process when idle.

## 11. Step 5 — add continuous authentication leases

Normal request authentication remains `ensureAuthenticated`. Administrator authorization must use the current role/identity predicate (`isLocalAdminUser` currently recognizes the supported local and routed admin forms) after authentication. Do not reuse `requireAdminControlRequest(..., { mutation: true })` for the public `/webtty` surface because that helper is intentionally local-control-origin scoped.

Add a response-free auth-layer API such as `createBrowserSessionLease(req)` and `validateBrowserSessionLease(lease)`. The implementation should reuse existing local token policy/revocation resolution and SSO session-store resolution rather than reimplementing JWT/cookie logic. A lease may retain the minimum cookie/token material needed for revalidation only in Router memory; it must never be persisted, sent to a worker, included in IPC, or logged.

Validation occurs:

1. On terminal creation through the normal authenticated request path.
2. On every subsequent input, resize, stream attach, and delete request.
3. Periodically for every live terminal at a short documented bound, including when no browser request arrives.
4. Immediately when an existing auth/session lifecycle event identifies the same session. Add a small event hook to explicit logout/revocation paths if current code has no reusable event, but retain periodic validation for external SSO deletion, expiry, or role changes.
5. Whenever the Router observes that the bound edge generation/host route is no longer current.

On expiry, revocation, missing session, user mismatch, or loss of administrator authority, atomically deny new input, close the stream, kill the PTY, forget the session, and release quotas. Do not claim that current logout code already emits such an event; it currently revokes/deletes sessions without a WebTTY callback.

Exit gate: tests prove explicit logout closes promptly, periodic local revocation and SSO deletion close within the configured bound, admin demotion closes, and a new login by the same user cannot take over a terminal from the old auth session.

## 12. Step 6 — add the browser API and security policy

Register a dedicated handler after normal authentication. Do not rely on the existing generic browser-mutation gate: `RoutingServer` deliberately exempts `req.authChannel === 'cli'`, and the canonical `local:admin` cookie session uses exactly that channel.

Add a route-specific helper used by every WebTTY mutating method, for every authentication channel, before body parsing or worker allocation. It must call the existing `verifyBrowserMutationRequest()` with the authenticated session, edge auth context, and current route plan, then call `commitRouteGeneration(routePlan)` immediately before the mutation. This deliberately extends the browser mutation proof to the CLI-channel local administrator rather than using `verifyAdminMutationRequest`, which is local-control-only and cannot protect the public routed surface. Current route plans already carry an edge lease, local control plans provide canonical origin/control bindings, and authenticated requests receive the same strict browser-CSRF cookie; missing binding evidence must fail closed. Reusing a proof already checked by the central gate is permitted only if the route-specific helper can prove it represents the identical session/origin/host/route/generation tuple; otherwise verify again.

| Method and path | Behavior | Required authority |
| --- | --- | --- |
| `GET /webtty/` | Serve terminal page | Authenticated current administrator; active route; no-store |
| `GET /webtty/assets/:name` | Serve a fixed local allowlist | Same; fixed content types; no path joining |
| `POST /webtty/sessions` | Validate request and create one worker/PTY | Admin plus exact origin/session/host/generation mutation proof |
| `GET /webtty/sessions/:id/stream` | Attach/reconnect SSE to an existing session | Same auth session/user/host/generation/Router epoch; never creates |
| `POST /webtty/sessions/:id/input` | Send bounded data | Same ownership plus mutation proof |
| `POST /webtty/sessions/:id/resize` | Apply bounded dimensions | Same ownership plus mutation proof |
| `DELETE /webtty/sessions/:id` | Idempotently close | Same ownership plus mutation proof |

Unknown, cross-owner, cross-host, cross-generation, and prior-Router-epoch session IDs return a non-enumerating `404`. Unauthenticated requests return `401`; authenticated non-admins return `403`. Parse only expected content types and bounded bodies. Apply mutation security before reading a large body or allocating a worker.

The Router sends only validated data over IPC. It never forwards browser headers, cookies, authorization fields, request objects, route plans, or user objects. Every WebTTY response is `Cache-Control: no-store`. Assets receive `nosniff`, frame restrictions, referrer/permissions policies, and a restrictive same-origin CSP. Logs include only redacted lifecycle categories, hashed IDs, relative cwd, duration, and exit reason; never keystrokes, output, commands, cookies, auth material, or environment contents.

Exit gate: handler tests cover every status boundary, exact CSRF/generation enforcement, no-GET-creation, fixed asset mapping, bounded bodies, cross-session isolation, header non-forwarding, SSE abort/backpressure, and cleanup on all error paths. The matrix must include the canonical `local:admin` cookie with `authMode: 'local'` and `authChannel: 'cli'`: the exact local control origin/current CSRF/current generation succeeds, while missing or wrong origin, missing or wrong CSRF, and replaced generation all fail before parsing the body or allocating a worker.

## 13. Step 7 — make `/webtty` a named reserved Router surface

Update every current routing seam together:

| Source | Change |
| --- | --- |
| `cli/sandbox/edgeGeneration.js` | Add `webtty` to `ROUTER_SURFACE_CATALOG` |
| `cli/server/edgeRoutePlan.js` | Add the selected-surface match in `surfaceForPath()` **and** the unconditional segment reservation in `isReservedRouterSurface()`; the latter is what prevents a non-selecting public host from falling through to its agent root |
| `cli/server/policy/HttpRouteAccessPath.js` | Add `webtty` to `ROUTER_OWNED_FIRST_SEGMENTS` |
| `cli/server/RoutingServer.js` | Recognize `/webtty` in `isRouterOwnedPath()` and dispatch the handler |
| `tests/unit/httpRouteAccessPath.test.mjs` | Add `/webtty` to the reserved-path loop and `webtty` to the lockstep expected `ROUTER_OWNED_FIRST_SEGMENTS` set |
| Edge-generation tests | Cover selected, unselected, local, wrong-host, stale-generation, and agent-shadow cases |

Expected routing behavior:

| Request location | Result |
| --- | --- |
| Local Router/control origin | Router WebTTY handler, still admin-only |
| Public agent-root host selecting `webtty` | Router WebTTY handler |
| Public host not selecting `webtty` | Reserved-path `404`, never agent-root fallback |
| Dedicated service/private interface without the surface | `404` |
| Stale route generation | Fail closed for page, API, and stream |

Do not create a broad manifest `admin` route level or an agent service mapping. The dedicated handler is the final authorization authority.

Update Router observability without reviving the old port-oriented component model: add `WebTTY: /webtty` to the startup surface banner and a numeric active-terminal count to the mode-`0600` detailed health response. Do not add a `routerEnv.js` TCP component, server-manager process, health port, or listener entry because WebTTY has no independent service or listener.

Exit gate: current edge hard-cut and route-access tests prove selection, reservation, generation, and shadow prevention.

## 14. Step 8 — build the core terminal page

Port the currently used terminal behavior, but do not blindly preserve the retired lockfile's deprecated `xterm` package names. Select exact, maintained xterm packages (the retired package metadata points to the `@xterm/*` replacements), review their browser/API changes, and commit only the required distribution files under fixed filenames together with versions, SHA-256 checksums, and third-party license files. Keep a reproducible refresh script or manifest, but do not add xterm or `node-pty` to Ploinky's root runtime dependency installation and do not load CDN assets.

The page must:

1. Display an explicit “Administrative shell — full workspace read/write” notice.
2. Treat `dir` as an untrusted workspace-relative request. It may be shown safely, but is sent only as JSON to `POST /webtty/sessions`; it is never interpolated into HTML or a shell command.
3. Create exactly one terminal through POST, then attach its SSE stream. GET and SSE reconnect never create a terminal.
4. Batch and bound input and resize requests. Surface capacity, authorization, invalid directory, terminal exit, and temporary runtime failures without internal paths/PIDs/stacks.
5. Use the existing Ploinky authentication cookie only. Add no WebTTY cookie, bearer token, localStorage credential, or client-generated authorization capability.
6. Attempt an idempotent keepalive DELETE on page close when practical, while server timeouts and auth leases remain authoritative.
7. Load only the fixed same-origin asset allowlist and pass the restrictive CSP without inline-eval exceptions.

Exit gate: client/DOM tests prove safe directory encoding/display, POST-before-stream, reconnect-without-create, bounded request batching, explicit exit handling, and zero external asset requests.

## 15. Step 9 — cut Explorer to the core route

Apply a direct cut in `AssistOSExplorer`:

1. Remove `"basic/webtty global no-wait"` from `explorer/manifest.json`.
2. Remove the `basic` repository declaration after a final reference scan confirms WebTTY remains its only enabled use.
3. In the same change, remove the `basic|https://github.com/AssistOS-AI/basic.git` row from `GRAPH_REPOSITORIES` in both `.github/workflows/deploy-explorer-qa.yml` and `.github/workflows/destroy-explorer-qa.yml`, then update `tests/smoke/lib/deploy-workflow-contract.test.mjs` so it no longer requires that row.
4. Change `openTerminalHere()` in `explorer/web-components/pages/file-exp/file-exp.js` to construct same-origin `/webtty/?dir=<workspace-relative-path>`. Current code already strips leading slashes before setting `URLSearchParams`; retain that canonical relative behavior and test spaces, Unicode, `#`, `%`, and nested directories.
5. Remove the `buildAgentPortUrl` import. Repository search currently shows WebTTY as its only production caller; if that remains true, delete `explorer/services/runtime/agent-port-url.js` and its focused unit test rather than retaining dead compatibility code.
6. Make administrator-only menu visibility an explicit new behavior: the current contribution is unconditional (`disabled: false` with no role check). Factor one shared predicate from the existing private checks in `file-exp-application-plugins.js` and `services/profileAvatar/avatarApi.js`, and use it so the directory context menu omits **Open Terminal Here** for non-admins. This is presentation only; Router enforcement remains authoritative.
7. Add `webtty` to the Router surfaces materialized by `.github/workflows/deploy-explorer-qa.yml` and every other current workflow/configuration that explicitly enumerates public surfaces.
8. Update manifest/public-exposure, workflow-contract, DOM/menu, and launcher tests to assert the absence of `basic`, absence of the agent-port route, correct same-origin URL and encoding, admin visibility, and non-admin omission.
9. Update current Explorer specifications and generated documentation according to that repository's documentation rules.

Never send the physical host cwd in the URL. The browser sends only a relative workspace path; the Box maps it under `/workspace`.

Exit gate: Explorer unit tests pass and a repository-wide search finds no production reference to `basic/webtty`, port `7681`, or the old agent-port route.

## 16. Step 10 — delete the retired implementations directly

### 16.1 `basic`

Delete, without tombstones or migration files:

```text
basic/webtty/
basic/tests/unit/webttyManifest.test.mjs
basic/docs/specs/DS004-webtty-agent.md
```

Remove the DS004 row from `basic/docs/specs/matrix.md`, then remove other current feature-owned references found by searching `webtty`, `webtty-agent`, `7681`, and the old agent route. Do not rewrite unrelated historical artifacts.

### 16.2 `container-image-builds`

After the direct Box native build passes:

```text
images/webtty-agent/
.github/workflows/publish-webtty-agent-image.yml
```

Remove its README inventory/publication instructions and replace the old image assertions in `tests/image-definitions.test.mjs` with direct `ploinky-box` native-runtime assertions. Update absence tests so they prove the independent image cannot return. Registry tag deletion is a separate destructive registry operation and is not authorized by this source change.

### 16.3 Ploinky agent-era artifacts

Remove the required nested `basic/webtty` container entry, the `webtty-service`/7681 listener rule, and port `7681` from `controlPorts` in `container/profiles/full-explorer-listeners.json`. Update `container/listener-inventory-tests.mjs` so the required-container assertion changes from 20 to 19 and every exact profile expectation matches the new graph. Add a focused absence test proving no current manifest, lookup, service map, control-port set, listener profile, or route resolves `basic/webtty` or `/base-agent-additional-server/webtty/7681/`. Rename generic fixtures using `webtty` as a dummy agent name only when the name falsely implies it remains an agent.

Exit gate: all three repositories contain only the new core-service meaning of WebTTY, and no runtime fallback path exists.

## 17. Step 11 — verification matrix

### 17.1 Ploinky unit and component coverage

| Area | Required cases |
| --- | --- |
| Native contract | Exact schema/lock/ABI/arch/artifact accepted on both newly obtained and already-present image paths; missing, tampered, wrong-arch, symlink, and wrong bundle reject Box admission without a tag race |
| Directory validation | Root/nested accepted; absolute, drive path, backslash ambiguity, traversal, NUL, malformed encoding, file, missing dir, and symlink escape rejected |
| Environment | Exact allowlist present; auth, routing, Cloudflare, agent, npm, and arbitrary inherited variables absent |
| Worker protocol | Version/order/type/size validation; one init/PTY; output sequence; disconnect cleanup |
| PTY behavior | Input, output, resize, clean/signal exit, grace/force cleanup, verified process group topology |
| Session manager | Per-session/user/global quotas, rate limits, exact-once release, idle/absolute timeout, output/IPC/SSE high-water behavior |
| Authentication | `401`, non-admin `403`, local and routed admin allowed, logout/revocation/expiry/demotion termination |
| Ownership | Cross-user, cross-login, cross-host, cross-generation, cross-Router-epoch IDs do not leak or attach |
| Mutation security | Exact canonical origin/session/host/route/generation succeeds; every mismatch fails before allocation; include `local:admin` with `authChannel: 'cli'` plus routed local/SSO administrator cases |
| API semantics | GET never creates, stream only attaches, delete idempotent, assets fixed, sensitive headers never reach worker |
| Lifecycle | Idle has no worker; opportunistic graceful Router close; authoritative IPC EOF; worker crash; startup orphan recovery; unproven record disables only WebTTY; stale PID refusal and documented Box-recreation recovery |
| Routing | Local/selected succeeds; unselected/wrong host/stale generation/shadow attempt fails closed; selected match and unconditional reservation are independently exercised |
| Box boundary | No privilege/publication/socket expansion and root dependency cache remains unrelated |

### 17.2 Native Box evidence on amd64 and arm64

For each architecture prove a fresh image can import the immutable addon; create a PTY; exchange input/output; resize; exit/reap; and pass the source lock/ABI/artifact contract. Inspect the final image for compiler/npm-cache absence, an unversioned Box marker, empty labels, and unchanged metadata. Exercise both freshly obtained and already-present image admission against the same immutable ID. Prove an old image without the native contract is rejected before Router readiness, then start the compatible Box and prove there is no listener on `7681` and no additional host publication.

Mount a temporary workspace and prove an admin terminal starts at `/workspace`, starts at a selected nested directory, reads an existing host-created file, writes a marker visible on the host, and cannot read a host canary outside all Box mounts. Prove an ordinary authenticated user cannot load assets/page, create, attach, input, resize, or close an administrator terminal.

Crash the worker, Router, and Box in separate cases. Verify streams close, terminal state disappears, proven process groups are reclaimed, old public IDs fail, and no WebTTY state persists in the workspace. Explicitly test the narrow Router/worker simultaneous-failure recovery record path.

### 17.3 Browser cutover evidence

Add a focused Explorer DOM/unit test and a Playwright smoke against a fresh exact-revision Box. The administrator case must show **Open Terminal Here**, open the same-origin `/webtty` page for a nested directory, create one terminal, prove the initial cwd, read an existing workspace marker, and write a marker visible outside the Box. The ordinary-user case must omit the menu item and receive `403` when navigating directly to the page or calling the session-creation API. Include the canonical local `authChannel: 'cli'` administrator mutation path; when the public surface is part of the candidate, also cover the routed selected-surface path and one unselected-host `404`.

This browser smoke is a release gate in the plan, but Ploinky policy requires the user's explicit authorization before running the fresh cross-repository deployment or Playwright gate. Do not silently substitute unit tests for it, and do not run it automatically while merely implementing or reviewing the repositories.

### 17.4 Repository checks

| Repository | Minimum verification before review |
| --- | --- |
| `ploinky` | Focused new tests, affected auth/routing/lifecycle/Box tests, then normal `npm test` |
| `container-image-builds` | Image-definition tests and native amd64/arm64 Box build/probe |
| `AssistOSExplorer/explorer` | Normal unit suite including manifest, launcher encoding, surface selection, and admin presentation |
| `basic` | Normal unit suite after deletion plus feature-absence search |

Do not automatically run the cross-repository fresh Explorer deployment or Playwright release gates described in Ploinky policy. They require the user's explicit request against exact committed/pushed revisions. List the unexecuted gate explicitly until that authorization is provided; do not claim the release candidate fully verified without it.

## 18. Step 12 — implementation and release order

There is no compatibility implementation, but the Box build consumes Ploinky source, so development must use exact candidate revisions:

| Order | Change group | Gate |
| --- | --- | --- |
| 0 | Fetch and fast-forward Ploinky `master`, re-prove the prerequisite ancestry, record the branch point, and create/switch to `feature/webtty-core` | Clean feature branch exists before the first implementation edit; no implementation commit lands directly on `master` |
| 1 | Ploinky protocol/native contract plus a throwaway native Box spike | Exact dependency works on both architectures |
| 2 | Ploinky worker, session manager, auth leases, API, route surface, UI, lifecycle, and tests | Source behavior complete; old Box is intentionally rejected before Router readiness |
| 3 | `container-image-builds` direct Box packaging and admission evidence | Candidate Box passes native and metadata gates |
| 4 | Explorer same-origin launcher/admin UI/surface selection, removal of `basic` enablement/workflow rows, and Ploinky listener-profile/count cleanup as one integrated change | No old runtime request remains and the new listener inventory validates at 19 required containers |
| 5 | Direct deletion in `basic` and old image/workflow deletion in `container-image-builds` | Cross-repository absence audit passes |
| 6 | Build/release exact integrated candidate | Revision map and immutable Box digest recorded |

Use the Ploinky `feature/webtty-core` branch plus coordinated feature branches in `container-image-builds`, `AssistOSExplorer`, and `basic`; create each companion branch from that repository's freshly verified default branch before its first edit. Record every branch point and candidate SHA in one revision map. Do not publish an interim mixed deployment and do not add dual-route logic to make mixed revisions work. If Ploinky's declared native contract and the Box image differ, reject Box admission with a hard error and require the compatible image before continuing.

The retired `webtty-service` listener rule currently has `minMatches: 1`. Therefore Explorer's removal of the old agent and Ploinky's profile/control-port/count cleanup in group 4 are one atomic integration point: do not deploy or run the full listener-profile validator after one half and before the other.

Recommended Ploinky commit boundaries are: contract and native probe; worker/process identity; Router manager/auth/API; route/UI; tests and stale-profile cleanup. Keep unrelated `agentlib-direct-mount` behavior intact throughout.

## 19. Failure behavior and diagnostics

| Failure | Externally visible behavior | Operator evidence or recovery |
| --- | --- | --- |
| Missing/incompatible Box runtime | Box start or reconciliation is rejected before Router readiness; no WebTTY or non-WebTTY Router route is served from that Box | Expected/observed contract categories and immutable image ID; build/pull the compatible image and recreate the Box; no install attempt |
| Non-admin or expired auth | `403` or `401`; existing terminal closes | Hashed auth/session audit identifier, no secret |
| Invalid directory | `400` | Safe relative-path reason, never physical host path |
| Quota/rate limit | `429` | Limit category and bounded count |
| Unknown/not-owned ID | Non-enumerating `404` | Hashed internal ownership category |
| Worker/native failure | SSE error/exit; session cleaned | Worker exit category and bounded redacted diagnostic tail |
| Output/backpressure limit | Session closed explicitly | Limit category and byte counts, never output content |
| Auth-lease invalidation | Stream closes and PTY is killed | Revoked/expired/demoted category |
| Unproven stale process identity | Running Router keeps non-WebTTY routes available, but `/webtty` returns `503` and creates no terminal | Record and `/proc` mismatch category, no unsafe signal; stop and recreate the Box to clear the Box-lifetime process/runtime state |

The browser distinguishes authorization, invalid directory, capacity, terminal exit, and temporary runtime failure without revealing PIDs, runtime paths, stack traces, or tokens.

## 20. Explicit non-goals

This work does not preserve the old WebTTY cookie/API/port, retain an agent manifest, maintain old image compatibility, migrate live terminals, restore the 2025 implementation verbatim, expose WebTTY to ordinary users, allow arbitrary shell executables/env/host paths, publish another port, add a helper image, promise containment against a trusted administrator, or delete old registry tags.

## 21. Definition of done

Implementation is done only when:

1. `master` still contains the `agentlib-direct-mount` merge, `feature/webtty-core` was created from a freshly verified `master` descendant of `021d9a9` before implementation, and no implementation commit was made directly on `master`.
2. The immutable `ploinky-box` carries the exact native WebTTY bundle and real PTY probes pass on amd64 and arm64.
3. Router owns all browser authority and every PTY is isolated in one lazy worker with bounded IPC and verified cleanup.
4. `/webtty` is named, reserved, generation-bound, administrator-only, mutation-protected, and impossible for an agent to shadow.
5. Auth expiry/revocation/logout/admin demotion closes live terminals without waiting for another terminal request.
6. The requested folder is canonicalized beneath `/workspace`; the shell has full read/write access to the selected workspace bind and no new host mount.
7. No secrets are inherited by workers/shells, no terminal content is logged, and all buffers/quotas/lifetimes are bounded.
8. The existing Box privilege, user, mount, and publication contracts remain intact.
9. `basic/webtty`, the old image/workflow, port 7681, Explorer's agent dependency/helper use, and stale listener entries are deleted without compatibility code.
10. Focused and normal repository tests pass, and the exact release revision/image map is recorded.

## 22. Evidence status and next checks

### Observed

The merged Ploinky tree shows that Watchdog owns only RoutingServer and assumes a single child; RoutingServer already has child-session cleanup and asynchronous `beforeClose` hooks. Those hooks are best-effort rather than a crash guarantee: SIGKILL cannot run them, and the current uncaught-exception path does not guarantee Router shutdown. Explicit logout currently revokes or deletes sessions but emits no WebTTY lifecycle notification.

The central browser mutation gate binds session, origin, route host, and active generation for local/SSO browser requests, but explicitly skips `authChannel === 'cli'`; the canonical `local:admin` cookie is assigned that channel. Every resolved route plan captures a generation lease, local control plans have canonical origin/control bindings, and authenticated requests with a session receive the existing strict browser-CSRF cookie. Therefore the same browser proof can be enforced directly and uniformly by the WebTTY handler, including for the CLI-channel administrator; this still requires the explicit tests in §12 and §17.

The Box mounts the selected workspace read/write at `/workspace`, mounts Ploinky source read-only at `/opt/ploinky`, and overlays `/opt/ploinky/node_modules` with a mutable workspace dependency directory. Only Router loopback TCP and LiveKit UDP are publishable. The current Box Dockerfile already creates working `npm` and `npx` symlinks. New-image admission runs a network-disabled container probe, while `inspectAndValidateExistingImage()` currently does not. Existing tests deliberately require an unversioned Box marker, empty labels, and no runtime-contract coupling in the reproduce workflow.

The old agent route, image, Explorer enablement, and stale Ploinky listener profile all remain present in their respective current trees. The profile also contains `7681` in `controlPorts`, its required-container test hard-codes 20, and Explorer's deploy/destroy workflow repository lists plus their contract test still require `basic`.

### Inferred design decisions

Router-owned per-terminal workers best match current lifecycle code: they isolate the native addon, exist only when used, and die through IPC ownership without turning Watchdog into a multi-process supervisor. A stable native-bundle fingerprint is safer and less operationally coupled than requiring the whole Ploinky source SHA to equal the image build SHA; the full SHA remains provenance. Periodic auth-lease validation is required because an already-open SSE connection does not naturally rerun request authentication after logout or external SSO revocation.

Because this plan deliberately makes the native terminal bundle part of the required core Box contract and excludes backward compatibility, old-image rejection is a whole-Box admission failure, not a feature-only fallback. That strict first cut is confined to native-contract changes: later unrelated Ploinky commits remain compatible. By contrast, an ambiguous recovery record discovered by an already-admitted Router disables only WebTTY, because killing an unproven process would be unsafe and the native image contract is still valid.

### Unknowns to prove before implementation is considered safe

The exact `node-pty` version must be proven on Fedora/Node 24 for both native architectures. The PTY PID/session/process-group topology and safe termination primitive must be measured in the real Box rather than assumed. The available unprivileged `/proc` identity fields and simultaneous Router/worker crash behavior must be validated. The exact maintained `@xterm/*` versions and vendored asset set must be selected and licensed. Re-run the repository-wide consumer/surface search at implementation and release time so changes after this planning baseline cannot create a new missed seam.

### First execution checks

Begin by creating `feature/webtty-core` from a freshly fetched, fast-forwarded, and ancestry-verified Ploinky `master`, then record that branch point. Next run the native dependency and process-topology spike in an exact candidate `ploinky-box`. Record import, input/output, resize, exit, PID/start-time/session/group, Router-disconnect, worker-SIGKILL, and cleanup results on amd64 and arm64. Use that evidence to finalize the worker cleanup primitive and runtime contract, then implement Router/auth/routing/UI behavior. Delete the old sources only after the direct Box build passes, but never add a runtime fallback during that sequencing.
