// Unit-test isolation guard: no unit test may start a container engine, an
// NVIDIA tool or a remote shell. Load it with
// `node --import ./tests/helpers/engineSpawnGuard.mjs --test ...` (the
// hardware-limits runner does). A child-process call that names one of these
// programs is refused with an error, and the test process exits non-zero even
// when the caller swallowed that error, so a leak is a test failure rather
// than stderr noise. A test-owned fake executable under the test temporary
// directory is not a real engine and is allowed.
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import util from 'node:util';
import { syncBuiltinESMExports } from 'node:module';

export const GUARDED_PROGRAMS = Object.freeze(['podman', 'podman-remote', 'docker', 'nvidia-smi', 'nvidia-cuda-mps-control', 'nvidia-cuda-mps-server', 'ssh', 'scp']);
const guarded = new Set(GUARDED_PROGRAMS);
let temporaryRoot = null;
try { temporaryRoot = fs.realpathSync(os.tmpdir()); } catch (_) {}
const violations = [];

function commandOf(name, args) {
    const [first, second, third] = args;
    const options = [second, third].find((value) => value && typeof value === 'object' && !Array.isArray(value)) || {};
    if (name === 'exec' || name === 'execSync' || options.shell) {
        const line = [first, ...(Array.isArray(second) ? second : [])].filter((value) => typeof value === 'string').join(' ');
        return line.trim().split(/\s+/)[0] || '';
    }
    return typeof first === 'string' ? first : '';
}

export function isGuardedCommand(command) {
    const program = path.basename(String(command || '').replace(/^['"]|['"]$/g, ''));
    if (!guarded.has(program)) return false;
    // A test-owned fake under the test temporary directory is allowed.
    if (path.isAbsolute(command) && temporaryRoot) {
        let real = command;
        try { real = fs.realpathSync(command); } catch (_) {}
        if (real.startsWith(`${temporaryRoot}${path.sep}`)) return false;
    }
    return true;
}

function refuse(name, command) {
    const message = `[engine-spawn-guard] a unit test tried to run ${path.basename(command)} through child_process.${name}`;
    violations.push(message);
    try { process.stderr.write(`${message}\n`); } catch (_) {}
    process.exitCode = 1;
    return Object.assign(new Error(message), { code: 'PLOINKY_TEST_ENGINE_SPAWN' });
}

for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync']) {
    const original = childProcess[name];
    const check = (args) => { const command = commandOf(name, args); if (isGuardedCommand(command)) throw refuse(name, command); };
    const wrapped = function guardedChildProcess(...args) { check(args); return original.apply(this, args); };
    if (original[util.promisify.custom]) {
        const custom = original[util.promisify.custom];
        wrapped[util.promisify.custom] = function guardedPromisified(...args) {
            try { check(args); } catch (error) { return Promise.reject(error); }
            return custom.apply(this, args);
        };
    }
    childProcess[name] = wrapped;
}
syncBuiltinESMExports();

// A swallowed refusal still fails the test process.
process.on('exit', () => { if (violations.length) process.exitCode = 1; });

export function engineSpawnViolations() { return [...violations]; }
