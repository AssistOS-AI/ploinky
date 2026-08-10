# Ploinky Box Host-Mounted Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop baking Ploinky source into `assistos/ploinky-box:podman-node24`; instead the wrapper bind-mounts the local host `ploinky` checkout read-only at `/opt/ploinky`, mounts a writable named volume at `/opt/ploinky/node_modules`, and the first in-box `ploinky` run detects missing dependencies and prompts to install them.

**Architecture:** Two repos change together. In `ploinky`, `container/ploinky-box.mjs` gains deterministic host-source resolution, two new mounts, a third named volume, and a first-run install flow; `bin/ploinky` becomes the single entry script — inside the box (detected by the image marker file `/etc/ploinky-box`) it runs the deps-gate plus direct CLI, on hosts it runs the boxed wrapper — and `bin/ploinky-direct` plus the `PLOINKY_BOX`/`PLOINKY_DIRECT` env vars are deleted outright. In `container-image-builds`, the ploinky-box Dockerfile becomes a runtime-tools-only image (Node 24, npm, git, podman, slirp4netns, plus the `/etc/ploinky-box` marker), the entrypoint self-check validates the mounted source instead of baked deps, and the publish workflow verifies the mount contract instead of baked contents.

**Tech Stack:** Node >= 20 (ESM, `node:test`), bash, podman/docker CLI, GitHub Actions, Dockerfile (quay.io/podman/stable base + node:24-bookworm-slim multi-stage copy).

**Revision v2 (2026-07-07):** per user decision, `bin/ploinky-direct` and the `PLOINKY_BOX` env var are removed with no backwards compatibility; the `PLOINKY_DIRECT` host escape is removed with them. In-box detection moves to the image-baked marker file `/etc/ploinky-box` (both for entry routing in `bin/ploinky` and for the named-network downgrade in `cli/services/docker/agentServiceManager.js`, which previously read `PLOINKY_BOX`).

**Revision v3 (2026-07-07):** addresses plan review findings: full-suite commands use explicit `tests/unit` globs, Docker deps-volume ownership repair is fatal and also runs for already-running boxes, public forwarded commands abort immediately after a declined dependency prompt, image verification checks `npx`, workflow temp volumes are cleaned up, and local smoke probes avoid tracked-file edits.

## Repos and branches

| Repo | Path | Branch to work on |
| --- | --- | --- |
| ploinky | `/Users/danielsava/work/file-parser/ploinky` | `ploinky-box` (current) |
| container-image-builds | `/Users/danielsava/work/file-parser/container-image-builds` | `main` (create feature branch `ploinky-box-host-mounted-core`) |

## Global Constraints

- Isolation contract is unchanged: never `--privileged`; the box runs `--user podman --device /dev/fuse --device /dev/net/tun --security-opt seccomp=unconfined` (`label=disable` only when the engine reports SELinux).
- The host Ploinky source is mounted **read-only** at `/opt/ploinky`. Nothing inside the box may write to it. Dependency installs write only to the named volume mounted at `/opt/ploinky/node_modules`.
- Required dependency check paths (exact): `/opt/ploinky/node_modules/achillesAgentLib` and `/opt/ploinky/node_modules/mcp-sdk`.
- The confirm prompt text is exactly: `Ploinky dependencies are not installed. Install them now? [y/N] ` (trailing space, capital N default).
- Decline/non-interactive warning must contain exactly the sentence: `Ploinky cannot run until dependencies are installed.` and the process must exit non-zero.
- Never install dependencies silently. Non-interactive contexts default to "no". The only non-prompt install paths are explicit user actions: running `bin/ploinky-install-deps` directly, or setting `PLOINKY_BOX_INSTALL_DEPS=1` on the wrapper.
- Install command (exact): `npm install --no-package-lock --no-audit --no-fund` run with cwd = the mounted Ploinky project root.
- **Removed with no backwards compatibility:** the file `bin/ploinky-direct`, the `PLOINKY_BOX` env var (wrapper stops injecting it; nothing reads it), and the `PLOINKY_DIRECT` env var (no host direct-mode escape). After this plan, `rg -n "PLOINKY_BOX([^_A-Z]|$)|PLOINKY_DIRECT|ploinky-direct" --glob '!node_modules' --glob '!docs/superpowers' --glob '!container/wrapper-tests.mjs' --glob '!docs/*.html' --glob '!docs/*.md' .` must return no hits in the ploinky repo (`container/wrapper-tests.mjs` may contain the strings only inside negative assertions that pin their absence; legacy prose under `docs/` is historical).
- In-box detection signal (exact): the marker file `/etc/ploinky-box`, baked by the image Dockerfile. `bin/ploinky` routes on it; `isPloinkyBoxRuntime()` in `cli/services/docker/agentServiceManager.js` stats it (test-injectable path). Host developers who want the CLI without the box run `node cli/index.js` from the checkout.
- Image name/tag stays `docker.io/assistos/ploinky-box:podman-node24`. `DEFAULT_IMAGE` in `container/ploinky-box.mjs` does not change.
- The image must keep: node, npm, npx, git, podman, slirp4netns, `ENV PATH=/opt/ploinky/bin:$PATH`, `ENV PLOINKY_WORKSPACE_ROOT=/workspace`, `USER podman`, `WORKDIR /workspace` — and now also `/etc/ploinky-box`.
- WebTTY: the box image bakes **no** webtty npm package because none is needed — `node-pty` ships inside the `docker.io/assistos/webtty-agent:node24` agent image (see `container-image-builds/images/webtty-agent/Dockerfile` and `basic/webtty/manifest.json`), which the box's *nested* podman pulls at runtime. The image keeps the runtime layer webtty needs (node + podman + slirp4netns) and the publish workflow gains an explicit best-effort webtty runtime check.
- Commit policy (workspace rule): no `Co-Authored-By`, no `Generated by`, no AI/tool attribution in any commit message, in either repo.
- Node engine floor stays `>=20.0.0` (`ploinky/package.json` `engines.node`). `ploinky/package.json` and `ploinky/globalDeps/package.json` need **no content changes** in this plan.

## Rollout order (read before executing)

A new wrapper against the **old** image fails at boot: the old entrypoint checks `/opt/ploinky/node_modules/achillesAgentLib`, and the new deps volume mounts an empty volume over the baked `node_modules`, so the box never reports healthy (the old image also lacks `/etc/ploinky-box`, so even a booted box would mis-route `ploinky` into the wrapper). An old wrapper against the **new** image also fails at boot ("ploinky source not mounted"), with a clear message. Therefore:

1. Implement and land both repos' changes (Tasks 1–10).
2. Build the new image locally and run the ploinky smoke against it (Task 11) before publishing.
3. Publish the new image (`gh workflow run publish-ploinky-box-image.yml`) **before** end users receive the new wrapper. Existing boxes keep running; newly created boxes need image + wrapper from the same generation. `ploinky box update` pulls the new image and recreates the box with the new mounts.

---

# Part 1 — ploinky repo

All paths in Part 1 are relative to `/Users/danielsava/work/file-parser/ploinky`.

### Task 1: Host source resolution, new mounts, deps volume, no more PLOINKY_BOX env

**Files:**
- Modify: `container/ploinky-box.mjs`
- Test: `container/wrapper-tests.mjs`

**Interfaces:**
- Consumes: existing exports `parseCli`, `buildRunArgs`, `volumeNames`, `instanceName` from `container/ploinky-box.mjs`.
- Produces: new export `resolveHostPloinkySource(env = process.env, scriptDir = HERE) -> string` (absolute path or `die()`); `volumeNames(cfg)` now returns `{ workspace, containers, deps }` where `deps = "<instance>-ploinky-deps"`; `buildRunArgs` emits `-v <source>:/opt/ploinky:ro` and `-v <deps>:/opt/ploinky/node_modules[:U]` (`:U` only when `cfg.engine === 'podman'`) and **no longer emits `-e PLOINKY_BOX=1`**. Task 2 relies on `cfg.sourceDirResolved` being set by `prepareSource(cfg)`.

- [ ] **Step 1: Write the failing tests**

Append to `container/wrapper-tests.mjs` (near the other buildRunArgs unit tests; `REPO_ROOT` goes next to the existing `HERE` constant at the top of the file):

```js
const REPO_ROOT = path.resolve(HERE, '..');
```

```js
test('resolveHostPloinkySource: PLOINKY_BOX_SOURCE override wins, defaults to the checkout', () => {
    assert.equal(resolveHostPloinkySource({}), REPO_ROOT);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-src-'));
    try {
        for (const marker of ['bin', 'cli', 'globalDeps']) fs.mkdirSync(path.join(tmp, marker));
        fs.writeFileSync(path.join(tmp, 'bin', 'ploinky'), '#!/usr/bin/env bash\n');
        fs.writeFileSync(path.join(tmp, 'cli', 'index.js'), '// stub\n');
        fs.writeFileSync(path.join(tmp, 'globalDeps', 'package.json'), '{}\n');
        assert.equal(resolveHostPloinkySource({ PLOINKY_BOX_SOURCE: tmp }), path.resolve(tmp));
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('up dies with guidance when PLOINKY_BOX_SOURCE is not a ploinky checkout', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-notsrc-'));
    try {
        const r = spawnSync(BOX, ['--name', 'qa', '--dry-run', 'up'], {
            encoding: 'utf8',
            env: { ...process.env, PLOINKY_BOX_ENGINE: 'podman', PLOINKY_BOX_SOURCE: tmp },
        });
        const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
        assert.equal(r.status, 1, out);
        checkIncludes(out, 'ploinky source not found', 'invalid source dies');
        checkIncludes(out, 'PLOINKY_BOX_SOURCE', 'error names the escape hatch');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('volume naming includes the deps volume', () => {
    const named = parseCli(['--name', 'qa', 'up'], {});
    assert.deepEqual(volumeNames(named), {
        workspace: 'ploinky-box-qa-workspace',
        containers: 'ploinky-box-qa-containers',
        deps: 'ploinky-box-qa-ploinky-deps',
    });
});

test('buildRunArgs: read-only source mount plus writable deps volume', () => {
    const podmanCfg = parseCli(['--engine', 'podman', 'up'], {});
    const podmanArgs = buildRunArgs(podmanCfg, { selinux: false }).join(' ');
    assert.ok(podmanArgs.includes(`-v ${REPO_ROOT}:/opt/ploinky:ro`), podmanArgs);
    assert.ok(podmanArgs.includes('-ploinky-deps:/opt/ploinky/node_modules:U'), podmanArgs);
    assert.ok(!podmanArgs.includes('/workspace:ro'), 'workspace stays writable');
    assert.ok(!podmanArgs.includes('PLOINKY_BOX='), 'no PLOINKY_BOX env injection');

    const dockerCfg = parseCli(['--engine', 'docker', 'up'], {});
    const dockerArgs = buildRunArgs(dockerCfg, { selinux: false }).join(' ');
    assert.ok(dockerArgs.includes('-ploinky-deps:/opt/ploinky/node_modules '), dockerArgs);
    assert.ok(!dockerArgs.includes(':U'), 'docker gets no :U volume option');
});
```

