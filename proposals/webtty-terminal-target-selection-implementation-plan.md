# Implementation Plan: Select the WebTTY Runtime from Explorer

| Field | Value |
| --- | --- |
| Status | Proposed; implementation is blocked until the prerequisite merges and the Phase 0 lifecycle gate passes |
| Plan date | 2026-08-28 |
| Planning baseline | `ploinky` `feature/webtty-core` at `9576d6c98db69a0d09d2bbe28083d969224c7077` |
| Primary implementation repositories | `ploinky`, `AssistOSExplorer` |
| Verification-only repositories | `container-image-builds`, `basic` |
| Required Ploinky implementation branch | New `feature/webtty-terminal-targets` branch created from the verified, updated `master` tip |
| Required Explorer implementation branch | New `feature/webtty-terminal-targets` branch created from the verified, updated `main` tip |
| Locked user experience | The target chooser is a modal inside Explorer, before a WebTTY tab opens |
| Compatibility policy | Hard cut; no old request-body compatibility, migration, or legacy WebTTY-agent fallback |

## 1. Required outcome

When an administrator opens a folder's three-dot menu and selects **Open Terminal Here**, Explorer must display a modal that lets the administrator choose:

1. **Ploinky Box**, which starts the existing Ploinky-core terminal in the selected folder under `/workspace`; or
2. any currently running Ploinky-managed OCI agent whose exact live mounts prove that it can access the selected folder.

Selecting an agent must open WebTTY in a new tab, execute a fixed interactive shell inside that exact immutable agent container, and start the shell at the container path that represents the selected Explorer folder. Ploinky, not Explorer, decides target eligibility, path translation, identity, and authorization.

The implementation is complete only when target discovery, launch handoff, Box and agent terminal lifecycle, cleanup, authorization, UI behavior, and fresh-deployment browser tests all pass against exact candidate revisions.

## 2. Locked product and architecture decisions

| ID | Decision | Required implementation meaning |
| --- | --- | --- |
| D-1 | Explorer owns the chooser modal. | Clicking **Open Terminal Here** displays the choice in Explorer. Do not replace this with a WebTTY-owned chooser page. |
| D-2 | Ploinky owns all security decisions. | Explorer renders server-provided rows. It never infers mounts, readiness, translated paths, or container identity. |
| D-3 | Box is the first target. | A usable Box provider is always listed first. Agent discovery failure must not remove the Box choice. |
| D-4 | Only proven live OCI agents are listed. | The first release supports agent containers owned by nested Podman/Docker. Host `bwrap` and `seatbelt` runtimes are not agent-terminal targets. |
| D-5 | Live inspect is mount authority. | Persisted registry binds may provide display context but must never authorize access or determine read-only state. |
| D-6 | Launch references are server-side records. | The browser receives a random, short-lived, single-use ID, not a signed capability and not a raw container selector. |
| D-7 | Session creation revalidates everything. | Discovery is advisory. The exact generation, admin session, container identity, ownership labels, mounts, selected directory, and translated cwd are rechecked immediately before spawn. |
| D-8 | Box and agent workers remain separate. | Keep the proven Box worker and exact v1 protocol unchanged. Add a separate agent worker and agent-specific protocol after the lifecycle spike chooses a backend. |
| D-9 | Browser transport remains SSE plus POST. | Preserve `EventSource` output/replay and POST input/resize plus DELETE close. Do not introduce a WebSocket rewrite. |
| D-10 | `node-pty` stays in `ploinky-box`. | Use the native dependency already built into the Box. Add no helper image and no `node-pty` dependency to agent images. |
| D-11 | No generic exec surface. | Browser requests can select only an offered target. They cannot provide a container ID/name, executable, argv, environment, physical host path, or translated cwd. |
| D-12 | No backward compatibility. | Replace `{dir, cols, rows}` session creation with the launch-record contract. Do not support both shapes. |
| D-13 | No legacy agent restoration. | `basic/webtty` remains deleted. Do not revive its manifest, image, route, port, workflow, or migration. |
| D-14 | New branches are mandatory. | Do not implement this feature on `master`, `main`, `feature/webtty-core`, `ploinky-proxy`, or another existing feature branch. |
| D-15 | WebTTY remains Ploinky core. | Discovery, authorization, session management, PTY workers, recovery, and the `/webtty` surface remain Router/Ploinky-owned. Do not create a separately deployable WebTTY agent or service. |
| D-16 | Agent terminals require a proven in-Box runtime. | Offer agent targets only when the Router can prove it controls the same supported nested OCI runtime and can perform the selected lifecycle protocol locally. Unsupported direct-host/development layouts expose no agent targets and never bridge to a remote runtime implicitly. |

## 3. Current observed baseline

The plan is based on executable code and tests. Ploinky historical DS files are not implementation authority and must not be changed as part of Ploinky behavior work.

| Area | Current behavior | Implementation consequence |
| --- | --- | --- |
| Explorer launcher | `file-exp.js` opens `/webtty/?dir=...` directly from the menu action. | Replace direct launch with `showModal('terminal-target-modal', ...)`. |
| Explorer authorization | The menu contribution is already admin-only. | Preserve presentation gating, but keep Router authorization authoritative. |
| WebTTY create API | `POST /webtty/sessions` accepts exactly `{dir, cols, rows}`. | Make a clean cut to `{launch, cols, rows}`. |
| WebTTY output | Output uses SSE and `Last-Event-ID`; input and resize use POST. | Extend ownership checks without changing transport. |
| Box cwd | `cwd.mjs` validates and realpaths a relative path beneath `/workspace`. | Reuse it for selected-directory canonicalization and Box launches. |
| Box worker | `terminal-worker.mjs` directly spawns Bash under Box `node-pty`. | Keep it unchanged behind the Box provider. |
| Worker protocol | The v1 worker protocol and shell environment use exact object/key validation. | Do not add agent fields to v1 messages or the Box environment. |
| Cleanup failure | Any unproven cleanup currently disables all WebTTY and closes all sessions. | Introduce provider-aware failure domains before adding agent sessions. |
| Recovery records | The v1 schema can represent only a Box worker and PTY identity. | Hard-cut to a target-discriminated v2 schema for the fresh Box release. |
| Runtime projection | `containerRegistry.js` currently retains only mount source and destination and drops `Id`, `Type`, `RW`, and volume name. | Add a dedicated exact-inspect projection for terminal targeting. |
| Runtime readiness | `collectAgentRuntimeStates` ties `running` to a route host port. | Do not use it for terminal eligibility; network-`none` containers can still be eligible. |
| Effective binds | Agent run arguments contain mounts omitted from persisted `config.binds`. | Inspect the exact live container every time authority is required. |
| Agent source aliases | Workspace code links are under `.ploinky/code/<agent>`. | Resolver tests must use the actual path, not `code/<agent>`. |
| Box image | `node-pty` is already compiled, verified, and installed in `ploinky-box`. | No image implementation is expected unless the Phase 0 spike reveals a missing runtime prerequisite. |
| Legacy WebTTY | `basic/webtty` is already absent on the WebTTY-core branch. | `basic` receives an absence check only. |

