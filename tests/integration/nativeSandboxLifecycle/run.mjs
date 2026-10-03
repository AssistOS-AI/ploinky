#!/usr/bin/env node
// Real native sandbox lifecycle runner (opt-in, dependency-free).
//
// Drives one lite-sandbox agent through `bin/ploinky-local` of a selected
// Ploinky checkout with the real host runtime (Seatbelt through
// /usr/bin/sandbox-exec on macOS, bubblewrap through /usr/bin/bwrap on Linux):
//
//   start -> stop -> start again (restage after stop) -> environment change
//   with start -> environment change with restart -> final stop
//
// Every claim is observed independently of Ploinky's own bookkeeping: the
// runner reads the registry and the PID record, but also asks the operating
// system (`ps` on macOS, `/proc` on Linux) for the process, its start
// identity, its argv and its descendants, asks the fixture process what it
// can see from inside the sandbox, and connects to its port.
//
// usage:
//   node run.mjs --runtime seatbelt|bwrap --source <ploinky checkout>
//                --artifacts <dir> [--agentlib <AchillesAgentLib checkout>]
//                [--mcp-sdk <mcp-sdk snapshot>] [--tmp-root <dir>]
//                [--scenario lifecycle|failed-first-start] [--engine absent|present]
//                [--teardown-deadline-ms <n>]
//
// Exit codes: 0 every step passed and cleanup verified, 1 a step or the
// cleanup failed, 2 unavailable-prerequisite (never a skip, never a
// fallback), 64 usage error, 129/130/143 interrupted by SIGHUP/SIGINT/SIGTERM.

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(HERE, 'fixture');
const RESULT_SCHEMA = 1;

const AGENT_NAME = 'lifecycle';
const FIXTURE_REPO = 'nativefix';
const AGENT_REF = `${FIXTURE_REPO}/${AGENT_NAME}`;
const BOOT_REPOS = Object.freeze(['AchillesIDE', 'AchillesCLI', 'copilot-agents']);
// The managed Router binds these two ports in code (cli/server/RoutingServer.js
// `const port = 8080; const privatePort = 8081;`); neither can be configured.
const ROUTER_PORT = 8080;
const ROUTER_PRIVATE_PORT = 8081;
const CONTAINER_ENGINES = Object.freeze(['podman', 'docker']);
const SYSTEM_DIRS = Object.freeze(['/usr/bin', '/bin', '/usr/sbin', '/sbin']);
const AGENTLIB_PACKAGE_NAME = 'ploinky-agent-lib';
const AGENTLIB_ENTRYPOINTS = Object.freeze(['package.json', 'LLMAgents/index.mjs', 'jwt/jwtSign.mjs']);
const PID_RECORD_KEYS = Object.freeze([
    'enableGeneration', 'instanceId', 'pid', 'processIdentity', 'runtimeKey', 'schemaVersion',
]);
const CLI_TIMEOUT_MS = 240_000;
const READY_TIMEOUT_MS = 30_000;
const TERM_GRACE_MS = 6_000;
const KILL_GRACE_MS = 3_000;
const CHILD_TERM_GRACE_MS = 5_000;
const TEARDOWN_DEADLINE_MS = 240_000;
const SIGNAL_EXIT_CODES = Object.freeze({ SIGHUP: 129, SIGINT: 130, SIGTERM: 143 });
const SCENARIOS = Object.freeze(['lifecycle', 'failed-first-start']);
const ENGINE_MODES = Object.freeze(['absent', 'present']);
const GATE_NAME = 'gate';
const GATE_REF = `${FIXTURE_REPO}/${GATE_NAME}`;

const RUNTIMES = Object.freeze({
    seatbelt: Object.freeze({ platform: 'darwin', binary: '/usr/bin/sandbox-exec' }),
    bwrap: Object.freeze({ platform: 'linux', binary: '/usr/bin/bwrap' }),
});

// ---------------------------------------------------------------- utilities

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const now = () => new Date().toISOString();
const sha256File = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function usage(message) {
    if (message) console.error(`run.mjs: ${message}`);
    console.error('usage: node run.mjs --runtime seatbelt|bwrap --source <ploinky checkout> '
        + '--artifacts <dir> [--agentlib <AchillesAgentLib checkout>] [--mcp-sdk <dir>] [--tmp-root <dir>] '
        + '[--scenario lifecycle|failed-first-start] [--engine absent|present] [--teardown-deadline-ms <n>]');
    process.exit(64);
}

function parseArgs(argv) {
    const known = new Set(['runtime', 'source', 'artifacts', 'agentlib', 'mcp-sdk', 'tmp-root', 'scenario', 'engine', 'teardown-deadline-ms']);
    const out = {};
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (!token.startsWith('--')) usage(`unexpected argument '${token}'`);
        const eq = token.indexOf('=');
        const key = eq === -1 ? token.slice(2) : token.slice(2, eq);
        if (!known.has(key)) usage(`unknown option '--${key}'`);
        let value;
        if (eq === -1) {
            value = argv[index + 1];
            index += 1;
        } else {
            value = token.slice(eq + 1);
        }
        if (value === undefined || value === '') usage(`option '--${key}' needs a value`);
        out[key] = value;
    }
    if (!out.runtime || !Object.hasOwn(RUNTIMES, out.runtime)) usage('--runtime must be seatbelt or bwrap');
    if (!out.source) usage('--source is required');
    if (!out.artifacts) usage('--artifacts is required');
    out.scenario = out.scenario || 'lifecycle';
    out.engine = out.engine || 'absent';
    if (!SCENARIOS.includes(out.scenario)) usage(`--scenario must be one of ${SCENARIOS.join(', ')}`);
    if (!ENGINE_MODES.includes(out.engine)) usage(`--engine must be one of ${ENGINE_MODES.join(', ')}`);
    out['teardown-deadline-ms'] = out['teardown-deadline-ms'] === undefined ? TEARDOWN_DEADLINE_MS : Number(out['teardown-deadline-ms']);
    if (!Number.isInteger(out['teardown-deadline-ms']) || out['teardown-deadline-ms'] < 1000) usage('--teardown-deadline-ms must be an integer of at least 1000');
    return out;
}

function tryRealpath(target) {
    try { return fs.realpathSync(target); } catch (_) { return null; }
}

function resolveOnPath(name, pathValue = process.env.PATH || '') {
    for (const dir of pathValue.split(path.delimiter).filter(Boolean)) {
        const candidate = path.join(dir, name);
        try {
            fs.accessSync(candidate, fs.constants.X_OK);
            if (fs.statSync(candidate).isFile()) return candidate;
        } catch (_) { /* keep looking */ }
    }
    return null;
}

// Observation tools run with the runner's own environment, pinned to the C
// locale so `ps -o lstart` text is stable and comparable with the child's.
const OBSERVER_ENV = Object.freeze({
    PATH: process.env.PATH || SYSTEM_DIRS.join(path.delimiter),
    LC_ALL: 'C',
    LANG: 'C',
});

// Helpers run detached, in their own process group: a terminal Ctrl-C goes to
// the foreground group, and must not kill an in-flight `ps` or `git` of the
// runner while it is cleaning up.
function runTool(file, args, { timeout = 15_000, env = OBSERVER_ENV, cwd } = {}) {
    const result = spawnSync(file, args, { encoding: 'utf8', timeout, env, cwd, detached: true });
    return {
        status: result.status,
        signal: result.signal,
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        error: result.error ? String(result.error.message || result.error) : null,
    };
}

// --------------------------------------------------------------- the result

class Result {
    constructor(file, base) {
        this.file = file;
        this.doc = {
            schemaVersion: RESULT_SCHEMA,
            result: 'running',
            startedAt: now(),
            finishedAt: null,
            ...base,
            steps: [],
        };
    }

