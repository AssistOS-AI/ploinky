# Agent Log Streaming Remediation Implementation Plan

Date: 2026-08-10

Status: Proposed remediation for the current uncommitted implementation

Base plan: `docs/superpowers/plans/2026-08-09-agent-log-streaming.md`

Review context: the implementation is directionally correct, but the adversarial implementation review remains **REVISE** because process identity, state revalidation, producer path safety, backpressure, and signal cleanup are not yet strong enough.

## 1. Objective

Finish the existing agent log streaming implementation without replacing the parts that are already sound.

The completed behavior must let an operator:

1. Follow the exact startup log of a slow current no-wait worker.
2. Hand off once, automatically, from that startup log to the runtime created by the same run.
3. Read or follow an already finalized Docker, Podman, Bubblewrap, or Seatbelt runtime.
4. Use aliases, qualified names, unique bare names, and usable canonical keys without resolving a different record.
5. Interrupt any follower without leaking a host child, an engine child, an in-Box Core process, a runtime log process, a descriptor, a timer, or a signal listener.

The implementation must remain observational. Reading logs must not create, adopt, prepare, start, repair, stop, remove, rewrite, or otherwise mutate workspace or runtime state.

`webmeetAgent` remains an example only. No production branch, constant, default, filename, compatibility rule, completion, or test assumption may depend on that identifier.

## 2. Starting Rules

Before implementing:

1. Read the repository-root `AGENTS.md` and the complete canonical `CLAUDE.md`.
2. Capture `git status --short --branch` and review the combined diff against `HEAD` before touching a file.
3. Preserve all unrelated worktree changes. Do not reset, clean, checkout, restore, or rewrite them.
4. Treat executable code and current tests as the source of truth. Do not use historical specifications or generated documentation as implementation authority.
5. Do not edit the base plan, historical plans, generated HTML, or machine-specific local-path documentation while applying this remediation.
6. Add or tighten a focused test before each behavior change.
7. Do not run the full Ploinky suite. Use only the focused commands in Section 16.
8. Do not start a test workspace, deploy Explorer, push, or run cross-repository gates unless the user separately authorizes that work.

The worktree already contains the feature implementation. This is an in-place remediation, not a reimplementation from `HEAD` and not permission to discard any existing change.

## 3. Observed Baseline

The following pieces are already sound and should be retained:

- `cli/index.js` has a lightweight one-shot `logs` dispatch that bypasses `cli/main.js`, dependency checks, environment initialization, and bootstrap.
- `ploinky-box/command/route.mjs` and `ploinky-box/bin/ploinky-box.mjs` classify `logs` as inspect-only and require an already owned `running-initialized` Box.
- `cli/sandbox/docker/containerOwnership.js` proves a Docker/Podman source through the persisted immutable 64-hex container ID and exact ownership labels. It supports both running and stopped containers and rejects staged predecessor fields.
- `logs last` correctly gives a provable finalized runtime precedence over no-wait files.
- Run-scoped no-wait filenames and tuple-plus-PID sandbox filenames are the right identity model.
- Runtime commands use executable-plus-argument arrays, not a shell.
- The descriptor-based file reader pins one verified inode and bounds `last` output at 16 MiB.
- Help, the Router-only Dashboard count validation, active Markdown, Box help, shell consumers, and focused-runner registrations already expose the basic feature.

The focused review baseline passed 256 current unit tests. That result proves the existing assertions, not the guarantees below: several tests currently encode the weak PID fallback, do not force registry revalidation on every poll, and simulate child exit immediately after a signal.

## 4. Defects This Plan Must Close

| ID | Defect | Primary remediation |
|---|---|---|
| R1 | A later or foreign process can satisfy the current worker proof; duplicate worker flags are last-value-wins. | Structured argv on Linux and macOS plus one strict shared worker-argument parser. |
| R2 | Marker and registry identity are not revalidated on every pending/starting poll, in `--startup`, or at the final handoff fence. | One bound observation function used for every state decision. |
| R3 | A marker is published before the run-scoped log exists, so `tail` can fall through to a predecessor runtime. | Open the producer log before marker publication and wait only for the exact file while the bound run remains valid. |
| R4 | Sandbox log selection calls a lifecycle helper that can delete a stale PID record. | Remove liveness from log source selection; derive and open the exact immutable file only. |
| R5 | Registry, marker, and status reads are not uniformly size-bounded or race-safe; failure text can expose raw or unbounded data. | One bounded verified JSON reader and one defensive diagnostic sanitizer. |
| R6 | Sandbox directory creation can follow a foreign path; final rename can overwrite; finalization failures can orphan a detached child. | Verified producer directories, no-replace publication, and pre-commit child cleanup before `unref()`. |
| R7 | The REPL coordinator claims every command even though only logs receives its signal; REPL close paths can lose signal exit codes. | Scope foreground ownership to logs and centralize idempotent REPL shutdown. |
| R8 | Runtime and Box children receive one signal and may be awaited forever; engine signal forwarding does not prove the in-Box follower stopped. | Bounded TERM/KILL supervisors plus a private Box stdin-EOF cancellation channel. |
| R9 | File and runtime pumps ignore writable backpressure; immediate sandbox-crash diagnostics read whole files. | Await drain before reading more and reuse the bounded backwards reader. |
| R10 | Ambiguity diagnostics and completions can advertise an alias that resolves to another exact key or the reserved Router target. | Generate references by resolving each candidate back to its intended canonical record. |