## 4. Prerequisites and branch creation

Implementation must not start until these steps pass in order.

| Sequence | Required action | Gate |
| --- | --- | --- |
| 1 | Finish and merge `agentlib-direct-mount` into Ploinky `master`. | Its exact merge commit is an ancestor of the selected branch point. |
| 2 | Finish, verify, and merge WebTTY core into `ploinky/master`, `AssistOSExplorer/main`, `container-image-builds/main`, and `basic/main`. | Each default branch contains its reviewed WebTTY-core commit; no repository is still relying on `feature/webtty-core`. |
| 3 | Preserve or complete all unrelated dirty work before switching branches. | No reset, checkout overwrite, stash loss, or accidental inclusion of unrelated changes. |
| 4 | Fetch remotes and update each default branch by fast-forward only. | Local default tips match their selected upstream tips and worktrees are clean. |
| 5 | Record the exact default-branch commits, upstreams, and merge ancestry. | A revision-map artifact identifies every branch point. |
| 6 | Create `feature/webtty-terminal-targets` from the verified Ploinky `master` tip. | All Ploinky implementation commits land only on this new branch. |
| 7 | Create the same-named companion branch from the verified Explorer `main` tip. | All Explorer implementation commits land only on this new branch. |
| 8 | Do not create follow-on branches in `basic` or `container-image-builds` unless Phase 0 proves a real source change is necessary. If one is necessary, create the same-named feature branch from that repository's verified default tip before editing. | Their default branches are verification inputs unless an evidence-backed change is required. |

The current planning checkout is not an acceptable implementation branch. It is `feature/webtty-core`, and the Ploinky worktree also contains unrelated changes. The implementation session must not switch or create branches in that dirty checkout until those changes have been safely resolved by their owner.

## 5. End-to-end request flow

| Step | Explorer/browser action | Ploinky action |
| --- | --- | --- |
| 1 | Admin clicks the folder's three-dot menu and **Open Terminal Here**. | No shell is created. |
| 2 | Explorer opens `terminal-target-modal` immediately with the selected workspace-relative folder. | No runtime identity comes from Explorer. |
| 3 | The modal sends a mutation-protected discovery request. | Ploinky validates admin, origin, CSRF, route generation, and directory containment. |
| 4 | The modal shows Box first, then eligible agents in stable order. | Ploinky inspects exact current-generation containers asynchronously and mints one launch record per offered row. |
| 5 | Admin clicks one target row. | The row click directly calls `window.open('/webtty/#launch=<random-id>', '_blank', 'noopener,noreferrer')`. |
| 6 | The WebTTY page reads and immediately removes the fragment from browser history. | The fragment is never sent in an HTTP request, access log, or referrer. |
| 7 | WebTTY posts `{launch, cols, rows}`. | Ploinky atomically consumes the record, revalidates the target from scratch, commits the generation, and starts the selected provider. |
| 8 | The page shows the target label, access badge, and effective cwd, then attaches SSE. | The session is bound to the admin lease, route generation, target kind, and exact target identity. |
| 9 | Input, resize, replay, auth invalidation, timeouts, and close use the existing WebTTY browser contract. | Provider-specific I/O and cleanup remain behind the session manager. |
| 10 | The tab closes or the session ends. | Ploinky terminates and proves reclamation of the Box shell or exact inner agent shell before deleting its recovery record. |

No GET navigation may create a shell. Loading `/webtty/` without a valid launch fragment displays an invalid-launch message and creates no worker.

## 6. Phase 0: choose and prove the agent PTY backend

Do not implement the production agent provider from assumptions. First run a focused executable spike inside the exact production `ploinky-box` image and nested rootless runtime.

### 6.1 Candidates

| Candidate | What must be tested | Decision posture |
| --- | --- | --- |
| Controlled `podman exec -it` under Box `node-pty`, with exact inner-process evidence from the Box namespace | Marker transport, Box `/proc` visibility, `NSpid`, UID and signal permissions, process groups/sessions, double-PTY resize, client death, foreground-child cleanup, and post-close exec drainage | Leading candidate, but not selected until every lifecycle gate passes |
| Podman exec REST API over the local nested-runtime service/socket | Exact exec ID, attach, resize, inspect, termination, service activation/lifetime, socket confinement, and orphan proof | Equal spike candidate; do not reject merely because service activation may be on-demand |
| Agent-side terminal broker | Dependency, protocol, image, and trust expansion | Out of scope for automatic fallback because it conflicts with the no-agent-dependency direction |
| Existing runtime relay as-is | PTY stream and lifecycle support | Rejected as a transport; its immutable-identity confinement pattern may be reused |

### 6.2 Spike matrix

| Test | Required evidence |
| --- | --- |
| Runtime inventory | Podman version/help, API/socket availability, Box UID, rootless storage/runtime environment, image digest, and selected agent image identities |
| Root-owned agent | Create, interactive I/O, terminal dimensions, normal exit, close, and cleanup proof |
| Non-root `USER` agent | Same tests plus exact cross-UID identity and permitted termination path |
| Marker discovery | The marker is actually present in verifiable inner-process evidence; the plan must not merely declare a marker field |
| Resize | `node-pty.resize()` or API resize changes `stty size` in the inner shell without corrupting input/output |
| Client loss | Kill the Box-side Podman client and observe whether the inner shell survives; the backend must detect and reclaim it |
| Foreground job | Run a foreground child, close the browser side, and prove the shell and foreground process group are gone |
| Container stop/remove | Stop or force-remove the target and prove the session exits without attaching to a replacement |
| Same-name replacement | Replace the container under the same mutable name and prove the old session/reference cannot target it |
| Router/worker crash | Kill the Router worker path and prove startup recovery can either reclaim or fail closed with exact evidence |
| Orphan audit | After every close, prove the marker, exact process identity/session members, and any engine exec record are gone |

### 6.3 Spike deliverables and stop condition