    save() {
        const tmp = `${this.file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, `${JSON.stringify(this.doc, null, 2)}\n`);
        fs.renameSync(tmp, this.file);
    }
}

// --------------------------------------------------- process observation
// The observer reads the operating system, never Ploinky's records. Start
// identity uses the same text forms Ploinky records (`ps-lstart:` on macOS,
// `linux-proc:` on Linux) so equality with a PID record can be asserted. The
// macOS form has one-second granularity: this runner cannot prove resistance
// to a hypothetical sub-second PID reuse collision.

const IS_LINUX = process.platform === 'linux';
const PS = IS_LINUX ? null : (resolveOnPath('ps', SYSTEM_DIRS.join(path.delimiter)) || resolveOnPath('ps'));

function parseProcStat(pid) {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const commandEnd = stat.lastIndexOf(')');
    if (commandEnd < 0) return null;
    const fields = stat.slice(commandEnd + 1).trim().split(/\s+/);
    return {
        comm: stat.slice(stat.indexOf('(') + 1, commandEnd),
        state: fields[0],
        ppid: Number(fields[1]),
        pgid: Number(fields[2]),
        startTicks: String(fields[19] || ''),
    };
}

function readCmdline(pid) {
    try {
        const raw = fs.readFileSync(`/proc/${pid}/cmdline`);
        const parts = raw.toString('utf8').split('\0');
        if (parts.length && parts[parts.length - 1] === '') parts.pop();
        return parts;
    } catch (_) {
        return [];
    }
}

// `ps` can be killed or time out; that is not the same as "no such process".
// Retry a failed invocation, and let the caller see an error if it keeps failing.
function runPs(args) {
    let last = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
        last = runTool(PS, args);
        if (last.status !== null) return last;
    }
    throw new Error(`ps did not complete (${last.signal || last.error || 'unknown'})`);
}

function processTable() {
    const rows = [];
    if (IS_LINUX) {
        for (const name of fs.readdirSync('/proc')) {
            if (!/^[0-9]+$/.test(name)) continue;
            try {
                const stat = parseProcStat(name);
                if (!stat) continue;
                const argv = readCmdline(name);
                rows.push({
                    pid: Number(name), ppid: stat.ppid, pgid: stat.pgid, state: stat.state,
                    args: argv.length ? argv.join(' ') : `[${stat.comm}]`,
                });
            } catch (_) { /* the process exited while listing */ }
        }
        return rows;
    }
    const listed = runPs(['-axo', 'pid=,ppid=,pgid=,stat=,command=']);
    if (listed.status !== 0) throw new Error(`ps failed: ${listed.stderr || listed.error}`);
    for (const line of listed.stdout.split('\n')) {
        const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
        if (match) {
            rows.push({
                pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]),
                state: match[4], args: match[5],
            });
        }
    }
    return rows;
}

// One process, observed directly. Returns null when it does not exist.
function processInfo(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    if (IS_LINUX) {
        try {
            const stat = parseProcStat(pid);
            if (!stat) return null;
            const argv = readCmdline(pid);
            let exe = null;
            let cwd = null;
            try { exe = fs.readlinkSync(`/proc/${pid}/exe`); } catch (_) { /* not permitted */ }
            try { cwd = fs.readlinkSync(`/proc/${pid}/cwd`); } catch (_) { /* not permitted */ }
            return {
                pid, ppid: stat.ppid, pgid: stat.pgid, state: stat.state,
                zombie: stat.state === 'Z', comm: stat.comm,
                identity: stat.startTicks ? `linux-proc:${stat.startTicks}` : '',
                argv, args: argv.join(' '), exe, cwd,
            };
        } catch (_) {
            return null;
        }
    }
    const listed = runPs(['-p', String(pid), '-o', 'ppid=,pgid=,stat=,lstart=,command=']);
    if (listed.status !== 0) return null;
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/m.exec(listed.stdout);
    if (!match) return null;
    return {
        pid, ppid: Number(match[1]), pgid: Number(match[2]), state: match[3],
        zombie: match[3].startsWith('Z'),
        identity: `ps-lstart:${match[4].trim().replace(/\s+/g, ' ')}`,
        argv: null, args: match[5], exe: null, cwd: null,
    };
}

const isLive = (info) => Boolean(info) && !info.zombie;

// Descendants by parent links plus members of the root's process group: the
// sandbox root is detached, so its group is its own.
function descendantsOf(rootPid, table) {
    const children = new Map();
    for (const row of table) {
        if (!children.has(row.ppid)) children.set(row.ppid, []);
        children.get(row.ppid).push(row);
    }
    const found = new Map();
    const queue = [rootPid];
    while (queue.length) {
        const current = queue.shift();
        for (const child of children.get(current) || []) {
            if (!found.has(child.pid)) {
                found.set(child.pid, child);
                queue.push(child.pid);
            }
        }
    }
    for (const row of table) {
        if (row.pgid === rootPid && row.pid !== rootPid && !found.has(row.pid)) found.set(row.pid, row);
    }
    return [...found.values()];
}

function ancestorsOfSelf(table) {
    const byPid = new Map(table.map((row) => [row.pid, row]));
    const out = new Set([process.pid]);
    let cursor = byPid.get(process.pid);
    while (cursor && cursor.ppid > 0 && !out.has(cursor.ppid)) {
        out.add(cursor.ppid);
        cursor = byPid.get(cursor.ppid);
    }
    return out;
}

// ------------------------------------------------------------------ ports

function portFree(port, host) {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.once('error', () => resolve(false));
        server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(true)));
    });
}

async function portStatus(port) {
    const hosts = ['127.0.0.1', '0.0.0.0'];
    const checked = {};
    for (const host of hosts) checked[host] = await portFree(port, host);
    return { port, free: hosts.every((host) => checked[host]), hosts: checked };
}

function pickFreePort(avoid = []) {
    return new Promise((resolve, reject) => {
        const attempt = () => {
            const server = net.createServer();
            server.once('error', reject);
            server.listen({ port: 0, host: '127.0.0.1' }, () => {
                const { port } = server.address();
                server.close(() => (avoid.includes(port) ? attempt() : resolve(port)));
            });
        };
        attempt();
    });
}

function linuxListenerPids(port) {
    const inodes = new Set();
    for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
        let text = '';
        try { text = fs.readFileSync(table, 'utf8'); } catch (_) { continue; }
        for (const line of text.split('\n').slice(1)) {
            const columns = line.trim().split(/\s+/);
            if (columns.length < 10 || columns[3] !== '0A') continue;
            if (parseInt(columns[1].split(':')[1], 16) === port) inodes.add(columns[9]);
        }
    }
    const pids = [];
    if (!inodes.size) return pids;
    for (const name of fs.readdirSync('/proc')) {
        if (!/^[0-9]+$/.test(name)) continue;
        let fds = [];
        try { fds = fs.readdirSync(`/proc/${name}/fd`); } catch (_) { continue; }
        for (const fd of fds) {
            try {
                const target = fs.readlinkSync(`/proc/${name}/fd/${fd}`);
                const match = /^socket:\[(\d+)\]$/.exec(target);
                if (match && inodes.has(match[1])) { pids.push(Number(name)); break; }
            } catch (_) { /* descriptor closed */ }
        }
    }
    return pids;
}

// Pids listening on a TCP port; null when this host cannot attribute.
function listenerPids(port) {
    if (IS_LINUX) return linuxListenerPids(port);
    const lsof = resolveOnPath('lsof', ['/usr/sbin', '/usr/bin', '/sbin', '/bin'].join(path.delimiter));
    if (!lsof) return null;
    const listed = runTool(lsof, ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp']);
    if (listed.status !== 0 && listed.status !== 1) return null;
    return listed.stdout.split('\n').filter((line) => /^p\d+$/.test(line)).map((line) => Number(line.slice(1)));
}

// ------------------------------------------------------------------- http

function httpGetJson(port, urlPath = '/probe', timeoutMs = 2_000) {
    return new Promise((resolve) => {
        const request = http.get({ host: '127.0.0.1', port, path: urlPath, timeout: timeoutMs }, (response) => {
            const chunks = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                try {
                    resolve({ ok: response.statusCode === 200, status: response.statusCode, body: JSON.parse(text) });
                } catch (_) {
                    resolve({ ok: false, status: response.statusCode, error: 'response is not JSON', text: text.slice(0, 200) });
                }
            });
        });
        request.on('timeout', () => request.destroy(new Error('timeout')));
        request.on('error', (error) => resolve({ ok: false, status: null, error: error.code || error.message }));
    });
}

async function waitForProbe(port, { timeoutMs = READY_TIMEOUT_MS } = {}) {
    const deadline = Date.now() + timeoutMs;
    let attempts = 0;
    let last = null;
    while (Date.now() < deadline) {
        attempts += 1;
        last = await httpGetJson(port);
        if (last.ok) return { ...last, attempts };
        await sleep(250);
    }
    return { ...(last || { ok: false }), attempts };
}

// ---------------------------------------------------------- prerequisites

function probeSeatbelt() {
    const missing = [];
    const details = { binary: RUNTIMES.seatbelt.binary };
    if (process.platform !== 'darwin') {
        missing.push(`platform: seatbelt requires macOS (this host is ${process.platform})`);
    }
    const binary = RUNTIMES.seatbelt.binary;
    if (!fs.existsSync(binary)) {
        missing.push(`runtime: ${binary} does not exist`);
        return { missing, details };
    }
    details.realpath = tryRealpath(binary);
    details.sha256 = sha256File(binary);
    const probe = runTool(binary, ['-p', '(version 1)(allow default)', '/bin/echo', 'seatbelt-probe-ok']);
    details.probe = { status: probe.status, stdout: probe.stdout.trim(), stderr: probe.stderr.trim() };
    if (probe.status !== 0 || probe.stdout.trim() !== 'seatbelt-probe-ok') {
        missing.push(`runtime: ${binary} cannot run a trivial profile (status ${probe.status}: ${probe.stderr.trim() || probe.error || 'no output'})`);
    }
    return { missing, details };
}

function probeBwrap() {
    const missing = [];
    const details = { binary: RUNTIMES.bwrap.binary };
    if (process.platform !== 'linux') {
        missing.push(`platform: bwrap requires Linux (this host is ${process.platform})`);
    }
    const binary = RUNTIMES.bwrap.binary;
    if (!fs.existsSync(binary)) {
        missing.push(`runtime: ${binary} does not exist`);
        return { missing, details };
    }
    details.realpath = tryRealpath(binary);
    details.sha256 = sha256File(binary);
    const version = runTool(binary, ['--version']);
    details.version = version.stdout.trim() || version.stderr.trim();
    if (version.status !== 0) {
        missing.push(`runtime: ${binary} --version failed (${version.stderr.trim() || version.error})`);
        return { missing, details };
    }
    const trueBinary = resolveOnPath('true', SYSTEM_DIRS.join(path.delimiter)) || '/bin/true';
    const probe = runTool(binary, [
        '--unshare-all', '--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev', trueBinary,
    ]);
    details.probe = { status: probe.status, stderr: probe.stderr.trim() };
    if (probe.status !== 0) {
        missing.push(`runtime: ${binary} cannot start a trivial --unshare-all sandbox (status ${probe.status}: ${probe.stderr.trim() || probe.error || 'no output'})`);
    }
    return { missing, details };
}

function validateAgentLib(dir) {
    const missing = [];
    if (!dir) {
        missing.push('agentlib: pass --agentlib <AchillesAgentLib checkout> or set PLOINKY_TEST_AGENTLIB_DIR');
        return { missing, realpath: null };
    }
    const real = tryRealpath(dir);
    if (!real || !fs.statSync(real).isDirectory()) {
        missing.push(`agentlib: ${dir} is not a directory`);
        return { missing, realpath: null };
    }
    let name = null;
    try { name = JSON.parse(fs.readFileSync(path.join(real, 'package.json'), 'utf8')).name; } catch (_) { /* reported below */ }
    if (name !== AGENTLIB_PACKAGE_NAME) {
        missing.push(`agentlib: ${real}/package.json name is ${JSON.stringify(name)}, expected "${AGENTLIB_PACKAGE_NAME}"`);
    }
    for (const entry of AGENTLIB_ENTRYPOINTS) {
        if (!fs.existsSync(path.join(real, entry))) missing.push(`agentlib: ${real} is missing ${entry}`);
    }
    return { missing, realpath: real };
}

// PATH for every Ploinky child. With no engine in the system directories the
// PATH is a private bin (a `node` symlink) followed by those directories. A
// host that ships podman or docker there gets a private bin that mirrors the
// system directories minus the engines, and nothing else.
function planPrivatePath(engine = 'absent') {
    if (engine === 'present') {
        // The real podman stays reachable on the children's PATH. Whether it can
        // reach a machine is up to the environment; the runner only records it.
        const podman = resolveOnPath('podman');
        return {
            mode: 'private-bin-plus-system-dirs-plus-podman', engine, engineHits: [],
            enginePath: podman, engineDir: podman ? path.dirname(podman) : null,
        };
    }
    const engineHits = [];
    for (const dir of SYSTEM_DIRS) {
        for (const engine of CONTAINER_ENGINES) {
            if (fs.existsSync(path.join(dir, engine))) engineHits.push(path.join(dir, engine));
        }
    }
    return { mode: engineHits.length ? 'mirror-without-engines' : 'private-bin-plus-system-dirs', engine, engineHits };
}

function buildPrivateBin(binDir, plan) {
    fs.mkdirSync(binDir, { recursive: true });
    fs.symlinkSync(fs.realpathSync(process.execPath), path.join(binDir, 'node'));
    if (plan.mode === 'private-bin-plus-system-dirs') {
        return [binDir, ...SYSTEM_DIRS].join(path.delimiter);
    }
    if (plan.mode === 'private-bin-plus-system-dirs-plus-podman') {
        return [...new Set([binDir, ...SYSTEM_DIRS, plan.engineDir])].join(path.delimiter);
    }
    for (const dir of SYSTEM_DIRS) {
        let entries = [];
        try { entries = fs.readdirSync(dir); } catch (_) { continue; }
        for (const entry of entries) {
            if (CONTAINER_ENGINES.includes(entry) || entry === 'node') continue;
            const target = path.join(dir, entry);
            const link = path.join(binDir, entry);
            try {
                fs.accessSync(target, fs.constants.X_OK);
                if (!fs.existsSync(link) && !fs.lstatSync(link, { throwIfNoEntry: false })) fs.symlinkSync(target, link);
            } catch (_) { /* not executable: not mirrored */ }
        }
    }
    return binDir;
}

function engineVisible(pathValue) {
    const found = [];
    for (const engine of CONTAINER_ENGINES) {
        const hit = resolveOnPath(engine, pathValue);
        if (hit) found.push(hit);
    }
    return found;
}

async function checkPrerequisites(options) {
    const missing = [];
    const details = {};
    const runtimeProbe = options.runtime === 'seatbelt' ? probeSeatbelt() : probeBwrap();
    missing.push(...runtimeProbe.missing);
    details.runtime = runtimeProbe.details;

    const nodeVersion = runTool(process.execPath, ['--version']);
    details.node = { execPath: process.execPath, version: nodeVersion.stdout.trim() };
    if (nodeVersion.status !== 0) missing.push('node: the running node binary does not execute');

    const git = resolveOnPath('git', SYSTEM_DIRS.join(path.delimiter)) || resolveOnPath('git');
    details.git = git;
    if (!git) missing.push('git: not found on PATH (the fixture repositories are git repositories)');
    else if (runTool(git, ['--version']).status !== 0) missing.push(`git: ${git} does not run`);
    if (!IS_LINUX && !PS) missing.push('ps: not found (macOS process observation needs it)');
    if (IS_LINUX && !fs.existsSync('/proc/self/stat')) missing.push('/proc: not mounted (Linux process observation reads it)');

    const source = tryRealpath(options.source);
    details.source = source;
    if (!source) {
        missing.push(`source: ${options.source} does not exist`);
    } else {
        for (const entry of ['bin/ploinky-local', 'cli/index.js', 'agentlib/bootstrap.mjs']) {
            const target = path.join(source, entry);
            if (!fs.existsSync(target)) missing.push(`source: ${target} does not exist`);
        }
        try { fs.accessSync(path.join(source, 'bin/ploinky-local'), fs.constants.X_OK); } catch (_) {
            missing.push(`source: ${path.join(source, 'bin/ploinky-local')} is not executable`);
        }
    }

    const agentLib = validateAgentLib(options.agentlib || process.env.PLOINKY_TEST_AGENTLIB_DIR || '');
    missing.push(...agentLib.missing);
    details.agentlib = agentLib.realpath;

    details.mcpSdk = { present: false, linkFrom: null };
    if (source) {
        const existing = path.join(source, 'node_modules', 'mcp-sdk');
        let present = false;
        try { present = fs.statSync(existing).isDirectory(); } catch (_) { /* absent */ }
        details.mcpSdk.present = present;
        if (!present) {
            const snapshot = options['mcp-sdk'] || process.env.PLOINKY_TEST_MCP_SDK_DIR || '';
            const real = snapshot ? tryRealpath(snapshot) : null;
            if (!real || !fs.existsSync(path.join(real, 'package.json'))) {
                missing.push(`mcp-sdk: ${existing} is missing and no usable snapshot was given (--mcp-sdk or PLOINKY_TEST_MCP_SDK_DIR)`);
            } else {
                details.mcpSdk.linkFrom = real;
            }
        }
    }

    // The workspace parent must exist and be writable, and it must be short:
    // the Router health socket lives under the workspace and Unix socket paths
    // are limited to 104 bytes. This is decided before any resource is created.
    const wantedBase = options['tmp-root'] || (process.platform === 'darwin' ? '/tmp' : os.tmpdir());
    const realBase = tryRealpath(wantedBase);
    details.tmpRoot = realBase;
    if (!realBase || !fs.statSync(realBase).isDirectory()) {
        missing.push(`tmp-root: ${wantedBase} is not an existing directory`);
    } else {
        try { fs.accessSync(realBase, fs.constants.W_OK); } catch (_) {
            missing.push(`tmp-root: ${realBase} is not writable`);
        }
        const longest = path.join(realBase, 'pnl-XXXXXX', 'ws', '.ploinky', 'run', 'router-health.sock');
        if (Buffer.byteLength(longest) > 100) {
            missing.push(`tmp-root: ${realBase} is too long for Unix socket paths inside the workspace (104-byte limit); pass a shorter --tmp-root`);
        }
    }

    const plan = planPrivatePath(options.engine);
    details.pathPlan = plan;
    if (options.engine === 'present' && !plan.enginePath) {
        missing.push('engine: --engine present needs a podman executable on the runner PATH');
    }

    details.routerPorts = [];
    for (const port of [ROUTER_PORT, ROUTER_PRIVATE_PORT]) {
        const status = await portStatus(port);
        details.routerPorts.push(status);
        if (!status.free) {
            missing.push(`port: ${port} is in use; the managed Router binds it unconditionally, so the runner cannot choose another`);
        }
    }
    return { missing, details };
}

// -------------------------------------------------------------- workspace

class Workspace {
    constructor(options, prerequisites, result) {
        this.options = options;
        this.runtime = options.runtime;
        this.source = prerequisites.details.source;
        this.agentLib = prerequisites.details.agentlib;
        this.pathPlan = prerequisites.details.pathPlan;
        this.mcpSdkLinkFrom = prerequisites.details.mcpSdk.linkFrom;
        this.tmpRoot = prerequisites.details.tmpRoot;
        this.state = null;
        this.activeChild = null;
        this.teardownPromise = null;
        this.foreign = new Map();
        this.result = result;
        this.root = null;
        this.created = { mcpSdkLink: null, nodeModulesDir: null };
        this.recorded = new Map();
        this.stepIndex = 0;
        this.seenTuples = [];
        this.fixturePort = 0;
        this.gatePort = 0;
        this.scenario = options.scenario;
        this.receiptsSeen = new Map();
        this.cleanupDone = new Set();
        this.bystander = null;
        this.git = prerequisites.details.git;
    }

    get ws() { return path.join(this.root, 'ws'); }
    get ploinkyDir() { return path.join(this.ws, '.ploinky'); }
    get home() { return path.join(this.root, 'home'); }
    get agentDir() { return path.join(this.ploinkyDir, 'repos', FIXTURE_REPO, AGENT_NAME); }
    get manifestPath() { return path.join(this.agentDir, 'manifest.json'); }
    get gateManifestPath() { return path.join(this.ploinkyDir, 'repos', FIXTURE_REPO, GATE_NAME, 'manifest.json'); }
    get cli() { return path.join(this.source, 'bin', 'ploinky-local'); }
}

function gitEnv(ws) {
    return { ...OBSERVER_ENV, HOME: ws.home, GIT_TERMINAL_PROMPT: '0' };
}

function git(ws, cwd, args) {
    const out = runTool(ws.git, ['-C', cwd, ...args], { env: gitEnv(ws) });
    if (out.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${out.stderr || out.error}`);
    return out.stdout.trim();
}

function createRoot(ws) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(ws.tmpRoot, 'pnl-')));
    fs.writeFileSync(path.join(root, '.pnl-owned'), `${process.pid}\n`);
    return root;
}

function copyAgentLib(from, to) {
    // The selected AgentLib must be a real directory inside the workspace:
    // validateAgentLibSource rejects a symlink root and the selection must lie
    // within the workspace root. Only `.git` is left out, as in its fingerprint.
    fs.cpSync(from, to, {
        recursive: true,
        verbatimSymlinks: true,
        filter: (src) => path.basename(src) !== '.git',
    });
}

function writeGitConfig(ws) {
    fs.mkdirSync(ws.home, { recursive: true });
    const tripwire = path.join(ws.root, 'nonexistent-network-tripwire');
    const config = [
        '[user]',
        '\tname = Ploinky Native Lifecycle',
        '\temail = native-lifecycle@example.invalid',
        '[init]',
        '\tdefaultBranch = main',
        `[url "${tripwire}/https/"]`,
        '\tinsteadOf = https://github.com/',
        `[url "${tripwire}/ssh/"]`,
        '\tinsteadOf = git@github.com:',
        '',
    ].join('\n');
    fs.writeFileSync(path.join(ws.home, '.gitconfig'), config);
    return tripwire;
}

