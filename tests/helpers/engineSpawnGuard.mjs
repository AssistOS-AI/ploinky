// Unit-test isolation guard: no unit test may start a container engine, an
// NVIDIA tool or a remote shell. Load it with
// `node --import ./tests/helpers/engineSpawnGuard.mjs --test ...` (the
// hardware-limits runner does).
//
// Covered (each form has a test in tests/unit/hardwareLimitsEngineGuard.test.mjs):
// - A child_process call that would run a guarded program is refused with an
//   error whose code is PLOINKY_TEST_ENGINE_SPAWN: named directly, through any
//   wrapper (env, nice, timeout, xargs, sudo, busybox, ...), through a shell
//   option cluster (-c, -lc, -ec, --login -c, -c --), or as a command of a
//   shell line (after assignments, redirections, `eval`, `exec`, `command`,
//   `$(...)`, backticks, nested wrappers and nested shells). Wrapper options
//   that take arguments (env -u/-P/-S/-C, xargs -I/-E/-n/-P/-L/-s/-d, ...) are
//   parsed, and the operand is analysed as a new invocation. A lookup such as
//   `command -v podman` runs nothing and is allowed.
// - Conservative scan: any word of a wrapper's argv or of a shell script that
//   is a path whose case-folded basename is guarded, or whose realpath or
//   inode is a real guarded binary found at start-up (the original PATH plus
//   /usr/bin, /bin, /usr/local/bin, /opt/homebrew/bin, /opt/podman/bin), is
//   refused wherever it appears (`eval /abs/podman`, `"$@"`, renamed symlinks,
//   `/.../PODMAN` on a case-insensitive file system).
// - Login shells (-l, --login, a cluster containing l, argv0 starting with
//   "-") rebuild PATH from their profile after any injection, so they are
//   refused when the script contains a guarded word anywhere (command
//   position or not); otherwise they run, with a PATH the guard cannot
//   shadow.
// - `options.shell` given as a string, and `fork` with `execPath`, are checked.
// - Descendants are guarded: Node children (and worker threads) load this
//   guard, an explicit environment gets a PATH that starts with failing stubs
//   (a missing PATH gets the stubs and the system directories), `PATH=`
//   assignments and `env -i`/`-u` in a wrapper's argv are rewritten through the
//   same shadowing and re-inject NODE_OPTIONS and the ledger variables.
// - Every refusal, JS or native stub, is appended at once to the top-level
//   ledger (an inherited path), so a child killed by a signal still fails the
//   top-level process, which exits non-zero when the ledger is not empty.
// - One temporary root per top-level guarded process holds every stub
//   directory of its descendants; the top-level process removes it on exit
//   and on SIGINT, SIGTERM and SIGHUP before re-raising.
// A test-owned fake executable at an absolute path under the test temporary
// directory is not a real engine and is allowed, unless its realpath or inode
// is a real guarded binary.
//
// Not covered: interpreters running engines (perl, awk, python, `find -exec`);
// scripts read from files or standard input; `process.binding`, internal
// spawn APIs and `ChildProcess.prototype.spawn`; native addons; hard links in
// the test temporary directory; glob or quote obfuscation (`p""odman`,
// `podma?`); environment resets inside a shell line given as one string
// (their words are still analysed, but they cannot be rewritten); sudo and
// doas environment resets.
//
// Test-only: PLOINKY_ENGINE_GUARD_EXTRA_PROGRAMS (comma-separated names) adds
// guarded names, so tests can use a canary that exists nowhere on any PATH.
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import util from 'node:util';
import workerThreads from 'node:worker_threads';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';

export const GUARDED_PROGRAMS = Object.freeze(['podman', 'podman-remote', 'docker', 'nvidia-smi', 'nvidia-cuda-mps-control', 'nvidia-cuda-mps-server', 'ssh', 'scp']);
const EXTRA_ENV = 'PLOINKY_ENGINE_GUARD_EXTRA_PROGRAMS';
const TOP_LOG_ENV = 'PLOINKY_ENGINE_GUARD_TOP_LOG';
const ROOT_ENV = 'PLOINKY_ENGINE_GUARD_ROOT';
const TEMP_ENV = 'PLOINKY_ENGINE_GUARD_TEMP';
const GUARD_URL = import.meta.url;
const DEFAULT_PATH = '/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin';
const FIXED_BINARY_DIRECTORIES = ['/usr/bin', '/bin', '/usr/local/bin', '/opt/homebrew/bin', '/opt/podman/bin'];
const MAX_DEPTH = 8;