| Deliverable | Required content |
| --- | --- |
| Evidence document | Add `proposals/webtty-agent-pty-spike-results.md` on the implementation branch with exact image/runtime versions, commands, results, and selected backend. Do not include secrets. |
| Executable regression | Preserve the lifecycle harness as an integration test that can run against a real Box. |
| Provider contract | Freeze create, I/O, resize, close, identity, recovery, and cleanup semantics before production worker code starts. |

If neither candidate can deterministically terminate and prove reclamation of the exact inner shell and foreground children, stop the implementation and request an architecture decision. Do not silently introduce a broker, helper image, privileged mode, extra host bind, or `node-pty` in every agent.

## 7. Terminal target discovery

### 7.1 Candidate source

The resolver must enumerate the active route plan's generation snapshot rather than running a full `podman ps` sweep or using marketplace runtime status.

An agent candidate is eligible for inspection only when all of these conditions hold:

| Check | Rule |
| --- | --- |
| Active membership | Its registry record exists in `routePlan.snapshot.agents` for the active leased generation. |
| Record kind | `record.type === 'agent'`. |
| OCI runtime | Runtime is exactly a supported `podman` or `docker` runtime for the selected in-Box provider. |
| Immutable identity | Full 64-hex `containerId`, non-empty `instanceId`, and non-empty `enableGeneration` are present. |
| Ownership metadata | Repository, agent, instance, container name, and generation fields form a complete descriptor. |
| Quarantine | The exact target and the agent provider are not quarantined/disabled. |
| Route ports | Ignored for eligibility. A live network-`none` agent can be selected. |

Refactor or export the existing exact-runtime and managed-container verification primitives rather than copying slightly different identity logic into WebTTY.

### 7.2 Exact asynchronous inspection

Add an async exact-ID inspect function with a narrow redacted projection:

```text
{
  id,
  name,
  running,
  state,
  labels,
  networkMode,
  mounts: [{ type, source, destination, rw, name }]
}
```

The projection must discard environment values, command arguments, secrets, and unrelated inspect data immediately after parsing. `Id`, `Type`, `Source`, `Destination`, `RW`, and volume `Name` must not be dropped.

| Bound | Initial value |
| --- | --- |
| Candidates | Active-generation identity-complete agents only |
| Concurrency | At most 4 exact inspections at a time |
| Per-inspect timeout | At most 2 seconds |
| Overall discovery budget | At most 3 seconds |
| Inspect output | Bounded buffer with parse failure treated as ineligible |
| Failure behavior | Omit the failed/slow agent; retain Box and other proven agents |

Do not cache complete discovery responses or launch records by generation. The first implementation should use no inspection cache. If profiling later proves a cache necessary, cache only the redacted exact-ID projection for at most one second, keyed by runtime, immutable container ID, and enable generation; launch-time revalidation always bypasses it.

### 7.3 Live ownership verification

For every inspection, require:

| Proof | Required match |
| --- | --- |
| Immutable ID | Inspected ID equals the full recorded ID. |
| State | Container is currently running. |
| Name | Inspected name, when present, matches the recorded managed name. |
| Managed labels | Managed flag, resource type `agent`, instance ID, and enable generation exactly match. |
| Workspace generation | The route lease and snapshot remain current throughout discovery. |

Any missing field, changed label, partial ID, stopped state, inspect error, or ambiguous ownership omits the target. Human-readable aliases and container names are display data, never authority.

## 8. Mount-to-cwd translation

### 8.1 Inputs

| Symbol | Meaning |
| --- | --- |
| `R` | Real path of the fixed Box workspace root `/workspace` |
| `r` | Canonical normalized workspace-relative directory supplied by Explorer |
| `S` | Real path of `R/r`, verified to be a directory contained by `R` |
| `M` | Every sanitized live mount from the exact container inspect, including bind and non-bind mounts |

Persisted `config.binds`, manifest volume declarations, run mode, and coincidental paths inside an image are not translation inputs.

### 8.2 Exact algorithm

| Step | Operation | Failure behavior |
| --- | --- | --- |
| 1 | Resolve `r` with the existing WebTTY cwd resolver. Capture `S`, `R`, and directory identity needed to detect discovery/create drift. | Reject malformed, traversal, missing, non-directory, or symlink-escape input. |
| 2 | Sanitize every inspected mount into an absolute normalized POSIX destination and retain **all mount types** for shadow analysis. | Drop malformed entries; missing required mount evidence makes a candidate unusable. |
| 3 | For each `Type === 'bind'` mount, realpath its Box-side `Source`; require that source to be a directory and require `RW` to be an actual boolean. | A missing/unreadable/file source or unknown access mode cannot authorize a target. |
| 4 | A bind is a source candidate only when `S === srcReal` or `S` starts with `srcReal + '/'`, using segment boundaries. | Nonmatching mounts are ignored as sources. |
| 5 | Select the candidate with the longest/more-specific `srcReal`. | Equal-specificity candidates that produce different target destinations are ambiguous and reject the agent. Exact duplicates may be collapsed. |
| 6 | Append the relative suffix from `srcReal` to the candidate destination and POSIX-normalize the result into `T`. | Reject an absolute/dot-segment anomaly or any result that escapes the candidate destination. |
| 7 | Find the most-specific mount from **all of `M`** whose destination is `T` or a segment-prefix of `T`. | A more-specific named volume, tmpfs, image volume, or other non-bind shadow rejects the target. |
| 8 | If a different bind shadows `T`, independently realpath it and prove that mapping `S` through it produces exactly `T`; otherwise reject. | Never assume a destination overlay represents the same workspace data. |
| 9 | Derive `access` from the effective post-shadow bind's `RW`: `true -> rw`, `false -> ro`. | Unknown access rejects the target. |
| 10 | At session creation, repeat steps 1–9 from a fresh inspect and require the directory identity and translated target to remain consistent with the offered record. | Any drift returns `terminal_target_stale`; do not fall back to Box or another agent. |
| 11 | The selected provider uses a fixed `-w T`/API working-directory field. Becoming ready proves the directory exists in the exact container. | A bad/missing target cwd fails before a session is reported ready and must leave no inner process. |

Keeping non-bind mounts through step 7 is mandatory. Filtering them out before shadow analysis would wrongly authorize a workspace bind hidden by a named volume.

Staged Podman `/code` and `/Agent` sources require no name-based exception: their real directories do not contain an Explorer selection from the original repository, so they naturally fail step 4. Tests must prove this. Workspace source aliases must use the real `.ploinky/code/<agent>` location and must prove the more-specific real source wins when appropriate.

