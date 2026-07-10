#!/usr/bin/env node
// Public host supervisor for the managed Ploinky outer runtime.
// Host requirements: podman (preferred) or docker, plus Node >= 20.
// Isolation contract: the outer box is privileged so nested Podman can run
// named service networks; host crossings remain explicit (published ports,
// `cp`, opt-in --mount).
// The public bin/ploinky launcher delegates directly to this module.
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { showHelp } from '../cli/services/help.js';
import { planBoxPublishesForStart } from './box-publish-planner.mjs';
import { parseExplicitPublishSpec } from './publish-spec.mjs';
import { createEngineClient } from './runtime-engine.mjs';
import {
    REQUIRED_RUNTIME_CONTRACT,
    REQUIRED_RUNTIME_IMAGE,
    buildRuntimeRunArgs,
    mergeDesiredRuntimeConfig,
    normalizeContainerInspect,
    normalizeImageInspect,
    planReconciliation,
    validateImageContract,
} from './runtime-contract.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_IMAGE = REQUIRED_RUNTIME_IMAGE;
const BOX_PREFIX = 'ploinky-box';
export class SupervisorError extends Error {
    constructor(message, exitCode = 1) {
        super(message);
        this.name = 'SupervisorError';
        this.exitCode = exitCode;
    }
}

function die(message, exitCode = 1) {
    throw new SupervisorError(message, exitCode);
}

export function publicUsageText() {
    return `ploinky - run Ploinky through its managed outer runtime

Usage: ploinky [flags] [command] [args]

Commands:
  ploinky                         Start/reconcile the runtime and open the Ploinky REPL
  p-cli                          Alias for ploinky
  ploinky cli                    Open Bash as podman in /workspace
  ploinky cli <agent> [args...]  Attach to an agent manifest CLI
  ploinky start ...              Start the graph and report router readiness
  ploinky status                 Combined read-only runtime and core status
  ploinky stop                   Stop core services, then the outer runtime
  ploinky destroy                Confirm and delete the runtime and its three volumes
  ploinky help [command]         Show help without starting the runtime

Flags:
  --name X       Instance name (container ploinky-box-X). Default: inferred
                 from the current directory basename.
  --port N       Host port for the router (default 8080).
                 Inside the runtime, the router always uses port 8080.
  --publish SPEC Extra host-to-runtime port publish; repeatable, same form as -p.
  --expose SPEC  Alias for --publish; repeatable.
  --image I      Runtime image override (default ${DEFAULT_IMAGE})
  --mount DIR    Bind DIR read-write at /workspace/mounted (pierces isolation)
  --listen-lan   Publish the router on 0.0.0.0 instead of 127.0.0.1
  --engine E     podman|docker (default: auto-detect, Podman first)
  --dry-run      Print engine commands instead of executing
  -h, --help     Show host help

Omitted creation flags preserve existing inspected settings.
Creation flags are invalid for status, stop, and destroy.
`;
}

export function parseHostInvocation(argv, env = process.env) {
    const invocation = {
        engine: env.PLOINKY_BOX_ENGINE || '',
        name: '',
        nameSource: '',
        port: '8080',
        image: DEFAULT_IMAGE,
        mountDir: '',
        mountDirResolved: '',
        sourceDirResolved: '',
        listenLan: false,
        dryRun: false,
        publish: [],
        explicit: new Set(),
        help: false,
        command: '',
        args: [],
    };
    let i = 0;
    const need = (flag) => {
        const v = argv[i + 1];
        if (v === undefined || v === '') die(`${flag} needs a value`);
        invocation.explicit.add(flag);
        i += 2;
        return v;
    };
    while (i < argv.length) {
        const tok = argv[i];
        if (invocation.command) {
            switch (tok) {
                case '--name': invocation.name = need('--name'); break;
                case '--port':
                    invocation.port = need('--port');
                    break;
                case '--publish':
                case '--expose':
                    invocation.publish.push(need(tok));
                    break;
                case '--image': invocation.image = need('--image'); break;
                case '--mount': invocation.mountDir = need('--mount'); break;
                case '--engine': invocation.engine = need('--engine'); break;
                case '--listen-lan':
                    invocation.listenLan = true;
                    invocation.explicit.add(tok);
                    i += 1;
                    break;
                default:
                    invocation.args.push(tok);
                    i += 1;
            }
            continue;
        }
        switch (tok) {
            case '--name': invocation.name = need('--name'); break;
            case '--port':
                invocation.port = need('--port');
                break;
            case '--publish':
            case '--expose':
                invocation.publish.push(need(tok));
                break;
            case '--image': invocation.image = need('--image'); break;
            case '--mount': invocation.mountDir = need('--mount'); break;
            case '--engine': invocation.engine = need('--engine'); break;
            case '--listen-lan':
                invocation.listenLan = true;
                invocation.explicit.add(tok);
                i += 1;
                break;
            case '--dry-run':
                invocation.dryRun = true;
                invocation.explicit.add(tok);
                i += 1;
                break;
            case '-h':
            case '--help':
                invocation.help = true;
                invocation.explicit.add(tok);
                i += 1;
                break;
            default:
                if (!invocation.command) invocation.command = tok;
                else invocation.args.push(tok);
                i += 1;
        }
    }
    return invocation;
}