In the existing `inferred up: cwd basename drives names; isolation contract holds` test, **replace** the line

```js
        checkIncludes(out, '-e PLOINKY_BOX=1', 'inferred up marks box runtime');
```

with:

```js
        checkIncludes(out, `-v ${path.resolve(HERE, '..')}:/opt/ploinky:ro`, 'inferred up mounts the host checkout read-only');
        checkIncludes(out, 'ploinky-box-testExplorerFresh-ploinky-deps:/opt/ploinky/node_modules:U', 'inferred up mounts the writable deps volume');
        checkAbsent(out, 'PLOINKY_BOX=', 'in-box routing uses the image marker file, not an env var');
```

Extend the existing `destroy targets the inferred instance and says so` test:

```js
        checkIncludes(out, 'volume rm ploinky-box-testExplorerFresh-workspace ploinky-box-testExplorerFresh-containers ploinky-box-testExplorerFresh-ploinky-deps', 'destroy removes all three volumes');
```

Add `resolveHostPloinkySource` to the existing import block from `./ploinky-box.mjs`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/danielsava/work/file-parser/ploinky && node container/wrapper-tests.mjs`
Expected: FAIL — `resolveHostPloinkySource` is not exported (SyntaxError on import), so the whole file fails to load. That is the expected red state.

- [ ] **Step 3: Implement in `container/ploinky-box.mjs`**

Add `fileURLToPath` to the `node:url` import and a `HERE` constant near the top (after the imports):

```js
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
```

Replace `volumeNames`:

```js
export function volumeNames(cfg) {
    const instance = instanceName(cfg);
    return {
        workspace: `${instance}-workspace`,
        containers: `${instance}-containers`,
        deps: `${instance}-ploinky-deps`,
    };
}
```

Add the resolver and prepare step (near `prepareMount`):

```js
const SOURCE_MARKERS = ['bin/ploinky', 'cli/index.js', 'globalDeps/package.json'];

// The box mounts the local ploinky checkout read-only at /opt/ploinky. The
// checkout is found from this script's own location (container/ -> repo root)
// so it works from any cwd; PLOINKY_BOX_SOURCE overrides for detached copies.
export function resolveHostPloinkySource(env = process.env, scriptDir = HERE) {
    const override = String(env.PLOINKY_BOX_SOURCE || '').trim();
    const candidate = path.resolve(override || path.resolve(scriptDir, '..'));
    const missing = SOURCE_MARKERS.filter((marker) => !fs.existsSync(path.join(candidate, marker)));
    if (missing.length > 0) {
        die(`ploinky source not found at ${candidate} (missing: ${missing.join(', ')}).
  The box mounts a local ploinky checkout read-only at /opt/ploinky.
  Run the wrapper from inside a ploinky checkout, or set PLOINKY_BOX_SOURCE=/path/to/ploinky.`);
    }
    return candidate;
}

function prepareSource(cfg) {
    cfg.sourceDirResolved = resolveHostPloinkySource();
    // node_modules must exist on the host: it is the mountpoint for the deps
    // volume, and the engine cannot create it inside a read-only bind mount.
    if (!cfg.dryRun) {
        fs.mkdirSync(path.join(cfg.sourceDirResolved, 'node_modules'), { recursive: true });
    }
}
```

Add `sourceDirResolved: ''` to the `cfg` object literal in `parseCli` (next to `mountDirResolved`), and carry it through `mergeBoxCfg`:

```js
        sourceDirResolved: inner.sourceDirResolved || outer.sourceDirResolved,
```

In `buildRunArgs`, replace the volume/env block (note: `-e PLOINKY_BOX=1` is gone — the image marker file `/etc/ploinky-box` is the in-box signal now):

```js
    const source = cfg.sourceDirResolved || resolveHostPloinkySource();
    const depsMountSuffix = cfg.engine === 'podman' ? ':U' : '';
    args.push(
        '-v', `${workspace}:/workspace`,
        '-v', `${containers}:/home/podman/.local/share/containers`,
        '-v', `${source}:/opt/ploinky:ro`,
        '-v', `${deps}:/opt/ploinky/node_modules${depsMountSuffix}`,
        '-e', 'PLOINKY_WORKSPACE_ROOT=/workspace',
    );
```

and change the destructuring at the top of `buildRunArgs` to `const { workspace, containers, deps } = volumeNames(cfg);`.

Note on `:U` (podman only): fresh named volumes are root-owned; `:U` makes podman chown the volume to the container user (`podman`) so `npm install` can write. Docker has no `:U`; Task 2 adds the docker fixup.

Note on PATH/PLOINKY_ROOT consistency: the image keeps `ENV PATH=/opt/ploinky/bin:$PATH`, and `bin/ploinky` derives `PLOINKY_ROOT` from its own on-disk location — mounted at `/opt/ploinky`, that derivation yields `/opt/ploinky`. No extra `-e PLOINKY_ROOT` is needed; do not add one.

Call `prepareSource(cfg)` in `cmdUp` right next to `prepareMount(cfg)`:

```js
        ensureImage(cfg);
        prepareMount(cfg);
        prepareSource(cfg);
```

and the same pair in `cmdUpdate` (it already calls `prepareMount(cfg)`; add `prepareSource(cfg)` after it).

In `cmdDestroy`, cover the third volume:

```js
    const { workspace, containers, deps } = volumeNames(cfg);
```

```js
        const anyVolume = query(cfg, ['volume', 'inspect', workspace]).ok
            || query(cfg, ['volume', 'inspect', containers]).ok
            || query(cfg, ['volume', 'inspect', deps]).ok;
```

```js
        const reply = await askLine(`Remove container '${instance}' and volumes '${workspace}' + '${containers}' + '${deps}'? [y/N] `);
```

```js
    runEngine(cfg, ['volume', 'rm', workspace, containers, deps], { silence: 'all', allowFail: true });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node container/wrapper-tests.mjs`
Expected: PASS — all tests. (The three legacy routing tests — `bin/ploinky runs direct CLI inside the box`, `bin/ploinky supports explicit PLOINKY_DIRECT escape on the host`, `bin/ploinky direct mode resolves through a symlink` — still exist and still pass because `bin/ploinky` itself is unchanged until Task 4 deletes them along with the mechanism they test.)

- [ ] **Step 5: Commit**

```bash
cd /Users/danielsava/work/file-parser/ploinky
git add container/ploinky-box.mjs container/wrapper-tests.mjs
git commit -m "Mount host ploinky source read-only into the box with a deps volume"
```

### Task 2: Docker deps-volume ownership fixup and wrapper first-run install flow

**Files:**
- Modify: `container/ploinky-box.mjs`
- Test: `container/wrapper-tests.mjs`

**Interfaces:**
- Consumes: `volumeNames(cfg).deps`, `cfg.sourceDirResolved` (Task 1), existing `runEngine`, `query`, `askLine`, `instanceName`.
- Produces: new export `shouldInstallDeps(env, isTTY, reply) -> boolean` (pure decision helper); internal `fixDepsOwnership(cfg)` and `ensureDepsInstalled(cfg, { fatalOnDecline }) -> Promise<boolean>` called from `cmdUp`, `cmdUpdate`, and public command startup. Task 3 provides the in-box installer path `/opt/ploinky/bin/ploinky-install-deps` that this task execs.

- [ ] **Step 1: Write the failing tests**

Append to `container/wrapper-tests.mjs` (add `shouldInstallDeps` to the import block from `./ploinky-box.mjs`):

```js
test('docker up fixes deps-volume ownership; podman relies on :U', () => {
    const docker = boxRun('docker', '--dry-run', '--name', 'qa', 'up');
    checkIncludes(docker.out, 'exec --user root ploinky-box-qa chown podman:podman /opt/ploinky/node_modules',
        'docker up chowns the fresh deps volume');
    const podman = boxRun('podman', '--dry-run', '--name', 'qa', 'up');
    checkAbsent(podman.out, 'chown podman:podman /opt/ploinky/node_modules', 'podman up needs no chown (:U)');
});

test('shouldInstallDeps: explicit env opt-in, TTY confirm, default no', () => {
    assert.equal(shouldInstallDeps({ PLOINKY_BOX_INSTALL_DEPS: '1' }, false, null), true);
    assert.equal(shouldInstallDeps({}, true, 'y'), true);
    assert.equal(shouldInstallDeps({}, true, 'Y'), true);
    assert.equal(shouldInstallDeps({}, true, 'n'), false);
    assert.equal(shouldInstallDeps({}, true, ''), false);
    assert.equal(shouldInstallDeps({}, true, null), false);
    assert.equal(shouldInstallDeps({}, false, 'y'), false); // non-TTY never installs from a piped reply
});

test('dependency flow source contract: fatal public decline, docker chown is mandatory', () => {
    const source = fs.readFileSync(MJS, 'utf8');
    checkIncludes(source, 'async function cmdUp(cfg, { fatalOnDepsDecline = false } = {})',
        'cmdUp accepts fatal dependency-decline option');
    checkIncludes(source, 'if (fatalOnDecline) process.exit(1);',
        'declined public ploinky command exits before forwarding');
    checkIncludes(source, 'await cmdUp(cfg, { fatalOnDepsDecline: true });',
        'public ploinky startup passes fatal dependency-decline option');
    checkIncludes(source, 'fixDepsOwnership(cfg);\n        await ensureDepsInstalled(cfg, { fatalOnDecline: fatalOnDepsDecline });',
        'already-running boxes repair docker deps ownership before prompting');
    checkAbsent(source, "chown', 'podman:podman', '/opt/ploinky/node_modules'], { allowFail: true",
        'docker deps chown failures are not ignored');
});
```

Also extend the docker-engine `named up` test (`named up: docker engine, instance prefixes, LAN bind`) with:

```js
    checkIncludes(out, 'ploinky-box-qa-ploinky-deps:/opt/ploinky/node_modules', 'named up mounts deps volume');
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node container/wrapper-tests.mjs`
Expected: FAIL — `shouldInstallDeps` not exported (import error), and once exported, the docker dry-run output lacks the chown line.

- [ ] **Step 3: Implement in `container/ploinky-box.mjs`**

Add near `waitHealthy`:

```js
// Docker cannot chown a fresh named volume via a mount option (podman's :U),
// so fix ownership with one root exec right after the container starts. The
// volume top-level is enough for npm to create its subtree.
function fixDepsOwnership(cfg) {
    if (cfg.engine !== 'docker') return;
    runEngine(cfg, ['exec', '--user', 'root', instanceName(cfg),
        'chown', 'podman:podman', '/opt/ploinky/node_modules']);
}

