# Proposal: Runtime Selection for “Open Terminal Here”

| Field | Value |
|---|---|
| Status | Proposed follow-on to WebTTY core |
| Date | 2026-08-28 |
| Proposal baseline | Ploinky branch `feature/webtty-core`, commit `9576d6c98db69a0d09d2bbe28083d969224c7077` |
| Primary repositories | `ploinky`, `AssistOSExplorer` |
| Implementation branch | A new feature branch; see “Branch and repository sequencing” |

## 1. Purpose

Explorer administrators should be able to choose the runtime in which “Open Terminal Here” starts a shell:

1. the Ploinky Box container, with access to the complete workspace from which Ploinky was launched; or
2. a currently running Ploinky agent container whose effective runtime mounts give it access to the selected folder.

This is a follow-on feature to WebTTY core. It is not merely a new popup. It adds runtime discovery, path translation, exact container targeting, a second terminal provider, and lifecycle guarantees for shells running in agent containers.

## 2. User requirements

| ID | Requirement | Acceptance meaning |
|---|---|---|
| UR-1 | In Explorer, the folder three-dot menu continues to contain “Open Terminal Here.” | The action is available for a folder and remains admin-only. |
| UR-2 | Activating the action opens a chooser before the terminal is launched. | The administrator explicitly chooses the terminal runtime. |
| UR-3 | The chooser always offers the Ploinky Box. | Selecting it opens the existing Ploinky-core WebTTY shell at the selected workspace folder. |
| UR-4 | The chooser lists Ploinky agents that have access to the selected folder. | Eligibility is determined from the exact active runtime and its effective mounts, not from a manifest declaration or run-mode guess alone. |
| UR-5 | Selecting an agent opens the shell inside that exact running agent container. | The shell sees that agent’s installed tools, filesystem, environment, and permissions, and starts at the container path corresponding to the selected Explorer folder. |
| UR-6 | The Box terminal covers the entire workspace from which Ploinky was run. | The launch directory on the host is mounted as `/workspace` in the Box. A selected host-workspace-relative folder therefore becomes `/workspace/<relative-folder>` in the Box. |
| UR-7 | WebTTY remains part of Ploinky core. | Do not restore WebTTY as a separately managed Ploinky agent. |
| UR-8 | `node-pty` belongs in the `ploinky-box` image. | Do not introduce a WebTTY helper image, and do not require every agent image to package `node-pty`. |
| UR-9 | Backward compatibility and migrations are not required. | The API and UI may make a clean cut to the new contract. No compatibility shim for the old session body is required. |
| UR-10 | The legacy `basic/webtty` agent may be removed directly. | Do not preserve or revive it for this feature. |
| UR-11 | Implementation must happen on a new branch. | Do not implement directly on a repository’s default branch or continue feature work on the existing WebTTY-core branch after it is merged. |
| UR-12 | End-to-end tests must be run before implementation is declared complete. | The fresh deployed Box, Explorer UI, Box terminal, agent terminal, authorization, stale-target, and cleanup paths must all be exercised. |

## 3. Decision summary

| Area | Proposed decision |
|---|---|
| Chooser ownership | Explorer renders the modal because the action originates there; Ploinky supplies all target eligibility and security decisions. |
| Box target | Always present when WebTTY is available to the current administrator. |
| Agent target | Selectable only when an exact ready/running runtime for the current workspace generation has an effective mount that contains the selected directory. |
| Path mapping | Translate the canonical Box workspace path through the most-specific matching active mount into the target container destination. |
| Browser contract | The browser receives display metadata and an opaque, short-lived, admin-session-bound target token; it never supplies a container name, container ID, executable, translated path, or arbitrary arguments. |
| Session creation | Ploinky revalidates authorization, workspace generation, runtime identity, mount topology, target state, and directory containment when the session is created. |
| Terminal providers | Preserve the current Box `node-pty` provider and add an OCI-agent provider behind a common session interface. |
| Agent PTY lifecycle | Require an engine-owned or otherwise verifiable inner exec-session identity. Killing only a local `podman exec` client is not sufficient proof that the shell inside the agent exited. |
| Image packaging | Keep `node-pty` in `ploinky-box`; add no helper image and no blanket dependency to agent images. |
| Auditing | Record target/runtime/session lifecycle metadata, but never terminal input, output, commands, or environment values. |