The `ro` badge describes the selected folder mapping only. It does not claim that the entire agent container is read-only; an administrator inside the agent can still reach whatever other paths and credentials that agent normally has.

## 9. Server-side discovery and launch records

### 9.1 Why discovery is POST

Discovery allocates short-lived launch records and consumes bounded server capacity. Use a mutation-protected POST instead of a GET with hidden side effects.

```text
POST /webtty/target-discoveries
Content-Type: application/json

{ "dir": "projects/demo" }
```

The handler must apply administrator authorization and `verifyBrowserMutationRequest()` before reading the bounded body, then resolve the directory and targets against the current route plan.

Illustrative response:

```json
{
  "ok": true,
  "discovery": {
    "id": "random-batch-id",
    "directory": "projects/demo",
    "expiresAt": 1787860000000,
    "agentTargetsAvailable": true,
    "targets": [
      {
        "launch": "random-single-use-id",
        "kind": "box",
        "label": "Ploinky Box",
        "detail": "Workspace runtime",
        "access": "rw",
        "cwdDisplay": "/workspace/projects/demo"
      },
      {
        "launch": "random-single-use-id",
        "kind": "agent",
        "label": "explorer",
        "detail": "AssistOSExplorer/explorer",
        "access": "rw",
        "cwdDisplay": "/workspace/projects/demo"
      }
    ]
  }
}
```

Response rows must not contain raw container names/IDs, physical Box paths, mount sources, runtime sockets, executable/argv data, environment values, credentials, or internal recovery evidence.

### 9.2 Launch-record model

Each offered target receives a CSPRNG ID with at least 192 bits. The Router stores the record only in memory.

| Binding | Stored server-side purpose |
| --- | --- |
| Discovery batch ID | Invalidate sibling rows after one target is consumed and support best-effort cancel cleanup. |
| Launch ID | Unguessable browser handle; it is a name, not sufficient authority. |
| User and auth-session fingerprint | Prevent another administrator session or a new login by the same user from consuming it. |
| Route binding | Exact host, host route key, generation/lease ID, and activation ID. |
| Directory | Canonical relative path plus memory-only realpath/directory identity used to detect drift. |
| Box target | Target discriminator and safe display metadata. |
| Agent target | Runtime, immutable container ID, managed name, repo/agent identity, instance ID, enable generation, expected translated cwd/access, and safe display metadata. |
| Lifetime | Creation and expiry times; default TTL five minutes. |
| State | Available or consumed; consumption is atomic and single-use. |

Initial limits:

| Limit | Value |
| --- | --- |
| Targets per discovery | 64 |
| Live discovery batches per auth session | 3 |
| Launch records globally | 512 |
| TTL | 5 minutes |

Creating a new batch beyond the per-session limit evicts that session's oldest unconsumed batch. Consuming one row invalidates every sibling row. Router restart, logout/revocation, route-generation replacement, or expiry invalidates the records. Modal cancel should best-effort call `DELETE /webtty/target-discoveries/:id`; TTL cleanup remains authoritative if the request is lost.

### 9.3 Target-aware session creation

```text
POST /webtty/sessions
Content-Type: application/json

{ "launch": "random-single-use-id", "cols": 120, "rows": 32 }
```

The exact processing order is:

| Order | Check/action |
| --- | --- |
| 1 | Require authenticated administrator and WebTTY surface availability. |
| 2 | Verify origin/CSRF/route mutation proof before body parsing. |
| 3 | Parse a bounded body with exactly `launch`, `cols`, and `rows`. |
| 4 | Lookup the record without revealing whether a foreign/expired ID ever existed. |
| 5 | Validate owner, auth-session fingerprint, route binding, TTL, and unused state. |
| 6 | Atomically consume the record and invalidate its siblings. Reuse always fails. |
| 7 | Re-resolve the selected workspace directory and require discovery-time directory identity consistency. |
| 8 | For Box, repeat normal cwd containment. For an agent, repeat exact-generation membership, exact-ID inspect, ownership labels, mount mapping, access, and quarantine checks from scratch. |
| 9 | Commit the route generation immediately before provider allocation. |
| 10 | Reserve normal WebTTY quotas, create the provider-specific worker, persist the v2 recovery record, and wait for a verified ready message. |
| 11 | Return safe session metadata: ID, target kind/label/detail, selected relative directory, effective cwd display, access, dimensions. |

Use non-enumerating `404` for unknown, foreign, expired, or reused launch IDs. Use `409 terminal_target_stale` only after a valid owned record is consumed but target/directory revalidation detects drift. Use `429` for launch/discovery/session quotas and `503` for provider/runtime failure. Never silently select Box when an agent launch becomes stale.

## 10. Provider and worker architecture

### 10.1 Common provider contract

Introduce an internal provider abstraction with the semantics already expected by `WebttySessionManager`:

| Method/event | Contract |
| --- | --- |
| `spawn()` | Start only the small Router child worker and return exact worker identity. |
| `start(spec)` | Allocate the Box PTY or exact agent exec; resolve only after provider-specific recovery evidence is complete and persisted. |
| `input(data)` | Deliver bounded input to the exact terminal. |
| `resize(cols, rows)` | Resize the exact terminal and fail closed on provider mismatch. |
| `close()` | Request deterministic termination and cleanup. |
| `waitForExit()` | Bounded proof that the worker exited. |
| Output/exit/error events | Preserve existing sequence, backpressure, replay, and safe error-category behavior. |
| `validateTarget()` | Agent-only bounded exact-ID/generation liveness check used by the session sweep. |
| Recovery evidence | Return a discriminated, exact schema; never expose it to the browser. |

The Box provider wraps the existing `WebttyWorkerClient` and `terminal-worker.mjs` without changing their v1 message schema, exact environment, shell, or cwd behavior.

### 10.2 Separate agent worker

Add a separate `agent-terminal-worker.mjs` and agent protocol. Its initialization message must use exact fields and accept only server-resolved values, for example:

```text
{
  protocol,
  type: "init-agent",
  terminalId,
  runtime,
  containerId,
  translatedCwd,
  marker,
  cols,
  rows
}
```

The final ready/recovery fields depend on the Phase 0 backend. The protocol must actually carry or derive the random marker used by cleanup proof; a marker that exists only in a plan or Router record is not evidence.

The worker process environment is a new exact allowlist. Start from the existing secret-scrubbed Box base and add only rootless Podman variables proven necessary by Phase 0. Never fork the worker with inherited Router environment or send cookies, auth leases, route plans, user objects, workspace secrets, or browser values over IPC.

