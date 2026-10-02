// Unit-test isolation guard: no unit test may start a container engine, an
// NVIDIA tool or a remote shell. Load it with
// `node --import ./tests/helpers/engineSpawnGuard.mjs --test ...` (the
// hardware-limits runner does).
//
// - A child-process call that would run one of these programs is refused
//   with an error: named directly, through a wrapper (env, sh -c, bash -c,
//   xargs, ...) or anywhere in a shell command line. A lookup such as
//   `command -v podman` runs nothing and is allowed.
// - Descendants are guarded too: Node children load this guard through
//   NODE_OPTIONS, and every child finds failing stubs for these programs
//   first on PATH, so a native or deeper spawn is refused as well.
// - Every refusal is recorded in a per-process ledger that is passed on to
//   the parent's ledger, and a process whose ledger is not empty exits
//   non-zero, so a refusal the code under test swallowed still fails the
//   test.
// A test-owned fake executable at an absolute path under the test temporary
// directory is not a real engine and is allowed.
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import util from 'node:util';
import { syncBuiltinESMExports } from 'node:module';

export const GUARDED_PROGRAMS = Object.freeze(['podman', 'podman-remote', 'docker', 'nvidia-smi', 'nvidia-cuda-mps-control', 'nvidia-cuda-mps-server', 'ssh', 'scp']);
const guarded = new Set(GUARDED_PROGRAMS);
const WRAPPERS = new Set(['env', 'sh', 'bash', 'zsh', 'dash', 'ksh', 'xargs', 'nohup', 'timeout', 'nice', 'ionice', 'stdbuf', 'sudo', 'doas', 'exec', 'time', 'setsid', 'script', 'unbuffer', 'flock', 'chroot', 'taskset', 'busybox']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'busybox']);
const GUARD_URL = import.meta.url;
const LOG_ENV = 'PLOINKY_ENGINE_GUARD_LOG';
const BIN_ENV = 'PLOINKY_ENGINE_GUARD_BIN';

let temporaryRoot = os.tmpdir();
try { temporaryRoot = fs.realpathSync(temporaryRoot); } catch (_) {}
const parentLog = process.env[LOG_ENV] || '';
const ownDirectory = fs.mkdtempSync(path.join(temporaryRoot, 'engine-guard-'));
const ownLog = path.join(ownDirectory, 'violations.log');
fs.writeFileSync(ownLog, '', { mode: 0o600 });
let binDirectory = process.env[BIN_ENV] || '';
if (!binDirectory || !fs.existsSync(path.join(binDirectory, GUARDED_PROGRAMS[0]))) {
    binDirectory = path.join(ownDirectory, 'bin');
    fs.mkdirSync(binDirectory, { mode: 0o700 });
    for (const program of GUARDED_PROGRAMS) {
        fs.writeFileSync(path.join(binDirectory, program), '#!/bin/sh\n'
            + `printf '%s\\n' "[engine-spawn-guard] a test process ran ${program}" >&2\n`
            + `[ -n "$${LOG_ENV}" ] && printf '%s\\n' "[engine-spawn-guard] a test process ran ${program} (native)" >> "$${LOG_ENV}"\n`
            + 'exit 97\n', { mode: 0o755 });
    }
}

const withGuardOptions = (value = '') => (String(value || '').includes(GUARD_URL) ? String(value) : `${String(value || '')} --import=${GUARD_URL}`.trim());
const withGuardPath = (value = '') => [binDirectory, ...String(value || '').split(path.delimiter).filter((entry) => entry && entry !== binDirectory)].join(path.delimiter);
process.env[LOG_ENV] = ownLog;
process.env[BIN_ENV] = binDirectory;
process.env.PATH = withGuardPath(process.env.PATH);
process.env.NODE_OPTIONS = withGuardOptions(process.env.NODE_OPTIONS);