export function routeHostInvocation(invocation) {
    if (invocation.help || invocation.command === 'help') {
        return { kind: 'help', topic: invocation.args };
    }
    if (!invocation.command) return { kind: 'repl' };
    if (invocation.command === 'status') return { kind: 'status' };
    if (invocation.command === 'stop') return { kind: 'stop' };
    if (invocation.command === 'destroy') return { kind: 'destroy' };
    if (invocation.command === 'start') {
        return {
            kind: 'start',
            forwardedArgs: ['start', ...invocation.args],
        };
    }
    return {
        kind: 'ordinary',
        forwardedArgs: [invocation.command, ...invocation.args],
        interactive: ['cli', 'shell', 'sh', '--shell', '-shell']
            .includes(invocation.command),
    };
}

export function instanceName(cfg) {
    return `${BOX_PREFIX}-${cfg.name}`;
}

export function volumeNames(cfg) {
    const instance = instanceName(cfg);
    return {
        workspace: `${instance}-workspace`,
        containers: `${instance}-containers`,
        deps: `${instance}-ploinky-deps`,
    };
}

export function sanitizeBoxSuffix(raw) {
    return raw.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 63);
}

export function resolveInstanceIdentity(cfg, cwd = process.cwd()) {
    if (cfg.name) {
        cfg.nameSource = 'flag';
        return cfg;
    }
    const inferred = sanitizeBoxSuffix(path.basename(cwd));
    if (!/[a-zA-Z0-9]/.test(inferred)) {
        die(`cannot infer an instance name from the current directory (${cwd}); pass --name X`);
    }
    cfg.name = inferred;
    cfg.nameSource = 'cwd';
    return cfg;
}

function inferredNote(cfg) {
    return cfg.nameSource === 'cwd'
        ? ' (name inferred from the current directory; pass --name X to target another instance)'
        : '';
}

function isExecutableFile(candidate) {
    try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return fs.statSync(candidate).isFile();
    } catch {
        return false;
    }
}

function whichBinary(name, env = process.env) {
    if (/[\\/]/.test(name)) return isExecutableFile(name) ? name : null;
    for (const dir of (env.PATH || '').split(':')) {
        if (!dir) continue;
        const candidate = path.join(dir, name);
        if (isExecutableFile(candidate)) return candidate;
    }
    return null;
}

function detectEngine(cfg) {
    if (cfg.engine) {
        if (!cfg.dryRun && !whichBinary(cfg.engine)) {
            die(`requested engine '${cfg.engine}' not found in PATH`);
        }
        return cfg.engine;
    }
    for (const candidate of ['podman', 'docker']) {
        if (whichBinary(candidate)) {
            cfg.engine = candidate;
            return candidate;
        }
    }
    return null;
}

function runtimeDependencies(cfg) {
    return cfg._runtimeDependencies || {
        stdout: process.stdout,
        stderr: process.stderr,
        stdin: process.stdin,
        env: process.env,
        sleep,
        askLine,
        fetch,
    };
}

function output(cfg, text) {
    runtimeDependencies(cfg).stdout.write(text);
}

function errorOutput(cfg, text) {
    runtimeDependencies(cfg).stderr.write(text);
}

