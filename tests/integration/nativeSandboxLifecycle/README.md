# Native sandbox lifecycle runner

An opt-in, dependency-free runner that drives one `lite-sandbox` agent through `bin/ploinky-local` with the real host runtime: Seatbelt (`/usr/bin/sandbox-exec`) on macOS or bubblewrap (`/usr/bin/bwrap`) on Linux. It never uses a fake engine, never falls back to a container runtime and is not part of `npm test`.

## Run

```sh
node tests/integration/nativeSandboxLifecycle/run.mjs \
  --runtime seatbelt|bwrap \
  --source <ploinky checkout> \
  --artifacts <dir> \
  [--agentlib <AchillesAgentLib checkout>] \
  [--mcp-sdk <mcp-sdk snapshot>] \
  [--tmp-root <dir>] \
  [--scenario lifecycle|failed-first-start] \
  [--engine absent|present] \
  [--teardown-deadline-ms <n>]
```

| Option | Meaning |
| --- | --- |
| `--runtime` | `seatbelt` needs macOS, `bwrap` needs Linux. A mismatch is an unavailable prerequisite, not a skip. |
| `--source` | The Ploinky checkout under test. Its `bin/ploinky-local` is the only entry point used. |
| `--artifacts` | Output directory: `result.json`, `steps/*.log`, `workspace-logs/`. It must be new or empty; a non-empty directory is a usage error (exit 64). |
| `--agentlib` | AgentLib checkout. Defaults to `PLOINKY_TEST_AGENTLIB_DIR`. |
| `--mcp-sdk` | Snapshot to link as `<source>/node_modules/mcp-sdk` when that directory is missing. Defaults to `PLOINKY_TEST_MCP_SDK_DIR`. The runner removes only the link it created, and a `node_modules` directory only if it created that too and it is empty. A pre-existing directory is never touched. |
| `--scenario` | `lifecycle` (default) is the scenario below. `failed-first-start` is the opt-in recovery scenario described under "Scenario: failed-first-start". |
| `--engine` | `absent` (default): the children's PATH has no container engine. `present`: the directory of the real `podman` (found on the runner's PATH) is added to the children's PATH, and `CONTAINERS_STORAGE_CONF` and `XDG_RUNTIME_DIR` are passed through when set. An `engine-probe` step records `podman --version` and a read-only `podman info`; with the isolated `HOME` the engine is normally installed but unusable. |
| `--teardown-deadline-ms` | Overall teardown deadline, default 240000, minimum 1000. |
| `--tmp-root` | Parent of the workspace. Default `/tmp` on macOS, `os.tmpdir()` on Linux. It must exist, be writable and stay short (Unix sockets are limited to 104 bytes). A bad root is an unavailable prerequisite, decided before anything is created. |

Run one instance at a time. The managed Router binds `0.0.0.0:8080` and `127.0.0.1:8081` unconditionally (`cli/server/RoutingServer.js`: `const port = 8080; const privatePort = 8081;`), so the runner cannot choose ephemeral Router ports and reports a busy port as an unavailable prerequisite. The fixture service and the control process use ephemeral loopback ports.

## Exit codes and result semantics

| Exit | `result` in `result.json` | Meaning |
| --- | --- | --- |
| 0 | `pass` | Every step passed, the final scenario step was reached, no network clone was attempted and cleanup was verified. `summary.scenarioComplete` means exactly that (the final step was reached and no step failed); `summary.cliStopSucceeded` only says that a `stop` or `destroy` exited 0. |
| 1 | `fail` | A step assertion, the scenario, or the cleanup verification failed. `firstFailure` names the step and its failed assertions. A restage failure caused by the native predecessor regression carries `class.class = native-predecessor-regression` and the code `PLOINKY_RUNTIME_PREDECESSOR_INVALID`. |
| 2 | `unavailable-prerequisite` | A prerequisite is missing. Stdout carries `{"result":"unavailable-prerequisite","missing":[...]}`. No workspace, process or link was created. Only the artifacts directory exists. |
| 129, 130, 143 | `fail` with `interrupted` | The run received SIGHUP (129), SIGINT (130) or SIGTERM (143). The in-flight command is terminated, the scenario stops at the next boundary, the single teardown runs to completion and the process exits once afterwards. Further signals during cleanup are ignored. |
| 64 | none | Usage error, including a non-empty `--artifacts`. |