### 10.3 Shell policy

| Concern | Policy |
| --- | --- |
| Executable | Fixed Ploinky-owned shell selection: Bash without profiles when present, otherwise interactive `/bin/sh`. |
| Fallback | Use a constant non-user-controlled wrapper/probe that distinguishes Bash absence. Do not retry `/bin/sh` for stale container, invalid cwd, permission, runtime, or identity failures. |
| Cwd | Pass the translated cwd through Podman's `-w` or the equivalent structured API field. Never build `cd '<browser-value>'` shell strings. |
| Arguments | Constant Ploinky-owned argv only. |
| Agent environment | Inherit the target container's configured environment as normal exec behavior, with only controlled terminal variables such as `TERM` added. |
| Browser input | Cannot choose shell, argv, environment, user, runtime flags, or cwd. |
| Missing shells | Report a target-specific `shell_unavailable` error and leave no worker/exec process. |

## 11. Session identity, cleanup, and recovery

### 11.1 Provider-aware availability

Replace the single boolean readiness model with structured availability:

| Domain | Behavior |
| --- | --- |
| Box provider | Preserves current conservative semantics. Unproven Box cleanup may disable all WebTTY because its recovery evidence is in the Box namespace. |
| Exact agent target | A cleanup ambiguity proven to concern one immutable target closes that session and quarantines that target only. Box and unrelated proven agents remain usable. |
| Agent provider | A systemic agent-provider failure or evidence mechanism failure disables all agent targets while preserving Box. |
| Unclassifiable record | Unsafe/unparseable evidence whose target kind cannot be established keeps the current global fail-closed behavior. |

Discovery always includes Box when Box is available. When the agent provider is unavailable, return Box plus a safe `agentTargetsAvailable: false` indication so the modal can explain that agent terminals are temporarily unavailable without exposing recovery internals.

Quarantine keys must contain the immutable container ID and enable generation, not only an alias/name. Do not clear a quarantine on a timer. Clear it only after recovery proves the recorded shell is gone and the record is safely removed, or after the exact old container is gone/replaced and all provider evidence is proven absent. Box recreation is the operator recovery when evidence cannot be proven.

### 11.2 Recovery schema v2

Because migrations are not required, replace v1 with an exact target-discriminated v2 schema and deploy it in a fresh Box with an empty ephemeral `/run/ploinky/webtty` directory.

| Record kind | Required evidence |
| --- | --- |
| Common | Schema, Router epoch, random marker, target kind, worker identity/start token/UID, created time, lifecycle state, cleanup state |
| Box | Existing PTY PID/start token/UID/process group/session evidence |
| Agent | Runtime and immutable target tuple plus backend-specific client and inner-shell/exec evidence chosen in Phase 0 |

Recovery must distinguish:

| State | Recovery result |
| --- | --- |
| Worker and terminal provably gone | Remove the record and keep the relevant provider available. |
| Live exact Box record | Use current verified Box reclamation, then prove no session members. |
| Live exact agent record | Use the selected provider's exact termination protocol, then prove marker/process/exec evidence is gone. |
| Agent container absent and all recorded client/inner evidence gone | Reclaim the record as proven dead. |
| Parseable target-specific ambiguity | Preserve evidence and quarantine that immutable target. |
| Systemic agent evidence failure | Preserve evidence and disable agent targets only. |
| Unsafe/unclassifiable record | Preserve it and disable all WebTTY. Never kill from an unproven PID. |

### 11.3 Live session validation

Extend the existing five-second auth/generation sweep for agent sessions with a bounded provider check of exact container identity and running state. Route-lease replacement, auth expiry/revocation, container stop/removal, identity mismatch, idle timeout, absolute timeout, stream detach, or workspace destroy closes the exact session. A same-named replacement can never inherit the old session because every provider operation is bound to the immutable ID.

## 12. Explorer modal implementation

### 12.1 Files and registration

Add a dedicated modal component under:

```text
AssistOSExplorer/explorer/web-components/modals/terminal-target-modal/
  terminal-target-modal.js
  terminal-target-modal.html
  terminal-target-modal.css
```

Register it in `explorer/webskel.json`. Update `FileExp.openTerminalHere()` to open the modal with only the canonical workspace-relative folder. Do not put target discovery or mount logic in `file-exp.js`.

### 12.2 Modal states and behavior

| State | Required presentation |
| --- | --- |
| Loading | Title **Open terminal in**, selected folder, progress status, disabled target area, and Cancel |
| Ready | Box first; agent rows sorted stably by case-insensitive label then detail; one direct-click button per row |
| Read-only | Visible **Read only** badge with text explaining it applies to the selected folder |
| Agent provider unavailable | Box remains selectable; show a generic agent-target warning |
| No eligible agents | Box remains selectable; explain that no running agent has a proven mount for this folder |
| Discovery error | Show retry and cancel; do not open a terminal or fabricate Box locally |
| Expired/stale rows | Refresh discovery and replace the complete batch; never reuse old launch IDs |
| Popup blocked | Keep the modal open and show instructions; do not consume or silently navigate the current Explorer tab |

The modal must support a stock Explorer root selection with at least 15 rows without overflowing the viewport. Use a bounded scroll region, keyboard navigation, visible focus, semantic buttons/list labels, focus trapping/restoration through the existing modal framework, an `aria-live` status, Escape/cancel behavior, and no target selection on row focus alone.

Show a concise notice with the agent choices: entering an agent runs with that container's normal user, tools, environment, permissions, and credential context. The modal must explain the consequence without displaying or copying any credential or environment value. The notice is informational for administrators, not a second confirmation dialog.

The `window.open()` call must occur synchronously inside the target button's click handler so it is a direct user gesture. After a non-null popup handle is returned, close the modal. Preserve `noopener,noreferrer`; do not add a cross-window `opener`, `postMessage`, or shared browser storage channel.

## 13. WebTTY page changes

| Area | Required change |
| --- | --- |
| Launch parsing | Read only `#launch=<id>`, validate its syntax, and immediately call `history.replaceState()` to remove it. |
| Auto-create | Create a session only when a syntactically valid launch ID was present. Remove `?dir=` auto-creation. |
| Request body | Send exactly `{launch, cols, rows}`. |
| Header/banner | Show safe target label/detail, Box or Agent badge, selected-folder access, and effective cwd returned by the server. |
| Stale target | Show **This terminal target changed. Close this tab and choose again from Explorer.** Do not fall back to Box. |
| Invalid/reused/expired launch | Show a non-enumerating unavailable message and create no EventSource. |
| Transport | Preserve existing SSE replay, input batching, resize, backpressure, close, and pagehide behavior. |
| Storage | Do not store launch IDs in local/session storage, cookies, query parameters, or history. |

