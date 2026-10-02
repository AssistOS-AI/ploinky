// The unit-test isolation guard (tests/helpers/engineSpawnGuard.mjs), form by
// form. Every probe runs as a suite through runSuite with the guard preloaded,
// exactly as the hardware-limits runner runs candidate suites.
//
// Test safety: no test here names podman, docker, ssh or scp, and none runs
// through a login shell with such a name. Every probe uses a CANARY: a program
// name that exists nowhere on any PATH, registered as guarded through the
// guard's test-only environment variable. A harmless sentinel with that name
// sits in a test directory on the probe's PATH and records an execution, so a
// guard failure shows up as a recorded canary run, never as a real program.
//
// Each refused form asserts all of: the probe received the guard's JS refusal
// code PLOINKY_TEST_ENGINE_SPAWN, the suite failed, and the sentinel ran zero
// times. (Asserting only the suite verdict lets the whole wrapper and
// propagation code be deleted unnoticed, because the PATH stubs alone fail it.)
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { runSuite } from '../hardware-limits/verify.mjs';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const GUARD = path.join(REPO, 'tests', 'helpers', 'engineSpawnGuard.mjs');
const CANARY = 'ploinky-guard-canary';
const REFUSED = 'PLOINKY_TEST_ENGINE_SPAWN';

function world(t) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hwl-eguard-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const sentinelBin = path.join(root, 'sentinel-bin'); fs.mkdirSync(sentinelBin);
    const ledger = path.join(root, 'canary.log');
    const sentinel = path.join(sentinelBin, CANARY);
    fs.writeFileSync(sentinel, `#!/bin/sh\necho "$0 $*" >> ${JSON.stringify(ledger)}\nexit 0\n`, { mode: 0o755 });
    const markers = path.join(root, 'markers'); fs.mkdirSync(markers);
    const suiteRoot = path.join(root, 'suite'); fs.mkdirSync(suiteRoot);
    const canaryRuns = () => (fs.existsSync(ledger) ? fs.readFileSync(ledger, 'utf8').split('\n').filter(Boolean).length : 0);
    // forms: [id, body]. A body runs inside an async function with cp, fs, os,
    // path, Worker, SENTINEL, SENTINEL_BIN, CANARY and ROOT in scope; what it
    // throws becomes the form's marker (the error's code, else its status).
    async function probe(name, forms, { extraEnv = {} } = {}) {
        const file = `${name}.test.mjs`;
        const tests = forms.map(([id, body]) => `test(${JSON.stringify(id)}, async () => {
    let marker = 'not-refused';
    let message = '';
    try { await (async () => { ${body} })(); } catch (error) { marker = error?.code || ('status:' + error?.status) || 'error'; message = String(error?.message || '').slice(0, 300); }
    fs.writeFileSync(path.join(MARKERS, ${JSON.stringify(id.replace(/[^A-Za-z0-9._-]/g, '_'))}), String(marker));
    fs.writeFileSync(path.join(MARKERS, ${JSON.stringify(id.replace(/[^A-Za-z0-9._-]/g, '_'))} + '.msg'), message);
});`).join('\n');
        fs.writeFileSync(path.join(suiteRoot, file), `import test from 'node:test';
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
const MARKERS = ${JSON.stringify(markers)};
const SENTINEL_BIN = ${JSON.stringify(sentinelBin)};
const SENTINEL = ${JSON.stringify(sentinel)};
const CANARY = ${JSON.stringify(CANARY)};
const ROOT = ${JSON.stringify(root)};
${tests}
`);
        const before = canaryRuns();
        const result = await runSuite({ root: suiteRoot, files: [file], runId: 'guard-run', childId: name, eventsPath: path.join(root, `${name}.jsonl`), preload: GUARD,
            extraEnv: { PATH: `${sentinelBin}:/usr/bin:/bin`, PLOINKY_ENGINE_GUARD_EXTRA_PROGRAMS: CANARY, ...extraEnv } });
        const marked = Object.fromEntries(forms.map(([id]) => {
            const target = path.join(markers, id.replace(/[^A-Za-z0-9._-]/g, '_'));
            return [id, fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : 'missing'];
        }));
        const messages = Object.fromEntries(forms.map(([id]) => {
            const target = path.join(markers, `${id.replace(/[^A-Za-z0-9._-]/g, '_')}.msg`);
            return [id, fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : ''];
        }));
        return { result, marked, messages, canaryRuns: canaryRuns() - before };
    }
    return { root, sentinelBin, sentinel, probe, canaryRuns };
}

function assertRefused(outcome, ids, label) {
    for (const id of ids) assert.equal(outcome.marked[id], REFUSED, `${label}: ${id} got the JS refusal`);
    assert.equal(outcome.result.verdict, 'FAIL', `${label}: the suite fails`);
    assert.equal(outcome.canaryRuns, 0, `${label}: the canary never ran`);
}

// The refusal names the program the guard stopped: every form of these tests
// must be stopped at the canary operand, never at a wrapper that merely shares
// a number-rounded inode with a real guarded binary.
function assertStoppedAt(outcome, ids, name, label) {
    for (const id of ids) assert.match(outcome.messages[id], new RegExp(`tried to run ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} through`), `${label}: ${id} was stopped at ${name}: ${outcome.messages[id]}`);
}

const exec = (command, args, options = '{ stdio: \'pipe\' }') => `cp.execFileSync(${command}, ${JSON.stringify(args)}, ${options});`;

test('EG.shell-option-clusters-and-script-forms-are-refused', async (t) => {
    const w = world(t);
    const forms = [
        ['sh -c', exec("'/bin/sh'", ['-c', `${CANARY} ps`])],
        ['bash -lc login', exec("'/bin/bash'", ['-lc', `${CANARY} ps`], "{ stdio: 'pipe', env: { PATH: '/usr/bin:/bin' } }")],
        ['sh -ec', exec("'/bin/sh'", ['-ec', `${CANARY} ps`])],
        ['sh -xc', exec("'/bin/sh'", ['-xc', `${CANARY} ps`])],
        ['bash --login -c', exec("'/bin/bash'", ['--login', '-c', `${CANARY} ps`])],
        ['sh -c --', exec("'/bin/sh'", ['-c', '--', `${CANARY} ps`])],
        ['bash -l -c', exec("'/bin/bash'", ['-l', '-c', `${CANARY} ps`])],
        ['sh -o posix -c', exec("'/bin/sh'", ['-o', 'posix', '-c', `${CANARY} ps`])],
        ['upper-case shell basename', exec("'/bin/SH'", ['-c', `${CANARY} ps`])],
        ['redirect before command', exec("'/bin/sh'", ['-c', `>/dev/null ${CANARY} ps`])],
        ['stdin redirect before command', exec("'/bin/sh'", ['-c', `</dev/null ${CANARY} ps`])],
        ['fd redirect before command', exec("'/bin/sh'", ['-c', `2>&1 ${CANARY} ps`])],
        ['eval', exec("'/bin/sh'", ['-c', `eval ${CANARY} ps`])],
        ['exec', exec("'/bin/sh'", ['-c', `exec ${CANARY} ps`])],
        ['exec -a', exec("'/bin/sh'", ['-c', `exec -a name ${CANARY} ps`])],
        ['command substitution', exec("'/bin/sh'", ['-c', `echo $(${CANARY} ps)`])],
        ['backticks', exec("'/bin/sh'", ['-c', `echo \`${CANARY} ps\``])],
        ['command -p', exec("'/bin/sh'", ['-c', `command -p ${CANARY} ps`])],
        ['assignment then command', exec("'/bin/sh'", ['-c', `X=1 ${CANARY} ps`])],
        ['wrapper inside a line', exec("'/bin/sh'", ['-c', `env X=1 nice -n 5 ${CANARY} ps`])],
        ['nested shell inside a line', exec("'/bin/sh'", ['-c', `sh -c '${CANARY} ps'`])],
        ['positional parameters', exec("'/bin/sh'", ['-c', 'exec "$@"', 'sh', CANARY, 'ps'])],
        ['exec string line', 'cp.execSync(CANARY + " ps", { stdio: \'pipe\' });'],
        ['spawn shell option', 'cp.spawnSync(CANARY + " ps", [], { shell: true, stdio: \'pipe\' });'],
    ];
    assertRefused(await w.probe('shell-forms', forms), forms.map(([id]) => id), 'shell forms');
    // Lookups run nothing and stay allowed.
    const lookups = await w.probe('lookups', [
        ['command -v', 'cp.execSync("command -v ' + CANARY + ' || true", { stdio: \'pipe\' });'],
        ['which in a shell', exec("'/bin/sh'", ['-c', `command -v ${CANARY}; true`])],
    ]);
    assert.equal(lookups.result.verdict, 'PASS', JSON.stringify(lookups.marked));
    assert.equal(lookups.canaryRuns, 0);
});

