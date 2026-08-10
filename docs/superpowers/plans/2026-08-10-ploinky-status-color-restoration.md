# Ploinky Status Color Restoration Implementation Plan

Date: 2026-08-10

Audience: Claude Code implementing the change in `/Users/danielsava/work/file-parser/ploinky`

Status: Ready for implementation against the current dirty worktree

## 1. Start Here

Before editing anything:

1. Read the repository-root `AGENTS.md` and the complete canonical `CLAUDE.md`.
2. Treat current executable code and tests as the source of truth. Historical specifications and generated HTML are not behavioral authority and must not be edited for this task.
3. Preserve every unrelated user change in the dirty worktree. Do not reset, revert, clean, stash, or overwrite them.
4. Work only in `/Users/danielsava/work/file-parser/ploinky`.
5. Inspect the current diffs before editing the three overlapping files:

   ```sh
   git diff -- ploinky-box/bin/ploinky-box.mjs \
     ploinky-box/command/execute.mjs \
     tests/unit/ploinkyBoxCli.test.mjs
   ```

   Those files already contain in-progress log-streaming work. Integrate with it; do not replace it with `HEAD` versions.
6. Do not deploy Explorer or run the cross-repository Playwright acceptance gate. The user requested the status-color fix, not deployment or cross-repository E2E validation.
7. Do not add dependencies, alter the public CLI grammar, change status content, or broaden this into a general CLI color refactor.
8. Do not commit, push, or open a pull request unless separately requested.

## 2. Goal

Restore the historical colors of `ploinky status` when it is invoked from a real terminal through the managed outer Box, while preserving clean plain-text output when stdout is redirected or piped.

The result must satisfy all three operator cases:

| Invocation context | Required result |
|---|---|
| `ploinky status` in a real terminal | Historical ANSI colors and gray `•` bullets |
| `ploinky status | cat` or redirected stdout | No ANSI escape sequences and `-` bullets |
| `NO_COLOR=1 ploinky status` | No ANSI escape sequences and `-` bullets, even in a terminal |

This is a terminal-capability propagation fix. It is not a palette redesign.

## 3. Confirmed Cause

Before the `ploinky-proxy` integration, `bin/ploinky` launched `cli/index.js` directly. The status renderer therefore observed the host terminal through `process.stdout.isTTY`.

After the integration, public status follows this path:

```text
bin/ploinky
  -> ploinky-box/bin/ploinky-box.mjs
  -> podman/docker container exec
  -> /opt/ploinky/bin/ploinky-local status
  -> cli/index.js
  -> cli/utils/status.js
```

The outer status route intentionally does not request `--interactive` or `--tty`. Consequently, the in-Box Node process sees `process.stdout.isTTY === false`, even when the outer `ploinky` process is writing to a real terminal.

`cli/utils/status.js` currently enables colors only when:

```js
Boolean(process.stdout.isTTY) && !process.env.NO_COLOR
```

It also chooses the bullet from the same boolean:

```js
const bulletSymbol = supportsColor ? grayBullet : '-';
```

The all-white output and `-` bullets are therefore the expected fallback for the lost TTY signal. The palette itself was not removed by the proxy merge.

## 4. Required Behavior and Invariants

### 4.1 Color policy

Use one internal, process-scoped environment marker:

```text
PLOINKY_COLOR=1
```

The marker means: the trusted outer CLI has already determined that stdout is a real terminal and the operator did not disable colors.

The status renderer enables colors exactly when:

```text
NO_COLOR is not a non-empty value
AND
(in-Box stdout is a TTY OR PLOINKY_COLOR is exactly "1")
```

Rules:

1. `NO_COLOR` wins over both a direct TTY and `PLOINKY_COLOR=1`.
2. Match the current truthy/non-empty `NO_COLOR` behavior; do not change unrelated `NO_COLOR` semantics in this task.
3. Accept only the exact marker value `1`. Values such as `true`, `yes`, or arbitrary host input must not enable colors.
4. The outer CLI derives the marker from `output.isTTY` and `env.NO_COLOR`; it must not forward a host-supplied `PLOINKY_COLOR` value blindly.
5. Do not persist this marker in Box configuration, workspace state, runtime registries, logs, or generated files. It belongs only to the one `container exec` process.

### 4.2 Historical palette

Do not change the existing ANSI table or status formatting. Preserve these mappings from `cli/utils/status.js`:

| Element | Existing style to preserve |
|---|---|
| `Workspace status:` and `Agent runtimes:` | bold cyan |
| labels such as `SSO`, `Router`, `agent`, `repo`, `image`, `created`, `cwd`, `binds`, `env`, and `ports` | dim |
| repository and runtime names | cyan |
| `running`, `enabled`, and listening state | green |
| `exited`, disabled/error state | red |
| `paused`, `restarting`, `stopped`, and other fallback states | yellow |
| `created` and `agents` badges | blue |
| agent/repo values and `skills` badges | magenta |
| runtime badges, PID/endpoint metadata, and bullets | gray |
| `mixed` badges | yellow |
| unknown badges | gray |

