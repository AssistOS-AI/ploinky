# Preserve the host workspace path inside Ploinky Box

## Objective and intended behavior

Replace the fixed outer `/workspace` mount with the exact absolute workspace path selected on the physical host. For a selected workspace `W=/home/skutner/work/project`, create a writable `W:W` bind, set the Box runtime `PLOINKY_WORKSPACE_ROOT=W`, and execute workspace commands with working directory `W`. A global agent must see project files at that same path. A development agent must retain the selected repository's path beneath `W`. Preserve isolated agent homes at `/root` and the static-agent `/home/agent` exception.

This is a filesystem namespace change, not a global text substitution. `/workspace-files` is an HTTP route and remains unchanged. `/opt/ploinky`, `/opt/ploinky-agentlib`, `/Agent`, `/code`, `/shared`, private control directories, dependency-cache destinations, and the image-cache destination retain their existing purposes. A host workspace literally named `/workspace` remains valid when otherwise admissible; there is no special compatibility alias for other roots.

**User scope correction: migrations and backward compatibility are not required. Implement a clean break for newly created Boxes and newly generated runtime state. Do not build legacy-layout support, state conversion, old-image fallback, compatibility aliases, or an upgrade procedure. This correction supersedes the original handoff's migration requirements.**

Do not add a second broad workspace mount or a `/workspace` symlink to hide missed callers. Do not mount the host root, user home, parent directories, container sockets, or external Git directories to make absolute paths work. Absolute references work only when their targets are inside an existing authorized grant.

## Starting point and concurrent work

| Item | Pinned value or restriction |
| --- | --- |
| Ploinky baseline | `1ce77eb3ea7674d68950985ea0e2df015d6957e4` |
| Implementation branch | `feat/host-workspace-path` |
| Implementation worktree | `/home/skutner/work/file-parser/ploinky-host-workspace-path` |
| Shared checkout | `/home/skutner/work/file-parser/ploinky`; do not edit, switch, stash, stage, reset, clean, or commit here |
| Existing parallel branch | `feat/image-digest-refresh` in `/home/skutner/work/file-parser/ploinky-image-digest-refresh`; do not modify or merge it |
| Other shared work | Authentication implementation is active in the wider workspace; treat all sibling source and deployment fixtures as owned by other sessions |
| Existing local fixture | `/home/skutner/work/testExplorerFresh`; never start, stop, destroy, reset, or reuse its deployment |

Read `/home/skutner/work/file-parser/CLAUDE.md`, this worktree's `CLAUDE.md`, and any closer instructions. Executable code and tests define current behavior; historical design specifications must not be used as authority or edited for this behavior change. Use the available `node-coding-style` guidance: new helpers should be dependency-free Node.js `.mjs` modules, with explicit imports and Node's built-in test runner; preserve existing file conventions when changing existing modules.

Do not pull or silently follow the moving shared branch. Record the baseline, final changed-file list, and integration concerns. The image-refresh effort overlaps `ploinky-box/supervisor.mjs`, image admission, lifecycle transactions, and `cli/sandbox/docker/agentServiceManager.js`. Keep path-policy changes modular, avoid formatting churn in these files, and prepare an integration note that explains how dynamic workspace arguments compose with captured immutable image IDs. Do not make image refresh decisions in the workspace-path helper.

The delivery branch is `feat/host-workspace-path`; commit and push only the reviewed changes on that branch. Do not merge, publish images, run tracked deployment workflows, mutate Cloudflare, or deploy Explorer. Do not run the cross-repository Explorer E2E gate unless separately requested. Do not modify tracked attribution or create commits with tool/agent signatures.

## Verified current behavior