test('EG.wrapper-operands-are-analysed-as-invocations', async (t) => {
    const w = world(t);
    const forms = [
        ['env', exec("'/usr/bin/env'", [CANARY, 'ps'])],
        ['env -u NAME', exec("'/usr/bin/env'", ['-u', 'FOO', CANARY, 'ps'])],
        ['env -uNAME attached', exec("'/usr/bin/env'", ['-uFOO', CANARY, 'ps'])],
        ['env -P dir', exec("'/usr/bin/env'", ['-P', '/usr/bin', CANARY, 'ps'])],
        ['env -S string', exec("'/usr/bin/env'", ['-S', `${CANARY} ps`])],
        ['env -S with assignment', exec("'/usr/bin/env'", ['-S', `A=1 ${CANARY} ps`])],
        ['env -C dir', exec("'/usr/bin/env'", ['-C', '/', CANARY, 'ps'])],
        ['env -i', exec("'/usr/bin/env'", ['-i', CANARY, 'ps'])],
        ['env -', exec("'/usr/bin/env'", ['-', CANARY, 'ps'])],
        ['env --ignore-environment', exec("'/usr/bin/env'", ['--ignore-environment', CANARY, 'ps'])],
        ['env -- operand', exec("'/usr/bin/env'", ['--', CANARY, 'ps'])],
        ['env assignments', exec("'/usr/bin/env'", ['A=1', 'B=2', CANARY, 'ps'])],
        ['upper-case env basename', exec("'/usr/bin/ENV'", [CANARY, 'ps'])],
        ['env -i then shell', exec("'/usr/bin/env'", ['-i', 'PATH=/usr/bin:/bin', '/bin/sh', '-c', `${CANARY} ps`])],
        ['env then shell', exec("'/usr/bin/env'", ['PATH=/usr/bin:/bin', '/bin/sh', '-c', `${CANARY} ps`])],
        ['env -i then login shell', exec("'/usr/bin/env'", ['-i', 'PATH=/usr/bin:/bin', '/bin/bash', '-lc', `${CANARY} ps`])],
        ['nested wrappers', exec("'/usr/bin/env'", ['A=1', '/usr/bin/nice', '-n', '5', '/usr/bin/env', '-u', 'B', CANARY, 'ps'])],
        ['nice -n', exec("'/usr/bin/nice'", ['-n', '5', CANARY, 'ps'])],
        ['nohup', exec("'/usr/bin/nohup'", [CANARY, 'ps'])],
        ['xargs', exec("'/usr/bin/xargs'", [CANARY, 'ps'])],
        ['xargs -I {}', exec("'/usr/bin/xargs'", ['-I', '{}', CANARY, '{}'])],
        ['xargs -E x', exec("'/usr/bin/xargs'", ['-E', 'x', CANARY, 'ps'])],
        ['xargs -n 1', exec("'/usr/bin/xargs'", ['-n', '1', CANARY, 'ps'])],
        ['xargs -P 2', exec("'/usr/bin/xargs'", ['-P', '2', CANARY, 'ps'])],
        ['xargs -L 1', exec("'/usr/bin/xargs'", ['-L', '1', CANARY, 'ps'])],
        ['xargs -s 100', exec("'/usr/bin/xargs'", ['-s', '100', CANARY, 'ps'])],
        ['xargs -d comma', exec("'/usr/bin/xargs'", ['-d', ',', CANARY, 'ps'])],
        ['xargs attached -n1', exec("'/usr/bin/xargs'", ['-n1', CANARY, 'ps'])],
        ['timeout duration', exec("'/usr/bin/timeout'", ['-k', '5', '10', CANARY, 'ps'])],
        ['sudo -u user', exec("'/usr/bin/sudo'", ['-u', 'nobody', CANARY, 'ps'])],
        ['busybox applet', exec("'/bin/busybox'", ['sh', '-c', `${CANARY} ps`])],
        ['script -c', exec("'/usr/bin/script'", ['-q', '-c', `${CANARY} ps`, '/dev/null'])],
        ['flock', exec("'/usr/bin/flock'", ['-w', '1', '/tmp/lock', CANARY, 'ps'])],
    ];
    const outcome = await w.probe('wrapper-forms', forms);
    assertRefused(outcome, forms.map(([id]) => id), 'wrapper forms');
    // Including the sudo and script rows: refused at the canary operand. (A
    // login shell is refused as a login shell.)
    assertStoppedAt(outcome, forms.filter(([id]) => !/login shell/.test(id)).map(([id]) => id), CANARY, 'wrapper forms');
});