## 4. Verified current state

The following statements are observations from the current codebase, not assumptions about the proposed implementation.

| Observation | Evidence |
|---|---|
| Explorer exposes “Open Terminal Here” only to administrators. | `AssistOSExplorer/explorer/web-components/pages/file-exp/file-exp-menu-contributions.js:216` |
| Explorer currently opens the same-origin `/webtty/?dir=...` URL directly, without a target chooser. | `AssistOSExplorer/explorer/web-components/pages/file-exp/file-exp.js:1736` |
| Current unit coverage asserts the direct-launch behavior. | `AssistOSExplorer/explorer/tests/unit/fileExpContextMenuCache.test.js:22` |
| Current WebTTY session creation accepts the Box-relative directory and terminal dimensions, then creates a local Box PTY worker. | `ploinky/cli/server/handlers/webtty.js:184`, `ploinky/cli/server/webtty/sessionManager.mjs:250` |
| The current worker spawns a shell inside the Box using `node-pty`. | `ploinky/core-services/webtty/terminal-worker.mjs:173` |
| WebTTY canonicalizes the requested directory beneath `/workspace`, including a realpath containment check. | `ploinky/core-services/webtty/cwd.mjs:4`, `ploinky/core-services/webtty/cwd.mjs:28` |
| Ploinky derives different project mounts for global, isolated, development, and configured/static agents. | `ploinky/cli/utils/agents.js:487` |
| The agent service manager assembles the actual bind set and persists effective runtime bind information. | `ploinky/cli/sandbox/docker/agentServiceManager.js:880`, `ploinky/cli/sandbox/docker/agentServiceManager.js:2160` |
| Container inspection normalizes actual OCI mount sources, destinations, and read/write state. | `ploinky/cli/sandbox/docker/containerRegistry.js:58` |
| Ploinky already has an interactive `podman exec -it` shell path for CLI use. | `ploinky/cli/sandbox/docker/interactive.js:514` |
| The existing runtime relay is an authenticated HTTP relay, not a PTY protocol. | `ploinky/cli/server/runtimeRelay/RuntimeRelayManager.js:158` |
| Ploinky’s security model requires exact runtime identity and closed routing surfaces. | `ploinky/docs/specs/DS013-security-model.md:18`, `ploinky/docs/specs/DS007-routing-and-web-surfaces.md:62` |

## 5. Terminology and invariants

| Term | Meaning |
|---|---|
| Workspace path | A canonical path beneath the Box mount root `/workspace`, representing the host directory from which Ploinky was launched. |
| Effective mount | A mount reported for the exact live container after all Ploinky defaults, manifest volumes, generated mounts, and runtime-specific staging have been applied. |
| Eligible agent | A current-generation, ready/running Ploinky-managed container with a provable effective mapping for the selected workspace directory. |
| Target token | An opaque, short-lived server-issued selector bound to the authenticated admin, workspace host, active generation, selected directory, and exact runtime identity. |
| Box provider | The current local `node-pty` shell provider running inside `ploinky-box`. |
| Agent provider | A new provider that allocates and manages a PTY exec session in an exact Ploinky agent container. |

The following invariants are mandatory:

| Invariant | Required behavior |
|---|---|
| Fail closed | Missing, stale, ambiguous, unverifiable, or inconsistent runtime/mount data produces no selectable agent target. |
| Exact identity | Never select an agent solely by human-readable alias or mutable container name. |
| Server authority | The client never decides whether a target can access a directory or what target path should be used. |
| Revalidation | Discovery is advisory; session creation repeats all security-sensitive checks. |
| No namespace widening | WebTTY does not introduce a generic container exec API or accept arbitrary executable/argv/environment input. |
| Inner-process cleanup | Session close must terminate and verify the shell inside the target container, including foreground children. |
| Current generation only | Agent replacement, restart, route generation change, or workspace destruction invalidates the target and closes any affected session. |