function initLocalRepo(ws, dir, files, message) {
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
        const target = path.join(dir, name);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
    }
    git(ws, dir, ['init', '-q']);
    git(ws, dir, ['add', '-A']);
    git(ws, dir, ['commit', '-q', '-m', message]);
    return git(ws, dir, ['rev-parse', 'HEAD']);
}

function renderManifest(ws, { marker }) {
    const template = fs.readFileSync(path.join(FIXTURE_DIR, 'lifecycle', 'manifest.json'), 'utf8')
        .replaceAll('__MARKER__', marker)
        .replaceAll('__PROBE_PATH__', path.join(ws.ploinkyDir, 'data'))
        .replaceAll('__PORT__', String(ws.fixturePort));
    JSON.parse(template);
    return template;
}

function renderGateManifest(ws, { fail }) {
    const template = fs.readFileSync(path.join(FIXTURE_DIR, 'gate', 'manifest.json'), 'utf8')
        .replaceAll('__FAIL__', fail ? '1' : '0')
        .replaceAll('__PROBE_PATH__', path.join(ws.ploinkyDir, 'data'))
        .replaceAll('__PORT__', String(ws.gatePort));
    JSON.parse(template);
    return template;
}

// ------------------------------------------------------------ CLI children

function buildChildEnv(ws) {
    // Nothing is inherited: no PLOINKY_* variable (in particular neither
    // PLOINKY_DISABLE_HOST_SANDBOX nor PLOINKY_AGENTLIB_DIR), no container
    // engine configuration, no NODE_OPTIONS, no real HOME.
    const env = {
        HOME: ws.home,
        PATH: ws.childPath,
        TMPDIR: path.join(ws.root, 'tmp'),
        LC_ALL: 'C',
        LANG: 'C',
        GIT_TERMINAL_PROMPT: '0',
    };
    // With an engine present, the two variables a rootless Podman reads to find
    // its storage and runtime directory are passed through when set.
    if (ws.options.engine === 'present') {
        for (const name of ['CONTAINERS_STORAGE_CONF', 'XDG_RUNTIME_DIR']) {
            if (process.env[name]) env[name] = process.env[name];
        }
    }
    return env;
}

async function runChild(ws, step, file, args, { timeoutMs = CLI_TIMEOUT_MS } = {}) {
    const stepsDir = path.join(ws.options.artifacts, 'steps');
    fs.mkdirSync(stepsDir, { recursive: true });
    const stem = path.join(stepsDir, `${String(step.index).padStart(2, '0')}-${step.name}`);
    const outFd = fs.openSync(`${stem}.stdout.log`, 'w');
    const errFd = fs.openSync(`${stem}.stderr.log`, 'w');
    const env = buildChildEnv(ws);
    const startedAt = Date.now();
    step.child = {
        argv: [file, ...args],
        cwd: ws.ws,
        envNames: Object.keys(env),
        path: env.PATH,
        stdout: path.relative(ws.options.artifacts, `${stem}.stdout.log`),
        stderr: path.relative(ws.options.artifacts, `${stem}.stderr.log`),
    };
    // The child leads its own process group, so an interrupt or a timeout can
    // end the whole subtree (the `ploinky-local` bash wrapper does not exec its
    // node CLI), and the group is the ownership proof for that subtree.
    const child = spawn(file, args, { cwd: ws.ws, env, stdio: ['ignore', outFd, errFd], detached: true });
    let spawnError = null;
    const exited = new Promise((resolve) => {
        child.once('error', (error) => { spawnError = String(error.message || error); resolve({ exitCode: null, signal: null }); });
        child.once('exit', (exitCode, signal) => resolve({ exitCode, signal }));
    });
    const active = { child, exited, stepName: step.name, terminating: null, report: null };
    ws.activeChild = active;
    const timer = setTimeout(() => { terminateChildGroup(ws, active).catch(() => { /* reported by the exit status */ }); }, timeoutMs);
    // Everything below this runner-spawned child (found by parent link while it
    // runs) is owned by the runner and may be cleaned up at teardown.
    const seen = new Set();
    let polling = Boolean(child.pid);
    const poller = (async () => {
        while (polling) {
            try {
                for (const row of descendantsOf(child.pid, processTable())) {
                    if (seen.has(row.pid)) continue;
                    seen.add(row.pid);
                    recordProcess(ws, processInfo(row.pid), 'cli-descendant', step.name, 'descendant of a runner-spawned child');
                }
            } catch (_) { /* best effort */ }
            await sleep(200);
        }
    })();
    const finished = await exited;
    // An interrupt or timeout ends the group; the step does not return (and the
    // next command, such as teardown's `stop`, does not start) before it is gone.
    if (active.terminating) {
        await active.terminating;
        step.child.termination = active.report;
    }
    polling = false;
    clearTimeout(timer);
    ws.activeChild = null;
    await poller;
    const outcome = { ...finished, error: spawnError };
    fs.closeSync(outFd);
    fs.closeSync(errFd);
    step.child.exitCode = outcome.exitCode;
    step.child.signal = outcome.signal;
    step.child.error = outcome.error;
    step.child.durationMs = Date.now() - startedAt;
    step.child.stdoutText = fs.readFileSync(`${stem}.stdout.log`, 'utf8');
    step.child.stderrText = fs.readFileSync(`${stem}.stderr.log`, 'utf8');
    return outcome;
}

function summarizeChildText(step) {
    const text = `${step.child.stdoutText}\n${step.child.stderrText}`;
    const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
    return {
        readyLines: lines.filter((line) => /ready after|Readiness \d+\/\d+ ready/.test(line)),
        errorLines: lines.filter((line) => /^(?:❌|Error|\[ERROR\])|Error:/.test(line)).slice(0, 5),
        startedLines: lines.filter((line) => /started with PID|Stopped|sent SIG/.test(line)).slice(0, 8),
        tail: lines.slice(-6),
    };
}

// --------------------------------------------------------- step machinery

function newStep(ws, name, description) {
    ws.stepIndex += 1;
    const step = {
        index: ws.stepIndex, name, description, status: 'running', startedAt: now(), finishedAt: null,
        assertions: [], observations: {},
    };
    ws.result.doc.steps.push(step);
    return step;
}

function check(step, name, ok, detail) {
    step.assertions.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
    return Boolean(ok);
}

function finishStep(ws, step) {
    // The captured stdout/stderr text lives in the per-step log files only.
    if (step.child) { delete step.child.stdoutText; delete step.child.stderrText; }
    step.status = step.assertions.every((entry) => entry.ok) ? 'pass' : 'fail';
    step.finishedAt = now();
    ws.result.save();
    const failed = step.assertions.filter((entry) => !entry.ok).map((entry) => entry.name);
    console.log(`[${step.status}] ${String(step.index).padStart(2, '0')} ${step.name}${failed.length ? `  (failed: ${failed.join('; ')})` : ''}`);
    return step.status === 'pass';
}

// Only processes the runner can prove it owns are recorded, and only recorded
// processes are ever signalled. `proof` says why the process is owned.
const SPECIFIC_ROLES = Object.freeze(['watchdog', 'router-child', 'agent-root', 'agent-descendant']);
const GENERIC_ROLES = Object.freeze(['cli-descendant', 'owned-descendant']);

function recordProcess(ws, info, role, stepName, proof, extra = {}) {
    if (!info || !info.identity) return;
    const key = `${info.pid}:${info.identity}`;
    const existing = ws.recorded.get(key);
    if (existing) {
        existing.lastSeenStep = stepName;
        if (GENERIC_ROLES.includes(existing.role) && SPECIFIC_ROLES.includes(role)) {
            existing.role = role;
            existing.proof = `${existing.proof}; ${proof}`;
        }
        if (extra.ownerKey && !existing.ownerKey) existing.ownerKey = extra.ownerKey;
        return;
    }
    ws.recorded.set(key, {
        pid: info.pid, identity: info.identity, role, proof, ppid: info.ppid, pgid: info.pgid,
        args: info.args, firstSeenStep: stepName, lastSeenStep: stepName, ownerKey: extra.ownerKey || null,
    });
}

// ----------------------------------------------------------- registry/PID

function readJsonFile(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function readRegistry(ws, agentName = AGENT_NAME) {
    const agents = readJsonFile(path.join(ws.ploinkyDir, 'agents.json')) || {};
    const entries = Object.entries(agents).filter(([key, record]) => (
        key !== '_config' && record && record.agentName === agentName && record.repoName === FIXTURE_REPO));
    if (!entries.length) return null;
    const [key, record] = entries[0];
    return {
        key,
        entries: entries.length,
        hasRuntimeField: Object.prototype.hasOwnProperty.call(record, 'runtime'),
        type: record.type,
        fields: Object.keys(record).sort(),
        runtime: record.runtime,
        pid: record.pid,
        instanceId: record.instanceId,
        enableGeneration: record.enableGeneration,
        envHash: record.envHash,
        profile: record.profile,
        ports: record.config && record.config.ports,
    };
}

function readPidRecords(ws) {
    const dir = path.join(ws.ploinkyDir, 'bwrap-pids');
    let names = [];
    try { names = fs.readdirSync(dir).filter((name) => name.endsWith('.pid')).sort(); } catch (_) { return []; }
    return names.map((name) => {
        const file = path.join(dir, name);
        let raw = '';
        try { raw = fs.readFileSync(file, 'utf8'); } catch (_) { /* vanished */ }
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch (_) { /* reported by the caller */ }
        return { file: path.relative(ws.root, file), key: name.slice(0, -'.pid'.length), raw: raw.trim(), parsed };
    });
}

function readRouterPid(ws) {
    try {
        const pid = Number(fs.readFileSync(path.join(ws.ploinkyDir, 'running', 'router.pid'), 'utf8').trim());
        return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
    } catch (_) {
        return null;
    }
}

// Every live descendant (parent link, or member of the process group of a
// detached root) of a recorded process is owned too, and is recorded with its
// identity now, while the parent link still exists: once the parent dies the
// child is reparented to init and nothing would link it to the run any more.
// A recorded process counts as a parent only while its start identity still
// matches, so a reused pid never lends ownership. Returns how many were added.
function recordOwnedDescendants(ws, table, stepName) {
    let added = 0;
    const present = new Set(table.map((row) => row.pid));
    for (const entry of [...ws.recorded.values()]) {
        if (!present.has(entry.pid)) continue;
        const rows = descendantsOf(entry.pid, table).filter((row) => !isRecordedPid(ws, row.pid));
        if (!rows.length || !sameProcess(processInfo(entry.pid), entry)) continue;
        for (const row of rows) {
            const info = processInfo(row.pid);
            if (!isLive(info) || ws.recorded.has(`${info.pid}:${info.identity}`)) continue;
            recordProcess(ws, info, 'owned-descendant', stepName, `descendant of owned ${entry.role} ${entry.pid} (parent link observed at ${stepName})`, { ownerKey: entry.ownerKey });
            added += 1;
        }
    }
    return added;
}

function isRecordedPid(ws, pid) {
    for (const entry of ws.recorded.values()) if (entry.pid === pid) return true;
    return false;
}

// A process whose start identity equals a PID record's processIdentity is the
// agent Ploinky bound to that record, whenever the record is read.
function recordPidRecordRoots(ws, stepName) {
    let added = 0;
    for (const entry of readPidRecords(ws)) {
        const rootPid = entry.parsed && entry.parsed.pid;
        if (!Number.isSafeInteger(rootPid)) continue;
        const info = processInfo(rootPid);
        if (!isLive(info) || info.identity !== entry.parsed.processIdentity) continue;
        if (ws.recorded.has(`${info.pid}:${info.identity}`)) continue;
        recordProcess(ws, info, 'agent-root', stepName, 'observed start identity equals the PID record processIdentity', { ownerKey: entry.key });
        added += 1;
    }
    return added;
}

// Registers the processes this run can prove it owns:
//   - the Router watchdog named by running/router.pid, when its argv is the
//     selected checkout's Watchdog.js, and the RoutingServer.js children of it;
//   - an agent root whose observed start identity equals a PID record's
//     processIdentity, and the descendants of that root;
//   - descendants of a runner-spawned child (recorded while the child runs).
// A registry pid alone, a stale router.pid and a process that merely names the
// workspace path prove nothing: none is recorded. Processes that name the
// workspace path without being owned are reported as foreign and fail the run
// as residue; they are never signalled.
function observeProcesses(ws, stepName) {
    const table = processTable();
    const skip = ancestorsOfSelf(table);
    const out = { router: null, agent: null, agents: {}, unproven: [], foreignWorkspaceProcesses: [] };
    const watchdogPath = path.join(ws.source, 'cli', 'server', 'Watchdog.js');
    const routingServerPath = path.join(ws.source, 'cli', 'server', 'RoutingServer.js');

    const routerPid = readRouterPid(ws);
    if (routerPid) {
        const info = processInfo(routerPid);
        if (isLive(info) && info.args.includes(watchdogPath)) {
            const tree = descendantsOf(routerPid, table);
            out.router = {
                pidFile: routerPid, watchdog: { pid: info.pid, identity: info.identity, args: info.args },
                children: tree.map((row) => ({ pid: row.pid, args: row.args })),
            };
            recordProcess(ws, info, 'watchdog', stepName, 'running/router.pid and Watchdog.js argv of the selected checkout');
            for (const row of tree) {
                if (row.args.includes(routingServerPath)) {
                    recordProcess(ws, processInfo(row.pid), 'router-child', stepName, 'child of the recorded watchdog running RoutingServer.js');
                }
            }
        } else {
            out.unproven.push({ kind: 'router.pid', pid: routerPid, live: isLive(info), args: info && info.args });
        }
    }

    for (const entry of readPidRecords(ws)) {
        const rootPid = entry.parsed && entry.parsed.pid;
        if (!Number.isSafeInteger(rootPid)) continue;
        const info = processInfo(rootPid);
        if (!isLive(info)) continue;
        if (info.identity !== entry.parsed.processIdentity) {
            out.unproven.push({ kind: 'pid-record', pid: rootPid, recorded: entry.parsed.processIdentity, observed: info.identity });
            continue;
        }
        const tree = descendantsOf(rootPid, table);
        recordProcess(ws, info, 'agent-root', stepName, 'observed start identity equals the PID record processIdentity', { ownerKey: entry.key });
        for (const row of tree) {
            recordProcess(ws, processInfo(row.pid), 'agent-descendant', stepName, `descendant of agent root ${rootPid}`, { ownerKey: entry.key });
        }
        out.agent = { rootPid, root: { pid: info.pid, identity: info.identity, args: info.args, argv: info.argv, exe: info.exe },
            descendants: tree.map((row) => ({ pid: row.pid, ppid: row.ppid, args: row.args })) };
        out.agents[entry.key] = out.agent;
    }

    recordOwnedDescendants(ws, table, stepName);

    const bystanderPid = ws.bystander && ws.bystander.pid;
    for (const row of table) {
        if (skip.has(row.pid) || row.pid === bystanderPid || !row.args.includes(ws.root)) continue;
        const info = processInfo(row.pid);
        if (info && ws.recorded.has(`${info.pid}:${info.identity}`)) continue;
        out.foreignWorkspaceProcesses.push({ pid: row.pid, args: row.args });
        if (info) {
            const key = `${info.pid}:${info.identity}`;
            const previous = ws.foreign.get(key);
            if (previous) previous.lastSeenStep = stepName;
            else ws.foreign.set(key, { pid: info.pid, identity: info.identity, args: info.args, firstSeenStep: stepName, lastSeenStep: stepName });
        }
    }
    return out;
}

// ------------------------------------------------------------ bystander

async function startBystander(ws) {
    // An unrelated process that looks like the agent (`node server.js`) and
    // lives in the workspace. Lifecycle commands must never signal it, and it
    // is the unconfined control for the fixture's in-sandbox read probe.
    const dir = path.join(ws.root, 'bystander');
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(FIXTURE_DIR, 'lifecycle', 'server.js'), path.join(dir, 'server.js'));
    const port = await pickFreePort([ROUTER_PORT, ROUTER_PRIVATE_PORT, ws.fixturePort, ws.gatePort]);
    const env = { ...OBSERVER_ENV, PORT: String(port), LIFECYCLE_MARKER: 'bystander',
        LIFECYCLE_PROBE_PATH: path.join(ws.ploinkyDir, 'data') };
    const child = spawn(path.join(ws.root, 'bin', 'node'), ['server.js'], {
        cwd: dir, env, detached: true, stdio: 'ignore',
    });
    child.unref();
    const ready = await waitForProbe(port, { timeoutMs: 10_000 });
    const info = processInfo(child.pid);
    ws.bystander = { pid: child.pid, port, identity: info && info.identity };
    if (info) recordProcess(ws, info, 'bystander', 'setup', 'spawned by the runner');
    return { ready, info: ws.bystander };
}

