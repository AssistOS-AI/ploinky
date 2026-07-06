# Ploinky Box as Ploinky Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `bin/ploinky` the boxed-by-default public entrypoint while preserving existing `ploinky ...` command syntax.

**Architecture:** Keep the existing `container/ploinky-box.mjs` wrapper as the box lifecycle implementation, but add a public `ploinky` mode that forwards bare commands into the box and reserves `ploinky box ...` for outer lifecycle. Add a direct CLI escape so the same `bin/ploinky` script runs the normal Node CLI when already inside the box (`PLOINKY_BOX=1`) or when explicitly requested (`PLOINKY_DIRECT=1`).

**Tech Stack:** Bash entrypoint scripts, Node.js ES modules, `node:test`, dry-run wrapper tests, Podman/Docker wrapper smoke.

---

## File Structure

- Modify `bin/ploinky`: public host entrypoint. It detects `PLOINKY_BOX=1` / `PLOINKY_DIRECT=1` and otherwise delegates to `container/ploinky-box.mjs` with `PLOINKY_PUBLIC_ENTRYPOINT=1`.
- Create `bin/ploinky-direct`: old direct Node CLI behavior, including the shell shortcut and dependency check.
- Modify `container/ploinky-box.mjs`: add public `ploinky` mode, public help text, `box` namespace routing, in-box command forwarding, and start passthrough args.
- Modify `container/wrapper-tests.mjs`: add engine-free tests for public-mode routing, entrypoint guard behavior, p-cli/psh alias behavior, and compatibility mode.
- Modify `container/smoke-box.mjs`: optionally exercise the normal `bin/ploinky` path in addition to the compatibility `ploinky-box` path when `SMOKE_PUBLIC_PLOINKY=1`.
- Modify `container/README.md`: document that `ploinky` is now the preferred public command and `ploinky box ...` controls the outer box.
- Modify `README.md`: update quick-start/PATH guidance so users expect boxed-by-default behavior and know about `PLOINKY_DIRECT=1`.

---

### Task 1: Add the Direct CLI Escape and Public Entrypoint Shell Shim

**Files:**
- Modify: `bin/ploinky`
- Create: `bin/ploinky-direct`
- Modify: `container/wrapper-tests.mjs`

- [ ] **Step 1: Write failing shell-entrypoint tests**

Add these helpers near the top of `container/wrapper-tests.mjs`, after the existing `const MJS = ...` declarations:

```js
const PLOINKY = path.join(HERE, '..', 'bin', 'ploinky');
const PCLI = path.join(HERE, '..', 'bin', 'p-cli');
const PSH = path.join(HERE, '..', 'bin', 'psh');

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
  ${JSON.stringify(realNode)} -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$arg" >> ${JSON.stringify(capture)}
done
printf '],"PLOINKY_PUBLIC_ENTRYPOINT":' >> ${JSON.stringify(capture)}
${JSON.stringify(realNode)} -e 'process.stdout.write(JSON.stringify(process.env.PLOINKY_PUBLIC_ENTRYPOINT || ""))' >> ${JSON.stringify(capture)}
printf ',"PLOINKY_BOX":' >> ${JSON.stringify(capture)}
${JSON.stringify(realNode)} -e 'process.stdout.write(JSON.stringify(process.env.PLOINKY_BOX || ""))' >> ${JSON.stringify(capture)}
printf ',"PLOINKY_DIRECT":' >> ${JSON.stringify(capture)}
${JSON.stringify(realNode)} -e 'process.stdout.write(JSON.stringify(process.env.PLOINKY_DIRECT || ""))' >> ${JSON.stringify(capture)}
printf '}' >> ${JSON.stringify(capture)}
exit 0
`);
    fs.chmodSync(node, 0o755);
    return { dir, capture };
}

