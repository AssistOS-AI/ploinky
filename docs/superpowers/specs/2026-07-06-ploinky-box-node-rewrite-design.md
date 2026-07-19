# ploinky-box: Rewrite Wrapper Tooling in Node (.mjs) — Design

Date: 2026-07-06
Status: Draft (autonomous brainstorming session; decisions flagged for user review)
Supersedes: the "Wrapper form: single-file bash" decision in
`docs/superpowers/specs/2026-07-03-ploinky-box-container-wrapper-design.md` §2.
Everything else in that spec (isolation contract, image, runtime behavior,
error policy) remains authoritative and is **not** re-decided here.

## 1. Purpose and context

Rewrite the ploinky-box wrapper tooling from bash to Node ES modules:

| Today (bash) | After (Node) |
| --- | --- |
| `container/ploinky-box` — 343-line bash program | `container/ploinky-box` — ~12-line bash shim that execs `node ploinky-box.mjs "$@"` |
| — | `container/ploinky-box.mjs` — the full program, self-contained, zero npm deps |
| `container/wrapper-tests.sh` — grep-based dry-run tests, wired into nothing | `container/wrapper-tests.mjs` — `node:test` port + new import-level unit tests; auto-discovered by the repo unit suite via a one-line `tests/unit/ploinkyBoxWrapper.test.mjs` shim |
| `container/smoke-box.sh` — engine-backed E2E smoke | `container/smoke-box.mjs` — same steps, same PASS/FAIL contract |

This is a **rewrite, not a redesign**: the CLI surface (commands, flags, env
vars), the engine command lines it produces, user-facing messages, exit codes,
and the isolation contract stay identical. Behavior parity is the acceptance
bar (§8).

### The one real trade-off: hosts now need Node

The 2026-07-03 design's distribution promise was "host needs nothing but
podman or docker" — a single curl-able bash file. Moving the program to Node
**adds Node ≥ 20 as a host requirement** and makes distribution two files
(shim + `.mjs`). This is inherent to the request and accepted; it must be
stated loudly in `container/README.md` (host requirements + two-file curl
quick start). Compensating win: `status` and the smoke probe use Node's global
`fetch`, dropping the host `curl` dependency the bash version silently had.

### Evidence that shaped the design

| Fact | Evidence | Consequence |
| --- | --- | --- |
| Repo is ESM (`"type": "module"`), zero-dep philosophy for launchers | `package.json:6`; `bin/ploinky` | `.mjs` files, node builtins only |
| The bash→node shim pattern already exists in-repo | `bin/ploinky` resolves its dir via `readlink -f`, execs `node cli/index.js "$@"` | Shim follows the established precedent |
| Unit suite auto-discovers `tests/unit/*.test.{js,mjs,cjs}` and runs each with `node --test` | `tests/test_all.sh:192-205` | Wrapper tests join `npm test` for free (today `wrapper-tests.sh` is referenced by no runner or workflow — verified by repo-wide `rg`) |
| Wrapper tests are engine-free by design (`--dry-run` seam prints the engine command) | `container/wrapper-tests.sh:2-3,32` | Port keeps spawning the real `container/ploinky-box` entrypoint, so the tests stay implementation-agnostic (they pass against the bash version *before* the swap and the Node version after — used as the migration gate) |
| Only 7 files in the repo mention `ploinky-box`/`wrapper-tests`/`smoke-box`: the three scripts, `container/README.md`, the two 2026-07-03 superpowers docs, `tests/unit/containerRuntime.test.mjs` | `rg -l` sweep | Closed touchpoint set; `containerRuntime.test.mjs` only concerns in-box `PLOINKY_BOX=1` behavior — unaffected |
| The box image entrypoint is a *different* file in a *different* repo | `container-image-builds/images/ploinky-box/entrypoint.sh` | Out of scope; it runs inside the image where bash is guaranteed |

