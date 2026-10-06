// Test helper: counts `git` child processes and synchronous fs calls made by
// agent lookups. `git` is counted through a PATH shim that logs every
// invocation and then runs the real binary; fs calls through wrappers on the
// shared `node:fs` object (named builtin exports are re-synced), keeping
// `realpathSync.native` working.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

export const AGENT_REPOSITORY_URL = 'https://github.com/AssistOS-AI/AssistOSExplorer.git';

// A workspace checkout whose origin is the registered AchillesIDE URL, so a
// repository-path lookup for AchillesIDE scans the workspace and spawns git.
export function createWorkspaceCheckout(directory, originUrl = AGENT_REPOSITORY_URL) {
    fs.mkdirSync(directory, { recursive: true });
    execFileSync('git', ['init', '-q', directory], { stdio: 'ignore' });
    execFileSync('git', ['-C', directory, 'remote', 'add', 'origin', originUrl], { stdio: 'ignore' });
}

export function installGitSpawnCounter(scratchDir) {
    const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    const shimDir = path.join(scratchDir, 'git-shim');
    const logPath = path.join(shimDir, 'git.log');
    fs.mkdirSync(shimDir, { recursive: true });
    fs.writeFileSync(path.join(shimDir, 'git'),
        `#!/bin/sh\necho x >> '${logPath}'\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
    const originalPath = process.env.PATH;
    process.env.PATH = `${shimDir}${path.delimiter}${originalPath}`;
    const readCount = () => {
        try {
            return fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).length;
        } catch (_) {
            return 0;
        }
    };
    return {
        count: readCount,
        restore() { process.env.PATH = originalPath; },
    };
}

let installedFsCounter = null;

export function installFsCallCounter() {
    if (installedFsCounter) return installedFsCounter;
    const calls = [];
    let active = false;
    for (const name of Object.keys(fs)) {
        const original = fs[name];
        if (!name.endsWith('Sync') || typeof original !== 'function') continue;
        const wrapped = function countedFsCall(...args) {
            if (active) calls.push({ name, target: typeof args[0] === 'string' ? args[0] : String(args[0]) });
            return original.apply(this, args);
        };
        if (typeof original.native === 'function') {
            const originalNative = original.native;
            wrapped.native = function countedNativeFsCall(...args) {
                if (active) calls.push({ name: `${name}.native`, target: String(args[0]) });
                return originalNative.apply(this, args);
            };
        }
        fs[name] = wrapped;
    }
    syncBuiltinESMExports();
    installedFsCounter = {
        // Runs fn with counting on; returns its result and the calls it made.
        measure(fn) {
            const start = calls.length;
            active = true;
            let result;
            let error = null;
            try {
                result = fn();
            } catch (caught) {
                error = caught;
            } finally {
                active = false;
            }
            const made = calls.slice(start);
            return { result, error, calls: made };
        },
        async measureAsync(fn) {
            const start = calls.length;
            active = true;
            let result;
            let error = null;
            try {
                result = await fn();
            } catch (caught) {
                error = caught;
            } finally {
                active = false;
            }
            return { result, error, calls: calls.slice(start) };
        },
    };
    return installedFsCounter;
}

export function callsNamed(calls, name) {
    return calls.filter((call) => call.name === name).length;
}

export function readsOf(calls, filePath) {
    const resolved = path.resolve(filePath);
    return calls.filter((call) => call.name === 'readFileSync' && path.resolve(call.target) === resolved).length;
}

export function manifestReads(calls) {
    return calls.filter((call) => call.name === 'readFileSync' && path.basename(call.target) === 'manifest.json').length;
}

export function deepFreeze(value) {
    if (value && typeof value === 'object') {
        for (const key of Object.keys(value)) deepFreeze(value[key]);
        Object.freeze(value);
    }
    return value;
}