## 6. Proposed user experience

| Step | User-visible behavior | System behavior |
|---|---|---|
| 1 | An administrator opens a folder’s three-dot menu and selects “Open Terminal Here.” | Explorer canonicalizes the selected workspace-relative folder representation but does not decide target eligibility. |
| 2 | A modal titled “Open terminal in” appears and displays the selected folder. | Explorer requests available targets from Ploinky. |
| 3 | “Ploinky Box” is shown first. Eligible agents follow. | Ploinky resolves targets from the current runtime state and effective mounts. |
| 4 | Each agent row shows its instance alias, agent/repository detail, and read-write or read-only access. | Raw container IDs, host paths, and credentials remain server-side. |
| 5 | The administrator selects one row. | A direct click opens the WebTTY tab, preserving browser popup semantics, and transfers only the selected folder plus opaque target token through a same-origin mechanism that does not place bearer material in access logs or referrers. |
| 6 | WebTTY displays the chosen target and translated working directory in a compact banner. | Ploinky revalidates the token and creates the target-specific PTY session. |
| 7 | Closing or disconnecting the terminal ends the shell. | Ploinky terminates the exact inner exec session, verifies cleanup, and removes all session state. |

Only ready/running agent targets are selectable. A starting agent may be shown as disabled only if Ploinky can identify it without claiming unverified mount access; otherwise it is omitted. Stopped, removed, stale-generation, or unhealthy instances are omitted.

The chooser should not hard-code known agents. For a typical Explorer deployment, Explorer itself may appear because it is a global/static agent with workspace access, but that is a result of runtime inspection rather than a UI special case.

## 7. Target discovery and path translation

### 7.1 Canonicalize the selected directory

Ploinky must apply the same containment guarantees used by the current Box WebTTY:

| Check | Failure result |
|---|---|
| Decode and normalize a workspace-relative directory. | Reject malformed or absolute input. |
| Resolve beneath `/workspace`. | Reject lexical traversal. |
| Resolve the real path and verify it remains under the exact workspace root. | Reject symlink escape. |
| Verify it is a directory. | Reject missing files and non-directories. |
| Bind the result to the active workspace host and generation. | Reject stale or cross-workspace use. |

The Box target uses this canonical `/workspace/<relative-directory>` path directly. `/workspace` is not a different user workspace: it is the container mount point for the host current working directory from which Ploinky was started.

### 7.2 Resolve exact agent runtimes

For every candidate agent instance, Ploinky should:

| Step | Requirement |
|---|---|
| Resolve configuration | Confirm the instance belongs to the active workspace topology and is enabled for the current generation. |
| Resolve runtime state | Require the exact runtime to be ready/running and owned by this Ploinky workspace. |
| Resolve immutable identity | Use the immutable container ID plus expected Ploinky ownership labels/metadata, not only a name. |
| Inspect mounts | Read the effective mounts from the exact live container. Do not infer access solely from `global`, `isolated`, `devel`, or manifest declarations. |
| Match directory | Find mounts whose source contains the canonical selected Box path. |
| Apply precedence | Choose the most-specific effective mount and account for nested/overlapping mounts. |
| Translate path | Append the selected path suffix to the matching container destination, normalize it, and verify it remains within that destination. |
| Detect destination shadowing | Check whether a more-specific mount at the translated destination hides the candidate mapping. Reject it unless that overlay independently and provably maps the same selected workspace directory. |
| Determine access | Derive read-write/read-only status from the effective mount at that path, including a more-specific overlay. |
| Verify in target | Confirm the translated path exists and is a directory in the exact container before allocating the shell. |

An agent that can reach Explorer APIs but does not have the selected directory mounted into its filesystem is not eligible. A coincidental same-named directory in the container image is also not eligible.

### 7.3 Translation example

