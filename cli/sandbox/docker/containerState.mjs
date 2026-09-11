import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { probeContainerRuntime } from './common.js';

const states = new Set([
    'running', 'configured', 'created', 'dead', 'exited', 'initialized', 'paused',
    'removing', 'restarting', 'stopped', 'stopping', 'unknown',
]);

export function inspectContainerState(target, options = {}) {
    const runtime = options.runtime || probeContainerRuntime();
    function fail(message, timeout = false) {
        const error = new Error(`cannot inspect container '${target}' identity and state: ${message}`);
        error.code = timeout ? 'PLOINKY_CONTAINER_CONTROL_PLANE_TIMEOUT' : 'PLOINKY_CONTAINER_CONTROL_PLANE_FAILED';
        throw error;
    }
    if (!runtime) fail('no container runtime is available');
    const idField = path.basename(runtime) === 'podman' ? '.ID' : '.Id';
    const result = (options.spawnSyncImpl || spawnSync)(runtime, [
        'container', 'inspect', '--format', `[{{json ${idField}}},{{json .Name}},{{json .State.Status}}]`, target,
    ], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        timeout: options.timeoutMs || 30_000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024,
    });
    if (result.error) fail('runtime inspection failed', result.error.code === 'ETIMEDOUT');
    if (result.status !== 0) fail('runtime inspection did not succeed');
    let value;
    try { value = JSON.parse(String(result.stdout || '')); } catch { fail('runtime returned malformed identity and state'); }
    if (!Array.isArray(value) || value.length !== 3) fail('runtime returned invalid identity and state');
    const [id, rawName, status] = value;
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)
        || typeof rawName !== 'string' || !states.has(status)) fail('runtime returned invalid identity and state');
    const name = rawName.replace(/^\//, '');
    if (!name || (target !== id && target !== name)) fail('runtime returned a different container');
    return { id, name, status, runtime };
}