function readCapture(capture) {
    return JSON.parse(fs.readFileSync(capture, 'utf8'));
}
```

Add these tests near the existing `entrypoint bash syntax check` test:

```js
test('public bin/ploinky delegates to the box wrapper on the host', () => {
    const fake = makeFakeNodeCapture();
    try {
        const env = {
            ...process.env,
            PATH: `${fake.dir}:${process.env.PATH || ''}`,
            PLOINKY_BOX_ENGINE: 'podman',
        };
        delete env.PLOINKY_BOX;
        delete env.PLOINKY_DIRECT;
        const r = spawnSync(PLOINKY, ['status', '--dry-run'], { encoding: 'utf8', env });
        assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
        const captured = readCapture(fake.capture);
        assert.ok(captured.argv[0].endsWith('/container/ploinky-box.mjs'), captured.argv);
        assert.deepEqual(captured.argv.slice(1), ['status', '--dry-run']);
        assert.equal(captured.PLOINKY_PUBLIC_ENTRYPOINT, '1');
    } finally {
        fs.rmSync(fake.dir, { recursive: true, force: true });
    }
});

test('bin/ploinky runs direct CLI inside the box', () => {
    const fake = makeFakeNodeCapture();
    try {
        const env = {
            ...process.env,
            PATH: `${fake.dir}:${process.env.PATH || ''}`,
            PLOINKY_BOX: '1',
        };
        delete env.PLOINKY_DIRECT;
        const r = spawnSync(PLOINKY, ['status'], { encoding: 'utf8', env });
        assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
        const captured = readCapture(fake.capture);
        assert.ok(captured.argv[0].endsWith('/cli/index.js'), captured.argv);
        assert.deepEqual(captured.argv.slice(1), ['status']);
        assert.equal(captured.PLOINKY_BOX, '1');
        assert.equal(captured.PLOINKY_PUBLIC_ENTRYPOINT, '');
    } finally {
        fs.rmSync(fake.dir, { recursive: true, force: true });
    }
});

test('bin/ploinky supports explicit PLOINKY_DIRECT escape on the host', () => {
    const fake = makeFakeNodeCapture();
    try {
        const env = {
            ...process.env,
            PATH: `${fake.dir}:${process.env.PATH || ''}`,
            PLOINKY_DIRECT: '1',
        };
        delete env.PLOINKY_BOX;
        const r = spawnSync(PLOINKY, ['list', 'agents'], { encoding: 'utf8', env });
        assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
        const captured = readCapture(fake.capture);
        assert.ok(captured.argv[0].endsWith('/cli/index.js'), captured.argv);
        assert.deepEqual(captured.argv.slice(1), ['list', 'agents']);
        assert.equal(captured.PLOINKY_DIRECT, '1');
    } finally {
        fs.rmSync(fake.dir, { recursive: true, force: true });
    }
});

test('p-cli still delegates through bin/ploinky', () => {
    const fake = makeFakeNodeCapture();
    try {
        const env = {
            ...process.env,
            PATH: `${fake.dir}:${process.env.PATH || ''}`,
            PLOINKY_BOX_ENGINE: 'podman',
        };
        delete env.PLOINKY_BOX;
        delete env.PLOINKY_DIRECT;
        const r = spawnSync(PCLI, ['status', '--dry-run'], { encoding: 'utf8', env });
        assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
        const captured = readCapture(fake.capture);
        assert.ok(captured.argv[0].endsWith('/container/ploinky-box.mjs'), captured.argv);
        assert.deepEqual(captured.argv.slice(1), ['status', '--dry-run']);
        assert.equal(captured.PLOINKY_PUBLIC_ENTRYPOINT, '1');
    } finally {
        fs.rmSync(fake.dir, { recursive: true, force: true });
    }
});

test('psh still delegates to ploinky sh', () => {
    const pshText = fs.readFileSync(PSH, 'utf8');
    assert.ok(pshText.includes('"$SCRIPT_DIR/ploinky" sh "$@"'), pshText);
});
```

- [ ] **Step 2: Run the focused tests and confirm failure**

Run:

```bash
node container/wrapper-tests.mjs
```

Expected: FAIL. The new tests should fail because `bin/ploinky` still runs the direct CLI on the host and `bin/ploinky-direct` does not exist yet.

- [ ] **Step 3: Create `bin/ploinky-direct` with the old direct behavior**

Create `bin/ploinky-direct`:

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_PATH="$(readlink -f "$0" 2>/dev/null || true)"
if [[ -z "$SCRIPT_PATH" ]]; then
    SCRIPT_PATH="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
fi
SCRIPT_DIR="$(dirname "$SCRIPT_PATH")"
export PLOINKY_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ ! -d "$PLOINKY_ROOT/node_modules/achillesAgentLib" ]]; then
    echo "Ploinky dependency missing: $PLOINKY_ROOT/node_modules/achillesAgentLib" >&2
    echo "Run 'npm install' from $PLOINKY_ROOT before running ploinky." >&2
    exit 1
fi

if [[ "${1:-}" == "-shell" || "${1:-}" == "sh" || "${1:-}" == "--shell" ]]; then
    shift
    exec "$SCRIPT_DIR/ploinky-shell" "$@"
fi

exec node "$PLOINKY_ROOT/cli/index.js" "$@"
```