test('EG.absolute-guarded-paths-are-refused-wherever-they-appear', async (t) => {
    const w = world(t);
    const upper = path.join(w.sentinelBin, CANARY.toUpperCase());
    const forms = [
        ['eval /abs', exec("'/bin/sh'", ['-c', `eval ${w.sentinel} ps`])],
        ['argument position of echo', exec("'/bin/sh'", ['-c', `echo ${w.sentinel} ps`])],
        ['command substitution echo', exec("'/bin/sh'", ['-c', `$(echo ${w.sentinel}) ps`])],
        ['positional "$@" with /abs', exec("'/bin/sh'", ['-c', 'exec "$@"', 'sh', w.sentinel, 'ps'])],
        ['env -u NAME /abs', exec("'/usr/bin/env'", ['-u', 'FOO', w.sentinel, 'ps'])],
        ['assignment of an absolute path', exec("'/bin/sh'", ['-c', `X=${w.sentinel}; $X ps`])],
        ['wrapper argv absolute path', exec("'/usr/bin/nice'", ['-n', '5', w.sentinel, 'ps'])],
        ['upper-case basename (case-insensitive file systems)', exec("'/bin/sh'", ['-c', `${upper} ps`])],
        ['direct upper-case path', `cp.execFileSync(${JSON.stringify(upper)}, ['ps'], { stdio: 'pipe' });`],
        ['renamed symlink to the real binary', `const link = path.join(os.tmpdir(), 'renamed-tool'); fs.symlinkSync(SENTINEL, link); cp.execFileSync(link, ['ps'], { stdio: 'pipe' });`],
        ['renamed symlink through a shell', `const link = path.join(os.tmpdir(), 'renamed-tool-2'); fs.symlinkSync(SENTINEL, link); cp.execFileSync('/bin/sh', ['-c', link + ' ps'], { stdio: 'pipe' });`],
    ];
    assertRefused(await w.probe('absolute-forms', forms), forms.map(([id]) => id), 'absolute forms');
    // A test-owned fake under the test temporary directory is not a real
    // program: it stays allowed, in a shell line and through a wrapper.
    const fake = await w.probe('fakes', [
        ['fake executable', `const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-')); const fake = path.join(dir, CANARY); fs.writeFileSync(fake, '#!/bin/sh\\nexit 0\\n', { mode: 0o755 }); cp.execFileSync(fake, ['ps']); cp.execFileSync('/bin/sh', ['-c', fake + ' ps']); cp.execFileSync('/usr/bin/env', [fake, 'ps']);`],
    ]);
    assert.equal(fake.marked['fake executable'], 'not-refused');
    assert.equal(fake.result.verdict, 'PASS');
    assert.equal(fake.canaryRuns, 0);
});

// A fake runtime a test puts first on PATH is not a real program; a real one
// first on PATH still decides (the bare name is resolved like a shell would).
test('EG.a-bare-name-resolving-first-to-a-test-owned-fake-is-allowed', async (t) => {
    const w = world(t);
    const allowed = await w.probe('bare-fake', [
        ['fake first on an explicit PATH', `const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-bin-')); fs.writeFileSync(path.join(dir, CANARY), '#!/bin/sh\\nexit 0\\n', { mode: 0o755 }); cp.execFileSync(CANARY, ['ps'], { env: { PATH: dir + ':/usr/bin:/bin' }, stdio: 'pipe' });`],
        ['fake first on the process PATH, through a shell', `const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-bin-')); fs.writeFileSync(path.join(dir, CANARY), '#!/bin/sh\\nexit 0\\n', { mode: 0o755 }); const saved = process.env.PATH; process.env.PATH = dir + ':' + saved; try { cp.execFileSync('/bin/sh', ['-c', CANARY + ' ps'], { stdio: 'pipe' }); } finally { process.env.PATH = saved; }`],
    ]);
    assert.equal(allowed.marked['fake first on an explicit PATH'], 'not-refused');
    assert.equal(allowed.marked['fake first on the process PATH, through a shell'], 'not-refused');
    assert.equal(allowed.result.verdict, 'PASS', JSON.stringify(allowed.marked));
    assert.equal(allowed.canaryRuns, 0, 'only the fake ran');
    const refused = [
        ['real first, fake second', `const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-bin-')); fs.writeFileSync(path.join(dir, CANARY), '#!/bin/sh\\nexit 0\\n', { mode: 0o755 }); cp.execFileSync(CANARY, ['ps'], { env: { PATH: SENTINEL_BIN + ':' + dir }, stdio: 'pipe' });`],
        ['no fake at all', `cp.execFileSync(CANARY, ['ps'], { env: { PATH: '/usr/bin:/bin' }, stdio: 'pipe' });`],
    ];
    assertRefused(await w.probe('bare-real', refused), refused.map(([id]) => id), 'real first');
});

test('EG.option-forms-shell-string-and-fork-exec-path', async (t) => {
    const w = world(t);
    const forms = [
        ['shell option as a string path', `cp.spawnSync('echo hi', [], { shell: ${JSON.stringify(w.sentinel)}, stdio: 'pipe' });`],
        ['shell option string with a guarded line', `cp.execSync(${JSON.stringify(`${CANARY} ps`)}, { shell: '/bin/sh', stdio: 'pipe' });`],
        ['fork execPath', `cp.fork('/dev/null', [], { execPath: SENTINEL, silent: true });`],
        ['exec with options', `cp.exec(${JSON.stringify(`${CANARY} ps`)}, { cwd: '/' }, () => {});`],
        ['execFile with callback and shell', `cp.execFile(CANARY, ['ps'], { shell: true }, () => {});`],
    ];
    assertRefused(await w.probe('option-forms', forms), forms.map(([id]) => id), 'option forms');
});

// A login shell's profile rebuilds PATH after any injection and can run
// anything, so it is refused outright: with a guarded word, without one, with
// a script file, through argv0 and behind a wrapper.
test('EG.login-shells-are-refused-outright', async (t) => {
    const w = world(t);
    const script = path.join(w.root, 'run-canary.sh');
    fs.writeFileSync(script, `#!/bin/sh\n${CANARY} ps\n`, { mode: 0o755 });
    const forms = [
        ['login shell hidden name', exec("'/bin/bash'", ['-lc', `x=${CANARY}; "$x" ps`], "{ stdio: 'pipe', env: { PATH: '/usr/bin:/bin' } }")],
        ['login shell via argv0', `cp.execFileSync('/bin/sh', ['-c', 'x=${CANARY}; "$x" ps'], { argv0: '-sh', stdio: 'pipe' });`],
        ['login shell positional', exec("'/bin/bash'", ['-lc', 'exec "$@"', 'bash', CANARY, 'ps'])],
        ['login shell --login -c', exec("'/bin/bash'", ['--login', '-c', `${CANARY} ps`])],
        ['login shell -l -c', exec("'/bin/bash'", ['-l', '-c', 'true'])],
        ['login shell cluster -xlc', exec("'/bin/sh'", ['-xlc', 'true'])],
        // C1: the login profile prepends a directory and a script file runs the canary indirectly.
        ['login shell running a script file', exec("'/bin/bash'", ['-lc', script])],
        ['login shell with nothing guarded', exec("'/bin/bash'", ['-lc', 'true'], "{ stdio: 'pipe', env: { PATH: '/usr/bin:/bin' } }")],
        ['login sh with nothing guarded', exec("'/bin/sh'", ['-lc', 'echo ok'])],
        ['env then login shell', exec("'/usr/bin/env'", ['A=1', '/bin/bash', '-lc', 'true'])],
        ['login shell in a shell line', exec("'/bin/sh'", ['-c', "bash -lc 'echo ok'"])],
        // Login forms without -l: zsh's login option, and a dash-prefixed argv[0] through exec.
        ['zsh -o login', exec("'/bin/zsh'", ['-o', 'login', '-c', 'true'])],
        ['zsh -o login after other options', exec("'/bin/zsh'", ['-f', '-o', 'login', '-c', 'true'])],
        ['exec -a -bash in a shell line', exec("'/bin/sh'", ['-c', "exec -a -bash bash -c 'true'"])],
        ['exec -l in a shell line', exec("'/bin/sh'", ['-c', "exec -l bash -c 'true'"])],
        ['exec -a -sh in a shell line', exec("'/bin/sh'", ['-c', "exec -a -sh /bin/sh -c 'true'"])],
        ['exec -a -bash as a wrapper', exec("'/usr/bin/env'", ['A=1', '/bin/sh', '-c', "exec -a -bash bash -c 'echo ok'"])],
    ];
    const outcome = await w.probe('login-refused', forms);
    assertRefused(outcome, forms.map(([id]) => id), 'login shells');
    for (const [id] of forms) assert.match(outcome.messages[id], /\(login shell\)|tried to run /, id);
    // Non-login shells with nothing guarded still run.
    const allowed = await w.probe('login-allowed', [
        ['plain shell', exec("'/bin/sh'", ['-c', 'echo ok'])],
        ['plain bash', exec("'/bin/bash'", ['-c', 'true'], "{ stdio: 'pipe', env: { PATH: '/usr/bin:/bin' } }")],
        ['exec with a plain argv0', exec("'/bin/sh'", ['-c', "exec -a renamed sh -c 'echo ok'"])],
        ['exec without options', exec("'/bin/sh'", ['-c', 'exec echo ok'])],
    ]);
    for (const id of ['plain shell', 'plain bash', 'exec with a plain argv0', 'exec without options']) assert.equal(allowed.marked[id], 'not-refused', `${id}: ${allowed.messages[id]}`);
    assert.equal(allowed.result.verdict, 'PASS');
    assert.equal(allowed.canaryRuns, 0);
});