const lower = (value) => String(value).toLowerCase();
const extraPrograms = String(process.env[EXTRA_ENV] || '').split(',').map((value) => value.trim()).filter((value) => /^[A-Za-z0-9._-]{3,64}$/.test(value));
const allGuarded = Object.freeze([...GUARDED_PROGRAMS, ...extraPrograms]);
const guardedNames = new Set(allGuarded.map(lower));

const WRAPPERS = new Set(['env', 'sh', 'bash', 'zsh', 'dash', 'ksh', 'xargs', 'nohup', 'timeout', 'nice', 'ionice', 'stdbuf', 'sudo', 'doas', 'exec', 'time', 'setsid', 'script', 'unbuffer', 'flock', 'chroot', 'taskset', 'busybox', 'command', 'builtin']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
// Options that take an argument, per wrapper, and the positionals the wrapper
// itself consumes before its command.
const WRAPPER_OPTIONS = {
    timeout: { args: ['-k', '-s', '--kill-after', '--signal'], positionals: 1 },
    nice: { args: ['-n', '--adjustment'], positionals: 0 },
    ionice: { args: ['-c', '-n', '-p', '-P', '-u', '--class', '--classdata', '--pid'], positionals: 0 },
    stdbuf: { args: ['-i', '-o', '-e', '--input', '--output', '--error'], positionals: 0 },
    sudo: { args: ['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-T', '-U', '-R'], positionals: 0 },
    doas: { args: ['-u', '-C'], positionals: 0 },
    flock: { args: ['-w', '-E', '--timeout', '--conflict-exit-code'], positionals: 1, command: ['-c', '--command'] },
    chroot: { args: ['--userspec', '--groups'], positionals: 1 },
    taskset: { args: [], positionals: 1, listFlags: ['-c', '--cpu-list'] },
    setsid: { args: [], positionals: 0 },
    nohup: { args: [], positionals: 0 },
    time: { args: ['-f', '-o', '--format', '--output'], positionals: 0 },
    exec: { args: ['-a'], positionals: 0 },
    unbuffer: { args: ['-p'], positionals: 0 },
    xargs: { args: ['-I', '-i', '-E', '-e', '-n', '-P', '-L', '-l', '-s', '-d', '-a', '--arg-file', '--delimiter', '--max-args', '--max-procs', '--max-lines', '--max-chars', '--replace', '--eof'], positionals: 0 },
    script: { args: ['-t', '-I', '-O', '-B', '-T', '-E', '-m'], positionals: 1, command: ['-c', '--command'] },
    busybox: { args: [], positionals: 0 },
    command: { args: [], positionals: 0 },
    builtin: { args: [], positionals: 0 },
};
const SHELL_KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', '}', 'fi', 'done']);

// The test temporary directory: what os.tmpdir() is for the top-level process,
// inherited by every descendant, so a child whose environment lacks TMPDIR does
// not widen "test-owned" to /tmp.
let temporaryRoot = process.env[ROOT_ENV] && process.env[TEMP_ENV] ? process.env[TEMP_ENV] : os.tmpdir();
try { temporaryRoot = fs.realpathSync(temporaryRoot); } catch (_) {}

// --- top-level ledger and one temporary root --------------------------------
const inheritedRoot = process.env[ROOT_ENV] || '';
const inheritedLog = process.env[TOP_LOG_ENV] || '';
const isTop = !(inheritedRoot && inheritedLog && fs.existsSync(inheritedRoot) && fs.existsSync(inheritedLog));
const guardRoot = isTop ? fs.mkdtempSync(path.join(temporaryRoot, 'engine-guard-')) : inheritedRoot;
const topLog = isTop ? path.join(guardRoot, 'violations.log') : inheritedLog;
if (isTop) fs.writeFileSync(topLog, '', { mode: 0o600 });
const ownDirectory = isTop ? guardRoot : fs.mkdtempSync(path.join(guardRoot, 'p-'));
const ownViolations = [];