| Concern | Relevant executable sources |
| --- | --- |
| Host workspace selection and path-derived Box identity | `ploinky-box/identity.mjs`, `cli/utils/config.js`, `cli/utils/workspace.js` |
| Outer workspace bind and environment | `ploinky-box/lifecycle/container.mjs`, `ploinky-box/constants.mjs` |
| Strict mount, workdir, environment and image admission | `ploinky-box/contract/container.mjs`, `ploinky-box/contract/image.mjs` |
| Image entrypoint and runtime preparation | `ploinky-box/entrypoint/ploinky-box-entrypoint`, `entrypoint.mjs`, `initialize-workspace.mjs`, `initialize-edge-routing.mjs` |
| Selected Achilles source and writable aliases | `ploinky-box/contract/agentlib.mjs`, `agentlib/contract.mjs`, `cli/sandbox/agentLibGrant.js` |
| Host-to-Box command execution | `ploinky-box/command/execute.mjs`, `supervisor.mjs`, `lifecycle/container.mjs`, `edgeDesired.mjs` |
| Launch scope and update scope translation | `ploinky-box/skillScope.mjs`, `graphSkillScope.mjs`, `command/hostUpdate.mjs` |
| Diagnostics and repair | `ploinky-box/diagnose.mjs`, `diagnose/current.mjs`, `diagnose/inside.mjs`, `repair.mjs`, `repair/` |
| Agent project paths and grants | `cli/commands/workspaceUtil.js`, `cli/sandbox/docker/agentServiceManager.js`, `common.js`, `agentHomeLayout.js`, `interactive.js`, bwrap and seatbelt managers |
| Repository link targets | `cli/utils/linkInstall.mjs` |
| Terminal cwd and scrubbed environments | `core-services/webtty/cwd.mjs`, `environment.mjs`, worker callers, `cli/server/webtty/terminalTargetResolver.mjs`, `cli/sandbox/runtimeShell.js`, `layerIdentification.js` |
| Browser path display and file references | `cli/server/authHandlers/marketplaceRoutes.js`, `cli/server/webchat/workspaceFileLinks.js`, file-link callers and tests |
| Manifest mount admission | `cli/sandbox/runtimeCapabilities.js`, `cli/utils/runtime/manifestVolumePolicy.js`, `agentDataPathPolicy.js`, `legacyAgentDataGuards.js` |

Today the entire selected host workspace is writable through the outer bind. The Ploinky source is independently read-only at `/opt/ploinky`. Dependencies and images use two additional workspace-backed writable binds. A local/managed Achilles source has both a stable read-only bind and a read-only overlay at its workspace alias; image-bundled Achilles has no source bind. Preserve these grants and their exact validation.

The image contract currently requires both baked working directory and baked workspace environment to equal `/workspace`. Container admission reuses that static contract. These must be separated: an immutable image cannot contain a per-user workspace path, but each created container must contain exactly the selected one.

The current resolver uses `path.resolve` for selected identity and fingerprints the selected root; it does not unconditionally replace identity with `realpath`. Keep workspace selection and identity scope separate from mount destination changes. Canonical paths used to check containment must not collapse distinct selected workspace identities.

## Design decisions

### One authoritative runtime root

Introduce a small shared path-contract helper at an appropriate existing dependency-free boundary. Its inputs are the trusted host-selected workspace identity or a validated runtime root; its outputs include the workspace mount destination, runtime environment entry, command working directory, and workspace-relative path resolution. It must have no filesystem initialization, network, CLI configuration, or lifecycle side effects when imported.

Host code passes the identity explicitly. In-Box code obtains the root from the host-owned reserved environment and validates it before use. Do not infer it from an arbitrary command cwd, browser input, agent manifest, user profile, or serialized agent-controlled field. Avoid silently falling back to `/workspace` when a required runtime root is absent. Keep non-Box and test callers explicit where they legitimately have their own root.

Preserve containment checks when resolving a launch directory or child path even when host-to-Box translation becomes an identity operation. Retain `PLOINKY_HOST_LAUNCH_CWD` as provenance. Workspace selection, skill scope, command cwd, agent `WORKSPACE_PATH`, and agent `HOME` remain distinct concepts.

### Safe destinations and path representation

Validate a clean absolute path and its relationship to runtime-owned mounts before any container mutation. Reject roots that would replace `/`, the runtime source/library, private control paths, or required runtime storage, and roots that overlap those protected locations in a way that masks or exposes them. Do not blanket-reject normal fixture directories such as `/tmp/<unique-project>`; `/tmp` is also an explicit tmpfs, so prove that a workspace below it survives mount ordering correctly.

Preserve spaces, Unicode, and shell metacharacters with argument arrays and existing safe shell quoting. Audit the colon-separated `--volume` renderer and inspection parser: either render engine-supported escaping/mount syntax for colon/comma-containing paths or reject unsupported names with an explicit preflight diagnostic. Never misparse a host pathname into mount options. Do not use shell interpolation or global string replacement to inject `W` into `node -e`, shell commands, or generated scripts; prefer argv/environment/serialized structured inputs.

For a symlink-selected workspace, distinguish the selected destination/identity from the canonical source used to verify a bind. Prove existing resolver semantics and source ownership without opportunistically adopting another workspace. Revalidate root fingerprints immediately before mutation as today.