function engineClientFor(cfg) {
    if (cfg._engineClient) return cfg._engineClient;
    const deps = runtimeDependencies(cfg);
    cfg._engineClient = createEngineClient({
        name: cfg.engine,
        dryRun: cfg.dryRun,
        spawnSyncImpl: deps.spawnSyncImpl,
        spawnImpl: deps.spawnImpl,
        stdout: deps.stdout,
        stderr: deps.stderr,
    });
    return cfg._engineClient;
}

function query(cfg, args) {
    return engineClientFor(cfg).query(args);
}

function streamContains(cfg, args, needle) {
    return engineClientFor(cfg).streamContains(args, needle);
}

function streamEngineToStderr(cfg, args) {
    return engineClientFor(cfg).streamToStderr(args);
}

function runEngine(cfg, args, options = {}) {
    try {
        return engineClientFor(cfg).run(args, options);
    } catch (error) {
        if (error instanceof SupervisorError) throw error;
        throw new SupervisorError(
            error?.message || String(error),
            Number.isInteger(error?.exitCode) ? error.exitCode : 1,
        );
    }
}

function engineSelinuxEnabled(cfg) {
    if (cfg.engine === 'podman') {
        return query(cfg, ['info', '--format', '{{.Host.Security.SELinuxEnabled}}']).stdout.trim() === 'true';
    }
    return query(cfg, ['info', '--format', '{{json .SecurityOptions}}']).stdout.includes('selinux');
}

function preflight(cfg) {
    if (cfg.dryRun) return;
    if (cfg.engine === 'podman' && os.platform() === 'darwin') {
        const r = query(cfg, ['machine', 'inspect', '--format', '{{.State}}']);
        if (!r.ok || !r.stdout.includes('running')) {
            die('podman machine is not running. Start it with: podman machine start');
        }
    }
    if (cfg.engine === 'docker') {
        if (!query(cfg, ['info']).ok) {
            die('docker daemon unreachable. Start Docker Desktop (macOS) or dockerd (Linux).');
        }
    }
}

function runtimeExists(cfg) {
    return query(cfg, ['container', 'inspect', instanceName(cfg)]).ok;
}

function runtimeRunning(cfg) {
    return query(cfg, ['container', 'inspect', '--format', '{{.State.Status}}', instanceName(cfg)])
        .stdout.trim() === 'running';
}

function runtimeHostPort(cfg) {
    const first = query(cfg, ['port', instanceName(cfg), '8080/tcp']).stdout.split('\n')[0] || '';
    const idx = first.lastIndexOf(':');
    return idx === -1 ? '' : first.slice(idx + 1).trim();
}

function prepareMount(cfg) {
    if (!cfg.mountDir) return;
    let isDir = false;
    try { isDir = fs.statSync(cfg.mountDir).isDirectory(); } catch { /* not found */ }
    if (!isDir) die(`--mount directory not found: ${cfg.mountDir}`);
    cfg.mountDirResolved = path.resolve(cfg.mountDir);
    errorOutput(cfg, `ploinky: WARNING: --mount pierces the isolation boundary for ${cfg.mountDir}\n`);
}

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
    cfg.sourceDirResolved = resolveHostPloinkySource(
        runtimeDependencies(cfg).env,
    );
    // node_modules must exist on the host: it is the mountpoint for the deps
    // volume, and the engine cannot create it inside a read-only bind mount.
    if (!cfg.dryRun) {
        fs.mkdirSync(path.join(cfg.sourceDirResolved, 'node_modules'), { recursive: true });
    }
}

const DEFAULT_SOURCE_BRANCHES = new Set(['main', 'master', 'HEAD']);
const BRANCH_POLICY_FLAGS = new Set(['--branch', '--repo-branch', '--branch-fallback', '--reset-repos']);

function hasBranchPolicyArg(args) {
    return (args || []).some((arg) => {
        const value = String(arg || '');
        return BRANCH_POLICY_FLAGS.has(value)
            || value.startsWith('--branch=')
            || value.startsWith('--repo-branch=')
            || value.startsWith('--branch-fallback=');
    });
}

function currentGitBranch(sourceDir) {
    const dir = String(sourceDir || '').trim();
    if (!dir) return '';
    const result = spawnSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.status !== 0 || result.error) return '';
    return String(result.stdout || '').trim();
}