function depsInstalled(cfg) {
    return query(cfg, ['exec', instanceName(cfg), 'sh', '-lc',
        'test -d /opt/ploinky/node_modules/achillesAgentLib && test -d /opt/ploinky/node_modules/mcp-sdk']).ok;
}

export function shouldInstallDeps(env, isTTY, reply) {
    if (String(env?.PLOINKY_BOX_INSTALL_DEPS || '') === '1') return true;
    if (!isTTY) return false;
    return /^[yY]$/.test(reply ?? '');
}

// First-run dependency flow, host side: never install silently. Explicit env
// opt-in installs; a TTY asks; everything else leaves the box up and warns.
// Public ploinky commands pass fatalOnDecline so a declined prompt exits once,
// before forwarding into a second in-box prompt.
async function ensureDepsInstalled(cfg, { fatalOnDecline = false } = {}) {
    if (cfg.dryRun || depsInstalled(cfg)) return true;
    let reply = null;
    const envOptIn = String(process.env.PLOINKY_BOX_INSTALL_DEPS || '') === '1';
    if (!envOptIn && process.stdin.isTTY) {
        reply = await askLine('Ploinky dependencies are not installed. Install them now? [y/N] ');
    }
    if (!shouldInstallDeps(process.env, process.stdin.isTTY, reply)) {
        process.stderr.write(`${activeProgramName}: WARNING: Ploinky cannot run until dependencies are installed.\n`
            + `${activeProgramName}: install them with: ${cfg.engine} exec -it ${instanceName(cfg)} /opt/ploinky/bin/ploinky-install-deps\n`);
        if (fatalOnDecline) process.exit(1);
        return false;
    }
    runEngine(cfg, ['exec', '-i', instanceName(cfg), '/opt/ploinky/bin/ploinky-install-deps']);
    return true;
}
```

Change the `cmdUp` signature so public forwarded commands can request a fatal dependency decline:

```js
async function cmdUp(cfg, { fatalOnDepsDecline = false } = {}) {
```

At the end of `cmdUp`, after `await waitHealthy(cfg);`:

```js
    await waitHealthy(cfg);
    fixDepsOwnership(cfg);
    await ensureDepsInstalled(cfg, { fatalOnDecline: fatalOnDepsDecline });
```

Also run the flow on the already-running early return, so a user who declined once gets re-prompted by the next `up` (every public command routes through `cmdUp`):

```js
    if (!cfg.dryRun && boxRunning(cfg)) {
        process.stdout.write(`ploinky-box: '${instanceName(cfg)}' already running.\n`);
        fixDepsOwnership(cfg);
        await ensureDepsInstalled(cfg, { fatalOnDecline: fatalOnDepsDecline });
        return;
    }
```

Same `fixDepsOwnership(cfg); await ensureDepsInstalled(cfg);` pair at the end of `cmdUpdate` after its `await waitHealthy(cfg);` (before the "updated" message).

In `runPublicCommand`, update both public startup paths that call `cmdUp(cfg)` before entering or forwarding to the in-box `ploinky` command:

```js
        await cmdUp(cfg, { fatalOnDepsDecline: true });
```

Note: `runEngine` already exits the process when the ownership fix or install exec fails, so those failures abort loudly. `ensureDepsInstalled` returns `false` on decline for plain `box up`/`update`, but exits non-zero when public `ploinky ...` startup passes `fatalOnDecline`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node container/wrapper-tests.mjs`
Expected: PASS — all tests (as in Task 1 Step 4, the three legacy `bin/ploinky` routing tests still exist and still pass until Task 4 deletes them). The dry-run docker `up` output now contains the `exec --user root ... chown` line; podman output does not.

- [ ] **Step 5: Commit**

```bash
git add container/ploinky-box.mjs container/wrapper-tests.mjs
git commit -m "Add first-run dependency install flow to the box wrapper"
```

### Task 3: `bin/ploinky-install-deps` installer script

**Files:**
- Create: `bin/ploinky-install-deps` (mode 0755)
- Test: `container/wrapper-tests.mjs`

**Interfaces:**
- Consumes: `PLOINKY_ROOT` env (optional; defaults to the script's parent directory), `npm` on PATH, `package.json` at the project root (its `postinstall` clones achillesAgentLib).
- Produces: exit 0 with both `node_modules/achillesAgentLib` and `node_modules/mcp-sdk` present; exit non-zero otherwise. Tasks 2 and 4 exec this script; the CI workflow (Task 9) runs it directly.

- [ ] **Step 1: Write the failing tests**

Append to `container/wrapper-tests.mjs`:

```js
const INSTALL_DEPS = path.join(HERE, '..', 'bin', 'ploinky-install-deps');

test('ploinky-install-deps bash syntax check (bash -n)', () => {
    const r = spawnSync('bash', ['-n', INSTALL_DEPS], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
});

// Fake checkout + fake npm: asserts the exact install flags and that the
// script verifies both dependency dirs afterwards.
function makeFakeCheckout({ npmCreatesDeps }) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-fake-root-'));
    fs.mkdirSync(path.join(root, 'bin'));
    fs.copyFileSync(INSTALL_DEPS, path.join(root, 'bin', 'ploinky-install-deps'));
    fs.chmodSync(path.join(root, 'bin', 'ploinky-install-deps'), 0o755);
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"fake"}\n');
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-fake-npm-'));
    const argsFile = path.join(binDir, 'npm-args.txt');
    fs.writeFileSync(path.join(binDir, 'npm'), `#!/usr/bin/env bash
echo "$@" >> ${JSON.stringify(argsFile)}
${npmCreatesDeps ? `mkdir -p "$PWD/node_modules/achillesAgentLib" "$PWD/node_modules/mcp-sdk"` : 'true'}
`);
    fs.chmodSync(path.join(binDir, 'npm'), 0o755);
    return { root, binDir, argsFile };
}

test('ploinky-install-deps installs with read-only-safe npm flags and verifies deps', () => {
    const { root, binDir, argsFile } = makeFakeCheckout({ npmCreatesDeps: true });
    try {
        const env = { ...process.env, PATH: `${binDir}:${process.env.PATH || ''}` };
        const r = spawnSync(path.join(root, 'bin', 'ploinky-install-deps'), [], { encoding: 'utf8', env });
        assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
        const npmArgs = fs.readFileSync(argsFile, 'utf8');
        assert.ok(npmArgs.includes('install --no-package-lock --no-audit --no-fund'), npmArgs);
        assert.ok(fs.statSync(path.join(root, 'node_modules', 'achillesAgentLib')).isDirectory());
        assert.ok(fs.statSync(path.join(root, 'node_modules', 'mcp-sdk')).isDirectory());
        // second run: already installed, npm must not run again
        const r2 = spawnSync(path.join(root, 'bin', 'ploinky-install-deps'), [], { encoding: 'utf8', env });
        assert.equal(r2.status, 0, `${r2.stdout}${r2.stderr}`);
        assert.ok(r2.stdout.includes('already present'), r2.stdout);
        assert.equal(fs.readFileSync(argsFile, 'utf8'), npmArgs, 'npm not re-invoked when deps exist');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(binDir, { recursive: true, force: true });
    }
});

test('ploinky-install-deps fails loudly when npm leaves deps missing', () => {
    const { root, binDir } = makeFakeCheckout({ npmCreatesDeps: false });
    try {
        const env = { ...process.env, PATH: `${binDir}:${process.env.PATH || ''}` };
        const r = spawnSync(path.join(root, 'bin', 'ploinky-install-deps'), [], { encoding: 'utf8', env });
        assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
        assert.ok(`${r.stdout}${r.stderr}`.includes('still missing after npm install'), `${r.stdout}${r.stderr}`);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(binDir, { recursive: true, force: true });
    }
});

test('ploinky-install-deps resets a partial achillesAgentLib before installing', () => {
    const { root, binDir } = makeFakeCheckout({ npmCreatesDeps: true });
    try {
        // partial state: achillesAgentLib exists (would break postinstall's git clone), mcp-sdk missing
        fs.mkdirSync(path.join(root, 'node_modules', 'achillesAgentLib', '.git'), { recursive: true });
        const env = { ...process.env, PATH: `${binDir}:${process.env.PATH || ''}` };
        const r = spawnSync(path.join(root, 'bin', 'ploinky-install-deps'), [], { encoding: 'utf8', env });
        assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
        assert.ok(!fs.existsSync(path.join(root, 'node_modules', 'achillesAgentLib', '.git')), 'partial dir was reset');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(binDir, { recursive: true, force: true });
    }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node container/wrapper-tests.mjs`
Expected: FAIL — `bash -n` and the spawn tests fail because `bin/ploinky-install-deps` does not exist (ENOENT).

- [ ] **Step 3: Create `bin/ploinky-install-deps`**

```bash
#!/usr/bin/env bash
# Install Ploinky's runtime dependencies (node_modules/achillesAgentLib and
# node_modules/mcp-sdk). Safe for the ploinky-box layout where the checkout is
# mounted read-only and node_modules is a writable volume: nothing outside
# node_modules is written (npm runs with --no-package-lock).
set -euo pipefail

SCRIPT_PATH="${BASH_SOURCE[0]}"
while [[ -L "$SCRIPT_PATH" ]]; do
    SCRIPT_DIR="$(cd -P "$(dirname "$SCRIPT_PATH")" >/dev/null 2>&1 && pwd)"
    SCRIPT_PATH="$(readlink "$SCRIPT_PATH")"
    [[ "$SCRIPT_PATH" != /* ]] && SCRIPT_PATH="$SCRIPT_DIR/$SCRIPT_PATH"
done
SCRIPT_DIR="$(cd -P "$(dirname "$SCRIPT_PATH")" >/dev/null 2>&1 && pwd)"
PLOINKY_ROOT="${PLOINKY_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
DEPS_DIR="$PLOINKY_ROOT/node_modules"

if [[ -d "$DEPS_DIR/achillesAgentLib" && -d "$DEPS_DIR/mcp-sdk" ]]; then
    echo "ploinky-install-deps: dependencies already present under $DEPS_DIR"
    exit 0
fi

mkdir -p "$DEPS_DIR" 2>/dev/null || true
if [[ ! -d "$DEPS_DIR" || ! -w "$DEPS_DIR" ]]; then
    echo "ploinky-install-deps: $DEPS_DIR is not writable." >&2
    echo "Inside ploinky-box this is the '<instance>-ploinky-deps' volume; recreate the box if its ownership is wrong." >&2
    exit 1
fi

# npm's postinstall clones achillesAgentLib into node_modules; a leftover
# partial directory makes that clone fail, so reset it first.
rm -rf "$DEPS_DIR/achillesAgentLib"

(cd "$PLOINKY_ROOT" && npm install --no-package-lock --no-audit --no-fund)

for dep in achillesAgentLib mcp-sdk; do
    if [[ ! -d "$DEPS_DIR/$dep" ]]; then
        echo "ploinky-install-deps: $DEPS_DIR/$dep still missing after npm install." >&2
        exit 1
    fi
done
echo "ploinky-install-deps: dependencies installed under $DEPS_DIR"
```

Then: `chmod 0755 bin/ploinky-install-deps`

- [ ] **Step 4: Run tests to verify they pass**

Run: `node container/wrapper-tests.mjs`
Expected: PASS, including the idempotence and partial-state tests.

- [ ] **Step 5: Commit**

```bash
git add bin/ploinky-install-deps container/wrapper-tests.mjs
git commit -m "Add ploinky-install-deps for read-only checkouts with a deps volume"
```

### Task 4: Single-entry `bin/ploinky`; delete `bin/ploinky-direct`, `PLOINKY_BOX`, `PLOINKY_DIRECT`

**Files:**
- Modify: `bin/ploinky` (full rewrite)
- Delete: `bin/ploinky-direct`
- Modify: `cli/index.js` (only `assertRuntimeDependencies`, lines 21–29)
- Modify: `container/ploinky-box.mjs` (usage text only: drop the `PLOINKY_DIRECT` escape block)
- Modify: `tests/unit/cliExitCodes.test.mjs` (drive the CLI via `node cli/index.js` — `PLOINKY_DIRECT` no longer exists)
- Test: `container/wrapper-tests.mjs`

**Interfaces:**
- Consumes: `bin/ploinky-install-deps` (Task 3) at `$SCRIPT_DIR/ploinky-install-deps`; the image marker `/etc/ploinky-box` (baked in Task 8).
- Produces: `bin/ploinky` is the only entry script. Marker present → export `PLOINKY_ROOT`, run the deps gate (prompt on TTY, decline warning `Ploinky cannot run until dependencies are installed.` + exit 1 otherwise), delegate `-shell|sh|--shell` to `bin/ploinky-shell`, exec `node cli/index.js`. Marker absent → export `PLOINKY_PUBLIC_ENTRYPOINT=1`, exec `node container/ploinky-box.mjs`. (`bin/p-cli` and `bin/psh` keep delegating to `bin/ploinky` unchanged.)

**Coverage note:** the in-box branch keys on the absolute path `/etc/ploinky-box`, which host-side unit tests cannot create. Unit tests therefore lock the script's *text contract* (needles below) plus `bash -n`; the *behavior* (prompt, decline exit code, install-then-run) is exercised for real by the image workflow's mounted-contract checks (Task 9) and the local end-to-end run (Task 11).

- [ ] **Step 1: Update `container/wrapper-tests.mjs` (failing first)**

1. Replace `makeFakeNodeCapture` with a version that captures only `argv` and `PLOINKY_PUBLIC_ENTRYPOINT` (the `PLOINKY_BOX`/`PLOINKY_DIRECT` fields are meaningless now):

```js
function makeFakeNodeCapture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-node-'));
    const capture = path.join(dir, 'capture.json');
    const node = path.join(dir, 'node');
    const realNode = process.execPath;
    fs.writeFileSync(node, `#!/usr/bin/env bash
printf '{"argv":[' > ${JSON.stringify(capture)}
first=1
for arg in "$@"; do
  if [ "$first" -eq 0 ]; then printf ',' >> ${JSON.stringify(capture)}; fi
  first=0
  ${JSON.stringify(realNode)} -e 'process.stdout.write(JSON.stringify(process.argv[1]))' -- "$arg" >> ${JSON.stringify(capture)}
done
printf '],"PLOINKY_PUBLIC_ENTRYPOINT":' >> ${JSON.stringify(capture)}
${JSON.stringify(realNode)} -e 'process.stdout.write(JSON.stringify(process.env.PLOINKY_PUBLIC_ENTRYPOINT || ""))' >> ${JSON.stringify(capture)}
printf '}' >> ${JSON.stringify(capture)}
exit 0
`);
    fs.chmodSync(node, 0o755);
    return { dir, capture };
}
```

2. Delete these three tests entirely (their routing mechanism no longer exists):
   - `bin/ploinky runs direct CLI inside the box`
   - `bin/ploinky supports explicit PLOINKY_DIRECT escape on the host`
   - `bin/ploinky direct mode resolves through a symlink`

3. In the surviving fake-capture tests (`public bin/ploinky delegates to the box wrapper on the host`, `bin/ploinky resolves its repo root when invoked through a symlink`, `p-cli still delegates through bin/ploinky`, `p-cli resolves its repo root when invoked through a symlink`, `psh delegates to ploinky sh through a symlink`), remove every `delete env.PLOINKY_BOX;` and `delete env.PLOINKY_DIRECT;` line. Keep the `captured.PLOINKY_PUBLIC_ENTRYPOINT` assertions.

4. In `public usage describes ploinky and box namespace`, replace

```js
    assert.ok(r.stdout.includes('PLOINKY_DIRECT=1'), r.stdout);
```

with:

```js
    assert.ok(!r.stdout.includes('PLOINKY_DIRECT'), r.stdout);
```

5. Add the entry-contract tests:

```js
test('bin/ploinky bash syntax and single-entry contract', () => {
    const r = spawnSync('bash', ['-n', PLOINKY], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const entry = fs.readFileSync(PLOINKY, 'utf8');
    assert.ok(entry.includes('/etc/ploinky-box'), 'entry routes on the image marker file');
    assert.ok(entry.includes('Ploinky dependencies are not installed. Install them now? [y/N]'), 'entry carries the confirm prompt');
    assert.ok(entry.includes('Ploinky cannot run until dependencies are installed.'), 'entry carries the decline warning');
    assert.ok(entry.includes('ploinky-install-deps'), 'entry points at the installer');
    assert.ok(entry.includes('cli/index.js'), 'in-box branch execs the CLI');
    assert.ok(!entry.includes('PLOINKY_DIRECT'), 'PLOINKY_DIRECT is gone');
    assert.ok(!entry.includes('PLOINKY_BOX'), 'PLOINKY_BOX routing is gone');
    assert.ok(!entry.includes('ploinky-direct'), 'ploinky-direct is gone');
});

test('bin/ploinky-direct is deleted', () => {
    assert.ok(!fs.existsSync(path.join(HERE, '..', 'bin', 'ploinky-direct')), 'ploinky-direct must not exist');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node container/wrapper-tests.mjs`
Expected: FAIL — `bin/ploinky` still contains `PLOINKY_DIRECT`/`ploinky-direct`, `bin/ploinky-direct` still exists, and the public usage still prints the escape block.

- [ ] **Step 3: Rewrite `bin/ploinky` and delete `bin/ploinky-direct`**

Full new `bin/ploinky` content:

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_PATH="${BASH_SOURCE[0]}"
while [[ -L "$SCRIPT_PATH" ]]; do
    SCRIPT_DIR="$(cd -P "$(dirname "$SCRIPT_PATH")" >/dev/null 2>&1 && pwd)"
    SCRIPT_PATH="$(readlink "$SCRIPT_PATH")"
    [[ "$SCRIPT_PATH" != /* ]] && SCRIPT_PATH="$SCRIPT_DIR/$SCRIPT_PATH"
done
SCRIPT_DIR="$(cd -P "$(dirname "$SCRIPT_PATH")" >/dev/null 2>&1 && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if ! command -v node >/dev/null 2>&1; then
    echo "ploinky: node >= 20 is required (https://nodejs.org)." >&2
    exit 1
fi

# Single entry: inside the ploinky-box image (marker baked by its Dockerfile)
# ploinky IS the direct CLI; everywhere else it drives the boxed runtime.
if [[ -f /etc/ploinky-box ]]; then
    export PLOINKY_ROOT="$ROOT_DIR"

    deps_missing=0
    [[ -d "$PLOINKY_ROOT/node_modules/achillesAgentLib" ]] || deps_missing=1
    [[ -d "$PLOINKY_ROOT/node_modules/mcp-sdk" ]] || deps_missing=1
    if [[ "$deps_missing" == "1" ]]; then
        # First-run flow: ask on a TTY, never install silently. Non-interactive
        # contexts (podman exec without -t, scripts, CI) default to "no".
        answer="n"
        if [[ -t 0 ]]; then
            printf 'Ploinky dependencies are not installed. Install them now? [y/N] ' >&2
            read -r answer || answer="n"
        fi
        if [[ "$answer" =~ ^[yY]$ ]]; then
            "$SCRIPT_DIR/ploinky-install-deps"
        else
            echo "WARNING: Ploinky cannot run until dependencies are installed." >&2
            echo "Install them with: $SCRIPT_DIR/ploinky-install-deps" >&2
            exit 1
        fi
    fi

    if [[ "${1:-}" == "-shell" || "${1:-}" == "sh" || "${1:-}" == "--shell" ]]; then
        shift
        exec "$SCRIPT_DIR/ploinky-shell" "$@"
    fi
    exec node "$PLOINKY_ROOT/cli/index.js" "$@"
fi

export PLOINKY_PUBLIC_ENTRYPOINT=1
exec node "$ROOT_DIR/container/ploinky-box.mjs" "$@"
```

Delete the old script:

```bash
git rm bin/ploinky-direct
```

In `container/ploinky-box.mjs`, delete these three lines from the public usage template in `usageText`:

```
Direct development escape:
  PLOINKY_DIRECT=1 ploinky <args>
```

(and the blank line separating them from the flags block, keeping the template tidy).

Replace `assertRuntimeDependencies` in `cli/index.js` (backstop for `node cli/index.js` callers; stays non-interactive):

```js
function assertRuntimeDependencies() {
    const missing = ['achillesAgentLib', 'mcp-sdk'].filter((dep) => {
        try {
            return !fs.statSync(path.join(PLOINKY_ROOT, 'node_modules', dep)).isDirectory();
        } catch (_) {
            return true;
        }
    });
    if (missing.length === 0) return;
    console.error(`Ploinky dependencies missing: ${missing.map((dep) => path.join(PLOINKY_ROOT, 'node_modules', dep)).join(', ')}`);
    console.error('WARNING: Ploinky cannot run until dependencies are installed.');
    console.error(`Install them with: ${path.join(PLOINKY_ROOT, 'bin', 'ploinky-install-deps')}`);
    process.exit(1);
}
```

- [ ] **Step 4: Update `tests/unit/cliExitCodes.test.mjs`**

Replace the binary constant:

```js
const cliEntry = path.join(repoRoot, 'cli', 'index.js');
```

(delete the `const ploinkyBin = path.join(repoRoot, 'bin', 'ploinky');` line). Replace `runPloinky` — the CLI is invoked directly; there is no `PLOINKY_DIRECT` anymore:

```js
function runPloinky(t, args) {
    const workspace = createWorkspace(t);
    return spawnSync(process.execPath, [cliEntry, ...args], {
        cwd: workspace,
        encoding: 'utf8',
        env: {
            ...process.env,
            PLOINKY_WORKSPACE_ROOT: workspace,
            PLOINKY_MASTER_KEY: '5'.repeat(64),
        },
    });
}
```

And in the `enable repo marks an installed repository as enabled` test, change the spawn to:

```js
    const result = spawnSync(process.execPath, [cliEntry, 'enable', 'repo', repoName], {
        cwd: workspace,
        encoding: 'utf8',
        env: {
            ...process.env,
            PLOINKY_WORKSPACE_ROOT: workspace,
            PLOINKY_MASTER_KEY: '5'.repeat(64),
        },
    });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node container/wrapper-tests.mjs && node --test tests/unit/cliExitCodes.test.mjs`
Expected: both PASS. Also spot-check the host route still works end-to-end in dry-run: `PLOINKY_BOX_ENGINE=podman ./bin/ploinky --name qa --dry-run status` goes through the wrapper's public path (output contains `DRY-RUN: podman run -d` and `exec -w /workspace ploinky-box-qa ploinky status`), proving the host branch still reaches `container/ploinky-box.mjs`.

- [ ] **Step 6: Verify no stragglers**

Run: `rg -n "PLOINKY_DIRECT|ploinky-direct" --glob '!node_modules' --glob '!docs/superpowers' --glob '!container/wrapper-tests.mjs' .`
Expected: the only remaining hits are in the root `README.md` (its escape block is rewritten in Task 7). Anything else listed must be cleaned up now. (`container/wrapper-tests.mjs` is excluded because its negative assertions intentionally contain the strings.)

- [ ] **Step 7: Commit**

```bash
git add bin/ploinky cli/index.js container/ploinky-box.mjs container/wrapper-tests.mjs tests/unit/cliExitCodes.test.mjs
git commit -m "Collapse ploinky entry to one script routed by the box marker"
```

(`git rm bin/ploinky-direct` in Step 3 already staged the deletion, so it rides along in this commit.)

### Task 5: Marker-based box detection for agent networking

**Files:**
- Modify: `cli/services/docker/agentServiceManager.js` (lines 109–110 area for the constant; `isPloinkyBoxRuntime` at line 470; `buildRuntimeNetworkPlan` at line 502)
- Test: `tests/unit/containerRuntime.test.mjs` (the `buildRuntimeNetworkPlan downgrades named podman networks inside ploinky-box` test at line 88)

**Interfaces:**
- Consumes: the image marker `/etc/ploinky-box` (baked in Task 8; on hosts the file is absent, so behavior is "not in box").
- Produces: `isPloinkyBoxRuntime(markerPath = '/etc/ploinky-box') -> boolean` (fs-based, env-free); `buildRuntimeNetworkPlan(runtime, manifestNetwork, options)` accepts `options.boxMarkerPath` for tests instead of `options.env`. Both production call sites (`agentServiceManager.js:688` and `:1329`) pass no options and need no changes.

- [ ] **Step 1: Update the test to marker injection (failing first)**

In `tests/unit/containerRuntime.test.mjs`, replace the body of `buildRuntimeNetworkPlan downgrades named podman networks inside ploinky-box` with:

```js
    const workspaceDir = tempDir();
    try {
        const markerPath = `${workspaceDir}/ploinky-box-marker`;
        fs.writeFileSync(markerPath, 'assistos/ploinky-box\n');
        const result = runModuleSnippet(
            `const { buildRuntimeNetworkPlan } = await import(${JSON.stringify(agentServiceManagerUrl)});
const plan = buildRuntimeNetworkPlan('podman', {
  name: 'webmeet',
  aliases: ['liveKitServerAgent', 'webmeetAgent'],
}, { boxMarkerPath: ${JSON.stringify(markerPath)} });
process.stdout.write(JSON.stringify(plan));`,
            {},
            { cwd: workspaceDir },
        );

        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), {
            args: ['--replace', '--network', 'slirp4netns:allow_host_loopback=true'],
            ensureNetworkName: '',
            useHostNetwork: false,
            boxNetworkCompat: true,
            hashEnv: { PLOINKY_BOX_NETWORK_COMPAT: 'slirp4netns-named-network' },
        });
    } finally {
        fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
```

Run: `node --test tests/unit/containerRuntime.test.mjs`
Expected: FAIL — the implementation still reads `options.env`/`PLOINKY_BOX`, ignores `boxMarkerPath`, and returns the named-network plan instead of the downgrade.

- [ ] **Step 2: Implement in `cli/services/docker/agentServiceManager.js`**

Next to the existing constants (`PODMAN_ROOTLESS_NETWORK`, `PLOINKY_BOX_NETWORK_COMPAT_HASH` at lines 109–110) add:

```js
const PLOINKY_BOX_MARKER_PATH = '/etc/ploinky-box';
```

Replace `isPloinkyBoxRuntime` (line 470; `fs` is already imported at the top of the file):

```js
// The ploinky-box image bakes /etc/ploinky-box (container-image-builds,
// images/ploinky-box/Dockerfile). Its presence — not an env var — signals
// that ploinky runs inside the box.
function isPloinkyBoxRuntime(markerPath = PLOINKY_BOX_MARKER_PATH) {
    try {
        return fs.statSync(markerPath).isFile();
    } catch (_) {
        return false;
    }
}
```

In `buildRuntimeNetworkPlan` (line 502), replace

```js
    const env = options.env || process.env;
```

with

```js
    const boxMarkerPath = options.boxMarkerPath || PLOINKY_BOX_MARKER_PATH;
```

and the guard at line 518

```js
        if (isPodman && isPloinkyBoxRuntime(env)) {
```

with

```js
        if (isPodman && isPloinkyBoxRuntime(boxMarkerPath)) {
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `node --test tests/unit/containerRuntime.test.mjs`
Expected: PASS — including the neighboring network-plan tests, which pass no options and correctly see "not in box" on the test host (no `/etc/ploinky-box` there).

Run: `rg -n "PLOINKY_BOX([^_A-Z]|$)" cli/ --glob '!node_modules'`
Expected: no output — nothing in the CLI reads the removed env var.

- [ ] **Step 4: Commit**

```bash
git add cli/services/docker/agentServiceManager.js tests/unit/containerRuntime.test.mjs
git commit -m "Detect the box runtime via the image marker file"
```

### Task 6: Smoke script opts into automatic dependency install

**Files:**
- Modify: `container/smoke-box.mjs`

**Interfaces:**
- Consumes: `PLOINKY_BOX_INSTALL_DEPS=1` handling in the wrapper (Task 2).
- Produces: smoke runs are non-interactive but still get dependencies installed via the explicit env opt-in.

- [ ] **Step 1: Set the env opt-in in both spawn helpers**

In `container/smoke-box.mjs`, replace the two helpers:

```js
// Smoke runs non-interactively; PLOINKY_BOX_INSTALL_DEPS=1 is the explicit
// opt-in that lets the wrapper install ploinky deps on first up without a TTY.
const SMOKE_ENV = { ...process.env, PLOINKY_BOX_INSTALL_DEPS: '1' };

function box(...args) {
    return spawnSync(BOX, args, { stdio: 'inherit', env: SMOKE_ENV }).status === 0;
}

function publicPloinky(...args) {
    return spawnSync(PUBLIC_PLOINKY, args, { stdio: 'inherit', env: SMOKE_ENV }).status === 0;
}
```

- [ ] **Step 2: Verify the smoke script parses and the docs-needle test still passes**

Run: `node --check container/smoke-box.mjs && node container/wrapper-tests.mjs`
Expected: both succeed (`smoke script documents optional public ploinky path` keeps passing — `SMOKE_PUBLIC_PLOINKY` and `bin/ploinky` strings are untouched).

- [ ] **Step 3: Commit**

```bash
git add container/smoke-box.mjs
git commit -m "Opt smoke runs into automatic dependency install"
```

### Task 7: ploinky docs — box README, root README, docs-needle tests

**Files:**
- Modify: `container/README.md`
- Modify: `README.md` (root)
- Test: `container/wrapper-tests.mjs` (the `docs describe boxed-by-default ploinky and direct escape` test)

**Interfaces:**
- Consumes: behavior implemented in Tasks 1–6.
- Produces: documentation matching the new contract; strengthened docs-needle test pins it.

- [ ] **Step 1: Update the docs test (failing first)**

Rename the test `docs describe boxed-by-default ploinky and direct escape` to `docs describe boxed-by-default ploinky and the host-mounted core` and make its body:

```js
    const rootReadme = fs.readFileSync(path.join(HERE, '..', 'README.md'), 'utf8');
    const boxReadme = fs.readFileSync(path.join(HERE, 'README.md'), 'utf8');
    assert.ok(rootReadme.includes('ploinky box status'), rootReadme);
    assert.ok(rootReadme.includes('mounted read-only'), rootReadme);
    assert.ok(rootReadme.includes('node cli/index.js'), rootReadme);
    assert.ok(!rootReadme.includes('PLOINKY_DIRECT'), 'the direct-mode escape is gone');
    assert.ok(boxReadme.includes('ploinky box destroy'), boxReadme);
    assert.ok(boxReadme.includes('ploinky-box compatibility'), boxReadme);
    assert.ok(boxReadme.includes('/opt/ploinky'), boxReadme);
    assert.ok(boxReadme.includes('read-only'), boxReadme);
    assert.ok(boxReadme.includes('ploinky-deps'), boxReadme);
    assert.ok(boxReadme.includes('PLOINKY_BOX_SOURCE'), boxReadme);
    assert.ok(boxReadme.includes('PLOINKY_BOX_INSTALL_DEPS'), boxReadme);
    assert.ok(boxReadme.includes('Install them now?'), boxReadme);
    assert.ok(boxReadme.includes('/etc/ploinky-box'), boxReadme);
    assert.ok(!boxReadme.includes('PLOINKY_DIRECT'), 'the direct-mode escape is gone');
```

Run: `node container/wrapper-tests.mjs`
Expected: FAIL on the new needles.

- [ ] **Step 2: Update `container/README.md`**

Make these exact edits:

1. Replace the intro sentence "The host needs podman (preferred) or docker, plus Node >= 20 to run the wrapper — no git, no ploinky checkout." with:

```markdown
The host needs podman (preferred) or docker, Node >= 20 to run the wrapper,
and a local ploinky checkout: the box does not bake Ploinky core — the wrapper
bind-mounts your checkout read-only at `/opt/ploinky` inside the box.
```

2. Replace the whole "Quick start" section body with:

```markdown
    git clone https://github.com/AssistOS-AI/ploinky ~/work/file-parser/ploinky
    cd ~/work/myProject
    ~/work/file-parser/ploinky/bin/ploinky start webtty   # box 'ploinky-box-myProject': up + start webtty + router probe
    open http://127.0.0.1:8080/status

On the first run the box has no Ploinky dependencies yet; the wrapper asks
`Ploinky dependencies are not installed. Install them now? [y/N]` and installs
them into the box's dependency volume when you confirm. Decline (or run
without a terminal) and ploinky exits non-zero with a warning until you
install. Set `PLOINKY_BOX_INSTALL_DEPS=1` to opt into automatic install in
scripts, or run the installer yourself:
`<engine> exec -it <instance> /opt/ploinky/bin/ploinky-install-deps`.
```

3. In the "Instances" section, extend the volumes sentence to name three volumes: `ploinky-box-testExplorerFresh-workspace` / `-containers` / `-ploinky-deps`.

4. Add a new section after "The one rule about ports":

```markdown
## Host-mounted core and the dependency volume

The box mounts your ploinky checkout read-only at `/opt/ploinky` (resolved
from the wrapper's own location; override with `PLOINKY_BOX_SOURCE=/path`).
Core code edits on the host are visible inside the running box immediately —
no image rebuild. Because the source is read-only, npm dependencies live in a
writable named volume `<instance>-ploinky-deps` mounted at
`/opt/ploinky/node_modules`; host-side `node_modules` content is shadowed and
never used in-box. `stop`/`update` keep the volume; `destroy` removes it.

There is no direct-mode escape and no `PLOINKY_BOX`/`PLOINKY_DIRECT` env
handling: on hosts `ploinky` always drives the box, and inside the box image
(marker file `/etc/ploinky-box`, baked by the Dockerfile) the same `ploinky`
script is the direct CLI. For CLI development on the host without the box,
run `node cli/index.js` from the checkout.
```

5. In "Isolation contract", change "State lives in two named volumes" to "State lives in three named volumes per instance: `<instance>-workspace` (the Ploinky workspace), `<instance>-containers` (nested agent images), and `<instance>-ploinky-deps` (Ploinky's npm dependencies)." Also add after the `--mount` sentence: "The ploinky source mount is read-only and is not a crossing: nothing in the box can write through it."

6. In "Limitations", replace the first bullet ("In-box `ploinky update` cannot update the baked runtime...") with:

```markdown
- Ploinky core is supplied by the host checkout (mounted read-only), so
  in-box `ploinky update` cannot modify core code either — update the
  checkout on the host with git; running boxes see edits immediately.
  `ploinky box update` still refreshes the runtime image itself.
- On macOS, the ploinky checkout (like `--mount` directories) must live under
  the podman-machine / Docker Desktop file share (default: your home
  directory).
```

7. Replace the "Image provenance" section body with:

```markdown
`docker.io/assistos/ploinky-box:podman-node24`, built by
`publish-ploinky-box-image.yml` in `AssistOS-AI/container-image-builds`. The
image is runtime-only (Node 24, npm, git, nested podman, slirp4netns, plus
the `/etc/ploinky-box` marker file): it contains no Ploinky source; the
wrapper supplies core code via the read-only host mount. Rebuild/publish:

    gh workflow run publish-ploinky-box-image.yml \
      --repo AssistOS-AI/container-image-builds \
      -f image_tag=podman-node24
```

- [ ] **Step 3: Update root `README.md`**

1. In the "By default, `ploinky` now runs through the boxed runtime..." paragraph, append:

```markdown
The box does not bake Ploinky core: your local checkout is mounted read-only
into the box, so core edits on the host apply to a running box without an
image rebuild. On first use, ploinky asks before installing its npm
dependencies into the box's dependency volume.
```

2. Replace the direct-mode escape block

```markdown
For local CLI development or emergency direct-mode debugging:

```bash
PLOINKY_DIRECT=1 ploinky <args>
```
```

with:

```markdown
For local CLI development without the box, run the CLI entry directly from
your checkout:

```bash
node cli/index.js <args>
```
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node container/wrapper-tests.mjs`
Expected: PASS (docs needles found; `usage text still documents every command and flag` unaffected).

- [ ] **Step 5: Run the full ploinky unit suite and the repo-wide straggler grep**

Run: `node --test tests/unit/*.test.mjs tests/unit/*.test.js`
Expected: PASS (the wrapper shim `tests/unit/ploinkyBoxWrapper.test.mjs` re-runs everything above; other unit tests unaffected).

Run: `rg -n "PLOINKY_BOX([^_A-Z]|$)|PLOINKY_DIRECT|ploinky-direct" --glob '!node_modules' --glob '!docs/superpowers' --glob '!container/wrapper-tests.mjs' --glob '!docs/*.html' --glob '!docs/*.md' .`
Expected: no output. (`container/wrapper-tests.mjs` is allowed to contain the strings inside negative assertions only; generated HTML docs and legacy design notes under `docs/` are historical and out of scope — clean them opportunistically if trivial.)

- [ ] **Step 6: Commit**

```bash
git add container/README.md README.md container/wrapper-tests.mjs
git commit -m "Document host-mounted ploinky core for the box"
```

---

# Part 2 — container-image-builds repo

All paths in Part 2 are relative to `/Users/danielsava/work/file-parser/container-image-builds`. Create the working branch first:

```bash
cd /Users/danielsava/work/file-parser/container-image-builds
git checkout -b ploinky-box-host-mounted-core
```

### Task 8: Runtime-only Dockerfile (with box marker) and mount-validating entrypoint

**Files:**
- Modify: `images/ploinky-box/Dockerfile`
- Modify: `images/ploinky-box/entrypoint.sh`
- Test: `tests/image-definitions.test.mjs` (the `ploinky-box workflow builds pinned ploinky checkout with nested-podman base` test)

**Interfaces:**
- Consumes: nothing new.
- Produces: an image with `/opt/ploinky` as an **empty** mountpoint, the marker file `/etc/ploinky-box` (the signal `bin/ploinky` and `agentServiceManager.js` route on — Tasks 4–5), tools node/npm/npx/git/podman/slirp4netns, unchanged `ENV PATH=/opt/ploinky/bin:$PATH` and `PLOINKY_WORKSPACE_ROOT=/workspace`; an entrypoint whose self-check requires the mounted source (`/opt/ploinky/bin/ploinky` executable) and the deps mountpoint (`/opt/ploinky/node_modules` directory) but **not** any installed dependency.

- [ ] **Step 1: Update the test to the new contract (failing first)**

In `tests/image-definitions.test.mjs`, replace the entire `test('ploinky-box workflow builds pinned ploinky checkout with nested-podman base', ...)` block with:

```js
test('ploinky-box image is runtime-only; ploinky is mounted, verified via the workflow', () => {
    const workflow = read('.github/workflows/publish-ploinky-box-image.yml');
    const dockerfile = read('images/ploinky-box/Dockerfile');
    const entrypoint = read('images/ploinky-box/entrypoint.sh');

    // workflow still checks out ploinky, but only to mount it during verification
    assert.match(workflow, /repository:\s*AssistOS-AI\/ploinky/);
    assert.match(workflow, /submodules:\s*true/);
    assert.match(workflow, /path:\s*sources\/ploinky/);
    assert.match(workflow, /ref:\s*\$\{\{ inputs\.source_ref \|\| 'master' \}\}/);
    assert.match(workflow, /file:\s*\.\/images\/ploinky-box\/Dockerfile/);
    assert.match(workflow, /IMAGE_NAME:\s*assistos\/ploinky-box/);
    assert.match(workflow, /docker\/login-action@v3/);
    assert.match(workflow, /docker\/build-push-action@v6/);
    assert.match(workflow, /password:\s*\$\{\{\s*secrets\.DOCKERHUB_TOKEN\s*\}\}/);
    assert.match(workflow, /platforms:\s*linux\/amd64,linux\/arm64/);
    assert.match(workflow, /--device \/dev\/fuse --device \/dev\/net\/tun --security-opt seccomp=unconfined/);
    assert.match(workflow, /slirp4netns:allow_host_loopback=true/);
    // the workflow's verify steps are rewritten in Task 9; this still-true
    // needle keeps the test green through this task (Task 9 replaces it)
    assert.match(workflow, /git -C sources\/ploinky rev-parse --short=12 HEAD/);

    // image bakes runtime tools + the box marker — no ploinky source, no npm install
    assert.match(dockerfile, /^ARG PODMAN_BASE=quay\.io\/podman\/stable$/m);
    assert.match(dockerfile, /^ARG NODE_RUNTIME_IMAGE=docker\.io\/library\/node:24-bookworm-slim$/m);
    assert.match(dockerfile, /COPY --from=node-runtime \/usr\/local\/bin\/node \/usr\/local\/bin\/node/);
    assert.match(dockerfile, /\bslirp4netns\b/);
    assert.match(dockerfile, /mkdir -p \/opt\/ploinky \/workspace/);
    assert.match(dockerfile, /\/etc\/ploinky-box/);
    assert.match(dockerfile, /^ENV PATH=\/opt\/ploinky\/bin:\$PATH/m);
    assert.match(dockerfile, /^USER podman$/m);
    assert.match(dockerfile, /WORKDIR \/workspace/);
    assert.doesNotMatch(dockerfile, /COPY sources\/ploinky/);
    assert.doesNotMatch(dockerfile, /npm install/);

    // entrypoint validates the mount contract, not baked dependencies
    assert.match(entrypoint, /podman info/);
    assert.match(entrypoint, /\/dev\/net\/tun/);
    assert.match(entrypoint, /podman rm -af --time 0/);
    assert.match(entrypoint, /ploinky source not mounted/);
    assert.match(entrypoint, /\/opt\/ploinky\/node_modules/);
    assert.match(entrypoint, /\/etc\/ploinky-box/);
    assert.match(entrypoint, /exec "\$@"/);
    assert.match(entrypoint, /exec sleep infinity/);
    assert.doesNotMatch(entrypoint, /achillesAgentLib/);
});
```

Run: `node --test tests/image-definitions.test.mjs`
Expected: FAIL — Dockerfile still contains `COPY sources/ploinky` and `npm install` and lacks the marker; entrypoint still checks `achillesAgentLib`.

- [ ] **Step 2: Rewrite `images/ploinky-box/Dockerfile`**

Full new content:

```dockerfile
ARG PODMAN_BASE=quay.io/podman/stable
ARG NODE_RUNTIME_IMAGE=docker.io/library/node:24-bookworm-slim

FROM ${NODE_RUNTIME_IMAGE} AS node-runtime

FROM ${PODMAN_BASE}

# Node 24 runtime: bookworm glibc binary runs on the newer-glibc Fedora base
# (same multi-stage trick as images/onlyoffice-agent).
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && dnf install -y git slirp4netns \
    && dnf clean all
# slirp4netns: ploinky pins agent networking to slirp4netns:allow_host_loopback,
# but podman/stable ships only pasta by default.

# No baked Ploinky core: the ploinky-box wrapper bind-mounts a host checkout
# read-only at /opt/ploinky and a writable named volume at
# /opt/ploinky/node_modules. /opt/ploinky stays an empty mountpoint here.
# /etc/ploinky-box is the in-box marker: bin/ploinky runs the direct CLI when
# it exists, and ploinky's agent networking downgrades named podman networks.
# Agent runtimes (e.g. webtty's node-pty) ship in their own agent images,
# pulled by the nested podman at run time.
RUN mkdir -p /opt/ploinky /workspace /home/podman/.local/share/containers \
    && chown -R podman:podman /workspace /home/podman/.local/share/containers \
    && echo 'assistos/ploinky-box' > /etc/ploinky-box

ENV PATH=/opt/ploinky/bin:$PATH \
    PLOINKY_WORKSPACE_ROOT=/workspace

COPY images/ploinky-box/entrypoint.sh /usr/local/bin/ploinky-box-entrypoint
RUN chmod 0755 /usr/local/bin/ploinky-box-entrypoint

USER podman
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/ploinky-box-entrypoint"]
```

- [ ] **Step 3: Rewrite `images/ploinky-box/entrypoint.sh`**

Full new content:

```bash
#!/usr/bin/env bash
# ploinky-box entrypoint: self-check, then run the given command or idle.
# The self-check is the single source of in-box diagnostics; the wrapper's
# `up` health-wait surfaces these messages verbatim.
# Ploinky core is NOT baked into this image: the wrapper mounts a host
# checkout read-only at /opt/ploinky plus a writable dependency volume at
# /opt/ploinky/node_modules. Dependencies are installed by the first
# `ploinky` run (confirm/install flow), so this self-check must not require
# node_modules content — only the mountpoints.
set -u

fail() {
    echo "[ploinky-box] SELF-CHECK FAILED: $1" >&2
    exit 1
}

command -v node >/dev/null 2>&1 || fail "node not on PATH"
command -v npm >/dev/null 2>&1 || fail "npm not on PATH"
command -v git >/dev/null 2>&1 || fail "git not on PATH"
command -v podman >/dev/null 2>&1 || fail "podman not on PATH"
[ -f /etc/ploinky-box ] || fail "/etc/ploinky-box marker missing (image build problem)"
[ -x /opt/ploinky/bin/ploinky ] || fail "ploinky source not mounted: bind-mount a ploinky checkout read-only at /opt/ploinky (the ploinky-box wrapper does this automatically)"
[ -d /opt/ploinky/node_modules ] || fail "dependency volume not mounted at /opt/ploinky/node_modules"
[ -w /workspace ] || fail "/workspace not writable (named-volume ownership problem)"
[ -e /dev/fuse ] || fail "/dev/fuse not present - run the box with --device /dev/fuse"
[ -e /dev/net/tun ] || fail "/dev/net/tun not present - run the box with --device /dev/net/tun (slirp4netns agent networking needs it)"
podman info >/dev/null 2>&1 \
    || fail "inner podman not functional - check --security-opt seccomp=unconfined, --device /dev/fuse, and subuid mapping"

# Fresh slate: an unclean box stop leaves inner podman with stale "running"
# containers (dead conmon/rootlessport, PID reuse fools liveness), which stops
# ploinky from recreating agents on resume. Agent containers are disposable -
# `ploinky start` recreates them from /workspace/.ploinky state.
podman rm -af --time 0 >/dev/null 2>&1 || true

echo "[ploinky-box] self-check OK"

if [ "$#" -gt 0 ]; then
    exec "$@"
fi
exec sleep infinity
```

- [ ] **Step 4: Syntax checks and green tests**

Run: `bash -n images/ploinky-box/entrypoint.sh && echo ENTRYPOINT-OK`
Expected: `ENTRYPOINT-OK`

Run: `node --test tests/image-definitions.test.mjs`
Expected: PASS — all 10 tests (the rewritten ploinky-box test matches the new Dockerfile/entrypoint, and the workflow needles it keeps are still true of the unchanged workflow).

- [ ] **Step 5: Commit**

```bash
git add images/ploinky-box/Dockerfile images/ploinky-box/entrypoint.sh tests/image-definitions.test.mjs
git commit -m "Make ploinky-box image runtime-only with box marker and mount checks"
```

### Task 9: Publish workflow verifies the mount contract

**Files:**
- Modify: `.github/workflows/publish-ploinky-box-image.yml`
- Test: `tests/image-definitions.test.mjs` (workflow assertions updated in this task)

**Interfaces:**
- Consumes: image/entrypoint from Task 8; `bin/ploinky` single-entry routing and `bin/ploinky-install-deps` from Part 1 Tasks 3–4 (the workflow checks out `AssistOS-AI/ploinky`, so those must exist on the ref it verifies — use `-f source_ref=<branch>` while ploinky changes are unmerged).
- Produces: a published `assistos/ploinky-box:podman-node24` image verified against the mounted-source contract. Note: no `-e PLOINKY_BOX=1` anywhere — the baked `/etc/ploinky-box` marker routes `ploinky` to the direct CLI inside every container run.

- [ ] **Step 1: Write the failing workflow assertions**

In the `ploinky-box image is runtime-only...` test from Task 8, replace the line

```js
    assert.match(workflow, /git -C sources\/ploinky rev-parse --short=12 HEAD/);
```

with:

```js
    // mount-contract verification instead of baked-content assertions
    assert.match(workflow, /sources\/ploinky:\/opt\/ploinky:ro/);
    assert.match(workflow, /ploinky-install-deps/);
    assert.match(workflow, /Ploinky cannot run until dependencies are installed/);
    assert.match(workflow, /npx -v/);
    assert.match(workflow, /verify_deps_volume=/);
    assert.match(workflow, /docker volume rm -f "\$verify_deps_volume"/);
    assert.match(workflow, /test -z "\$\(ls -A \/opt\/ploinky\)"/);
    assert.match(workflow, /test -f \/etc\/ploinky-box/);
    assert.match(workflow, /webtty-agent:node24/);
    // image content no longer depends on the ploinky revision
    assert.doesNotMatch(workflow, /git -C sources\/ploinky rev-parse/);
    // no baked-content checks left (the mounted-contract step tests
    // /opt/ploinky/bin/ploinky-install-deps, never `test -x .../bin/ploinky`)
    assert.doesNotMatch(workflow, /test -x \/opt\/ploinky\/bin\/ploinky\s/);
    // the removed env var must not sneak back in
    assert.doesNotMatch(workflow, /PLOINKY_BOX=/);
```

Run: `node --test tests/image-definitions.test.mjs`
Expected: FAIL — the workflow still has the old `Resolve source revision` step and baked-content verify step.

- [ ] **Step 2: Rewrite the verification steps in `.github/workflows/publish-ploinky-box-image.yml`**

Keep: the two checkout steps (self + `AssistOS-AI/ploinky` into `sources/ploinky` with `submodules: true` — the checkout now exists purely to mount during verification, mirroring a dev machine's checkout, including a non-empty `node_modules` that the deps volume must shadow), QEMU/Buildx/login steps, the `Build verification image` step, and the final `Build metadata` + `Build and push` steps.

Replace the `Resolve source revision` step with:

```yaml
      - name: Resolve build revision
        id: build_rev
        run: echo "sha=$(git rev-parse --short=12 HEAD)" >> "$GITHUB_OUTPUT"
```

and update the metadata tags to use it (the image content no longer depends on the ploinky sha):

```yaml
          tags: |
            type=raw,value=${{ env.IMAGE_TAG }}
            type=raw,value=${{ env.IMAGE_TAG }}-${{ steps.build_rev.outputs.sha }}
```

Replace the `Verify image contents` step with:

```yaml
      - name: Verify image contents (runtime-only, no baked ploinky)
        run: |
          docker run --rm --user podman --entrypoint bash \
            ploinky-box:verify -lc '
              set -e
              node -v
              npm -v
              npx -v
              git --version
              podman --version
              command -v slirp4netns
              test -f /etc/ploinky-box
              test -d /opt/ploinky
              test -z "$(ls -A /opt/ploinky)"
              test -x /usr/local/bin/ploinky-box-entrypoint
              echo IMAGE-OK
            '

      - name: Verify mounted-source contract
        run: |
          verify_deps_volume="ploinky-box-verify-deps-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
          docker volume rm -f "$verify_deps_volume" >/dev/null 2>&1 || true
          docker volume create "$verify_deps_volume"
          trap 'docker volume rm -f "$verify_deps_volume" >/dev/null 2>&1 || true' EXIT
          # docker named volumes start root-owned; mirror the wrapper's fixup
          docker run --rm --user root --entrypoint bash \
            -v "$PWD/sources/ploinky:/opt/ploinky:ro" \
            -v "$verify_deps_volume":/opt/ploinky/node_modules \
            ploinky-box:verify -lc 'chown podman:podman /opt/ploinky/node_modules'
          # 1) first ploinky run without deps: non-interactive => decline, warn, exit non-zero
          set +e
          out=$(docker run --rm --user podman --entrypoint bash \
            -v "$PWD/sources/ploinky:/opt/ploinky:ro" \
            -v "$verify_deps_volume":/opt/ploinky/node_modules \
            ploinky-box:verify -lc 'ploinky help' 2>&1)
          code=$?
          set -e
          echo "$out"
          test "$code" -ne 0
          echo "$out" | grep -q "Ploinky cannot run until dependencies are installed"
          # 2) explicit install writes only into the deps volume
          docker run --rm --user podman --entrypoint bash \
            -v "$PWD/sources/ploinky:/opt/ploinky:ro" \
            -v "$verify_deps_volume":/opt/ploinky/node_modules \
            ploinky-box:verify -lc '/opt/ploinky/bin/ploinky-install-deps'
          # 3) deps landed; ploinky now runs from the mounted source via PATH
          docker run --rm --user podman --entrypoint bash \
            -v "$PWD/sources/ploinky:/opt/ploinky:ro" \
            -v "$verify_deps_volume":/opt/ploinky/node_modules \
            ploinky-box:verify -lc '
              set -e
              test -d /opt/ploinky/node_modules/achillesAgentLib
              test -d /opt/ploinky/node_modules/mcp-sdk
              ploinky help >/dev/null
              echo MOUNT-OK
            '
```

Replace the `Nested podman check (best effort)` step with (mounts added because the entrypoint self-check now requires them; the webtty check proves the runtime layer supports ploinky's default smoke agent, whose node-pty ships in the agent image):

```yaml
      - name: Nested podman check (best effort)
        continue-on-error: true
        run: |
          docker run --rm --user podman \
            --device /dev/fuse --device /dev/net/tun --security-opt seccomp=unconfined \
            --security-opt label=disable \
            -v "$PWD/sources/ploinky:/opt/ploinky:ro" \
            -v /opt/ploinky/node_modules \
            ploinky-box:verify \
            podman run --network slirp4netns:allow_host_loopback=true \
              --rm docker.io/library/alpine echo nested-ok

      - name: WebTTY runtime check (best effort)
        continue-on-error: true
        run: |
          docker run --rm --user podman \
            --device /dev/fuse --device /dev/net/tun --security-opt seccomp=unconfined \
            --security-opt label=disable \
            -v "$PWD/sources/ploinky:/opt/ploinky:ro" \
            -v /opt/ploinky/node_modules \
            ploinky-box:verify \
            podman run --rm docker.io/assistos/webtty-agent:node24 \
              node -e "require('node-pty'); console.log('webtty-runtime-ok')"
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `node --test tests/image-definitions.test.mjs`
Expected: PASS — all 10 tests, including the mount-contract assertions from Step 1.

- [ ] **Step 4: Lint the workflow YAML**

Run: `command -v actionlint >/dev/null && actionlint .github/workflows/publish-ploinky-box-image.yml || echo 'actionlint not installed - skipped'`
Expected: actionlint passes or is skipped.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/publish-ploinky-box-image.yml tests/image-definitions.test.mjs
git commit -m "Verify ploinky-box mount contract instead of baked contents"
```

### Task 10: container-image-builds README contract update

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: the new image contract (Tasks 8–9).
- Produces: accurate published documentation.

- [ ] **Step 1: Update the images table row**

Replace the `assistos/ploinky-box:podman-node24` row with:

```markdown
| `assistos/ploinky-box:podman-node24` | runtime-only (Ploinky mounted at run time) | repo root | `images/ploinky-box/Dockerfile` | `publish-ploinky-box-image.yml` |
```

- [ ] **Step 2: Update the note under the table**

Replace the sentence "The `bwrap-runner`, `livekit-server-agent`, and `ploinky-box` workflows check out their source repositories under `sources/` and build with the Dockerfiles in this repository." with:

```markdown
The `bwrap-runner` and `livekit-server-agent` workflows check out their source
repositories under `sources/` and build with the Dockerfiles in this
repository. The `ploinky-box` workflow also checks out `AssistOS-AI/ploinky`
under `sources/`, but only to verify the image: the image itself bakes no
Ploinky source. It provides the box runtime (Node 24, npm, git, nested podman,
slirp4netns, and the `/etc/ploinky-box` marker file that switches `ploinky`
into its in-box direct mode) and expects the ploinky-box wrapper to bind-mount
a host ploinky checkout read-only at `/opt/ploinky` with a writable dependency
volume at `/opt/ploinky/node_modules`. Agent runtimes such as WebTTY's
node-pty ship in their own agent images (`assistos/webtty-agent`), pulled by
the nested podman at run time.
```

- [ ] **Step 3: Verify and commit**

Run: `node --test tests/image-definitions.test.mjs`
Expected: PASS (tests do not read README, but rerun to confirm nothing regressed).

```bash
git add README.md
git commit -m "Document runtime-only ploinky-box image contract"
```

---

# Part 3 — Integration

### Task 11: Local end-to-end verification and publish

**Files:**
- No lasting file changes; this task exercises both repos together. Step 5 creates an untracked `.hostcore-probe-*` file and removes it with a trap. Record the outcome (date, host, engine version, pass/fail per step) in the PR description or a follow-up commit to `container/README.md`'s smoke note if the team keeps that convention.

**Interfaces:**
- Consumes: everything from Tasks 1–10.
- Produces: a locally verified image + wrapper pair, then a published image.

- [ ] **Step 1: Build the new image locally**

```bash
cd /Users/danielsava/work/file-parser/container-image-builds
podman build -f images/ploinky-box/Dockerfile -t ploinky-box:dev .
```

Expected: build succeeds with **no** `sources/ploinky` in the context (the Dockerfile no longer references it, so no checkout is needed to build).

- [ ] **Step 2: Confirm the image has no baked ploinky and carries the marker**

```bash
podman run --rm --user podman --entrypoint bash ploinky-box:dev -lc 'test -z "$(ls -A /opt/ploinky)" && test -f /etc/ploinky-box && echo EMPTY-AND-MARKED-OK'
```

Expected: `EMPTY-AND-MARKED-OK`

- [ ] **Step 3: First-run decline path (non-interactive)**

```bash
cd /Users/danielsava/work/file-parser/ploinky
./container/ploinky-box --name hostcore --image ploinky-box:dev up </dev/null
set +e
podman exec ploinky-box-hostcore ploinky help
code=$?
set -e
echo "exit=$code"
```

Expected: `up` succeeds (self-check OK; stdin is closed so the wrapper prints its warning and does not prompt); the `podman exec` prints `WARNING: Ploinky cannot run until dependencies are installed.` and `exit=1` — proving the marker routes in-box `ploinky` to the direct CLI with no env vars involved.

- [ ] **Step 4: Confirm path (interactive prompt)**

```bash
podman exec -it ploinky-box-hostcore ploinky help
```

Type `y` at `Ploinky dependencies are not installed. Install them now? [y/N]`.
Expected: npm install output, then ploinky's help text. Re-running the command shows help immediately (deps persist in the `ploinky-box-hostcore-ploinky-deps` volume).

- [ ] **Step 5: Host-edit visibility without rebuild**

```bash
probe=".hostcore-probe-$$"
trap 'rm -f "$probe"' EXIT
printf 'hostcore-probe\n' > "$probe"
podman exec ploinky-box-hostcore cat "/opt/ploinky/$probe"
rm -f "$probe"
trap - EXIT
```

Expected: `hostcore-probe` — a host edit is visible inside the running box with no image rebuild, without touching any tracked source file.

- [ ] **Step 6: Read-only enforcement**

```bash
podman exec ploinky-box-hostcore sh -lc 'touch /opt/ploinky/probe 2>&1; echo "exit=$?"'
```

Expected: `Read-only file system` error and `exit=1`.

- [ ] **Step 7: Full smoke and cleanup**

```bash
./container/ploinky-box --name hostcore destroy   # answer y; removes all three volumes
SMOKE_IMAGE=ploinky-box:dev node container/smoke-box.mjs
```

Expected: smoke prints `PASS` for every step (deps auto-install via the smoke's `PLOINKY_BOX_INSTALL_DEPS=1` opt-in) and exits 0.

- [ ] **Step 8: Publish**

Merge the `container-image-builds` branch, then:

```bash
gh workflow run publish-ploinky-box-image.yml \
  --repo AssistOS-AI/container-image-builds \
  -f source_ref=<ploinky branch with Tasks 1-7, e.g. ploinky-box or master once merged> \
  -f image_tag=podman-node24
```

Expected: workflow green, including `IMAGE-OK`, `MOUNT-OK`, and the non-zero decline check. Note: the verification checkout ref must contain the Part 1 changes (single-entry `bin/ploinky`, `bin/ploinky-install-deps`); publish after the ploinky branch is pushed.

---

## Acceptance criteria traceability

| Acceptance criterion | Covered by |
| --- | --- |
| Host core edits need no image rebuild | Tasks 1, 8; verified in Task 11 Step 5 |
| Image has no baked `/opt/ploinky` checkout | Task 8; CI `test -z "$(ls -A /opt/ploinky)"` (Task 9); Task 11 Step 2 |
| Box start mounts host `ploinky` read-only | Task 1 (`-v <src>:/opt/ploinky:ro`); Task 11 Step 6 |
| Container uses mounted code via PATH | Image keeps `ENV PATH=/opt/ploinky/bin:$PATH` (Task 8); CI runs bare `ploinky help` (Task 9) |
| Writable dependency location despite ro source | Tasks 1–3 (deps volume + `:U`/chown + installer); CI step 2 of "Verify mounted-source contract" |
| First `ploinky` run detects missing deps | Task 4 in-box gate + Task 2 wrapper probe |
| Confirm → install → continue | Task 4 (`y` → installer → exec CLI); Task 11 Step 4 |
| Decline → non-zero + clear warning | Task 4; CI decline check (Task 9); Task 11 Step 3 |
| Non-interactive defaults to no | Task 4 (`[[ -t 0 ]]` gate); CI decline check runs without a TTY |
| `bin/ploinky-direct` and `PLOINKY_BOX`/`PLOINKY_DIRECT` removed, no compat | Tasks 1, 4, 5, 7; straggler greps in Task 4 Step 6, Task 5 Step 3, Task 7 Step 5 |
| WebTTY stays in the image/runtime layer | Task 8 (runtime tools + comment), Task 9 WebTTY runtime check, Global Constraints rationale |
| Dockerfile, entrypoint, workflow, wrapper, tests, docs all covered | Tasks 8, 8, 9, 1–2, 1–5, 7+10 respectively |

## Verification command summary

ploinky repo (`/Users/danielsava/work/file-parser/ploinky`):

```bash
node container/wrapper-tests.mjs        # wrapper + installer + entry-contract tests (engine-free)
node --test tests/unit/*.test.mjs tests/unit/*.test.js   # full unit suite incl. wrapper shim, exit codes, container runtime
bash -n bin/ploinky bin/ploinky-install-deps
rg -n "PLOINKY_BOX([^_A-Z]|$)|PLOINKY_DIRECT|ploinky-direct" --glob '!node_modules' --glob '!docs/superpowers' --glob '!container/wrapper-tests.mjs' --glob '!docs/*.html' --glob '!docs/*.md' .   # expect: no output
node cli/index.js help >/dev/null && echo DIRECT-OK   # host-side direct CLI path
```

container-image-builds repo (`/Users/danielsava/work/file-parser/container-image-builds`):

```bash
node --test tests/image-definitions.test.mjs
bash -n images/ploinky-box/entrypoint.sh
podman build -f images/ploinky-box/Dockerfile -t ploinky-box:dev .   # optional local build
```

End-to-end: Task 11 (local image + wrapper, then publish workflow).
