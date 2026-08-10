# Adversarial Review: Agent Log Streaming Plan

Plan reviewed: `docs/superpowers/plans/2026-08-09-agent-log-streaming.md`

Review date: 2026-08-09

## 1. Verdict

**REVISE**

Automatic startup-log to runtime-log handoff is the right operator-facing behavior for a slow no-wait agent. The proposed implementation is not ready, however, because its read-only guarantee is violated at both CLI boundaries, its runtime identity checks do not prove ownership, its startup and sandbox filenames are not run/generation-specific, and its signal design does not account for the existing REPL signal handlers.

The plan is directionally accurate about the current Router-only dispatch, generic Box forwarding, the two no-wait status publications, final OCI records, and the existing Bubblewrap/Seatbelt producers. It is materially inaccurate about qualified enabled-agent resolution and treats "finalized" registry state as if it were directly identifiable when the current registry has transitional staged records but no finalized flag.

Initial worktree state, reported before inspection:

```text
## master...origin/master
 M container/README.md
 M docs/superpowers/plans/2026-07-07-ploinky-box-host-mounted-core.md
?? docs/superpowers/plans/2026-08-09-agent-log-streaming-review-prompt.md
?? docs/superpowers/plans/2026-08-09-agent-log-streaming.md
```

Those entries were treated as unrelated user work and preserved.

## 2. Findings, ordered by severity

### High 1 — `logs` is not observational at either CLI boundary

