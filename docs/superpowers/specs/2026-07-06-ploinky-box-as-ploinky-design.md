# Ploinky Box as the Default Ploinky Entrypoint

## Goal

Make the boxed runtime the normal `ploinky` user experience. Users should be
able to keep typing existing commands such as `ploinky start explorer`,
`ploinky status`, `ploinky stop`, `ploinky destroy`, `ploinky logs`, and
`ploinky install ...` without learning a separate `ploinky-box` syntax. Those
commands execute inside the boxed runtime by default.

The current `ploinky-box` command remains available as a compatibility and
diagnostic entrypoint, but the product direction is that `ploinky` means
"Ploinky running through the box" unless an explicit direct/development escape is
used.

## Current State

`bin/ploinky` currently runs the host Node CLI directly:

1. Resolve `PLOINKY_ROOT`.
2. Check that `node_modules/achillesAgentLib` exists.
3. Route `sh`, `--shell`, and `-shell` to `bin/ploinky-shell`.
4. Run `node cli/index.js "$@"`.

`container/ploinky-box` is a thin shell shim that runs
`container/ploinky-box.mjs`. The Node wrapper manages the outer box container,
the `/workspace` and nested-container-storage named volumes, command execution
inside the box, and convenience commands like `start`, `status`, `destroy`, and
`update`.

The two command surfaces currently overlap. For example, `status`, `stop`,
`destroy`, `logs`, `update`, `cli`, and `start` exist both as normal Ploinky
commands and as box-management commands.

## User-Facing Command Contract

Bare `ploinky ...` commands preserve normal Ploinky syntax and semantics. The
only behavior change is where they run: inside the boxed workspace.

Examples:

```bash
ploinky start explorer
ploinky start explorer 8080
ploinky status
ploinky stop
ploinky destroy
ploinky logs
ploinky install ...
ploinky list agents
ploinky
```

All of the above should target the in-box Ploinky CLI. `ploinky` with no
arguments opens the in-box interactive CLI, preserving the existing p-cli style
experience.

Outer box lifecycle operations move to an explicit namespace:

```bash
ploinky box up
ploinky box status
ploinky box logs
ploinky box stop
ploinky box update
ploinky box destroy
ploinky box cp ...
```

This avoids changing existing Ploinky command meanings. In particular,
`ploinky destroy` is the normal in-box Ploinky destroy operation, while
`ploinky box destroy` removes the outer container and its named volumes.

The legacy `ploinky-box` executable keeps its existing command surface during
the transition. It may share the same underlying implementation, but it should
continue to print `ploinky-box` oriented help and errors when invoked directly.

## Instance Identity

When no `--name` is provided, the box instance name is inferred from the current
directory basename, using the same sanitization rules already implemented by the
wrapper. This keeps commands run from different project directories isolated by
default.

Examples:

```bash
cd ~/work/testExplorerFresh
ploinky start explorer

cd ~/work/testExplorer2
ploinky start explorer
```

Those commands target different outer boxes because their current directory
basenames differ.

Users can still pass `--name X` to target another instance explicitly. In public
`ploinky` mode, wrapper flags are parsed only before the first non-flag command
token, or after the explicit `box` namespace for box lifecycle operations. Once
normal Ploinky command parsing begins, flags belong to the in-box Ploinky
command and must be forwarded unchanged. This preserves commands such as
`ploinky client tool process --dry-run`.

The public entrypoint accepts the same box flags that are needed before the
in-box command is executed, such as `--name`, `--port`, `--image`, `--publish`,
`--webmeet-ports`, `--mount`, `--listen-lan`, `--engine`, and `--dry-run`.

## Runtime Architecture

`bin/ploinky` becomes a box-aware dispatcher:

1. If running inside a box, execute the direct Node CLI path.
2. If direct/development mode is explicitly requested, execute the direct Node
   CLI path.
3. Otherwise, dispatch through the box wrapper behavior.

The in-box guard is mandatory because the Docker image is built from this repo.
If `bin/ploinky` always launched the box wrapper, then `podman exec ... ploinky`
inside the box would recursively try to create another box. The existing
`PLOINKY_BOX=1` environment marker is the natural guard: when it is present,
`bin/ploinky` behaves like the old direct CLI.

Direct/development mode must be explicit and boring. `PLOINKY_DIRECT=1` is the
required escape hatch: when it is present on the host, `bin/ploinky` runs the
direct Node CLI path instead of managing a box. A small `bin/ploinky-direct`
helper may be added as a convenience, but the environment variable is the
contract. This is not the default user path; it exists for CLI development,
emergency debugging, and tests that need the direct Node CLI.

## Command Routing

The wrapper needs two modes:

1. `ploinky-box` compatibility mode, where top-level commands like `status`,
   `destroy`, `update`, and `run` keep their existing box-management meanings.
2. `ploinky` public mode, where top-level commands are normal Ploinky commands
   unless they begin with `box`.

In public `ploinky` mode:

- `ploinky box <box-command> ...` maps to existing outer box lifecycle logic.
- `ploinky start <agent> [hostPort]` ensures the box exists and then runs
  `ploinky start <agent> 8080` inside `/workspace`.