Then make it executable:

```bash
chmod +x bin/ploinky-direct
```

- [ ] **Step 4: Replace `bin/ploinky` with the boxed-by-default dispatcher**

Replace `bin/ploinky` with:

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_PATH="$(readlink -f "$0" 2>/dev/null || true)"
if [[ -z "$SCRIPT_PATH" ]]; then
    SCRIPT_PATH="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
fi
SCRIPT_DIR="$(dirname "$SCRIPT_PATH")"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ "${PLOINKY_BOX:-}" == "1" || "${PLOINKY_DIRECT:-}" == "1" ]]; then
    exec "$SCRIPT_DIR/ploinky-direct" "$@"
fi

if ! command -v node >/dev/null 2>&1; then
    echo "ploinky: node >= 20 is required for the boxed wrapper (https://nodejs.org)." >&2
    echo "Inside the box, or with PLOINKY_DIRECT=1, ploinky runs the direct Node CLI." >&2
    exit 1
fi

export PLOINKY_PUBLIC_ENTRYPOINT=1
exec node "$ROOT_DIR/container/ploinky-box.mjs" "$@"
```

- [ ] **Step 5: Run syntax and focused tests**

Run:

```bash
bash -n bin/ploinky
bash -n bin/ploinky-direct
node container/wrapper-tests.mjs
```

Expected: the shell syntax checks pass. Some public-mode wrapper tests may still fail until Task 2, but the entrypoint guard tests from this task should pass.

- [ ] **Step 6: Commit Task 1**

Run:

```bash
git add bin/ploinky bin/ploinky-direct container/wrapper-tests.mjs
git commit -m "Make ploinky dispatch through the boxed wrapper"
```

---

### Task 2: Add Public `ploinky` Routing Mode to the Wrapper

**Files:**
- Modify: `container/ploinky-box.mjs`
- Modify: `container/wrapper-tests.mjs`

- [ ] **Step 1: Add failing public-mode wrapper tests**

Add these helpers near `boxRunIn` in `container/wrapper-tests.mjs`:

```js
function publicRun(engine, ...args) {
    const r = spawnSync(MJS, args, {
        encoding: 'utf8',
        env: { ...process.env, PLOINKY_BOX_ENGINE: engine, PLOINKY_PUBLIC_ENTRYPOINT: '1' },
    });
    return { out: `${r.stdout ?? ''}${r.stderr ?? ''}`, status: r.status };
}