## 5. Non-Negotiable Invariants

### 5.1 Observational command boundary

The `logs` command may perform only these external operations:

- read and verify files;
- inspect one persisted OCI container ID;
- spawn `docker logs` or `podman logs` for a proved ID;
- follow an already opened file descriptor;
- forward through an already running, initialized, owned Box.

It must never call workspace initialization, bootstrap, Box preparation, runtime discovery by name, repair, adoption, lifecycle cleanup, PID-record cleanup, or any registry/status writer.

Add a negative dependency test that fails if the logs path imports or invokes mutating modules. A before/after tree snapshot must remain identical for existing workspaces, and an absent workspace must remain absent.

### 5.2 Identity

One agent follow binds once to:

```text
canonical registry key
+ instanceId
+ enableGeneration
+ current marker { runId, runStartedAtMs, waveIndex, statusFile }
```

Every later lookup is by canonical key and derived run-scoped paths. Never resolve the operator's alias again during a follow.

At runtime handoff, also fence the source-specific immutable identity:

- OCI: `runtime + containerId`;
- sandbox: `runtime + pid + derived identity digest`.

### 5.3 Fail closed

Malformed, oversized, symlinked, foreign, replaced, ambiguous, expired, or unverifiable state must produce one bounded diagnostic and exit 1. Do not guess a nearby source, search by container name, probe legacy log names, retry a post-`running` registry mismatch, or repair any state.

### 5.4 Output contract

- Selected application/startup log bytes remain unmodified.
- Control and handoff messages go to stderr.
- `last` remains capped at 16 MiB across emitted application streams.
- Control diagnostics are separately bounded and redacted.
- A duration-unbounded `tail` must remain constant-memory and honor writable backpressure.

## 6. Work Order and Dependency Graph

Implement in this order:

```text
Task 1: verified reads + diagnostics
  ├─> Task 2: exact worker identity
  ├─> Task 3: bound no-wait observer and handoff
  └─> Task 5: safe producer directories

Task 4: pure sandbox selection ─> Task 5: sandbox producer commit

Task 6: backpressure + child supervisor
  ├─> Task 7: Core/REPL signal ownership
  └─> Task 8: Box cancellation channel

Task 9: resolver round trips

Tasks 1-9 ─> Task 10: integration surfaces, docs, and final verification
```

Do not combine unrelated lifecycle refactors with these tasks.

## 7. Task 1 — Add One Bounded, Verified Read Layer

### Files

- Add `cli/utils/verifiedReadOnlyFile.js`.
- Modify `cli/commands/logUtils.js` to use it for log descriptors.
- Modify `cli/utils/agentRegistrySnapshot.js`.
- Modify `cli/commands/noWaitLogObserver.js`.
- Add `cli/utils/diagnosticText.js`.
- Modify `cli/commands/noWaitWorker.js` and `cli/commands/workspaceUtil.js` to share the diagnostic policy.
- Add `tests/unit/verifiedReadOnlyFile.test.mjs` and `tests/unit/diagnosticText.test.mjs`.
- Extend `tests/unit/cliLogsEntrypoint.test.mjs` and `tests/unit/noWaitRunScopedLogs.test.mjs`.

### Implementation

Create a side-effect-free primitive:

```js
openVerifiedRegularFile({ trustedRoot, relativeSegments, fsApi, pathApi })
```

It returns a pinned descriptor or `null` for absence and must:

1. Validate every relative segment with the existing safe-segment grammar.
2. `lstat` the trusted root and every child directory; reject links and non-directories.
3. `lstat` the final path; reject links and non-regular files.
4. Verify the final real path remains beneath the real trusted root.
5. Open with `O_RDONLY | O_NOFOLLOW`.
6. Compare the opened descriptor's device and inode to the validated final path.
7. Close the descriptor on every rejected or exceptional path.

Move the current equivalent logic out of `logUtils.js`; do not keep two subtly different verifiers.

Build this JSON-object reader on top:

```js
readVerifiedJsonObject({
  trustedRoot,
  relativeSegments,
  byteLimit,
  absent,
  fsApi,
  pathApi,
})
```

Required limits:

- agent registry: 4 MiB;
- one no-wait marker or status: 256 KiB;
- JSON depth: 64;
- total object/array nodes: 100,000.

Check `fstat().size` before allocation, read at most the declared limit, and reject a size/identity change detected across the read. Parse only one top-level object. Validate depth/node limits with an iterative stack; remove the recursive `deepFreeze()` implementation so hostile nesting cannot overflow the JavaScript stack. Return a deeply frozen snapshot after validation.

