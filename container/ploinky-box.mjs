#!/usr/bin/env node
// ploinky-box: run the Ploinky runtime isolated inside a rootless-podman container.
// Host requirements: podman (preferred) or docker, plus Node >= 20.
// Isolation contract: never --privileged; explicit crossings only (published
// ports, `cp`, opt-in --mount).
// All wrapper logic lives here; `container/ploinky-box` is a thin bash shim.
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const DEFAULT_IMAGE = 'docker.io/assistos/ploinky-box:podman-node24';
const BOX_PREFIX = 'ploinky-box';

export function usageText() {
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

function die(msg) {
    process.stderr.write(`ploinky-box: ${msg}\n`);
    process.exit(1);
}

export function parseCli(argv, env = process.env) {
    const cfg = {
        engine: env.PLOINKY_BOX_ENGINE || '',
        name: '',
        nameSource: '',
        port: '8080',
        portExplicit: false,
        image: DEFAULT_IMAGE,
        mountDir: '',
        mountDirResolved: '',
        listenLan: false,
        dryRun: false,
        publish: [],
        webmeetPorts: false,
        help: false,
        command: '',
        args: [],
    };
    let i = 0;
    const need = (flag) => {
        const v = argv[i + 1];
        if (v === undefined || v === '') die(`${flag} needs a value`);
        i += 2;
        return v;
    };
    while (i < argv.length) {
        const tok = argv[i];
        switch (tok) {
            case '--name': cfg.name = need('--name'); break;
            case '--port':
                cfg.port = need('--port');
                cfg.portExplicit = true;
                break;
            case '--publish': cfg.publish.push(need('--publish')); break;
            case '--webmeet-ports': cfg.webmeetPorts = true; i += 1; break;
            case '--image': cfg.image = need('--image'); break;
            case '--mount': cfg.mountDir = need('--mount'); break;
            case '--engine': cfg.engine = need('--engine'); break;
            case '--listen-lan': cfg.listenLan = true; i += 1; break;
            case '--dry-run': cfg.dryRun = true; i += 1; break;
            case '-h':
            case '--help': cfg.help = true; i += 1; break;
            default:
                if (!cfg.command) cfg.command = tok; else cfg.args.push(tok);
                i += 1;
        }
    }
    return cfg;
}

export function instanceName(cfg) {
    return `${BOX_PREFIX}-${cfg.name}`;
}

export function volumeNames(cfg) {
    const instance = instanceName(cfg);
    return { workspace: `${instance}-workspace`, containers: `${instance}-containers` };
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

export function mapCpPath(side, instance) {
    return side.startsWith('box:') ? `${instance}:${side.slice('box:'.length)}` : side;
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
        return;
    }
    for (const candidate of ['podman', 'docker']) {
        if (whichBinary(candidate)) { cfg.engine = candidate; return; }
    }
    die('neither podman nor docker found in PATH. Install podman (https://podman.io) or docker.');
}

function query(cfg, args) {
    const r = spawnSync(cfg.engine, args, { encoding: 'utf8' });
    return {
        ok: r.status === 0 && !r.error,
        stdout: r.stdout || '',
        stderr: r.stderr || '',
    };
}

function streamContains(cfg, args, needle) {
    return new Promise((resolve) => {
        let tail = '';
        let settled = false;
        const done = (found) => {
            if (settled) return;
            settled = true;
            resolve(found);
        };
        let child;
        try {
            child = spawn(cfg.engine, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        } catch {
            done(false);
            return;
        }
        const scan = (chunk) => {
            const text = `${tail}${chunk}`;
            if (text.includes(needle)) {
                done(true);
                child.kill();
                return;
            }
            tail = text.slice(-Math.max(needle.length - 1, 0));
        };
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', scan);
        child.stderr.on('data', scan);
        child.on('error', () => done(false));
        child.on('close', () => done(false));
    });
}

function streamEngineToStderr(cfg, args) {
    return new Promise((resolve) => {
        let child;
        try {
            child = spawn(cfg.engine, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        } catch {
            resolve(1);
            return;
        }
        child.stdout.pipe(process.stderr, { end: false });
        child.stderr.pipe(process.stderr, { end: false });
        child.on('error', () => resolve(1));
        child.on('close', (code, signal) => {
            resolve(typeof code === 'number' ? code : 128 + (os.constants.signals[signal] ?? 15));
        });
    });
}

function childExitCode(r) {
    if (typeof r.status === 'number') return r.status;
    if (r.signal) return 128 + (os.constants.signals[r.signal] ?? 15);
    return 1;
}

function runEngine(cfg, args, { silence = 'none', allowFail = false } = {}) {
    if (cfg.dryRun) {
        if (silence === 'none') process.stdout.write(`DRY-RUN: ${cfg.engine} ${args.join(' ')}\n`);
        return 0;
    }
    const stdio = [
        'inherit',
        silence === 'none' ? 'inherit' : 'ignore',
        silence === 'all' ? 'ignore' : 'inherit',
    ];
    const r = spawnSync(cfg.engine, args, { stdio });
    if (r.error && !allowFail) die(`failed to run ${cfg.engine}: ${r.error.message}`);
    const code = childExitCode(r);
    if (code !== 0 && !allowFail) process.exit(code);
    return code;
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

function boxExists(cfg) {
    return query(cfg, ['container', 'inspect', instanceName(cfg)]).ok;
}

function boxRunning(cfg) {
    return query(cfg, ['container', 'inspect', '--format', '{{.State.Status}}', instanceName(cfg)])
        .stdout.trim() === 'running';
}

function hostPort(cfg) {
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
    process.stderr.write(`ploinky-box: WARNING: --mount pierces the isolation boundary for ${cfg.mountDir}\n`);
}

export function buildRunArgs(cfg, { selinux = false } = {}) {
    const bindIp = cfg.listenLan ? '0.0.0.0' : '127.0.0.1';
    const instance = instanceName(cfg);
    const { workspace, containers } = volumeNames(cfg);
    const args = ['run', '-d', '--init', '--name', instance,
        '--user', 'podman',
        '--device', '/dev/fuse',
        '--device', '/dev/net/tun',
        '--security-opt', 'seccomp=unconfined',
        '-p', `${bindIp}:${cfg.port}:8080`,
    ];
    for (const spec of cfg.publish) args.push('-p', spec);
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
    args.push(
        '-v', `${workspace}:/workspace`,
        '-v', `${containers}:/home/podman/.local/share/containers`,
        '-e', 'PLOINKY_BOX=1',
        '-e', 'PLOINKY_WORKSPACE_ROOT=/workspace',
    );
    if (selinux) args.push('--security-opt', 'label=disable');
    if (cfg.mountDir) args.push('-v', `${cfg.mountDirResolved}:/workspace/mounted`);
    args.push(cfg.image);
    return args;
}

function ensureImage(cfg) {
    if (cfg.dryRun) return;
    if (query(cfg, ['image', 'inspect', cfg.image]).ok) return;
    const r = spawnSync(cfg.engine, ['pull', cfg.image], { stdio: 'inherit' });
    if (childExitCode(r) !== 0) {
        die(`cannot pull ${cfg.image}.
  - Publish it: gh workflow run publish-ploinky-box-image.yml --repo AssistOS-AI/container-image-builds
  - Or point at another image with --image`);
    }
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

async function waitHealthy(cfg) {
    if (cfg.dryRun) return;
    const instance = instanceName(cfg);
    for (let i = 0; i < 30; i += 1) {
        const inspect = query(cfg, ['container', 'inspect', '--format', '{{.State.Status}}', instance]);
        const state = inspect.ok ? inspect.stdout.trim() : 'missing';
        if (state === 'running') {
            if (await streamContains(cfg, ['logs', instance], 'self-check OK')) {
                process.stdout.write(`ploinky-box: '${instance}' is up (router will publish on port ${cfg.port} once started inside).\n`);
                return;
            }
        }
        if (state === 'exited') {
            process.stderr.write(`ploinky-box: '${instance}' failed its self-check:\n`);
            await streamEngineToStderr(cfg, ['logs', instance]);
            die('fix the reported cause; do NOT fall back to --privileged');
        }
        await sleep(1000);
    }
    die(`'${instance}' did not become healthy within 30s; inspect with: ${cfg.engine} logs ${instanceName(cfg)}`);
}

function requireRunning(cfg) {
    if (cfg.dryRun) return;
    if (!boxRunning(cfg)) {
        die(`'${instanceName(cfg)}' is not running. Start it with: ploinky-box --name ${cfg.name} up`);
    }
}

function gracefulPloinkyStop(cfg) {
    if (!cfg.dryRun && boxRunning(cfg)) {
        spawnSync(cfg.engine, ['exec', '-w', '/workspace', instanceName(cfg), 'timeout', '30', 'ploinky', 'stop'], { stdio: 'ignore' });
    }
}

async function urlOk(url) {
    try {
        const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
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

async function cmdUp(cfg) {
    preflight(cfg);
    if (!cfg.dryRun && boxRunning(cfg)) {
        process.stdout.write(`ploinky-box: '${instanceName(cfg)}' already running.\n`);
        return;
    }
    if (!cfg.dryRun && boxExists(cfg)) {
        runEngine(cfg, ['start', instanceName(cfg)], { silence: 'stdout' });
    } else {
        if (!cfg.dryRun && await portInUse(cfg.port)) {
            die(`host port ${cfg.port} is already in use; choose another with --port`);
        }
        ensureImage(cfg);
        prepareMount(cfg);
        const selinux = cfg.dryRun ? false : engineSelinuxEnabled(cfg);
        runEngine(cfg, buildRunArgs(cfg, { selinux }));
    }
    await waitHealthy(cfg);
}

async function probeRouter(port, attempts = 30) {
    for (let i = 0; i < attempts; i += 1) {
        for (const p of ['status', 'health']) {
            if (await urlOk(`http://127.0.0.1:${port}/${p}`)) return p;
        }
        await sleep(1000);
    }
    return null;
}

// start <agent> [port]: up + in-box `ploinky start <agent> 8080` + router
// probe. [port]/--port choose the HOST side only; the in-box router port is
// always 8080 (the one rule about ports).
async function cmdStart(cfg) {
    const [agent, portArg, ...extra] = cfg.args;
    if (!agent || extra.length > 0) die('usage: ploinky-box start <agent> [port]');
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
        process.stderr.write(`ploinky-box: note: existing box publishes host port ${published}; the requested port applies only when the box is created. To change it, run update/recreate with the same flags you used for up plus --port ${cfg.port}.\n`);
    }
    runEngine(cfg, ['exec', '-w', '/workspace', instanceName(cfg), 'ploinky', 'start', agent, '8080']);
    if (cfg.dryRun) return;
    const probePath = await probeRouter(published);
    if (probePath) {
        process.stdout.write(`ploinky-box: router responding on http://127.0.0.1:${published}/${probePath}\n`);
    } else {
        process.stderr.write(`ploinky-box: router did not respond on http://127.0.0.1:${published} within 30s; check: ploinky-box --name ${cfg.name} status\n`);
        process.exitCode = 1;
    }
}

function cmdCli(cfg) {
    preflight(cfg);
    requireRunning(cfg);
    process.on('SIGINT', () => {});
    process.on('SIGTERM', () => {});
    runEngine(cfg, ['exec', '-it', '-w', '/workspace', instanceName(cfg), 'p-cli']);
}

function cmdRun(cfg) {
    preflight(cfg);
    requireRunning(cfg);
    runEngine(cfg, ['exec', '-w', '/workspace', instanceName(cfg), 'ploinky', ...cfg.args]);
}

function cmdCp(cfg) {
    preflight(cfg);
    requireRunning(cfg);
    if (cfg.args.length !== 2) die('usage: ploinky-box cp <src> <dst>  (prefix the container side with box:)');
    const [src, dst] = cfg.args;
    if (!`${src}${dst}`.includes('box:')) {
        die('one side must carry the box: prefix, e.g. box:/workspace/file');
    }
    const instance = instanceName(cfg);
    runEngine(cfg, ['cp', mapCpPath(src, instance), mapCpPath(dst, instance)]);
}

async function cmdStatus(cfg) {
    preflight(cfg);
    const instance = instanceName(cfg);
    if (cfg.dryRun) {
        process.stdout.write(`ploinky-box: '${instance}' does not exist.${inferredNote(cfg)}\n`);
        return 1;
    }
    if (!boxExists(cfg)) {
        process.stdout.write(`ploinky-box: '${instance}' does not exist.${inferredNote(cfg)}\n`);
        return 1;
    }
    const state = query(cfg, ['container', 'inspect', '--format', '{{.State.Status}}', instance]).stdout.trim();
    process.stdout.write(`container: ${instance} (${state})\n`);
    const hp = hostPort(cfg);
    if (hp && await urlOk(`http://127.0.0.1:${hp}/status`)) {
        process.stdout.write(`router:    responding on http://127.0.0.1:${hp}/status\n`);
    } else if (hp && await urlOk(`http://127.0.0.1:${hp}/health`)) {
        process.stdout.write(`router:    responding on http://127.0.0.1:${hp}/health\n`);
    } else {
        process.stdout.write(`router:    not responding (start it inside: ploinky-box --name ${cfg.name} run start <agent> 8080)\n`);
    }
    return 0;
}

function cmdLogs(cfg) {
    preflight(cfg);
    requireRunning(cfg);
    runEngine(cfg, ['exec', instanceName(cfg), 'sh', '-lc',
        'tail -n 100 /workspace/.ploinky/logs/*.log 2>/dev/null || echo "no .ploinky logs yet"']);
}

function cmdStop(cfg) {
    preflight(cfg);
    if (!boxExists(cfg)) {
        process.stdout.write(`ploinky-box: '${instanceName(cfg)}' does not exist.${inferredNote(cfg)}\n`);
        return;
    }
    gracefulPloinkyStop(cfg);
    runEngine(cfg, ['stop', instanceName(cfg)], { silence: 'stdout' });
    process.stdout.write(`ploinky-box: '${instanceName(cfg)}' stopped (volumes kept).\n`);
}

async function cmdUpdate(cfg) {
    preflight(cfg);
    runEngine(cfg, ['pull', cfg.image]);
    if (boxExists(cfg)) {
        gracefulPloinkyStop(cfg);
        runEngine(cfg, ['stop', instanceName(cfg)], { silence: 'all', allowFail: true });
        runEngine(cfg, ['rm', instanceName(cfg)], { silence: 'stdout' });
    }
    prepareMount(cfg);
    const selinux = cfg.dryRun ? false : engineSelinuxEnabled(cfg);
    runEngine(cfg, buildRunArgs(cfg, { selinux }));
    await waitHealthy(cfg);
    process.stdout.write(`ploinky-box: updated. Resume agents with: ploinky-box --name ${cfg.name} run start\n`);
}

async function cmdDestroy(cfg) {
    preflight(cfg);
    const instance = instanceName(cfg);
    const { workspace, containers } = volumeNames(cfg);
    if (cfg.nameSource === 'cwd') {
        process.stderr.write(`ploinky-box: targeting '${instance}' (name inferred from the current directory)\n`);
    }
    if (!cfg.dryRun) {
        const anyVolume = query(cfg, ['volume', 'inspect', workspace]).ok
            || query(cfg, ['volume', 'inspect', containers]).ok;
        if (!boxExists(cfg) && !anyVolume) {
            die(`nothing to destroy: no container or volumes for '${instance}'${inferredNote(cfg)}`);
        }
        const reply = await askLine(`Remove container '${instance}' and volumes '${workspace}' + '${containers}'? [y/N] `);
        if (!/^[yY]$/.test(reply ?? '')) die('aborted');
    }
    runEngine(cfg, ['stop', instance], { silence: 'all', allowFail: true });
    runEngine(cfg, ['rm', instance], { silence: 'all', allowFail: true });
    runEngine(cfg, ['volume', 'rm', workspace, containers], { silence: 'all', allowFail: true });
    process.stdout.write(`ploinky-box: '${instance}' and its volumes removed.\n`);
}

async function main() {
    const major = Number(process.versions.node.split('.')[0]);
    if (major < 20) die(`Node >= 20 is required (found ${process.versions.node})`);
    const cfg = parseCli(process.argv.slice(2));
    if (cfg.help) { process.stdout.write(usageText()); process.exit(0); }
    if (!cfg.command) { process.stdout.write(usageText()); process.exit(1); }
    const known = new Set(['up', 'start', 'cli', 'run', 'cp', 'status', 'logs', 'stop', 'update', 'destroy', 'help']);
    if (!known.has(cfg.command)) die(`unknown command '${cfg.command}' (see: ploinky-box --help)`);
    detectEngine(cfg);
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
        case 'help': process.stdout.write(usageText()); break;
    }
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