// ------------------------------------------------ assertions on lifecycle

const NATIVE_RUNTIMES = Object.freeze(['seatbelt', 'bwrap']);

function sameProcess(info, recorded) {
    return isLive(info) && info.identity === recorded.identity;
}

function checkBystander(ws, step) {
    const info = ws.bystander && processInfo(ws.bystander.pid);
    return check(step, 'unrelated bystander process is still the same live process',
        sameProcess(info, { identity: ws.bystander && ws.bystander.identity }),
        info ? { pid: info.pid, identity: info.identity } : 'gone');
}

// `agent` selects the fixture agent being observed (the default lifecycle agent,
// or the gate agent of the failed-first-start scenario). Observations of the
// default agent stay at the top level of the step; the gate's go under its name.
async function observeRunning(ws, step, {
    expectMarker, label, agent = AGENT_NAME, pidRecordCount = 1, routerChecks = true, freshTuple = true,
}) {
    const port = agent === GATE_NAME ? ws.gatePort : ws.fixturePort;
    const obs = agent === AGENT_NAME ? step.observations : (step.observations[agent] = {});
    const procs = observeProcesses(ws, step.name);
    const registry = readRegistry(ws, agent);
    const pidRecords = readPidRecords(ws);
    obs.registry = registry;
    obs.pidRecords = pidRecords.map((entry) => ({ file: entry.file, raw: entry.raw }));
    if (agent === AGENT_NAME) obs.processes = procs;

    check(step, `registry holds exactly one ${agent} runtime record`, registry && registry.entries === 1, registry && registry.entries);
    if (!registry) return null;
    check(step, `registry runtime is native (${ws.runtime}), never a container engine`,
        registry.runtime === ws.runtime && NATIVE_RUNTIMES.includes(registry.runtime), registry.runtime);

    const own = pidRecords.filter((entry) => entry.key === registry.key);
    check(step, `exactly one PID record exists for the ${agent} runtime key (and ${pidRecordCount} in total)`, own.length === 1 && pidRecords.length === pidRecordCount,
        pidRecords.map((entry) => entry.file));
    const record = own[0] && own[0].parsed;
    check(step, 'PID record has exactly the schema-2 keys',
        Boolean(record) && JSON.stringify(Object.keys(record).sort()) === JSON.stringify(PID_RECORD_KEYS)
        && record.schemaVersion === 2, record && Object.keys(record));
    if (!record) return null;
    check(step, 'PID record runtimeKey equals the registry key', record.runtimeKey === registry.key);
    check(step, 'PID record tuple equals the registry tuple',
        record.instanceId === registry.instanceId && record.enableGeneration === registry.enableGeneration,
        { record: [record.instanceId, record.enableGeneration], registry: [registry.instanceId, registry.enableGeneration] });
    check(step, 'PID record pid equals the registry pid', record.pid === registry.pid, [record.pid, registry.pid]);

    const info = processInfo(record.pid);
    check(step, 'PID record pid is a live process (OS observation)', isLive(info), info ? info.state : 'absent');
    check(step, "observed start identity equals the PID record's processIdentity",
        Boolean(info) && info.identity === record.processIdentity, { observed: info && info.identity, record: record.processIdentity });
    obs.agentRoot = info && {
        pid: info.pid, identity: info.identity, ppid: info.ppid, pgid: info.pgid, args: info.args, argv: info.argv, exe: info.exe, cwd: info.cwd,
    };

    const tuple = { instanceId: registry.instanceId, enableGeneration: registry.enableGeneration };
    if (freshTuple) {
        check(step, 'instanceId and enableGeneration are fresh (never seen earlier in this run)',
            ws.seenTuples.every((seen) => seen.instanceId !== tuple.instanceId && seen.enableGeneration !== tuple.enableGeneration),
            { tuple, seen: ws.seenTuples });
    }
    ws.seenTuples.push({ ...tuple, step: step.name, pid: record.pid, agent });
    obs.tuple = tuple;

    const agentTree = procs.agents && procs.agents[registry.key];
    const descendants = agentTree ? agentTree.descendants : [];
    const service = descendants.find((row) => /\bserver\.js\b/.test(row.args)) || (info && /\bserver\.js\b/.test(info.args) ? info : null);
    check(step, 'fixture service process is in the agent process tree', Boolean(service), descendants.map((row) => row.args));

    if (ws.runtime === 'bwrap') {
        const bwrapReal = tryRealpath(RUNTIMES.bwrap.binary);
        // /proc/<pid>/exe is unreadable for a setuid bwrap (the process is not
        // dumpable); its argv[0] and kernel comm then identify the image.
        const imageIsBwrap = Boolean(info) && (info.exe
            ? tryRealpath(info.exe) === bwrapReal
            : tryRealpath((info.argv || [])[0] || '') === bwrapReal && info.comm === 'bwrap');
        check(step, 'agent root process image is the real /usr/bin/bwrap', imageIsBwrap,
            { exe: info && info.exe, argv0: info && info.argv && info.argv[0], comm: info && info.comm, expected: bwrapReal });
        check(step, 'agent root argv is the bwrap argv (--unshare-pid, --clearenv, --chdir)',
            Boolean(info) && Array.isArray(info.argv) && /(^|\/)bwrap$/.test(info.argv[0] || '')
            && ['--unshare-pid', '--clearenv', '--chdir'].every((flag) => info.argv.includes(flag)), info && info.argv && info.argv.slice(0, 12));
    } else {
        // Entry shape only. sandbox-exec replaces itself with the entry command,
        // so this is not evidence that the process is sandboxed; the PATH and
        // confinement checks below are.
        check(step, 'agent root argv has the post-exec entry shape (sh -c ... server.js); not a sandbox proof',
            Boolean(info) && /^sh -c .*\bserver\.js\b/.test(info.args), info && info.args);
    }

    const probe = await waitForProbe(port);
    obs.readiness = { port, ok: probe.ok, status: probe.status, attempts: probe.attempts, body: probe.body };
    check(step, 'fixture answers on its ephemeral loopback port (independent HTTP readiness)', probe.ok, probe.error || probe.status);
    const body = probe.body || {};
    check(step, `fixture reports the manifest marker '${expectMarker}'`, body.marker === expectMarker, body.marker);
    check(step, `fixture sees PLOINKY_RUNTIME=${ws.runtime}`, body.runtime === ws.runtime, body.runtime);
    check(step, 'fixture environment carries the registry tuple',
        body.instanceId === registry.instanceId && body.enableGeneration === registry.enableGeneration,
        { fixture: [body.instanceId, body.enableGeneration], registry: [registry.instanceId, registry.enableGeneration] });
    if (ws.runtime === 'seatbelt') {
        check(step, 'fixture pid reported by the process equals an observed tree member',
            [info && info.pid, ...descendants.map((row) => row.pid)].includes(body.pid), body.pid);
        // Ploinky spawns `sandbox-exec` with the PATH it builds for the agent
        // (envMap.PATH), which the fixture reports from inside the sandbox.
        const resolvedExec = body.path ? resolveOnPath('sandbox-exec', body.path) : null;
        obs.sandboxExecResolution = { pathInsideSandbox: body.path, resolved: resolvedExec };
        check(step, 'sandbox-exec resolved against the PATH the agent runs with is the real /usr/bin/sandbox-exec',
            Boolean(resolvedExec) && tryRealpath(resolvedExec) === tryRealpath(RUNTIMES.seatbelt.binary),
            { pathInsideSandbox: body.path, resolved: resolvedExec });
    }
    const probePath = path.join(ws.ploinkyDir, 'data');
    const deniedCodes = ws.runtime === 'seatbelt' ? ['EPERM'] : ['ENOENT', 'EACCES'];
    const control = await httpGetJson(ws.bystander.port);
    const controlProbe = control.body && control.body.probe;
    obs.control = { port: ws.bystander.port, probe: controlProbe };
    check(step, `confinement: reading ${probePath} inside the sandbox is denied (${deniedCodes.join(' or ')})`,
        Boolean(body.probe) && body.probe.path === probePath && body.probe.readable === false && deniedCodes.includes(body.probe.code), body.probe);
    check(step, 'control: the unconfined bystander reads the very same path',
        control.ok && Boolean(controlProbe) && controlProbe.readable === true && controlProbe.code === null
        && Boolean(body.probe) && controlProbe.path === body.probe.path, controlProbe);

    const listeners = listenerPids(port);
    obs.fixtureListeners = listeners;
    if (listeners === null) {
        obs.fixtureListenersNote = 'listener attribution is unavailable on this host';
    } else {
        const treePids = new Set([info && info.pid, ...descendants.map((row) => row.pid)]);
        check(step, `the ${agent} port is listened on by a process of the agent tree`,
            listeners.length > 0 && listeners.every((pid) => treePids.has(pid)), { listeners, tree: [...treePids] });
    }

    const router = procs.router;
    if (routerChecks) {
        check(step, 'Router watchdog from running/router.pid is live and runs Watchdog.js',
            Boolean(router && router.watchdog && /Watchdog\.js/.test(router.watchdog.args)), router && router.watchdog);
        check(step, 'Router child process runs RoutingServer.js',
            Boolean(router && router.children.some((row) => /RoutingServer\.js/.test(row.args))), router && router.children);
        const routerListeners = listenerPids(ROUTER_PORT);
        if (routerListeners !== null) {
            const routerPids = new Set(router ? router.children.map((row) => row.pid) : []);
            check(step, `port ${ROUTER_PORT} is listened on by the Router child`,
                routerListeners.length > 0 && routerListeners.every((pid) => routerPids.has(pid)), { routerListeners, routerPids: [...routerPids] });
        }
        checkBystander(ws, step);
    }
    obs.label = label;
    return { registry, record, info, tuple, descendants, router };
}

async function observeAbsent(ws, step, { predecessors, expectRouterGone }) {
    const procs = observeProcesses(ws, step.name);
    const pidRecords = readPidRecords(ws);
    step.observations.processes = procs;
    step.observations.pidRecords = pidRecords.map((entry) => ({ file: entry.file, raw: entry.raw }));
    step.observations.registryAfter = readRegistry(ws);
    const survivors = [];
    for (const recorded of predecessors) {
        const info = processInfo(recorded.pid);
        if (sameProcess(info, recorded)) survivors.push({ pid: recorded.pid, role: recorded.role, args: info.args });
    }
    check(step, 'every captured agent process (root and descendants) is gone (OS observation)', survivors.length === 0, survivors);
    check(step, 'no PID record remains for the runtime', pidRecords.length === 0, pidRecords.map((entry) => entry.raw));
    const probe = await httpGetJson(ws.fixturePort, '/probe', 1_000);
    check(step, 'the fixture port refuses connections', !probe.ok && probe.status === null, probe.error || probe.status);
    const fixturePort = await portStatus(ws.fixturePort);
    check(step, 'the fixture port is free', fixturePort.free, fixturePort);
    if (ws.gatePort) {
        const gateProbe = await httpGetJson(ws.gatePort, '/probe', 1_000);
        check(step, 'the gate port refuses connections', !gateProbe.ok && gateProbe.status === null, gateProbe.error || gateProbe.status);
        const gatePort = await portStatus(ws.gatePort);
        check(step, 'the gate port is free', gatePort.free, gatePort);
    }
    if (expectRouterGone) {
        const routerSurvivors = [...ws.recorded.values()]
            .filter((entry) => ['watchdog', 'router-child'].includes(entry.role))
            .filter((entry) => sameProcess(processInfo(entry.pid), entry));
        check(step, 'Router watchdog and children are gone', routerSurvivors.length === 0, routerSurvivors);
        for (const port of [ROUTER_PORT, ROUTER_PRIVATE_PORT]) {
            const status = await portStatus(port);
            check(step, `Router port ${port} is free`, status.free, status);
        }
    }
    checkBystander(ws, step);
}

function agentTreeNow(ws) {
    return [...ws.recorded.values()].filter((entry) => ['agent-root', 'agent-descendant'].includes(entry.role));
}

function routerEntries(ws) {
    return [...ws.recorded.values()].filter((entry) => ['watchdog', 'router-child'].includes(entry.role));
}

// ------------------------------------------- receipts and live-root helpers

// Predecessor receipts under .ploinky/run/runtime-predecessors/ (the files a
// restaging start writes before it rotates a tuple and removes a predecessor).
function readReceipts(ws) {
    const dir = path.join(ws.ploinkyDir, 'run', 'runtime-predecessors');
    let names = [];
    try { names = fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort(); } catch (_) { return []; }
    return names.map((name) => {
        let parsed = null;
        let bytes = 0;
        try { const raw = fs.readFileSync(path.join(dir, name), 'utf8'); bytes = raw.length; parsed = JSON.parse(raw); } catch (_) { /* vanished or malformed */ }
        const predecessor = (parsed && parsed.predecessor) || {};
        return {
            file: name, bytes,
            containerName: parsed && parsed.containerName,
            successor: parsed && parsed.successor,
            predecessor: {
                agentName: predecessor.agentName, runtime: predecessor.runtime || null,
                instanceId: predecessor.instanceId, enableGeneration: predecessor.enableGeneration,
                process: predecessor.process || null,
            },
        };
    });
}