const underTemporaryRoot = (target) => {
    let real = target;
    try { real = fs.realpathSync(target); } catch (_) {}
    return real.startsWith(`${temporaryRoot}${path.sep}`) && !real.startsWith(`${guardRoot}${path.sep}`);
};

// --- real guarded binaries ---------------------------------------------------
const originalPath = String(process.env.PATH || '');
const realPaths = new Set();
const realInodes = new Set();
for (const directory of [...originalPath.split(path.delimiter), ...FIXED_BINARY_DIRECTORIES].filter(Boolean)) {
    for (const program of allGuarded) {
        const candidate = path.join(directory, program);
        try {
            const stat = fs.statSync(candidate);
            if (!stat.isFile() || underTemporaryRoot(candidate)) continue;
            realPaths.add(fs.realpathSync(candidate));
            realInodes.add(`${stat.dev}:${stat.ino}`);
        } catch (_) {}
    }
}

// The guarded programs a PATH would really run: found and executable, and not
// a test-owned fake under the test temporary directory. Only those are
// shadowed, so a lookup of a program that is absent still finds nothing.
function realProgramsOn(searchPath) {
    const found = [];
    for (const program of allGuarded) {
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
            + `[ -n "$${TOP_LOG_ENV}" ] && printf '%s\\n' "[engine-spawn-guard] a test process ran ${program} (native)" >> "$${TOP_LOG_ENV}"\n`
            + 'exit 97\n', { mode: 0o755 });
    }
    stubDirectories.set(key, directory);
    return directory;
}
const isStubDirectory = (entry) => /\/engine-guard-[^/]+(\/p-[^/]+)?\/bin-\d+$/.test(entry);
// `all` shadows every guarded name, found or not: a PATH the child did not
// have (an environment reset) is resolved by the child's own default search.
function withGuardPath(value, { all = false } = {}) {
    if (value === undefined || value === null) return value;
    const entries = String(value).split(path.delimiter).filter((entry) => entry && !isStubDirectory(entry));
    const programs = all ? [...allGuarded] : realProgramsOn(entries.join(path.delimiter));
    return (programs.length ? [stubDirectoryFor(programs), ...entries] : entries).join(path.delimiter);
}
const withGuardOptions = (value = '') => (String(value || '').includes(GUARD_URL) ? String(value) : `${String(value || '')} --import=${GUARD_URL}`.trim());
process.env[TOP_LOG_ENV] = topLog;
process.env[ROOT_ENV] = guardRoot;
process.env[TEMP_ENV] = temporaryRoot;
process.env.PATH = withGuardPath(process.env.PATH);
process.env.NODE_OPTIONS = withGuardOptions(process.env.NODE_OPTIONS);

