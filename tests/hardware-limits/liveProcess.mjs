// Fixed-command live harness transport. Callers select commands; manifests
// never supply scripts, shell fragments, environment maps or arbitrary argv.
import { spawn } from 'node:child_process';
import path from 'node:path';

export function runBoundedProcess(binary, args, {
    cwd, env, deadlineMs = 30000, maxBytes = 65536, signal, spawnProcess = spawn,
} = {}) {
    if (!path.isAbsolute(binary) || !path.isAbsolute(cwd || '')
        || !Array.isArray(args) || args.some(value => typeof value !== 'string' || value.includes('\0'))
        || !Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 1200000
        || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 1048576) {
        throw new Error('Invalid bounded process invocation');
    }
    return new Promise(resolve => {
        let child;
        let stdout = '';
        let stderr = '';
        let bytes = 0;
        let timedOut = false;
        let truncated = false;
        let cancelled = Boolean(signal?.aborted);
        let errorCode = null;
        let timer;
        let killTimer;
        let settled = false;
        const finish = (status, childSignal) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            clearTimeout(killTimer);
            signal?.removeEventListener('abort', abort);
            resolve({ status, signal: childSignal, stdout, stderr, timedOut, truncated, cancelled, errorCode });
        };
        const stop = () => {
            child?.kill('SIGTERM');
            killTimer ||= setTimeout(() => child?.kill('SIGKILL'), 500);
        };
        const abort = () => { cancelled = true; stop(); };
        if (cancelled) { finish(null, null); return; }
        try {
            child = spawnProcess(binary, args, { cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (error) {
            errorCode = error.code || 'SPAWN_ERROR';
            finish(null, null);
            return;
        }
        const collect = (name, chunk) => {
            const buffer = Buffer.from(chunk);
            const remaining = Math.max(0, maxBytes - bytes);
            const value = buffer.subarray(0, remaining).toString('utf8');
            if (name === 'stdout') stdout += value;
            else stderr += value;
            bytes += buffer.length;
            if (bytes > maxBytes) { truncated = true; stop(); }
        };
        child.stdout.on('data', chunk => collect('stdout', chunk));
        child.stderr.on('data', chunk => collect('stderr', chunk));
        child.on('error', error => { errorCode = error.code || 'SPAWN_ERROR'; });
        child.on('close', finish);
        timer = setTimeout(() => { timedOut = true; stop(); }, deadlineMs);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
    });
}

export function requireTransport(result, { stress = false } = {}) {
    if (!result || result.errorCode || result.signal || result.timedOut || result.truncated || result.cancelled
        || !Number.isInteger(result.status) || (!stress && result.status !== 0)) {
        throw new Error('Live command failed, timed out, was cancelled, or returned incomplete output');
    }
    return result;
}