function liveTuples(ws) {
    const out = new Map();
    for (const entry of readPidRecords(ws)) {
        const record = entry.parsed;
        if (!record || !Number.isSafeInteger(record.pid)) continue;
        const info = processInfo(record.pid);
        if (isLive(info) && info.identity === record.processIdentity) out.set(`${record.instanceId}|${record.enableGeneration}`, { pid: record.pid, key: entry.key });
    }
    return out;
}

// Records the receipts present now and checks the invariant "no receipt is lost
// while the process it covers lives": a receipt seen earlier and missing now is
// a violation when the native process it names (pid and start identity), or the
// live PID-record tuple it names, is still alive.
function snapshotReceipts(ws, step, { assert = true } = {}) {
    ws.receiptSnapshots = (ws.receiptSnapshots || 0) + 1;
    const current = readReceipts(ws);
    step.observations.receipts = current;
    for (const receipt of current) {
        if (!ws.receiptsSeen.has(receipt.file)) ws.receiptsSeen.set(receipt.file, { firstSeenStep: step.name, receipt });
    }
    const present = new Set(current.map((receipt) => receipt.file));
    const tuples = liveTuples(ws);
    const lost = [];
    for (const [file, seen] of ws.receiptsSeen) {
        if (present.has(file)) continue;
        const predecessor = seen.receipt.predecessor;
        let covered = null;
        if (predecessor.process) {
            const info = processInfo(predecessor.process.pid);
            if (isLive(info) && info.identity === predecessor.process.processIdentity) covered = { pid: predecessor.process.pid, by: 'receipt process evidence' };
        }
        if (!covered && tuples.has(`${predecessor.instanceId}|${predecessor.enableGeneration}`)) {
            covered = { pid: tuples.get(`${predecessor.instanceId}|${predecessor.enableGeneration}`).pid, by: 'live PID-record tuple' };
        }
        if (covered) lost.push({ file, firstSeenStep: seen.firstSeenStep, covers: covered, agent: predecessor.agentName });
    }
    if (assert) check(step, 'no predecessor receipt was lost while the process it covers is alive', lost.length === 0, lost);
    return { current, lost };
}

// Live agent roots found by argv in the process table, independent of every
// Ploinky record: seatbelt's `sh -c cd <agent dir> && ...`, or bwrap's argv
// naming the agent dir. Forked copies of a root (bwrap's init) count once.
function liveAgentRoots(ws, agentName) {
    const agentDir = path.join(ws.ploinkyDir, 'repos', FIXTURE_REPO, agentName);
    const isRoot = ws.runtime === 'seatbelt'
        // sh -c cd <agent dir> && node server.js  (sandbox-exec exec-ed in place)
        ? (args) => /^sh -c /.test(args) && args.includes(`cd ${agentDir} `)
        // bwrap ... --bind <agent dir> /code ...  (the agent code mount)
        : (args) => /(^|\/)bwrap /.test(args) && args.includes(`${agentDir} /code`);
    const rows = processTable().filter((row) => isRoot(row.args));
    const pids = new Set(rows.map((row) => row.pid));
    return rows.filter((row) => !pids.has(row.ppid)).map((row) => ({ pid: row.pid, ppid: row.ppid, args: row.args }));
}

function editGateFail(ws, fail) {
    fs.writeFileSync(ws.gateManifestPath, renderGateManifest(ws, { fail }));
    git(ws, path.join(ws.ploinkyDir, 'repos', FIXTURE_REPO), ['add', 'gate/manifest.json']);
    git(ws, path.join(ws.ploinkyDir, 'repos', FIXTURE_REPO), ['commit', '-q', '-m', `gate fail=${fail ? 1 : 0}`]);
}

// ---------------------------------------------------------- the scenario

function failureClass(step) {
    const text = `${step.child && step.child.stdoutText}\n${step.child && step.child.stderrText}`;
    if (/runtime predecessor receipt|PLOINKY_RUNTIME_PREDECESSOR_INVALID/.test(text)) {
        return {
            class: 'native-predecessor-regression',
            code: 'PLOINKY_RUNTIME_PREDECESSOR_INVALID',
            evidence: text.split('\n').find((line) => /runtime predecessor receipt|PLOINKY_RUNTIME_PREDECESSOR_INVALID/.test(line)) || '',
        };
    }
    return null;
}

// `expectExit` null leaves the exit status unasserted (the caller classifies it);
// `expectFailure` asserts an ordinary nonzero exit (not a signal or a spawn error).
async function cliStep(ws, name, description, args, { expectExit = 0, expectFailure = false } = {}) {
    const step = newStep(ws, name, description);
    await runChild(ws, step, ws.cli, args);
    const exit = { exitCode: step.child.exitCode, signal: step.child.signal, error: step.child.error };
    if (expectFailure) {
        check(step, `ploinky-local ${args.join(' ')} fails (nonzero exit, no signal)`,
            Number.isInteger(step.child.exitCode) && step.child.exitCode !== 0 && !step.child.signal && !step.child.error, exit);
    } else if (expectExit !== null) {
        check(step, `ploinky-local ${args.join(' ')} exits ${expectExit}`, step.child.exitCode === expectExit, exit);
    }
    step.child.summary = summarizeChildText(step);
    return step;
}

function editFixtureMarker(ws, marker) {
    fs.writeFileSync(ws.manifestPath, renderManifest(ws, { marker }));
    git(ws, path.join(ws.ploinkyDir, 'repos', FIXTURE_REPO), ['add', 'lifecycle/manifest.json']);
    git(ws, path.join(ws.ploinkyDir, 'repos', FIXTURE_REPO), ['commit', '-q', '-m', `marker ${marker}`]);
}

async function scenario(ws, state) {
    const stopHere = (step) => {
        // Classify before finishStep drops the captured output text.
        const classified = step.assertions.some((entry) => !entry.ok) ? failureClass(step) : null;
        const ok = finishStep(ws, step);
        if (!ok) {
            state.failedStep = step;
            if (classified) step.failureClass = classified;
        }
        // An interrupt ends the scenario after the step in flight; teardown follows.
        return ok && !state.interrupted;
    };
    // The in-flight command was terminated by the interrupt handler: record
    // that, finish the step, and stop without observing a half-done command.
    const interruptedIn = (step) => {
        if (!state.interrupted) return false;
        check(step, `the step was interrupted by ${state.interrupted}`, false, { exitCode: step.child && step.child.exitCode });
        state.failedStep = state.failedStep || step;
        finishStep(ws, step);
        return true;
    };

    // 1. the network tripwire is armed before anything could clone
    {
        const step = newStep(ws, 'tripwire-selftest', 'git rewrites github.com URLs to a nonexistent local path');
        const probe = runTool(ws.git, ['ls-remote', 'https://github.com/ploinky-native-lifecycle/tripwire.git'], { env: { ...gitEnv(ws) } });
        step.observations.lsRemote = { status: probe.status, stderr: probe.stderr.trim().slice(0, 400) };
        check(step, 'a github.com URL fails against the tripwire path, not the network',
            probe.status !== 0 && probe.stderr.includes(ws.tripwire), probe.stderr.trim());
        if (!stopHere(step)) return;
    }

    // 1b. with an engine present, record whether it is usable from the isolated HOME
    if (ws.options.engine === 'present') {
        const step = newStep(ws, 'engine-probe', 'the real podman on the children\'s PATH: version and reachability (read-only, recorded only)');
        const env = { ...buildChildEnv(ws) };
        const podman = ws.pathPlan.enginePath;
        const version = runTool(podman, ['--version'], { env });
        const info = runTool(podman, ['info', '--format', '{{.Host.Arch}}'], { env, timeout: 30_000 });
        step.observations.engine = {
            podman, version: version.stdout.trim(), versionStatus: version.status,
            infoStatus: info.status, infoStdout: info.stdout.trim().slice(0, 200), infoStderr: info.stderr.trim().slice(0, 400),
            usable: info.status === 0,
        };
        ws.engineUsable = info.status === 0;
        check(step, 'the podman binary on the children\'s PATH runs', version.status === 0, version.stderr.trim());
        if (!stopHere(step)) return;
    }

    // 2. fresh edge sources through the selected checkout's own API
    {
        const step = newStep(ws, 'init-edge-sources', 'initialize the fresh edge routing sources through the checkout API');
        await runChild(ws, step, process.execPath, [path.join(FIXTURE_DIR, 'initEdgeSources.mjs'), ws.source]);
        if (interruptedIn(step)) return;
        check(step, 'initEdgeSources.mjs exits 0', step.child.exitCode === 0, step.child.stderrText.trim().slice(0, 400));
        check(step, 'it reports initialized:true', /"initialized":true/.test(step.child.stdoutText), step.child.stdoutText.trim());
        if (!stopHere(step)) return;
    }

    // 3. force native
    {
        const step = await cliStep(ws, 'enable-sandbox', 'ploinky-local enable sandbox (PLOINKY_DISABLE_HOST_SANDBOX unset)', ['enable', 'sandbox']);
        if (interruptedIn(step)) return;
        check(step, 'the CLI itself reports host sandbox runtimes enabled for the workspace',
            /Host sandbox runtimes: enabled \(workspace\)/.test(step.child.stdoutText), step.child.summary && step.child.summary.startedLines);
        const config = (readJsonFile(path.join(ws.ploinkyDir, 'agents.json')) || {})._config || {};
        step.observations.sandboxConfig = config.sandbox;
        check(step, 'workspace config records disableHostRuntimes:false',
            config.sandbox && config.sandbox.disableHostRuntimes === false, config.sandbox);
        if (!stopHere(step)) return;
    }

    // 4. the local fixture repository, installed by the real CLI
    {
        const step = await cliStep(ws, 'install-fixture-repo', 'ploinky-local install repo <local fixture repository> (a local git clone, no network)',
            ['install', 'repo', ws.fixtureSourceRepo, FIXTURE_REPO]);
        if (interruptedIn(step)) return;
        check(step, 'the fixture agent manifest is present in the workspace', fs.existsSync(ws.manifestPath), ws.manifestPath);
        const head = git(ws, path.join(ws.ploinkyDir, 'repos', FIXTURE_REPO), ['rev-parse', 'HEAD']);
        check(step, 'the installed repository is the local fixture commit', head === ws.fixtureCommit, { head, expected: ws.fixtureCommit });
        if (!stopHere(step)) return;
    }

    if (ws.scenario === 'failed-first-start') {
        await scenarioFailedFirstStart(ws, state, { stopHere, interruptedIn });
        return;
    }

    // 5. real admission
    {
        const step = newStep(ws, 'admit-manifest', 'admitDirectAgentRuntimeManifest selects the native runtime');
        await runChild(ws, step, process.execPath,
            [path.join(FIXTURE_DIR, 'admitManifest.mjs'), ws.source, ws.manifestPath, AGENT_REF]);
        if (interruptedIn(step)) return;
        check(step, 'admitManifest.mjs exits 0', step.child.exitCode === 0, step.child.stderrText.trim().slice(0, 400));
        let admitted = null;
        try { admitted = JSON.parse(step.child.stdoutText.trim().split('\n').pop()); } catch (_) { /* reported below */ }
        step.observations.admission = admitted;
        check(step, `admission selects the ${ws.runtime} runtime`, admitted && admitted.runtime === ws.runtime && admitted.runtimeKind === ws.runtime, admitted);
        check(step, 'admission keeps network.mode host', admitted && admitted.network && admitted.network.mode === 'host', admitted && admitted.network);
        if (!stopHere(step)) return;
    }

    // 6. first start
    let first = null;
    {
        const step = await cliStep(ws, 'start-initial', `ploinky-local start ${AGENT_NAME} ${ROUTER_PORT}`,
            ['start', AGENT_NAME, String(ROUTER_PORT)]);
        if (interruptedIn(step)) return;
        first = await observeRunning(ws, step, { expectMarker: 'one', label: 'first start' });
        if (!stopHere(step)) return;
    }

    // 7. stop
    const beforeStop = agentTreeNow(ws);
    {
        const step = await cliStep(ws, 'stop-after-start', 'ploinky-local stop', ['stop']);
        if (interruptedIn(step)) return;
        await observeAbsent(ws, step, { predecessors: beforeStop, expectRouterGone: true });
        if (!stopHere(step)) return;
    }

    // 8. restage after stop (the P1 regression)
    let second = null;
    {
        const step = await cliStep(ws, 'start-restage-after-stop', `ploinky-local start ${AGENT_NAME} (restage after stop)`,
            ['start', AGENT_NAME]);
        if (interruptedIn(step)) return;
        second = await observeRunning(ws, step, { expectMarker: 'one', label: 'restage after stop' });
        if (second && first) {
            check(step, 'a new process (new pid and start identity) replaced the stopped one',
                second.info && first.info && (second.info.pid !== first.info.pid || second.info.identity !== first.info.identity),
                { before: first.info && [first.info.pid, first.info.identity], after: second.info && [second.info.pid, second.info.identity] });
        }
        if (!stopHere(step)) return;
    }

    // 9. environment change, then start
    {
        const predecessor = agentTreeNow(ws).filter((entry) => sameProcess(processInfo(entry.pid), entry));
        const routerBefore = routerEntries(ws).filter((entry) => sameProcess(processInfo(entry.pid), entry));
        editFixtureMarker(ws, 'two');
        const step = await cliStep(ws, 'env-change-start', `manifest env LIFECYCLE_MARKER one -> two, then ploinky-local start ${AGENT_NAME}`,
            ['start', AGENT_NAME]);
        if (interruptedIn(step)) return;
        const observed = await observeRunning(ws, step, { expectMarker: 'two', label: 'env change via start' });
        await checkOnlyPredecessorExited(ws, step, predecessor, routerBefore, observed);
        if (!stopHere(step)) return;
    }

    // 10. environment change, then restart
    {
        const predecessor = agentTreeNow(ws).filter((entry) => sameProcess(processInfo(entry.pid), entry));
        const routerBefore = routerEntries(ws).filter((entry) => sameProcess(processInfo(entry.pid), entry));
        editFixtureMarker(ws, 'three');
        const step = await cliStep(ws, 'env-change-restart', `manifest env LIFECYCLE_MARKER two -> three, then ploinky-local restart ${AGENT_NAME}`,
            ['restart', AGENT_NAME]);
        if (interruptedIn(step)) return;
        const observed = await observeRunning(ws, step, { expectMarker: 'three', label: 'env change via restart' });
        await checkOnlyPredecessorExited(ws, step, predecessor, routerBefore, observed);
        if (!stopHere(step)) return;
    }

    // 11. final stop through the real CLI
    {
        state.reachedEnd = true;
        const step = await cliStep(ws, 'stop-final', 'ploinky-local stop (final)', ['stop']);
        if (interruptedIn(step)) return;
        state.finalStopRan = step.child.exitCode === 0;
        await observeAbsent(ws, step, { predecessors: agentTreeNow(ws), expectRouterGone: true });
        const everything = [...ws.recorded.values()].filter((entry) => entry.role !== 'bystander');
        const alive = everything.filter((entry) => sameProcess(processInfo(entry.pid), entry));
        check(step, 'every process this run recorded (except the bystander) is gone', alive.length === 0, alive);
        stopHere(step);
    }
}