// A test file that runs a real login shell on purpose opts in; the shell is then
// judged by name alone.
test('EG.an-opted-in-login-shell-is-judged-by-name-alone', async (t) => {
    const w = world(t);
    const optIn = { PLOINKY_ENGINE_GUARD_ALLOW_LOGIN_SHELLS: '1' };
    const withFake = (body) => `const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-bin-')); fs.writeFileSync(path.join(dir, CANARY), '#!/bin/sh\\nexit 0\\n', { mode: 0o755 }); const env = { ...process.env, PATH: dir + ':' + SENTINEL_BIN + ':/usr/bin:/bin' }; ${body}`;
    const allowed = await w.probe('login-opt-in-allowed', [
        ['login shell with nothing guarded', exec("'/bin/sh'", ['-lc', 'echo ok'])],
        ['login bash with nothing guarded', exec("'/bin/bash'", ['-lc', 'true'], "{ stdio: 'pipe', env: { PATH: '/usr/bin:/bin' } }")],
    ], { extraEnv: optIn });
    for (const id of ['login shell with nothing guarded', 'login bash with nothing guarded']) assert.equal(allowed.marked[id], 'not-refused', `${id}: ${allowed.messages[id]}`);
    assert.equal(allowed.result.verdict, 'PASS');
    const forms = [
        ['guarded name in the script', exec("'/bin/sh'", ['-lc', `${CANARY} ps`])],
        ['hidden name with a guarded word', exec("'/bin/bash'", ['-lc', `x=${CANARY}; "$x" ps`], "{ stdio: 'pipe', env: { PATH: '/usr/bin:/bin' } }")],
        ['guarded word in an argument', exec("'/bin/bash'", ['-lc', 'exec "$@"', 'bash', CANARY, 'ps'])],
        ['a fake first on the caller PATH grants nothing', withFake(`cp.execFileSync('/bin/bash', ['-lc', ${JSON.stringify(`${CANARY} ps`)}], { stdio: 'pipe', env });`)],
        ['guarded absolute path in the script', exec("'/bin/sh'", ['-lc', `${w.sentinel} ps`])],
    ];
    const refused = await w.probe('login-opt-in-refused', forms, { extraEnv: optIn });
    assertRefused(refused, forms.map(([id]) => id), 'opted-in login shells');
    // Without the opt-in the same harmless shell is refused.
    const off = await w.probe('login-opt-out', [['login shell with nothing guarded', exec("'/bin/sh'", ['-lc', 'echo ok'])]]);
    assertRefused(off, ['login shell with nothing guarded'], 'login shell without the opt-in');
});

// A guarded path that is only mentioned inside a longer argument (a script given
// to an interpreter, a JSON document) is data, not a command operand.
test('EG.a-guarded-path-inside-a-longer-argument-is-not-a-command-for-an-unlisted-program', async (t) => {
    const w = world(t);
    const allowed = await w.probe('embedded-data', [
        ['path inside a node script', exec("process.execPath", ['--input-type=module', '-e', `const descriptor = { source: ${JSON.stringify(w.sentinel)}, destination: '/usr/bin/${CANARY}' }; void descriptor;`])],
        ['path inside a JSON argument', exec("'/usr/bin/true'", ['--json', `{"tool":"/usr/bin/${CANARY}"}`])],
    ]);
    for (const id of ['path inside a node script', 'path inside a JSON argument']) assert.equal(allowed.marked[id], 'not-refused', `${id}: ${allowed.messages[id]}`);
    assert.equal(allowed.result.verdict, 'PASS');
    assert.equal(allowed.canaryRuns, 0);
    // An argument that IS the path is an operand and is refused; so is an embedded path for a launcher.
    const refused = [
        ['operand that is the path', exec("'/usr/bin/true'", [w.sentinel, 'ps'])],
        ['launcher with an embedded path', exec("'/usr/bin/caffeinate'", ['-i', `x ${w.sentinel}`])],
    ];
    assertRefused(await w.probe('embedded-operands', refused), refused.map(([id]) => id), 'operands');
});