`result.json` records, per step: the exact child argv, cwd, environment variable names and PATH, exit code, readiness output lines, the registry record (`runtime`, `instanceId`, `enableGeneration`, `pid`), the raw PID-record contents, the independently observed process (pid, start identity, parent, group, argv, `/proc` exe on Linux), its descendants, the fixture's own report, port and listener observations, and every assertion with its detail. The top level adds the prerequisite probes, the children's PATH mode, the cleanup inventory (every recorded process, every signal sent, ports, removed paths, residue scan) and the `noNetwork` check.

## Prerequisites (checked before anything is created)

| Check | Detail |
| --- | --- |
| Runtime binary | Seatbelt: `/usr/bin/sandbox-exec` runs `(version 1)(allow default)`. Bwrap: `/usr/bin/bwrap --version` and a trivial `--unshare-all` sandbox succeed. |
| Tools | `node`, `git`, and `ps` (macOS) or `/proc` (Linux). |
| Source | `bin/ploinky-local`, `cli/index.js`, `agentlib/bootstrap.mjs`. |
| AgentLib | `package.json` named `ploinky-agent-lib` plus the entry points the runner needs. |
| mcp-sdk | `<source>/node_modules/mcp-sdk`, or a usable snapshot to link. |
| Router ports | 8080 and 8081 are free on `127.0.0.1` and `0.0.0.0`. |
| Engine | With `--engine present`, a `podman` executable on the runner's PATH. |

## What the runner creates

One `mkdtemp` directory (canonical real path under the short temp root, marked with an ownership sentinel). It is removed only when the sentinel is present. It holds:

| Resource | Purpose |
| --- | --- |
| `home/.gitconfig` | Test identity and `url.<nonexistent path>.insteadOf` tripwires for `https://github.com/` and `git@github.com:`. A self-test step proves the tripwire is armed. |
| `bin/` | Children's PATH. Normally a `node` symlink followed by `/usr/bin:/bin:/usr/sbin:/sbin`, never `/opt/homebrew/bin`. If a system directory ships `podman` or `docker` (common on Linux), `bin/` instead mirrors the system directories minus the engines and is the whole PATH. The runner asserts no engine is visible on that PATH. |
| `ws/achillesAgentLib` | A real-directory copy of the selected AgentLib without `.git`. A symlink is rejected by `validateAgentLibSource` ("must be a real directory, not a symlink"), and the selection must lie inside the workspace. |
| `ws/.ploinky/repos/{AchillesIDE,AchillesCLI,copilot-agents}` | Minimal local git repositories so `start` never clones. Their HEADs must be unchanged at the end. |
| `fixture-repo` | Local git repository with one `lite-sandbox` agent (`nativefix/lifecycle`: a dependency-free Node HTTP service, `network.mode` host, TCP readiness). Installed by `ploinky-local install repo <path> nativefix`, which is a local clone. |
| `bystander/` | An unrelated `node server.js` process. Lifecycle commands must never signal it, and it is the unconfined control for the in-sandbox read probe. |

Children get a clean environment: only `HOME`, `PATH`, `TMPDIR`, `LC_ALL`, `LANG`, `GIT_TERMINAL_PROMPT`. No `PLOINKY_*` variable is inherited, so `PLOINKY_DISABLE_HOST_SANDBOX` is unset and the host bootstrap reads only `<workspace>/achillesAgentLib`.

## Scenario

| Step | Command | Observed independently |
| --- | --- | --- |
| 01 tripwire-selftest | `git ls-remote https://github.com/...` | Fails against the tripwire path. |
| 02 init-edge-sources | `fixture/initEdgeSources.mjs` | The checkout's `initializeFreshEdgeRoutingSources`. `enable sandbox` writes `agents.json` first, and a later `start` refuses a workspace with only some edge sources, so the runner initializes all four before enabling. |
| 03 enable-sandbox | `enable sandbox` | Workspace config `disableHostRuntimes: false`. |
| 04 install-fixture-repo | `install repo <fixture-repo> nativefix` | Installed HEAD equals the fixture commit. |
| 05 admit-manifest | `fixture/admitManifest.mjs` | `admitDirectAgentRuntimeManifest` selects the native runtime. |
| 06 start-initial | `start lifecycle 8080` | Registry runtime is `seatbelt`/`bwrap`. The PID record equals the registry tuple. The OS process exists with a start identity equal to the record's. Fresh tuple. Argv. HTTP readiness. The fixture reports its own tuple, marker and `PATH`. Reading `<workspace>/.ploinky/data` is denied inside the sandbox (`EPERM` on Seatbelt, `ENOENT` or `EACCES` on bwrap) while the unconfined bystander reads the same path. Seatbelt: `sandbox-exec` resolved against the `PATH` the agent runs with is `/usr/bin/sandbox-exec`. Listener belongs to the agent tree. |
| 07 stop-after-start | `stop` | Every captured process is gone, no PID record, ports free, Router gone, bystander untouched. |
| 08 start-restage-after-stop | `start lifecycle` | The P1 regression: must succeed with a fresh tuple and a new process. |
| 09 env-change-start | manifest env `one` to `two`, `start lifecycle` | Only the captured predecessor tree exits, the successor has a fresh tuple, the Router and bystander keep their pids and start identities. |
| 10 env-change-restart | manifest env `two` to `three`, `restart lifecycle` | Same assertions through the restart path. |
| 11 stop-final | `stop` | Every recorded process (except the bystander, which teardown ends) is gone. |