| Effective mount source in Box | Destination in agent | Selected Explorer folder | Translated agent working directory |
|---|---|---|---|
| `/workspace` | `/workspace` | `projects/demo` | `/workspace/projects/demo` |
| `/workspace/projects/demo` | `/project` | `projects/demo/src` | `/project/src` |
| `/workspace/.data/example` | `/root` | `.data/example/output` | `/root/output` |

These examples illustrate mount translation only. The implementation must use actual inspected mounts instead of assuming these destination paths from an agent mode.

## 8. Proposed server contract

Exact naming may change during implementation, but the trust boundary must not.

### 8.1 Discover terminal targets

    GET /webtty/targets?dir=<workspace-relative-directory>

Illustrative response:

    {
      "ok": true,
      "directory": {
        "relativePath": "projects/demo"
      },
      "targets": [
        {
          "token": "<opaque-short-lived-token>",
          "kind": "box",
          "label": "Ploinky Box",
          "detail": "Workspace runtime",
          "access": "rw",
          "state": "ready",
          "cwdDisplay": "/workspace/projects/demo"
        },
        {
          "token": "<opaque-short-lived-token>",
          "kind": "agent",
          "label": "explorer",
          "detail": "AssistOS Explorer",
          "access": "rw",
          "state": "ready",
          "cwdDisplay": "/workspace/projects/demo"
        }
      ]
    }

The endpoint must use the existing WebTTY admin, authentication, host-binding, and origin protections. It must not return raw container IDs, private socket paths, host paths outside the workspace, credentials, or command-line material.

The token is not sufficient authority by itself: it is bound to the authenticated admin session, workspace host, active generation, canonical directory, target identity, and a short expiry. The handoff to the new tab should use a URL fragment, a one-time same-origin launch record, or another mechanism that keeps the token out of request/access logs and referrers. The implementation must not retain a reusable bearer capability in browser history.

### 8.2 Create a terminal session

    POST /webtty/sessions

Illustrative request:

    {
      "target": "<opaque-short-lived-token>",
      "dir": "projects/demo",
      "cols": 120,
      "rows": 32
    }

The server must not trust a translated working directory embedded in the token or supplied by the browser. It must resolve and validate the directory and target again, then bind the created terminal session to the exact container ID and active generation.

Because compatibility is not required, the old `{dir, cols, rows}` body may be replaced rather than supported in parallel.

## 9. Server architecture

| Component | Responsibility |
|---|---|
| `TerminalTargetResolver` | Canonicalize the selected directory; enumerate exact current runtimes; inspect effective mounts; translate paths; issue and validate opaque target tokens. |
| `BoxTerminalProvider` | Preserve the current Box-local `node-pty` behavior and workspace containment. |
| `AgentContainerTerminalProvider` | Allocate, attach, resize, close, and verify an interactive shell in one exact agent container. |
| Common terminal session interface | Present input, output, resize, exit, close, and cleanup semantics to the current WebTTY session manager independent of provider. |
| Session manager | Bind authorization, target identity, generation, lease, connection, timeout, and cleanup state for both providers. |
| Audit sink | Record lifecycle metadata without recording terminal contents. |

The common interface should preserve the WebTTY protocol already used by the browser. Target-provider differences stay behind the Ploinky server boundary.

## 10. Agent PTY mechanism: required design gate

The existing CLI `ploinky shell` proves that Ploinky can invoke an interactive command in an agent container. It does not, by itself, prove the stronger lifecycle guarantees required for a long-lived browser terminal.

The implementation must complete a focused spike before committing to the agent provider:

| Candidate | Benefits | Risks / questions | Recommendation |
|---|---|---|---|
| Podman engine exec API with a TTY and exact exec-session ID | Engine-owned identity may support attach, resize, inspect, and verifiable cleanup without adding agent dependencies. | Confirm support and behavior in the nested rootless Podman version used by `ploinky-box`; prove termination of the inner shell and foreground children. | Investigate first. This best matches the exact-identity requirement if the API can reliably terminate and inspect exec sessions. |
| `podman exec -it` launched under Box `node-pty`, plus an in-container session marker/wrapper | Reuses current tools and keeps `node-pty` only in the Box. | Killing the local client may leave the in-container process alive; resize and disconnect behavior must be proven; PID reuse and shell child trees complicate cleanup. | Accept only with a concrete inner-process identity, termination protocol, and post-close verification. |
| A Ploinky terminal broker inside every agent | Can own PTY lifecycle close to the shell. | Expands the trusted agent runtime, protocol, dependency, and image surface; may require `node-pty` or other PTY tooling in every image. | Not the default. Adopt only if evidence shows the engine approach cannot meet lifecycle requirements. |
| Reuse the existing HTTP runtime relay unchanged | Existing authenticated transport and container targeting. | The relay is HTTP request/response infrastructure, not a PTY stream or terminal lifecycle manager. | Do not overload it without an explicit protocol redesign and security review. |