// A fake runtime first on the caller's PATH grants nothing once the invocation
// replaces that PATH: the name is judged by the PATH the command really
// resolves through, or by name alone when that PATH is not knowable.
test('EG.a-fake-on-the-callers-path-grants-nothing-when-the-invocation-replaces-the-path', async (t) => {
    const w = world(t);
    const withFake = (body) => `const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-bin-')); fs.writeFileSync(path.join(dir, CANARY), '#!/bin/sh\\nexit 0\\n', { mode: 0o755 }); const env = { ...process.env, PATH: dir + ':' + SENTINEL_BIN + ':/usr/bin:/bin' }; ${body}`;
    const run = (command, args) => withFake(`cp.execFileSync(${JSON.stringify(command)}, ${JSON.stringify(args)}, { stdio: 'pipe', env });`);
    const runWithDir = (command, build) => withFake(`cp.execFileSync(${JSON.stringify(command)}, (${build})(dir), { stdio: 'pipe', env });`);
    const forms = [
        // A1: a login shell is refused whatever the caller's PATH holds.
        ['A1 login shell with a fake first', run('/bin/bash', ['-lc', `${CANARY} ps`])],
        // B1: an inline PATH replaces the caller's.
        ['B1 inline PATH to the real directory', run('/bin/sh', ['-c', `PATH=${w.sentinelBin} ${CANARY} ps`])],
        ['standalone assignment', run('/bin/sh', ['-c', `PATH=${w.sentinelBin}; ${CANARY} ps`])],
        ['export', run('/bin/sh', ['-c', `export PATH=${w.sentinelBin}; ${CANARY} ps`])],
        ['assignment in an earlier segment', run('/bin/sh', ['-c', `PATH=${w.sentinelBin} && ${CANARY} ps`])],
        ['assignment before a pipe', run('/bin/sh', ['-c', `PATH=${w.sentinelBin}; true | ${CANARY} ps`])],
        ['assignment inside eval', run('/bin/sh', ['-c', `eval 'PATH=${w.sentinelBin} ${CANARY} ps'`])],
        ['assignment from another variable', run('/bin/sh', ['-c', `PATH=$HOME/nowhere ${CANARY} ps`])],
        ['assignment from a command substitution', run('/bin/sh', ['-c', `PATH=$(echo ${w.sentinelBin}) ${CANARY} ps`])],
        ['nested shell keeps the assignment', run('/bin/sh', ['-c', `PATH=${w.sentinelBin}; sh -c '${CANARY} ps'`])],
        ['env assigns a real directory', run('/usr/bin/env', [`PATH=${w.sentinelBin}`, CANARY, 'ps'])],
        ['env -i resets the PATH', run('/usr/bin/env', ['-i', CANARY, 'ps'])],
        ['env -u PATH', run('/usr/bin/env', ['-u', 'PATH', CANARY, 'ps'])],
        ['env assigns a PATH that does not hold the fake', run('/usr/bin/env', ['PATH=/usr/bin:/bin', '/bin/sh', '-c', `${CANARY} ps`])],
    ];
    const outcome = await w.probe('fake-path-replaced', forms);
    assertRefused(outcome, forms.map(([id]) => id), 'a replaced PATH');
    assertStoppedAt(outcome, forms.filter(([id]) => !id.startsWith('A1')).map(([id]) => id), CANARY, 'a replaced PATH');
    // Controls: nothing replaces the fake's directory, so the fake is allowed.
    const allowed = await w.probe('fake-path-kept', [
        ['no replacement', run('/bin/sh', ['-c', `${CANARY} ps`])],
        ['PATH keeps $PATH', run('/bin/sh', ['-c', `PATH="$PATH:/usr/sbin" ${CANARY} ps`])],
        ['export keeps the fake directory', runWithDir('/bin/sh', "(dir) => ['-c', 'export PATH=' + dir + ':/usr/bin:/bin; ' + CANARY + ' ps']")],
        ['env assigns a PATH that keeps the fake', runWithDir('/usr/bin/env', "(dir) => ['PATH=' + dir + ':/usr/bin:/bin', CANARY, 'ps']")],
    ]);
    for (const id of ['no replacement', 'PATH keeps $PATH', 'export keeps the fake directory', 'env assigns a PATH that keeps the fake']) {
        assert.equal(allowed.marked[id], 'not-refused', `${id}: ${allowed.messages[id]}`);
    }
    assert.equal(allowed.result.verdict, 'PASS', JSON.stringify(allowed.marked));
    assert.equal(allowed.canaryRuns, 0, 'only the fake ran');
});

// Programs outside the wrapper table still run commands named in their argv
// (sandbox-exec, caffeinate, arch, bwrap, unshare, su), and the production
// seatbelt and bwrap shapes end in `sh -lc`.
test('EG.unlisted-wrappers-launchers-and-embedded-shells-are-analysed', async (t) => {
    const w = world(t);
    const sandboxProfile = '(version 1)(allow default)';
    const forms = [
        // D1: an absolute guarded path as an operand of an unlisted wrapper.
        ['D1 caffeinate with an absolute path', exec("'/usr/bin/caffeinate'", ['-i', w.sentinel, 'ps'])],
        ['caffeinate with a bare name', exec("'/usr/bin/caffeinate'", ['-i', CANARY, 'ps'])],
        ['arch with a bare name', exec("'/usr/bin/arch'", ['-arm64', CANARY, 'ps'])],
        ['bwrap with a bare name', exec("'bwrap'", ['--bind', '/', '/', CANARY, 'ps'])],
        ['unshare with a bare name', exec("'/usr/bin/unshare'", ['-m', CANARY, 'ps'])],
        ['su -c', exec("'/usr/bin/su'", ['-c', `${CANARY} ps`, 'nobody'])],
        ['unlisted program with an absolute guarded path', exec("'/usr/bin/true'", ['--', w.sentinel, 'ps'])],
        ['unlisted program with an embedded shell', exec("'/usr/bin/true'", ['sh', '-c', `${CANARY} ps`])],
        ['unlisted program with an embedded nested shell', exec("'/usr/bin/true'", ['--flag', '/bin/sh', '-c', `cd /tmp && ${CANARY} ps`])],
        // E: sandbox-exec running a shell, login and not.
        ['E0 sandbox-exec sh -c', exec("'/usr/bin/sandbox-exec'", ['-p', sandboxProfile, '/bin/sh', '-c', `${CANARY} ps`])],
        ['E1 sandbox-exec sh -lc', exec("'/usr/bin/sandbox-exec'", ['-p', sandboxProfile, '/bin/sh', '-lc', `cd /tmp && ${CANARY} ps`])],
        ['E2 bare sandbox-exec sh -lc (production shape)', exec("'sandbox-exec'", ['-p', sandboxProfile, 'sh', '-lc', `cd /tmp && ${CANARY} ps`])],
        // The production seatbelt shape: sandbox-exec -f PROFILE sh -lc "cd 'WD' && COMMAND".
        ['seatbelt shape with a login shell', exec("'sandbox-exec'", ['-f', '/tmp/profile.sb', 'sh', '-lc', `cd '/tmp' && ${CANARY} ps`])],
        ['seatbelt shape without the login flag', exec("'sandbox-exec'", ['-f', '/tmp/profile.sb', 'sh', '-c', `cd '/tmp' && ${CANARY} ps`])],
        // The production bwrap shape: bwrap ...ARGS -- sh -lc COMMAND.
        ['bwrap shape with a login shell', exec("'bwrap'", ['--unshare-all', '--bind', '/', '/', '--', 'sh', '-lc', `${CANARY} ps`])],
        ['bwrap shape without the login flag', exec("'bwrap'", ['--unshare-all', '--bind', '/', '/', '--', 'sh', '-c', `${CANARY} ps`])],
        ['bwrap shape with a hidden name', exec("'bwrap'", ['--bind', '/', '/', '--', 'sh', '-c', 'x=' + CANARY + '; "$x" ps'])],
    ];
    const outcome = await w.probe('unlisted-forms', forms);
    for (const [id] of forms) {
        // A hidden name is stopped by the PATH stubs (status 97) or by the JS refusal; nothing may run the sentinel.
        assert.ok([REFUSED, 'status:97'].includes(outcome.marked[id]), `${id}: ${outcome.marked[id]} ${outcome.messages[id]}`);
    }
    assert.equal(outcome.result.verdict, 'FAIL');
    assert.equal(outcome.canaryRuns, 0, 'the canary never ran');
    // Everything but the hidden name is refused by the JS layer.
    for (const [id] of forms.filter(([form]) => !form.includes('hidden'))) assert.equal(outcome.marked[id], REFUSED, id);
    // Benign shapes of unlisted programs are not refused.
    const allowed = await w.probe('unlisted-allowed', [
        ['unlisted program with benign operands', exec("'/usr/bin/true'", ['--flag', 'sh', 'value'])],
        ['unlisted program with an embedded benign shell', exec("'/usr/bin/true'", ['sh', '-c', 'echo ok'])],
        ['unlisted program naming a guarded word as data', exec("'/usr/bin/true'", ['--grep', CANARY])],
    ]);
    for (const id of ['unlisted program with benign operands', 'unlisted program with an embedded benign shell', 'unlisted program naming a guarded word as data']) {
        assert.equal(allowed.marked[id], 'not-refused', `${id}: ${allowed.messages[id]}`);
    }
    assert.equal(allowed.result.verdict, 'PASS');
});