### Image and container contract separation

Use a neutral static image working directory such as `/`, and remove the baked `PLOINKY_WORKSPACE_ROOT=/workspace` default. The host must supply both `--workdir W` and `--env PLOINKY_WORKSPACE_ROOT=W` at creation. Keep the image's user, HOME, entrypoint, allowed binaries, immutable identity, empty labels/volumes requirements, init, devices, confinement, and publication rules unchanged.

Validate static image metadata separately from the exact dynamic container environment and working directory. Container admission requires exactly one writable workspace bind with source/destination appropriate to `W`; reject missing, extra, wrong-root, wrong-mode, and stale `/workspace` grants. Keep all other expected mounts exact. Do not accept an arbitrary environment allowlist to accommodate the new variable.

The entrypoint shell currently runs preparation before its later fixed-value checks. Move dynamic-root preflight early enough to reject invalid/missing roots before preparation writes anything. Pass the validated root through entrypoint helpers and preserve test-root injection without accidentally duplicating an absolute path under a synthetic test root. Probe-only image execution must still work offline without a mounted workspace.

### Companion image artifact

The actual image definition is in a separate repository. A read-only local source is available at `/home/skutner/work/testExplorerFresh/container-image-builds`, pinned during planning at `9a642203b9b5878d830c68a64bb8320ea627fb42`. It contains `images/ploinky-box/Dockerfile`, `tests/image-definitions.test.mjs`, and `tests/box-transport-entrypoint.test.mjs`. The Dockerfile copies `ploinky-box/entrypoint/ploinky-box-entrypoint` from its pinned Ploinky build input into `/usr/local/bin/ploinky-box-entrypoint`; changing mounted Ploinky source does not replace that installed shell script in an existing image.

Prepare an applyable companion patch against that pinned image revision under this worktree's `proposals/`, rather than editing the fixture checkout. If validation needs an image-source checkout, use a separate disposable checkout of the pinned revision, never the deployment fixture and never shared writable dependencies. Update neutral image defaults, remove unnecessary `/workspace` creation/ownership setup, and update image-definition tests and relevant reproduction workflow assumptions. There is no `images/ploinky-box/entrypoint.sh` at this revision; do not create a second competing entrypoint.

Document the exact Ploinky and image-source revisions required to build a compatible image. A rebuilt image must contain the changed canonical entrypoint. Do not claim old published images support the new layout, relax immutable-image checks, retag shared images, or publish `latest`. Deliver the companion patch and explicit build/validation instructions even if registry access or native runtime testing is unavailable.

### Fresh runtime state only

Old Boxes, old image contracts, and generated state containing the former `/workspace` prefix do not need to work with the new implementation. Normal exact contract validation may reject them. Do not add a legacy layout classifier, legacy execution cwd, special teardown path, automatic replacement of old deployments, or state migration machinery. Recreating incompatible runtime resources is an operator action outside this implementation session.

Update producers of path-bearing state so a fresh workspace creates correct `.ploinky/agents.json` project/work paths, generated code and skill symlinks, launch/skill-scope records, managed dependency links, and topology/runtime records. Verify newly generated state works end to end. Do not scan and rewrite existing user files or generated state to preserve compatibility.

The lack of compatibility requirements does not authorize deleting existing workspaces, source files, secrets, `.data`, caches, or another session's deployment. Keep the existing ownership, lock, confinement, and normal current-layout rollback protections. Do not change public Box naming to an incremented version.

## Implementation sequence

### Phase 1: contract and focused tests

Add the root helper and tests for normal paths, two independent workspaces, subdirectories, spaces, Unicode, prefix-confusion (`project` versus `project-other`), symlink roots, unsupported mount characters, reserved collisions, and `/tmp/<fixture>`. Preserve the existing identity resolver test expectations. Establish current relevant tests before making changes; the initial analysis already passed 47 tests in `ploinkyBoxIdentity`, `ploinkyBoxWorkspaceData`, `ploinkySkillScope`, and `ploinkyBoxImageContract`.

### Phase 2: outer lifecycle and image bootstrap

Update create arguments, exact mount/workdir/environment validation, Achilles alias projection, entrypoint preflight/preparation, initialization, and image-contract probes. Prepare the image companion patch alongside this phase. Inject `W` into every host-owned execution path, including start/restart/stop, shell/CLI forwarding, bootstrap/install-dependencies, routing setup, status inbox, diagnostics, repair, smoke helpers, rollback, and no-wait paths. Preserve image-refresh policy and operation-lock boundaries.