No design is acceptable if “close” merely kills the Box-side CLI process and assumes the inner shell disappeared. The selected design must prove:

| Lifecycle event | Required proof |
|---|---|
| Create | The shell belongs to the requested immutable container and current workspace generation. |
| Resize | Terminal dimensions reach the exact exec session. |
| Disconnect/timeout | The shell and its foreground process group are terminated or otherwise deterministically reaped. |
| Agent restart/replacement | The WebTTY session exits and cannot attach to a same-named replacement. |
| Workspace destroy | All target sessions close before or as their runtimes disappear. |
| Cleanup verification | No orphan exec session or marked shell remains in the container after close. |

## 11. Shell and environment policy

| Concern | Policy |
|---|---|
| Executable | Ploinky chooses a fixed interactive shell policy, such as `/bin/bash` with a controlled fallback to `/bin/sh`. The browser cannot choose an executable. |
| Arguments | Ploinky owns the fixed argument list. No arbitrary browser-supplied argv. |
| Working directory | Derived only from canonical workspace path plus inspected mount translation. |
| Environment | The shell naturally receives the target container’s configured environment. This is an intentional consequence of entering that agent runtime. |
| Credentials | The chooser should make clear that an agent terminal exposes that agent’s runtime permissions and credentials to the administrator. Values are never copied into responses or audit logs. |
| Read-only mounts | A read-only target may still be offered with a visible “Read only” badge; writes must fail according to the actual mount. |

An administrator with a Box terminal already has access to nested Podman control and can inspect managed agent containers. Direct agent selection is therefore primarily a safer, more convenient path to an authority the Box administrator already has, not a new non-admin privilege. It still requires explicit selection and auditing because it changes the runtime environment and credential context.

## 12. Security and audit requirements

| Threat | Required mitigation |
|---|---|
| Non-admin access | Enforce authorization independently on target discovery, session creation, terminal page load, and WebSocket attachment. UI hiding is not a security control. |
| Cross-workspace target | Bind discovery and session creation to the exact workspace host and active generation. |
| Stale target / TOCTOU | Use short-lived opaque tokens and repeat runtime, container, mount, directory, and generation validation at session creation. |
| Token leakage or replay | Bind the token to the current admin session and exact launch context, make it short-lived and preferably single-use, and keep it out of request logs, referrers, and persistent browser storage. |
| Container-name substitution | Bind the session to immutable container ID plus Ploinky ownership metadata and generation. |
| Arbitrary container exec | Never accept container name/ID, runtime socket, image, executable, argv, environment, or translated path from the browser. |
| Symlink or mount escape | Apply realpath containment at the Box workspace and normalized containment at the target destination; reject ambiguous overlapping mount resolution. |
| Route widening | Keep the existing closed WebTTY namespace and do not expose Podman sockets or generic exec endpoints to the browser. |
| Credential disclosure | Do not include environment values, command output, or secrets in discovery responses or logs. |
| Orphan shell | Track and terminate the exact inner exec session and verify cleanup. |
| Audit overcollection | Record creation/close time, result, hashed session ID, target kind, canonical agent instance identity, generation, access mode, and cleanup reason only. |

## 13. Explorer implementation

