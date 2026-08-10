# Agent Log Streaming Implementation Plan

Date: 2026-08-09

Audience: A Codex or Claude Code session implementing the change in the `ploinky` repository

Status: Revised after adversarial review; ready for a second review before implementation

## 1. Start Here

Before editing anything:

1. Read the repository-root `AGENTS.md` and the complete canonical `CLAUDE.md`.
2. Treat current executable code and tests as the source of truth. If this plan has drifted, stop and update the plan before implementing.
3. Preserve all unrelated user changes in the dirty worktree. Do not reset, revert, clean, or overwrite them.
4. Work only in the canonical repository at `/Users/danielsava/work/file-parser/ploinky`.
5. Fetch `origin/master` and require local `master` to be exactly synchronized with it before implementation begins. If the commit IDs differ, do not implement on a stale or diverged branch; preserve the dirty worktree and resolve synchronization safely first.
6. Use only the scoped tests named in this plan. Do not run the full Ploinky suite.
7. Do not deploy Explorer or run cross-repository Playwright gates unless the user explicitly requests that work in the implementation session.
8. Do not update historical specifications or generated HTML. Update executable code, tests, and active Markdown only.

The requested operator interface is:

~~~sh
ploinky logs tail webmeetAgent
ploinky logs last 200 webmeetAgent
~~~

The implementation must remain generic. `webmeetAgent` is only an example; production logic must derive all identities from the enabled-agent registry and current runtime state.

## 2. Review Reconciliation

The supplied review findings were checked against the current implementation. Every finding below is accepted and is incorporated into the design and task sequence.

| Finding | Decision | Plan correction |
|---|---|---|
| `logs` mutates state before dispatch | Accepted | Add lightweight Core dispatch before importing `cli/main.js` and an inspect-only Box route that never prepares or repairs the Box. |
| Persisted OCI ID is not ownership proof | Accepted | Inspect only the recorded immutable ID and verify the exact name, workspace, managed labels, contract, generation tuple, and init configuration. |
| No-wait marker/status can cross runs | Accepted | Make startup logs run-scoped, validate the worker command identity, and revalidate the marker plus registry tuple during every observation step. |
| Existing qualified resolver semantics are unsafe | Accepted | Replace duplicate resolvers with one pure deterministic resolver and use a read-only registry snapshot for logs. |
| Sandbox filename is not process-specific | Accepted | Derive the final filename from the canonical key, generation tuple, and finalized PID. Make a hard cut with no legacy probing or migration. |
| `tail` and `last` precedence conflict | Accepted | Define separate, exhaustive selection rules for each subcommand and for `--startup`. |
| Signal handling conflicts with the REPL and Box wrapper | Accepted | Introduce one foreground-command coordinator and a dedicated async Box execution path for streaming logs. |
| Lexical path checks and line-only bounds are insufficient | Accepted | Open verified descriptors without following symlinks, never reopen by name, follow in constant memory, and enforce a 16 MiB cap for `last`. |
| Tests and active surfaces are incomplete | Accepted | Add lightweight entrypoint, no-wait handoff, Dashboard, sandbox consumer, documentation, and focused-runner coverage. |

No compatibility layer is required. In particular, old shared no-wait logs and old Bubblewrap/Seatbelt filenames are not read, migrated, renamed, or probed.

## 3. Required Outcome

An operator can inspect one exact enabled agent through the existing `ploinky logs` command when the agent is:

1. Waiting or starting in a detached no-wait worker.
2. Running in Docker or Podman.
3. Running in Bubblewrap or Seatbelt.
4. Stopped while its exact post-cut runtime log remains retrievable.
5. Failed during the current no-wait run and has durable startup diagnostics.

For a current no-wait start, `logs tail <agent>` follows that exact worker's startup log. When the same run publishes `running`, the command revalidates the unchanged agent identity and switches once to that exact runtime's application log. A superseding start, changed generation tuple, failed worker, corrupt state, or failed ownership proof terminates the command instead of guessing.

The command is observational:

- It never creates `.ploinky` or any child directory.
- It never bootstraps repositories or checks unrelated Core dependencies.
- It never creates, starts, adopts, repairs, restarts, stops, or removes the outer Box or an agent runtime.
- It never writes or repairs `agents.json`, no-wait state, routing state, or runtime state.
- It does not introduce a public schema, persisted log index, routing document, or log database.

The producers changed by this feature may create their own new run-scoped log files as part of normal startup. The log-reading command itself remains read-only.

## 4. Public CLI Contract

### 4.1 Grammar

| Command | Required behavior |
|---|---|
| `ploinky logs tail` | Follow Router logs, starting with the most recent 10 lines. |
| `ploinky logs tail router` | Same as the Router default. |
| `ploinky logs tail <agent-ref>` | Follow a current exact no-wait worker and hand off once to its exact runtime; otherwise follow an already verified runtime. |
| `ploinky logs tail <agent-ref> --startup` | Follow only the current run-scoped startup log and stop at `running` or `failed`. |
| `ploinky logs last` | Show the last 200 Router lines. |
| `ploinky logs last <N>` | Show the last `N` Router lines. |
| `ploinky logs last <agent-ref>` | Show the last 200 lines for the selected agent source. |
| `ploinky logs last <N> <agent-ref>` | Show the last `N` lines for the selected agent source. |
| `ploinky logs last [N] <agent-ref> --startup` | Read only the current run-scoped startup log. |

