import fs from 'fs';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { LOGS_DIR } from '../utils/config.js';
import {
    readProviderTaskOwner,
    readServiceOwnerReadOnly,
} from '../sandbox/bwrap/bwrapFleet.js';
import {
    collectLiveAgentContainers,
    getAgentsRegistry,
} from '../sandbox/docker/containerRegistry.js';

function invalidLogTarget(message) {
    const error = new Error(message);
    error.code = 'PLOINKY_LOG_TARGET_INVALID';
    return error;
}

function exactKey(value, label) {
    if (typeof value !== 'string' || !value || value !== value.trim()
        || Buffer.byteLength(value, 'utf8') > 512
        || !/^[A-Za-z0-9:._-]+$/u.test(value)) {
        throw invalidLogTarget(`${label} is invalid`);
    }
    return value;
}

function confinedLogPath(value) {
    if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value) {
        throw invalidLogTarget('owned log path is not exact');
    }
    const relative = path.relative(LOGS_DIR, value);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw invalidLogTarget('owned log path escapes the workspace log directory');
    }
    return value;
}

function exactContainerId(value) {
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
        throw invalidLogTarget('selected container identity is invalid');
    }
    return value;
}

function readExactContainerServiceOwner(runtimeKey, dependencies = {}) {
    const registry = (dependencies.getAgentsRegistry || getAgentsRegistry)();
    const record = registry?.[runtimeKey];
    if (!record || record.type !== 'agent' || record.runtime !== 'podman') return null;
    const containerId = exactContainerId(record.containerId);
    const containers = (dependencies.collectLiveAgentContainers || collectLiveAgentContainers)({
        registry,
    });
    const selected = containers.find((entry) => (
        entry?.containerName === runtimeKey
        && entry.runtime === 'podman'
        && entry.containerId === containerId
        && entry.instanceId === record.instanceId
        && entry.enableGeneration === record.enableGeneration
    ));
    if (!selected) return null;
    return Object.freeze({
        role: 'service',
        runtime: 'container',
        runtimeKey,
        containerId,
    });
}

function selectedServiceLogOwner(runtimeKey, dependencies = {}) {
    if (Object.hasOwn(dependencies, 'readServiceOwner')) {
        const sandboxOwner = dependencies.readServiceOwner(runtimeKey);
        if (sandboxOwner) return sandboxOwner;
        return (dependencies.readContainerServiceOwner || readExactContainerServiceOwner)(
            runtimeKey,
            dependencies,
        );
    }
    const registry = (dependencies.getAgentsRegistry || getAgentsRegistry)();
    const record = registry?.[runtimeKey];
    if (!record || record.type !== 'agent') return null;
    if (record.runtime === 'podman') {
        return (dependencies.readContainerServiceOwner || readExactContainerServiceOwner)(
            runtimeKey,
            { ...dependencies, getAgentsRegistry: () => registry },
        );
    }
    if (record.runtime !== 'bwrap' && record.runtime !== 'seatbelt') return null;
    const owner = readServiceOwnerReadOnly(runtimeKey);
    if (!owner || owner.instanceId !== record.instanceId
        || owner.enableGeneration !== record.enableGeneration
        || owner.homeKey !== record.homeKey) return null;
    return owner;
}

export function parseLogTarget(tokens = []) {
    if (!Array.isArray(tokens)) throw invalidLogTarget('log target must be an argument list');
    if (tokens.length === 0 || (tokens.length === 1 && tokens[0] === 'router')) {
        return Object.freeze({ kind: 'router' });
    }
    if (tokens.length === 2 && tokens[0] === 'service') {
        return Object.freeze({ kind: 'service', runtimeKey: exactKey(tokens[1], 'runtime key') });
    }
    if (tokens.length === 3 && tokens[0] === 'task') {
        return Object.freeze({
            kind: 'task',
            runtimeKey: exactKey(tokens[1], 'runtime key'),
            taskId: exactKey(tokens[2], 'task id'),
        });
    }
    throw invalidLogTarget('log target must be router, service <runtime-key>, or task <runtime-key> <task-id>');
}