export function inferPublicStartBranchArgs(args, env = process.env, sourceDir = '') {
    const autoBranch = String(env?.PLOINKY_BOX_AUTO_BRANCH || '').trim().toLowerCase();
    if (autoBranch === '0' || autoBranch === 'false' || autoBranch === 'no') return [];
    if (hasBranchPolicyArg(args)) return [];

    const branch = String(env?.PLOINKY_BOX_BRANCH || currentGitBranch(sourceDir || resolveHostPloinkySource(env)) || '').trim();
    if (!branch || DEFAULT_SOURCE_BRANCHES.has(branch)) return [];
    return ['--branch', branch];
}

function validatePublishSpecs(cfg) {
    for (const spec of cfg.publish) {
        try {
            parseExplicitPublishSpec(spec);
        } catch (error) {
            die(`invalid --publish '${spec}': ${error?.message || error}`);
        }
    }
}

function validateHostPort(value, label) {
    const raw = String(value || '').trim();
    if (!/^\d+$/.test(raw)) {
        die(`${label} must be a number, got '${value}'`);
    }
    const port = Number.parseInt(raw, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        die(`${label} must be between 1 and 65535, got '${value}'`);
    }
}

function appendGraphDrivenStartPublishes(cfg, startPlan) {
    const planned = planBoxPublishesForStart({
        startPlan,
        sourceDir: cfg.sourceDirResolved || resolveHostPloinkySource(
            runtimeDependencies(cfg).env,
        ),
    });
    cfg._generatedPublishes = planned.publishes;
}

function inspectedImage(cfg, imageRef) {
    const result = query(cfg, ['image', 'inspect', imageRef]);
    if (!result.ok) return null;
    try {
        return normalizeImageInspect(result.stdout);
    } catch {
        return null;
    }
}

function inspectExistingRuntimeConfig(cfg) {
    if (cfg.dryRun) return null;
    const result = query(cfg, ['container', 'inspect', instanceName(cfg)]);
    if (!result.ok) return null;
    let existing;
    try {
        existing = normalizeContainerInspect(cfg.engine, result.stdout);
    } catch (error) {
        die(`cannot parse runtime inspect for '${instanceName(cfg)}': ${error.message || error}`);
    }
    const imageRef = existing.imageId || existing.image;
    const image = imageRef ? inspectedImage(cfg, imageRef) : null;
    existing.contract = image?.contract || '';
    return existing;
}

function ensureImage(cfg, imageRef) {
    if (cfg.dryRun) return;
    let image = inspectedImage(cfg, imageRef);
    if (!image) {
        const code = runEngine(cfg, ['pull', imageRef], { allowFail: true });
        if (code !== 0) {
            die(`cannot pull ${imageRef}.
  - Publish it: gh workflow run publish-ploinky-box-image.yml --repo AssistOS-AI/container-image-builds
  - Or point at another image with --image`);
        }
        image = inspectedImage(cfg, imageRef);
    }
    if (!image) die(`cannot inspect runtime image '${imageRef}' after pull`);
    validateImageContract(image, imageRef);
}

function portInUse(port, host = '127.0.0.1', timeoutMs = 500) {
    return new Promise((resolve) => {
        const portNumber = Number(port);
        if (!Number.isInteger(portNumber) || portNumber < 0 || portNumber >= 65536) {
            resolve(false);
            return;
        }
        const sock = net.connect({ port: portNumber, host });
        const done = (v) => { sock.destroy(); resolve(v); };
        sock.once('connect', () => done(true));
        sock.once('error', () => done(false));
        sock.setTimeout(timeoutMs, () => done(false));
    });
}