## 2. Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Program shape | **One** self-contained `ploinky-box.mjs` (Approach A, §3) | Preserves curl-ability (2 files total); ~500 LOC fits one file; no build step |
| Shim contract | Bash ≥ 3.2, resolves own dir, checks `node` exists with a friendly install pointer, `exec node "$DIR/ploinky-box.mjs" "$@"` | Same UX/filename as today; `bin/ploinky` precedent; graceful "node missing" diagnostics that a node shebang cannot give |
| Node floor | ≥ 20, enforced inside the `.mjs` (die with message), not in the shim | Global `fetch` needs 18+; 18 is EOL; keep the shim dumb |
| CLI parsing | Hand-rolled port of the bash greedy-flag loop, including its quirks | Exact parity beats elegance; `util.parseArgs` cannot reproduce flags-after-command semantics |
| Dry-run output | Byte-identical `DRY-RUN: <engine> <args space-joined>` | Existing tests grep it with `-F`; it is the parity seam |
| Test home | Source of truth `container/wrapper-tests.mjs` (works standalone: `node container/wrapper-tests.mjs`); thin `tests/unit/ploinkyBoxWrapper.test.mjs` doing `import '../../container/wrapper-tests.mjs'` | Keeps container/ self-contained *and* wires the tests into the repo suite — fixing the current "wired into nothing" gap |
| Testability upgrade | `ploinky-box.mjs` exports its pure functions (`parseCli`, `buildRunArgs`, `mapCpPath`, …) behind a main-module guard | The bash version could only be tested by spawning; imports enable direct unit tests |
| Behavior changes | **None** for supported command behavior, except: node-missing (new, shim), node-too-old (new, .mjs), cleaner missing-value flag diagnostics, and the documented `--mount` symlink path micro-divergence in §5 | Rewrite discipline; accepted divergences are documented so parity reviews do not treat them as accidents |

## 3. Approaches considered

| | Approach | Verdict |
| --- | --- | --- |
| A | Single self-contained `.mjs` + tiny bash shim | **Recommended.** 2-file distribution, importable internals, no build step |
| B | `container/lib/*.mjs` multi-module split | Rejected: breaks curl-onto-bare-host distribution (N files) or forces a bundling step; the program is too small to justify it (YAGNI) |
| C | No shim; `#!/usr/bin/env node` shebang on the `.mjs` only | Rejected as the *entry* story: the user explicitly wants the small `.sh` launcher, and the shim delivers a clear diagnostic when node is absent. Partially adopted: the `.mjs` still gets shebang + exec bit, so `./ploinky-box.mjs` works for node-savvy users |

## 4. File inventory after the change

| Path | State | Notes |
| --- | --- | --- |
| `container/ploinky-box` | rewritten (shrinks ~343 → ~12 lines) | bash shim, `+x`, macOS bash-3.2-safe |
| `container/ploinky-box.mjs` | new | the program; `+x`, node shebang, exports for tests |
| `container/wrapper-tests.mjs` | new | `node:test`; replaces `wrapper-tests.sh` |
| `container/smoke-box.mjs` | new | replaces `smoke-box.sh` |
| `tests/unit/ploinkyBoxWrapper.test.mjs` | new | one-line import shim for suite auto-discovery |
| `container/wrapper-tests.sh`, `container/smoke-box.sh` | deleted | after their ports are green |
| `container/README.md` | updated | two-file curl, Node ≥ 20 host requirement, curl-no-longer-needed note |

## 5. Component design — `ploinky-box.mjs`

Single file, four internal layers, 1:1 with the bash structure. Only node
builtins: `node:child_process`, `node:net`, `node:fs`, `node:path`,
`node:readline`, `node:url`, `node:process`, global `fetch`.