### Phase 3: scopes, nested agents, and generated links

Replace `/workspace` translation in `skillScope`, `graphSkillScope`, and host update scope with validated same-path behavior. Build link-install targets from the actual workspace root, not a fixed prefix. Verify global/development source-equals-destination mounts, isolated and static home layouts, Podman staged symlink targets, interactive exec cwd selection, bwrap grants, and direct non-Box callers.

Do not widen manifest volume permissions: sources inside a Box remain relative to the selected workspace and subject to current storage/symlink policy. Preserve read-only Achilles aliases, read-only code/dependency grants, private homes, legacy-data guards, topology/control mounts, and the intentional writable project access of global/development agents. Mount name changes must not turn read-only aliases into writable bypasses.

Update all generated-state producers to write the actual root from the start; do not convert old records or links. Prove that an ordinary in-workspace absolute symlink works across host/Box/global-agent boundaries and that an external symlink does not gain access.

### Phase 4: terminal and browser consumers

Pass the validated root explicitly into WebTTY directory resolution and both worker and shell environment construction. Preserve exact environment key/value checks and secret scrubbing; copying the full Router environment is forbidden. Ensure terminal target display and actual worker cwd agree. Keep relative browser cwd inputs traversal-safe.

Remove fixed `/workspace` generation from marketplace repository display and runtime banners. File-link handling should accept workspace-relative references and, when needed, an absolute path strictly beneath the trusted runtime root. Do not accept arbitrary host absolute paths. Prefer existing relative file APIs; expose only the minimal root context needed by authorized clients, and preserve authenticated `/workspace-files` routing and download confinement. Update the consumers and their tests together.

### Phase 5: fresh-state fixtures and documentation

Update all unit/integration/native fixtures to create new state using selected roots rather than hardcoded `/workspace`. Preserve intentional examples where `/workspace` itself is the selected host directory and negative tests for invalid mounts; do not retain old-layout support fixtures. Update current user-facing README/container guidance and CLI messages; leave historical `docs/specs/` and generated specification HTML alone under the repository contract. State the requirement for a rebuilt image and fresh runtime state without developing an upgrade procedure.

Produce a residual-occurrence inventory. Each remaining `/workspace` match must be an unchanged HTTP namespace, negative contract test, literal host-path test, or explained historical document. Active runtime code must not use it as a hidden default or compatibility mount.

## Verification matrix

| Scenario | Required evidence |
| --- | --- |
| Outer Box at ordinary `W` | Observed bind source/destination, Config.WorkingDir, environment and shell `pwd` equal `W`; host/Box writes agree |
| Two workspace roots | Distinct existing path-derived identities, no cross-workspace adoption or mutation |
| Global/development agents | Absolute project paths match host/Box; correct `WORKSPACE_PATH`; private HOME remains separate |
| Isolated and static agents | Existing `/root` project/home and static `/home/agent` behavior remains correct; no extra broad project grant |
| Library/cache overlays | Writes through all protected aliases fail; allowed project files remain writable; local and image Achilles modes pass |
| Path edge cases | Spaces, Unicode and shell metacharacters work without execution; unsupported mount syntax fails before mutation; parent/prefix traversal and protected collisions rejected |
| Symlinks and Git | In-tree absolute symlinks resolve at identical paths; external targets stay unavailable; ordinary repositories work; external Git-worktree metadata is diagnosed without adding host grants |
| Image contract | Static image validation stays exact; dynamic container root accepted only for matching identity; stale image rejected before destructive replacement |
| Fresh generated state | Registry paths, symlinks, scopes and runtime records use the actual root from first creation; incompatible old contracts are rejected without conversion |
| Commands and scopes | Start/restart/stop/CLI/shell/update, skill scope and graph replay, routing initialization, inbox, diagnose and repair use the exact root |
| WebTTY | Shell cwd/root match; env scrubbing remains exact; rejected paths cannot escape; no secrets inherited |
| Browser links | Relative and allowed absolute references resolve; external absolute paths rejected; `/workspace-files` API unchanged |
| Local runtime limits | Missing rebuilt image or Podman is reported as an explicit unverified gate, not a pass |

Use Node syntax checks for changed modules and focused existing tests, including relevant `ploinkyBox*`, `ploinkySkillScope`, `ploinkyGraphSkillScope`, AgentLib, `linkInstall`, runtimeCapabilities, agentHomeLayout, containerRuntime, Podman staging, WebTTY, and workspaceFileLinks suites. Inspect the repository's test scripts before running a broad command; do not accidentally launch shared deployment/E2E fixtures. Run broader non-deploying unit coverage after the focused suites pass.