async function waitHealthy(cfg, phase) {
    if (cfg.dryRun) return;
    const injected = runtimeDependencies(cfg).waitHealthy;
    if (injected) {
        await injected(cfg, phase);
        return;
    }
    const instance = instanceName(cfg);
    for (let i = 0; i < 30; i += 1) {
        const inspect = query(cfg, ['container', 'inspect', '--format', '{{.State.Status}}', instance]);
        const state = inspect.ok ? inspect.stdout.trim() : 'missing';
        if (state === 'running') {
            if (await streamContains(cfg, ['logs', instance], 'self-check OK')) {
                output(cfg, `ploinky: '${instance}' is running (router will publish on port ${cfg.port} once started inside).\n`);
                return;
            }
        }
        if (state === 'exited') {
            errorOutput(cfg, `ploinky: '${instance}' failed its self-check:\n`);
            await streamEngineToStderr(cfg, ['logs', instance]);
            die('fix the reported cause; inspect the privileged box runtime before retrying');
        }
        await runtimeDependencies(cfg).sleep(1000);
    }
    die(`'${instance}' did not become healthy within 30s; inspect with: ${cfg.engine} logs ${instanceName(cfg)}`);
}

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
// opt-in installs; a TTY asks; everything else leaves the runtime running and warns.
// Public ploinky commands pass fatalOnDecline so a declined prompt exits once,
// before forwarding into a second in-box prompt.
async function ensureDepsInstalled(cfg, { fatalOnDecline = false } = {}) {
    if (cfg.dryRun || depsInstalled(cfg)) return true;
    const deps = runtimeDependencies(cfg);
    let reply = null;
    const envOptIn = String(deps.env.PLOINKY_BOX_INSTALL_DEPS || '') === '1';
    if (!envOptIn && deps.stdin.isTTY) {
        reply = await deps.askLine('Ploinky dependencies are not installed. Install them now? [y/N] ');
    }
    if (!shouldInstallDeps(deps.env, deps.stdin.isTTY, reply)) {
        errorOutput(cfg, 'ploinky: WARNING: Ploinky cannot run until dependencies are installed.\n'
            + `ploinky: install them with: ${cfg.engine} exec -it ${instanceName(cfg)} /opt/ploinky/bin/ploinky-install-deps\n`);
        if (fatalOnDecline) {
            throw new SupervisorError('Ploinky dependencies are required before running this command');
        }
        return false;
    }
    runEngine(cfg, ['exec', '-i', instanceName(cfg), '/opt/ploinky/bin/ploinky-install-deps']);
    return true;
}

function requireRuntimeRunning(cfg) {
    if (cfg.dryRun) return;
    if (!runtimeRunning(cfg)) {
        die(`'${instanceName(cfg)}' is not running; run a normal ploinky command to start it`);
    }
}

function gracefulPloinkyStop(cfg) {
    if (!cfg.dryRun && runtimeRunning(cfg)) {
        runEngine(
            cfg,
            ['exec', '-w', '/workspace', instanceName(cfg), 'timeout', '30', 'ploinky', 'stop'],
            { silence: 'all', allowFail: true },
        );
    }
}

async function urlOk(cfg, url) {
    try {
        const r = await runtimeDependencies(cfg).fetch(url, {
            signal: AbortSignal.timeout(2000),
        });
        return r.ok;
    } catch { return false; }
}

function askLine(promptText) {
    return new Promise((resolve) => {
        process.stdout.write(promptText);
        const rl = readline.createInterface({ input: process.stdin, terminal: false });
        let settled = false;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            resolve(value);
        };
        rl.once('line', (line) => { finish(line); rl.close(); });
        rl.once('close', () => finish(null));
    });
}

async function ensureRuntime(cfg, { fatalOnDepsDecline = false } = {}) {
    validateHostPort(cfg.port, `${cfg.command || 'runtime'}: host port`);
    validatePublishSpecs(cfg);
    preflight(cfg);
    const existing = inspectExistingRuntimeConfig(cfg);
    if (!existing || cfg.explicit.has('--mount')) {
        prepareMount(cfg);
    }
    if (!existing) prepareSource(cfg);
    const desired = mergeDesiredRuntimeConfig(
        cfg,
        existing,
        cfg._generatedPublishes || [],
    );
    const plan = planReconciliation({
        existing,
        desired,
        contractMatches: existing?.contract === REQUIRED_RUNTIME_CONTRACT,
    });
    cfg._runtimeConfig = desired;
    cfg._reconciliationPlan = plan;

    if (existing?.running) {
        output(cfg, `ploinky: '${instanceName(cfg)}' already running.\n`);
        fixDepsOwnership(cfg);
        if (!await ensureDepsInstalled(cfg, { fatalOnDecline: fatalOnDepsDecline })) {
            throw new SupervisorError('Ploinky dependencies are required before running this command');
        }
        return;
    }
    let phase;
    if (existing) {
        runEngine(cfg, ['start', instanceName(cfg)], { silence: 'stdout' });
        phase = 'start';
    } else {
        const portCheck = runtimeDependencies(cfg).portInUse || portInUse;
        if (!cfg.dryRun && await portCheck(desired.routerPublish.hostPort)) {
            die(`host port ${cfg.port} is already in use; choose another with --port`);
        }
        ensureImage(cfg, desired.image);
        const selinux = cfg.dryRun ? false : engineSelinuxEnabled(cfg);
        runEngine(cfg, buildRuntimeRunArgs(desired, {
            engine: cfg.engine,
            selinux,
        }));
        phase = 'create';
    }
    await waitHealthy(cfg, phase);
    fixDepsOwnership(cfg);
    if (!await ensureDepsInstalled(cfg, { fatalOnDecline: fatalOnDepsDecline })) {
        throw new SupervisorError('Ploinky dependencies are required before running this command');
    }
}