Absence is caller-specific:

- missing `agents.json` returns the shared empty registry;
- missing marker/status returns `null`;
- every other path, type, size, containment, or parse problem fails closed.

Do not include raw JSON text or the parser's input excerpt in an error message.

Create a diagnostic helper with a 4,000-character ceiling. It must:

- mask JWTs and `Authorization: Bearer/Basic` values;
- mask values for known manifest/exposed secret names when that context is available;
- mask common token/password/secret/key assignments defensively;
- truncate after redaction, not before it;
- never accept or serialize a whole registry, status object, environment, spawn options object, or stack by default.

Use it both when producing no-wait failure statuses and when summarizing them. In particular, replace the raw `error.message` publication in `writeNoWaitSpawnFailure()`. The consumer must sanitize and cap again because persisted state is not trusted merely because current producers are safe.

### Tests

Cover exact boundary sizes, over-limit files, empty files, malformed JSON, a non-object root, depth/node overflow, a symlinked root, symlinked intermediate directory, symlinked file, inode replacement between `lstat` and `open`, truncation/growth during read, and cross-workspace real-path escape. Assert every opened descriptor is closed.

Add secret-shaped and overlong spawn errors and prove neither the status file nor CLI stderr contains the original credential or more than the diagnostic limit.

### Completion gate

All registry, marker, and status reads used by `logs` go through this layer. No `readFileSync(pathname)` remains in the observational state path.

## 8. Task 2 — Prove the Exact No-Wait Worker Process

### Files

- Add `cli/commands/noWaitWorkerArgs.js`.
- Modify `cli/commands/noWaitWorker.js`.
- Modify `cli/commands/noWaitLogObserver.js`.
- Modify `cli/sandbox/processIdentity.js`.
- Extend `tests/unit/processIdentity.test.mjs` and `tests/unit/noWaitWorker.test.mjs`.

### Implementation

Create one strict parser for the worker invocation. Both the worker and the observer must use it.

The parser must:

1. Recognize the complete current worker option set: required identity/start options and the existing optional alias, profile, router-port, and force-recreate options.
2. Require every token to be a recognized `--name value` pair.
3. Reject unknown flags, missing values, positionals, and every duplicate flag.
4. Preserve option order independence.
5. Apply the existing typed validation for run UUID, epoch, wave, status basename/path, and dependency-status JSON.

This removes last-value-wins behavior from the worker itself and makes the observer validate the same grammar the worker executes.

Replace the current basename-plus-ordered-subsequence proof with structured argv proof:

- Linux: read the NUL-delimited `/proc/<pid>/cmdline` buffer.
- macOS: read `kern.procargs2.<pid>` through fixed `/usr/sbin/sysctl -b` arguments with a timeout and bounded buffer, then parse `argc`, executable path, and exactly `argc` NUL-delimited argv entries.
- Unsupported or unavailable structured argv: fail closed with `PROCESS_IDENTITY_UNPROVEN`.
- Never use a shell-rendered `ps ... args` string as argv proof.

Require:

1. exact executable path equal to the `process.execPath` used by the producer;
2. exact absolute worker script path, not only `noWaitWorker.js` by basename;
3. a strict parse of all remaining arguments;
4. exact values for container, run ID, run start, wave, and absolute status path;
5. a stable process-start identity before and after the argv read so PID replacement during inspection fails.

The process-start value is corroborating race evidence only. Delete the current rule that accepts any process whose start epoch is later than the run start.

### Tests

Cover a valid Linux vector, valid macOS `KERN_PROCARGS2` fixtures, unavailable macOS inspection, wrong executable, same-basename foreign script, missing identity flag, unknown flag, duplicate flag before and after the expected value, shuffled valid flags, wrong status path, PID death, start-identity change during inspection, and an unrelated later process. The unrelated later process must fail.

Add one platform-gated test that spawns a harmless Node child and proves the real platform reader returns structured argv; do not create workspace state.

### Completion gate

There is no start-time-only success result and no ordered-subsequence matcher. The worker and observer cannot disagree about duplicate or unknown options.

## 9. Task 3 — Centralize Bound No-Wait Observation and File Acquisition

### Files

- Modify `cli/commands/noWaitLogObserver.js`.
- Modify `cli/commands/logCommands.js`.
- Modify `cli/commands/logUtils.js`.
- Modify `cli/commands/workspaceUtil.js`.
- Extend `tests/unit/logCommands.test.mjs`, `tests/unit/noWaitRunScopedLogs.test.mjs`, and `tests/unit/cliLogsEntrypoint.test.mjs`.

### Implementation

Introduce one immutable binding:

```js
{
  containerName,
  instanceId,
  enableGeneration,
  marker: { runId, runStartedAtMs, waveIndex, statusFile }
}
```

Implement one `observeBoundNoWaitRun(binding, deps)` operation. Each invocation must, in this order:

1. Read the exact run-scoped status through Task 1's bounded reader.
2. Validate all existing `resolveRunScopedObservation()` invariants.
3. If the state is starting, prove the exact worker through Task 2.
4. Re-read the current marker and require exact equality with the binding.
5. Read one fresh registry snapshot, look up only `containerName`, require `type: "agent"`, and require the bound instance/generation tuple.
6. Return the classified observation and that exact current registry record together.

For a missing status, compute the existing queued/pending deadline from the marker. It must not remain pending forever.

Use this operation for:

- initial pending/starting selection;
- every idle poll while waiting for the log file;
- every idle poll while following startup output;
- `--startup last` and `--startup tail`;
- the transition that observes `running`;
- the final handoff fence.

Do not leave a second marker-only observer or a startup path that omits registry validation.

#### Producer order

Change the no-wait launch phases to:

1. clear all canonical and run-scoped status files for the full schedule before any worker starts;
2. for each worker, open its exact run-scoped log exclusively at mode 0600;
3. publish that worker's current marker only after the log descriptor exists;
4. spawn the worker with the already opened descriptor;
5. close only the parent's descriptor copy;
6. on spawn failure, retain the run log, publish one bounded/redacted failed status, and never leave a running unlogged worker.

If log creation or marker publication fails, do not spawn. If marker publication fails after log creation, close and remove only that task-owned unexposed log.

#### Tail acquisition

Replace the current absent-file fallthrough with a cancellable acquisition loop:

1. Observe the binding.
2. Try to open only `<container>.<runId>.log` through the verified descriptor API.
3. If absent and the state is pending/starting, wait for one injected poll interval and repeat the full observation.
4. If the descriptor opens, observe the binding again before emitting bytes.
5. If `running` or `failed` is terminal but its required run log is absent, treat that as protocol corruption and return 1.
6. Never fall through to an older runtime merely because the startup pathname is temporarily absent.

Do not use `openVerifiedLogFileWhenPresent()` as a generic poller because it cannot revalidate marker and registry identity. Remove it unless it is rewritten as a thin callback-driven helper that executes the full bound observation on every iteration.

#### Handoff fence

When a followed run reports `running`:

1. use the registry record returned by the bound observation;
2. prove OCI ownership or derive/open the sandbox source once;
3. immediately re-run the bound observation;
4. require it still says `running` and require runtime kind plus container ID or sandbox PID to equal the proved source;
5. spawn/follow that source once, without a registry retry.

A changed marker, removed key, changed tuple, changed source identity, or failed ownership proof returns 1.

#### Precedence

Preserve these explicit rules:

| Command/state | Result |
|---|---|
| `last`, provable finalized runtime | Runtime wins without consulting no-wait state further. |
| `last`, no runtime, exact current starting log | Emit startup suffix. |
| `last`, no runtime, exact failed run | Emit startup suffix and bounded failure; return 1. |
| `tail`, exact live pending/starting run | Wait for/follow its startup file; it outranks a predecessor runtime. |
| `tail`, no exact live current worker, provable finalized runtime | Follow runtime. |
| A worker already followed by this command fails or is superseded | Stop with 1; never fall back. |
| Status says `running` but runtime proof fails | Protocol/ownership error; return 1. |
| Any `--startup` command | Never inspect or open a runtime. |

Distinguish stale/unavailable state from malformed or foreign state with error codes. A stale initial status does not outrank a provable runtime; corrupt or foreign state fails closed. Once startup following begins, any loss of the binding is terminal.

### Tests

Use injected clocks and sleeps. Cover marker-before-log, status-before-log, missing status until valid starting, missing status past deadline, exact file appearing later, descriptor open followed by marker change, registry tuple change on every poll position, `--startup` registry change, marker change after `running`, runtime identity change after ownership proof, terminal state without a log, exactly one ownership proof/follower on handoff, no post-`running` retry, internal handoff not producing 130/143, stale initial status plus valid runtime, and followed failure/supersession with no runtime fallback.

### Completion gate

Every startup decision comes from one bound observation result. There is no `kind: "absent"` path that silently selects a runtime.

## 10. Task 4 — Make Sandbox Log Selection Pure

### Files

- Modify `cli/commands/logCommands.js`.
- Modify `cli/sandbox/sandboxLogFiles.js`.
- Extend `tests/unit/logCommands.test.mjs` and `tests/unit/sandboxLogFiles.test.mjs`.

### Implementation

Remove `isBwrapProcessRunning()` from the logs path and remove the unused `running` property returned by `proveSandboxLogSource()`.

Sandbox source selection requires only:

1. supported recorded runtime (`bwrap` or `seatbelt`);
2. exact instance/generation tuple;
3. positive finalized PID;
4. the tuple-plus-PID derived relative path;
5. a verified regular descriptor for that exact path.

Do not call `clearBwrapPid()`, `isBwrapProcessRunning()`, stop helpers, or any other lifecycle API. A stopped post-cut sandbox remains readable because its exact file identity is persisted indirectly by tuple and PID. A missing derived file retains the restart-required diagnostic and does not probe legacy names.