Add meaningful behavior tests for wrong-root admission, an unexpected `/workspace` mount, actual root propagation, freshly generated paths, absolute in-tree links, terminal environment scrubbing, and mount protections. Do not add backward-compatibility or migration suites. Do not merely replace expected literals or weaken existing security assertions.

When a compatible locally built immutable image and runtime are available, use a unique disposable workspace and unique image tag to run a narrow native host-path integration test, with task-owned resource IDs recorded before cleanup. Never use `~/work/testExplorerFresh`, shared tags, global prune, existing workspace Boxes, or a currently running deployment. If the necessary image build is outside available scope, deliver the runnable fixture and record that the native gate remains pending.

## Review and delivery

Deliver the implementation diff in the isolated branch/worktree, the companion image patch, test results, remaining native/image gates, fresh-start requirements, and a short integration note for the concurrent image-refresh/authentication work. No migration procedure or compatibility implementation is required. Keep the plan updated with justified implementation deviations and their evidence. Do not report completion based only on passing mock tests if an image/entrypoint dependency remains unaddressed.

Before handoff, verify only intended files changed, no shared checkout was modified by this work, no existing deployment was operated, no extra host grants were introduced, no secrets entered artifacts, and no runtime `/workspace` default remains. Preserve the worktree for review and subsequent integration; do not merge or remove it automatically.

## Implementation deviations and refinements

These refinements were made during implementation. Each is backed by executable code and tests in this worktree.