async function probeRouter(cfg, port, attempts = 30) {
    for (let i = 0; i < attempts; i += 1) {
        for (const p of ['status', 'health']) {
            if (await urlOk(cfg, `http://127.0.0.1:${port}/${p}`)) return p;
        }
        await runtimeDependencies(cfg).sleep(1000);
    }
    return null;
}

function splitPublicStartArgs(args, options = {}) {
    const raw = args.map((entry) => String(entry));
    let agent = '';
    let hostPort = '';
    let profile = 'default';
    let profileWasExplicit = false;
    const passthrough = [];
    const selectProfile = (value) => {
        const normalized = String(value || '').trim().toLowerCase();
        if (!normalized) {
            die('start: --profile needs a value');
        }
        if (profileWasExplicit && profile !== normalized) {
            die(`start: conflicting profiles '${profile}' and '${normalized}'; give --profile once`);
        }
        profile = normalized;
        profileWasExplicit = true;
    };
    for (let i = 0; i < raw.length; i += 1) {
        const arg = raw[i];
        if (arg === '--profile') {
            const value = raw[i + 1];
            if (value === undefined || value === '' || value.startsWith('--')) {
                die('start: --profile needs a value');
            }
            selectProfile(value);
            i += 1;
            continue;
        }
        if (arg.startsWith('--profile=')) {
            selectProfile(arg.slice('--profile='.length));
            continue;
        }
        if (arg === '--branch' || arg === '--repo-branch' || arg === '--branch-fallback') {
            passthrough.push(arg);
            if (i + 1 < raw.length) passthrough.push(raw[++i]);
            continue;
        }
        if (arg.startsWith('--branch=') || arg.startsWith('--repo-branch=') || arg.startsWith('--branch-fallback=')) {
            passthrough.push(arg);
            continue;
        }
        if (arg === '--reset-repos') {
            passthrough.push(arg);
            continue;
        }
        if (arg.startsWith('--')) {
            passthrough.push(arg);
            continue;
        }
        if (!agent) {
            agent = arg;
            continue;
        }
        if (!hostPort && /^\d+$/.test(arg)) {
            hostPort = arg;
            continue;
        }
        passthrough.push(arg);
    }
    const implicitBranchArgs = inferPublicStartBranchArgs(raw, options.env || process.env, options.sourceDir || '');
    if (!agent) {
        return {
            hasAgent: false,
            agent: '',
            hostPort: '',
            profile,
            inBoxArgs: ['start', '--profile', profile, ...passthrough, ...implicitBranchArgs],
        };
    }
    return {
        hasAgent: true,
        agent,
        hostPort,
        profile,
        inBoxArgs: ['start', agent, '8080', '--profile', profile, ...passthrough, ...implicitBranchArgs],
    };
}