If a step fails the remaining steps are not run and teardown starts.

## Scenario: failed-first-start

Opt-in recovery scenario for a partly failed first native `start`. The fixture repository gets a second `lite-sandbox` agent, `gate`, which lists the lifecycle agent in its `enable` array and is the static agent. `ploinky-local start` starts the manifest graph wave by wave, dependencies first, and awaits each blocking wave's launch and readiness: lifecycle is wave 1 and the gate is wave 2. The gate's server exits at once when `LIFECYCLE_FAIL=1`, the runtime reports `process exited immediately`, the wave throws, and `start` fails after the lifecycle agent's native process was launched and is alive.

| Step | Command | Observed |
| --- | --- | --- |
| `start-fails-after-dependency-launch` | `start gate 8080` | Nonzero exit naming the gate. The surviving lifecycle process (pid, start identity, argv), its registry record (including whether the `runtime` field is present), its PID record and any predecessor receipts under `.ploinky/run/runtime-predecessors/`. The gate has no PID record and no process. |
| `heal-gate` | edits the gate manifest `LIFECYCLE_FAIL` 1 to 0 | |
| `start-after-heal` | `start gate` | Exit 0, or a conservative refusal. Never `PLOINKY_SANDBOX_PID_SLOT_BUSY`, which was the wedge symptom and is asserted absent. A nonzero exit is accepted only when the final `❌ Error:` line carries `PLOINKY_RUNTIME_OWNERSHIP_AMBIGUOUS`, names the lifecycle runtime key, and leaves the safe state: the survivor alive with its original start identity, its PID record byte-for-byte intact, and every receipt that covered it still present. The CLI prints only `error.message`, so the code is recognized by its literal text or by the fixed message its constructors produce (`ownership could not be verified (<reason>)` with any reason except `invalid-record`, which is `PLOINKY_SANDBOX_PID_RECORD_INVALID`, an internal-state error; `sandbox runtime '…': …`; `preserved container … because exact immutable ownership/removal was not proven`). Any other nonzero exit, with any text, fails this step. Exactly one live lifecycle process, found by argv in the process table independently of Ploinky's records, reported as `replaced` or `reused-or-retained`. On success both agents are fully observed. |
| `start-further` | `start gate` | Must exit 0 (no permanent `PLOINKY_SANDBOX_PID_SLOT_BUSY`, which is also asserted absent from its output), with the same observations. |
| `stop`, `destroy` | `stop`, then `destroy` | Both through the CLI. Every process the scenario created must be gone after each, so Ploinky's own commands reached it. The two commands are reported separately. |