| Area | Change |
|---|---|
| Menu action | Replace direct terminal launch with opening the target chooser for the selected directory. |
| Modal | Show Box first, then eligible agent instances in stable order; include loading, empty-agent, stale, and error states. |
| Popup behavior | Call `window.open` from the target-row click itself so browsers recognize it as a direct user gesture. Do not depend on an async continuation of the original menu click. |
| Data authority | Consume Ploinky’s target-discovery response; do not reconstruct mount logic or agent eligibility in Explorer. |
| Accessibility | Keyboard navigation, focus trapping/restoration, semantic labels, and an explicit cancel action are required. |
| Error handling | A stale selection should return to the chooser with a useful message and refreshed targets, never silently fall back to the Box or another agent. |
| Presentation | The WebTTY page should identify “Ploinky Box” or the chosen agent instance and show the effective working directory. |

An alternative is to navigate immediately to a WebTTY-owned target-selection page. That would centralize the UI at the trust boundary and simplify stale-state handling, but it does not exactly match the requested Explorer popup experience. A reviewer should recommend it only if it provides a material security or browser-reliability advantage that cannot be achieved with the Explorer modal.

## 14. Branch and repository sequencing

| Sequence | Required action |
|---|---|
| 1 | Finish, verify, review, and merge the current WebTTY-core implementation into Ploinky’s default branch. |
| 2 | Update the local default branch without discarding unrelated work. Confirm the exact base commit. |
| 3 | Create a new Ploinky branch, suggested name `feature/webtty-terminal-targets`, from that verified default-branch tip. |
| 4 | If `AssistOSExplorer` is a separate Git repository, create a corresponding new feature branch from its verified default branch before editing it. |
| 5 | Keep unrelated dirty-worktree changes intact. Never reset, overwrite, or fold them into this feature. |
| 6 | Implement and test the cross-repository changes together, while keeping commits scoped by repository and concern. |

The current `feature/webtty-core` branch is a proposal baseline, not the branch on which this follow-on feature should be implemented.

## 15. Suggested implementation sequence

| Phase | Work | Exit criterion |
|---|---|---|
| 0. Runtime spike | Compare Podman exec API and controlled `podman exec` approaches under the actual nested rootless Box runtime. Exercise PTY attach, resize, exit, disconnect, foreground-child cleanup, and container restart. | A short evidence document and executable test prove one mechanism meets the lifecycle invariants. |
| 1. Target resolver | Add canonical target discovery, exact runtime inspection, mount matching/precedence, path translation, access-mode derivation, token issuance, and revalidation. | Unit tests cover every agent mode, overlapping mounts, read-only mounts, stale identities, ambiguity, and path escapes. |
| 2. Provider abstraction | Extract the current Box worker behind a common terminal-session interface without changing behavior. | Existing WebTTY unit and E2E tests remain green. |
| 3. Agent provider | Implement the selected exact exec-session mechanism and integrate it with session manager cleanup and generation invalidation. | Provider integration tests prove I/O, resize, exit, disconnect, timeout, foreground-child cleanup, and no orphan process. |
| 4. API | Add admin-only target discovery and the hard-cut target-aware session contract. | Handler tests prove authorization, token binding, revalidation, and invalid/stale target rejection. |
| 5. Explorer chooser | Add the modal, loading/error/access states, direct-user-gesture tab launch, and target presentation. | DOM/unit tests cover selection and accessibility; existing context-menu cache behavior remains correct. |
| 6. Integrated verification | Build the real Box image and deploy a fresh Explorer workspace with representative global, isolated/development, read-only, starting, and replaced-agent cases. | The full acceptance matrix passes, including browser E2E and cleanup audits. |
| 7. Documentation and removal check | Update security/routing/operator docs and confirm the legacy `basic/webtty` agent is absent and not referenced. | Documentation matches shipped behavior and repository search finds no unintended legacy dependency. |

## 16. Required test matrix