// ------------------------------------------- scenario: failed-first-start
//
// Mechanism. `ploinky-local start <static agent>` starts the manifest graph in
// waves, dependencies first (workspaceUtil.js: `for (let waveIndex ...)`, each
// blocking wave awaits its launch and its readiness). The gate agent is the
// static agent and lists the lifecycle agent in its `enable` array, so the
// lifecycle agent is wave 1 and the gate is wave 2. The gate's server exits at
// once (LIFECYCLE_FAIL=1), the native runtime sees "process exited
// immediately", the wave throws, and `start` fails after the lifecycle agent's
// native process was launched and is alive. The gate is then made healthy and
// `start` is run again.

// The CLI prints `error.message`, never `error.code`, so the one accepted
// refusal, PLOINKY_RUNTIME_OWNERSHIP_AMBIGUOUS, is recognized by its code when
// printed, or by the fixed message its constructors produce
// (bwrapFleet.js slotError, agentServiceManager.js sandboxOwnershipUnknownError
// and sandboxRemovalAmbiguityError, and the "preserved container ... exact
// immutable ownership/removal was not proven" wrapper). Only the final
// `❌ Error:` line counts, it must name the lifecycle runtime key whose safe
// state is asserted, and `ownership could not be verified (invalid-record)` is
// excluded: that is PLOINKY_SANDBOX_PID_RECORD_INVALID, an internal-state error.
// PLOINKY_SANDBOX_PID_SLOT_BUSY is never accepted: it was the wedge symptom.
const OWNERSHIP_AMBIGUOUS_MESSAGE = /PLOINKY_RUNTIME_OWNERSHIP_AMBIGUOUS|sandbox runtime '?[^'\s]+'? ownership could not be verified \((?!invalid-record\))|preserved container '[^']+' because exact immutable ownership\/removal was not proven|sandbox runtime '[^']+': /;
const SLOT_BUSY_MESSAGE = /PLOINKY_SANDBOX_PID_SLOT_BUSY|is already bound to a live process|PID slot was claimed concurrently/;

function finalErrorLine(text) {
    const lines = text.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('❌ Error:'));
    return lines.length ? lines[lines.length - 1] : '';
}

function namedRefusalCode(text, runtimeKey) {
    const line = finalErrorLine(text);
    if (!line || !line.includes(runtimeKey)) return null;
    return OWNERSHIP_AMBIGUOUS_MESSAGE.test(line) ? 'PLOINKY_RUNTIME_OWNERSHIP_AMBIGUOUS' : null;
}

// Classifies one `start` that ran after the failed first start.
//
// Exit 0 is the recovery (the process was replaced or reused). A nonzero exit
// is accepted only as a conservative refusal: its final error line carries
// PLOINKY_RUNTIME_OWNERSHIP_AMBIGUOUS for the lifecycle runtime key AND it
// leaves the specified safe state, namely the survivor alive with its original
// start identity, its PID record byte-for-byte intact, and every receipt that
// covered it still present. Everything else fails, and so does any
// PLOINKY_SANDBOX_PID_SLOT_BUSY. The hard variant (the further start) must
// simply succeed.
async function assessRestart(ws, step, { survivor, hard, label }) {
    const text = `${step.child.stdoutText}\n${step.child.stderrText}`;
    const exit = step.child.exitCode;
    const slotBusy = SLOT_BUSY_MESSAGE.test(text);
    const refusalCode = exit === 0 ? null : namedRefusalCode(text, survivor.key);
    const errorLines = step.child.summary ? step.child.summary.errorLines : [];
    const tail = step.child.summary ? step.child.summary.tail : [];
    const roots = liveAgentRoots(ws, AGENT_NAME);
    const survivorAlive = sameProcess(processInfo(survivor.pid), survivor);
    const pidRecord = readPidRecords(ws).find((entry) => entry.key === survivor.key);
    const pidRecordIntact = Boolean(pidRecord) && pidRecord.raw === survivor.pidRecordRaw;
    observeProcesses(ws, step.name);
    const receipts = snapshotReceipts(ws, step, { assert: false });
    // The safe state only applies to a refusal; a recovery replaces the process.
    const safeState = survivorAlive && pidRecordIntact && receipts.lost.length === 0;
    const outcome = {
        label, exitCode: exit, refusalCode, slotBusy, finalErrorLine: finalErrorLine(text), errorLines, outputTail: tail,
        liveRoots: roots, survivorStillAlive: survivorAlive, pidRecordIntact, receiptsLost: receipts.lost,
        safeState: exit === 0 ? null : safeState,
        lifecycleProcess: roots.length === 1 && roots[0].pid === survivor.pid && survivorAlive ? 'reused-or-retained' : (survivorAlive ? 'survivor-alive-with-other-root' : 'replaced'),
    };
    step.observations.restart = outcome;

    check(step, 'the start output carries no PLOINKY_SANDBOX_PID_SLOT_BUSY (the wedge symptom)', !slotBusy, errorLines);
    if (hard) {
        check(step, 'a further start succeeds (no permanent PLOINKY_SANDBOX_PID_SLOT_BUSY)', exit === 0, { exit, refusalCode, errorLines, outputTail: tail });
    } else if (exit !== 0) {
        check(step, 'start-after-heal exits 0, or refuses with PLOINKY_RUNTIME_OWNERSHIP_AMBIGUOUS in its final error line for the lifecycle runtime key (any other nonzero exit fails)',
            Boolean(refusalCode), { exit, finalErrorLine: finalErrorLine(text), outputTail: tail });
        check(step, 'a refusal leaves the safe state: survivor alive with its identity, PID record intact, no covering receipt lost',
            safeState, { survivorAlive, pidRecordIntact, receiptsLost: receipts.lost });
    }
    check(step, 'exactly one live lifecycle process for the runtime key (argv scan, independent of Ploinky records)', roots.length === 1, roots);
    check(step, 'no predecessor receipt was lost while the process it covers is alive', receipts.lost.length === 0, receipts.lost);
    if (exit === 0) {
        await observeRunning(ws, step, { expectMarker: 'one', label, agent: AGENT_NAME, pidRecordCount: 2, freshTuple: false });
        await observeRunning(ws, step, { expectMarker: 'gate-ok', label, agent: GATE_NAME, pidRecordCount: 2, routerChecks: false, freshTuple: false });
    } else {
        step.observations.registry = readRegistry(ws, AGENT_NAME);
        step.observations.pidRecords = readPidRecords(ws).map((entry) => ({ file: entry.file, raw: entry.raw }));
    }
    return outcome;
}

async function scenarioFailedFirstStart(ws, state, { stopHere, interruptedIn }) {
    const report = ws.result.doc.failedFirstStart = {
        engine: ws.options.engine,
        engineUsable: ws.engineUsable === undefined ? null : ws.engineUsable,
        mechanism: 'the gate (static agent) lists the lifecycle agent in `enable`, so lifecycle is wave 1 and the gate is wave 2; the gate server exits at once (LIFECYCLE_FAIL=1), so start fails after the lifecycle agent launched natively',
    };

    // 5. admission of both manifests
    for (const [name, manifestPath, ref] of [
        ['admit-manifest-dependency', ws.manifestPath, AGENT_REF],
        ['admit-manifest-gate', ws.gateManifestPath, GATE_REF],
    ]) {
        const step = newStep(ws, name, `admitDirectAgentRuntimeManifest selects the native runtime for ${ref}`);
        await runChild(ws, step, process.execPath, [path.join(FIXTURE_DIR, 'admitManifest.mjs'), ws.source, manifestPath, ref]);
        if (interruptedIn(step)) return;
        check(step, 'admitManifest.mjs exits 0', step.child.exitCode === 0, step.child.stderrText.trim().slice(0, 400));
        let admitted = null;
        try { admitted = JSON.parse(step.child.stdoutText.trim().split('\n').pop()); } catch (_) { /* reported below */ }
        step.observations.admission = admitted;
        check(step, `admission selects the ${ws.runtime} runtime`, admitted && admitted.runtime === ws.runtime && admitted.runtimeKind === ws.runtime, admitted);
        if (!stopHere(step)) return;
    }

    // 6. the first start fails after the dependency launched
    let survivor = null;
    {
        const step = await cliStep(ws, 'start-fails-after-dependency-launch',
            `ploinky-local start ${GATE_NAME} ${ROUTER_PORT} (lifecycle launches, then the gate's server exits at once)`,
            ['start', GATE_NAME, String(ROUTER_PORT)], { expectFailure: true });
        if (interruptedIn(step)) return;
        const text = `${step.child.stdoutText}\n${step.child.stderrText}`;
        check(step, "the start fails because of the gate's start failure",
            /Failed to start agent 'gate'|agent\(s\) failed to start: gate/.test(text), step.child.summary.errorLines);
        step.observations.processes = observeProcesses(ws, step.name);
        const pidRecords = readPidRecords(ws);
        step.observations.pidRecords = pidRecords.map((entry) => ({ file: entry.file, raw: entry.raw }));
        const lifecycleRecord = pidRecords.find((entry) => /^ploinky_nativefix_lifecycle_/.test(entry.key));
        const gateRecord = pidRecords.find((entry) => /^ploinky_nativefix_gate_/.test(entry.key));
        const record = lifecycleRecord && lifecycleRecord.parsed;
        const info = record && processInfo(record.pid);
        check(step, 'the lifecycle agent has a PID record and its process is alive with that start identity (OS observation)',
            Boolean(record) && isLive(info) && info.identity === record.processIdentity, { record: lifecycleRecord && lifecycleRecord.raw, observed: info && info.identity });
        check(step, 'the gate has no PID record', !gateRecord, gateRecord && gateRecord.raw);
        check(step, 'exactly one live lifecycle process by argv', liveAgentRoots(ws, AGENT_NAME).length === 1, liveAgentRoots(ws, AGENT_NAME));
        check(step, 'no live gate process by argv', liveAgentRoots(ws, GATE_NAME).length === 0, liveAgentRoots(ws, GATE_NAME));
        const probe = await waitForProbe(ws.fixturePort, { timeoutMs: 10_000 });
        step.observations.lifecycleReadiness = { port: ws.fixturePort, ok: probe.ok, marker: probe.body && probe.body.marker };
        check(step, 'the surviving lifecycle process answers on its port', probe.ok && probe.body && probe.body.marker === 'one', probe.error || probe.status);
        const registryLifecycle = readRegistry(ws, AGENT_NAME);
        const registryGate = readRegistry(ws, GATE_NAME);
        step.observations.registryLifecycle = registryLifecycle;
        step.observations.registryGate = registryGate;
        step.observations.survivor = info && { pid: info.pid, identity: info.identity, ppid: info.ppid, pgid: info.pgid, args: info.args, argv: info.argv, exe: info.exe };
        const receipts = snapshotReceipts(ws, step);
        report.survivor = {
            pid: record && record.pid, processIdentity: record && record.processIdentity, args: info && info.args, argv: info && info.argv,
            pidRecord: lifecycleRecord && lifecycleRecord.raw,
            registryRecord: registryLifecycle,
            registryRecordHasRuntimeField: registryLifecycle ? registryLifecycle.hasRuntimeField : null,
            receipts: receipts.current,
        };
        if (record && info) survivor = { pid: record.pid, identity: info.identity, key: lifecycleRecord.key, pidRecordRaw: lifecycleRecord.raw, tuple: [record.instanceId, record.enableGeneration] };
        if (!stopHere(step) || !survivor) return;
    }

    // From the restart on, a failed step is recorded and the scenario carries on:
    // each later command then reports its own outcome, apart from the first failure.
    const soft = (step) => {
        const classified = step.assertions.some((entry) => !entry.ok) ? failureClass(step) : null;
        const ok = finishStep(ws, step);
        if (!ok) { state.failedStep = state.failedStep || step; if (classified) step.failureClass = classified; }
        return !state.interrupted;
    };

    // 7. the gate is made healthy
    {
        const step = newStep(ws, 'heal-gate', 'the gate manifest env LIFECYCLE_FAIL 1 -> 0 (committed in the workspace repository)');
        editGateFail(ws, false);
        const manifest = JSON.parse(fs.readFileSync(ws.gateManifestPath, 'utf8'));
        const value = (manifest.env.find((entry) => entry.name === 'LIFECYCLE_FAIL') || {}).value;
        check(step, 'the gate manifest now declares LIFECYCLE_FAIL=0', value === '0', value);
        if (!stopHere(step)) return;
    }

    // 8. start again: recovered, or conservatively retained with a clear refusal
    {
        const step = await cliStep(ws, 'start-after-heal', `ploinky-local start ${GATE_NAME} (again, after the gate was made healthy)`,
            ['start', GATE_NAME], { expectExit: null });
        if (interruptedIn(step)) return;
        report.startAfterHeal = await assessRestart(ws, step, { survivor, hard: false, label: 'start after heal' });
        if (!soft(step)) return;
    }

    // 9. a further start must succeed: no permanent SLOT_BUSY
    {
        const step = await cliStep(ws, 'start-further', `ploinky-local start ${GATE_NAME} (a further start)`, ['start', GATE_NAME], { expectExit: null });
        if (interruptedIn(step)) return;
        report.furtherStart = await assessRestart(ws, step, { survivor, hard: true, label: 'further start' });
        if (!soft(step)) return;
    }

    // 10. stop, then 11. destroy: both through the CLI. A failing stop does not
    //     end the scenario: destroy gets its own chance and is reported apart.
    const created = () => [...ws.recorded.values()].filter((entry) => entry.role !== 'bystander');
    const stillAlive = () => created().filter((entry) => sameProcess(processInfo(entry.pid), entry))
        .map((entry) => ({ pid: entry.pid, role: entry.role, ownerKey: entry.ownerKey, args: entry.args }));
    {
        const step = await cliStep(ws, 'stop', 'ploinky-local stop', ['stop']);
        if (interruptedIn(step)) return;
        state.finalStopRan = step.child.exitCode === 0;
        await observeAbsent(ws, step, { predecessors: agentTreeNow(ws), expectRouterGone: true });
        const alive = stillAlive();
        report.afterStop = { survivors: alive };
        check(step, "every process this scenario created is gone after Ploinky's own stop", alive.length === 0, alive);
        snapshotReceipts(ws, step);
        if (!soft(step)) return;
    }
    {
        state.reachedEnd = true;
        const step = await cliStep(ws, 'destroy', 'ploinky-local destroy', ['destroy']);
        if (interruptedIn(step)) return;
        state.finalStopRan = state.finalStopRan || step.child.exitCode === 0;
        await observeAbsent(ws, step, { predecessors: agentTreeNow(ws), expectRouterGone: true });
        const alive = stillAlive();
        report.afterDestroy = { survivors: alive };
        check(step, "every process this scenario created is gone after Ploinky's own destroy", alive.length === 0, alive);
        snapshotReceipts(ws, step);
        // The receipt invariant is vacuous when no receipt was ever seen.
        report.receiptInvariant = {
            snapshots: ws.receiptSnapshots, receiptsEverSeen: ws.receiptsSeen.size,
            heldVacuously: ws.receiptsSeen.size === 0,
            note: ws.receiptsSeen.size === 0 ? 'no receipt existed at any snapshot, so "no receipt lost" held vacuously' : 'receipts were observed; see lost-receipt assertions per step',
        };
        soft(step);
    }
}