export function resolveOwnedLogSource(request = {}, dependencies = {}) {
    const kind = String(request?.kind || '');
    if (kind === 'router') {
        return Object.freeze({
            kind: 'file',
            path: path.join(LOGS_DIR, 'router.log'),
        });
    }
    const runtimeKey = exactKey(request?.runtimeKey, 'runtime key');
    if (kind === 'service') {
        const owner = selectedServiceLogOwner(runtimeKey, dependencies);
        if (!owner || owner.role !== 'service' || owner.runtimeKey !== runtimeKey) {
            throw invalidLogTarget('exact service log owner is unavailable');
        }
        if (owner.runtime === 'container') {
            return Object.freeze({
                kind: 'container',
                runtime: 'podman',
                runtimeKey,
                containerId: exactContainerId(owner.containerId),
            });
        }
        return Object.freeze({ kind: 'file', path: confinedLogPath(owner.logPath) });
    }
    if (kind === 'task') {
        const taskId = exactKey(request?.taskId, 'task id');
        const read = dependencies.readProviderTaskOwner || readProviderTaskOwner;
        const owner = read(runtimeKey, taskId);
        if (!owner || owner.role !== 'provider-task'
            || owner.runtimeKey !== runtimeKey || owner.taskId !== taskId) {
            throw invalidLogTarget('exact provider-task log owner is unavailable');
        }
        return Object.freeze({ kind: 'file', path: confinedLogPath(owner.logPath) });
    }
    throw invalidLogTarget('log kind must be router, service, or task');
}

export function resolveOwnedLogPath(request = {}, dependencies = {}) {
    const source = resolveOwnedLogSource(request, dependencies);
    if (source.kind !== 'file') {
        throw invalidLogTarget('selected service logs are owned by the container runtime');
    }
    return source.path;
}

function logRequest(target) {
    if (target && typeof target === 'object' && !Array.isArray(target)) return target;
    return Object.freeze({ kind: target || 'router' });
}

export function getLogPath(target, dependencies = {}) {
    return resolveOwnedLogPath(logRequest(target), dependencies);
}

export async function logsTail(target, dependencies = {}) {
    const source = resolveOwnedLogSource(logRequest(target), dependencies);
    if (source.kind === 'container') {
        const run = dependencies.spawn || spawn;
        const proc = run(source.runtime, [
            'logs', '--follow', '--tail', '0', source.containerId,
        ], { stdio: 'inherit' });
        await new Promise((resolve, reject) => {
            proc.once('error', reject);
            proc.once('exit', (code) => (
                code === 0 ? resolve() : reject(new Error('container logs failed'))
            ));
        });
        return;
    }
    const file = source.path;
    if (!fs.existsSync(file)) {
        console.log(`No log file yet: ${file}`);
        return;
    }
    try {
        const proc = spawn('tail', ['-f', file], { stdio: 'inherit' });
        await new Promise(resolve => proc.on('exit', resolve));
    } catch (_) {
        console.log(`Following ${file} (fallback watcher). Stop with Ctrl+C.`);
        let pos = fs.statSync(file).size;
        const fd = fs.openSync(file, 'r');
        const loop = () => {
            try {
                const st = fs.statSync(file);
                if (st.size > pos) {
                    const len = st.size - pos;
                    const buf = Buffer.alloc(len);
                    fs.readSync(fd, buf, 0, len, pos);
                    process.stdout.write(buf.toString('utf8'));
                    pos = st.size;
                }
            } catch (_) {}
            setTimeout(loop, 1000);
        };
        loop();
    }
}

export function showLast(count, target, dependencies = {}) {
    const n = Math.max(1, parseInt(count || '200', 10) || 200);
    const source = resolveOwnedLogSource(logRequest(target || 'router'), dependencies);
    if (source.kind === 'container') {
        const run = dependencies.spawnSync || spawnSync;
        const result = run(source.runtime, [
            'logs', '--tail', String(n), source.containerId,
        ], { stdio: 'inherit' });
        if (result?.error || result?.status !== 0) {
            throw invalidLogTarget('exact container service logs are unavailable');
        }
        return;
    }
    const file = source.path;
    if (!fs.existsSync(file)) {
        console.log(`No log file: ${file}`);
        return;
    }
    try {
        const result = spawnSync('tail', ['-n', String(n), file], { stdio: 'inherit' });
        if (result.status !== 0) throw new Error('tail failed');
    } catch (e) {
        try {
            const data = fs.readFileSync(file, 'utf8');
            const lines = data.split('\n');
            const chunk = lines.slice(-n).join('\n');
            console.log(chunk);
        } catch (e2) {
            console.error(`Failed to read ${file}: ${e2.message}`);
        }
    }
}
