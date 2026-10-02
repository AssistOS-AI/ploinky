// Unit-test isolation guard: no unit test may start a container engine, an
// NVIDIA tool or a remote shell. Load it with
// `node --import ./tests/helpers/engineSpawnGuard.mjs --test ...` (the
// hardware-limits runner does).
//
// - A child-process call that would run one of these programs is refused
//   with an error: named directly, through a wrapper (env, sh -c, bash -c,
//   xargs, ...) or as a command of a shell line. A lookup such as
//   `command -v podman` runs nothing and is allowed.
// - Descendants are guarded too: Node children load this guard through
//   NODE_OPTIONS, and wherever a child's PATH would run a real one of these
//   programs a failing stub is found first, so a native or deeper spawn is
//   refused as well; an absent program stays absent.
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

let temporaryRoot = os.tmpdir();
try { temporaryRoot = fs.realpathSync(temporaryRoot); } catch (_) {}
const parentLog = process.env[LOG_ENV] || '';
const ownDirectory = fs.mkdtempSync(path.join(temporaryRoot, 'engine-guard-'));
const ownLog = path.join(ownDirectory, 'violations.log');
fs.writeFileSync(ownLog, '', { mode: 0o600 });

const underTemporaryRoot = (target) => {
    let real = target;
    try { real = fs.realpathSync(target); } catch (_) {}
    return real.startsWith(`${temporaryRoot}${path.sep}`) && !real.startsWith(`${ownDirectory}${path.sep}`);
};
// The guarded programs a PATH would really run: found and executable, and
// not a test-owned fake under the test temporary directory. Only those are
// shadowed, so a lookup of a program that is absent still finds nothing.
function realProgramsOn(searchPath) {
    const found = [];
    for (const program of GUARDED_PROGRAMS) {
        for (const directory of String(searchPath || '').split(path.delimiter).filter(Boolean)) {
            const candidate = path.join(directory, program);
            try { fs.accessSync(candidate, fs.constants.X_OK); } catch (_) { continue; }
            if (!underTemporaryRoot(candidate)) found.push(program);
            break;
        }
    }
    return found;
}
const stubDirectories = new Map();
function stubDirectoryFor(programs) {
    const key = programs.join(',');
    if (stubDirectories.has(key)) return stubDirectories.get(key);
    const directory = path.join(ownDirectory, `bin-${stubDirectories.size}`);
    fs.mkdirSync(directory, { mode: 0o700 });
    for (const program of programs) {
        fs.writeFileSync(path.join(directory, program), '#!/bin/sh\n'
            + `printf '%s\\n' "[engine-spawn-guard] a test process ran ${program}" >&2\n`
            + `[ -n "$${LOG_ENV}" ] && printf '%s\\n' "[engine-spawn-guard] a test process ran ${program} (native)" >> "$${LOG_ENV}"\n`
            + 'exit 97\n', { mode: 0o755 });
    }
    stubDirectories.set(key, directory);
    return directory;
}
const isStubDirectory = (entry) => entry.startsWith(`${ownDirectory}${path.sep}bin-`) || /\/engine-guard-[^/]+\/bin-\d+$/.test(entry);
function withGuardPath(value) {
    if (value === undefined || value === null) return value;
    const entries = String(value).split(path.delimiter).filter((entry) => entry && !isStubDirectory(entry));
    const programs = realProgramsOn(entries.join(path.delimiter));
    return (programs.length ? [stubDirectoryFor(programs), ...entries] : entries).join(path.delimiter);
}
const withGuardOptions = (value = '') => (String(value || '').includes(GUARD_URL) ? String(value) : `${String(value || '')} --import=${GUARD_URL}`.trim());
process.env[LOG_ENV] = ownLog;
process.env.PATH = withGuardPath(process.env.PATH);
process.env.NODE_OPTIONS = withGuardOptions(process.env.NODE_OPTIONS);

export function isGuardedCommand(command) {
    const text = String(command || '').replace(/^['"]|['"]$/g, '');
    if (!guarded.has(path.basename(text))) return false;
    // A test-owned fake under the test temporary directory is allowed.
    return !(path.isAbsolute(text) && underTemporaryRoot(text));
}

// The programs a shell line runs: the first word of each command, after
// assignments, keywords and wrappers. Lookups (command -v, which, type,
// hash) and words in argument positions run nothing.
const SHELL_PREFIXES = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', 'time', 'exec', 'nohup', 'env', 'builtin', 'xargs', 'sudo', 'doas', 'nice', 'ionice', 'timeout', 'stdbuf', 'setsid', 'unbuffer', 'command']);
function shellCommands(line) {
    const commands = [];
    for (const segment of String(line || '').split(/\|\||&&|[;|&\n()`]|\$\(/)) {
        const words = segment.trim().split(/\s+/).filter(Boolean).map((word) => word.replace(/^['"]|['"]$/g, ''));
        let index = 0;
        while (index < words.length) {
            const word = words[index];
            if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) { index += 1; continue; }
            if ((word === 'command' && /^-[vV]$/.test(words[index + 1] || '')) || ['which', 'type', 'hash'].includes(word)) break;
            if (SHELL_PREFIXES.has(word)) {
                index += 1;
                while (index < words.length && /^-/.test(words[index])) index += 1;
                if (word === 'timeout' && /^\d/.test(words[index] || '')) index += 1;
                continue;
            }
            commands.push(word);
            break;
        }
    }
    return commands;
}

// The guarded program an invocation would run, or null.
export function guardedProgramOf(name, args) {
    const [first, second, third] = args;
    const options = [second, third].find((value) => value && typeof value === 'object' && !Array.isArray(value)) || {};
    const argv = Array.isArray(second) ? second.filter((value) => typeof value === 'string') : [];
    if (name === 'exec' || name === 'execSync' || options.shell) {
        return shellCommands([first, ...argv].filter((value) => typeof value === 'string').join(' ')).find(isGuardedCommand) || null;
    }
    const program = typeof first === 'string' ? first : '';
    if (isGuardedCommand(program)) return program;
    const base = path.basename(program);
    if (!WRAPPERS.has(base)) return null;
    if (SHELLS.has(base)) return argv.includes('-c') ? shellCommands(argv[argv.indexOf('-c') + 1]).find(isGuardedCommand) || null : null;
    // A wrapper runs its first non-option, non-assignment operand.
    const operand = argv.find((value) => !/^-/.test(value) && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(value) && !/^\d+(\.\d+)?[smhd]?$/.test(value));
    return operand && isGuardedCommand(operand) ? operand : null;
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
    const env = { ...args[index].env, NODE_OPTIONS: withGuardOptions(args[index].env.NODE_OPTIONS) };
    if (env.PATH !== undefined) env.PATH = withGuardPath(env.PATH);
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
