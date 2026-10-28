import { execFile as execFileDefault, spawn as spawnDefault } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { buildAgentWorkerEnvironment } from '../webtty/agentWorkerEnvironment.mjs';
import { parseExactPodmanInspectEnvelope } from '../webtty/agentRuntime.mjs';
import {
    assertOwnedInspection,
    exactCandidate,
    projectTerminalContainerInspect,
    translateWorkspaceDirectoryToMount,
} from '../webtty/terminalTargetResolver.mjs';
import { workspaceNetworkIdentity } from '../../sandbox/networkIdentity.js';

// Agent exec: an agent whose manifest sets routerAccess.agentExec (RoboTeam) runs one non-interactive
// process inside the running container of a global-mode agent, the way `ploinky shell` and WebTTY run
// a process in an agent container, but started by the agent and with pipes instead of a terminal.
//
// The process never inherits the target's environment: it starts through `env -i` with only the
// caller's variables (no PLOINKY_* names), so it cannot read or use the target agent's credentials.
// Its cwd must be a writable workspace directory mounted at the same path in the target. Output is
// buffered per exec and read through a resumable NDJSON stream; stdin arrives in separate requests
// because the private listener buffers each request body before authorizing it.

const PODMAN = '/usr/bin/podman';
const EXEC_ID = /^[a-f0-9]{32}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const TARGET = /^[A-Za-z0-9._-]{1,128}\/[A-Za-z0-9._-]{1,128}$/;
const MARKER_NAME = 'PLOINKY_AGENT_EXEC_ID';

export const AGENT_EXEC_LIMITS = Object.freeze({
    maxConcurrentPerCaller: 16,
    maxConcurrent: 48,
    maxArgv: 512,
    maxArgBytes: 64 * 1024,
    maxEnvEntries: 256,
    maxEnvBytes: 256 * 1024,
    maxBufferedOutputBytes: 8 * 1024 * 1024,
    retainAfterExitMs: 10 * 60 * 1000,
    killGraceMs: 3000,
    inspectTimeoutMs: 5000,
});

export function agentExecError(status, code, message = code) {
    const error = new Error(message);
    error.status = status;
    error.code = code;
    return error;
}

function exactText(value) {
    return typeof value === 'string' ? value : '';
}

// Validates and normalizes a start request: { target: "repo/agent", argv: [...], env: {...}, cwd }.
export function normalizeAgentExecRequest(input, limits = AGENT_EXEC_LIMITS) {
    const invalid = (message) => agentExecError(400, 'AGENT_EXEC_REQUEST_INVALID', message);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('request must be an object');
    const target = exactText(input.target);
    if (!TARGET.test(target)) throw invalid('target must be repo/agent');
    const argv = input.argv;
    if (!Array.isArray(argv) || argv.length === 0 || argv.length > limits.maxArgv
        || argv.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
        throw invalid('argv must be a non-empty array of strings');
    }
    if (argv.reduce((total, arg) => total + Buffer.byteLength(arg), 0) > limits.maxArgBytes) throw invalid('argv is too large');
    if (!path.isAbsolute(argv[0])) throw invalid('argv[0] must be an absolute path');
    const cwd = exactText(input.cwd);
    if (!path.isAbsolute(cwd) || path.resolve(cwd) !== cwd) throw invalid('cwd must be a normalized absolute path');
    const env = input.env ?? {};
    if (!env || typeof env !== 'object' || Array.isArray(env)) throw invalid('env must be an object');
    const entries = Object.entries(env);
    if (entries.length > limits.maxEnvEntries) throw invalid('env has too many entries');
    let bytes = 0;
    for (const [name, value] of entries) {
        if (!ENV_NAME.test(name) || name.startsWith('PLOINKY_') || typeof value !== 'string' || value.includes('\0')) {
            throw invalid(`env entry ${name} is not allowed`);
        }
        bytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 2;
    }
    if (bytes > limits.maxEnvBytes) throw invalid('env is too large');
    return Object.freeze({ target, argv: Object.freeze([...argv]), cwd, env: Object.freeze(Object.fromEntries(entries)) });
}