### Tests

Set up a stale/dead PID record and assert `logs last` and `logs tail` perform zero writes/unlinks and leave a before/after workspace tree hash unchanged. Inject mutating lifecycle stubs that throw if called.

### Completion gate

The observational import graph contains no sandbox lifecycle cleanup function.

## 11. Task 5 — Harden No-Wait and Sandbox Log Producers

### Files

- Add producer-directory helpers to `cli/utils/verifiedReadOnlyFile.js` or a narrowly named sibling module.
- Modify `cli/commands/workspaceUtil.js`.
- Modify `cli/sandbox/sandboxLogFiles.js`.
- Modify `cli/sandbox/bwrap/bwrapServiceManager.js`.
- Modify `cli/sandbox/seatbelt/seatbeltServiceManager.js`.
- Extend `tests/unit/noWaitRunScopedLogs.test.mjs`, `tests/unit/sandboxLogFiles.test.mjs`, and `tests/unit/sandboxRuntime.test.mjs`.

### Implementation

For producer-owned directories, validate the workspace root and each existing parent with `lstat`/realpath containment. Create only the expected leaf directory, non-recursively, then revalidate it. Require directories to be owned by the current user and not group/other writable before publishing security-sensitive state or logs.

Apply this to:

- `.ploinky/logs/no-wait`;
- `.ploinky/running/no-wait`;
- `.ploinky/logs/agents`.

Do not let `mkdirSync({ recursive: true })` traverse a symlinked `.ploinky`, `logs`, or `running` parent.

For sandbox logs:

1. Keep the existing canonical-key plus tuple/PID digest naming.
2. Open a random pending file with `O_CREAT | O_EXCL | O_NOFOLLOW`, mode 0600.
3. Publish without replacement using an atomic hard link from pending path to final path, then unlink the pending name.
4. Treat `EEXIST` as an identity collision and fail; never overwrite the prior final file.
5. Close the parent's descriptor in a `finally` path even when link/unlink fails.
6. If the final link was created but cleanup fails, remove only links whose device/inode still equal the opened descriptor before surfacing failure.

For both sandbox managers, keep the child referenced until the candidate has:

1. a positive PID;
2. a successfully published final log;
3. passed the immediate-crash check;
4. saved its exact tuple-bound PID record.

Only then call `child.unref()`.

Any failure before that commit point must synchronously kill the candidate process group and PID with `SIGKILL`, close the parent log descriptor, remove only task-owned pending/final links, and leave predecessor PID/registry state untouched. In particular, remove the Seatbelt immediate-crash call that clears a possibly pre-existing canonical PID record before this candidate owns it.

The child writes through its inherited descriptor. Remove `LOGS_DIR` from both Seatbelt `extraWritePaths` lists; neither the service nor interactive child needs pathname-level write access to the workspace log tree.

Replace whole-file immediate-crash reads in both service managers with the existing backwards descriptor/path reader, limited to 12 lines and at most 64 KiB. Sanitize the resulting control diagnostic before embedding it in an error.

### Tests

Cover a symlinked parent, wrong owner/mode, pre-existing final path, same tuple/PID collision, link failure, unlink-after-link failure, descriptor close on every path, candidate kill before unref, immediate child exit, PID-save failure, predecessor PID preservation, two aliases/generations/PIDs producing different files, file/dir modes, bounded reads of a very large crash log, and Seatbelt profiles without writable `LOGS_DIR`.

### Completion gate

No sandbox finalization can replace an existing identity file, and no pre-commit failure can leave the candidate running or mutate a predecessor's ownership record.

## 12. Task 6 — Add Backpressure and Bounded Child Termination

### Files

- Modify `cli/commands/logUtils.js`.
- Add `cli/commands/logChildSupervisor.js` if keeping the logic in `logUtils.js` would mix concerns.
- Extend `tests/unit/logFileAdapters.test.mjs`.

### Implementation

Add:

```js
writeWithBackpressure(writable, chunk, { signal })
```

If `write()` returns `false`, await `drain` before reading another file/runtime chunk. Race `drain` against abort, `error`, and `close`, remove every temporary listener exactly once, and never destroy `process.stdout` or `process.stderr`.

Use it for:

- the initial file suffix;
- every descriptor-follow chunk;
- Docker/Podman stdout;
- Docker/Podman stderr/application stream;
- bounded one-shot suffix output.

Refactor runtime logs into two backpressured stream pumps plus one child-exit supervisor. For `last`, share the 16 MiB application-output budget across both streams. For `tail`, do not accumulate chunks.

Add a child termination helper with injected timers:

1. send `SIGTERM` once;
2. after 2 seconds without close, send `SIGKILL` once;
3. after one further second without close, detach/destroy only the child's pipes, remove listeners/timers, and reject with a cleanup failure rather than waiting forever;
4. settle once if spawn error, natural exit, abort, output limit, TERM close, and KILL close race.

