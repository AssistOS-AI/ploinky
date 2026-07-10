# Simplified Runtime Supervisor and CLI Design

Date: 2026-07-10
Status: approved in conversation; awaiting written-spec review

## Summary

Ploinky will expose one public command surface and treat its outer container as an automatically managed runtime. The public `ploinky box ...` namespace and the standalone `container/ploinky-box` compatibility launcher will be deleted, together with their parser, usage text, dispatch table, and command-only handlers.

The host entrypoint will retain a small private supervisor because every normal Ploinky command still needs engine detection, instance resolution, runtime creation, version reconciliation, command forwarding, graceful stop, read-only status, and explicit destruction. These are implementation primitives, not user-callable box commands.

Parameterless `ploinky cli` will open Bash in the outer runtime, where Podman is installed. `ploinky cli <agent> [args...]` will keep opening the selected agent's manifest CLI. Bare `ploinky` and `p-cli` will keep opening the Ploinky REPL inside the outer runtime.

## Motivation

The existing interface exposes two overlapping control planes. Ordinary `ploinky` commands already create and start the outer runtime automatically, while `ploinky box ...` separately exposes lifecycle commands for the same container. The duplication makes it unclear whether a user is operating the outer runtime or an agent container.

The ambiguity is most visible in `ploinky cli explorer`: the host wrapper enters the outer runtime, but core Ploinky immediately attaches to the Explorer agent container. The resulting prompt looks like the box prompt even though Podman exists only one level above. A parameterless outer-runtime shell and explicit attachment banners make that boundary visible.

## Goals and Non-Goals

| Area | Decision |
| --- | --- |
| Public lifecycle namespace | Delete `ploinky box ...` completely |
| Legacy executable | Delete `container/ploinky-box` and its independent command interface |
| Automatic startup | Missing or stopped runtimes are created or started for ordinary commands |
| Automatic upgrade | A required runtime-image generation change recreates the outer container while preserving volumes |
| Ploinky REPL | Preserve bare `ploinky` and `p-cli` |
| Outer shell | Parameterless `cli` opens `/bin/bash` as `podman` in `/workspace` |
| Agent CLI | `cli <agent> [args...]` remains unchanged |
| State inspection | Top-level `status` is combined and read-only |
| Shutdown | Top-level `stop` stops core services and then the outer runtime |
| Destruction | Top-level `destroy` remains the only explicit volume-deleting operation |
| Agent privilege | Do not install Podman in ordinary agent images or grant agents control of sibling containers |
| Internal names | Existing `ploinky-box-*` container and volume names remain valid to avoid orphaning state |

## Architecture

### Component Boundaries

| Component | Responsibility |
| --- | --- |
| `bin/ploinky` | Detect whether execution is on the host or inside the managed runtime and delegate accordingly |
| `bin/p-cli` | Continue acting as an alias to `bin/ploinky` |
| `container/runtime-supervisor.mjs` | Public-only host supervisor for engine selection, instance identity, runtime reconciliation, command routing, status, stop, and destroy |
| `cli/index.js` | Core Ploinky one-shot command dispatcher and interactive REPL inside the runtime |
| Core `cli` command | Open the outer Bash shell when no agent is supplied; otherwise execute the selected agent manifest CLI |
| `container-image-builds/images/ploinky-box` | Supply the versioned outer runtime with Bash, Node, Git, and nested rootless Podman |
| `container-image-builds/images/ploinky-node` | Remain a non-privileged application image without Podman or Docker |

The current dual-purpose `container/ploinky-box.mjs` will be renamed and reduced to the public-only runtime supervisor. It will no longer support a non-public mode or accept an outer lifecycle subcommand registry.

`bin/ploinky` will continue using the runtime marker to prevent recursion. On the host it executes the supervisor. Inside the outer runtime it executes core `cli/index.js` directly.

### Host Routing