Parsing rules:

1. After removing at most the existing single global `--debug` or `-d` flag, `logs` must be the first command token.
2. `tail` accepts zero or one positional target.
3. `last` accepts zero, one, or two positional values. A strict integer in the first position is `N`; otherwise the one positional value is the target and `N` defaults to 200.
4. `--startup` may appear once after the subcommand and is valid only for an agent target.
5. Unknown flags, duplicate flags, extra positionals, and malformed counts fail with usage and exit 1.
6. `N` must match `^[1-9][0-9]*$` and be between 1 and 10,000 inclusive. Do not coerce fractions, signs, whitespace, zero, negative values, partial integers, `NaN`, or excessive values.
7. Informational source and handoff messages go to stderr. Stdout contains only selected log bytes.
8. Application log bytes are passed through unchanged.

### 4.2 Agent references

Literal unqualified `router` is reserved by the log grammar and always selects Router logs. All other targets resolve against one read-only snapshot of `.ploinky/agents.json`.

Resolution precedence is exact and deterministic:

1. Exact registry key whose record has `type: "agent"`.
2. For an unqualified input, exact alias matches collected across all enabled agent records; exactly one is required.
3. For a qualified input, require exactly one accepted separator (`/` or `:`), two non-empty components, and no additional separator. Match `repoName` plus `agentName` only. Do not fall back to aliases.
4. For a remaining unqualified input, match `agentName`; exactly one is required.

Duplicate aliases, duplicate qualified identities, duplicate bare names, malformed qualified forms, and ambiguity fail closed. Diagnostics list sorted usable aliases or canonical registry keys and never select the first map entry.

Completion rules:

- Never suggest an unqualified alias named `router`.
- Prefer a unique non-reserved alias.
- Always allow a qualified `repo/agent` reference.
- Offer a bare agent name only when unique.
- Keep exact registry keys accepted but do not prefer them for display.
- An agent whose manifest name is `router` remains reachable through a qualified reference.

## 5. Corrected Current Implementation Map

| Area | Current behavior that must change |
|---|---|
| `cli/index.js` | Only help, status, and bare `cli` bypass `cli/main.js`. `logs` currently reaches dependency checks, environment initialization, and bootstrap. |
| `cli/main.js` | `runCoreCli()` can create workspace state and bootstrap repositories before command dispatch. Its permanent REPL handlers can exit before a follower cleans up. |
| `cli/utils/workspace.js` | `loadAgents()` creates `.ploinky` before reading. It cannot be used by a read-only log entrypoint. |
| `cli/commands/cli.js` and `cli/commands/logUtils.js` | Logging is Router-only. File follow uses `tail -f` or an uncancellable fallback watcher. |
| `cli/utils/agents.js` | Qualified input can fall back to a global bare alias; duplicate aliases use first-match semantics. |
| `cli/utils/workspaceDependencyGraph.js` | Contains a second pure resolver with the same unsafe semantics. |
| `ploinky-box/command/route.mjs` | Classifies `logs` as generic. |
| `ploinky-box/bin/ploinky-box.mjs` | Generic commands call `prepareBoxForCommand()`, which can reconcile a Box and install dependencies. |
| `ploinky-box/command/execute.mjs` | Uses synchronous inherited-stdio execution and does not own an asynchronously cancellable streaming child. |
| `cli/commands/workspaceUtil.js` | Every no-wait run appends to `.ploinky/logs/no-wait/<container>.log` and silently falls back to ignored stdio if opening fails. |
| `cli/commands/noWaitWorker.js` | Already publishes strong run-scoped status metadata and commits the final registry record before `running`. Those invariants must be reused. |
| `cli/sandbox/docker/containerFleet.js` | Has the strongest existing exact OCI ownership predicate, but it is private to destructive fleet lifecycle code. |
| Bubblewrap/Seatbelt service managers | Append to manifest-name-only legacy files, so aliases and generations can collide. |
| `cli/sandbox/bwrap/bwrapFleet.js` | Has tuple-bound PID records and process-identity checks suitable for live sandbox proof. |
| Dashboard | Uses partial integer parsing without the CLI upper bound; the number input has no min/max constraints. |
| Focused shell runners | The normal runner registers Router tail and last; the failing-fast runner omits even the existing last-N check. |

Important protocol facts:

1. A no-wait agent has two streams: worker orchestration output and runtime application output.
2. The no-wait worker commits the exact runtime record before it publishes `running`. There is no valid post-`running` registry visibility retry.
3. During staging, a fresh `instanceId` and `enableGeneration` can temporarily coexist with predecessor runtime fields. No record is final merely because it contains a runtime, container ID, or PID.
4. OCI logs are authoritative in Docker or Podman; no workspace application-log file exists.
5. A live sandbox can be proved through its tuple-bound PID record and process identity. A stopped post-cut sandbox is addressed by the finalized tuple and PID retained in `agents.json`.
6. Pre-cut stopped sandbox records have only ambiguous legacy files and require an operator restart before logs are available through this feature.

## 6. Design

### 6.1 Read-only Core entrypoint

Add a lightweight `logs` branch to `cli/index.js` alongside the existing status branch.

The branch must:

1. Recognize the existing placement of one global `--debug` or `-d` flag.
2. Dynamically import `cli/commands/logCommands.js` without importing `cli/main.js`.
3. Invoke the log handler and return its numeric code.
4. Avoid `assertRuntimeDependencies()`, `initEnvironment()`, `bootstrap()`, `loadAgents()`, or any module whose import has filesystem write side effects.
5. Resolve the workspace exactly as current read-only status does, but treat missing `.ploinky` or `agents.json` as absent state rather than creating them.
6. Treat malformed, symlinked, non-regular, or unreadable `agents.json` as a closed failure. Do not repair or rewrite it.

`cli/commands/cli.js` still calls the same handler for an already initialized interactive REPL. There must be one parser, resolver, state machine, and implementation for both entry paths.

Add a pure snapshot reader, either in `cli/utils/agentRegistrySnapshot.js` or an equivalently focused module:

~~~js
readAgentRegistrySnapshot({ workspaceRoot, fsApi })
~~~

It returns an immutable plain-object snapshot. `ENOENT` means an empty registry; every other read, type, containment, or JSON error fails.

### 6.2 Inspect-only Box forwarding

Add `kind: "logs"` in `ploinky-box/command/route.mjs`. It must preserve the original Core argv and must not use the generic prepare path.

In `runOuterCli()`:

1. Call `inspectBoxStatus()` once.
2. Continue only when state is `running-initialized` and the status contains the exact owned container handle and engine.
3. Build the same fixed in-Box command used by other Core forwarding.
4. Execute `ploinky-local logs ...` without a TTY.
5. Return the exact Core exit code.
6. For absent, stopped, transient, uninitialized, foreign, incompatible, unknown, or unsupported Box state, print one actionable diagnostic to stderr and return 1.
7. Never call `prepareBoxForCommand()`, `reconcileBoxContainer()`, `ensureBoxDependencies()`, or a mutation lock on the logs route.

Use a dedicated async execution primitive for this streaming route. It owns its `container exec` child, forwards SIGINT/SIGTERM, awaits exit, removes handlers once, and maps signal exits to 130/143. The existing synchronous primitive may remain for non-streaming routes.

### 6.3 Pure enabled-agent resolver

Create `cli/utils/agentRegistryResolver.js` with:

~~~js
resolveEnabledAgentRecordFromMap(agentRef, registry)
enabledAgentLogSuggestionsFromMap(registry)
~~~

The module must be pure, deterministic, free of filesystem imports, and implement Section 4.2 exactly.

Then:

1. Make `cli/utils/agents.js::resolveEnabledAgentRecord()` a loading wrapper around the pure resolver.
2. Replace the duplicate resolver in `cli/utils/workspaceDependencyGraph.js` with the pure helper.
3. Use the same helper from `logCommands.js` with the read-only snapshot.
4. Sort ambiguity diagnostics and completions.
5. Add focused tests for the changed semantics because this intentionally makes a hard behavioral correction and does not preserve unsafe first-match behavior.

The log handler resolves the operator reference once to a canonical registry key. Every later registry lookup is by that exact key only; it never resolves the alias again.

### 6.4 Verified file access and bounded output

Replace the current external `tail -f` and fallback watcher with controlled descriptor-based primitives in `cli/commands/logUtils.js`.

Required primitives:

~~~js
openVerifiedLogFile({ trustedRoot, relativeSegments, fsApi })
readLastLinesFromDescriptor(fd, { lineCount, byteLimit })
followDescriptor(fd, { initialLines, signal, output, poll })
runRuntimeLogs({ runtime, containerId, follow, lineCount, signal, output })
~~~

File verification must:

1. Derive every segment from trusted constants or a validated canonical key/run ID/digest.
2. `lstat` each existing parent and reject symlinks or non-directories.
3. Resolve the trusted root and selected file with `realpath` and require exact containment.
4. Open with `O_RDONLY | O_NOFOLLOW` where available.
5. `fstat` the descriptor and require a regular file.
6. Compare the descriptor's device/inode with the verified path before accepting it.
7. Keep the descriptor open for the complete read/follow lifecycle.
8. Never use `tail -F` and never reopen by name after validation.
9. If a producer file is not present yet, poll only the derived exact path with cancellation and repeat the full verification when it appears.

`logs last` limits:

- Maximum 10,000 lines from the parser.
- Maximum 16 MiB of emitted stdout for every source, including OCI output.
- Read files backwards in fixed-size chunks and stop once enough line boundaries are found.
- If the required suffix or child output exceeds 16 MiB, report truncation/limit failure on stderr and return 1.
- Never read an entire unbounded file into memory.

`logs tail` limits:

- The initial suffix is 10 lines and uses the same 16 MiB safety ceiling.
- New bytes are copied in fixed-size chunks directly to stdout.
- The follower keeps constant memory, supports truncation of the same open inode, and is cancellable.
- There is no duration or total-byte limit for live follow.
- Replacement of the pathname does not redirect the open follower to a different inode.

Runtime processes are always spawned with an executable and argument array. Stdout is piped through the bounded/pass-through writer as required; stderr is inherited or relayed without including raw registry, status, or environment data in command-generated diagnostics.

### 6.5 Exact OCI runtime proof

A registry record containing `runtime` and `containerId` is only a candidate. Before running `docker logs` or `podman logs`:

1. Require record `type === "agent"`.
2. Require runtime to be exactly `docker` or `podman`.
3. Require a lowercase 64-hex-character `containerId`.
4. Require non-empty trimmed `instanceId` and `enableGeneration`.
5. Resolve the current workspace identity hash.
6. Inspect only the recorded immutable ID with the recorded runtime.
7. Require the inspected ID and canonical container name to match exactly.
8. Require `HostConfig.Init === true`.
9. Require the existing managed/resource/schema/workspace/contract/instance/generation labels to match the current record and workspace.
10. Accept running or stopped state only after all proof succeeds.
11. Fail if inspect returns missing, staged identity labels mismatch, or any field is malformed.

Factor the non-destructive ownership predicate currently embedded in `cli/sandbox/docker/containerFleet.js` into a reusable pure helper. Keep lifecycle-only descriptor-mount and removal checks in the fleet module. The log path may inspect; it must never discover by name, adopt, repair, start, stop, or remove a container.

After proof, execute only:

~~~text
docker|podman logs --tail <N> <immutable-id>
docker|podman logs --follow --tail 10 <immutable-id>
~~~

### 6.6 Process-specific sandbox log files

Bubblewrap and Seatbelt use the same post-cut log layout:

~~~text
.ploinky/logs/agents/<containerName>.<identityDigest>.log
identityDigest = sha256(instanceId + NUL + enableGeneration + NUL + decimalPid)
~~~

Producer protocol:

1. Require a safe canonical `containerName` and exact runtime identity tuple before spawning.
2. Create `.ploinky/logs/agents` with restrictive permissions.
3. Create one unique temporary regular file in that directory with `wx`, mode 0600, and no-follow protection.
4. Spawn the sandbox with that already-open descriptor for combined stdout/stderr.
5. Once `child.pid` exists, derive `identityDigest` from the existing tuple and PID.
6. Rename the still-open temporary file atomically to its final path.
7. Use that exact final path for immediate-crash diagnostics.
8. Delete the temporary file on spawn failure; never append to an older generation's file.
9. Persist the same tuple and PID through the existing final registry record.

Reader proof:

| Runtime state | Required proof |
|---|---|
| Live Bubblewrap/Seatbelt | Registry tuple and PID match the tuple-bound PID record, and `bwrapFleet` process-identity validation proves the current process. |
| Stopped post-cut sandbox | Registry has the exact runtime, tuple, and positive PID; the derived 0600 regular file passes descriptor verification. |
| Staged record | Derived tuple/PID file is absent or live proof mismatches, so fail closed. |
| Pre-cut stopped sandbox | Print a restart-required diagnostic and return 1. |

Do not add a log-path field to `agents.json`. Do not probe or migrate `<agentName>-bwrap.log`, `<agentName>-seatbelt.log`, or the former canonical-key-only proposal.

Update immediate-crash readers, producer tests, `tests/test-functions/check_preinstall_run.sh`, and the active generated-files table.

### 6.7 Exact no-wait startup stream

Change the producer to:

~~~text
.ploinky/logs/no-wait/<containerName>.<runId>.log
~~~

Producer rules:

1. Derive the filename from the same validated canonical key and UUID already used by the run-scoped status.
2. Create a new 0600 regular file with exclusive creation; do not append across runs.
3. Open one descriptor for combined stdout/stderr and close only the parent copy after spawn.
4. Treat any directory/open/spawn failure as a foreground spawn failure and publish the existing bounded/redacted terminal status where possible.
5. Remove the silent `stdio: "ignore"` fallback.
6. Never delete a log selected by the reader. If producer-side cleanup is added, it may remove only a prior run filename validated from the prior marker and is otherwise out of scope.
7. Update the top-level `noWaitWorker.js` protocol comment to document the run-scoped log relation.

Observer binding:

1. Resolve the canonical registry key and capture its initial `instanceId` plus `enableGeneration`.
2. Read `<container>.current.json` and require one plain object with exact UUID `runId`, exact typed `runStartedAtMs`, safe status basename, and valid wave index.
3. Require `statusFile === <container>.<runId>.json` under the trusted no-wait status root.
4. Validate the run-scoped status through the existing `resolveRunScopedObservation()` rules, including run start, wave, state/phase combinations, timestamps, and deadlines.
5. Require `status.containerName` to equal the canonical key.
6. For `starting`, require a positive published PID and verify that the live process command is exactly Node running `noWaitWorker.js` with the expected container, run ID, run-start epoch, wave, and status-file arguments. A PID liveness check alone is insufficient.
7. Before each poll result is acted on, re-read the current marker and the exact registry key. Require the marker identity and captured registry tuple to remain unchanged.
8. Repeat that revalidation immediately before runtime handoff.
9. A new marker, removed key, changed tuple, expired status, dead/reused PID, or mismatched worker argv means the observed run was superseded or corrupted; stop and return 1.
10. When exact `running` is visible, read `agents.json` once and require the final runtime proof immediately. Do not retry registry visibility because the worker commits it before publishing `running`.

Use a portable read-only process-identity helper modeled on `bwrapFleet`. Linux may use `/proc/<pid>/stat` and NUL-delimited `/proc/<pid>/cmdline`; macOS must use `KERN_PROCARGS2`/`sysctl` or another structured argv source. Do not treat a shell-rendered `ps` command string as exact argv. Tests inject process inspection and must cover PID reuse and argument mismatch.

