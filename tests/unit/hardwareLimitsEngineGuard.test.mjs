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
    try { await (async () => { ${body} })(); } catch (error) { marker = error?.code || ('status:' + error?.status) || 'error'; }
    fs.writeFileSync(path.join(MARKERS, ${JSON.stringify(id.replace(/[^A-Za-z0-9._-]/g, '_'))}), String(marker));
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
        return { result, marked, canaryRuns: canaryRuns() - before };
    }
    return { root, sentinelBin, sentinel, probe, canaryRuns };
}

function assertRefused(outcome, ids, label) {
    for (const id of ids) assert.equal(outcome.marked[id], REFUSED, `${label}: ${id} got the JS refusal`);
    assert.equal(outcome.result.verdict, 'FAIL', `${label}: the suite fails`);
    assert.equal(outcome.canaryRuns, 0, `${label}: the canary never ran`);
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
    assertRefused(await w.probe('wrapper-forms', forms), forms.map(([id]) => id), 'wrapper forms');
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

test('EG.login-shells-are-refused-with-a-guarded-word-and-run-otherwise', async (t) => {
    const w = world(t);
    const refused = [
        ['login shell hidden name', exec("'/bin/bash'", ['-lc', `x=${CANARY}; "$x" ps`], "{ stdio: 'pipe', env: { PATH: '/usr/bin:/bin' } }")],
        ['login shell via argv0', `cp.execFileSync('/bin/sh', ['-c', 'x=${CANARY}; "$x" ps'], { argv0: '-sh', stdio: 'pipe' });`],
        ['login shell positional', exec("'/bin/bash'", ['-lc', 'exec "$@"', 'bash', CANARY, 'ps'])],
    ];
    assertRefused(await w.probe('login-refused', refused), refused.map(([id]) => id), 'login shells');
    // A login shell without anything guarded runs: its PATH is rebuilt by its
    // profile, which the guard cannot shadow, and that is documented.
    const allowed = await w.probe('login-allowed', [
        ['unrelated login command', exec("'/bin/bash'", ['-lc', 'true'], "{ stdio: 'pipe', env: { PATH: '/usr/bin:/bin' } }")],
        ['unrelated login sh', exec("'/bin/sh'", ['-lc', 'echo ok'])],
    ]);
    assert.equal(allowed.marked['unrelated login command'], 'not-refused');
    assert.equal(allowed.marked['unrelated login sh'], 'not-refused');
    assert.equal(allowed.result.verdict, 'PASS');
    assert.equal(allowed.canaryRuns, 0);
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
const guardRoots = (directory) => fs.readdirSync(directory).filter((name) => name.startsWith('engine-guard-'));

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