An operator abort resolves the runtime adapter only after cleanup; the foreground coordinator owns mapping the operator signal to 130/143. A natural integer child code remains exact. Output-limit termination remains an error, not an operator interrupt.

### Tests

Use fake writables and fake timers. Cover `write() === false`, delayed drain, abort before drain, error/close before drain, no read-ahead, listener removal, natural zero/nonzero exits, spawn error, TERM-honored exit, TERM ignored then KILL, child never closes after KILL, output-limit termination, and races between close and abort.

### Completion gate

No output call in the log adapters ignores a false `write()` result, and no runtime child can keep the command promise pending indefinitely after cancellation.

## 13. Task 7 — Correct Direct-Core and REPL Signal Ownership

### Files

- Modify `cli/commands/foregroundCommand.js`.
- Modify `cli/sandbox/replCommandRunner.js`.
- Modify `cli/main.js`.
- Modify `cli/commands/cli.js` only if the active signal plumbing changes.
- Extend `tests/unit/replCommandRunner.test.mjs` and `tests/unit/cliLogsEntrypoint.test.mjs`.

### Implementation

Keep one-shot `logs` inside the foreground coordinator. The coordinator must record the first operator signal, abort once, wait for handler cleanup, remove handlers, and return 130 for SIGINT or 143 for SIGTERM.

In the REPL, coordinate only commands whose parsed command token is `logs`. All other commands call `handleCommand()` directly so an unrelated long-running command does not claim a cancellation signal it cannot consume.

Replace the competing REPL exit paths with one idempotent shutdown function that owns:

- the selected exit code;
- TTY restoration;
- session cleanup;
- input-state deregistration;
- readline close;
- final process exit/exitCode.

The readline `close` event must not unconditionally call `process.exit(0)` after a SIGTERM path selected 143.

Required semantics:

| Context | SIGINT | SIGTERM |
|---|---|---|
| One-shot logs | Cleanup, exit 130 | Cleanup, exit 143 |
| REPL logs | Cleanup, return to prompt with command code 130 | Cleanup, then close REPL with 143 |
| REPL non-log command | Preserve normal REPL shutdown behavior; do not pretend the command consumed it | Close REPL with 143 |
| Internal startup handoff | No operator code; continue into runtime | No operator code; continue into runtime |

### Tests

Cover active logs and non-logs separately, first-signal-wins races, repeated signals, SIGTERM waiting for log cleanup, `rl.close` not overwriting 143, SIGINT returning a prompt only for a coordinated log command, handler exceptions, and exact removal of process listeners.

### Completion gate

Only logs can make `foreground.deliver()` return true, and every exit path has one test asserting its final code.

## 14. Task 8 — Make Box Cancellation End-to-End

### Files

- Modify `ploinky-box/command/execute.mjs`.
- Modify `ploinky-box/bin/ploinky-box.mjs`.
- Modify `cli/index.js` and `cli/commands/foregroundCommand.js` for the private EOF cancellation hook.
- Extend `tests/unit/ploinkyBoxStreamingExecution.test.mjs`, `tests/unit/ploinkyBoxCli.test.mjs`, and `tests/unit/ploinkyBoxArguments.test.mjs`.

### Implementation

Do not depend solely on Docker/Podman forwarding an outer signal through `container exec`.

For the logs route only:

1. Build `container exec --interactive` without `--tty`.
2. Add a fixed private environment marker such as `PLOINKY_BOX_LOG_STREAM=1` to the in-Box command.
3. Spawn the engine child with a dedicated piped stdin and inherited stdout/stderr. Do not pipe the operator's stdin into log bytes.
4. On the first operator SIGINT/SIGTERM, record it, close the engine child's stdin to deliver EOF in the Box, and forward the same signal to the engine child.
5. Apply the same 2-second TERM and 1-second KILL bounds as Task 6.
6. A repeated operator signal may escalate immediately to KILL, but the first signal still determines 130/143.

In the lightweight in-Box `cli/index.js` path, honor stdin EOF only when the private marker is present. Register `end`/`close` listeners for the duration of the log command and route EOF to an internal coordinator cancellation that aborts the follower without recording an operator signal. Remove the listeners in `finally`.

This gives two independent cleanup paths:

- normal engine signal propagation;
- EOF caused by the outer parent pipe closing.

The in-Box command may return 0 after EOF cleanup; the outer process retains the operator's 130/143 code. Natural Core exit codes and spawn failures remain exact/nonzero.

The Box route must stay inspect-only throughout this work. Do not add preparation, repair, a TTY, a mutation lock, or a persisted cancellation marker.

### Tests

Cover exact `container exec` argv (`--interactive`, no `--tty`, fixed environment marker), dedicated stdin, EOF cleanup, signal forwarding, TERM ignored then KILL, repeated signal, child natural exit, spawn error, timeout cleanup, first-signal exit code, listener/timer removal, and no call to Box preparation.