// The registry candidate for repo/agent: a running podman agent in global mode, other than the caller.
export function selectAgentExecTarget(snapshot, target, caller) {
    const [repoName, agentName] = target.split('/');
    const matches = Object.entries(snapshot?.agents || {})
        .filter(([, record]) => record?.type === 'agent' && record.repoName === repoName && record.agentName === agentName && !record.alias);
    if (matches.length !== 1) throw agentExecError(404, 'AGENT_EXEC_TARGET_UNKNOWN', `agent ${target} is not enabled`);
    const [containerName, record] = matches[0];
    if (record.runMode !== 'global') {
        throw agentExecError(409, 'AGENT_EXEC_TARGET_NOT_GLOBAL', `agent ${target} does not run in global mode`);
    }
    const candidate = exactCandidate(containerName, record, new Set(['podman']));
    if (!candidate) throw agentExecError(409, 'AGENT_EXEC_TARGET_UNAVAILABLE', `agent ${target} has no running podman container`);
    if (caller && `agent:${repoName}/${agentName}` === caller.agentId) {
        throw agentExecError(409, 'AGENT_EXEC_TARGET_IS_CALLER', 'an agent cannot exec into itself');
    }
    return candidate;
}

function inspectContainer(containerId, { execFileImpl, timeoutMs }) {
    return new Promise((resolve, reject) => {
        execFileImpl(PODMAN, ['container', 'inspect', containerId], {
            cwd: '/tmp', env: buildAgentWorkerEnvironment(), encoding: 'utf8', timeout: timeoutMs,
            maxBuffer: 4 * 1024 * 1024, killSignal: 'SIGKILL', windowsHide: true,
        }, (error, stdout) => {
            if (error) return reject(agentExecError(503, 'AGENT_EXEC_TARGET_INSPECT_FAILED', 'target container cannot be inspected'));
            try {
                const raw = parseExactPodmanInspectEnvelope(stdout, containerId,
                    function inspectError() { return agentExecError(503, 'AGENT_EXEC_TARGET_INSPECT_INVALID'); });
                const imagePath = (raw?.Config?.Env || []).find((entry) => String(entry).startsWith('PATH='));
                resolve({ inspected: projectTerminalContainerInspect(raw), imagePath: imagePath ? String(imagePath).slice(5) : '' });
            } catch (inner) { reject(inner); }
        });
    });
}

// The pids of the exec's processes: those carrying its marker in their environment, plus every
// descendant. Nested rootless containers share the Box PID namespace view, so the Router sees them.
export function listMarkedProcessTree(marker, { procRoot = '/proc', fsApi = fs } = {}) {
    // The marker is 128 random bits, so a substring match identifies the exec's processes.
    const needle = Buffer.from(`${MARKER_NAME}=${marker}`);
    const parents = new Map();
    const marked = new Set();
    for (const entry of fsApi.readdirSync(procRoot)) {
        if (!/^[0-9]+$/.test(entry)) continue;
        const pid = Number(entry);
        try {
            const stat = fsApi.readFileSync(path.join(procRoot, entry, 'stat'), 'utf8');
            const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
            parents.set(pid, Number(fields[1]));
            const environ = fsApi.readFileSync(path.join(procRoot, entry, 'environ'));
            if (environ.includes(needle)) marked.add(pid);
        } catch (_) { /* exited or not readable */ }
    }
    const tree = new Set(marked);
    let grew = true;
    while (grew) {
        grew = false;
        for (const [pid, ppid] of parents) {
            if (!tree.has(pid) && tree.has(ppid)) { tree.add(pid); grew = true; }
        }
    }
    return [...tree];
}

export class AgentExecManager {
    constructor({
        execFileImpl = execFileDefault,
        spawnImpl = spawnDefault,
        listProcessTree = listMarkedProcessTree,
        killImpl = (pid, signal) => process.kill(pid, signal),
        workspaceIdentity = workspaceNetworkIdentity,
        assertOwned = assertOwnedInspection,
        fsApi = fs,
        limits = AGENT_EXEC_LIMITS,
        now = () => Date.now(),
        audit = () => {},
    } = {}) {
        Object.assign(this, { execFileImpl, spawnImpl, listProcessTree, killImpl, workspaceIdentity, assertOwned, fsApi, now, audit });
        this.limits = Object.freeze({ ...AGENT_EXEC_LIMITS, ...limits });
        this.execs = new Map();
    }