## 14. Security, privacy, and audit requirements

| Threat | Required control |
| --- | --- |
| Ordinary user calls hidden endpoints | Every page, discovery, create, stream, input, resize, cancel, and close route independently enforces authenticated administrator authority as applicable. |
| Cross-site request | Discovery, create, input, resize, cancel, and close use the existing origin/CSRF/generation mutation proof before body parsing or allocation. |
| Forged target | Only a random record minted for this admin session/directory/generation can be consumed, followed by full revalidation. |
| Record replay | Atomic single-use consumption and sibling invalidation. |
| Cross-workspace access | Bind to exact routed host/generation and validate selected realpath under `/workspace`. |
| Container substitution | Full immutable ID plus managed labels, instance ID, and enable generation. |
| Mount confusion | Exact algorithm in section 8, including non-bind destination shadows. |
| Arbitrary exec | No browser-provided runtime/container/shell/argv/env/user/cwd fields. |
| Secret leakage | Redacted inspect projection; no environment values, terminal contents, cookies, auth material, mount sources, or physical paths in responses/logs. |
| Orphan process | Exact provider identity, bounded TERM/KILL or API termination, foreground-member sweep, post-close proof, and recovery record. |
| Denial of service | Discovery/session quotas, CSPRNG record bounds, timeouts, concurrency limits, body limits, IPC/output limits, and expiry cleanup. |

Audit only lifecycle metadata: hashed terminal ID, target kind, hashed immutable instance identity, generation, canonical relative directory, access mode, timestamps, duration, exit/cleanup category, and quarantine/provider state transition. Never record keystrokes, output, commands, environment values, tokens, raw container IDs, or host mount paths.

## 15. File-level implementation map

Exact names may adjust to local conventions, but responsibilities must remain separated.

| Repository/path | Planned work |
| --- | --- |
| `ploinky/cli/sandbox/docker/containerRegistry.js` or a new adjacent exact-inspect module | Add async inspect-by-full-ID with timeout/concurrency injection and the redacted mount/identity projection. Preserve existing consumers. |
| `ploinky/cli/server/edgeRoutePlan.js` / confinement helper | Export or factor reusable exact active-runtime and managed-label verification instead of duplicating it. |
| `ploinky/cli/server/webtty/terminalTargetResolver.mjs` | Active-generation enumeration, exact inspect, ownership verification, mount translation, access derivation, target display model, create-time revalidation. |
| `ploinky/cli/server/webtty/launchRecords.mjs` | CSPRNG discovery batches, auth/route/directory/target binding, quotas, expiry, atomic consumption, sibling invalidation, logout/generation cleanup. |
| `ploinky/cli/server/handlers/webtty.js` | Add discovery create/cancel routes, hard-cut session body, status mapping, safe responses, target-aware availability. |
| `ploinky/cli/server/webtty/sessionManager.mjs` | Provider selection, target metadata, provider-aware readiness/quarantine, exact target validation sweep, target-aware audit and recovery handling. |
| `ploinky/cli/server/webtty/workerClient.mjs` | Keep Box client behavior; factor only common mechanics if tests prove zero Box behavior change. |
| `ploinky/cli/server/webtty/agentWorkerClient.mjs` | Fork the separate agent worker with an exact secret-scrubbed Podman environment and protocol. |
| `ploinky/core-services/webtty/agent-worker-protocol.mjs` | Exact agent-only IPC envelopes and provider-specific ready evidence selected by Phase 0. |
| `ploinky/core-services/webtty/agent-terminal-worker.mjs` | Fixed agent exec, I/O/resize, marker capture, deterministic cleanup, and error categorization. |
| `ploinky/core-services/webtty/environment.mjs` or adjacent agent environment module | Preserve Box exact environment and add a separately tested agent-worker allowlist. |
| `ploinky/cli/server/webtty/runtimeRecords.mjs` | Target-discriminated v2 schema and provider-aware recovery outcomes. No v1 migration. |
| `ploinky/cli/server/webtty/webtty.js` | Fragment consume/strip, new create body, target banner, stale/invalid states; retain SSE plus POST behavior. |
| `ploinky/cli/server/webtty/webtty.html` / `webtty.css` | Target/cwd/access presentation and accessible failure states. |
| `AssistOSExplorer/explorer/web-components/pages/file-exp/file-exp.js` | Replace direct tab creation with modal invocation. |
| `AssistOSExplorer/explorer/web-components/modals/terminal-target-modal/*` | Discovery UI, safe rendering, stable sorting, direct-gesture popup, retry/cancel/accessibility. |
| `AssistOSExplorer/explorer/webskel.json` | Register the new modal. |
| Explorer docs | Update `docs/specs/DS002-ploinky-runtime.md`, `DS010-workspace-operations.md`, matching HTML/operator docs, and WebTTY smoke documentation as required by Explorer's repository rules. |
| Ploinky docs | Update maintained operator/readme/proposal documentation only. Do not update historical Ploinky DS/spec files as behavior authority. |
| `container-image-builds` | No source change expected; rerun native WebTTY/image hygiene tests and verify no helper image appears. |
| `basic` | No source change expected; verify `basic/webtty` and its references remain absent. |

## 16. Implementation phases and exit gates