Do not “correct” or reinterpret any status-to-color mapping as part of this work. The goal is to make the surviving palette visible again.

### 4.3 Runtime and security invariants

1. Status remains read-only and continues to use `inspectBoxStatus()` without preparing, repairing, creating, restarting, or mutating the Box.
2. Preserve exact exit-code forwarding and the current Box-summary fallback when the core status renderer fails.
3. Do not allocate a pseudo-terminal for status. In particular, do not add `--tty` or `--interactive`.
4. Do not alter the log-streaming `--interactive` behavior or `PLOINKY_BOX_LOG_STREAM=1` marker already being developed in the dirty worktree.
5. Do not copy the host environment into the Box. Add only the derived literal `PLOINKY_COLOR=1` argument when policy allows it.
6. Do not change Router/media port forwarding, user selection, working directory, container identity, or the fixed `/opt/ploinky/bin/ploinky-local` target.
7. Keep pipe and redirected output machine-friendly: no ANSI escapes, no carriage-return behavior introduced by a PTY, and no Unicode bullet in plain mode.

## 5. Files in Scope

| File | Required change |
|---|---|
| `ploinky-box/bin/ploinky-box.mjs` | Derive terminal color intent for the running status route and pass it to the exec-argument builder. |
| `ploinky-box/command/execute.mjs` | Add a non-interactive `colorOutput` option that emits `--env PLOINKY_COLOR=1` only when true. |
| `cli/utils/status.js` | Honor the exact internal marker while keeping `NO_COLOR` authoritative. |
| `tests/unit/ploinkyBoxCli.test.mjs` | Cover outer TTY propagation, non-TTY suppression, `NO_COLOR`, host-marker non-forwarding, and absence of TTY allocation. |
| `tests/unit/cliStatusEntrypoint.test.mjs` | Cover colored renderer output and both plain-output cases in fresh child processes. |
| `tests/e2e/ploinkyBox/statusCommand.test.mjs` | Make the existing captured/non-TTY contract explicit by asserting that output contains no ANSI escapes. |
| `tests/unit/ploinkyBoxSafetyMatrix.test.mjs` | No expected code edit unless needed; run it to prove the new fixed literal does not weaken host-environment confinement. |

No other production file should be needed. In particular, do not edit `bin/ploinky`, `cli/index.js`, `cli/main.js`, `cli/utils/utils.js`, command routing, Box supervision, or generated documentation.

## 6. Implementation Sequence

### Task 0: Record the baseline without disturbing the worktree

- [ ] Record the current revision and target-file state:

  ```sh
  git rev-parse HEAD
  git status --short
  git diff --check
  ```

- [ ] Run the focused tests before adding new assertions:

  ```sh
  node --test \
    tests/unit/cliStatusEntrypoint.test.mjs \
    tests/unit/ploinkyBoxCli.test.mjs \
    tests/unit/ploinkyBoxSafetyMatrix.test.mjs
  ```

- [ ] If an existing test already fails because of unrelated dirty work, record the exact failure and continue only if the status-color work can remain isolated. Do not fix unrelated log-streaming failures under this plan.

### Task 1: Add failing outer-boundary tests first

Edit `tests/unit/ploinkyBoxCli.test.mjs` without discarding its current log-streaming additions.

- [ ] Keep the existing test proving that running status uses the read-only renderer without preparing the Box.
- [ ] Add a focused table-driven test for a running initialized Box with these cases:

  | Outer output | Outer environment | Expected exec marker |
  |---|---|---|
  | `isTTY: true` | no `NO_COLOR` | `PLOINKY_COLOR=1` present exactly once |
  | `isTTY: false` | no `NO_COLOR` | marker absent |
  | `isTTY: true` | `NO_COLOR=1` | marker absent |
  | `isTTY: false` | host already contains `PLOINKY_COLOR=1` | marker absent |

- [ ] For every case, assert all existing status-route invariants:
  - `inspectBoxStatus()` is called;
  - `prepareBoxForCommand()` is not called;
  - the command ends with `/opt/ploinky/bin/ploinky-local`, `status`;
  - `--tty` is absent;
  - `--interactive` is absent;
  - the core exit code is returned unchanged.
- [ ] Add a direct `buildContainerExecArgs()` assertion showing that `colorOutput: true` adds the pair `--env`, `PLOINKY_COLOR=1` without adding either TTY flag.
- [ ] Confirm the new test fails because color intent is not yet emitted, not because of an unrelated assertion.

Suggested assertion helper, if useful:

```js
function execEnvAssignments(args) {
    const values = [];
    for (let index = 0; index < args.length - 1; index += 1) {
        if (args[index] === '--env') values.push(args[index + 1]);
    }
    return values;
}
```

Do not assert fragile full-array equality after the fixed prefix; the existing log-streaming marker and future fixed internal markers may coexist. Assert the exact relevant assignments and the fixed command suffix.

### Task 2: Propagate explicit color intent across the Box boundary

Edit `ploinky-box/command/execute.mjs` carefully around the current `logStream` work.

- [ ] Add `colorOutput = false` to the `buildContainerExecArgs()` option object.
- [ ] When and only when `colorOutput === true`, add this exact container-exec pair before `--user`:

  ```js
  '--env', 'PLOINKY_COLOR=1'
  ```

- [ ] Preserve the current argument order for existing Router/media environment variables and `PLOINKY_BOX_LOG_STREAM=1`.
- [ ] Do not use the host value of `PLOINKY_COLOR`.
- [ ] Do not change the `logStream` or interactive conditional:

  ```js
  if (logStream) {
      args.push('--interactive');
  } else if (interactive && inputIsTty && outputIsTty) {
      args.push('--interactive', '--tty');
  }
  ```

Edit `ploinky-box/bin/ploinky-box.mjs`:

- [ ] Add `colorOutput = false` to the private `executePrepared()` options and forward it to `buildContainerExecArgs()`.
- [ ] In only the running initialized `status` branch, pass:

  ```js
  colorOutput: output.isTTY === true && !env.NO_COLOR,
  ```

- [ ] Do not set `interactive: true` for status.
- [ ] Do not add color intent to unavailable Box summaries, logs, update, start, shell, REPL, or generic forwarding in this task.
- [ ] Rerun `tests/unit/ploinkyBoxCli.test.mjs`; the new outer-boundary tests should pass.

### Task 3: Add failing renderer tests

Refactor the fixture in `tests/unit/cliStatusEntrypoint.test.mjs` only as much as needed to launch `cli/index.js status` repeatedly with controlled environments.

- [ ] Build each child environment from a fresh object.
- [ ] Explicitly remove inherited `NO_COLOR` and `PLOINKY_COLOR` before applying test overrides. This prevents the developer or CI shell from deciding test results.
- [ ] Continue launching a fresh Node child for each case. `supportsColor` is initialized when `status.js` is imported, so reusing one process would make environment changes unreliable.
- [ ] Preserve the existing tree hash before and after every invocation to prove status remains read-only.
- [ ] Add these cases:

  1. Captured stdout with no marker: plain output.
  2. Captured stdout with `PLOINKY_COLOR=1`: colored output.
  3. Captured stdout with both `PLOINKY_COLOR=1` and `NO_COLOR=1`: plain output.

- [ ] For plain output, assert:
  - no `\u001B[` sequence exists;
  - the expected status content remains present;
  - list bullets use `-`, not `•`.
- [ ] For colored output, assert representative exact historical sequences:

  ```text
  ESC[1m ESC[36m Workspace status: ESC[0m
  ESC[90m • ESC[0m
  ESC[36m ploinky_example ESC[0m
  ESC[33m [stopped] ESC[0m
  ESC[90m [podman] ESC[0m
  ```

  Express these as JavaScript strings or regular expressions containing `\u001B`; do not insert visually ambiguous literal escape bytes into the test source.
- [ ] Confirm the colored case fails before modifying `status.js`.

The test does not need to manufacture every runtime state. Exact representative assertions plus preservation of the unchanged ANSI/style tables are sufficient for this regression.

### Task 4: Make the status renderer honor trusted color intent

Edit only the color-capability expression near the top of `cli/utils/status.js`.

- [ ] Replace the current expression with logic equivalent to:

  ```js
  const supportsColor = !process.env.NO_COLOR
      && (Boolean(process.stdout.isTTY) || process.env.PLOINKY_COLOR === '1');
  ```

- [ ] Keep the strict `=== '1'` check.
- [ ] Keep `NO_COLOR` first and authoritative.
- [ ] Do not change `ANSI`, `styles`, `bulletSymbol`, output text, indentation, state mappings, repository badges, SSO rendering, Router probing, or runtime collection.
- [ ] Rerun `tests/unit/cliStatusEntrypoint.test.mjs`; all three color-policy cases and the read-only hash checks should pass.

### Task 5: Make the non-TTY end-to-end contract explicit

Edit `tests/e2e/ploinkyBox/statusCommand.test.mjs`.

The existing test launches `bin/ploinky status` with `spawnSync(..., { encoding: 'utf8' })`, so stdout is captured and is not a TTY.

- [ ] After the existing content assertions, add:

  ```js
  assert.doesNotMatch(status.stdout, /\u001B\[/);
  ```