    active(callerId = null) {
        return [...this.execs.values()].filter((entry) => entry.exit === null && (!callerId || entry.callerId === callerId)).length;
    }

    async start({ snapshot, caller, body }) {
        let input;
        try { input = JSON.parse(Buffer.from(body || '').toString('utf8') || 'null'); } catch (_) {
            throw agentExecError(400, 'AGENT_EXEC_REQUEST_INVALID', 'request must be JSON');
        }
        const request = normalizeAgentExecRequest(input, this.limits);
        if (this.active() >= this.limits.maxConcurrent || this.active(caller.agentId) >= this.limits.maxConcurrentPerCaller) {
            throw agentExecError(429, 'AGENT_EXEC_LIMIT', 'too many agent exec processes are running');
        }
        const candidate = selectAgentExecTarget(snapshot, request.target, caller);
        const workspaceHash = exactText(this.workspaceIdentity()?.hash);
        if (!workspaceHash) throw agentExecError(503, 'AGENT_EXEC_WORKSPACE_UNAVAILABLE');
        const { inspected, imagePath } = await inspectContainer(candidate.containerId,
            { execFileImpl: this.execFileImpl, timeoutMs: this.limits.inspectTimeoutMs });
        let owned;
        try { owned = this.assertOwned(candidate, inspected, workspaceHash); } catch (_) {
            throw agentExecError(409, 'AGENT_EXEC_TARGET_UNAVAILABLE', `agent ${request.target} is not running`);
        }
        const mapping = await translateWorkspaceDirectoryToMount(request.cwd, owned.mounts, { fsApi: this.fsApi });
        if (!mapping || mapping.access !== 'rw' || mapping.translatedCwd !== request.cwd) {
            throw agentExecError(409, 'AGENT_EXEC_CWD_UNAVAILABLE', 'cwd is not a writable workspace directory at the same path in the target');
        }
        const id = randomBytes(16).toString('hex');
        const marker = randomBytes(16).toString('hex');
        // The caller's PATH comes first; the target image's PATH keeps its own tools reachable.
        const env = { ...request.env, [MARKER_NAME]: marker };
        env.PATH = [request.env.PATH, imagePath].filter(Boolean).join(':') || '/usr/local/bin:/usr/bin:/bin';
        const args = ['container', 'exec', '--interactive', '--user', owned.user, '--workdir', request.cwd,
            candidate.containerId, '/usr/bin/env', '-i', ...Object.entries(env).map(([name, value]) => `${name}=${value}`),
            ...request.argv];
        const child = this.spawnImpl(PODMAN, args, { cwd: '/tmp', env: buildAgentWorkerEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
        const entry = {
            id, marker, callerId: caller.agentId, target: request.target, containerId: candidate.containerId,
            child, events: [], firstSeq: 0, nextSeq: 0, bufferedBytes: 0, exit: null, listeners: new Set(),
            startedAt: this.now(), killTimer: null, dropTimer: null,
        };
        this.execs.set(id, entry);
        child.stdout.on('data', (chunk) => this.record(entry, 'stdout', chunk));
        child.stderr.on('data', (chunk) => this.record(entry, 'stderr', chunk));
        child.stdin.on('error', () => {});
        child.on('error', () => this.finish(entry, { code: null, signal: null, error: 'spawn-failed' }));
        child.on('close', (code, signal) => this.finish(entry, { code, signal }));
        this.audit('agent_exec_started', { execId: id, callerAgentId: caller.agentId, target: request.target });
        return { execId: id, target: request.target };
    }

    record(entry, type, chunk) {
        const data = Buffer.from(chunk);
        entry.events.push({ seq: entry.nextSeq++, type, data });
        entry.bufferedBytes += data.length;
        // Old output is dropped once the buffer is full; a reader behind it learns about the gap.
        while (entry.bufferedBytes > this.limits.maxBufferedOutputBytes && entry.events.length > 1) {
            const dropped = entry.events.shift();
            entry.bufferedBytes -= dropped.data.length;
            entry.firstSeq = entry.events[0].seq;
        }
        for (const listener of entry.listeners) listener();
    }

    finish(entry, exit) {
        if (entry.exit) return;
        clearTimeout(entry.killTimer);
        entry.exit = exit;
        entry.events.push({ seq: entry.nextSeq++, type: 'exit', data: Buffer.alloc(0) });
        for (const listener of entry.listeners) listener();
        this.audit('agent_exec_finished', { execId: entry.id, callerAgentId: entry.callerId, code: exit.code, signal: exit.signal });
        entry.dropTimer = setTimeout(() => this.execs.delete(entry.id), this.limits.retainAfterExitMs);
        entry.dropTimer.unref?.();
    }

    owned(id, caller) {
        const entry = EXEC_ID.test(String(id || '')) ? this.execs.get(id) : null;
        if (!entry || entry.callerId !== caller.agentId) throw agentExecError(404, 'AGENT_EXEC_UNKNOWN', 'unknown agent exec');
        return entry;
    }

    // Writes NDJSON events from `from` on: {seq, type: stdout|stderr, data: base64} and finally
    // {seq, type: 'exit', code, signal}. The response ends after the exit event or when `isAuthorized`
    // turns false (the client reconnects with the next seq).
    stream(id, caller, from, res, { isAuthorized = () => true } = {}) {
        const entry = this.owned(id, caller);
        let next = Number.isSafeInteger(from) && from >= 0 ? from : 0;
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        if (next < entry.firstSeq) {
            res.write(`${JSON.stringify({ seq: entry.firstSeq, type: 'gap', from: next })}\n`);
            next = entry.firstSeq;
        }
        let closed = false;
        const close = () => {
            if (closed) return;
            closed = true;
            entry.listeners.delete(flush);
            clearInterval(guard);
            res.end();
        };
        const flush = () => {
            if (closed) return;
            for (const event of entry.events) {
                if (event.seq < next) continue;
                const line = event.type === 'exit'
                    ? { seq: event.seq, type: 'exit', code: entry.exit.code, signal: entry.exit.signal, ...(entry.exit.error ? { error: entry.exit.error } : {}) }
                    : { seq: event.seq, type: event.type, data: event.data.toString('base64') };
                res.write(`${JSON.stringify(line)}\n`);
                next = event.seq + 1;
                if (event.type === 'exit') return close();
            }
        };
        const guard = setInterval(() => { if (!isAuthorized()) close(); }, 5000);
        guard.unref?.();
        entry.listeners.add(flush);
        res.on('close', close);
        flush();
    }

    input(id, caller, body) {
        const entry = this.owned(id, caller);
        let input;
        try { input = JSON.parse(Buffer.from(body || '').toString('utf8') || '{}'); } catch (_) {
            throw agentExecError(400, 'AGENT_EXEC_INPUT_INVALID', 'input must be JSON');
        }
        if (entry.exit) throw agentExecError(409, 'AGENT_EXEC_FINISHED', 'agent exec has finished');
        if (input.data !== undefined) {
            if (typeof input.data !== 'string') throw agentExecError(400, 'AGENT_EXEC_INPUT_INVALID', 'data must be base64 text');
            entry.child.stdin.write(Buffer.from(input.data, 'base64'));
        }
        if (input.close === true) entry.child.stdin.end();
        return { ok: true };
    }

    // SIGTERM to the exec's process tree in the target, then SIGKILL after the grace period.
    kill(id, caller) {
        const entry = this.owned(id, caller);
        if (entry.exit) return { ok: true, finished: true };
        const signalTree = (signal) => {
            let pids = [];
            try { pids = this.listProcessTree(entry.marker); } catch (_) {}
            for (const pid of pids) { try { this.killImpl(pid, signal); } catch (_) {} }
            try { entry.child.kill(signal); } catch (_) {}
        };
        signalTree('SIGTERM');
        entry.killTimer = setTimeout(() => { if (!entry.exit) signalTree('SIGKILL'); }, this.limits.killGraceMs);
        entry.killTimer.unref?.();
        this.audit('agent_exec_killed', { execId: entry.id, callerAgentId: entry.callerId });
        return { ok: true, finished: false };
    }
}