// --- what is a guarded word ---------------------------------------------------
const unquote = (word) => String(word).replace(/^['"]+|['"]+$/g, '');

function matchesRealBinary(target) {
    try {
        const stat = fs.statSync(target);
        return realInodes.has(`${stat.dev}:${stat.ino}`) || realPaths.has(fs.realpathSync(target));
    } catch (_) { return false; }
}

// A bare name resolves through PATH (the explicit environment of the call
// being analysed, else this process's): when the first executable of that name
// is a test-owned fake under the test temporary directory (a fake runtime a
// test puts first on PATH), the name is not a real program. The guard's own
// stub directories are skipped, and a real binary first on PATH still decides.
let analysedPath = null;
function bareNameIsTestFake(name) {
    for (const directory of String(analysedPath ?? process.env.PATH ?? '').split(path.delimiter).filter((entry) => entry && !isStubDirectory(entry))) {
        const candidate = path.join(directory, name);
        try { fs.accessSync(candidate, fs.constants.X_OK); } catch (_) { continue; }
        return underTemporaryRoot(candidate) && !matchesRealBinary(candidate);
    }
    return false;
}

// A command word is guarded when its case-folded basename is a guarded name,
// unless it is an absolute test-owned fake; any path whose realpath or inode
// is a real guarded binary is guarded under whatever name.
function guardedWord(word) {
    const text = unquote(word);
    if (!text) return false;
    const named = guardedNames.has(lower(path.basename(text)));
    if (!text.includes('/')) return named && !bareNameIsTestFake(text);
    if (matchesRealBinary(text)) return true;
    return named && !(path.isAbsolute(text) && underTemporaryRoot(text));
}
export function isGuardedCommand(command) { return guardedWord(command); }

// Every word of a text that is a path to a guarded program, wherever it appears.
const SCAN_SPLIT = /[\s;&|()<>`$'"\\{}=,]+/;
function scanPaths(text) {
    return String(text ?? '').split(SCAN_SPLIT).find((word) => word.includes('/') && guardedWord(word)) || null;
}
// Any guarded word at all, bare names included (login shells).
function scanAnyGuarded(text) {
    return String(text ?? '').split(SCAN_SPLIT).find((word) => word && guardedWord(word)) || null;
}

// --- shell lines -------------------------------------------------------------
const SEGMENT = /\|\||&&|[;|&\n()`]|\$\(/;
// `2>&1` and `&>file` contain an ampersand that is not a command separator.
const withoutRedirectionAmpersands = (line) => String(line ?? '').replace(/(\d*[<>]{1,2})&(\d*-?)/g, '$1$2').replace(/&>/g, '>');
const REDIRECTION = /^\d*(?:[<>]{1,2}|&>|>&|<&)/;
const BARE_REDIRECTION = /^\d*(?:[<>]{1,2}|&>|>&|<&)$/;
function skipLeading(words) {
    let index = 0;
    while (index < words.length) {
        const word = words[index];
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || SHELL_KEYWORDS.has(word)) { index += 1; continue; }
        if (REDIRECTION.test(word)) {
            // A bare operator takes the next word as its target.
            index += BARE_REDIRECTION.test(word) ? 2 : 1;
            continue;
        }
        break;
    }
    return words.slice(index);
}
// The guarded program a shell line runs, or null.
function lineHit(line, depth) {
    for (const segment of withoutRedirectionAmpersands(line).split(SEGMENT)) {
        const words = segment.trim().split(/\s+/).filter(Boolean).map(unquote);
        const command = skipLeading(words);
        if (!command.length) continue;
        const [first, ...rest] = command;
        if (['which', 'type', 'hash'].includes(first)) continue;
        if (first === 'command' && /^-[vV]$/.test(rest[0] || '')) continue;
        if (first === 'eval') { const hit = lineHit(rest.join(' '), depth + 1); if (hit) return hit; continue; }
        const result = inspect(first, rest, depth + 1);
        if (result.hit) return result.hit;
    }
    return null;
}

// --- invocation analysis -----------------------------------------------------
// The result of one invocation: the guarded program it would run, or null,
// and the argv with guard-environment rewrites applied.
function inspect(program, argv, depth = 0, context = {}) {
    if (depth > MAX_DEPTH) return { hit: String(program), argv };
    const text = unquote(program);
    if (guardedWord(text)) return { hit: text, argv };
    const base = lower(path.basename(text));
    if (!WRAPPERS.has(base)) return { hit: null, argv };
    for (const word of argv) {
        const found = scanPaths(word);
        if (found) return { hit: found, argv };
    }
    if (SHELLS.has(base)) return inspectShell(argv, depth, context);
    if (base === 'env') return inspectEnv(argv, depth);
    return inspectWrapper(base, argv, depth);
}

function inspectShell(argv, depth, context) {
    let login = typeof context.argv0 === 'string' && context.argv0.startsWith('-');
    let command = false;
    let index = 0;
    for (; index < argv.length; index += 1) {
        const word = argv[index];
        if (word === '--') { index += 1; break; }
        if (word === '--login') { login = true; continue; }
        if (['--rcfile', '--init-file'].includes(word)) { index += 1; continue; }
        if (/^--/.test(word)) continue;
        if (/^[-+][A-Za-z]+$/.test(word)) {
            const letters = word.slice(1);
            if (word[0] === '-') {
                if (letters.includes('c')) command = true;
                if (letters.includes('l')) login = true;
            }
            // -o/-O (and +o/+O) take the next word as their argument.
            if (/[oO]$/.test(letters)) index += 1;
            continue;
        }
        break;
    }
    const operands = argv.slice(index);
    const script = command ? String(operands[0] ?? '') : '';
    const positional = command ? operands.slice(1) : operands;
    // A login shell's profile rebuilds PATH after any injection: refuse it
    // when anything guarded is in its script or arguments; otherwise it runs.
    if (login) {
        const found = scanAnyGuarded([script, ...positional].join(' '));
        if (found) return { hit: found, argv };
    }
    if (!command) return { hit: null, argv };
    const found = lineHit(script, depth + 1) || scanPaths(script);
    if (found) return { hit: found, argv };
    // Positional parameters ($0 first) feed `"$@"`, `$1` and friends: analyse
    // them as a command when the script uses them, and refuse a guarded word.
    if (/\$(?:[@*]|[0-9])|\$\{[0-9@*]/.test(script)) {
        const args = positional.slice(1);
        for (const word of args) if (guardedWord(word)) return { hit: unquote(word), argv };
        if (args.length) {
            const nested = inspect(args[0], args.slice(1), depth + 1);
            if (nested.hit) return { hit: nested.hit, argv };
        }
    }
    return { hit: null, argv };
}

// Wrapper option parsing shared by the table-driven wrappers: leading
// options (with their arguments), then the wrapper's own positionals.
function splitWrapperArguments(base, argv) {
    const spec = WRAPPER_OPTIONS[base] || { args: [], positionals: 0 };
    let index = 0;
    let commandString = null;
    let positionals = spec.positionals;
    while (index < argv.length) {
        const word = argv[index];
        if (word === '--') { index += 1; break; }
        if (!/^-./.test(word)) break;
        if (spec.command?.includes(word)) { commandString = String(argv[index + 1] ?? ''); index += 2; continue; }
        if (spec.listFlags?.includes(word)) { positionals = 1; index += 2; continue; }
        const long = word.startsWith('--');
        const name = long ? word.split('=')[0] : word.slice(0, 2);
        if (spec.args.includes(name)) {
            index += (long ? word.includes('=') : word.length > 2) ? 1 : 2;
            continue;
        }
        // A flag, or a numeric option such as `nice -5` or `timeout -5s`.
        index += 1;
    }
    index += positionals;
    return { commandString, rest: argv.slice(index) };
}

function inspectWrapper(base, argv, depth) {
    const { commandString, rest } = splitWrapperArguments(base, argv);
    if (commandString !== null) {
        const hit = lineHit(commandString, depth + 1);
        if (hit) return { hit, argv };
    }
    if (!rest.length) return { hit: null, argv };
    const nested = inspect(rest[0], rest.slice(1), depth + 1);
    if (nested.hit) return { hit: nested.hit, argv };
    return { hit: null, argv: [...argv.slice(0, argv.length - rest.length), rest[0], ...nested.argv] };
}

// env: options, assignments, then the operand. PATH assignments are rewritten
// through the shadowing, an environment reset gets the guard environment back,
// and the operand is analysed as a new invocation.
function inspectEnv(argv, depth) {
    const options = [];
    const assignments = [];
    let clears = false;
    let unsetsPath = false;
    let split = null;
    let index = 0;
    for (; index < argv.length; index += 1) {
        const word = argv[index];
        if (word === '--') { options.push(word); index += 1; break; }
        if (word === '-' || word === '--ignore-environment') { clears = true; options.push(word); continue; }
        if (/^--(unset|chdir|split-string|default-signal|ignore-signal|block-signal|argv0)(=|$)/.test(word)) {
            const attached = word.includes('=') ? word.slice(word.indexOf('=') + 1) : null;
            options.push(word);
            let value = attached;
            if (attached === null) { index += 1; value = argv[index]; options.push(value); }
            if (/^--unset/.test(word) && lower(value ?? '') === 'path') unsetsPath = true;
            if (/^--split-string/.test(word)) split = value;
            continue;
        }
        if (/^--/.test(word)) { options.push(word); continue; }
        if (/^-[A-Za-z]/.test(word)) {
            // A cluster of flags; u, C, P and S take an argument (attached or next).
            options.push(word);
            for (let at = 1; at < word.length; at += 1) {
                const letter = word[at];
                if (letter === 'i') clears = true;
                if ('uCPS'.includes(letter)) {
                    const attached = word.slice(at + 1);
                    let value = attached;
                    if (!attached) { index += 1; value = argv[index]; options.push(value); }
                    if (letter === 'u' && lower(value ?? '') === 'path') unsetsPath = true;
                    if (letter === 'S') split = value;
                    break;
                }
            }
            continue;
        }
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) { assignments.push(word); continue; }
        break;
    }
    let operandArgv = argv.slice(index);
    if (split !== null) operandArgv = [...String(split).trim().split(/\s+/).filter(Boolean), ...operandArgv];
    // Words after `--` or from an `-S` string may themselves be assignments.
    while (operandArgv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(operandArgv[0])) assignments.push(operandArgv.shift());
    const nested = operandArgv.length ? inspect(operandArgv[0], operandArgv.slice(1), depth + 1) : { hit: null, argv: [] };
    if (nested.hit) return { hit: nested.hit, argv };
    let hasPath = false;
    const rewritten = assignments.map((assignment) => {
        if (!/^PATH=/.test(assignment)) return assignment;
        hasPath = true;
        return `PATH=${withGuardPath(assignment.slice(5))}`;
    });
    // Re-injected after every -i/-u so that nothing earlier can remove them.
    const guardEnvironment = [`NODE_OPTIONS=${withGuardOptions('')}`, `${TOP_LOG_ENV}=${topLog}`, `${ROOT_ENV}=${guardRoot}`, `${TEMP_ENV}=${temporaryRoot}`,
        ...(process.env[EXTRA_ENV] ? [`${EXTRA_ENV}=${process.env[EXTRA_ENV]}`] : [])];
    if (!hasPath && (clears || unsetsPath)) guardEnvironment.push(`PATH=${withGuardPath(DEFAULT_PATH, { all: true })}`);
    return { hit: null, argv: [...options, ...rewritten, ...guardEnvironment, ...(operandArgv.length ? [operandArgv[0], ...nested.argv] : [])] };
}

// The guarded program an invocation would run, or null (public form).
export function guardedProgramOf(name, args) {
    return analyzeCall(name, args).hit;
}

function analyzeCall(name, args) {
    const options = [args[1], args[2]].find((value) => value && typeof value === 'object' && !Array.isArray(value)) || {};
    analysedPath = options.env && options.env.PATH !== undefined ? String(options.env.PATH) : null;
    try { return analyzeCallWith(name, args, options); } finally { analysedPath = null; }
}

function analyzeCallWith(name, args, options) {
    const [first, second] = args;
    const argv = Array.isArray(second) ? second.filter((value) => typeof value === 'string') : [];
    if (name === 'fork') {
        const execPath = typeof options.execPath === 'string' && guardedWord(options.execPath) ? options.execPath : null;
        return { hit: execPath, args };
    }
    if (name === 'exec' || name === 'execSync' || options.shell) {
        if (typeof options.shell === 'string' && guardedWord(options.shell)) return { hit: options.shell, args };
        const line = [first, ...argv].filter((value) => typeof value === 'string').join(' ');
        return { hit: scanPaths(line) || lineHit(line, 0), args };
    }
    const program = typeof first === 'string' ? first : '';
    const result = inspect(program, argv, 0, { argv0: options.argv0 });
    if (result.hit || !Array.isArray(second)) return { hit: result.hit, args };
    const next = [...args];
    next[1] = result.argv;
    return { hit: null, args: next };
}

// --- refusal and the top-level ledger ---------------------------------------
function refuse(name, program) {
    const message = `[engine-spawn-guard] a unit test tried to run ${path.basename(String(program))} through child_process.${name}`;
    ownViolations.push(message);
    // At once, to the top-level ledger: a child killed by a signal still counts.
    try { fs.appendFileSync(topLog, `${message}\n`); } catch (_) {}
    try { process.stderr.write(`${message}\n`); } catch (_) {}
    process.exitCode = 1;
    return Object.assign(new Error(message), { code: 'PLOINKY_TEST_ENGINE_SPAWN' });
}

// A child given an explicit environment is still guarded: its PATH starts
// with the failing stubs (a missing PATH gets the stubs and the system
// directories) and a Node child loads this guard. A nested runner that imports
// the guard itself is an independent root with its own ledger and root.
function guardChildEnvironment(args) {
    const index = [1, 2].find((position) => args[position] && typeof args[position] === 'object' && !Array.isArray(args[position]));
    const options = index === undefined ? null : args[index];
    const argv = Array.isArray(args[1]) ? args[1] : [];
    const independent = [args[0], ...argv].some((value) => typeof value === 'string' && value.includes('engineSpawnGuard'));
    if (!options?.env && !independent) return args;
    const base = options?.env || process.env;
    const env = { ...base, NODE_OPTIONS: withGuardOptions(base.NODE_OPTIONS) };
    env.PATH = base.PATH !== undefined ? withGuardPath(base.PATH) : withGuardPath(DEFAULT_PATH, { all: true });
    if (independent) {
        delete env[TOP_LOG_ENV];
        delete env[ROOT_ENV];
        delete env[TEMP_ENV];
        if (!options?.env || options.env[EXTRA_ENV] === undefined) delete env[EXTRA_ENV];
    } else {
        env[TOP_LOG_ENV] = topLog;
        env[ROOT_ENV] = guardRoot;
        env[TEMP_ENV] = temporaryRoot;
        if (process.env[EXTRA_ENV]) env[EXTRA_ENV] = process.env[EXTRA_ENV];
    }
    const next = [...args];
    if (index === undefined) next.splice(Array.isArray(args[1]) ? 2 : 1, 0, { env });
    else next[index] = { ...options, env };
    return next;
}

for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    const original = childProcess[name];
    const check = (args) => {
        const { hit, args: rewritten } = analyzeCall(name, args);
        if (hit) throw refuse(name, hit);
        return guardChildEnvironment(rewritten);
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

// A worker thread has its own child_process module: it loads this guard too.
const OriginalWorker = workerThreads.Worker;
class GuardedWorker extends OriginalWorker {
    constructor(file, options = {}) {
        // A worker inherits `--import` from the NODE_OPTIONS of its environment
        // (injected below when the environment is explicit) and from the
        // inherited execArgv; only an explicit execArgv array needs the import.
        const execArgv = Array.isArray(options?.execArgv) && !options.execArgv.some((value) => String(value).includes(GUARD_URL))
            ? [...options.execArgv, `--import=${GUARD_URL}`] : options?.execArgv;
        const own = options?.env && options.env !== workerThreads.SHARE_ENV && typeof options.env === 'object' ? options.env : null;
        const env = own
            ? { ...own, NODE_OPTIONS: withGuardOptions(own.NODE_OPTIONS), PATH: own.PATH !== undefined ? withGuardPath(own.PATH) : withGuardPath(DEFAULT_PATH, { all: true }), [TOP_LOG_ENV]: topLog, [ROOT_ENV]: guardRoot, [TEMP_ENV]: temporaryRoot, ...(process.env[EXTRA_ENV] ? { [EXTRA_ENV]: process.env[EXTRA_ENV] } : {}) }
            : options?.env;
        // `--import` does not apply to an eval worker: its CommonJS code first
        // requires this guard (an ES module without top-level await).
        const source = options?.eval === true && typeof file === 'string' ? `require(${JSON.stringify(fileURLToPath(GUARD_URL))});\n${file}` : file;
        super(source, { ...(options || {}), ...(execArgv !== undefined ? { execArgv } : {}), ...(env !== undefined ? { env } : {}) });
    }
}
workerThreads.Worker = GuardedWorker;
syncBuiltinESMExports();

// --- exit and signals --------------------------------------------------------
function ledgerLines() {
    try { return fs.readFileSync(topLog, 'utf8').split('\n').filter(Boolean); } catch (_) { return [...ownViolations]; }
}
let cleaned = false;
function cleanup() {
    if (cleaned) return;
    cleaned = true;
    // A straggling descendant may still write into the root: retry the removal.
    try { fs.rmSync(isTop ? guardRoot : ownDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch (_) {}
}
// A refusal anywhere below the top-level process fails it, even when swallowed
// or when the process that made it was killed.
process.on('exit', () => {
    if ((isTop ? ledgerLines() : ownViolations).length) process.exitCode = 1;
    cleanup();
});
if (isTop) {
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
        process.once(signal, () => { cleanup(); process.kill(process.pid, signal); });
    }
}

export function engineSpawnViolations() { return ledgerLines(); }