| Layer | Exports (tested by import) | Bash counterpart |
| --- | --- | --- |
| CLI | `parseCli(argv)` → `{command, args, name, port, image, mountDir, engine, listenLan, dryRun, publish[], webmeetPorts}`; `usage()` heredoc verbatim | lines 22-90 |
| Engine | `detectEngine(cfg)`, `preflight(cfg)`, `runEngine(cfg, args, opts)` (dry-run aware, stdio inherit), `queryEngine(cfg, args)` (captured, never dry-run — mirrors bash's direct `"$ENGINE"` calls), `engineSelinuxEnabled(cfg)` | `detect_engine`, `preflight`, `engine()`, direct calls, `engine_selinux_enabled` |
| Model | `instanceName(cfg)`, `volumeNames(cfg)`, `buildRunArgs(cfg, {selinux})` (pure, returns the argv array), `mapCpPath(side, instance)` | lines 88-90, `build_run_args`, `cmd_cp` prefix logic |
| Commands | `cmdUp/cmdCli/cmdRun/cmdCp/cmdStatus/cmdLogs/cmdStop/cmdUpdate/cmdDestroy` + helpers `boxExists`, `boxRunning`, `hostPort`, `waitHealthy`, `gracefulPloinkyStop`, `portInUse`, `confirm` | `cmd_*` + helpers |

Main-module guard compares `import.meta.url` to `process.argv[1]` and its
`fs.realpathSync()` target, so imports have zero side effects while direct
execution through a symlink still runs the CLI.

### Parity contract (the load-bearing details)

| Bash behavior | Node port |
| --- | --- |
| Greedy flag scan: flags recognized anywhere in argv, first non-flag = command, rest = args (so wrapper flags after `run` are still eaten — existing quirk, preserved) | same loop, same order, same missing/empty value semantics; accepted diagnostic cleanup: Node prints `ploinky-box: --X needs a value` instead of bash's `${2:?}` shell diagnostic |
| `die()` → `ploinky-box: <msg>` on stderr, exit 1 | identical |
| `set -e` propagation: engine/child failures exit with the child's status (`run`, `cli`, `cp`, `pull`, …); signal death → 128+n | check `status`/`signal` from `spawnSync`/awaited spawn; `process.exit(status)`; 128+signum on signal |
| Dry-run short-circuits: `preflight`, `require_running`, `box_running`/`box_exists` in `cmd_up`, SELinux query, `ensure_image`, `wait_healthy`, destroy confirmation, port-in-use probe | replicated per call site — this is what makes the dry-run matrix deterministic on engine-less machines |
| Forced engine + dry-run skips the binary-existence check (tests force both podman and docker names) | replicated |
| Engine auto-detect: probe `podman` then `docker` on PATH | PATH-scan `command -v` equivalent (`fs.accessSync(X_OK)` over `PATH` entries; macOS/Linux only — Windows already unsupported) |
| macOS preflight: podman → `podman machine inspect --format '{{.State}}'` must contain `running`; docker → `docker info` succeeds | `queryEngine` + same match, same remediation messages |
| SELinux: query the **engine** (`podman info '{{.Host.Security.SELinuxEnabled}}'` = `true`; docker `SecurityOptions` contains `selinux`), never client getenforce | identical commands via `queryEngine` |
| `/dev/tcp/127.0.0.1/PORT` connect test → die "port in use" | `net.connect` to `127.0.0.1:PORT`: connect → in use; `ECONNREFUSED`/timeout (500 ms) → free |
| `wait_healthy`: ≤ 30 × 1 s; running + logs contain `self-check OK` → OK; `exited` → dump logs, die "do NOT fall back to --privileged"; timeout → die with `$ENGINE logs` hint | identical loop, strings, and exit paths |
| Interactive `cli`: `exec -it -w /workspace <instance> p-cli` | spawn with `stdio: 'inherit'`; parent ignores SIGINT/SIGTERM while the child runs so the TTY session owns them; exit with child status |
| `cp` prefix: `${var/#box:/$INSTANCE:}` — **leading** `box:` only, one side must carry it | `startsWith('box:')` replace; same usage error |
| `logs`: `exec <instance> sh -lc 'tail -n 100 /workspace/.ploinky/logs/*.log 2>/dev/null || echo "no .ploinky logs yet"'` | verbatim argv |
| `graceful_ploinky_stop`: best-effort `exec -w /workspace <instance> timeout 30 ploinky stop`, output discarded, errors swallowed, only when running and not dry-run | identical |
| `status`: exit 1 when the box doesn't exist; router probe `/status` then `/health` on the published port | `fetch` with short timeout replaces host `curl` (host-dep removal, same output strings) |
| `destroy`: prompt `Remove container '%s' and volumes '%s' + '%s'? [y/N] `, read one line from stdin (works piped — the smoke pipes `y\n`), `y`/`Y` proceeds else `die "aborted"`; removals swallow errors | `readline` on stdin; identical strings |
| `--mount`: must exist, bind `$(cd DIR && pwd)` → `/workspace/mounted`, stderr WARNING about piercing isolation | `path.resolve()` + existence check. Micro-divergence: bash yields the *logical* path for symlinked dirs, `path.resolve` against node's physical cwd may differ (e.g. macOS `/tmp` vs `/private/tmp`); acceptable — engines resolve binds anyway; noted here so it is a decided divergence, not an accident |
| `usage()` help text | byte-identical heredoc |
| Env: `PLOINKY_BOX_ENGINE` respected; container env `-e PLOINKY_BOX=1 -e PLOINKY_WORKSPACE_ROOT=/workspace` and every other `build_run_args` flag in the same order | `buildRunArgs` returns the identical argv sequence |

## 6. The shim — `container/ploinky-box`

~12 lines, bash ≥ 3.2: shebang; resolve `SCRIPT_DIR` (`readlink -f` per the
`bin/ploinky` precedent, with `cd/dirname/pwd` fallback for old macOS
readlink); if `node` is not on PATH, print
`ploinky-box: node >= 20 is required (https://nodejs.org) — the box itself still only needs podman/docker`
to stderr and exit 1; `exec node "$SCRIPT_DIR/ploinky-box.mjs" "$@"`.
No other logic, ever — all behavior lives in the `.mjs`.

## 7. Testing design

| Level | What | How it runs |
| --- | --- | --- |
| Syntax | `bash -n` on the shim, `node --check` on each `.mjs` | inside `wrapper-tests.mjs` |
| Process-level parity (port of all ~30 existing checks) | spawn `container/ploinky-box` with `PLOINKY_BOX_ENGINE` + `--dry-run`, assert substrings — same matrix, same expected strings as `wrapper-tests.sh` | `node container/wrapper-tests.mjs` standalone, or via the unit suite |
| Import-level (new) | `parseCli` flag/quirk cases, `buildRunArgs` (selinux/mount/publish/webmeet ordering), `mapCpPath` | same file |
| Suite wiring | `tests/unit/ploinkyBoxWrapper.test.mjs` = `import '../../container/wrapper-tests.mjs'` | auto-discovered by `tests/test_all.sh` (`run_node_unit_tests`) |
| Golden parity diff (migration gate, run once during implementation) | capture the full dry-run matrix from `git show HEAD:container/ploinky-box` (old bash) vs the new shim+mjs; DRY-RUN lines must be byte-identical | scripted in the plan |
| E2E smoke | `node container/smoke-box.mjs` — same steps (`up`, enable, start, router probe ≤ 30 s, cp round-trip, stop, re-up, resume, optional `SMOKE_WS_AGENT`, destroy), same PASS/FAIL lines and exit code; spawns the **shim** so the full stack is exercised; `fetch` replaces curl, `mkdtemp` replaces mktemp, `input: 'y\n'` feeds destroy | manual, engine required (matches today) |

Test-ordering trick: `wrapper-tests.mjs` lands **first** and must pass against
the *current bash* `container/ploinky-box`; then the swap lands and the same
tests must stay green. The tests are the migration harness.

## 8. Acceptance criteria (runnable)

1. `node container/wrapper-tests.mjs` → exit 0, all checks PASS (covers syntax checks + full dry-run matrix + import-level tests).
2. `node --test tests/unit/ploinkyBoxWrapper.test.mjs` → pass (suite wiring works).
3. Golden diff: dry-run matrix output of old bash vs new shim+mjs — zero differences on `DRY-RUN:` lines (exact script in the plan).
4. `grep -rl '^#!/usr/bin/env bash' container/` → exactly `container/ploinky-box`; `wc -l < container/ploinky-box` ≤ 20.
5. `container/README.md` states Node ≥ 20 host requirement and two-file quick start.
6. Engine-gated (manual, when podman machine is available): `node container/smoke-box.mjs` → `== SMOKE PASSED ==`, exit 0.

## 9. Out of scope

`images/ploinky-box/entrypoint.sh` (container-image-builds repo — runs inside
the image where bash is guaranteed); `bin/*` launchers; the repo-wide
`tests/*.sh` harness; any wrapper behavior change or new feature (including
fixing the flags-after-command quirk — candidate follow-up, not this change);
Windows support.

## 10. Risks

| Risk | Mitigation |
| --- | --- |
| Subtle parity drift (quoting, ordering, exit codes) | Dry-run matrix is byte-compared against the old bash output (§8.3); non-dry-run paths are covered by the smoke |
| TTY behavior of `cli` under spawn differs from bash `exec` | `stdio: 'inherit'` + parent signal-ignore is the standard pattern (`bin/ploinky` runs the whole ploinky CLI this way today); verified in smoke by the interactive-adjacent `run` path, `cli` checked manually |
| Hosts without Node hit a wall | Shim prints a one-line remediation; README updated; this is the accepted trade-off of the rewrite |
| `readlink -f` absent on very old macOS | Shim carries the `cd/dirname/pwd` fallback |