| Invocation | Host behavior |
| --- | --- |
| `ploinky` or `p-cli` | Reconcile/start the runtime and attach the Ploinky REPL |
| `ploinky cli` | Reconcile/start the runtime and forward parameterless `cli` with an interactive TTY |
| `ploinky cli <agent> ...` | Reconcile/start the runtime and forward the agent CLI request unchanged |
| `ploinky start ...` | Preserve graph-driven publish planning, reconcile/start the runtime, forward core `start`, and retain router-readiness reporting |
| `ploinky <ordinary command>` | Reconcile/start the runtime and forward the command unchanged |
| `ploinky status` | Inspect without creating, starting, pulling, or recreating anything |
| `ploinky stop` | Skip reconciliation, gracefully stop core services if running, then stop the outer runtime |
| `ploinky destroy` | Skip reconciliation, confirm the target, then remove the outer runtime and its persistent volumes |
| `ploinky help`, `ploinky --help`, or `ploinky -h` | Render public/core help without starting the runtime |

## CLI and REPL Behavior

### Parameterless `cli`

Core Ploinky will give `cli` an intentional arity-based meaning:

| Syntax | Meaning |
| --- | --- |
| `cli` | Open the outer runtime's `/bin/bash` |
| `cli <agent> [args...]` | Run the agent manifest's `cli` command interactively |

The shell runs as the outer container's default `podman` user, starts in `/workspace`, inherits the runtime environment, and receives the terminal directly. The runtime image self-check guarantees that `/bin/bash` and Podman exist.

When launched from host `ploinky cli`, exiting Bash returns to the host shell. When launched by typing `cli` in `p-cli`, the REPL suspends input, Bash owns the TTY, and exiting Bash restores the REPL prompt and input state.

Parameterless `cli` outside a managed runtime fails with a clear managed-runtime-required error. It never opens an arbitrary host shell. A parameterless invocation without an interactive terminal also fails immediately instead of attempting a broken TTY attachment. Existing non-TTY agent CLI paths remain supported when an agent argument is present.

### REPL Scope

The Ploinky REPL remains useful as a persistent interface with history, completion, current-directory context, and repeated core commands without the `ploinky` prefix.

Commands typed inside the REPL operate at the core workspace layer. In particular, REPL `status`, `stop`, and `destroy` retain their existing workspace/router/agent meanings because a process inside the outer runtime cannot safely control its own host container. Help text will distinguish these from system-wide host invocations. A user exits the REPL before running host-level `ploinky stop` or `ploinky destroy`.

### Layer Identification

Before opening the outer shell, Ploinky prints the target runtime, user, working directory, and return behavior:

```text
[ploinky] Entering outer runtime 'ploinky-box-testExplorerFresh'
[ploinky] user=podman cwd=/workspace; exit returns to the previous prompt
```

Before attaching to an agent CLI, Ploinky prints the agent, nested container name, and image:

```text
[ploinky] Attaching to agent 'explorer'
[ploinky] container=ploinky_AchillesIDE_explorer_workspace_c52ddf65
[ploinky] image=docker.io/assistos/ploinky-node:24-bookworm-tools
```

These messages identify the execution layer even when nested containers inherit a misleading hostname.

## Runtime Image Contract

The runtime image is a coordinated contract between `container-image-builds` and Ploinky. The first generation defined by this design is published as the immutable multi-architecture tag `docker.io/assistos/ploinky-box:podman-node24-runtime-v1` and carries this exact label:

```text
io.assistos.ploinky.runtime-contract=1
```

The supervisor requires that tag and contract value `1`. Future incompatible generations increment both the versioned tag and contract value. A Ploinky code update changes the required reference only after the matching image has been published and validated. The supervisor does not poll a mutable registry tag on every command.

An explicit custom image must expose the required contract label. Validation happens before the existing runtime is altered. An incompatible custom image fails with the expected and observed contract values.

## Automatic Reconciliation

For an ordinary command, the supervisor resolves the current instance and compares it with the required runtime image, contract, and effective creation configuration.