// A public start preserves the graph publish planner, profile selection,
// source-branch forwarding, and router readiness probe.
async function startGraph(cfg) {
    const startPlan = splitPublicStartArgs(cfg.args, {
        env: runtimeDependencies(cfg).env,
        sourceDir: cfg.sourceDirResolved || '',
    });
    if (!startPlan.hasAgent) {
        await ensureRuntime(cfg, { fatalOnDepsDecline: true });
        runEngine(cfg, ['exec', '-w', '/workspace', instanceName(cfg), 'ploinky', ...startPlan.inBoxArgs]);
        return 0;
    }
    if (startPlan.hostPort) {
        if (cfg.explicit.has('--port') && cfg.port !== startPlan.hostPort) {
            die(`start: conflicting host ports (--port ${cfg.port} vs argument ${startPlan.hostPort}); give the port once`);
        }
        cfg.port = startPlan.hostPort;
    }
    validateHostPort(cfg.port, 'start: host port');
    validatePublishSpecs(cfg);
    appendGraphDrivenStartPublishes(cfg, startPlan);
    await ensureRuntime(cfg, { fatalOnDepsDecline: true });
    const published = cfg.dryRun ? cfg.port : (runtimeHostPort(cfg) || cfg.port);
    if (!cfg.dryRun && published !== cfg.port) {
        errorOutput(cfg, `ploinky: note: existing runtime publishes host port ${published}; the requested port applies only when the runtime is created. Recreate it through normal reconciliation with --port ${cfg.port}.\n`);
    }
    runEngine(cfg, ['exec', '-w', '/workspace', instanceName(cfg), 'ploinky', ...startPlan.inBoxArgs]);
    if (cfg.dryRun) return 0;
    const probePath = await probeRouter(cfg, published);
    if (probePath) {
        output(cfg, `ploinky: router responding on http://127.0.0.1:${published}/${probePath}\n`);
        return 0;
    }
    errorOutput(cfg, `ploinky: router did not respond on http://127.0.0.1:${published} within 30s; check: ploinky --name ${cfg.name} status\n`);
    return 1;
}

function forwardCoreCommand(cfg, forwardedArgs, { interactive = false } = {}) {
    preflight(cfg);
    requireRuntimeRunning(cfg);
    const execArgs = ['exec'];
    if (interactive) execArgs.push('-it');
    execArgs.push('-w', '/workspace', instanceName(cfg), 'ploinky', ...forwardedArgs);
    return runEngine(cfg, execArgs);
}

async function inspectRuntimeStatus(cfg) {
    preflight(cfg);
    const instance = instanceName(cfg);
    if (cfg.dryRun) {
        output(cfg, `ploinky: '${instance}' does not exist.${inferredNote(cfg)}\n`);
        return 1;
    }
    if (!runtimeExists(cfg)) {
        output(cfg, `ploinky: '${instance}' does not exist.${inferredNote(cfg)}\n`);
        return 1;
    }
    const state = query(cfg, ['container', 'inspect', '--format', '{{.State.Status}}', instance]).stdout.trim();
    output(cfg, `container: ${instance} (${state})\n`);
    const hp = runtimeHostPort(cfg);
    if (hp && await urlOk(cfg, `http://127.0.0.1:${hp}/status`)) {
        output(cfg, `router:    responding on http://127.0.0.1:${hp}/status\n`);
    } else if (hp && await urlOk(cfg, `http://127.0.0.1:${hp}/health`)) {
        output(cfg, `router:    responding on http://127.0.0.1:${hp}/health\n`);
    } else {
        output(cfg, `router:    not responding (run ploinky --name ${cfg.name} start <agent>)\n`);
    }
    return 0;
}

function stopRuntime(cfg) {
    preflight(cfg);
    if (!runtimeExists(cfg)) {
        output(cfg, `ploinky: '${instanceName(cfg)}' does not exist.${inferredNote(cfg)}\n`);
        return 0;
    }
    gracefulPloinkyStop(cfg);
    runEngine(cfg, ['stop', instanceName(cfg)], { silence: 'stdout' });
    output(cfg, `ploinky: '${instanceName(cfg)}' stopped (volumes kept).\n`);
    return 0;
}