Add one opt-in controlled Docker/Podman acceptance test for an already running initialized Box: start `logs tail`, send SIGINT and SIGTERM in separate cases, and use `pgrep` inside that same Box to prove no `ploinky-local logs`, `docker logs`, or `podman logs` follower remains. Do not make this acceptance test start or repair the Box.

### Completion gate

Unit tests prove bounded host cleanup, and the opt-in acceptance test proves the in-Box process tree is gone rather than merely proving that the outer engine process exited.

## 15. Task 9 — Make Resolver Diagnostics and Completion Round-Trip

### Files

- Modify `cli/utils/agentRegistryResolver.js`.
- Modify completion code in `cli/commands/cli.js` if its adapter assumes every returned string is usable.
- Extend `tests/unit/agentRegistryResolver.test.mjs` and `tests/unit/logsCompletion.test.mjs`.

### Implementation

Keep the current resolver precedence. Add a pure helper that generates candidate references for one canonical record, then feeds each candidate back through `resolveEnabledAgentRecordFromMap()`.

A candidate is usable only when:

1. it is not the reserved unqualified `router` target;
2. resolution does not throw;
3. resolution returns the intended canonical key.

Consider candidates in this display order:

1. alias;
2. `repo/agent`;
3. unique bare agent name;
4. canonical registry key.

Do not assume a unique alias count is sufficient: an alias may equal another record's exact key, which wins by resolver precedence. Do not assume a canonical key is usable when it is literally `router`.

Use the same round-trip helper for ambiguity diagnostics and completion. For a duplicate match, choose each record's first usable reference, sort and deduplicate them, and say `Use one of:` rather than claiming they are aliases. If a record has no usable spelling, report that configuration explicitly instead of advertising a false reference.

To keep completion simple, return one preferred usable spelling per record rather than independently adding every alias, qualified name, bare name, and key.

### Tests

Cover duplicate alias diagnostics, alias equal to another exact key, alias `router`, canonical key `router`, manifest agent named `router` reachable by a unique qualified reference, duplicate qualified names, multiple instances, exact-key precedence, malformed separators, and a property test that every completion resolves to the canonical record it represents.

### Completion gate

No diagnostic or completion string can resolve to a different agent or to Router.

## 16. Task 10 — Focused Integration, Active Surfaces, and Documentation

### Files to inspect and update only when behavior text changes

- `cli/commands/help.js`
- `cli/server/dashboard/dashboard.js`
- `cli/server/dashboard/dashboard.html`
- `README.md`
- `docs/ploinky-overview.md`
- `docs/code-derived-agent-lifecycle.md`
- `tests/test-functions/logs_commands.sh`
- `tests/test-functions/check_preinstall_run.sh`
- `tests/testsAfterStart.sh`
- `tests/runFailingFast.sh`

### Implementation

Update active text to reflect:

- exact worker proof on Linux and macOS;
- automatic handoff's final marker/registry/source fence;
- runtime-first `last` precedence;
- one preferred completion per enabled record;
- reserved `router` requiring a usable qualified spelling for an agent with that name;
- bounded TERM/KILL cleanup;
- immutable process-specific sandbox files and the restart-required hard cut;
- application log bytes being intentionally unredacted while control diagnostics are bounded/redacted.

Keep Dashboard log selection Router-only. Dashboard agent selection, aggregation, search, formatting, and retention remain out of scope. Retain the existing strict 1–10,000 line validation.

Keep `check_preinstall_run.sh` using the public logs command for sandbox diagnostics. Do not reintroduce direct legacy sandbox filename probing.

Add a focused no-wait shell fixture that delays status/log production, emits a unique startup sentinel, transitions to a fake or controlled runtime with a distinct sentinel, and asserts ordered startup-then-runtime output. It must use generic fixture identities.

Register every new focused shell test in both normal focused runners, but do not run the full suite.

### Focused verification commands

Run syntax checks for every changed JavaScript module, then these unit groups:

```sh
node --test \
  tests/unit/verifiedReadOnlyFile.test.mjs \
  tests/unit/diagnosticText.test.mjs \
  tests/unit/processIdentity.test.mjs \
  tests/unit/noWaitWorker.test.mjs \
  tests/unit/noWaitRunScopedLogs.test.mjs

node --test \
  tests/unit/logCommands.test.mjs \
  tests/unit/logFileAdapters.test.mjs \
  tests/unit/cliLogsEntrypoint.test.mjs \
  tests/unit/containerLogOwnership.test.mjs \
  tests/unit/sandboxLogFiles.test.mjs \
  tests/unit/sandboxRuntime.test.mjs

node --test \
  tests/unit/replCommandRunner.test.mjs \
  tests/unit/agentRegistryResolver.test.mjs \
  tests/unit/logsCompletion.test.mjs \
  tests/unit/logSurfaces.test.mjs \
  tests/unit/helpLayers.test.mjs

node --test \
  tests/unit/ploinkyBoxArguments.test.mjs \
  tests/unit/ploinkyBoxCli.test.mjs \
  tests/unit/ploinkyBoxSafetyMatrix.test.mjs \
  tests/unit/ploinkyBoxStreamingExecution.test.mjs
```