### 6.8 Source-selection precedence

Selection is subcommand-specific.

#### `logs last` without `--startup`

| Observation | Result |
|---|---|
| Exact verified OCI or sandbox runtime exists | Runtime output wins, regardless of stale, starting, or failed no-wait files. |
| No verified runtime; exact current `starting` worker and run log exist | Show current startup suffix and return 0. |
| No verified runtime; exact current `failed` status and run log exist | Show startup suffix, print bounded/redacted failure summary, return 1. |
| Current status says `running` but exact runtime proof fails | Protocol/ownership failure, return 1. |
| No exact current source | Actionable diagnostic, return 1. |

#### `logs tail` without `--startup`

| Observation | Result |
|---|---|
| Exact current live `starting` worker exists | Follow its run-scoped startup file. It outranks any predecessor runtime while this command is bound to the current start. |
| Followed worker publishes exact `running` | Stop the startup follower internally, revalidate marker and tuple, prove the final runtime once, and hand off. |
| Followed worker publishes exact `failed` | Stop, print bounded/redacted failure summary, and return 1. Never fall back to another runtime. |
| No exact live current worker; verified runtime exists | Follow runtime immediately. |
| No live current worker; no runtime; exact current `failed` startup exists | Show startup suffix and failure summary, return 1. |
| No exact source | Actionable diagnostic, return 1. |

#### `--startup`

`--startup` never selects or hands off to application runtime output.

| Subcommand/state | Result |
|---|---|
| `last` with exact `starting` or `running` status | Show startup suffix, return 0. |
| `last` with exact `failed` status | Show startup suffix and failure summary, return 1. |
| `tail` while exact `starting` | Follow until exact `running` or `failed`. |
| `tail` reaches `running` | Stop startup follow and return 0. |
| `tail` reaches `failed` | Stop, show failure summary, return 1. |
| Missing, stale, superseded, or corrupt current run | Return 1 without probing older shared logs. |

Only already-redacted, bounded status failure fields may appear in command diagnostics. Never print raw registry JSON, raw status JSON, process environments, secrets, or spawn options.

### 6.9 One deterministic handoff state machine

Implement one explicit state machine in `logCommands.js` rather than nested watchers:

~~~text
RESOLVE_TARGET
  -> SNAPSHOT_IDENTITY
  -> SELECT_SOURCE
  -> FOLLOW_STARTUP | FOLLOW_RUNTIME | SHOW_LAST | FAIL

FOLLOW_STARTUP
  -> poll exact run
  -> same starting: remain
  -> exact failed: CANCEL_STARTUP -> FAIL(1)
  -> exact running: CANCEL_STARTUP
       --startup: COMPLETE(0)
       default: REVALIDATE -> PROVE_RUNTIME -> FOLLOW_RUNTIME
  -> superseded/corrupt/expired: CANCEL_STARTUP -> FAIL(1)

FOLLOW_RUNTIME
  -> child exit or operator cancellation
~~~

Rules:

1. There is at most one active follower child or descriptor loop.
2. Internal handoff cancellation is not reported as operator cancellation.
3. Every transition owns and disposes its child, descriptor, timer, listeners, and abort signal exactly once.
4. Runtime `--tail 10` or the file's initial 10-line suffix closes the visible handoff gap.
5. No state transition resolves the original alias again.
6. No registry visibility retry, fuzzy runtime discovery, or fallback watcher exists.

### 6.10 Foreground command and signal ownership

Add one foreground-command coordinator shared by one-shot logs and the REPL.

One-shot behavior:

- SIGINT cancels the active follower and returns 130.
- SIGTERM cancels the active follower and returns 143.
- A normal child exit returns the child's exact code.
- A race between signal and child exit resolves once with the first owned terminal event.
- Handlers and timers are removed in a `finally` path.

REPL behavior:

1. Replace the current unconditional `process.exit(0)` signal path with active-command-aware coordination.
2. While a log follower is active, SIGINT cancels it, waits for cleanup, records code 130 for the command, and returns to the prompt without exiting the REPL.
3. SIGTERM cancels the active command, waits for cleanup, restores the TTY, cleans session containers, and exits 143.
4. When no command is active, preserve intentional REPL shutdown behavior but use the actual signal-derived exit code.
5. Make `runReplCommand()` return the numeric command result instead of discarding it. The REPL decides whether to prompt or terminate.
6. An internal startup-to-runtime handoff never invokes process-level signal behavior.

Outer Box behavior:

1. The dedicated async logs route keeps one active `container exec` child.
2. It forwards SIGINT/SIGTERM, waits for in-Box cleanup, and returns 130/143.
3. It does not allocate a TTY for piped output.
4. Tests cover programmatic signals with no TTY; a controlled manual acceptance covers terminal Ctrl+C.
5. No in-Box `tail`, Docker, Podman, timer, or descriptor follower remains after cancellation.

### 6.11 Completion, help, Dashboard, and active documentation

Update:

| Surface | Required change |
|---|---|
| `cli/main.js` | Enabled-agent completions, correct positional awareness, and active-command signal coordination. |
| `cli/commands/help.js` | Summary, syntax, strict count rules, agent forms, `--startup`, source handoff, and examples. |
| `ploinky-box/bin/ploinky-box.mjs` | Add host-visible `logs` usage and describe inspect-only availability. |
| `README.md` | Add `logs tail` and `logs last` to the Core command list. |
| `docs/ploinky-overview.md` | Document Router and exact agent sources plus the no-mutation guarantee. |
| `docs/code-derived-agent-lifecycle.md` | Update command tables and generated-files rows for run-scoped no-wait and process-specific sandbox logs. |
| `cli/commands/noWaitWorker.js` | Update the protocol comment for the run-scoped producer log. |
| `cli/server/dashboard/dashboard.js` | Replace partial parsing with strict 1..10,000 validation and never emit `NaN` to the CLI. |
| `cli/server/dashboard/dashboard.html` | Add `min="1"`, `max="10000"`, and `step="1"` to the log count input. |
| `tests/test-functions/check_preinstall_run.sh` | Derive the new exact sandbox log path from registry tuple/PID or use a tested helper; remove hardcoded legacy filenames. |

Keep the Dashboard's no-target Router request. Do not add an agent selector in this change.

## 7. Implementation Tasks

Each task begins with a failing focused test and ends with that test passing. Do not combine unrelated cleanup.

### Task 0: Record the scoped baseline

Record:

~~~sh
git status --short --branch
git fetch origin master
git rev-parse master
git rev-parse origin/master
git rev-list --left-right --count master...origin/master
node --test \
  tests/unit/cliStatusEntrypoint.test.mjs \
  tests/unit/helpLayers.test.mjs \
  tests/unit/ploinkyBoxCli.test.mjs \
  tests/unit/noWaitWorker.test.mjs \
  tests/unit/sandboxRuntime.test.mjs \
  tests/unit/runtimeShell.test.mjs
~~~

The two commit IDs must match and the left/right count must be `0 0`. Record the synchronized commit SHA in the implementation notes before editing.

If a broad existing file has unrelated failures, use `--test-name-pattern` and document the limitation. Do not run `npm test`, `tests/test_all.sh`, `tests/run-all.sh`, or the full Ploinky suite.

### Task 1: Add lightweight Core logs dispatch

Files:

- Modify `cli/index.js`.
- Create `tests/unit/cliLogsEntrypoint.test.mjs`.
- Create the minimal `cli/commands/logCommands.js` entry surface.

Tests must prove:

1. `logs` dispatches without importing `cli/main.js`.
2. One global debug flag retains current placement semantics.
3. Running in an absent workspace does not create any file or directory.
4. A pre/post tree hash is unchanged for success and failure.
5. Missing unrelated Core dependencies do not block logs.
6. Missing `agents.json` is empty state; corrupt/unreadable/symlinked registry fails without a write.

### Task 2: Implement the pure registry resolver

Files:

- Create `cli/utils/agentRegistryResolver.js`.
- Create the read-only registry snapshot helper.
- Modify `cli/utils/agents.js`.
- Modify `cli/utils/workspaceDependencyGraph.js`.
- Add focused resolver tests.

Cover exact key, unique alias, duplicate alias, qualified slash/colon, duplicate qualified records, unique bare name, duplicate bare name, malformed separators, reserved Router completion, sorted diagnostics, and an agent actually named `router` through a qualified reference.

### Task 3: Add inspect-only Box routing and async execution

Files:

- Modify `ploinky-box/command/route.mjs`.
- Modify `ploinky-box/bin/ploinky-box.mjs`.
- Extend `ploinky-box/command/execute.mjs`.
- Modify `tests/unit/ploinkyBoxCli.test.mjs` and focused execution tests.

Replace the current test that expects `logs` to prepare the Box. Prove:

1. `running-initialized` forwards without `prepareBoxForCommand()`.
2. Every other Box state returns 1 without reconcile, dependency install, mutation lock, start, or create calls.
3. Core exit codes pass through.
4. SIGINT/SIGTERM reach the active child and map to 130/143.
5. No TTY flags are used for the logs route.

### Task 4: Implement verified descriptor and runtime-output adapters

Files:

- Refactor `cli/commands/logUtils.js`.
- Add focused file-adapter and child-lifecycle tests.

Cover:

1. Trusted-parent and file symlink rejection.
2. Non-regular file rejection.
3. Real-path confinement.
4. Device/inode replacement races.
5. Initial last-10 output and continuous same-descriptor follow.
6. Cancellation during file appearance polling and active follow.
7. Constant-size read buffers.
8. Strict 16 MiB failure for file and OCI `last`.
9. Exact Docker/Podman argument arrays.
10. Unknown runtime rejection before spawn.
11. Spawn error, nonzero exit, operator signal, and internal cancellation cleanup.
12. Removal of the old fallback watcher.

### Task 5: Factor and apply exact OCI ownership proof

Files:

- Factor a reusable predicate from `cli/sandbox/docker/containerFleet.js`.
- Use it in the agent log runtime adapter.
- Add targeted ownership tests, reusing existing container fleet fixtures where practical.

Cover running, stopped, missing, malformed ID, foreign name, wrong workspace, wrong managed/resource/schema/contract label, wrong tuple, missing init, staged predecessor fields, and unsupported runtime. Assert inspection is by immutable ID and no discovery or mutation call occurs.

### Task 6: Make no-wait logs run-scoped

Files:

- Modify `cli/commands/workspaceUtil.js`.
- Update `cli/commands/noWaitWorker.js` comments.
- Extend `tests/unit/noWaitWorker.test.mjs` and/or `tests/unit/workspaceDependencyGraph.test.mjs`.

