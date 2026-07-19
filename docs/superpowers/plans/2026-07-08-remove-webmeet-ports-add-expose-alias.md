# Remove WebMeet Ports and Add Expose Alias Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the boxed-runtime `--webmeet-ports` shortcut and make `--expose SPEC` behave as a repeatable alias for `--publish SPEC`.

**Architecture:** The live behavior is concentrated in `container/ploinky-box.mjs`: `parseCli()` owns wrapper flag recognition, `buildRunArgs()` emits engine `-p` arguments, `usageText()` documents both public and compatibility help, and `mergeBoxCfg()` combines outer `ploinky` flags with nested `ploinky box` flags. Tests live in `container/wrapper-tests.mjs` and are wired into `tests/unit/ploinkyBoxWrapper.test.mjs`; documentation for the user-facing flag surface lives in `container/README.md`.

**Tech Stack:** Node.js ESM, Node built-in `node:test`, bash entrypoint shims, podman/docker dry-run assertions.

---

## Codebase Findings

- `AGENTS.md` points to `CLAUDE.md`, but no `CLAUDE.md` exists in this checkout; `rg --files -g 'CLAUDE.md' -g 'AGENTS.md' -g '!node_modules'` only returned `AGENTS.md`.
- `--webmeet-ports` currently appears in live source only in `container/ploinky-box.mjs`, `container/wrapper-tests.mjs`, and `container/README.md` when excluding `node_modules`, `globalDeps`, and historical `docs/superpowers` files.
- `--publish` is already the generic data model: `parseCli()` appends values to `cfg.publish`, and `buildRunArgs()` emits each value as `-p SPEC`.
- The normal in-box Ploinky CLI already has a bare `expose` command for environment variables (`cli/index.js`, `cli/services/help.js`, `cli/services/commandRegistry.js`). The new flag is `--expose` at the wrapper layer, so it should not change the existing `expose` command.
- Baseline verification before this plan: `node container/wrapper-tests.mjs` passed with 79 tests.

## File Structure

| Path | Role | Planned Change |
| --- | --- | --- |
| `container/wrapper-tests.mjs` | Engine-free wrapper behavior tests | Update tests first: prove `--expose` accumulates with `--publish`, prove `--webmeet-ports` is no longer a wrapper shortcut, update usage assertions, and cover public-entrypoint post-command `--expose`. |
| `container/ploinky-box.mjs` | Boxed runtime CLI parser, help text, and engine arg builder | Remove `webmeetPorts` state and fixed LiveKit/TURN expansion; parse `--expose` exactly like `--publish` in both parser modes; document `--expose` in public and compatibility help. |
| `container/README.md` | User-facing boxed runtime docs | Replace WebMeet-specific shortcut docs with generic `--publish` / `--expose` port publishing docs. |
| `docs/superpowers/*` | Historical design and plan artifacts | Do not edit by default. Exclude from final removal grep unless the user explicitly wants archival docs rewritten. |

---

### Task 1: Write Failing Wrapper Tests

**Files:**
- Modify: `container/wrapper-tests.mjs`
- Test: `container/wrapper-tests.mjs`

- [x] **Step 1: Replace the existing publish/WebMeet process tests**

Replace the current `publish flag adds extra port` and `webmeet ports publish the LiveKit/TURN set` tests with:

```js
test('publish and expose flags add extra ports in order', () => {
    const { out } = boxRun(
        'podman',
        '--dry-run',
        '--publish', '127.0.0.1:7880:7880',
        '--expose', '127.0.0.1:7881:7881',
        'up',
    );
    checkIncludes(out, '-p 127.0.0.1:7880:7880', 'publish flag adds extra port');
    checkIncludes(out, '-p 127.0.0.1:7881:7881', 'expose flag aliases publish');
    assert.ok(
        out.indexOf('-p 127.0.0.1:7880:7880') < out.indexOf('-p 127.0.0.1:7881:7881'),
        'publish/expose port order is preserved',
    );
});

test('--webmeet-ports is no longer a wrapper flag', () => {
    const { out, status } = boxRun('podman', '--dry-run', '--webmeet-ports', 'up');
    assert.equal(status, 1, out);
    checkIncludes(
        out,
        "unknown command '--webmeet-ports' (see: ploinky-box --help)",
        'removed webmeet shortcut is not accepted as a wrapper flag',
    );
});
```

- [x] **Step 2: Update the parse-level publish test**

Replace the current `parseCli: repeatable --publish accumulates in order` test with:

```js
test('parseCli: repeatable --publish and --expose accumulate in order', () => {
    const cfg = parseCli(['--publish', 'a:1:1', '--expose', 'b:2:2', '--publish', 'c:3:3', 'up'], {});
    assert.deepEqual(cfg.publish, ['a:1:1', 'b:2:2', 'c:3:3']);
    assert.equal(Object.hasOwn(cfg, 'webmeetPorts'), false);
});
```

- [x] **Step 3: Update usage assertions**