| Layer | Required cases |
|---|---|
| Resolver unit | Root and nested workspace paths; global/static mapping; isolated mapping; development mapping; manifest volume mapping; most-specific overlapping mount; read-only overlay; named/unmappable volume; missing directory; symlink escape; ambiguous mapping; stale generation; wrong ownership; stopped/replaced container. |
| Handler unit | Admin success; ordinary-user denial; missing/expired/replayed token; token bound to another directory/admin/host/generation; client-supplied container/path/argv rejected; response redaction. |
| Box provider | Existing create, input/output, resize, close, timeout, reconnect policy, and workspace containment remain unchanged. |
| Agent provider | Shell identity; exact container identity; translated cwd; target environment; Bash-to-`sh` policy; resize; normal exit; abrupt WebSocket close; foreground command; agent restart; workspace destroy; cleanup verification. |
| Explorer unit | Admin-only menu; modal open/cancel; Box first; stable agent ordering; access badges; loading/error/stale refresh; keyboard behavior; target click opens correct URL; no raw runtime data stored. |
| Security integration | Direct endpoint requests as non-admin; forged container/target; cross-workspace token; stale alias reused by replacement; symlink change between discovery and create; unexpected mount change. |
| Fresh browser E2E | Select Box and prove cwd/write visibility; select a global agent and prove exact target container/cwd/write visibility; verify isolated/development eligibility only for mounted folders; verify read-only write failure; invalidate a target by agent restart; close with foreground process and prove no orphan exec/session; verify WebTTY remains usable afterward. |

The E2E run must use a fresh deployed `ploinky-box` image containing the production `node-pty` dependency and production WebTTY assets. Repository-local dependency success is not sufficient. Shared Podman VM and fresh-workspace ownership must be coordinated before starting, and all workspace-owned containers, networks, volumes, listeners, and temporary directories must be audited and cleaned afterward.

## 17. Non-goals

| Non-goal | Reason |
|---|---|
| Starting or installing an agent from the chooser | Terminal selection should not mutate topology or hide agent startup latency. |
| Arbitrary host filesystem access | The boundary remains the exact Ploinky workspace mounted at `/workspace`. |
| Non-admin terminal access | This proposal does not introduce a lower-privilege shell model. |
| Generic browser-accessible container exec | Only a fixed shell in an eligible Ploinky-owned target is in scope. |
| Terminal command/output recording | This would materially expand sensitive-data handling and is unnecessary for lifecycle auditing. |
| Compatibility with the legacy WebTTY agent or old session body | The product direction explicitly permits direct removal and a clean API cut. |
| A separate WebTTY/helper image | WebTTY core and `node-pty` remain in `ploinky-box`. |

## 18. Questions the design review must answer

| Question | Why it matters |
|---|---|
| Which nested Podman exec mechanism provides a stable exec-session identity, resize, termination, and post-close verification in the shipped Box environment? | This is the principal correctness and orphan-process risk. |
| Are current runtime records and container inspection sufficient to reconstruct effective Box-source-to-agent-destination mounts without race or ambiguity? | Target eligibility and cwd translation depend on this being authoritative. |
| What exact ownership and generation fields should bind a target token and live session? | Mutable aliases and names are insufficient. |
| Should target tokens be stateless signed capabilities or short-lived server-side records? | The choice affects revocation, replay handling, memory, and multi-process behavior. |
| Can an effective read-only state always be derived from mount inspection, including nested mounts and engine-specific staging? | The UI must not mislabel access. |
| Does the Explorer modal introduce popup-blocking, stale-data, or coupling problems serious enough to justify a WebTTY-owned chooser page instead? | The requested UX should be preserved unless a better design is demonstrably safer or more reliable. |
| What happens when an agent image lacks both expected shells? | Failure must be explicit and target-specific. |
| Which current WebTTY lifecycle, lease, and audit fields can be reused, and which must become target-aware? | The feature should extend—not bypass—the existing security model. |

## 19. Completion definition

The feature is complete only when an administrator can select a folder in Explorer, choose either the Box or a provably eligible active agent, receive a shell in the exact equivalent directory and runtime, and close that terminal without leaving an inner shell or child process behind. Non-admin, forged, stale, cross-workspace, ambiguous-mount, and path-escape attempts must fail closed. The implementation must live on new feature branches, preserve `node-pty` in `ploinky-box`, avoid a helper image, and pass the full fresh-deployment E2E matrix.