| Phase | Work | Exit gate |
| --- | --- | --- |
| A. Prerequisites and branches | Complete section 4 and record branch points. | New clean feature branches exist; required merges are ancestors. |
| B. Runtime spike | Execute section 6 and select one backend. | Evidence document and executable lifecycle harness prove every required cleanup/resize/identity behavior. |
| C. Exact inspect and resolver | Add reusable identity verification, async exact inspect, canonical mount algorithm, and agent availability model. | Resolver/projection unit matrix passes; event loop remains bounded; Box-only result survives agent inspect failures. |
| D. Launch records and discovery API | Add mutation-protected discovery batches, safe response rows, quotas, expiry, cancel, and atomic single-use consumption. | Handler/record tests pass for owner, directory, generation, expiry, replay, redaction, quota, and timeout cases. |
| E. Box provider abstraction | Put current Box worker behind the common provider seam without changing worker protocol or behavior. | Every existing Box WebTTY test remains green before agent code is enabled. |
| F. Agent worker/provider | Implement only the Phase 0-selected backend, agent protocol/env, exact shell/cwd, I/O, resize, close, cleanup, and validation. | Component/integration tests prove exact target, fallback semantics, foreground cleanup, non-root cleanup, and same-name replacement refusal. |
| G. Recovery and failure domains | Implement v2 records, target quarantine, agent-provider disable, Box/global conservative cases, and startup recovery. | Ambiguous agent cleanup does not interrupt an active Box session; unclassifiable evidence still fails globally closed. |
| H. Session API and WebTTY client hard cut | Consume launch records, revalidate, return target metadata, remove query auto-create, add banner/errors. | Handler/client tests pass; direct `?dir=` creates nothing. |
| I. Explorer modal | Add component, registration, launcher change, popup handling, accessibility, and docs. | Explorer unit/DOM tests pass; ordinary user still has no action. |
| J. Static and integration verification | Run scoped suites in both repositories plus image/absence contracts. | All required non-browser gates pass on clean exact candidates. |
| K. Fresh deployment and browser E2E | After explicit authorization in the implementation task, push exact candidates, recreate the dedicated fixture, deploy, run feature and mandatory release gates, audit cleanup. | Every command reports the exact expected test and passes with no skips/retries/ignored errors; resources are clean afterward. |
| L. Coordinated cutover | Merge/release the exact tested Ploinky and Explorer pair with no mixed old/new UI/API deployment. | Defaults contain the tested commits and release evidence identifies the pair. |

## 17. Required automated test matrix

### 17.1 Ploinky unit and component tests

| Area | Required cases |
| --- | --- |
| Exact inspect projection | Full immutable ID; running/stopped; label retention; bind rw/ro; named volume; tmpfs; missing `RW`; malformed JSON; timeout; oversized output; one failed target does not poison others |
| Candidate identity | Current generation success; missing/partial container ID; missing instance/generation; wrong labels/name/ID; stopped container; record absent from generation; network-`none` eligible; host runtimes omitted; unsupported non-Box provider topology returns no agent targets without remote access |
| Workspace cwd | Root/nested; Unicode/literal `%`; malformed/double-encoded traversal; symlink contained/escape; file/missing; path changes between discovery and create |
| Mount resolver | Global/static; isolated `/root`; devel; manifest bind; `.ploinky/code/<agent>` symlink; most-specific source; equal-specificity ambiguity; rw/ro; unknown `RW`; file bind; named-volume source rejection; non-bind destination shadow; bind shadow mapping same/different source; staged `/code` source not matching original repo |
| Launch records | CSPRNG shape; owner/session/host/generation/directory binding; TTL; quota; batch cancellation; sibling invalidation; atomic double-consume race; logout/restart/generation invalidation; no raw identities in response |
| Handler | Auth 401/403; local CLI-admin mutation proof; body-before-CSRF rejection; discovery and cancel; exact create body; foreign/expired/reused 404; stale 409; quota 429; provider 503; response headers/redaction |
| Box provider regression | Current create/input/output/resize/SSE replay/close/timeout/auth revocation/foreground cleanup/recovery tests unchanged |
| Agent protocol/env | Exact fields; unknown/extra/browser fields rejected; marker present; fixed argv; no inherited secret canary; only Phase 0 Podman env keys; bounded messages/output |
| Agent provider | Exact ID; translated cwd; target env; Bash selection; true Bash-absence fallback only; missing shells; resize; normal exit; client crash; foreground child; non-root target; container stop/remove; replacement refusal; cleanup proof |
| Availability/recovery | Target-only quarantine; systemic agent disable with Box usable; parseable dead record self-heal; container-absent self-heal; unclassifiable record global failure; Box ambiguity keeps conservative behavior; no unverified signal |
| WebTTY client | Fragment parse/strip; no query auto-create; no launch no create; target banner; stale/invalid errors; SSE replay and input/resize behavior retained; launch never stored |

### 17.2 Explorer unit and DOM tests

| Area | Required cases |
| --- | --- |
| Menu | Directory admin sees action; ordinary user and file target do not; menu cache remains correct |
| Launcher | Calls modal with canonical workspace-relative directory and does not call `window.open` itself |
| Modal discovery | Sends same-origin protected request; loading, retry, cancellation, Box-only, agent-unavailable, no-agent, and error states |
| Rendering | Box first; stable agent order; duplicate display labels remain distinguishable; rw/ro badge; agent permission/credential-context notice; no unsafe `innerHTML`; no raw identity retained/rendered |
| Popup | Target click directly calls `window.open` with `/webtty/#launch=...` and `noopener,noreferrer`; blocked popup keeps modal open; successful popup closes it |
| Expiry/refresh | Refresh invalidates the prior batch and replaces every launch ID |
| Accessibility | Keyboard reachability, focus visibility/restoration, semantic list/buttons, Escape/cancel, status announcements, scroll behavior with at least 15 targets |

### 17.3 Repository integration and static tests

| Repository | Required commands/gates |
| --- | --- |
| `ploinky` | Narrow WebTTY/target tests first, then the full relevant unit/integration suite and existing routing/security/image-contract tests |
| `AssistOSExplorer/explorer` | New modal/launcher tests, `npm test`, documentation/registration contracts |
| `AssistOSExplorer/tests/smoke` | Unit/profile selector tests, updated WebTTY profile contract, `--list` proving the intended browser test is discovered exactly once |
| `container-image-builds` | Existing Box WebTTY native runtime, image definition, source-boundary, transport/entrypoint, no-helper-image, and hygiene tests |
| `basic` | Search/contract proof that no WebTTY agent, manifest, image, port 7681, or old route was restored |

## 18. Fresh-deployment browser and runtime acceptance

The implementation prompt/task must explicitly authorize E2E in that same task. Once authorized, this phase is mandatory before completion. If implementation starts without that authorization, stop at code-complete verification and request it; do not declare the feature complete.

Follow the exact fresh-fixture and revision-pinning contract in `ploinky/CLAUDE.md`:

| Step | Requirement |
| --- | --- |
| Pin | Commit and push exact candidate revisions; record branch/upstream/commit for Ploinky and every deployed repo plus immutable Box image identity. |
| Fixture | Coordinate exclusive ownership of the shared Podman VM and `~/work/testExplorerFresh`; destroy only the exact prior fixture; recreate it genuinely fresh. |
| Deploy | Run the literal command `cd ~/work/testExplorerFresh && ploinky start explorer`, with branch selection handled separately. |
| Prove | Confirm clean exact revisions, complete graph readiness, expected Box identity/generation, rootless privileges, and allowed network publications. |
| Feature gate | Run the updated WebTTY target-selection Playwright spec in headless Chromium, one worker, zero retries, fresh run ID/artifact directory. |
| Mandatory cross-repo gates | Also run the exact OnlyOffice confidential-save, Copilot folder-launch, and two-account WebMeet media/chat gates required by `ploinky/CLAUDE.md`. |
| Cleanup | Destroy the exact test Box and audit workspace-owned containers, networks, volumes, listeners, marked processes/exec sessions, and fixture path. Preserve redacted evidence outside tracked source. |