async function destroyRuntime(cfg) {
    preflight(cfg);
    const instance = instanceName(cfg);
    const { workspace, containers, deps } = volumeNames(cfg);
    if (cfg.nameSource === 'cwd') {
        errorOutput(cfg, `ploinky: targeting '${instance}' (name inferred from the current directory)\n`);
    }
    if (!cfg.dryRun) {
        const anyVolume = query(cfg, ['volume', 'inspect', workspace]).ok
            || query(cfg, ['volume', 'inspect', containers]).ok
            || query(cfg, ['volume', 'inspect', deps]).ok;
        if (!runtimeExists(cfg) && !anyVolume) {
            die(`nothing to destroy: no container or volumes for '${instance}'${inferredNote(cfg)}`);
        }
        const reply = await runtimeDependencies(cfg).askLine(`Remove container '${instance}' and volumes '${workspace}' + '${containers}' + '${deps}'? [y/N] `);
        if (!/^[yY]$/.test(reply ?? '')) die('aborted');
    }
    runEngine(cfg, ['stop', instance], { silence: 'all', allowFail: true });
    runEngine(cfg, ['rm', instance], { silence: 'all', allowFail: true });
    runEngine(cfg, ['volume', 'rm', workspace, containers, deps], { silence: cfg.dryRun ? 'none' : 'all', allowFail: true });
    output(cfg, `ploinky: '${instance}' and its volumes removed.\n`);
    return 0;
}

function defaultDependencies() {
    return {
        stdout: process.stdout,
        stderr: process.stderr,
        stdin: process.stdin,
        cwd: () => process.cwd(),
        env: process.env,
        detectEngine,
        showHelp,
        sleep,
        askLine,
        fetch,
        portInUse,
        createEngineClient,
    };
}

export function createRuntimeSupervisor(dependencies = {}) {
    const deps = { ...defaultDependencies(), ...dependencies };
    return {
        async run(argv) {
            const major = Number(process.versions.node.split('.')[0]);
            if (major < 20) {
                throw new SupervisorError(`Node >= 20 is required (found ${process.versions.node})`);
            }

            const invocation = parseHostInvocation(argv, deps.env);
            const route = routeHostInvocation(invocation);
            if (route.kind === 'help') {
                if (route.topic.length > 0) {
                    deps.showHelp(route.topic, { surface: 'host' });
                } else {
                    deps.stdout.write(publicUsageText());
                }
                return 0;
            }

            const detected = deps.detectEngine(invocation);
            if (!detected) {
                throw new SupervisorError('Ploinky requires Podman or Docker on the host');
            }
            if (typeof detected === 'string') invocation.engine = detected;
            const engineClient = deps.engineClient || deps.createEngineClient({
                name: invocation.engine,
                dryRun: invocation.dryRun,
                spawnSyncImpl: deps.spawnSyncImpl,
                spawnImpl: deps.spawnImpl,
                stdout: deps.stdout,
                stderr: deps.stderr,
            });
            Object.defineProperties(invocation, {
                _runtimeDependencies: {
                    value: deps,
                    configurable: true,
                },
                _engineClient: {
                    value: engineClient,
                    configurable: true,
                    writable: true,
                },
            });
            const cwd = typeof deps.cwd === 'function' ? deps.cwd() : deps.cwd;
            resolveInstanceIdentity(invocation, cwd);

            if (route.kind === 'status') return inspectRuntimeStatus(invocation);
            if (route.kind === 'stop') return stopRuntime(invocation);
            if (route.kind === 'destroy') return destroyRuntime(invocation);
            if (route.kind === 'start') return startGraph(invocation);

            await ensureRuntime(invocation, { fatalOnDepsDecline: true });
            if (route.kind === 'repl') {
                forwardCoreCommand(invocation, [], { interactive: true });
                return 0;
            }
            forwardCoreCommand(invocation, route.forwardedArgs, {
                interactive: route.interactive,
            });
            return 0;
        },
    };
}

export async function runSupervisorWithBoundary(
    supervisor,
    argv,
    stderr = process.stderr,
) {
    try {
        return await supervisor.run(argv);
    } catch (error) {
        stderr.write('ploinky: ' + (error.message || error) + '\n');
        return Number.isInteger(error.exitCode) ? error.exitCode : 1;
    }
}

async function main() {
    const supervisor = createRuntimeSupervisor(defaultDependencies());
    process.exitCode = await runSupervisorWithBoundary(
        supervisor,
        process.argv.slice(2),
    );
}

function isMainModule() {
    if (!process.argv[1]) return false;
    if (import.meta.url === pathToFileURL(process.argv[1]).href) return true;
    try {
        return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
    } catch {
        return false;
    }
}

if (isMainModule()) {
    await main();
}