export function isGuardedCommand(command) {
    const text = String(command || '').replace(/^['"]|['"]$/g, '');
    if (!guarded.has(path.basename(text))) return false;
    // A test-owned fake under the test temporary directory is allowed.
    if (path.isAbsolute(text)) {
        let real = text;
        try { real = fs.realpathSync(text); } catch (_) {}
        if (real.startsWith(`${temporaryRoot}${path.sep}`) && !real.startsWith(`${binDirectory}${path.sep}`)) return false;
    }
    return true;
}

// The words a shell would run: lookups (command -v, which, type, hash) run
// nothing, and assignments are not programs.
function shellWords(line) {
    const withoutLookups = String(line || '').replace(/\b(?:command\s+-[vV]|which|type|hash)\s+\S+/g, ' ');
    return withoutLookups.split(/[\s;&|()<>`$'"\\{}]+/).filter(Boolean).filter((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
}

// The guarded program an invocation would run, or null.
export function guardedProgramOf(name, args) {
    const [first, second, third] = args;
    const options = [second, third].find((value) => value && typeof value === 'object' && !Array.isArray(value)) || {};
    const argv = Array.isArray(second) ? second.filter((value) => typeof value === 'string') : [];
    if (name === 'exec' || name === 'execSync' || options.shell) {
        return shellWords([first, ...argv].filter((value) => typeof value === 'string').join(' ')).find(isGuardedCommand) || null;
    }
    const program = typeof first === 'string' ? first : '';
    if (isGuardedCommand(program)) return program;
    const base = path.basename(program);
    if (!WRAPPERS.has(base)) return null;
    const direct = argv.find(isGuardedCommand);
    if (direct) return direct;
    if (SHELLS.has(base) && argv.includes('-c')) return shellWords(argv[argv.indexOf('-c') + 1]).find(isGuardedCommand) || null;
    return null;
}

const violations = [];
function refuse(name, program) {
    const message = `[engine-spawn-guard] a unit test tried to run ${path.basename(String(program))} through child_process.${name}`;
    violations.push(message);
    try { fs.appendFileSync(ownLog, `${message}\n`); } catch (_) {}
    try { process.stderr.write(`${message}\n`); } catch (_) {}
    process.exitCode = 1;
    return Object.assign(new Error(message), { code: 'PLOINKY_TEST_ENGINE_SPAWN' });
}

// A child given an explicit environment is still guarded: its PATH starts
// with the failing stubs and a Node child loads this guard. A nested runner
// that imports the guard itself is an independent root with its own ledger.
function guardChildEnvironment(args) {
    const index = [1, 2].find((position) => args[position] && typeof args[position] === 'object' && !Array.isArray(args[position]));
    if (index === undefined || !args[index].env) return args;
    const argv = Array.isArray(args[1]) ? args[1] : [];
    const independent = argv.some((value) => typeof value === 'string' && value.includes('engineSpawnGuard'));
    const env = { ...args[index].env, PATH: withGuardPath(args[index].env.PATH), NODE_OPTIONS: withGuardOptions(args[index].env.NODE_OPTIONS), [BIN_ENV]: binDirectory };
    if (independent) delete env[LOG_ENV]; else env[LOG_ENV] = ownLog;
    const next = [...args];
    next[index] = { ...args[index], env };
    return next;
}

for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    const original = childProcess[name];
    const check = (args) => {
        const program = name === 'fork' ? null : guardedProgramOf(name, args);
        if (program) throw refuse(name, program);
        return guardChildEnvironment(args);
    };
    const wrapped = function guardedChildProcess(...args) { return original.apply(this, check(args)); };
    if (original[util.promisify.custom]) {
        const custom = original[util.promisify.custom];
        wrapped[util.promisify.custom] = function guardedPromisified(...args) {
            let checked;
            try { checked = check(args); } catch (error) { return Promise.reject(error); }
            return custom.apply(this, checked);
        };
    }
    childProcess[name] = wrapped;
}
syncBuiltinESMExports();

// A refusal anywhere below this process fails it, even when swallowed, and
// is passed on to the parent's ledger.
process.on('exit', () => {
    let lines = [];
    try { lines = fs.readFileSync(ownLog, 'utf8').split('\n').filter(Boolean); } catch (_) {}
    if (lines.length) {
        process.exitCode = 1;
        if (parentLog && parentLog !== ownLog) { try { fs.appendFileSync(parentLog, `${lines.join('\n')}\n`); } catch (_) {} }
    }
    try { fs.rmSync(ownDirectory, { recursive: true, force: true }); } catch (_) {}
});

export function engineSpawnViolations() {
    try { return fs.readFileSync(ownLog, 'utf8').split('\n').filter(Boolean); } catch (_) { return [...violations]; }
}