async function checkOnlyPredecessorExited(ws, step, predecessor, routerBefore, observed) {
    const survivors = predecessor.filter((entry) => sameProcess(processInfo(entry.pid), entry));
    check(step, 'every captured predecessor process is gone', survivors.length === 0, survivors);
    check(step, 'the predecessor was replaced by a different process',
        Boolean(observed && observed.info)
        && predecessor.every((entry) => entry.pid !== observed.info.pid || entry.identity !== observed.info.identity),
        observed && observed.info && observed.info.pid);
    const routerAfter = routerBefore.filter((entry) => sameProcess(processInfo(entry.pid), entry));
    check(step, 'the Router processes are unchanged (same pids, same start identity)', routerAfter.length === routerBefore.length,
        { before: routerBefore.map((entry) => entry.pid), after: routerAfter.map((entry) => entry.pid) });
    step.observations.predecessor = predecessor.map((entry) => ({ pid: entry.pid, identity: entry.identity, role: entry.role, args: entry.args }));
}

// --------------------------------------------------------------- teardown

async function terminateRecorded(ws, actions) {
    const keyOf = (entry) => `${entry.pid}:${entry.identity}`;
    // A process whose identity cannot be observed is never signalled (except
    // SIGCONT, which is harmless to anything) and is reported as still alive.
    const signalOne = (entry, signal) => {
        let info;
        try { info = processInfo(entry.pid); } catch (error) {
            actions.push({ pid: entry.pid, role: entry.role, action: `identity-unverifiable-${signal}-not-sent`, error: String(error.message || error) });
            return 'unverifiable';
        }
        if (!isLive(info)) return 'gone';
        if (info.identity !== entry.identity) {
            actions.push({ pid: entry.pid, role: entry.role, action: 'identity-mismatch-not-signaled', recorded: entry.identity, observed: info.identity });
            return 'identity-mismatch';
        }
        try { process.kill(entry.pid, signal); } catch (error) {
            if (error.code !== 'ESRCH') actions.push({ pid: entry.pid, role: entry.role, action: `signal-${signal}-failed`, error: error.code });
            return 'gone';
        }
        actions.push({ pid: entry.pid, role: entry.role, action: `sent-${signal}`, identity: entry.identity });
        return 'signaled';
    };
    const isAlive = (entry) => {
        try { return sameProcess(processInfo(entry.pid), entry); } catch (_) { return true; }
    };
    const liveEntries = () => [...ws.recorded.values()].filter(isAlive);

    const frozen = new Map();
    // Never leave a process stopped, whatever happens below.
    const resumeAll = () => {
        for (const entry of frozen.values()) {
            try { process.kill(entry.pid, 'SIGCONT'); } catch (_) { /* gone */ }
        }
    };
    try {
        // 1. Freeze, then record, until a pass finds nothing new. A stopped
        //    supervisor cannot spawn (the Router's container monitor restarts a
        //    stopped agent on a timer), so every descendant it already has is
        //    recorded, with its identity, before any parent link is broken. If an
        //    observation fails, everything frozen so far is resumed and the
        //    freeze is abandoned; termination then continues without it.
        try {
            for (let pass = 0; pass < 12; pass += 1) {
                const added = recordOwnedDescendants(ws, processTable(), 'teardown') + recordPidRecordRoots(ws, 'teardown');
                let newlyFrozen = 0;
                for (const entry of liveEntries()) {
                    if (entry.role === 'bystander' || frozen.has(keyOf(entry))) continue;
                    if (signalOne(entry, 'SIGSTOP') === 'signaled') { frozen.set(keyOf(entry), entry); newlyFrozen += 1; }
                }
                if (!added && !newlyFrozen) break;
            }
        } catch (error) {
            actions.push({ action: 'freeze-loop-aborted', error: String(error && error.message || error), resumed: [...frozen.values()].map((entry) => entry.pid) });
            resumeAll();
            frozen.clear();
        }

        // 2. Supervisors are killed outright (a stopped process would only run its
        //    handlers, and its timers, after SIGCONT). Everything else gets SIGTERM
        //    and then SIGCONT, so the signal is delivered.
        for (const entry of liveEntries()) {
            if (['watchdog', 'router-child'].includes(entry.role)) signalOne(entry, 'SIGKILL');
        }
        for (const entry of liveEntries()) {
            signalOne(entry, 'SIGTERM');
            if (frozen.has(keyOf(entry))) { try { process.kill(entry.pid, 'SIGCONT'); } catch (_) { /* gone */ } }
        }
        let deadline = Date.now() + TERM_GRACE_MS;
        while (Date.now() < deadline && !ws.deadlineExceeded && liveEntries().length) await sleep(200);
        for (const entry of liveEntries()) signalOne(entry, 'SIGKILL');
        deadline = Date.now() + KILL_GRACE_MS;
        while (Date.now() < deadline && !ws.deadlineExceeded && liveEntries().length) await sleep(200);
    } finally {
        resumeAll();
    }
}

function collectWorkspaceLogs(ws) {
    const out = path.join(ws.options.artifacts, 'workspace-logs');
    const copied = [];
    const sources = [
        path.join(ws.ploinkyDir, 'logs'),
    ];
    for (const dir of sources) {
        let names = [];
        try { names = fs.readdirSync(dir, { recursive: true }); } catch (_) { continue; }
        for (const name of names) {
            const from = path.join(dir, name);
            try {
                if (!fs.statSync(from).isFile()) continue;
                const to = path.join(out, name);
                fs.mkdirSync(path.dirname(to), { recursive: true });
                fs.copyFileSync(from, to);
                copied.push(path.relative(ws.options.artifacts, to));
            } catch (_) { /* best effort */ }
        }
    }
    for (const file of ['agents.json', 'routing.json']) {
        try {
            fs.mkdirSync(out, { recursive: true });
            fs.copyFileSync(path.join(ws.ploinkyDir, file), path.join(out, file));
            copied.push(path.join('workspace-logs', file));
        } catch (_) { /* absent */ }
    }
    return copied;
}

// Members of a runner-spawned child's process group, or null if unobservable.
function groupMembers(pid) {
    try { return processTable().filter((row) => row.pgid === pid); } catch (_) { return null; }
}

// Ends the whole process group of a runner-spawned command: SIGTERM to the
// group, a bounded wait until no process has pgid === pid, then SIGKILL to the
// group. Memoized, so an interrupt and a timeout share one termination.
function terminateChildGroup(ws, active) {
    if (active.terminating) return active.terminating;
    active.terminating = (async () => {
        const pid = active.child.pid;
        const report = { leaderPid: pid, signals: [], membersBeforeSignal: [], membersAfterTerm: null, membersAtEnd: null };
        active.report = report;
        if (!pid) { await active.exited; return; }
        // Decide ownership BEFORE recording anything. The group is the runner's
        // only while its leader is still the unreaped child, or one of its members
        // is a process the runner had already recorded, matched by pid AND start
        // identity (a pid number alone proves nothing, and members recorded in
        // this very call would prove nothing at all).
        const leaderLive = active.child.exitCode === null && active.child.signalCode === null;
        const members = groupMembers(pid) || [];
        let ours = leaderLive;
        if (!ours) {
            for (const row of members) {
                let info = null;
                try { info = processInfo(row.pid); } catch (_) { info = null; }
                if (info && ws.recorded.has(`${info.pid}:${info.identity}`)) { ours = true; break; }
            }
        }
        report.membersBeforeSignal = members.map((row) => ({ pid: row.pid, ppid: row.ppid, args: row.args }));
        report.ownershipProof = leaderLive ? 'leader is the unreaped child' : (ours ? 'a member was recorded earlier with the same start identity' : 'none: the group was not signalled');
        if (ours) {
            for (const row of members) {
                try {
                    recordProcess(ws, processInfo(row.pid), 'cli-descendant', active.stepName, 'member of the process group of a runner-spawned child');
                } catch (_) { /* best effort */ }
            }
        }
        if (ours) {
            try { process.kill(-pid, 'SIGTERM'); report.signals.push('SIGTERM to the process group'); } catch (_) { /* group already empty */ }
            const deadline = Date.now() + CHILD_TERM_GRACE_MS;
            while (Date.now() < deadline) {
                const rest = groupMembers(pid);
                if (rest !== null && rest.length === 0) break;
                await sleep(100);
            }
            const rest = groupMembers(pid);
            report.membersAfterTerm = rest && rest.map((row) => ({ pid: row.pid, args: row.args }));
            if (rest === null || rest.length) {
                try { process.kill(-pid, 'SIGKILL'); report.signals.push('SIGKILL to the process group'); } catch (_) { /* group already empty */ }
                const killDeadline = Date.now() + KILL_GRACE_MS;
                while (Date.now() < killDeadline) {
                    const left = groupMembers(pid);
                    if (left !== null && left.length === 0) break;
                    await sleep(100);
                }
            }
        }
        await active.exited;
        const end = groupMembers(pid);
        report.membersAtEnd = end && end.map((row) => ({ pid: row.pid, args: row.args }));
    })();
    return active.terminating;
}

// Ends the in-flight runner-spawned command, if any, and waits for its group.
async function terminateActiveChild(ws) {
    if (ws.activeChild) await terminateChildGroup(ws, ws.activeChild);
}

function cleanupRecord(ws) {
    return ws.result.doc.cleanup
        || (ws.result.doc.cleanup = { processes: [], actions: [], removed: [], ports: [], residue: [], foreign: [], ok: true, notes: [] });
}

// Each phase fails on its own: one failure never skips a later phase.
async function cleanupPhase(cleanup, name, fn) {
    try { await fn(); } catch (error) {
        cleanup.ok = false;
        cleanup.notes.push(`${name}: ${error && error.stack || error}`);
    }
}

// The cheap, ownership-safe closing steps. Each runs at most once, from the
// normal teardown or from the deadline handler, whichever gets there first.

// The link this run created is removed even if an earlier phase failed, and
// only while it still points where the run pointed it.
async function removeMcpLink(ws, cleanup) {
    if (ws.cleanupDone.has('mcp-sdk-link')) return;
    ws.cleanupDone.add('mcp-sdk-link');
    const link = ws.created.mcpSdkLink;
    cleanup.mcpSdkLink = { created: Boolean(link), link: link || null };
    if (link) {
        const stat = fs.lstatSync(link, { throwIfNoEntry: false });
        if (stat && stat.isSymbolicLink() && fs.readlinkSync(link) === ws.mcpSdkLinkFrom) {
            fs.unlinkSync(link);
            cleanup.removed.push(link);
        } else if (stat) {
            cleanup.ok = false;
            cleanup.notes.push(`${link} is no longer the symlink this run created; left in place`);
        }
    }
    if (ws.created.nodeModulesDir) {
        try { fs.rmdirSync(ws.created.nodeModulesDir); cleanup.removed.push(ws.created.nodeModulesDir); } catch (error) {
            cleanup.ok = false;
            cleanup.notes.push(`could not remove the node_modules directory this run created: ${error.code}`);
        }
    }
}

async function verifyPorts(ws, cleanup) {
    if (ws.cleanupDone.has('ports')) return;
    ws.cleanupDone.add('ports');
    const ports = [ROUTER_PORT, ROUTER_PRIVATE_PORT, ws.fixturePort, ws.gatePort, ws.bystander && ws.bystander.port].filter(Boolean);
    for (const port of ports) {
        const status = await portStatus(port);
        cleanup.ports.push(status);
        if (!status.free) cleanup.ok = false;
    }
}

async function scanResidue(ws, cleanup) {
    if (ws.cleanupDone.has('residue')) return;
    ws.cleanupDone.add('residue');
    if (!ws.root) return;
    // Anything that still names the workspace path is residue. The runner
    // reports it and never signals it: it is not provably the runner's.
    const table = processTable();
    const skip = ancestorsOfSelf(table);
    for (const row of table) {
        if (skip.has(row.pid) || !row.args.includes(ws.root)) continue;
        const info = processInfo(row.pid);
        const owned = Boolean(info) && ws.recorded.has(`${info.pid}:${info.identity}`);
        // 'owned-survivor' was recorded and signalled yet is still alive;
        // 'foreign' was never linked to an owned process and is never signalled.
        cleanup.residue.push({ pid: row.pid, args: row.args, class: owned ? 'owned-survivor' : 'foreign' });
    }
    cleanup.foreign = [...ws.foreign.values()];
    if (cleanup.residue.length) {
        cleanup.ok = false;
        cleanup.notes.push('processes that name the workspace path remain; they are not provably owned by the runner and were not signalled');
    }
}

// One teardown, awaited by every path (scenario end, failure, interrupt).
function teardown(ws, state) {
    if (!ws.teardownPromise) {
        let timer = null;
        const deadlineMs = ws.options['teardown-deadline-ms'];
        const deadline = new Promise((resolve) => {
            timer = setTimeout(async () => {
                // Report what remains instead of waiting forever, and still run
                // the cheap ownership-safe steps: the link removal (with its
                // target check), then the port and residue report. Blocking
                // waits elsewhere end early once this flag is set.
                ws.deadlineExceeded = true;
                const cleanup = cleanupRecord(ws);
                cleanup.ok = false;
                cleanup.notes.push(`teardown deadline of ${deadlineMs} ms exceeded; the remaining phases were abandoned and what remains is reported`);
                await cleanupPhase(cleanup, 'deadline-remaining-report', async () => {
                    cleanup.remaining = [...ws.recorded.values()]
                        .filter((entry) => sameProcess(processInfo(entry.pid), entry))
                        .map((entry) => ({ pid: entry.pid, role: entry.role, identity: entry.identity, args: entry.args }));
                    if (ws.root && fs.existsSync(ws.root)) cleanup.notes.push(`${ws.root} was not removed`);
                });
                // The bystander is the runner's own spawn: end it, identity-checked.
                await cleanupPhase(cleanup, 'deadline-stop-bystander', async () => {
                    const bystander = ws.bystander;
                    if (!bystander || !bystander.identity) return;
                    const info = processInfo(bystander.pid);
                    if (isLive(info) && info.identity === bystander.identity) {
                        process.kill(bystander.pid, 'SIGKILL');
                        cleanup.actions.push({ pid: bystander.pid, role: 'bystander', action: 'sent-SIGKILL', identity: bystander.identity });
                    }
                });
                await cleanupPhase(cleanup, 'deadline-remove-mcp-sdk-link', () => removeMcpLink(ws, cleanup));
                await cleanupPhase(cleanup, 'deadline-verify-ports', () => verifyPorts(ws, cleanup));
                await cleanupPhase(cleanup, 'deadline-residue-scan', () => scanResidue(ws, cleanup));
                resolve();
            }, deadlineMs);
        });
        ws.teardownPromise = Promise.race([runTeardown(ws, state), deadline]).finally(() => clearTimeout(timer));
    }
    return ws.teardownPromise;
}

