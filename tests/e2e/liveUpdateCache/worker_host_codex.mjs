import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { AcceptanceError, LIMITS, need, validateManifest, parseStrictJson } from './manifest_codex.mjs';
import { superviseOwnedUpdate, OPERATIONS, validateExpectation } from './execution_codex.mjs';
import { runOwnedCommand, buildCommandEnvironment, monotonicNow, defaultDelay } from './host_command_codex.mjs';
import { parseStatusProof } from './live_admission_codex.mjs';

// Parent side of the owned worker: one fixed input file per operation, the pinned Node binary, a private
// environment, and the retained supervision of the exact child. The parent never imports the candidate product.
const WORKER_RELATIVE = 'tests/e2e/liveUpdateCache/execution_codex.mjs';

export function writeInputOnce(io, file, bytes) {
    need(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= LIMITS.manifestBytes, 'worker-input-size');
    let fd;
    try { fd = io.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600); }
    catch (error) {
        if (error?.code !== 'EEXIST') throw new AcceptanceError('worker-input-write');
        // A repeated status read reuses the identical private file; anything else under that name is refused.
        const existing = io.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
            const stat = io.fstatSync(existing), buffer = Buffer.alloc(bytes.length + 1); let offset = 0;
            need(stat.isFile() && stat.nlink === 1 && stat.size === bytes.length && (stat.mode & 0o077) === 0, 'worker-input-conflict');
            for (;;) { const count = io.readSync(existing, buffer, offset, buffer.length - offset, null); if (!count) break; offset += count; need(offset <= bytes.length, 'worker-input-conflict'); }
            need(offset === bytes.length && buffer.subarray(0, offset).equals(bytes), 'worker-input-conflict');
        } finally { io.closeSync(existing); }
        return false;
    }
    try { let offset = 0; while (offset < bytes.length) { const count = io.writeSync(fd, bytes, offset, bytes.length - offset); need(count > 0, 'worker-input-write'); offset += count; } }
    finally { io.closeSync(fd); }
    return true;
}

export function createWorkerHost({ manifest, deps, io = fs, spawn = childProcess.spawn, processEnv = process.env }) {
    validateManifest(manifest);
    need(deps && deps.latch && deps.custody && typeof deps.runId === 'string', 'worker-host-adapters');
    const { launch = spawn, now = monotonicNow, delay = defaultDelay, register, current, latch, custody } = deps;
    const env = buildCommandEnvironment(processEnv, { PLOINKY_WORKSPACE_ROOT: manifest.workspace.path });
    const workerPath = path.join(manifest.candidate.root, WORKER_RELATIVE), node = manifest.host.node.path;
    const inputPath = operation => path.join(manifest.evidence.root, `${operation}_input_codex.json`);
    const workerLaunch = (bin, args, options) => launch(bin, args, { ...options, env, shell: false, detached: false, windowsHide: true });
    const frameOf = result => { try { return parseStrictJson(result.control, LIMITS.controlBytes); } catch { throw new AcceptanceError('worker-control-json'); } };
    return Object.freeze({
        env: () => ({ ...env }),
        async status() {
            const file = inputPath('status');
            writeInputOnce(io, file, Buffer.from(JSON.stringify({ schemaVersion: 1, kind: 'status', runId: manifest.runId, operation: 'status', manifest })));
            const result = await runOwnedCommand({ operation: 'worker-status', kind: 'read', argv: [node, workerPath, '--owned-status', file], cwd: manifest.workspace.path, env,
                deadlineMs: 120000, controlBytes: LIMITS.controlBytes, allowedExitCodes: [0, 2], collect: false }, { launch: workerLaunch, now, delay, latch, custody, runId: deps.runId, register, current });
            const frame = frameOf(result);
            if (frame?.type === 'WORKER_FAILURE') {
                need(isDeepStrictEqual(Object.keys(frame), ['type', 'runId', 'operation', 'reason']) && result.code === 2 && frame.runId === manifest.runId && frame.operation === 'status'
                    && typeof frame.reason === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(frame.reason), 'worker-result-binding');
                latch.stop(`worker-${frame.reason}`); throw new AcceptanceError(`worker-${frame.reason}`);
            }
            need(result.code === 0 && isDeepStrictEqual(Object.keys(frame ?? {}), ['type', 'runId', 'proof']) && frame.type === 'STATUS_RESULT' && frame.runId === manifest.runId, 'worker-result-binding');
            return parseStatusProof(frame.proof);
        },
        async update(operation, expected) {
            need(OPERATIONS.includes(operation), 'update-operation'); validateExpectation(expected, manifest);
            const file = inputPath(operation);
            need(writeInputOnce(io, file, Buffer.from(JSON.stringify({ schemaVersion: 1, kind: 'update', runId: manifest.runId, operation, manifest, expected }))), 'worker-input-reused');
            const result = await superviseOwnedUpdate({ manifest, operation, workerPath, workerInputPath: file, expected }, { launch: workerLaunch, register, current, now, delay, latch, custody });
            if (result.passed === false || result.uncertain) { const error = new AcceptanceError(result.reason ?? 'worker-uncertain'); error.retained = result.retained; throw error; }
            return result;
        },
    });
}