1. If no runtime exists, the supervisor obtains the required image, creates the named volumes and container, validates health, and forwards the command.
2. If the runtime exists but is stopped and compatible, the supervisor starts it, validates health, and forwards the command.
3. If the runtime is running and compatible, the supervisor forwards the command without registry traffic or recreation.
4. If the runtime is incompatible, the supervisor first pulls and validates the replacement image, captures the existing runtime's image and creation settings, gracefully stops core services, recreates only the outer container, reattaches the existing volumes, and validates health before forwarding the command.
5. If replacement creation or validation fails, the supervisor reconstructs and restarts the previous container from the captured image and configuration, leaves all volumes untouched, reports the failed phase, and returns nonzero.

The preserved creation settings include published ports, listening scope, bind mounts, source mount, runtime image selection, security options, devices, and named-volume attachments. Explicit global flags on the current command modify the desired configuration. Omitted flags preserve the inspected settings of an existing container, so a later Ploinky upgrade does not silently discard prior publishes or mounts.

Automatic reconciliation never removes the workspace, dependency, or nested-container-storage volumes.

## State-Aware Commands

| Command | Missing runtime | Stopped runtime | Running incompatible runtime |
| --- | --- | --- | --- |
| Ordinary command, `ploinky`, or `ploinky cli` | Create and start | Start | Reconcile, then execute |
| `ploinky status` | Report missing | Report stopped | Report outdated without changing it |
| `ploinky stop` | Report already stopped and succeed | Report already stopped and succeed | Stop without upgrading |
| `ploinky destroy` | Report nothing to remove and succeed | Confirm and delete | Confirm and delete without upgrading |

`ploinky status` combines outer state, image-contract compatibility, configured publishes, and router/agent state when the runtime is already running. It never invokes image pull, container create, container start, or reconciliation. It exits successfully only when the runtime is running, compatible, and the available core status check succeeds; missing, stopped, outdated, or unhealthy states return nonzero.

`ploinky stop` first invokes core shutdown for the router and configured agent runtimes, then stops the outer container while preserving all volumes. If graceful core shutdown fails, the supervisor still stops the outer container, reports both phases, and returns nonzero. Missing and already stopped runtimes are idempotent successes.

`ploinky destroy` names the exact inferred or selected instance and all volumes in its interactive confirmation. Refusal or absent confirmation aborts without mutation. Confirmation removes the outer container plus its workspace, nested-container-storage, and dependency volumes. No automatic path may invoke destruction.

Creation-only flags such as publishes, port, mount, image, and listening scope are rejected for `status`, `stop`, and `destroy`. Instance selectors such as `--name` and `--engine` remain accepted.

## Removed Surface and Code

| Removed item | Replacement |
| --- | --- |
| `ploinky box up` | Automatic ensure/start before ordinary commands |
| `ploinky box cli` | Bare `ploinky`/`p-cli` for the REPL; `ploinky cli` for outer Bash |
| `ploinky box status` | Combined top-level `ploinky status` |
| `ploinky box stop` | System-wide top-level `ploinky stop` |
| `ploinky box update` | Automatic image-contract reconciliation |
| `ploinky box destroy` | Top-level `ploinky destroy` |
| `ploinky box logs` | Existing core `ploinky logs` behavior; ordinary invocation may start only the outer runtime to read persistent workspace logs |
| `ploinky box cp` | Direct host engine tooling when exceptional host-to-volume copying is required |
| `ploinky-box run` | Normal `ploinky <command>` forwarding |

The implementation removal includes `BOX_COMMANDS`, removed-flag tables specific to box commands, nested box parsing, `runBoxCommand`, dual usage text, the non-public main path, the old `cli`, `run`, `cp`, aggregate-log, explicit-up, and explicit-update handlers, and tests or smoke steps whose only purpose is exercising that interface.

Shared behavior still needed by normal public commands is retained under capability-oriented private names. This includes engine queries, volume naming, instance inference, creation argument construction, source and dependency preparation, health checks, graph-driven start publishing, readiness probing, graceful core shutdown, and destructive volume removal.

The token `box` receives no compatibility alias or deprecation dispatcher. Current authoritative help and documentation omit it. Historical design and plan documents remain as records of the earlier architecture.