function publicRunIn(cwd, engine, ...args) {
    const r = spawnSync(MJS, args, {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, PLOINKY_BOX_ENGINE: engine, PLOINKY_PUBLIC_ENTRYPOINT: '1' },
    });
    return { out: `${r.stdout ?? ''}${r.stderr ?? ''}`, status: r.status };
}
```

Add these tests after the existing `usage text still documents every command and flag` test:

```js
test('public usage describes ploinky and box namespace', () => {
    const r = spawnSync(process.execPath, [MJS, '--help'], {
        encoding: 'utf8',
        env: { ...process.env, PLOINKY_PUBLIC_ENTRYPOINT: '1' },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes('Usage: ploinky [flags] [command] [args]'), r.stdout);
    assert.ok(r.stdout.includes('ploinky box status'), r.stdout);
    assert.ok(r.stdout.includes('PLOINKY_DIRECT=1'), r.stdout);
});

test('public status routes to in-box ploinky status, not outer box status', () => {
    const { parent, dir } = makeCwd('testExplorerFresh');
    try {
        const { out, status } = publicRunIn(dir, 'podman', 'status', '--dry-run');
        assert.equal(status, 0, out);
        checkIncludes(out, 'DRY-RUN: podman run -d', 'public status creates/starts the box first');
        checkIncludes(out, 'exec -w /workspace ploinky-box-testExplorerFresh ploinky status', 'public status runs in-box status');
        checkAbsent(out, "'ploinky-box-testExplorerFresh' does not exist.", 'public status is not outer status');
    } finally {
        fs.rmSync(parent, { recursive: true, force: true });
    }
});

test('public destroy routes to in-box ploinky destroy, not outer volume removal', () => {
    const { out, status } = publicRun('podman', '--name', 'qa', 'destroy', '--dry-run');
    assert.equal(status, 0, out);
    checkIncludes(out, 'exec -w /workspace ploinky-box-qa ploinky destroy', 'public destroy runs in-box destroy');
    checkAbsent(out, 'volume rm ploinky-box-qa-workspace', 'public destroy does not remove outer volumes');
});

test('public box status targets the outer box status command', () => {
    const { out, status } = publicRun('podman', '--name', 'qa', 'box', 'status', '--dry-run');
    assert.equal(status, 1, out);
    checkIncludes(out, "'ploinky-box-qa' does not exist.", 'box status uses outer status behavior');
    checkAbsent(out, 'ploinky status', 'box status does not forward to in-box status');
});

test('public box destroy targets the outer volume destroy command', () => {
    const { out, status } = publicRun('podman', '--name', 'qa', 'box', 'destroy', '--dry-run');
    assert.equal(status, 0, out);
    checkIncludes(out, 'volume rm ploinky-box-qa-workspace ploinky-box-qa-containers', 'box destroy removes outer volumes');
    checkAbsent(out, 'ploinky destroy', 'box destroy does not run in-box destroy');
});

test('public no-arg command opens in-box p-cli', () => {
    const { out, status } = publicRun('podman', '--name', 'qa', '--dry-run');
    assert.equal(status, 0, out);
    checkIncludes(out, 'DRY-RUN: podman run -d', 'no-arg public command ensures box');
    checkIncludes(out, 'exec -it -w /workspace ploinky-box-qa p-cli', 'no-arg public command opens p-cli');
});

test('public start preserves branch flags while forcing in-box router to 8080', () => {
    const { out, status } = publicRun(
        'podman',
        '--name', 'qa',
        'start', 'explorer', '9191',
        '--branch', 'feature-x',
        '--repo-branch', 'AssistOSExplorer=peristo-user',
        '--branch-fallback', 'fail',
        '--dry-run',
    );
    assert.equal(status, 0, out);
    checkIncludes(out, '127.0.0.1:9191:8080', 'public start positional port is host port');
    checkIncludes(
        out,
        'exec -w /workspace ploinky-box-qa ploinky start explorer 8080 --branch feature-x --repo-branch AssistOSExplorer=peristo-user --branch-fallback fail',
        'public start forwards branch flags after in-box port',
    );
    checkAbsent(out, 'ploinky start explorer 9191', 'public start never uses host port inside');
});

test('ploinky-box compatibility status remains outer status', () => {
    const { out, status } = boxRun('podman', '--name', 'qa', '--dry-run', 'status');
    assert.equal(status, 1, out);
    checkIncludes(out, "'ploinky-box-qa' does not exist.", 'compatibility status remains outer status');
    checkAbsent(out, 'ploinky status', 'compatibility status is not forwarded');
});
```

- [ ] **Step 2: Run focused tests and confirm failure**

Run:

```bash
node container/wrapper-tests.mjs
```

Expected: FAIL. Public-mode tests should fail because `PLOINKY_PUBLIC_ENTRYPOINT=1` is not handled yet and `cmdStart` rejects extra branch arguments.

- [ ] **Step 3: Add mode-aware help and program naming**

In `container/ploinky-box.mjs`, add these constants after `BOX_PREFIX`:

```js
const PUBLIC_ENTRYPOINT_ENV = 'PLOINKY_PUBLIC_ENTRYPOINT';
const PUBLIC_PROGRAM = 'ploinky';
const BOX_PROGRAM = 'ploinky-box';
const BOX_COMMANDS = new Set(['up', 'start', 'cli', 'run', 'cp', 'status', 'logs', 'stop', 'update', 'destroy', 'help']);
let activeProgramName = BOX_PROGRAM;
```

Replace `usageText()` with a mode-aware version:

```js
export function usageText(options = {}) {
    const publicEntrypoint = Boolean(options.publicEntrypoint);
    if (publicEntrypoint) {
        return `ploinky - run Ploinky through the boxed runtime

Usage: ploinky [flags] [command] [args]

Normal commands keep their existing Ploinky syntax and execute inside the box:
  ploinky start <agent> [port]
  ploinky status
  ploinky stop
  ploinky destroy
  ploinky logs
  ploinky install ...
  ploinky list agents
  ploinky

Outer box lifecycle is explicit:
  ploinky box up
  ploinky box status
  ploinky box logs
  ploinky box stop
  ploinky box update
  ploinky box destroy
  ploinky box cp A B

Flags:
  --name X       Instance name (container ploinky-box-X). Default: inferred
                 from the current directory basename.
  --port N       Host port for the router (default 8080).
                 Inside the box, always start the router on port 8080.
  --publish SPEC Extra host-to-box port publish; repeatable, same form as -p.
  --webmeet-ports
                 Publish local LiveKit/TURN ports used by WebMeet rooms/media.
  --image I      Image override (default docker.io/assistos/ploinky-box:podman-node24)
  --mount DIR    Bind DIR read-write at /workspace/mounted (pierces isolation)
  --listen-lan   Publish the router on 0.0.0.0 instead of 127.0.0.1
  --engine E     podman|docker (default: auto-detect, podman first)
  --dry-run      Print engine commands instead of executing
  -h, --help     This help

Direct development escape:
  PLOINKY_DIRECT=1 ploinky <args>
`;
    }
    return `ploinky-box - run Ploinky isolated in a rootless-podman container

Usage: ploinky-box [flags] <command> [args]

Commands:
  up         Create/start the box (pulls the image on first use)
  start <agent> [port]
             Create/start the box, then run 'ploinky start <agent> 8080'
             inside and wait for the router; [port] = host port (default 8080)
  cli        Interactive Ploinky console (p-cli) inside the box
  run <...>  One-shot ploinky command, e.g.: ploinky-box run start webtty 8080
  cp A B     Copy in/out; prefix the container side with box:
             e.g. ploinky-box cp ./file box:/workspace/file
  status     Container state + router probe
  logs       Show recent .ploinky logs from the box
  stop       Stop the box (volumes kept)
  update     Pull a newer image and recreate the box (volumes kept);
             pass the same flags you used with up
  destroy    Remove the box AND its volumes (asks for confirmation)

Flags:
  --name X       Instance name (container ploinky-box-X). Default: inferred
                 from the current directory basename.
  --port N       Host port for the router (default 8080).
                 Inside the box, always start the router on port 8080.
  --publish SPEC Extra host-to-box port publish; repeatable, same form as -p.
  --webmeet-ports
                 Publish local LiveKit/TURN ports used by WebMeet rooms/media.
  --image I      Image override (default docker.io/assistos/ploinky-box:podman-node24)
  --mount DIR    Bind DIR read-write at /workspace/mounted (pierces isolation)
  --listen-lan   Publish the router on 0.0.0.0 instead of 127.0.0.1
  --engine E     podman|docker (default: auto-detect, podman first)
  --dry-run      Print the engine command for up/run/cp instead of executing
  -h, --help     This help
`;
}
```

Change `die` to use the active program name:

```js
function die(msg) {
    process.stderr.write(`${activeProgramName}: ${msg}\n`);
    process.exit(1);
}
```

Add:

```js
export function isPublicEntrypoint(env = process.env) {
    return String(env?.[PUBLIC_ENTRYPOINT_ENV] || '') === '1';
}
```

- [ ] **Step 4: Make `cmdStart` preserve extra start flags**

Replace the first lines of `cmdStart` with:

```js
async function cmdStart(cfg) {
    const [agent, ...rest] = cfg.args;
    if (!agent) die(`usage: ${activeProgramName} start <agent> [port]`);
    let portArg;
    const passthroughArgs = [];
    if (rest.length > 0) {
        if (!String(rest[0]).startsWith('-')) {
            portArg = rest[0];
            passthroughArgs.push(...rest.slice(1));
        } else {
            passthroughArgs.push(...rest);
        }
    }
    if (portArg !== undefined) {
        if (cfg.portExplicit && cfg.port !== portArg) {
            die(`start: conflicting host ports (--port ${cfg.port} vs argument ${portArg}); give the port once`);
        }
        cfg.port = portArg;
    }
    if (!/^\d+$/.test(cfg.port)) die(`start: host port must be a number, got '${cfg.port}'`);
    await cmdUp(cfg);
    const published = cfg.dryRun ? cfg.port : (hostPort(cfg) || cfg.port);
    if (!cfg.dryRun && published !== cfg.port) {
        process.stderr.write(`${activeProgramName}: note: existing box publishes host port ${published}; the requested port applies only when the box is created. To change it, run ${activeProgramName} box update/recreate with the same flags you used for up plus --port ${cfg.port}.\n`);
    }
    runEngine(cfg, ['exec', '-w', '/workspace', instanceName(cfg), 'ploinky', 'start', agent, '8080', ...passthroughArgs]);
```

Keep the existing router probe block after this line unchanged except for any `ploinky-box:` wording that should use `activeProgramName`.

- [ ] **Step 5: Add public-mode command execution**

Add these helpers before `main()`:

```js
function assertBoxCommand(cfg) {
    if (!BOX_COMMANDS.has(cfg.command)) {
        die(`unknown box command '${cfg.command}' (see: ${activeProgramName} box --help)`);
    }
}

async function runBoxCommand(cfg) {
    assertBoxCommand(cfg);
    if (!(cfg.command === 'status' && cfg.dryRun)) detectEngine(cfg);
    if (cfg.command !== 'help') resolveInstanceIdentity(cfg);
    switch (cfg.command) {
        case 'up': await cmdUp(cfg); break;
        case 'start': await cmdStart(cfg); break;
        case 'cli': cmdCli(cfg); break;
        case 'run': cmdRun(cfg); break;
        case 'cp': cmdCp(cfg); break;
        case 'status': process.exitCode = await cmdStatus(cfg); break;
        case 'logs': cmdLogs(cfg); break;
        case 'stop': cmdStop(cfg); break;
        case 'update': await cmdUpdate(cfg); break;
        case 'destroy': await cmdDestroy(cfg); break;
        case 'help': process.stdout.write(usageText({ publicEntrypoint: false })); break;
    }
}

function cmdForwardToPloinky(cfg, forwardedArgs) {
    preflight(cfg);
    requireRunning(cfg);
    runEngine(cfg, ['exec', '-w', '/workspace', instanceName(cfg), 'ploinky', ...forwardedArgs]);
}

async function runPublicCommand(cfg) {
    if (cfg.command === 'box') {
        cfg.command = cfg.args.shift() || 'help';
        await runBoxCommand(cfg);
        return;
    }
    detectEngine(cfg);
    resolveInstanceIdentity(cfg);
    if (!cfg.command) {
        await cmdUp(cfg);
        cmdCli(cfg);
        return;
    }
    if (cfg.command === 'start') {
        await cmdStart(cfg);
        return;
    }
    await cmdUp(cfg);
    cmdForwardToPloinky(cfg, [cfg.command, ...cfg.args]);
}
```

Refactor `main()` to select public or compatibility mode:

```js
async function main() {
    const major = Number(process.versions.node.split('.')[0]);
    if (major < 20) die(`Node >= 20 is required (found ${process.versions.node})`);
    const publicEntrypoint = isPublicEntrypoint();
    activeProgramName = publicEntrypoint ? PUBLIC_PROGRAM : BOX_PROGRAM;
    const cfg = parseCli(process.argv.slice(2));
    if (cfg.help) {
        process.stdout.write(usageText({ publicEntrypoint }));
        process.exit(0);
    }
    if (publicEntrypoint) {
        await runPublicCommand(cfg);
        return;
    }
    if (!cfg.command) {
        process.stdout.write(usageText({ publicEntrypoint: false }));
        process.exit(1);
    }
    await runBoxCommand(cfg);
}
```

- [ ] **Step 6: Run focused tests**

Run:

```bash
node container/wrapper-tests.mjs
```

Expected: PASS for public routing, compatibility routing, and shell-entrypoint tests.

- [ ] **Step 7: Commit Task 2**

Run:

```bash
git add container/ploinky-box.mjs container/wrapper-tests.mjs
git commit -m "Route ploinky commands through the box"
```

---

### Task 3: Update Smoke Coverage for the Public `ploinky` Path

**Files:**
- Modify: `container/smoke-box.mjs`
- Modify: `container/wrapper-tests.mjs`

- [ ] **Step 1: Add failing smoke public-path support test**

Add this test to `container/wrapper-tests.mjs`:

```js
test('smoke script documents optional public ploinky path', () => {
    const smokeText = fs.readFileSync(path.join(HERE, 'smoke-box.mjs'), 'utf8');
    assert.ok(smokeText.includes('SMOKE_PUBLIC_PLOINKY'), smokeText);
    assert.ok(smokeText.includes('bin/ploinky'), smokeText);
});
```

- [ ] **Step 2: Run focused tests and confirm failure**

Run:

```bash
node container/wrapper-tests.mjs
```

Expected: FAIL because `container/smoke-box.mjs` does not mention `SMOKE_PUBLIC_PLOINKY` yet.

- [ ] **Step 3: Modify `container/smoke-box.mjs` to support public path**

Change the constants at the top:

```js
const BOX = path.join(HERE, 'ploinky-box');
const PUBLIC_PLOINKY = path.join(HERE, '..', 'bin', 'ploinky');
const USE_PUBLIC_PLOINKY = process.env.SMOKE_PUBLIC_PLOINKY === '1';
```

Add this helper after `function box(...args)`:

```js
function publicPloinky(...args) {
    return spawnSync(PUBLIC_PLOINKY, args, { stdio: 'inherit' }).status === 0;
}
```

After the existing `console.log(...)` line, add:

```js
console.log(`publicPloinky=${USE_PUBLIC_PLOINKY ? 'enabled' : 'disabled'}`);
```

Replace the existing start-command smoke step:

```js
step('start command (idempotent on a running box)', box('--name', NAME, 'start', AGENT));
```

with:

```js
if (USE_PUBLIC_PLOINKY) {
    step(
        'public ploinky start command (idempotent on a running box)',
        publicPloinky('--name', NAME, '--port', PORT, 'start', AGENT),
    );
    step('public ploinky status command', publicPloinky('--name', NAME, 'status'));
    step('public ploinky box status command', publicPloinky('--name', NAME, 'box', 'status'));
} else {
    step('start command (idempotent on a running box)', box('--name', NAME, 'start', AGENT));
}
```

- [ ] **Step 4: Run smoke script syntax and focused tests**

Run:

```bash
node --check container/smoke-box.mjs
node container/wrapper-tests.mjs
```

Expected: both pass.

- [ ] **Step 5: Commit Task 3**

Run:

```bash
git add container/smoke-box.mjs container/wrapper-tests.mjs
git commit -m "Exercise public ploinky path in box smoke"
```

---

### Task 4: Update Public Documentation

**Files:**
- Modify: `container/README.md`
- Modify: `README.md`

- [ ] **Step 1: Add failing documentation assertions**

Add this test to `container/wrapper-tests.mjs`:

```js
test('docs describe boxed-by-default ploinky and direct escape', () => {
    const rootReadme = fs.readFileSync(path.join(HERE, '..', 'README.md'), 'utf8');
    const boxReadme = fs.readFileSync(path.join(HERE, 'README.md'), 'utf8');
    assert.ok(rootReadme.includes('PLOINKY_DIRECT=1'), rootReadme);
    assert.ok(rootReadme.includes('ploinky box status'), rootReadme);
    assert.ok(boxReadme.includes('ploinky box destroy'), boxReadme);
    assert.ok(boxReadme.includes('ploinky-box compatibility'), boxReadme);
});
```

- [ ] **Step 2: Run focused tests and confirm failure**

Run:

```bash
node container/wrapper-tests.mjs
```

Expected: FAIL because the docs do not yet describe boxed-by-default `ploinky`.

- [ ] **Step 3: Update `container/README.md`**

Make these content changes:

1. Change the title from `# ploinky-box` to:

```md
# Boxed Ploinky Runtime
```

2. Add this paragraph after the opening description:

```md
`ploinky` is the preferred public entrypoint when using this checkout. It runs
normal Ploinky commands through the boxed runtime by default. `ploinky-box`
remains as a compatibility and diagnostic command for the wrapper itself.
```

3. Add this subsection before the existing `## Commands` section:

````md
## Public `ploinky` command

Bare `ploinky ...` commands keep their existing Ploinky meaning and execute
inside the box:

```bash
ploinky start explorer
ploinky status
ploinky stop
ploinky destroy
ploinky logs
ploinky install ...
```

Outer box lifecycle commands use the explicit `box` namespace:

```bash
ploinky box status
ploinky box stop
ploinky box update
ploinky box destroy
```

`ploinky destroy` runs the normal in-box Ploinky destroy command. `ploinky box
destroy` removes the outer container and the two named volumes for the selected
instance.
````

4. Rename `## Commands` to:

```md
## `ploinky-box` compatibility commands
```

5. Add this sentence under that heading:

```md
These commands remain available for direct wrapper diagnostics and standalone
downloads; public users should prefer `ploinky ...` and `ploinky box ...`.
```

- [ ] **Step 4: Update `README.md`**

In the usage/PATH section, add:

```md
By default, `ploinky` now runs through the boxed runtime. Existing commands keep
their syntax, but agents run as nested containers inside one outer box container.

Use `ploinky box status`, `ploinky box stop`, `ploinky box update`, and
`ploinky box destroy` for the outer container lifecycle. Bare commands such as
`ploinky status`, `ploinky stop`, and `ploinky destroy` are forwarded to the
normal Ploinky CLI inside the box.

For local CLI development or emergency direct-mode debugging:

```bash
PLOINKY_DIRECT=1 ploinky <args>
```
```

- [ ] **Step 5: Run docs tests**

Run:

```bash
node container/wrapper-tests.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit Task 4**

Run:

```bash
git add README.md container/README.md container/wrapper-tests.mjs
git commit -m "Document boxed ploinky entrypoint"
```

---

### Task 5: Final Verification and Plan Ledger

**Files:**
- Modify: `docs/superpowers/plans/2026-07-06-ploinky-box-as-ploinky.md`

- [ ] **Step 1: Run full engine-free verification**

Run:

```bash
node container/wrapper-tests.mjs
node --test tests/unit/ploinkyBoxWrapper.test.mjs
node --check container/ploinky-box.mjs
node --check container/smoke-box.mjs
bash -n bin/ploinky
bash -n bin/ploinky-direct
```

Expected:

- wrapper tests pass.
- unit wrapper test passes.
- Node syntax checks pass.
- Bash syntax checks pass.

- [ ] **Step 2: Run smoke only if Podman is already running**

Check:

```bash
podman machine inspect --format '{{.State}}'
```

If the output is exactly `running`, run:

```bash
SMOKE_PUBLIC_PLOINKY=1 node container/smoke-box.mjs
```

Expected: `== SMOKE PASSED ==`.

If Podman is not already running, do not start it. Record the smoke as SKIPPED
with the observed reason.

- [ ] **Step 3: Review final diff**

Run:

```bash
git status --short
git diff --stat
git diff -- bin/ploinky bin/ploinky-direct container/ploinky-box.mjs container/wrapper-tests.mjs container/smoke-box.mjs README.md container/README.md
```

Expected: only intended files are modified, plus this plan ledger.

- [ ] **Step 4: Tick completed checkboxes in this plan**

After all tasks and verification pass, change every completed `- [ ]` checkbox
in this plan to `- [x]`. Do not tick a skipped smoke run as passed; leave the
step ticked only if the skip was intentional and recorded.

- [ ] **Step 5: Commit the checked plan**

Run:

```bash
git add docs/superpowers/plans/2026-07-06-ploinky-box-as-ploinky.md
git commit -m "Mark boxed ploinky entrypoint plan complete"
```

---

## Self-Review Checklist

- Spec coverage: the tasks cover boxed-by-default `bin/ploinky`, unchanged bare
  command syntax, `ploinky box ...`, recursion guard, direct escape,
  `ploinky-box` compatibility, tests, docs, and smoke verification.
- Placeholder scan: no TBD/TODO placeholders are intentionally left in this
  plan.
- Type/name consistency: public mode uses `PLOINKY_PUBLIC_ENTRYPOINT=1`;
  direct mode uses `PLOINKY_DIRECT=1`; in-box guard uses existing
  `PLOINKY_BOX=1`.