At every observation after the failed start (including one after `destroy`), no predecessor receipt may be lost while the process it covers is alive (matched by the receipt's native process evidence, or by the live PID-record tuple it names). `failedFirstStart.receiptInvariant` says how many snapshots were taken and how many receipts were ever seen, and sets `heldVacuously` when there were none, so a reader can tell a held invariant from an untested one. Steps from `start-after-heal` on are soft: a failure is recorded and the scenario carries on, so each later command reports its own outcome and `firstFailure` is the first failing step. `result.json` carries `failedFirstStart` with the survivor, both restart outcomes, `afterStop` and `afterDestroy` survivors, and `reach`, which lists anything the runner's own teardown had to signal because Ploinky's stop and destroy did not reach it.

On Linux the same scenario uses the PID record, `/proc` identities and the bwrap argv (`--bind <agent dir> /code`) to find the live roots. That path has not been run here.

## Cleanup

Every `ploinky-local` step (and every helper script) is spawned detached, as the leader of its own process group, because the `bin/ploinky-local` bash wrapper does not `exec` its node CLI and would otherwise outlive a signal sent only to the wrapper. An interrupt or a step timeout sends SIGTERM to the whole group, waits (bounded) until no process has that process group id, then sends SIGKILL to the group. The step does not return, and teardown's `stop` does not start, before the group is gone, and the group is recorded as owned before it is signalled. `result.json` shows this as `child.termination` on the step (members before the signal, after SIGTERM and at the end). Helper `ps` and `git` calls are detached too, so a terminal Ctrl-C does not kill them mid-cleanup. A failed observation during the freeze below resumes every frozen process and carries on to termination, and teardown as a whole has a deadline (`--teardown-deadline-ms`, default 240 s). When it fires, the runner still runs the cheap ownership-safe closing steps before it resolves: it ends its own bystander (identity-checked), removes the `mcp-sdk` link it created (only while the link still points at its snapshot), and reports ports and residue. The workspace directory and any process it cannot prove it owns are left, and are listed in `cleanup.remaining`, `cleanup.residue` and `cleanup.notes`; `cleanup.ok` is false. Blocking waits in the abandoned phases end early.

Teardown always runs, also on failure, SIGINT or SIGTERM, and there is exactly one teardown: every path awaits it. If the final stop did not complete it first terminates any in-flight command and runs `ploinky-local stop`. It then signals only processes the runner can prove it owns, Watchdog first, re-reading each process's start identity immediately before every signal (SIGTERM, then SIGKILL after a grace period):

| Owned because | Roles |
| --- | --- |
| Spawned by the runner | The CLI children and the bystander. |
| Descendant of a runner-spawned child, found by parent link while it runs | `cli-descendant`. |
| Descendant (parent link or detached process group) of any owned process, recorded with its start identity at every observation point and again during teardown | `owned-descendant`. |
| `running/router.pid` names it and its argv is `<source>/cli/server/Watchdog.js`; or a `RoutingServer.js` child of that watchdog | `watchdog`, `router-child`. |
| Its observed start identity equals a PID record's `processIdentity`; or a descendant of such a root | `agent-root`, `agent-descendant`. |

The Router's container monitor restarts a stopped native agent on a timer, so a failed run can create an agent process after the last observation. Before any signal, teardown therefore freezes every live owned process (SIGSTOP, so it cannot spawn), records its newly found descendants, and repeats until a pass finds nothing new. Ownership is thus recorded before any parent link is broken. It then kills the frozen supervisors (Watchdog, Router child) and sends the rest SIGTERM then SIGCONT, with SIGKILL after the grace period. An owned process that was reparented to init is still signalled, because it was recorded earlier.

A registry pid alone, a stale `router.pid` and a process that merely names the workspace path prove nothing and are never recorded or signalled. A process that still names the workspace path after teardown is reported in `cleanup.residue`, classified `foreign` (never linked to an owned process, never signalled) or `owned-survivor` (recorded and signalled yet still alive), and fails the run. Teardown then removes the workspace (only with its ownership sentinel) and, in a separate `finally`, the `mcp-sdk` link it created, and only while that link still points at the snapshot it was created for. It finally verifies that all recorded processes are gone and that 8080, 8081, the fixture port and the control port are free. Each phase fails on its own and never skips a later one.

## Limits

| Limit | Detail |
| --- | --- |
| Seatbelt argv | `sandbox-exec` replaces itself with the entry command, so the kernel keeps only `sh -c <entry>`, and the runner cannot observe the `sandbox-exec -f <profile>` argv after launch. The `sh -c ... server.js` check is an entry-shape check and proves nothing about the sandbox. The real binary is shown by resolving `sandbox-exec` against the `PATH` the agent itself reports (the one Ploinky spawns with), and confinement by the in-sandbox probe of one specific path against an unconfined control that reads the same path. On Linux, `/proc/<pid>/exe` and the `bwrap` argv are asserted directly. |
| Start identity | macOS identity is `ps -o lstart` with one-second granularity (Ploinky records the same form). The runner does not prove resistance to a hypothetical sub-second PID reuse. |
| Router ports | Fixed at 8080 and 8081 by the Router code. Concurrent runs, or any other Ploinky Router on the host, make the runner report an unavailable prerequisite. |
| Backend transitions | Native to container and container to native need a container engine and are outside this runner. |