| Area | Deviation or refinement | Reason and evidence |
| --- | --- | --- |
| Root helper location | The helper is `ploinky-box/contract/workspace-root.mjs`. It exports admission (`boxWorkspaceRootProblem`, `assertBoxWorkspaceRoot`), the in-Box reader `readBoxWorkspaceRoot`, and the mount, environment, exec-option and workspace-relative path builders. | The contract directory already holds the image, container and AgentLib contracts. `tests/unit/ploinkyBoxWorkspaceRoot.test.mjs` proves import has no side effects. |
| Unsupported mount syntax | Roots containing `:` or a literal backslash are rejected. Control characters, non-well-formed Unicode, paths over 4095 bytes, unclean spellings and trailing whitespace are also rejected. Commas stay allowed. | Volume syntax splits on `:`; existing terminal and runtime path readers interpret backslash as a separator. Reject these spellings before mutation rather than mount one path and later operate on another. |
| Reserved paths | Besides Box mounts, image system trees, nested engine stores and private sockets, the policy reserves nested agent runtime destinations: `/Agent`, `/code`, `/shared`, `/models`, `/runtime`, `/root`, `/home/agent`, `/run/ploinky-health-probes` and `/run/ploinky-edge-topology`. `/tmp` and `/var/tmp` are reserved only as parents: a root may lie below them but may not equal or contain them. | Global and development agents receive the workspace at the same path, so a root at those destinations would mask agent grants. A drift test compares the list with `EDGE_TOPOLOGY_CONTAINER_DIR`, `PROBE_CONTROL_CONTAINER_ROOT` and `AGENTLIB_STABLE_MOUNT_PATH`. |
| Entrypoint preflight | Before any preparation write, the shell entrypoint requires the reserved root to be set and absolute, `pwd -P` to equal it, and the directory to be writable. The Node preparation helper also requires `cwd === root` and `realpath(root) === root`. | Inside the Box, the selected spelling is a real mountpoint, so a root that does not resolve to itself (for example, through an image symlink component) is rejected rather than prepared under another path. Image probes use explicit `--entrypoint` overrides, so offline probe execution does not need a workspace. |
| AgentLib alias | The read-only alias shadow is projected at `W/<sourceRelativePath>` and rendered after the writable workspace bind. | Same-path layout. Admission compares exact mounts, including the alias destination (`ploinkyBoxTransactions` covers wrong alias destinations). |
| Mutation preflight | `beforeAnchor` validates the root before inspecting ownership, so start, stop, destroy and the other locked mutations reject an unmountable path before any engine call. | Every mutation needs the root for exec working directories and create arguments. A consequence: an old Box at a path that is now inadmissible (for example, one containing `:`) must be removed with engine commands. |
| Host exec paths | `buildContainerExecArgs`, supervisor bootstrap, dependency, core-command, inbox, edge, smoke and diagnostic helpers all receive `workspaceRoot` explicitly. The native test helper `execInBox` relies on the admitted Box working directory instead of passing a fixed `--workdir`. | This avoids hidden defaults. Native tests assert `Config.WorkingDir`, a single root environment entry, `pwd -P` and `printenv` inside the Box. |
| Edge initializer | `initializeBoxEdgeRouting` became async and imports `cli/sandbox/edgeGeneration.js` lazily, after reading the root. | `cli/utils/config.js` fills in `PLOINKY_WORKSPACE_ROOT` from the cwd when imported, which would hide a missing root (`ploinkyBoxEdgeInitialization` tests). |
| In-Box readers | Inbox status, inside diagnostics, workspace initialization, runtime shell banner and cwd, managed Box master key, and listener inventory tooling read the root from the reserved environment or require an explicit root. None falls back to `/workspace`. | This follows the plan's no-hidden-default rule. |
| Link-install targets | `/Agent/linked/<repo>` targets are the repository's actual same-path source. The CLI help text was updated to match. | Generated links resolve identically on the host, in the Box and in agents (`linkInstall`, `podmanStaging`). |
| WebTTY | The terminal target display is the absolute directory path. The session manager validates its root when constructed. The worker checks shell environments against its own trusted root, not the root carried in the message. | The display and actual cwd agree. A worker with a missing root fails immediately instead of hanging at startup (`webttySessionManager`, `webttyEnvironment`). |
| WebChat | Workspace paths rendered into the page are HTML-attribute escaped, and a `data-workspace-root` attribute supplies the trusted root to file-link handling. Absolute references are linked only when strictly beneath that root and present in the file index. They are marked root-relative so that no base prefix is added. | Arbitrary admitted roots can contain quotes and markup characters (`webchatWorkdirAttribute`, a mutation-checked test, and `webchatWorkspaceFileLinks`). `/workspace-files` routes are unchanged. |
| Marketplace display | Local repositories are labelled `./<basename>` instead of an absolute path. | Unprivileged views must not disclose host absolute paths. The authorization harness flags absolute local paths. |
| Diagnose | A `workspace.path` check fails with same-path guidance. A new `workspace.git` warning (`ploinky-box/diagnose/gitMetadata.mjs`) reports repositories at the workspace root, its immediate children and `.ploinky/repos/*` whose Git metadata (a linked worktree `gitdir`, a separated Git directory, or `commondir`) the Box cannot read at the selected path. Both checks have explicit manual remediation actions. | This implements the plan's requirement to diagnose external Git metadata without adding host grants. The scan is bounded and read-only. Explicit actions prevent words inside user paths ("registry", "overlay") from being classified as registry or storage failures (`ploinkyBoxDiagnoseGitMetadata`). |
| Nested agents | Project, home and grant construction were already parameterized by the Box-side project path. Review also restored a missing `isPathWithin` import in bwrap, which otherwise prevented those arguments from being constructed. | Unit tests prove same-path project binds, separate private homes, read-only code/dependency grants, and intentional writable global/development project source. A native fixture also proves literal host paths, write-through, symlink boundaries, and both local AgentLib read-only aliases. |
| Symlinks | The native lifecycle test now asserts that a host-written absolute in-workspace symlink resolves in the Box and in a global agent, and that an absolute symlink to a file outside the workspace does not. | This is the plan's absolute-link row. It runs only with a rebuilt candidate image. |
| Documentation | README and container README describe the same-path contract, the admission rules, and the rejection of `/workspace`-layout Boxes and images. A stale container README sentence about a `--mount DIR` grant at `/workspace/mounted` was removed; no such option exists in code. | This is the clean break requested by the user. Historical `docs/specs` and generated HTML were not edited. |
| Companion image patch | Besides the Dockerfile, image-definition test and README changes, the patch updates `scripts/install-roboteam-local.mjs`. It checks containment on canonical paths and builds the in-Box script path from the Box's reported workspace root in its selected spelling. | The installer previously hardcoded `/workspace/<relative>`, and a symlink-selected workspace would otherwise be rejected (`roboteam-agent-supply-chain` source assertions). |
| Migration scope | No legacy classification, conversion, alias, fallback or special teardown was implemented. Exact admission rejects old Boxes and images. For a `/workspace`-layout Box, `ploinky stop` still stops the outer Box but reports that the in-Box stop could not run. `ploinky destroy` then removes it. | User scope correction. The existing stop/destroy transactions already continue to the outer stop when the inner stop fails. |