- [ ] Do not force color in this test. Its purpose is to protect pipe/capture compatibility through the full public wrapper.
- [ ] Preserve all existing Box and workspace immutability hashes.

An actual PTY-based native test is not required for this scoped fix. The outer unit test proves marker propagation from a TTY-like output, the renderer child-process test proves marker consumption, and the native captured-output test proves the plain end-to-end case.

### Task 6: Run focused verification

- [ ] Run formatting/static whitespace validation:

  ```sh
  git diff --check
  ```

- [ ] Run the focused unit tests together:

  ```sh
  node --test \
    tests/unit/cliStatusEntrypoint.test.mjs \
    tests/unit/ploinkyBoxCli.test.mjs \
    tests/unit/ploinkyBoxSafetyMatrix.test.mjs
  ```

- [ ] Run the existing Box-native status test when its documented Podman candidate prerequisites are available:

  ```sh
  node --test tests/e2e/ploinkyBox/statusCommand.test.mjs
  ```

  If prerequisites are unavailable and the test skips, report it as not run; do not describe a skip as passing proof.

- [ ] Inspect the final scoped diff:

  ```sh
  git diff -- \
    ploinky-box/bin/ploinky-box.mjs \
    ploinky-box/command/execute.mjs \
    cli/utils/status.js \
    tests/unit/ploinkyBoxCli.test.mjs \
    tests/unit/cliStatusEntrypoint.test.mjs \
    tests/unit/ploinkyBoxSafetyMatrix.test.mjs \
    tests/e2e/ploinkyBox/statusCommand.test.mjs
  ```

- [ ] Confirm the final diff does not remove or weaken any pre-existing log-streaming changes.

### Task 7: Optional read-only manual validation

Only if an already running disposable workspace is available, run status there. Do not start, recreate, destroy, or deploy Explorer for this task.

- [ ] In a real terminal, run:

  ```sh
  ploinky status
  ```

  Visually confirm bold cyan section headers, colored state/badge fields, gray metadata, and gray `•` bullets.

- [ ] Confirm a pipe is plain:

  ```sh
  if ploinky status | LC_ALL=C grep -q $'\033'; then
    echo 'unexpected ANSI in piped output' >&2
    false
  fi
  ```

- [ ] Confirm `NO_COLOR` is plain:

  ```sh
  if NO_COLOR=1 ploinky status | LC_ALL=C grep -q $'\033'; then
    echo 'unexpected ANSI with NO_COLOR' >&2
    false
  fi
  ```

Because the two negative checks pipe stdout, they validate absence of ANSI but do not independently prove the `NO_COLOR`-while-TTY case; that case is covered by the unit tests.

## 7. Acceptance Criteria

Implementation is complete only when all of the following are true:

1. Public `ploinky status` emits the existing historical palette when the outer stdout is a TTY.
2. The visible list bullet changes back from `-` to gray `•` in colored mode.
3. Captured, redirected, and piped output contains no ANSI escape sequences and retains `-` bullets.
4. A non-empty `NO_COLOR` disables color even when the outer output is a TTY.
5. A host-supplied `PLOINKY_COLOR` is not blindly forwarded; only the outer policy decision can add the exact literal marker.
6. Status still receives neither `--tty` nor `--interactive`.
7. Status remains inspect-only and does not prepare or mutate the Box or workspace.
8. Existing exit codes, failure fallback, content, spacing, palette, and status mappings remain unchanged.
9. The active log-streaming edits in the dirty worktree remain intact.
10. `git diff --check` and the focused unit tests pass.
11. The native status test passes when its Podman prerequisites are available, or its absence is reported accurately.

## 8. Non-Goals

Do not do any of the following:

- allocate a PTY for status;
- always emit color from `status.js`;
- emit color into pipes or files;
- alter the historical colors or introduce a theme system;
- refactor every ANSI helper in the repository;
- add `chalk`, `kleur`, `supports-color`, or another dependency;
- propagate arbitrary host environment variables into the Box;
- change `ploinky status` text, sections, sorting, indentation, or runtime semantics;
- change the Box lifecycle or ownership model;
- fix unrelated log-streaming code or tests;
- update historical specifications or generated HTML;
- run the cross-repository Explorer/OnlyOffice/Copilot/WebMeet acceptance gate.

## 9. Handoff Report Expected from the Implementer

When finished, report:

1. The exact production and test files changed.
2. The resulting color-policy expression and how the outer marker is derived.
3. Confirmation that no PTY is allocated for status.
4. Focused test commands and pass/fail counts.
5. Whether the native Podman status test ran or was unavailable/skipped.
6. Whether manual terminal, pipe, and `NO_COLOR` checks were performed.
7. Any pre-existing failures or dirty-worktree conflicts that were intentionally left untouched.