## Container Image Changes

`container-image-builds` will make its runtime-only Ploinky box definition the authoritative image contract. Ploinky source and its dependency volume are mounted at runtime instead of being relied upon as baked application content.

The image entrypoint will hard-fail unless Bash, Node, Git, Podman, required devices, and `podman info` succeed. The publish workflow will make nested-Podman smoke verification mandatory rather than `continue-on-error` and will publish the immutable versioned tag before Ploinky adopts it.

The Explorer-selected `ploinky-node` image remains intentionally free of Podman and Docker. Agent containers remain non-privileged unless a separate manifest contract explicitly requires otherwise; this design does not grant agents control over sibling containers.

## Error Handling

| Failure | Required behavior |
| --- | --- |
| No Podman or Docker on the host | Fail before mutation with the supported-engine requirement |
| Required image cannot be obtained | Keep the existing runtime untouched and return nonzero |
| Replacement or custom image fails contract validation | Reject before stopping or removing the current runtime |
| Graceful shutdown fails during reconciliation | Abort replacement and leave or restore the current runtime |
| Replacement create or health check fails | Restore the previous container configuration and image; preserve volumes |
| Bash or Podman missing from a supposedly compatible image | Treat the image self-check as failed and do not forward the command |
| Parameterless `cli` lacks a TTY | Fail immediately with an interactive-terminal message |
| Direct-core parameterless `cli` is outside the runtime | Fail with a managed-runtime-required message |

## Verification Contract

| Boundary | Required coverage |
| --- | --- |
| Public routing | Every command in the routing table reaches the intended host or core path; `ploinky box` and the standalone compatibility launcher are absent |
| Core CLI | `cli` opens outer Bash; `cli <agent>` preserves agent lookup, auto-enable, readiness, and attachment |
| REPL terminal ownership | Parameterless `cli` suspends input, Bash receives the TTY, and the prompt/history recover after exit |
| Status | Missing, stopped, running, outdated, and unhealthy cases are read-only and report the correct combined state |
| Stop | Core shutdown precedes outer stop; outer stop still occurs after a core failure; repeated stop is idempotent |
| Destroy | Exact target confirmation is required and only the selected container and volumes are removed |
| Reconciliation | Matching generation is a no-op; mismatches pull before stop, preserve configuration and volumes, and roll back on creation or health failure |
| Configuration | Omitted flags preserve inspected settings; explicit flags intentionally change the desired configuration |
| Engine parity | Fake-engine tests assert equivalent Podman and Docker command construction |
| Image contract | Image labels and self-checks match the supervisor's required contract |
| Nested runtime | Real smoke runs require `podman version`, `podman info`, and execution of a nested test container inside the outer image |
| Agent boundary | Explorer attachment identifies its node image and confirms that agent containers do not gain outer-runtime Podman access |

The existing graph-driven publish planner, branch forwarding, dependency preparation, router readiness, profile handling, and agent lifecycle tests remain regression requirements.

## Rollout

The runtime-only image change is built, tested, and published first under its immutable versioned reference. Ploinky then adopts that exact reference and contract value. Publishing a mutable compatibility tag may continue for external consumers, but the supervisor does not use it.

Existing containers created from the old mutable image lack the new contract metadata and therefore appear as outdated in `ploinky status`. The first subsequent ordinary command performs the non-destructive outer-container reconciliation and preserves existing named volumes and creation settings.

No removed public command is retained for migration. Existing internal `ploinky-box-*` names are deliberately reused so the supervisor finds and upgrades current instances rather than orphaning them.

## Alternatives Considered

| Approach | Decision |
| --- | --- |
| Slim public-only supervisor | Selected because it removes the duplicate interface while preserving tested engine and lifecycle boundaries |
| Hide the old box namespace but keep its implementation | Rejected because it leaves dead compatibility code and contradicts complete removal |
| Move all engine logic into `bin/ploinky` | Rejected because it mixes Bash and JavaScript responsibilities and weakens testability and Podman/Docker parity |