Cover:

1. `<container>.<runId>.log` exclusive 0600 creation.
2. Two runs never share a descriptor or filename.
3. Open failure does not spawn an unlogged worker.
4. Spawn failure closes descriptors and publishes bounded/redacted failure state.
5. No `stdio: "ignore"` fallback remains.
6. Marker/status filenames and log filenames share the same run identity.

### Task 7: Implement the exact no-wait observer and handoff state machine

Files:

- Extend `cli/commands/logCommands.js`.
- Add `tests/unit/logCommands.test.mjs` with injected filesystem, clock, timers, process inspection, registry snapshots, and followers.

Cover:

1. Missing initial status followed by a valid current `starting` publication.
2. Exact `starting -> running` with one startup follower and one runtime follower.
3. `starting -> failed` returns 1 and never opens a runtime.
4. `--startup` stops at `running` without handoff.
5. Registry final record is read once after `running`; there is no retry.
6. Changed marker during follow fails before handoff.
7. Changed/removed registry tuple during follow fails before handoff.
8. Foreign run ID, run epoch, wave, status basename, container, state/phase, timestamp, and expired deadline fail.
9. Dead PID, reused PID, wrong script, and mismatched worker arguments fail.
10. Internal handoff cancellation does not become exit 130/143.
11. Stale terminal status never outranks an exact verified runtime.
12. A followed current failure never falls back to a predecessor runtime.

Use fake timers; unit tests must not sleep on wall-clock seconds.

### Task 8: Make sandbox logs process-specific

Files:

- Modify Bubblewrap and Seatbelt service managers.
- Reuse/factor sandbox process-identity helpers.
- Update sandbox unit tests and `tests/test-functions/check_preinstall_run.sh`.

Cover:

1. Two aliases of one manifest get different paths.
2. Two generations of one canonical key get different paths.
3. PID participates in the digest.
4. Temporary file is 0600, no-follow, and renamed after PID finalization.
5. Immediate-crash diagnostics read the final exact file.
6. Live proof requires PID record, tuple, PID, and process identity.
7. Stopped post-cut log derives from registry tuple/PID.
8. A staged predecessor record cannot select either generation's log.
9. A pre-cut stopped record returns the restart-required diagnostic.
10. No legacy filename probe or migration exists.

### Task 9: Integrate foreground signal coordination

Files:

- Add or refactor one foreground-command coordinator.
- Modify `cli/main.js`.
- Modify `cli/sandbox/replCommandRunner.js`.
- Create `tests/unit/replCommandRunner.test.mjs` and extend focused log lifecycle tests.

Cover one-shot and REPL SIGINT/SIGTERM, prompt return after active SIGINT, exit 143 after active SIGTERM, numeric result propagation, normal child exit, child/signal race, and cleanup exactly once.

### Task 10: Update help, completion, Dashboard, docs, and consumers

Update every surface in Section 6.11. Add focused tests for:

1. Help summary and detailed examples.
2. Completion with unique aliases, qualified names, ambiguity, and reserved `router`.
3. Dashboard values `1`, `10000`, zero, fractional, partial, empty, and excessive.
4. Root README command discoverability.
5. Generated-files rows for both new log families.
6. Updated sandbox shell consumer.
7. No generated HTML or historical specification edits.

### Task 11: Add targeted shell integration coverage

Extend `tests/test-functions/logs_commands.sh` and register every new function in both `tests/testsAfterStart.sh` and `tests/runFailingFast.sh`. Also register the existing last-N check in the failing-fast runner.

Required integration cases:

1. Existing Router `tail` behavior remains useful.
2. Existing Router `last 5` behavior remains useful.
3. `logs last <N> <agent>` targets the registered immutable runtime and produces available output.
4. `logs tail <agent>` produces output and cleans up after a bounded test cancellation.
5. A deliberately slow no-wait fixture proves startup output is visible before runtime creation and application output appears after automatic handoff.
6. A no-wait failure returns 1 and exposes the bounded failure summary.
7. Sandbox mode uses the new process-specific file when that focused runtime is selected.

Do not assert exactly `N` application lines when a fixture emits fewer lines. Do not hardcode `webmeetAgent` except as an explicit fixture example.

### Task 12: Run scoped verification

Run the focused unit tests for every changed area, then the changed shell functions only. At minimum:

~~~sh
node --test \
  tests/unit/cliLogsEntrypoint.test.mjs \
  tests/unit/logCommands.test.mjs \
  tests/unit/helpLayers.test.mjs \
  tests/unit/ploinkyBoxCli.test.mjs \
  tests/unit/noWaitWorker.test.mjs \
  tests/unit/replCommandRunner.test.mjs
~~~

Also run the specific resolver, OCI ownership, Bubblewrap, Seatbelt, Dashboard, and process-execution test files changed by the implementation.

Run `node --check` on every new or materially changed JavaScript module and `git diff --check`. Run only the focused shell log functions through their normal harness. Do not run the full Ploinky suite.

## 8. Test Matrix