The updated WebTTY browser spec must prove:

| Case | Required evidence |
| --- | --- |
| Explorer modal | Menu click opens the Explorer modal, not a WebTTY tab; Box appears first; at least one proven global/static agent appears. |
| Box target | Row click opens a new same-origin tab; banner says Ploinky Box; `pwd` is `/workspace/<selected-relative>`; host/browser marker round-trip succeeds. |
| Exact agent target | Select a known global/static agent; banner identifies it; a pre-established in-container marker or independently inspected hostname proves the shell is in the exact immutable container; `pwd` equals the translated cwd. Prompt text is not identity proof. |
| Eligibility | A folder not mounted into an isolated agent does not list that agent; a folder that is mounted maps to the expected target path. Network-`none` eligibility is proven in integration if no release agent supplies that case. |
| Read-only | Unit/integration must prove the resolver/UI and actual write failure. Browser proof is additionally required when the exact release graph contains a suitable read-only selected-folder mount; do not fabricate or skip a test silently. |
| Stale selection | Mint a row, replace/restart the agent, then consume the old row; receive stale/unavailable behavior and create no shell in the replacement. Refreshing the Explorer modal produces a new selectable identity. |
| Authorization | Ordinary user has no menu item and receives 403 from page/discovery/create attempts. Cross-session launch-record consumption fails. |
| Replay | A consumed launch ID cannot create a second terminal. The fragment is absent from requests, history after bootstrap, and evidence logs. |
| Cleanup | Run a foreground process, close the terminal, and prove the exact inner marker/process group and engine exec evidence are gone. |
| Failure isolation | After agent terminal cleanup/restart scenarios, open and use a Box terminal in the same browser run. |
| Diagnostics | No browser/page/network errors, retries, skips, softened assertions, or leaked credentials. |

Update the existing `01-webtty-core.spec.mjs` helpers and assertions rather than keeping the obsolete direct `?dir=` path. The second Box terminal in the current smoke test must also be opened through the Explorer modal because direct query creation is intentionally removed.

## 19. Documentation and coordinated hard cut

| Repository | Documentation action |
| --- | --- |
| Ploinky | Keep this plan and spike evidence current; update maintained operator/security/readme material that describes WebTTY APIs and failure recovery. Do not modify historical Ploinky DS/spec files. |
| Explorer | Update `docs/specs/DS002-ploinky-runtime.md`, `docs/specs/DS010-workspace-operations.md`, `docs/workspace-operations.html`, `docs/index.html`, `docs/deploy-skills-explorer.md`, and smoke README/profile documentation to describe the modal and opaque launch handoff. |
| Basic/image repositories | Record verification evidence only unless a real source change was required. |

Because compatibility is intentionally not provided, old Explorer plus new Ploinky and new Explorer plus old Ploinky are unsupported pairs. Build and test exact companion revisions, then coordinate their merge/release so a deployment does not silently mix the old direct `{dir,...}` launcher with the new `{launch,...}` API.

## 20. Completion checklist

| Gate | Pass condition |
| --- | --- |
| Branching | Work was implemented on new feature branches from verified updated defaults after required merges. |
| UX | Explorer modal appears before a tab opens and lets the admin select Box or eligible agents. |
| Authority | Ploinky alone derives target eligibility and path translation from exact live state. |
| Identity | Agent session is bound to full immutable ID, ownership labels, instance, and generation. |
| Cwd | Box and agent shells start in the exact equivalent selected folder, not a hard-coded `/workspace` default. |
| Packaging | `node-pty` remains only in `ploinky-box`; no helper image or agent dependency exists. |
| Core ownership | WebTTY remains a Ploinky-core Router surface; no separately deployed WebTTY agent/service exists. |
| Transport | Existing SSE plus POST behavior remains intact. |
| Security | No raw target selector, arbitrary exec input, cross-workspace record, replay, stale replacement, or path/mount escape succeeds. |
| Cleanup | Normal, foreground-child, disconnect, timeout, restart, replacement, and recovery paths leave no unproven inner shell. |
| Failure isolation | Agent-specific/systemic failures preserve Box according to section 11; unclassifiable/Box evidence still fails conservatively. |
| Compatibility | Old body/query behavior and migration code are absent. |
| Legacy absence | `basic/webtty`, port 7681, old routes/images/workflows, and helper-image references remain absent. |
| Tests | All scoped unit/integration/static tests and explicitly authorized fresh browser/release gates pass on exact pushed candidates. |
| Cleanup evidence | Shared test resources and workspace-owned Podman resources are verified clean and handed back. |

## 21. Unknowns that Phase 0 must resolve

| Unknown | Decisive check |
| --- | --- |
| Exact nested Podman version and API/exec behavior in the shipped image | Inventory inside the exact immutable Box image, not the macOS client. |
| Whether the real inner shell is reliably visible and distinguishable in Box `/proc` | Launch marked root/non-root shells and capture stable PID/start-token/session/namespace evidence. |
| Marker mechanism that survives the fixed shell wrapper without accepting browser data | Test the actual `/proc`/API evidence; include it in the agent protocol and record only after proof. |
| Cross-UID termination permissions and `NSpid` mapping | Exercise a non-root `USER` image and prove the exact safe kill path. |
| Double-PTY resize and disconnect semantics | Run `stty size`, client-kill, foreground-process, and terminal close tests through node-pty and Podman. |
| REST exec termination and service/socket lifecycle | Exercise the exact available API; do not infer from generic Podman documentation. |
| Minimal secret-free Podman worker environment | Start from an empty/fixed environment and add only variables required by the exact nested runtime. |
| Whether inspect bind sources require Box-side realpath normalization | Bind through a symlink in the spike and compare inspected source with actual realpath. |
| Direct-host/development behavior where the Router is not inside the production Box runtime | Prove the provider-locality probe returns agent-target unavailable without touching a remote runtime; pin Box-only versus whole-surface-unavailable behavior to the existing core Box-provider availability with a unit test. |

No production agent worker or recovery schema should be finalized until these questions have executable evidence.