// The guard's seatbelt and bwrap forms are the shapes production builds: pin
// them, so a change of either shape reaches this test.
test('EG.the-seatbelt-and-bwrap-shapes-the-guard-analyses-are-the-production-shapes', () => {
    const seatbelt = fs.readFileSync(path.join(REPO, 'cli', 'sandbox', 'seatbelt', 'seatbeltServiceManager.js'), 'utf8');
    assert.match(seatbelt, /spawnSync\('sandbox-exec', \['-f', profilePath, 'sh', '-lc', `cd '\$\{wd\}' && \$\{rewrittenCmd\}`\]/);
    const bwrap = fs.readFileSync(path.join(REPO, 'cli', 'sandbox', 'bwrap', 'bwrapServiceManager.js'), 'utf8');
    assert.match(bwrap, /bwrapArgs\.push\('--', 'sh', '-lc', shellCommand\)/);
});

// Absolute system binaries are not the real guarded binaries: on macOS, where
// inodes exceed 2^53, a Number key made 113 of them collide with ssh or scp.
test('EG.system-binaries-are-not-refused-by-a-number-rounded-inode', async (t) => {
    const w = world(t);
    const forms = [
        ['FP1 absolute sed', exec("'/usr/bin/sed'", ['-n', '1p', '/etc/hosts'])],
        ['FP2 absolute printf in a shell', exec("'/bin/sh'", ['-c', '/usr/bin/printf ok'])],
        ['FP0 absolute env true', exec("'/usr/bin/env'", ['true'])],
        ['absolute cat in a shell line', exec("'/bin/sh'", ['-c', 'echo x | /bin/cat'])],
    ];
    const outcome = await w.probe('system-binaries', forms);
    for (const [id] of forms) assert.equal(outcome.marked[id], 'not-refused', `${id}: ${outcome.messages[id]}`);
    assert.equal(outcome.result.verdict, 'PASS', JSON.stringify(outcome.marked));
    assert.equal(outcome.canaryRuns, 0);
});

// The brief's four bypasses and the no-PATH variant: each must fail its suite
// with the JS refusal and zero canary executions.
test('EG.environment-resets-and-explicit-environments-are-refused', async (t) => {
    const w = world(t);
    const sentinelPath = `${w.sentinelBin}:/usr/bin:/bin`;
    const forms = [
        ['env -i PATH= sh -c', exec("'/usr/bin/env'", ['-i', `PATH=${sentinelPath}`, '/bin/sh', '-c', `${CANARY} ps`])],
        ['env PATH= sh -c (no -i)', exec("'/usr/bin/env'", [`PATH=${sentinelPath}`, '/bin/sh', '-c', `${CANARY} ps`])],
        ['bash -lc with explicit PATH', exec("'/bin/bash'", ['-lc', `${CANARY} ps`], `{ stdio: 'pipe', env: { PATH: ${JSON.stringify(sentinelPath)} } }`)],
        ['sh -c PATH=dir canary with empty env', exec("'/bin/sh'", ['-c', `PATH=${w.sentinelBin} ${CANARY} ps`], '{ stdio: \'pipe\', env: {} }')],
        ['env -i sh -c with no PATH', exec("'/usr/bin/env'", ['-i', '/bin/sh', '-c', `${CANARY} ps`])],
        ['env -u PATH sh -c', exec("'/usr/bin/env'", ['-u', 'PATH', '/bin/sh', '-c', `${CANARY} ps`])],
    ];
    assertRefused(await w.probe('reset-forms', forms), forms.map(([id]) => id), 'environment resets');
});

// A name the guard cannot see (a shell variable) is stopped by the PATH layer:
// the stubs come first on every PATH the guard can shadow, including a PATH
// rewritten in a wrapper's argv, one an environment reset rebuilds and one a
// child did not have at all. The stub exits 97 and records the native run in
// the ledger; the sentinel never runs.
test('EG.hidden-names-reach-the-path-stubs-through-every-environment-rewrite', async (t) => {
    const w = world(t);
    const sentinelPath = `${w.sentinelBin}:/usr/bin:/bin`;
    const hidden = `x=${CANARY}; $x ps`;
    const forms = [
        ['plain shell', exec("'/bin/sh'", ['-c', hidden])],
        ['env PATH= assignment rewritten', exec("'/usr/bin/env'", [`PATH=${sentinelPath}`, '/bin/sh', '-c', hidden])],
        ['env -i PATH= rewritten', exec("'/usr/bin/env'", ['-i', `PATH=${sentinelPath}`, '/bin/sh', '-c', hidden])],
        ['env -i without PATH', exec("'/usr/bin/env'", ['-i', '/bin/sh', '-c', hidden])],
        ['env -u PATH', exec("'/usr/bin/env'", ['-u', 'PATH', '/bin/sh', '-c', hidden])],
        ['explicit env without PATH', exec("'/bin/sh'", ['-c', hidden], '{ stdio: \'pipe\', env: { HOME: os.tmpdir() } }')],
        ['explicit env with the sentinel PATH', exec("'/bin/sh'", ['-c', hidden], `{ stdio: 'pipe', env: { PATH: ${JSON.stringify(sentinelPath)} } }`)],
    ];
    const outcome = await w.probe('hidden-forms', forms);
    for (const [id] of forms) assert.equal(outcome.marked[id], 'status:97', `${id}: the failing stub answered`);
    assert.equal(outcome.result.verdict, 'FAIL', 'a native stub run fails the suite through the ledger');
    assert.equal(outcome.canaryRuns, 0, 'the sentinel never ran');
});

test('EG.descendants-and-worker-threads-are-guarded-through-an-explicit-environment', async (t) => {
    const w = world(t);
    fs.writeFileSync(path.join(w.root, 'worker.mjs'), `import cp from 'node:child_process';
import fs from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
let marker = 'not-refused';
try { cp.execFileSync(workerData.canary, ['ps'], { stdio: 'pipe' }); } catch (error) { marker = error?.code || ('status:' + error?.status); }
fs.writeFileSync(workerData.marker, String(marker));
parentPort.postMessage('done');
`);
    const childCode = `const cp = require('node:child_process'); const fs = require('node:fs'); let marker = 'not-refused'; try { cp.execFileSync(${JSON.stringify(CANARY)}, ['ps'], { stdio: 'pipe' }); } catch (error) { marker = error?.code || ('status:' + error?.status); } fs.writeFileSync(process.argv[1], marker);`;
    const forms = [
        // A Node child with an explicit environment that has neither NODE_OPTIONS nor the ledger.
        ['node child with explicit env', `const marker = path.join(ROOT, 'child-marker-1'); cp.spawnSync(process.execPath, ['-e', ${JSON.stringify(childCode)}, marker], { env: { PATH: SENTINEL_BIN + ':/usr/bin:/bin' } }); if (fs.readFileSync(marker, 'utf8') !== '${REFUSED}') throw Object.assign(new Error('child not guarded'), { code: 'child:' + fs.readFileSync(marker, 'utf8') }); throw Object.assign(new Error('child refused'), { code: '${REFUSED}' });`],
        // A Node child that inherits the environment.
        ['node child inheriting env', `const marker = path.join(ROOT, 'child-marker-2'); cp.spawnSync(process.execPath, ['-e', ${JSON.stringify(childCode)}, marker]); if (fs.readFileSync(marker, 'utf8') !== '${REFUSED}') throw Object.assign(new Error('child not guarded'), { code: 'child:' + fs.readFileSync(marker, 'utf8') }); throw Object.assign(new Error('child refused'), { code: '${REFUSED}' });`],
        // A worker thread with an explicit environment and no inherited execArgv.
        ['worker file with explicit env and empty execArgv', `const marker = path.join(ROOT, 'worker-marker-1'); await new Promise((resolve, reject) => { const w = new Worker(path.join(ROOT, 'worker.mjs'), { env: { PATH: SENTINEL_BIN + ':/usr/bin:/bin' }, execArgv: [], workerData: { canary: CANARY, marker } }); w.once('message', resolve); w.once('error', reject); }); const seen = fs.readFileSync(marker, 'utf8'); throw Object.assign(new Error('worker saw ' + seen), { code: seen === '${REFUSED}' ? '${REFUSED}' : 'worker:' + seen });`],
        ['eval worker', `const marker = path.join(ROOT, 'worker-marker-2'); await new Promise((resolve, reject) => { const w = new Worker(${JSON.stringify(`const cp = require('node:child_process'); const fs = require('node:fs'); const { parentPort, workerData } = require('node:worker_threads'); let marker = 'not-refused'; try { cp.execFileSync(workerData.canary, ['ps'], { stdio: 'pipe' }); } catch (error) { marker = error?.code || ('status:' + error?.status); } fs.writeFileSync(workerData.marker, String(marker)); parentPort.postMessage('done');`)}, { eval: true, env: { PATH: SENTINEL_BIN + ':/usr/bin:/bin' }, workerData: { canary: CANARY, marker } }); w.once('message', resolve); w.once('error', reject); }); const seen = fs.readFileSync(marker, 'utf8'); throw Object.assign(new Error('worker saw ' + seen), { code: seen === '${REFUSED}' ? '${REFUSED}' : 'worker:' + seen });`],
    ];
    const outcome = await w.probe('descendant-forms', forms);
    for (const [id] of forms) assert.equal(outcome.marked[id], REFUSED, `${id}: the descendant was guarded in JS`);
    assert.equal(outcome.canaryRuns, 0);
    assert.equal(outcome.result.verdict, 'FAIL', 'the descendants\' refusals fail the suite');
});

// An eval worker whose source uses module syntax is evaluated as an ES module,
// where `require` does not exist: the guard imports itself first instead.
test('EG.an-eval-worker-with-module-syntax-is-guarded', async (t) => {
    const w = world(t);
    const header = `import cp from 'node:child_process';
import fs from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
let marker = 'not-refused';
try { cp.execFileSync(workerData.canary, ['ps'], { stdio: 'pipe' }); } catch (error) { marker = error?.code || ('status:' + error?.status); }
fs.writeFileSync(workerData.marker, String(marker));
`;
    const modules = {
        'eval worker with import statements': `${header}parentPort.postMessage('done');`,
        'eval worker with import statements and top-level await': `${header}const later = await Promise.resolve('module');\nparentPort.postMessage(later);`,
    };
    const forms = Object.entries(modules).map(([id, code], index) => [id, `const marker = path.join(ROOT, 'esm-worker-marker-${index}');
await new Promise((resolve, reject) => { const w = new Worker(${JSON.stringify(code)}, { eval: true, env: { PATH: SENTINEL_BIN + ':/usr/bin:/bin' }, execArgv: [], workerData: { canary: CANARY, marker } }); w.once('message', resolve); w.once('error', reject); w.once('exit', resolve); });
throw Object.assign(new Error('worker finished'), { code: fs.readFileSync(marker, 'utf8') });`]);
    const outcome = await w.probe('esm-worker', forms);
    for (const [id] of forms) assert.equal(outcome.marked[id], REFUSED, `${id}: the worker's own guard refused the canary (${outcome.messages[id]})`);
    assert.equal(outcome.canaryRuns, 0);
});

test('EG.a-violating-child-killed-by-a-signal-still-fails-the-top-level-suite', async (t) => {
    const w = world(t);
    const code = `const cp = require('node:child_process'); try { cp.execFileSync(${JSON.stringify(CANARY)}, ['ps'], { stdio: 'pipe' }); } catch (_) {} process.kill(process.pid, 'SIGKILL');`;
    const outcome = await w.probe('ledger-forms', [
        ['child refused then SIGKILL', `const result = cp.spawnSync(process.execPath, ['-e', ${JSON.stringify(code)}]); if (result.signal !== 'SIGKILL') throw new Error('child was not killed: ' + result.status);`],
        ['grandchild with explicit env refused then SIGKILL', `const result = cp.spawnSync(process.execPath, ['-e', ${JSON.stringify(code)}], { env: { PATH: SENTINEL_BIN + ':/usr/bin:/bin' } }); if (result.signal !== 'SIGKILL') throw new Error('child was not killed: ' + result.status);`],
    ]);
    // The probes themselves caught nothing (no error): the failure is the ledger's.
    assert.equal(outcome.marked['child refused then SIGKILL'], 'not-refused');
    assert.equal(outcome.marked['grandchild with explicit env refused then SIGKILL'], 'not-refused');
    assert.equal(outcome.result.verdict, 'FAIL', 'the killed child\'s violation reached the top-level ledger');
    assert.equal(outcome.canaryRuns, 0);
});

// One temporary root per top-level guarded process: removed on exit and on
// SIGTERM, and every descendant's directories live inside it.
async function runGuardedTop({ tmp, program, signal = null, waitFor = null, env = {} }) {
    const child = spawn(process.execPath, ['--import', GUARD, '-e', program], { env: { PATH: process.env.PATH, HOME: tmp, TMPDIR: tmp, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let stdout = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    const closed = new Promise((resolve) => child.once('close', (code, sig) => resolve({ code, signal: sig })));
    if (waitFor) {
        const deadline = Date.now() + 15000;
        while (!waitFor(stdout) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
        assert.ok(waitFor(stdout), `the guarded process reached its checkpoint: ${stderr}`);
    }
    if (signal) child.kill(signal);
    return { ...(await closed), stderr };
}
// The same, but the top-level process starts with NO NODE_OPTIONS and no
// inherited ledger: the test process is itself guarded, and its guard injects
// NODE_OPTIONS into every child it starts, which would hide the top-level
// guard's own propagation. A shell removes the injected variables before it
// execs the Node top-level with `--import` on its command line only.
async function runBareGuardedTop({ tmp, program, env = {} }) {
    const script = 'unset NODE_OPTIONS PLOINKY_ENGINE_GUARD_TOP_LOG PLOINKY_ENGINE_GUARD_ROOT PLOINKY_ENGINE_GUARD_TEMP; exec "$HWL_NODE" --import "$HWL_GUARD" -e "$HWL_PROGRAM"';
    const child = spawn('/bin/sh', ['-c', script], { env: { PATH: process.env.PATH, HOME: tmp, TMPDIR: tmp, HWL_NODE: process.execPath, HWL_GUARD: GUARD, HWL_PROGRAM: program, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdout.resume();
    const closed = await new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
    return { ...closed, stderr };
}
const guardRoots = (directory) => fs.readdirSync(directory).filter((name) => name.startsWith('engine-guard-'));

// A Node child loads the guard through NODE_OPTIONS: a top-level process started
// with `--import` on its command line only passes that on by setting the
// variable in its own environment (inherited by a child that is given none) and
// by re-injecting it after `env -i` / `env -u`. The child runs an ABSOLUTE
// canary path, which no PATH stub can stop: only the guard in the child can.
test('EG.a-node-child-is-guarded-through-the-inherited-environment-and-after-env-i', async (t) => {
    const w = world(t);
    const tmp = path.join(w.root, 'nodeopts-tmp'); fs.mkdirSync(tmp);
    // The canary's absolute path is read from a file inside the child: written
    // in the child's argv it would be refused in the PARENT, which is the
    // conservative scan doing its job, not the child guard under test.
    const target = path.join(w.root, 'canary-target'); fs.writeFileSync(target, w.sentinel);
    const childCode = `const cp = require('node:child_process'); const fs = require('node:fs'); let m = 'not-refused'; try { cp.execFileSync(fs.readFileSync(process.argv[2], 'utf8'), ['ps'], { stdio: 'pipe' }); } catch (error) { m = error?.code || ('status:' + error?.status); } fs.writeFileSync(process.argv[1], m);`;
    const markers = { inherited: path.join(w.root, 'inherited-marker'), envI: path.join(w.root, 'env-i-marker'), envU: path.join(w.root, 'env-u-marker') };
    const program = `const cp = require('node:child_process');
cp.spawnSync(process.execPath, ['-e', ${JSON.stringify(childCode)}, ${JSON.stringify(markers.inherited)}, ${JSON.stringify(target)}]);
cp.spawnSync('/usr/bin/env', ['-i', 'PATH=/usr/bin:/bin', process.execPath, '-e', ${JSON.stringify(childCode)}, ${JSON.stringify(markers.envI)}, ${JSON.stringify(target)}]);
cp.spawnSync('/usr/bin/env', ['-u', 'NODE_OPTIONS', process.execPath, '-e', ${JSON.stringify(childCode)}, ${JSON.stringify(markers.envU)}, ${JSON.stringify(target)}]);`;
    const result = await runBareGuardedTop({ tmp, program, env: { PATH: `${w.sentinelBin}:/usr/bin:/bin`, PLOINKY_ENGINE_GUARD_EXTRA_PROGRAMS: CANARY } });
    const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 'missing');
    assert.equal(read(markers.inherited), REFUSED, `a child with the inherited environment is guarded: ${result.stderr}`);
    assert.equal(read(markers.envI), REFUSED, 'a child after env -i is guarded');
    assert.equal(read(markers.envU), REFUSED, 'a child after env -u NODE_OPTIONS is guarded');
    assert.equal(w.canaryRuns(), 0, 'the canary never ran');
    assert.notEqual(result.code, 0, 'the refusals fail the top-level process through the ledger');
});

test('EG.the-top-level-removes-its-temporary-root-on-exit-and-on-sigterm', async (t) => {
    const w = world(t);
    const exited = path.join(w.root, 'exit-tmp'); fs.mkdirSync(exited);
    const normal = await runGuardedTop({ tmp: exited, program: 'process.exit(0)' });
    assert.equal(normal.code, 0, normal.stderr);
    assert.deepEqual(guardRoots(exited), [], 'a normal exit leaves no root');
    const killed = path.join(w.root, 'term-tmp'); fs.mkdirSync(killed);
    const result = await runGuardedTop({ tmp: killed, program: 'console.log("ready"); setInterval(() => {}, 1000)', signal: 'SIGTERM', waitFor: (out) => out.includes('ready') && guardRoots(killed).length > 0 });
    assert.equal(result.signal, 'SIGTERM', 'the signal is re-raised after the cleanup');
    assert.deepEqual(guardRoots(killed), [], 'a SIGTERM leaves no root');
});

// A root whose owner died without its exit event is removed by the next
// top-level guard in the same temporary directory; a root of a live owner, one
// that names no owner and any other directory are left alone.
test('EG.a-root-left-by-a-dead-owner-is-removed-by-the-next-top-level-guard', async (t) => {
    const w = world(t);
    const tmp = path.join(w.root, 'sweep-tmp'); fs.mkdirSync(tmp);
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    const deadPid = String(dead.stdout);
    const make = (name, owner) => { const dir = path.join(tmp, name); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'violations.log'), 'x\n'); if (owner !== null) fs.writeFileSync(path.join(dir, 'owner.pid'), owner); return dir; };
    const staleDead = make('engine-guard-deadOwner1', deadPid);
    const liveOwner = make('engine-guard-liveOwner1', String(process.pid));
    const noOwner = make('engine-guard-noOwner0001', null);
    const garbage = make('engine-guard-garbage001', 'not-a-pid');
    const other = path.join(tmp, 'unrelated-directory'); fs.mkdirSync(other);
    const result = await runGuardedTop({ tmp, program: 'process.exit(0)' });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(fs.existsSync(staleDead), false, 'the dead owner\'s root is removed');
    for (const kept of [liveOwner, noOwner, garbage, other]) assert.equal(fs.existsSync(kept), true, `${path.basename(kept)} is left alone`);
});

test('EG.a-sigkilled-descendant-with-an-explicit-env-leaves-nothing-behind', async (t) => {
    const w = world(t);
    const tmp = path.join(w.root, 'top-tmp'); fs.mkdirSync(tmp);
    const info = path.join(w.root, 'child-info.json');
    // The child has an explicit environment without TMPDIR: it must not fall
    // back to /tmp, but create its directories inside the top-level root.
    const childCode = `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(info)}, JSON.stringify({ root: process.env.PLOINKY_ENGINE_GUARD_ROOT, firstPath: process.env.PATH.split(':')[0], tmpdir: require('node:os').tmpdir() })); setInterval(() => {}, 1000);`;
    const program = `const cp = require('node:child_process'); const fs = require('node:fs');
const child = cp.spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], { env: { PATH: process.env.PATH }, stdio: 'ignore' });
const wait = setInterval(() => { if (fs.existsSync(${JSON.stringify(info)})) { clearInterval(wait); child.kill('SIGKILL'); child.once('exit', () => process.exit(0)); } }, 25);`;
    // The canary is on the PATH the child is given, so a stub directory exists.
    const result = await runGuardedTop({ tmp, program, env: { PATH: `${w.sentinelBin}:/usr/bin:/bin`, PLOINKY_ENGINE_GUARD_EXTRA_PROGRAMS: CANARY } });
    assert.equal(result.code, 0, result.stderr);
    const seen = JSON.parse(fs.readFileSync(info, 'utf8'));
    assert.ok(seen.root.startsWith(`${fs.realpathSync(tmp)}${path.sep}engine-guard-`), `the child inherited the top-level root: ${seen.root}`);
    assert.ok(seen.firstPath.startsWith(seen.root), `the child's first PATH entry is a stub directory inside it: ${seen.firstPath}`);
    assert.deepEqual(guardRoots(tmp), [], 'the SIGKILLed child left nothing behind');
});