If a new test file is not ultimately needed, remove it from these commands rather than leaving a nonexistent path.

Run only the individually named shell log functions through the existing harness, in an already prepared disposable workspace. Do not invoke `tests/testsAfterStart.sh` or `tests/runFailingFast.sh` wholesale.

Finish with:

```sh
git diff --check
git status --short --branch
```

Also inspect the final diff for:

- any new `webmeetAgent` production reference;
- any `exec`, `execSync`, shell string, or name-based OCI discovery in the log path;
- any `readFileSync(pathname)` in observational registry/marker/status reads;
- any unawaited output write in log pumps;
- any `mkdirSync(..., { recursive: true })` in the remediated log/state producers;
- any Box preparation or sandbox cleanup reachable from `logs`;
- any historical plan or generated HTML change.

## 17. Test Matrix by Risk

| Risk | Required proof |
|---|---|
| Foreign/reused PID | Exact executable/script/strict args plus stable start identity; later unrelated process rejected. |
| Stale marker/status | Marker and registry checked after every status/process observation and immediately around handoff. |
| Marker-before-log race | Producer opens first; tail waits on only the bound file and never falls through. |
| Registry tampering | Exact canonical key/tuple every poll; OCI ownership labels and immutable ID remain mandatory. |
| Cross-workspace path | Symlinked/replaced/foreign roots and files fail before bytes or writes cross the trusted root. |
| Credential disclosure | Producer and consumer diagnostics both redact/cap; raw state and environments never print. |
| Unbounded output/memory | `last` byte cap, fixed-size backwards reads, constant-memory tail, and backpressure tests. |
| Sandbox mutation | Tree hash unchanged; no PID cleanup/lifecycle calls from observation. |
| Producer overwrite/orphan | No-replace final link, candidate kill before unref, predecessor record preserved. |
| Alias/router collision | Every advertised reference round-trips to its intended canonical key. |
| Ctrl+C/SIGTERM leak | Direct, REPL, host Box, and in-Box process-tree tests with exact 130/143 semantics. |

## 18. Simplifications Required by This Remediation

Remove these states or behaviors instead of repairing them:

1. Remove the start-time-only process proof and basename/ordered-subsequence argv matching.
2. Remove the `running` field and `isBwrapProcessRunning()` call from sandbox log selection.
3. Remove the generic file-present poller unless it invokes the complete bound observation callback on every iteration.
4. Remove recursive `deepFreeze()` in favor of one iterative bounded traversal.
5. Remove independent alias/qualified/bare count maps as proof that a completion is usable; use resolver round trips.
6. Remove foreground coordination from non-log REPL commands.
7. Remove whole-file sandbox crash-log reads.
8. Remove Seatbelt pathname write access to the workspace logs directory.
9. Keep the existing hard cut: do not add legacy no-wait/sandbox probing or migration.
10. Do not add a current-log index, new registry field, persisted cancellation state, public Box option, runtime discovery fallback, or post-`running` retry.
11. Do not change the OCI registry lifecycle or ownership schema; the current immutable-ID proof is sufficient when the exact current record passes it.
12. Do not add Dashboard agent selection as part of this repair.

## 19. Definition of Done

The remediation is complete only when all of the following are true:

1. A slow exact no-wait worker can be tailed before its runtime exists.
2. The startup descriptor cannot belong to a predecessor or successor run.
3. Handoff occurs once and only after final marker, registry tuple, source identity, and runtime ownership checks.
4. An initial stale no-wait status cannot outrank a valid finalized runtime; a followed failed/superseded run cannot fall back to one.
5. Docker/Podman logs use only the persisted immutable ID after full ownership proof, for running and stopped containers.
6. Bubblewrap/Seatbelt selection is read-only, while producers cannot escape the workspace, overwrite an identity file, or orphan a pre-commit child.
7. Every completion/diagnostic reference resolves to the intended record; an agent named `router` remains reachable only through a non-reserved unambiguous spelling.
8. Registry/marker/status reads and diagnostics have explicit byte/complexity limits.
9. File and runtime streaming honor backpressure and remain constant-memory.
10. Direct Core, REPL, Box, and runtime child signal paths have bounded cleanup and exact exit-code tests.
11. The logs path creates or mutates no workspace/runtime state in positive, stale, corrupt, and error cases.
12. All focused checks pass, `git diff --check` is clean, unrelated changes remain intact, and no full-suite/deployment action was taken.

## 20. Implementation Handoff

When implementation is finished, report:

1. the files changed for each task;
2. the exact focused commands run and their pass/fail counts;
3. any platform-gated process-identity result on Linux/macOS;
4. whether the opt-in real Box cancellation check was run or explicitly deferred;
5. confirmation that no full suite, workspace creation/repair, deploy, commit, push, or unrelated cleanup occurred;
6. the final `git status --short --branch` so existing user changes remain visible.
