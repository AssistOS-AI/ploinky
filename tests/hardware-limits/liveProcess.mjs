// Fixed-command transport. Every POSIX child starts a new owned process group;
// deadlines terminate that group and have a separate final settlement bound.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// stdinPath, when given, is one private regular file streamed as the child's
// standard input (remote staging uploads); otherwise standard input is closed.
export function runBoundedProcess(binary, args, {
    cwd, env, deadlineMs = 30000, maxBytes = 65536, signal, spawnProcess = spawn, stdinPath = null,
} = {}) {
    if (!path.isAbsolute(binary) || !path.isAbsolute(cwd || '')
        || !Array.isArray(args) || args.some(value => typeof value !== 'string' || value.includes('\0'))
        || !Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 18_000_000
        || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 1048576
        || !(stdinPath === null || (path.isAbsolute(stdinPath) && path.normalize(stdinPath) === stdinPath))) throw new Error('Invalid bounded process invocation');
    if (process.platform === 'win32') throw new Error('Owned process-group transport requires POSIX');
    return new Promise(resolve => {
        let child, timer, killTimer, settlementTimer, groupTimer;
        let stdout = '', stderr = '', bytes = 0;
        let timedOut = false, truncated = false, cancelled = Boolean(signal?.aborted);
        let errorCode = null, settled = false, stopping = false, settlementForced = false;
        let exitStatus = null, exitSignal = null;
        const finish = (status = exitStatus, childSignal = exitSignal) => {
            if (settled) return;
            settled = true;
            for (const value of [timer, killTimer, settlementTimer, groupTimer]) clearTimeout(value);
            signal?.removeEventListener('abort', abort);
            resolve({ status, signal: childSignal, stdout, stderr, timedOut, truncated, cancelled, errorCode, settlementForced });
        };
        const killGroup = kind => {
            if (!Number.isInteger(child?.pid) || child.pid <= 0) return;
            try { process.kill(-child.pid, kind); }
            catch (error) { if (error.code !== 'ESRCH') errorCode ||= error.code || 'PROCESS_GROUP_SIGNAL_FAILED'; }
        };
        const groupPresent = () => {
            if (!Number.isInteger(child?.pid) || child.pid <= 0) return false;
            try { process.kill(-child.pid, 0); return true; }
            catch (error) { if (error.code === 'ESRCH') return false; errorCode ||= error.code || 'PROCESS_GROUP_QUERY_FAILED'; return true; }
        };
        const waitForGroup = () => {
            if (settled) return;
            if (!groupPresent()) { finish(); return; }
            groupTimer = setTimeout(waitForGroup, 10);
        };
        const stop = () => {
            if (stopping || settled) return;
            stopping = true;
            killGroup('SIGTERM');
            killTimer = setTimeout(() => killGroup('SIGKILL'), 250);
            settlementTimer = setTimeout(() => {
                // A descendant with an inherited pipe cannot keep the caller
                // waiting after its entire owned group was sent SIGKILL.
                settlementForced = true;
                killGroup('SIGKILL');
                child?.stdout?.destroy(); child?.stderr?.destroy();
                child?.unref();
                finish();
            }, 750);
        };
        const abort = () => { cancelled = true; stop(); };
        if (cancelled) { finish(null, null); return; }
        let input = 'ignore';
        try {
            if (stdinPath !== null) {
                input = fs.openSync(stdinPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
                if (!fs.fstatSync(input).isFile()) throw Object.assign(new Error('stdin is not a regular file'), { code: 'STDIN_NOT_FILE' });
            }
            child = spawnProcess(binary, args, { cwd, env, shell: false, detached: true, stdio: [input, 'pipe', 'pipe'] });
        } catch (error) { errorCode = error.code || 'SPAWN_ERROR'; finish(null, null); return; }
        finally { if (typeof input === 'number') fs.closeSync(input); }
        const collect = (name, chunk) => {
            const buffer = Buffer.from(chunk); const remaining = Math.max(0, maxBytes - bytes);
            const value = buffer.subarray(0, remaining).toString('utf8');
            if (name === 'stdout') stdout += value; else stderr += value;
            bytes += buffer.length;
            if (bytes > maxBytes) { truncated = true; stop(); }
        };
        child.stdout.on('data', chunk => collect('stdout', chunk));
        child.stderr.on('data', chunk => collect('stderr', chunk));
        child.on('error', error => { errorCode = error.code || 'SPAWN_ERROR'; if (!child.pid) finish(null, null); else stop(); });
        child.on('exit', (status, childSignal) => { exitStatus = status; exitSignal = childSignal; });
        child.on('close', (status, childSignal) => {
            if (settled) return;
            exitStatus = status; exitSignal = childSignal;
            // The command cannot leave a same-group descendant behind merely
            // by closing its output pipes before the leader exits.
            if (!groupPresent()) { finish(status, childSignal); return; }
            stop();
            waitForGroup();
        });
        timer = setTimeout(() => { timedOut = true; stop(); }, deadlineMs);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
    });
}

export function requireTransport(result, { stress = false } = {}) {
    if (!result || result.errorCode || result.signal || result.timedOut || result.truncated || result.cancelled || result.settlementForced
        || !Number.isInteger(result.status) || (!stress && result.status !== 0)) throw new Error('Live command failed, timed out, was cancelled, or returned incomplete output');
    return result;
}