async function runTeardown(ws, state) {
    const cleanup = cleanupRecord(ws);
    const phase = (name, fn) => cleanupPhase(cleanup, name, fn);
    try {
        await phase('stop-and-observe', async () => {
            await terminateActiveChild(ws);
            if (ws.root && fs.existsSync(ws.ws)) {
                // Stop through the real CLI first, so a Watchdog does not respawn
                // what the runner is about to signal.
                if (!state.finalStopRan) {
                    const step = newStep(ws, 'teardown-stop', 'ploinky-local stop (cleanup after an incomplete scenario)');
                    try {
                        await runChild(ws, step, ws.cli, ['stop'], { timeoutMs: 120_000 });
                        step.child.summary = summarizeChildText(step);
                    } catch (error) {
                        step.error = String(error && error.message || error);
                    }
                    if (step.child) { delete step.child.stdoutText; delete step.child.stderrText; }
                    step.status = 'teardown';
                    step.finishedAt = now();
                    console.log(`[teardown] stop exit ${step.child && step.child.exitCode}`);
                }
                observeProcesses(ws, 'teardown');
                ws.result.doc.workspaceLogs = collectWorkspaceLogs(ws);
            }
        });

        await phase('terminate-owned-processes', async () => {
            await terminateRecorded(ws, cleanup.actions);
            for (const entry of ws.recorded.values()) {
                const alive = sameProcess(processInfo(entry.pid), entry);
                cleanup.processes.push({
                    pid: entry.pid, role: entry.role, proof: entry.proof, identity: entry.identity, args: entry.args,
                    firstSeenStep: entry.firstSeenStep, lastSeenStep: entry.lastSeenStep,
                    goneAtEnd: !alive,
                    signaled: cleanup.actions.some((action) => action.pid === entry.pid && /^sent-/.test(action.action)),
                });
                if (alive) cleanup.ok = false;
            }
        });

        await phase('remove-workspace', async () => {
            if (!ws.root) return;
            const sentinel = path.join(ws.root, '.pnl-owned');
            if (fs.existsSync(sentinel) && path.basename(ws.root).startsWith('pnl-')) {
                fs.rmSync(ws.root, { recursive: true, force: true });
                cleanup.removed.push(ws.root);
            } else {
                cleanup.ok = false;
                cleanup.notes.push(`refused to remove ${ws.root}: ownership sentinel is missing`);
            }
            if (fs.existsSync(ws.root)) { cleanup.ok = false; cleanup.notes.push(`${ws.root} still exists`); }
        });
    } finally {
        await phase('remove-mcp-sdk-link', () => removeMcpLink(ws, cleanup));
        await phase('verify-ports', () => verifyPorts(ws, cleanup));
        await phase('residue-scan', () => scanResidue(ws, cleanup));
        ws.result.save();
    }
}

// ------------------------------------------------------------------- main

async function main() {
    const options = parseArgs(process.argv.slice(2));
    options.artifacts = path.resolve(options.artifacts);
    options.source = path.resolve(options.source);
    if (fs.existsSync(options.artifacts)) {
        let entries = null;
        try { entries = fs.readdirSync(options.artifacts); } catch (_) { /* not a directory */ }
        if (entries === null || entries.length) usage(`--artifacts ${options.artifacts} must be a new or empty directory`);
    }
    fs.mkdirSync(options.artifacts, { recursive: true });
    const resultFile = path.join(options.artifacts, 'result.json');
    const result = new Result(resultFile, {
        runtime: options.runtime,
        host: { platform: process.platform, arch: process.arch, node: process.version },
        scenario: options.scenario,
        engine: options.engine,
        request: { source: options.source, agentlib: options.agentlib || process.env.PLOINKY_TEST_AGENTLIB_DIR || null },
    });
    result.save();

    const prerequisites = await checkPrerequisites(options);
    result.doc.prerequisites = prerequisites.details;
    if (prerequisites.missing.length) {
        result.doc.result = 'unavailable-prerequisite';
        result.doc.missing = prerequisites.missing;
        result.doc.finishedAt = now();
        result.save();
        console.log(JSON.stringify({ result: 'unavailable-prerequisite', missing: prerequisites.missing }));
        process.exit(2);
    }

    const sourceHead = (() => {
        const out = runTool(prerequisites.details.git, ['-C', prerequisites.details.source, 'rev-parse', 'HEAD']);
        return out.status === 0 ? out.stdout.trim() : null;
    })();
    result.doc.source = { path: prerequisites.details.source, head: sourceHead };
    result.doc.agentlib = prerequisites.details.agentlib;

    const ws = new Workspace(options, prerequisites, result);
    const state = { failedStep: null, finalStopRan: false, interrupted: null };
    ws.state = state;
    let fatal = null;
    // A signal never exits the process. It marks the run interrupted and ends
    // the in-flight command; the scenario stops at the next boundary, the single
    // teardown runs to completion, and the process exits once, afterwards.
    const onSignal = (signal) => {
        if (state.interrupted) {
            console.error(`[interrupt] ${signal} ignored: cleanup is already in progress`);
            return;
        }
        state.interrupted = signal;
        console.error(`[interrupt] ${signal}: ending the in-flight command, then cleaning up`);
        terminateActiveChild(ws).catch(() => { /* teardown repeats it */ });
    };
    process.on('SIGINT', () => onSignal('SIGINT'));
    process.on('SIGTERM', () => onSignal('SIGTERM'));
    process.on('SIGHUP', () => onSignal('SIGHUP'));

    try {
        // Resources are created only now that every prerequisite held.
        const nodeModules = path.join(ws.source, 'node_modules');
        const sdkLink = path.join(nodeModules, 'mcp-sdk');
        if (ws.mcpSdkLinkFrom) {
            if (!fs.existsSync(nodeModules)) { fs.mkdirSync(nodeModules); ws.created.nodeModulesDir = nodeModules; }
            fs.symlinkSync(ws.mcpSdkLinkFrom, sdkLink, 'dir');
            ws.created.mcpSdkLink = sdkLink;
            result.doc.mcpSdkLink = { link: sdkLink, target: ws.mcpSdkLinkFrom, createdNodeModules: Boolean(ws.created.nodeModulesDir) };
            result.save();
        }

        ws.root = createRoot(ws);
        result.doc.workspace = { root: ws.root, removedAtEnd: true };
        console.log(`[workspace] root=${ws.root}`);
        fs.mkdirSync(ws.ws, { recursive: true });
        fs.mkdirSync(path.join(ws.root, 'tmp'), { recursive: true });
        ws.tripwire = writeGitConfig(ws);
        ws.childPath = buildPrivateBin(path.join(ws.root, 'bin'), ws.pathPlan);
        const visibleEngines = engineVisible(ws.childPath);
        result.doc.childPath = {
            path: ws.childPath, mode: ws.pathPlan.mode, engine: options.engine,
            engineHitsInSystemDirs: ws.pathPlan.engineHits, enginesVisible: visibleEngines, enginePath: ws.pathPlan.enginePath || null,
        };
        if (options.engine === 'absent' && visibleEngines.length) {
            throw new Error(`a container engine is still visible on the children's PATH: ${visibleEngines.join(', ')}`);
        }
        if (options.engine === 'present' && !visibleEngines.length) {
            throw new Error('--engine present: no container engine is visible on the children\'s PATH');
        }

        copyAgentLib(ws.agentLib, path.join(ws.ws, 'achillesAgentLib'));
        for (const name of BOOT_REPOS) {
            initLocalRepo(ws, path.join(ws.ploinkyDir, 'repos', name), { 'README.md': `${name} (local fixture)\n` }, 'local fixture');
        }
        ws.bootRepoHeads = Object.fromEntries(BOOT_REPOS.map((name) => [name, git(ws, path.join(ws.ploinkyDir, 'repos', name), ['rev-parse', 'HEAD'])]));

        ws.fixturePort = await pickFreePort([ROUTER_PORT, ROUTER_PRIVATE_PORT]);
        const fixtureFiles = {
            'lifecycle/manifest.json': renderManifest(ws, { marker: 'one' }),
            'lifecycle/server.js': fs.readFileSync(path.join(FIXTURE_DIR, 'lifecycle', 'server.js'), 'utf8'),
        };
        if (ws.scenario === 'failed-first-start') {
            // A second lite-sandbox agent: it starts after the lifecycle agent and
            // fails at first (LIFECYCLE_FAIL=1), the same server with a failing env.
            ws.gatePort = await pickFreePort([ROUTER_PORT, ROUTER_PRIVATE_PORT, ws.fixturePort]);
            fixtureFiles['gate/manifest.json'] = renderGateManifest(ws, { fail: true });
            fixtureFiles['gate/server.js'] = fixtureFiles['lifecycle/server.js'];
        }
        ws.fixtureSourceRepo = path.join(ws.root, 'fixture-repo');
        ws.fixtureCommit = initLocalRepo(ws, ws.fixtureSourceRepo, fixtureFiles, 'native lifecycle fixture agents');
        result.doc.workspace.fixturePort = ws.fixturePort;
        if (ws.gatePort) result.doc.workspace.gatePort = ws.gatePort;
        result.doc.workspace.routerPorts = { public: ROUTER_PORT, private: ROUTER_PRIVATE_PORT, configurable: false };
        result.doc.workspace.agentLibCopiedFrom = ws.agentLib;
        result.save();

        const bystander = await startBystander(ws);
        // (the bystander port is chosen to avoid the fixture and gate ports)
        result.doc.workspace.bystander = { port: ws.bystander.port, pid: ws.bystander.pid, ready: bystander.ready.ok };
        if (!bystander.ready.ok) throw new Error('the bystander control process did not become ready');

        if (!state.interrupted) await scenario(ws, state);

        // Network tripwire: the pre-seeded boot repositories were never touched.
        const heads = Object.fromEntries(BOOT_REPOS.map((name) => [name, git(ws, path.join(ws.ploinkyDir, 'repos', name), ['rev-parse', 'HEAD'])]));
        const lifecycleText = result.doc.steps.filter((step) => /^(start|stop|env|enable|destroy)/.test(step.name)).map((step) => (
            fs.existsSync(path.join(options.artifacts, step.child ? step.child.stdout : '')) && step.child
                ? fs.readFileSync(path.join(options.artifacts, step.child.stdout), 'utf8') + fs.readFileSync(path.join(options.artifacts, step.child.stderr), 'utf8')
                : '')).join('\n');
        result.doc.noNetwork = {
            bootRepoHeadsUnchanged: JSON.stringify(heads) === JSON.stringify(ws.bootRepoHeads),
            cloneOrFetchMentioned: /Cloning into|repository not found|Fetching|git fetch/i.test(lifecycleText),
        };
    } catch (error) {
        fatal = error;
        console.error(`runner error: ${error && error.stack || error}`);
    } finally {
        await teardown(ws, state);
    }

    if (result.doc.failedFirstStart && result.doc.cleanup) {
        // Which processes needed the runner: anything the runner's teardown had to
        // signal (SIGTERM or SIGKILL) was not reached by Ploinky's own stop/destroy.
        const roles = new Map([...ws.recorded.values()].map((entry) => [entry.pid, entry]));
        const signalled = result.doc.cleanup.actions
            .filter((action) => /^sent-(SIGTERM|SIGKILL)$/.test(action.action) && roles.has(action.pid) && roles.get(action.pid).role !== 'bystander')
            .map((action) => ({ pid: action.pid, role: roles.get(action.pid).role, ownerKey: roles.get(action.pid).ownerKey, signal: action.action.slice(5) }));
        const report = result.doc.failedFirstStart;
        report.reach = {
            ploinkyStopReachedEverything: report.afterStop ? report.afterStop.survivors.length === 0 : null,
            ploinkyDestroyReachedEverything: report.afterDestroy ? report.afterDestroy.survivors.length === 0 : null,
            runnerTeardownHadToSignal: signalled,
        };
    }
    const stepsOk = result.doc.steps.filter((step) => step.status !== 'teardown').every((step) => step.status === 'pass');
    // scenarioComplete: the final scenario step was reached and no step failed.
    // cliStopSucceeded only says that a `stop` or `destroy` exited 0.
    const cliStopSucceeded = Boolean(state.finalStopRan);
    const scenarioComplete = Boolean(state.reachedEnd) && stepsOk;
    const noNetworkOk = !result.doc.noNetwork || (result.doc.noNetwork.bootRepoHeadsUnchanged && !result.doc.noNetwork.cloneOrFetchMentioned);
    const cleanupOk = Boolean(result.doc.cleanup && result.doc.cleanup.ok);
    const passed = !fatal && !state.interrupted && stepsOk && scenarioComplete && noNetworkOk && cleanupOk;
    result.doc.result = passed ? 'pass' : 'fail';
    if (state.interrupted) result.doc.interrupted = { signal: state.interrupted, exitCode: SIGNAL_EXIT_CODES[state.interrupted] };
    if (fatal) result.doc.error = String(fatal.stack || fatal);
    if (state.failedStep) {
        result.doc.firstFailure = {
            step: state.failedStep.name,
            failedAssertions: state.failedStep.assertions.filter((entry) => !entry.ok).map((entry) => entry.name),
            ...(state.failedStep.failureClass ? { class: state.failedStep.failureClass } : {}),
        };
    }
    result.doc.summary = {
        stepsPassed: result.doc.steps.filter((step) => step.status === 'pass').length,
        stepsFailed: result.doc.steps.filter((step) => step.status === 'fail').length,
        scenarioComplete, cliStopSucceeded, noNetworkOk, cleanupOk,
    };
    result.doc.finishedAt = now();
    result.save();
    console.log(`${passed ? 'PASS' : 'FAIL'} runtime=${options.runtime} result=${resultFile}`);
    process.exit(state.interrupted ? SIGNAL_EXIT_CODES[state.interrupted] : (passed ? 0 : 1));
}

main().catch((error) => {
    console.error(`run.mjs: ${error && error.stack || error}`);
    process.exit(1);
});