- `ploinky start` with no static agent remains valid existing syntax and is
  forwarded as `ploinky start` inside `/workspace`.
- `ploinky <anything-else>` ensures the box exists and then runs the same
  command inside `/workspace`.
- `ploinky` with no arguments ensures the box exists and runs the in-box
  interactive CLI.

For `start`, the optional user-provided port remains the host-facing router port.
Inside the box, the router is always started on port `8080`, matching the
existing box contract. Start flags such as `--branch`, `--repo-branch`,
`--branch-fallback`, and `--reset-repos` may appear before or after the port and
must be forwarded to the in-box command unchanged.

## Shell and Aliases

`p-cli` currently delegates to `bin/ploinky`; it should continue to work and use
the boxed runtime by default.

`psh` currently delegates to `ploinky sh`; it should continue to work. The
public host entrypoint should forward `ploinky sh` into the box like any other
normal Ploinky command. Inside the box, `PLOINKY_BOX=1` makes `bin/ploinky`
execute the direct path, where the existing `sh`, `--shell`, and `-shell`
shortcut routes to `bin/ploinky-shell`. This preserves shell behavior without
starting host-mode agents.

Interactive commands that naturally need a terminal, including `ploinky`,
`ploinky cli`, `ploinky shell`, and `ploinky sh`, should use interactive engine
exec (`-it`) when forwarding into the box.

## State and Storage Semantics

The outer box keeps using named volumes for:

- `/workspace`: boxed Ploinky workspace state.
- `/home/podman/.local/share/containers`: nested Podman image/container state.

Removing the outer container keeps named volumes. `ploinky box destroy` removes
the outer container and explicitly removes those named volumes. Bare
`ploinky destroy` does not remove the outer box volumes; it runs the normal
in-box Ploinky command.

Bind mounts remain opt-in through `--mount`. They are not the default storage
model because the box's default isolation and portability depend on managed
volumes.

## Error Handling

The public entrypoint should keep errors clear about which layer failed:

- Missing Node on the host: explain that Node >= 20 is required for the wrapper.
- Missing Podman/Docker: explain that the boxed runtime needs a container
  engine.
- Podman machine stopped on macOS: tell the user to start it; do not start or
  stop it automatically.
- Box exists but publishes a different host port: explain that port mappings
  are fixed at container creation and require `ploinky box update` or recreate.
- In-box command failure: return the in-box command's exit code.

Help text should match the invoked program. `ploinky --help` should describe the
boxed-by-default public command behavior and the `ploinky box ...` namespace.
`ploinky-box --help` may keep the compatibility-oriented wrapper help.

## Testing

Implementation must include engine-free tests for command translation and guard
behavior:

- `bin/ploinky` runs direct CLI when `PLOINKY_BOX=1`.
- Direct/development escape runs direct CLI without creating a box.
- Host `ploinky start explorer 9090 --dry-run` translates to outer box startup
  on host port `9090` and in-box `ploinky start explorer 8080`.
- Host `ploinky --dry-run start explorer 9090 --branch feature-x` translates to
  outer box startup on host port `9090` and in-box
  `ploinky start explorer 8080 --branch feature-x`.
- Host `ploinky start` is forwarded as an in-box `ploinky start` command instead
  of failing in the wrapper.
- Host `ploinky client tool process --dry-run` preserves `--dry-run` as an
  in-box command argument instead of consuming it as a wrapper flag.
- Host `ploinky --dry-run status` is routed as an in-box `ploinky status` in
  wrapper dry-run mode, not as outer box status.
- Host `ploinky status --dry-run` preserves `--dry-run` as an in-box command
  argument instead of consuming it as a wrapper flag.
- `ploinky box status --dry-run` targets outer box status.
- `ploinky box --help`, `ploinky box help`, and unknown `ploinky-box` commands
  show mode-appropriate help/guidance.
- `ploinky` with no arguments maps to in-box interactive CLI.
- `p-cli` and `psh` keep working through the new entrypoint.
- `ploinky-box` compatibility commands remain available.

Implementation must also keep the existing wrapper test suite passing. A smoke
test should demonstrate that a normal command such as `ploinky start webtty` or
an equivalent dry-run/smoke path uses the boxed runtime rather than starting
host-level agent containers.

## Non-Goals

This change does not remove the `ploinky-box` compatibility executable.

This change does not make host bind mounts the default storage model.

This change does not merge the outer box lifecycle into the application CLI
itself. The box lifecycle remains wrapper behavior, exposed under
`ploinky box ...`.

This change does not require changing Explorer or agent manifests.

## Acceptance Criteria

1. `bin/ploinky` is the boxed-by-default public entrypoint on the host.
2. Existing `ploinky ...` command syntax is preserved and executed inside the
   box by default.
3. Outer box lifecycle is available through `ploinky box ...`.
4. The in-box recursion guard preserves direct CLI behavior when
   `PLOINKY_BOX=1`.
5. A direct/development escape exists and is documented.
6. `ploinky-box` compatibility behavior remains available.
7. Unit/wrapper tests prove the command routing, collision handling, and direct
   guard behavior.
8. Smoke or equivalent verification proves that the normal `ploinky` command
   path uses the boxed runtime.