| Risk | Required evidence |
|---|---|
| Hidden Core mutation | Lightweight entrypoint tree-hash test; `cli/main.js` import trap. |
| Hidden Box mutation | Outer route spies prove no prepare/reconcile/install/lock call. |
| Resolver nondeterminism | Duplicate alias/qualified/bare tests with stable sorted errors. |
| Foreign OCI disclosure | Immutable-ID ownership-label matrix. |
| Staged predecessor selection | Fresh tuple plus old runtime fields fails for OCI and sandbox. |
| Mixed no-wait runs | Distinct run-scoped files and marker supersession test. |
| PID reuse | Process start identity and exact argv mismatch tests. |
| Handoff race | Marker and registry tuple change immediately before handoff. |
| Registry visibility misconception | Exact `running` followed by one failed registry read returns 1. |
| Symlink/replacement escape | Trusted-parent, file symlink, inode swap, and no-reopen tests. |
| Unbounded `last` | One over-16-MiB line for file and OCI child output. |
| Resource leak | Descriptor, timer, listener, and child cleanup assertions on every exit. |
| REPL premature exit | Active SIGINT returns prompt; active SIGTERM exits only after cleanup. |
| Outer orphan | Programmatic no-TTY signal test plus controlled terminal acceptance. |
| Active UI drift | Dashboard strict parser and HTML min/max/step assertions. |
| Focused runner omission | New functions and existing last-N registered in both runners. |

## 9. Safety and Correctness Invariants

| Risk | Required protection |
|---|---|
| Cross-workspace access | Derive state/log paths under the current workspace and prove real-path confinement. |
| Filesystem substitution | Reject symlinks/non-regular files, open no-follow, compare device/inode, and retain the descriptor. |
| Container-name reuse | Inspect the persisted immutable ID and verify exact managed ownership labels plus tuple. |
| Shell injection | Spawn only a fixed executable with an argument array. |
| Registry tampering | Read one validated snapshot, allow only known runtime enums, and fail on malformed identity. |
| Stale no-wait state | Bind marker, status, worker command, run metadata, and registry tuple; revalidate through handoff. |
| Alias collision | Use a deterministic resolver and canonical registry key for all later operations. |
| Sandbox generation collision | Derive filename from canonical key, tuple, and finalized PID. |
| Resource leaks | One coordinator disposes children, timers, descriptors, listeners, and abort signals exactly once. |
| Credential exposure | Pass application bytes unchanged but print only bounded/redacted command diagnostics. |
| Runtime mutation | Logs never initialize, bootstrap, reconcile, install, discover, adopt, repair, or alter runtime state. |
| Unbounded memory/output | Fixed-size reads, constant-memory follow, 10,000-line parser cap, and 16 MiB `last` cap. |

## 10. Acceptance Criteria

1. `ploinky logs tail webmeetAgent` shows exact current startup output before the no-wait runtime exists and automatically switches to that run's application output.
2. `ploinky logs last 200 webmeetAgent` returns verified runtime output whenever an exact runtime exists.
3. `--startup` never opens Docker, Podman, Bubblewrap, or Seatbelt runtime output.
4. Direct Core logs do not import `cli/main.js`, check unrelated dependencies, initialize `.ploinky`, or bootstrap repositories.
5. Host-visible logs work only through an already `running-initialized` owned Box and never prepare or repair one.
6. Exact key, alias, qualified name, and unique bare name resolution are deterministic; ambiguous or malformed references fail.
7. OCI logs require exact immutable-ID ownership proof for both running and stopped containers.
8. Two no-wait runs never share one startup log.
9. Two aliases, generations, or finalized sandbox PIDs never share one runtime log.
10. Pre-cut stopped sandbox logs return a restart-required diagnostic; no legacy probe exists.
11. A superseding marker or changed generation tuple stops a follower before handoff.
12. A no-wait `running` publication gets one exact registry read; missing/mismatched runtime fails immediately.
13. A followed no-wait failure returns 1 and never falls back to a predecessor runtime.
14. `logs last` never emits more than 16 MiB and reports limit failure.
15. SIGINT/SIGTERM leave no in-Box or host follower, timer, listener, or descriptor behind.
16. REPL SIGINT cancels active tail and returns to the prompt; SIGTERM exits 143 after cleanup.
17. Router logging and the Dashboard remain functional with their existing no-target syntax.
18. Help, completion, README, active lifecycle docs, producer comments, shell consumers, and focused runners are updated.
19. No new public schema, persisted log index, legacy migration, historical spec edit, or generated HTML edit is introduced.
20. Scoped tests pass without running the full Ploinky suite.

## 11. Explicitly Out of Scope

1. Dashboard agent selection.
2. Cross-agent log aggregation or multiplexing.
3. Search, filtering, timestamps, JSON formatting, or colorization.
4. Log rotation, retention policy, persistent indexing, or remote shipping.
5. Cloud-hosted agent logs.
6. Starting or repairing an agent or Box as a side effect of reading logs.
7. Recovery of pre-cut shared no-wait or sandbox log filenames.
8. Historical DS/specification or generated HTML updates.
9. Explorer deployment, cross-repository tests, or Playwright gates.
10. The full Ploinky test suite.

## 12. Implementation Handoff

Before declaring implementation complete, provide:

1. The synchronized `master`/`origin/master` starting SHA.
2. A concise file-by-file change summary.
3. The exact scoped test commands and results.
4. The controlled terminal Ctrl+C acceptance result through the host Box path.
5. Any pre-existing or unrelated test failures, clearly separated from feature results.
6. `git status --short --branch` showing unrelated user changes were preserved.