Replace the `usage text still documents every command and flag` test body with:

```js
test('usage text still documents every command and flag', () => {
    const u = usageText();
    for (const word of ['up', 'start', 'cli', 'run', 'cp', 'status', 'logs', 'stop', 'update', 'destroy',
        '--name', '--port', '--publish', '--expose', '--image', '--mount',
        '--listen-lan', '--engine', '--dry-run']) {
        assert.ok(u.includes(word), `usage() lost mention of ${word}`);
    }
    assert.ok(!u.includes('--webmeet-ports'), 'usage() still documents removed --webmeet-ports flag');
});
```

- [x] **Step 4: Extend public usage assertions**

Add these assertions inside `public usage describes ploinky and box namespace`, after the existing `ploinky box status` assertion:

```js
    assert.ok(r.stdout.includes('--expose SPEC'), r.stdout);
    assert.ok(!r.stdout.includes('--webmeet-ports'), r.stdout);
```

- [x] **Step 5: Extend public parser flag-hoisting coverage**

Replace `public parser hoists box selector flags after the command` with:

```js
test('public parser hoists box selector flags after the command', () => {
    const cfg = parseCli(['destroy', '--name', 'qa', '--expose', '127.0.0.1:9090:9090'], {}, { publicEntrypoint: true });
    assert.equal(cfg.command, 'destroy');
    assert.equal(cfg.name, 'qa');
    assert.deepEqual(cfg.publish, ['127.0.0.1:9090:9090']);
    assert.deepEqual(cfg.args, []);
});
```

- [x] **Step 6: Add process-level public `--expose` coverage**

Add this test near the other public command routing tests:

```js
test('public command hoists --expose after the command without forwarding it in-box', () => {
    const { out, status } = publicRun('podman', '--name', 'qa', '--dry-run', 'status', '--expose', '127.0.0.1:9090:9090');
    assert.equal(status, 0, out);
    checkIncludes(out, '-p 127.0.0.1:9090:9090', 'public post-command --expose publishes an outer box port');
    checkIncludes(out, 'exec -w /workspace ploinky-box-qa ploinky status', 'public status still runs in-box status');
    checkAbsent(out, 'ploinky status --expose 127.0.0.1:9090:9090', 'post-command --expose is not forwarded in-box');
});
```

- [x] **Step 7: Run the narrow test and verify it fails for the right reason**

Run:

```bash
node container/wrapper-tests.mjs
```

Expected before implementation: failures mention `--expose` not being recognized/hoisted and `--webmeet-ports` still being accepted. Stop if failures are unrelated syntax errors or unrelated baseline failures.

---

### Task 2: Implement Parser, Help, and Runtime Changes

**Files:**
- Modify: `container/ploinky-box.mjs`
- Test: `container/wrapper-tests.mjs`

- [x] **Step 1: Update both help text blocks**

In both `usageText()` branches, replace:

```text
  --publish SPEC Extra host-to-box port publish; repeatable, same form as -p.
  --webmeet-ports
                 Publish local LiveKit/TURN ports used by WebMeet rooms/media.
```

with:

```text
  --publish SPEC Extra host-to-box port publish; repeatable, same form as -p.
  --expose SPEC  Alias for --publish; repeatable.
```

- [x] **Step 2: Remove `webmeetPorts` from parsed config**

In the `cfg` object inside `parseCli()`, remove this property:

```js
        webmeetPorts: false,
```

- [x] **Step 3: Parse `--expose` like `--publish` before and after public commands**

In both parser switch statements, replace the current `--publish` and `--webmeet-ports` cases:

```js
                case '--publish': cfg.publish.push(need('--publish')); break;
                case '--webmeet-ports': cfg.webmeetPorts = true; i += 1; break;
```

and:

```js
            case '--publish': cfg.publish.push(need('--publish')); break;
            case '--webmeet-ports': cfg.webmeetPorts = true; i += 1; break;
```

with:

```js
                case '--publish':
                case '--expose':
                    cfg.publish.push(need(tok));
                    break;
```

and:

```js
            case '--publish':
            case '--expose':
                cfg.publish.push(need(tok));
                break;
```

- [x] **Step 4: Remove fixed WebMeet port expansion**

In `buildRunArgs()`, delete this block completely:

```js
    if (cfg.webmeetPorts) {
        args.push(
            '-p', `${bindIp}:7880:7880`,
            '-p', `${bindIp}:7881:7881`,
            '-p', `${bindIp}:7882-7892:7882-7892/udp`,
            '-p', `${bindIp}:3478:3478/tcp`,
            '-p', `${bindIp}:3478:3478/udp`,
            '-p', `${bindIp}:20000-20010:20000-20010/udp`,
        );
    }
```

- [x] **Step 5: Remove merged WebMeet state**

In `mergeBoxCfg()`, remove:

```js
        webmeetPorts: inner.webmeetPorts || outer.webmeetPorts,
```

- [x] **Step 6: Run the wrapper tests**

Run:

```bash
node container/wrapper-tests.mjs
```

Expected after implementation: all wrapper tests pass.

---

### Task 3: Update User-Facing Box Documentation

**Files:**
- Modify: `container/README.md`
- Test: `container/wrapper-tests.mjs`

- [x] **Step 1: Rewrite the port publishing paragraph**

Replace:

```markdown
Other in-box ports are unreachable from the host unless you publish them when
creating the box. Use `--publish HOST:BOX` for a specific port, repeat it for
more ports, or use `--webmeet-ports` to publish the local LiveKit/TURN ports
needed by WebMeet rooms/media. Existing boxes keep their original port mappings;
run `ploinky-box update` with the same flags, or recreate the box, when you add
new published ports.
```

with:

```markdown
Other in-box ports are unreachable from the host unless you publish them when
creating the box. Use `--publish HOST:BOX` for a specific port, or use its alias
`--expose HOST:BOX`; repeat either flag for more ports. Existing boxes keep their
original port mappings; run `ploinky-box update` with the same flags, or recreate
the box, when you add new published ports.
```

- [x] **Step 2: Update the flag list**

Replace:

```markdown
directory basename), `--port N`, `--publish SPEC`, `--webmeet-ports`,
`--image I`, `--mount DIR`, `--listen-lan`,
```

with:

```markdown
directory basename), `--port N`, `--publish SPEC`, `--expose SPEC`,
`--image I`, `--mount DIR`, `--listen-lan`,
```

- [x] **Step 3: Run the wrapper tests again**

Run:

```bash
node container/wrapper-tests.mjs
```

Expected: all tests pass, including the existing `docs describe boxed-by-default ploinky and the host-mounted core` test.

---

### Task 4: Final Verification and Cleanup Scan

**Files:**
- Inspect: `container/ploinky-box.mjs`
- Inspect: `container/wrapper-tests.mjs`
- Inspect: `container/README.md`

- [x] **Step 1: Verify the unit-suite shim still passes**

Run:

```bash
node --test tests/unit/ploinkyBoxWrapper.test.mjs
```

Expected: all tests registered by `container/wrapper-tests.mjs` pass through the unit shim.

- [x] **Step 2: Verify removed implementation is gone and rejection guard is intentional**

Run:

```bash
rg -n --glob '!node_modules/**' --glob '!globalDeps/**' --glob '!docs/superpowers/**' -- "webmeetPorts|7882-7892|3478:3478|20000-20010|LiveKit|TURN|WebMeet" container/ploinky-box.mjs container/README.md
```

Expected: no output. `--webmeet-ports` remains only as an intentional rejection sentinel in `container/ploinky-box.mjs` and in regression assertions inside `container/wrapper-tests.mjs`.

- [x] **Step 3: Verify `--expose` is present only in intended live files**

Run:

```bash
rg -n --glob '!node_modules/**' --glob '!globalDeps/**' --glob '!docs/superpowers/**' -- "--expose" .
```

Expected output is limited to:

```text
container/ploinky-box.mjs
container/wrapper-tests.mjs
container/README.md
```

The exact line numbers will vary.

- [x] **Step 4: Review the final diff**

Run:

```bash
git diff -- container/ploinky-box.mjs container/wrapper-tests.mjs container/README.md
```

Expected:
- `--webmeet-ports` is removed from user-facing docs and port-publishing behavior, remaining only as an explicit rejection guard and regression-test input.
- `webmeetPorts` state and fixed WebMeet/TURN port expansion are removed.
- `--expose` is parsed as an alias for `--publish`.
- No changes touch the in-box bare `expose` environment-variable command.
- Historical `docs/superpowers/*` files are unchanged.

- [x] **Step 5: Optional broader test gate**

If time permits before merging, run:

```bash
node --test tests/unit/*.test.mjs tests/unit/*.test.js
```

Expected: the full Node unit suite passes. If unrelated tests fail, capture their names and compare against the pre-change baseline before changing implementation scope.

---

## Self-Review

- Spec coverage: The plan removes the live `--webmeet-ports` parser state, runtime expansion, positive tests, and docs; it keeps only an explicit rejection guard and regression tests while adding `--expose` as a parser-level alias to `--publish` in both wrapper parser modes.
- Placeholder scan: No `TBD`, `TODO`, or deferred implementation steps remain.
- Type/name consistency: The plan consistently uses existing `cfg.publish` and removes `cfg.webmeetPorts`; it does not introduce a second data model for exposed ports.
- Scope check: The existing bare `expose` CLI command is deliberately out of scope and must remain unchanged.

## Implementation Addendum

- Independent verification found one additional removal gap: public top-level commands such as `ploinky status --webmeet-ports` no longer hoisted the flag, but still forwarded it in-box.
- The final implementation rejects removed wrapper flags before public top-level forwarding, while nested `ploinky box ... --webmeet-ports` continues to report `ploinky box --help`.
- Regression coverage now includes leading and trailing public top-level `--webmeet-ports` positions.