The plan says the command is observational and only changes the `logs` branch in `cli/commands/cli.js` ([plan lines 118-138](./2026-08-09-agent-log-streaming.md#L118)). That is too late in the current call path.

Direct Core execution sends every command except `status`, help, and bare `cli` through `cli/main.js` ([`cli/index.js:18-28`](../../../cli/index.js#L18)). `runCoreCli()` first checks unrelated dependencies, calls `initEnvironment()`, and runs repository bootstrap before dispatching the command ([`cli/main.js:415-447`](../../../cli/main.js#L415)). `initEnvironment()` creates `.ploinky`, its subdirectories, and the history file ([`cli/utils/config.js:107-130`](../../../cli/utils/config.js#L107)); bootstrap can clone default repositories or switch branches ([`cli/commands/ploinkyboot.js:28-67`](../../../cli/commands/ploinkyboot.js#L28)). Even the proposed `resolveEnabledAgentRecord()` calls `loadAgents()`, whose current implementation creates `.ploinky` before reading ([`cli/utils/workspace.js:22-39`](../../../cli/utils/workspace.js#L22)).

The host wrapper also classifies `logs` as generic forwarding ([`ploinky-box/command/route.mjs:97-100`](../../../ploinky-box/command/route.mjs#L97)). Generic forwarding calls `prepareBoxForCommand()` ([`ploinky-box/bin/ploinky-box.mjs:211-228`](../../../ploinky-box/bin/ploinky-box.mjs#L211)), which takes the mutation path, reconciles the Box, and ensures dependencies ([`ploinky-box/supervisor.mjs:89-113`](../../../ploinky-box/supervisor.mjs#L89)). The current test explicitly expects `logs` to prepare the Box ([`tests/unit/ploinkyBoxCli.test.mjs:180-206`](../../../tests/unit/ploinkyBoxCli.test.mjs#L180)).

Concrete failure mode: asking for logs in an incomplete or stopped workspace can create workspace files, clone/switch repositories, or create/start/repair the outer Box before the log handler runs. That directly contradicts the plan's runtime-mutation invariant.

### High 2 — A persisted OCI container ID alone does not prove a current, owned runtime

Final Docker/Podman records do persist the runtime, immutable container ID, instance ID, and enable generation ([`cli/sandbox/docker/agentServiceManager.js:3168-3202`](../../../cli/sandbox/docker/agentServiceManager.js#L3168)). This supports read-only logs for a running or stopped container only after exact ownership is independently proved.

The registry also has a transitional state. During staging, the code spreads the predecessor record and rotates only `instanceId` and `enableGeneration`, leaving the old `runtime` and `containerId` temporarily attached to the new tuple ([`cli/commands/workspaceUtil.js:1129-1166`](../../../cli/commands/workspaceUtil.js#L1129)). The plan merely allows the `docker`/`podman` enum and prefers the recorded ID ([plan lines 151-153](./2026-08-09-agent-log-streaming.md#L151)). A corrupt or staged registry can therefore direct `docker logs` or `podman logs` at a stale or foreign container.

The repository's existing ownership proof is much stronger: it verifies the inspected ID and name plus the managed/resource/schema/workspace/contract/instance/generation labels and init setting ([`cli/sandbox/docker/containerFleet.js:89-112`](../../../cli/sandbox/docker/containerFleet.js#L89)); it also requires a 64-character immutable ID and re-inspects by that ID ([`cli/sandbox/docker/containerFleet.js:136-176`](../../../cli/sandbox/docker/containerFleet.js#L136)).

Concrete failure mode: registry tampering can disclose another container's logs, while staged predecessor fields can make an old runtime appear to be the new generation. A stopped OCI container is supported only when immutable-ID inspection still succeeds and proves all ownership fields; a missing or removed container is not retrievable.

### High 3 — The marker/status proposal cannot select one exact no-wait worker or log stream

The current startup producer appends every run for a container to the same file ([`cli/commands/workspaceUtil.js:109-130`](../../../cli/commands/workspaceUtil.js#L109), [`cli/commands/workspaceUtil.js:171-175`](../../../cli/commands/workspaceUtil.js#L171)). Markers are written before workers are spawned ([`cli/commands/workspaceUtil.js:2229-2271`](../../../cli/commands/workspaceUtil.js#L2229)). Successive or overlapping workers can therefore write to the same visible log even if their status documents are distinct. The log-opening helper also silently falls back to `stdio: 'ignore'` on failure, leaving a valid-looking active worker with no startup log.

The plan validates a live PID with `kill(pid, 0)` and then polls one run-scoped status ([plan lines 171-211](./2026-08-09-agent-log-streaming.md#L171)). PID liveness is not process identity; PID reuse can validate an unrelated process. The plan also does not re-read the `.current.json` marker or the registry tuple during the follow. A newer start can supersede the marker/record while the original follower later sees its old `running` status and attaches to the newer runtime under the same registry key.

The current protocol already exposes stronger validation primitives. `resolveRunScopedObservation()` strictly binds `runId`, typed `runStartedAtMs`, wave index, state/sequence-phase combinations, timestamps, and deadlines ([`cli/commands/noWaitWorker.js:438-500`](../../../cli/commands/noWaitWorker.js#L438)). The published status includes the PID and exact run metadata ([`cli/commands/noWaitWorker.js:1795-1819`](../../../cli/commands/noWaitWorker.js#L1795)). The plan omits several of those checks.

The proposed registry-read retry is also unsupported. The worker saves the exact runtime record inside `upsertRoute()` ([`cli/commands/noWaitWorker.js:669-731`](../../../cli/commands/noWaitWorker.js#L669)) and only publishes `running` after that awaited commit returns ([`cli/commands/noWaitWorker.js:2032-2042`](../../../cli/commands/noWaitWorker.js#L2032)). Once the run-scoped `running` file is visible, absence or identity mismatch in `agents.json` is a protocol failure, not an expected visibility gap.

Concrete failure modes: mixed startup output from two runs, handoff from an old worker to a new runtime, acceptance of a reused PID, indefinite waiting on an expired queued/active phase, and silent loss of the only startup diagnostic.

### High 4 — The claimed resolver semantics are not the current semantics

The plan promises repository-scoped qualified names and says to call the existing resolver ([plan lines 56-65](./2026-08-09-agent-log-streaming.md#L56), [plan line 132](./2026-08-09-agent-log-streaming.md#L132)). The current resolver checks a global alias first. For a qualified input it strips the qualifier and searches that bare alias across every repository without applying `repoFilter` ([`cli/utils/agents.js:1323-1342`](../../../cli/utils/agents.js#L1323)). It uses `.find()`, so duplicate aliases silently select the first record. Filtering empty split components also lets malformed qualified spellings collapse to two parts. The pure duplicate in `workspaceDependencyGraph.js` has the same behavior ([`cli/utils/workspaceDependencyGraph.js:126-175`](../../../cli/utils/workspaceDependencyGraph.js#L126)).

Literal `router` is additionally reserved by the proposed command grammar, while the proposed completion policy prefers every alias ([plan lines 65 and 242-245](./2026-08-09-agent-log-streaming.md#L65)). An alias literally named `router` would be suggested even though it resolves to Router logs.

Concrete failure modes: `RepoA/foo` can select an alias `foo` from RepoB; duplicate aliases are nondeterministic; malformed qualified inputs are accepted; and completion can advertise an unusable `router` alias. Exact registry keys and unique bare names are otherwise reasonable, but they do not repair these branches.

### High 5 — `<containerName>.log` fixes alias collisions but cannot identify the finalized sandbox process

The current Bubblewrap and Seatbelt producers use only the manifest agent name ([`cli/sandbox/bwrap/bwrapServiceManager.js:766-792`](../../../cli/sandbox/bwrap/bwrapServiceManager.js#L766), [`cli/sandbox/seatbelt/seatbeltServiceManager.js:548-576`](../../../cli/sandbox/seatbelt/seatbeltServiceManager.js#L548)). Moving to an `agents` directory and including `containerName` is necessary to separate aliases, but the proposed single `.ploinky/logs/agents/<containerName>.log` remains append-only across runtime generations ([plan lines 157-167](./2026-08-09-agent-log-streaming.md#L157)).

This is especially unsafe during staging: a fresh tuple can coexist with the predecessor `pid` and runtime fields. A live sandbox can be proved through the tuple-bound PID record and process identity ([`cli/sandbox/bwrap/bwrapFleet.js:84-135`](../../../cli/sandbox/bwrap/bwrapFleet.js#L84), [`cli/sandbox/bwrap/bwrapFleet.js:228-245`](../../../cli/sandbox/bwrap/bwrapFleet.js#L228)), but stopping clears that PID record ([`cli/sandbox/bwrap/bwrapFleet.js:308-369`](../../../cli/sandbox/bwrap/bwrapFleet.js#L308)). The registry does persist the final PID and tuple for Bubblewrap and Seatbelt ([`cli/sandbox/bwrap/bwrapServiceManager.js:841-881`](../../../cli/sandbox/bwrap/bwrapServiceManager.js#L841), [`cli/sandbox/seatbelt/seatbeltServiceManager.js:626-663`](../../../cli/sandbox/seatbelt/seatbeltServiceManager.js#L626)). Those fields must participate in the filename so a staged predecessor cannot select the new process's log and a finalized stopped process remains addressable without a new schema.

The plan also misses existing consumers and diagnostics. Both service managers read the same `logFile` on immediate crash ([`cli/sandbox/bwrap/bwrapServiceManager.js:811-819`](../../../cli/sandbox/bwrap/bwrapServiceManager.js#L811), [`cli/sandbox/seatbelt/seatbeltServiceManager.js:596-604`](../../../cli/sandbox/seatbelt/seatbeltServiceManager.js#L596)). `tests/test-functions/check_preinstall_run.sh` hardcodes both legacy filenames ([`tests/test-functions/check_preinstall_run.sh:30-45`](../../../tests/test-functions/check_preinstall_run.sh#L30)). Seatbelt already grants write access to `LOGS_DIR`, so the new subdirectory needs creation but no broader profile grant ([`cli/sandbox/seatbelt/seatbeltServiceManager.js:513-538`](../../../cli/sandbox/seatbelt/seatbeltServiceManager.js#L513)).

The hard cut also conflicts with the unqualified promise that stopped runtime logs remain retrievable ([plan lines 35-36](./2026-08-09-agent-log-streaming.md#L35)). Pre-upgrade stopped sandbox records have only legacy files. A safe plan must either narrow that promise to post-cut sandbox launches and emit a restart-required diagnostic, or define a migration. Probing legacy names is unsafe for aliases and should remain out of scope.

### Medium 6 — Source-selection precedence is internally inconsistent

The public contract says `logs last` uses runtime output whenever an exact runtime is available ([plan line 53](./2026-08-09-agent-log-streaming.md#L53)). The common selection table instead chooses startup output for any live `starting` status ([plan lines 181-190](./2026-08-09-agent-log-streaming.md#L181)). It does not distinguish `last` from `tail`, and it leaves a current `failed` status plus a retrievable runtime underspecified.

The stale-terminal/runtime row is conceptually correct: a stale no-wait status must not outrank a valid finalized runtime. It is only safe after the OCI or sandbox finalization proofs above. During an already-followed run, however, `starting -> failed` must stop and return 1 rather than silently switching to some other runtime.

Concrete failure modes: `logs last` can return startup text despite a valid runtime, while a tail command can mask the failure of the exact worker it was following or select a staged predecessor that merely looks finalized.

### Medium 7 — Signal, REPL, and Box exit semantics are incomplete

The plan proposes temporary SIGINT/SIGTERM listeners ([plan lines 217-238](./2026-08-09-agent-log-streaming.md#L217)). The REPL already installs permanent listeners whose first action path ends in `process.exit(0)` ([`cli/main.js:356-369`](../../../cli/main.js#L356)). A command-local handler registered later may never clean its child or return 130/143. The REPL command runner also discards numeric command results ([`cli/sandbox/replCommandRunner.js:1-15`](../../../cli/sandbox/replCommandRunner.js#L1)).

At the Box boundary, execution is synchronous with inherited stdio and only maps the resulting status/signal ([`ploinky-box/command/execute.mjs:40-50`](../../../ploinky-box/command/execute.mjs#L40)). The plan leaves end-to-end Ctrl+C as an open acceptance point ([plan lines 394-398](./2026-08-09-agent-log-streaming.md#L394)), but the new inspect-only `logs` route and its cleanup behavior need to be part of the implementation task, not an unresolved postcondition.

Concrete failure modes: an in-Box `tail`, Docker, or Podman follower can survive the outer process; REPL Ctrl+C can exit 0 before cleanup; an internal handoff signal can be mistaken for operator cancellation; and a race between child exit and SIGTERM can produce the wrong exit code.

### Medium 8 — Lexical path checks do not prevent symlink escape or replacement, and `last` is only line-bounded

The plan derives paths under `.ploinky` and checks safe segments ([plan lines 353-365](./2026-08-09-agent-log-streaming.md#L353)), but lexical `resolve()`/`relative()` checks do not stop `.ploinky/logs`, `no-wait`, `agents`, or a selected file from being a symlink. Its proposed `tail -F` reopens by name and can follow a file replacement after validation ([plan lines 144-149](./2026-08-09-agent-log-streaming.md#L144)). The repository already has a suitable fail-closed pattern: `lstat`, reject symlinks/non-regular files, and compare real paths under the exact root ([`cli/sandbox/docker/containerFleet.js:61-77`](../../../cli/sandbox/docker/containerFleet.js#L61)).

The 10,000-line limit does not cap bytes; one adversarial line can be arbitrarily large. `logs tail` is intentionally unbounded in duration, but it must remain constant-memory and cancellable. `logs last` needs an explicit byte ceiling if the plan intends "bounded" to be a security property.

Shell injection is handled correctly by the executable-plus-argument-array requirement. Credential handling needs one additional rule: live application output is intentionally passed through unchanged, but command diagnostics must never print raw registry/status JSON or environments. Existing no-wait failure details are bounded and redacted before persistence ([`cli/commands/noWaitWorker.js:1490-1535`](../../../cli/commands/noWaitWorker.js#L1490), [`cli/commands/noWaitWorker.js:2052-2078`](../../../cli/commands/noWaitWorker.js#L2052)); the log command should print only those already-redacted fields.

### Medium 9 — The scoped tests and active surfaces omit central regressions

The plan's baseline and verification sets do not exercise a lightweight log entry point ([plan lines 259-272 and 338-350](./2026-08-09-agent-log-streaming.md#L259)). The existing status test demonstrates the required tree-hash/no-core-import pattern ([`tests/unit/cliStatusEntrypoint.test.mjs:28-77`](../../../tests/unit/cliStatusEntrypoint.test.mjs#L28)). The proposed shell integration uses an already-running agent and therefore does not cover the feature's defining no-wait handoff ([plan lines 325-336](./2026-08-09-agent-log-streaming.md#L325)).

The Dashboard parser accepts partial integers, does not cap at 10,000, and can emit `NaN` ([`cli/server/dashboard/dashboard.js:109-119`](../../../cli/server/dashboard/dashboard.js#L109)); its number input has no min/max constraints ([`cli/server/dashboard/dashboard.html:248-253`](../../../cli/server/dashboard/dashboard.html#L248)). The new strict CLI parser would make that active UI repeatedly error for values the UI currently permits.

The plan names two active docs but omits the root command list in `README.md` ([`README.md:233-252`](../../../README.md#L233)) and the generated-files table that currently documents no-wait state but not either new log family ([`docs/code-derived-agent-lifecycle.md:798-809`](../../code-derived-agent-lifecycle.md#L798)). It also needs to update the no-wait producer comment ([`cli/commands/noWaitWorker.js:1-12`](../../../cli/commands/noWaitWorker.js#L1)) and the hardcoded shell consumer cited in Finding 5. Generated HTML should remain untouched, consistent with `CLAUDE.md`.

Finally, new shell test functions must be registered in the normal focused runners. Current log registrations are at [`tests/testsAfterStart.sh:198-200`](../../../tests/testsAfterStart.sh#L198) and [`tests/runFailingFast.sh:122-127`](../../../tests/runFailingFast.sh#L122); the latter does not even register the existing last-N check.

## 3. Plan amendments

The following is exact replacement or additional plan text for the accepted findings.

### Amendment 1 — Replace the dispatch part of Section 5.1 and add a Box subsection

```markdown
#### Read-only entry-point dispatch

`cli/index.js` shall recognize the `logs` command, including the currently accepted placement of one global `--debug`/`-d` flag, before importing `cli/main.js`. It shall dynamically import the log command module and return its numeric exit code. This path must not call `assertRuntimeDependencies()`, `initEnvironment()`, `bootstrap()`, or any registry reader that creates directories. Read `agents.json` through a read-only snapshot function: `ENOENT` means no enabled state; malformed or unreadable JSON fails closed and does not repair or rewrite it.

The interactive REPL may call the same handler from `cli/commands/cli.js`, but one-shot execution must use the lightweight entry point. Add a tree-hash test proving repeated `logs` invocations do not change an existing workspace and do not create `.ploinky` in an absent workspace.

#### Inspect-only Box forwarding

Classify `logs` as its own outer route. `runOuterCli()` shall call only `inspectBoxStatus()` and may execute `ploinky-local logs ...` only when the exact owned Box is already `running-initialized`. For absent, stopped, foreign, incompatible, unknown, or unsupported Box state, print an actionable diagnostic and return nonzero. Never call `prepareBoxForCommand()`, `reconcile()`, dependency installation, or a mutation lock for `logs`.
```

### Amendment 2 — Replace the OCI finalization text in Section 5.3

```markdown
An OCI source is retrievable only when all of the following read-only proof succeeds: the exact enabled record is type `agent`; runtime is exactly `docker` or `podman`; `containerId` is one lowercase 64-hex immutable ID; `instanceId` and `enableGeneration` are nonempty; and runtime inspection by that ID returns the same ID, the exact registry/container name, `Init === true`, and the current managed/resource/schema/workspace/contract/instance/generation labels. Factor the ownership predicate from `containerFleet.js` so the log path uses identical checks without taking a lock or mutating state.

Never inspect by name, enumerate for candidates, adopt, or repair. A proved running or stopped container is retrievable. A missing container, staged predecessor, identity mismatch, or ownership mismatch is not a runtime source and must fail closed before `runtime logs` is spawned.
```

### Amendment 3 — Replace Sections 5.5-5.6's worker-binding and registry-retry text

```markdown
The no-wait producer shall write one run-scoped startup file at `.ploinky/logs/no-wait/<containerName>.<runId>.log`, mode 0600, using the already-minted UUID. It must not append separate runs to one canonical file and must not silently replace a log-open failure with ignored stdio. On publication of a new marker, producer-side startup code may remove only the single prior run log derived from a strictly validated predecessor marker; the observational `logs` command never deletes anything.

Capture the selected record's exact `(containerName, instanceId, enableGeneration)` before observing startup. Validate the marker's object shape, UUID, typed `runStartedAtMs`, typed wave index, exact status basename, and real-path confinement. Validate the run-scoped status with the existing timeout model and `resolveRunScopedObservation()`, then additionally require the exact container name and valid worker PID. Treat a PID as current only when both liveness and process identity are proved: the process command must be `noWaitWorker.js` with the exact container, run ID, run-start, wave, and status-file arguments. `kill(pid, 0)` alone is insufficient.

While following, re-read the current marker and exact registry tuple on every status poll and immediately before handoff. If either is superseded or changes, cancel the follower and fail; do not switch runs. A fresh marker without a status is allowed only within the existing startup/read-retry grace. Apply the existing queued and active deadlines.

After a validated `running` publication, perform one exact registry read and require the captured tuple plus the runtime ownership proof. Do not retry an absent or mismatched registry record: current publication order commits the record before publishing `running`, so mismatch is a protocol violation. Stop the startup follower internally, suppress that child's signal-derived status, and start the verified runtime follower.
```

### Amendment 4 — Replace Section 5.2's resolver algorithm

```markdown
Extract one pure `resolveEnabledAgentRecordFromMap(agentRef, registry)` helper and use it from both the existing loading wrapper and the log command's read-only snapshot. Remove the duplicate resolver in `workspaceDependencyGraph.js` where practical.

Resolution order is:

1. Literal unqualified `router` is reserved by the log command before agent resolution.
2. An exact registry key resolves directly, except the reserved literal `router`.
3. An unqualified alias is collected across all enabled agent records and succeeds only when exactly one record matches.
4. A qualified `repo/agent` or `repo:agent` contains exactly one separator, two nonempty components, and matches `record.repoName` plus `record.agentName`; it never falls back to alias lookup.
5. A bare manifest agent name succeeds only when exactly one enabled record matches.

Reject duplicate aliases, duplicate qualified matches, malformed/multiple separators, and ambiguous bare names with a sorted list of usable exact keys/aliases. An alias literally named `router` is never suggested bare; completion must offer its qualified manifest name or exact registry key. A manifest agent named `router` remains reachable by a qualified name. Do not add any production identifier for `webmeetAgent`; it remains example/test data only.
```

### Amendment 5 — Replace Section 5.4

```markdown
Use one pure sandbox log-path helper based on fields already persisted in a final sandbox record:

`.ploinky/logs/agents/<containerName>.<sha256(instanceId + "\0" + enableGeneration + "\0" + pid)>.log`

The producer shall create the `agents` directory safely, open a unique 0600 temporary log in that directory without following symlinks, spawn with that descriptor, and immediately rename the still-open file to the final tuple/PID-derived path after a positive child PID is known. Bubblewrap and Seatbelt immediate-crash diagnostics must read that exact renamed file. A live source additionally requires the existing tuple-bound PID record and process-identity check. A stopped source uses the final registry tuple/PID-derived file. A staged record retains the predecessor PID under a fresh tuple and therefore cannot select the new process's file.

This remains a hard cut: do not probe, migrate, copy, or infer legacy `<agentName>-bwrap.log` or `<agentName>-seatbelt.log` files. State explicitly that pre-cut stopped sandbox logs require one operator-initiated restart before they are available through the new command. Update `check_preinstall_run.sh` to use the new command or the shared exact path helper, and update the lifecycle files-generated table and producer comment.
```

### Amendment 6 — Replace the common source-selection table with subcommand-specific rules

```markdown
Source precedence is subcommand-specific.

For `logs last` without `--startup`, a verified exact runtime wins regardless of stale, live-starting, or terminal no-wait state. If no verified runtime exists, use only the current marker-bound startup log. A current failed run prints the bounded redacted failure summary and returns 1.

For `logs tail` without `--startup`, a validated live current worker in `starting` wins so slow startup is observable. If that exact followed run publishes `failed`, stop and return 1 without falling back. If it publishes `running`, perform the exact handoff. When invocation begins with no live current worker, prefer a verified exact runtime; use a current failed startup log only when no runtime exists. Invalid, expired, dead, foreign, or superseded startup state never authorizes startup output.

With `--startup`, never select runtime output. `tail --startup` emits the last 10 startup lines, follows only the exact run, and exits 0 on `running` or 1 on `failed`; `last --startup` reads only that current run's file and returns 1 when its current terminal state is `failed`.
```

### Amendment 7 — Replace Section 5.7's lifecycle text

```markdown
One foreground-follow coordinator owns exactly one active child or file descriptor, one status poller, and one idempotent cancellation result. Operator SIGINT/SIGTERM, child exit, spawn failure, internal handoff, and status transition race through that coordinator; the first terminal cause wins. Internal handoff cancellation never becomes exit 130/143. Normal child nonzero status is propagated. `--startup` returns 0 on `running` and 1 on `failed`.

In one-shot Core mode, install and remove temporary handlers. In REPL mode, integrate with the existing global handlers: active SIGINT cancels the follower and returns to the prompt; active SIGTERM cancels it and exits 143. The existing handler must not call `process.exit(0)` before active-command cleanup. Idle REPL behavior may remain unchanged.

The inspect-only outer Box route must preserve the Core code. Run a controlled no-TTY acceptance test for SIGINT and SIGTERM. If synchronous `container exec` cannot prove forwarding and reaping, use an async child only for the `logs` route, forward both signals, await its exit, remove handlers once, and verify that no in-Box follower survives.
```

### Amendment 8 — Add to Section 7

```markdown
For every file source, validate each trusted parent directory with `lstat`/`realpath`; reject symlinked roots, directories, non-regular files, and files whose real path escapes the exact workspace log root. Open with `O_NOFOLLOW`, then `fstat` the descriptor and verify device/inode against the validated file. Do not use name-reopening `tail -F` after validation. Use one cancellable, constant-memory descriptor follower for append-only workspace logs; a marker-bound startup file that does not yet exist may be awaited only for the bounded startup grace while the marker/tuple remains unchanged.

Live follow output is intentionally duration-unbounded and passed through unchanged, but no output is accumulated in memory. `logs last` has both the 10,000-line limit and a named 16 MiB output ceiling; on reaching the byte ceiling, stop, report truncation on stderr, and return nonzero. Never print raw registry/status JSON, process environments, or command strings. For failure summaries, print only the existing bounded/redacted fields.
```

### Amendment 9 — Add to Tasks 6-8

```markdown
Update the root `README.md` Core command list, the lifecycle files-generated table, the no-wait producer comment, the Dashboard count input (`min=1`, `max=10000`, `step=1`) and finite-integer client validation, and `tests/test-functions/check_preinstall_run.sh`. Keep generated HTML and historical specifications untouched.

Add a lightweight logs-entrypoint test modeled on `cliStatusEntrypoint.test.mjs`. Register every new shell log test in both `tests/testsAfterStart.sh` and `tests/runFailingFast.sh`. Keep immutable OCI argv/ownership assertions in unit tests; integration tests should assert visible output and exit behavior rather than trying to infer hidden spawn arguments.
```

## 4. Missing tests

Only the following additions are needed for the identified risks and behavior gaps:

1. **Read-only entry/Box boundary (Finding 1):** a tree-hash test for repeated direct `logs` calls, an absent-workspace test proving `.ploinky` is not created, debug-flag placement cases, and Box-state tests proving `prepareBoxForCommand()` is never called while only an already-running initialized owned Box is executed.
2. **OCI ownership (Finding 2):** valid running and stopped exact containers; malformed ID; foreign ID/name/workspace/tuple/contract/schema labels; missing init; missing inspected container; and a staged record that carries a predecessor ID. Every rejection must occur before spawning `logs`.
3. **Exact no-wait run (Finding 3):** two overlapping run-scoped logs with no cross-output; missing status within grace; expired queued and active statuses; PID reused/wrong argv; marker supersession; registry-tuple supersession; status/container/run-start/wave/phase mismatches; log-open failure publication; and `starting -> running` with exactly one internal cancellation and one runtime follower.
4. **Resolver/router (Finding 4):** qualified name in the presence of a foreign same-name alias, duplicate aliases, multiple instances, exact-key-versus-alias precedence, malformed/multiple separators, manifest agent named `router`, alias named `router`, and completion that never suggests the unusable bare alias.
5. **Sandbox identity (Finding 5):** two aliases, two tuples, and two PIDs produce distinct paths; a staged predecessor cannot select a new log; final stopped records remain readable; live records require exact PID identity; immediate-crash diagnostics read the renamed exact file; legacy paths are not probed; and the preinstall diagnostic consumes the new source.
6. **Precedence (Finding 6):** table-driven `last`, `tail`, and `--startup` tests for live starting plus valid runtime, stale/dead status plus valid runtime, failed status with and without runtime, followed-run failure, and successful handoff.
7. **Signals/leaks (Finding 7):** normal/nonzero/spawn-error child exits; internal handoff not surfacing 130/143; operator signal winning a race; exact listener/timer/fd cleanup; REPL with pre-existing handlers; and controlled Box SIGINT/SIGTERM acceptance with an assertion that no in-Box follower remains.
8. **Path/output security (Finding 8):** symlinked root/directory/file, post-validation replacement, non-regular file, and cross-workspace real-path escape; constant-memory follow; a single overlarge line hitting the byte ceiling; and diagnostics that do not print raw registry/status/environment data.
9. **Active surfaces/integration (Finding 9):** Dashboard invalid/over-limit count behavior; help/completion for the reserved `router` cases; one focused real no-wait startup-to-runtime handoff; one stopped OCI `logs last` case; and runner-registration assertions. No full-suite run is required.

## 5. Simplifications

1. Delete the portable fallback watcher instead of retaining and repairing it. One controlled descriptor follower handles Router and sandbox/startup files without a `tail` subprocess.
2. Remove the post-`running` registry visibility retry. The existing publication order makes a mismatch a protocol error.
3. Factor one pure registry-snapshot resolver instead of adding a third copy of the current resolver logic.
4. Use one source-selection state machine and one foreground-follow coordinator; runtime/file adapters should only produce a verified descriptor or executable-plus-argv source.
5. Derive startup and sandbox filenames from existing run/runtime identity. Do not add a current-log index, registry field, routing field, or new persisted schema.
6. Keep the sandbox hard cut. Do not add legacy probing, migration heuristics, or alias-dependent fallback; give a precise restart-required diagnostic for pre-cut stopped sandboxes.
7. Remove `getLogPath(kind)`'s unknown-to-Router fallback. Unknown source kinds must fail closed instead of silently selecting Router.
8. Keep `webmeetAgent` only as an example or fixture value. No agent-specific production branch, identifier, option, or compatibility behavior is needed.

## 6. Review execution and repository changes

No tests were run; the challenged claims were established by read-only source/test inspection, so no test workspace was needed. No implementation files were edited. The report is unstaged, no staged changes remain, and nothing was committed, pushed, deployed, started, repaired, or removed.

The original review request required no file changes. The follow-up request explicitly asked for the findings in a Markdown file, so this review document is the sole file created by the reviewer:

```text
docs/superpowers/plans/2026-08-09-agent-log-streaming-review.md
```
