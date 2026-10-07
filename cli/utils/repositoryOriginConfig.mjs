import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

const ORIGIN_TIMEOUT_MS = 2000;
const ORIGIN_MAX_BYTES = 1024 * 1024;
const originArgs = directory => ['-C', directory, 'config', '--get', 'remote.origin.url'];

// Git owns repository discovery, safe.directory and the complete effective config.
export function readOriginFromGitConfig(directory) {
    if (!fs.existsSync(path.join(directory, '.git'))) return '';
    try {
        return execFileSync('git', originArgs(directory), {
            encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: ORIGIN_TIMEOUT_MS,
        }).replace(/\n$/, '');
    } catch { return ''; }
}

export function readOriginFromGitConfigAsync(directory, { signal } = {}) {
    if (signal?.aborted || !fs.existsSync(path.join(directory, '.git'))) return Promise.resolve('');
    return new Promise(resolve => {
        let child;
        try { child = spawn('git', originArgs(directory), { stdio: ['ignore', 'pipe', 'ignore'] }); }
        catch { resolve(''); return; }
        let failed = false;
        let bytes = 0;
        const chunks = [];
        const terminate = () => {
            failed = true;
            chunks.length = 0;
            child.kill('SIGKILL');
        };
        const timer = setTimeout(terminate, ORIGIN_TIMEOUT_MS);
        const onAbort = () => terminate();
        signal?.addEventListener('abort', onAbort, { once: true });
        child.on('error', () => { failed = true; });
        child.stdout.on('error', terminate);
        child.stdout.on('data', chunk => {
            if (failed) return;
            bytes += chunk.length;
            if (bytes > ORIGIN_MAX_BYTES) terminate();
            else chunks.push(chunk);
        });
        // Resolve on close, never on exit/error: the direct child and pipes are settled.
        child.once('close', code => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            resolve(!failed && !signal?.aborted && code === 0 ? Buffer.concat(chunks).toString('utf8').replace(/\n$/, '') : '');
        });
        if (signal?.aborted) terminate();
    });
}
