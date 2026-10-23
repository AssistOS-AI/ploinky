import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Two real processes, one per Ploinky source writer, update the same checkout
// concurrently: the host writer (`updateHostPloinkySource`) and the direct-core
// self-update (`updatePloinkySelf` outside a Box). Both must serialize on the
// same physical source lock and never hold it at the same time.

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const moduleUrl = rel => pathToFileURL(path.join(projectRoot, rel)).href;

function runChild(script, env) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('close', code => resolve({ code, stdout, stderr }));
    });
}

const LOGGING_MANAGER = String.raw`
function loggingManager(real, who) {
    const log = event => fs.appendFileSync(process.env.LOCK_EVENTS, JSON.stringify({ who, t: Date.now(), ...event }) + '\n');
    return {
        async acquireAt(lockPath, identity) {
            const lock = await real.acquireAt(lockPath, identity);
            log({ event: 'acquired', identity, lockPath });
            return {
                ...lock,
                assertHeld: value => lock.assertHeld(value),
                release() {
                    log({ event: 'releasing', identity });
                    lock.release();
                },
            };
        },
    };
}
`;

test('host and direct-core Ploinky source writers never overlap on the same checkout', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-source-lock-'));
    try {
        const home = path.join(scratch, 'home');
        const bin = path.join(scratch, 'bin');
        fs.mkdirSync(home);
        fs.mkdirSync(bin);
        const globalConfig = path.join(scratch, 'gitconfig');
        fs.writeFileSync(globalConfig, '[user]\n\tname = Ploinky Test\n\temail = test@example.invalid\n[init]\n\tdefaultBranch = main\n');
        const env = {
            ...process.env,
            HOME: home,
            GIT_CONFIG_GLOBAL: globalConfig,
            GIT_CONFIG_NOSYSTEM: '1',
            LOCK_EVENTS: path.join(scratch, 'lock-events.log'),
            PLOINKY_WORKSPACE_ROOT: scratch,
            PLOINKY_ROOT: path.join(scratch, 'runtime-root'),
        };
        for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[name];
        const git = (cwd, ...args) => String(execFileSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8' })).trim();
        const remote = path.join(scratch, 'remote.git');
        const seed = path.join(scratch, 'seed');
        const checkout = path.join(scratch, 'checkout');
        execFileSync('git', ['init', '-q', '--bare', remote], { env });
        fs.mkdirSync(seed);
        git(seed, 'init', '-q', '-b', 'main');
        fs.writeFileSync(path.join(seed, 'version.txt'), 'one\n');
        git(seed, 'add', '.');
        git(seed, 'commit', '-q', '-m', 'one');
        git(seed, 'remote', 'add', 'origin', remote);
        git(seed, 'push', '-q', '-u', 'origin', 'main');
        execFileSync('git', ['clone', '-q', remote, checkout], { env });
        fs.writeFileSync(path.join(seed, 'version.txt'), 'two\n');
        git(seed, 'commit', '-q', '-am', 'two');
        git(seed, 'push', '-q');
        const upstream = git(seed, 'rev-parse', 'HEAD');

        // Widen each critical section: every fetch takes at least 700 ms.
        const realGit = String(execFileSync('which', ['git'], { encoding: 'utf8' })).trim();
        fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nfor arg in "$@"; do if [ "$arg" = fetch ]; then sleep 0.7; fi; done\nexec "${realGit}" "$@"\n`);
        fs.chmodSync(path.join(bin, 'git'), 0o755);
        env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
        const notABox = path.join(scratch, 'not-a-box');

        const hostScript = String.raw`
            import fs from 'node:fs';
            const { updateHostPloinkySource } = await import(${JSON.stringify(moduleUrl('ploinky-box/command/hostUpdate.mjs'))});
            const { createMutationLockManager } = await import(${JSON.stringify(moduleUrl('ploinky-box/locks.mjs'))});
            ${LOGGING_MANAGER}
            const real = createMutationLockManager();
            const result = await updateHostPloinkySource({
                repositoryRoot: ${JSON.stringify(checkout)},
                updateScopeRoot: ${JSON.stringify(checkout)},
                lockManager: loggingManager(real, 'host'),
                boxMarkerPath: ${JSON.stringify(notABox)},
            });
            process.stdout.write('RESULT:' + JSON.stringify({ updated: result.updated, outcome: result.record.outcome }) + '\n');
        `;
        const coreScript = String.raw`
            import fs from 'node:fs';
            const { updatePloinkySelf } = await import(${JSON.stringify(moduleUrl('cli/commands/updateService.js'))});
            const { createDefaultSourceLockManager } = await import(${JSON.stringify(moduleUrl('cli/utils/git/sourceLock.js'))});
            ${LOGGING_MANAGER}
            const real = await createDefaultSourceLockManager();
            const result = await updatePloinkySelf({
                repoPath: ${JSON.stringify(checkout)},
                sourceLockManager: loggingManager(real, 'core'),
                boxMarkerPath: ${JSON.stringify(notABox)},
                logger: { warn() {} },
            });
            process.stdout.write('RESULT:' + JSON.stringify({ updated: result.updated, outcome: result.record.outcome }) + '\n');
        `;

        const [host, core] = await Promise.all([runChild(hostScript, env), runChild(coreScript, env)]);
        assert.equal(host.code, 0, host.stderr);
        assert.equal(core.code, 0, core.stderr);
        const parse = run => JSON.parse(run.stdout.split('\n').find(line => line.startsWith('RESULT:')).slice('RESULT:'.length));
        const hostResult = parse(host);
        const coreResult = parse(core);

        assert.deepEqual([hostResult.outcome, coreResult.outcome].sort(), ['changed', 'unchanged'],
            'exactly one writer advanced the checkout; the other verified it current');
        assert.equal(git(checkout, 'rev-parse', 'HEAD'), upstream);

        const events = fs.readFileSync(env.LOCK_EVENTS, 'utf8').trim().split('\n').map(line => JSON.parse(line));
        assert.equal(new Set(events.map(event => event.identity)).size, 1, 'both writers use the same lock name');
        const lockPaths = new Set(events.filter(event => event.event === 'acquired').map(event => event.lockPath));
        const sourceLock = path.join(fs.realpathSync(checkout), '.git', 'ploinky-source.lock');
        assert.deepEqual([...lockPaths], [sourceLock], 'both writers use the lock in the checkout git directory');
        assert.equal(fs.existsSync(sourceLock), false, 'the source lock was released');
        assert.equal(fs.existsSync(path.join(home, '.ploinky-box')), false, 'nothing is written under the home directory');
        const interval = who => {
            const acquired = events.find(event => event.who === who && event.event === 'acquired');
            const releasing = events.find(event => event.who === who && event.event === 'releasing');
            assert.ok(acquired && releasing, `${who} acquired and released the source lock`);
            return [acquired.t, releasing.t];
        };
        const [hostStart, hostEnd] = interval('host');
        const [coreStart, coreEnd] = interval('core');
        assert.ok(hostEnd <= coreStart || coreEnd <= hostStart,
            `source lock intervals overlap: host ${hostStart}-${hostEnd}, core ${coreStart}-${coreEnd}`);
        assert.ok(hostEnd - hostStart >= 600 && coreEnd - coreStart >= 600, 'each writer held the lock across its fetch');
    } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
    }
});

test('source lock acquisition retries only transient ownerless observations, within a bound', async () => {
    const { acquireSourceLock } = await import('../../cli/utils/git/sourceLock.js');
    const wrapped = Object.assign(new Error('Unable to read mutation lock owner'), {
        code: 'PLOINKY_BOX_LOCK_FAILED',
        cause: Object.assign(new Error('owner.json missing'), { code: 'ENOENT' }),
    });
    const raw = Object.assign(new Error('lock directory vanished'), { code: 'ENOENT' });
    const unrelated = Object.assign(new Error('Mutation lock identity does not match'), { code: 'PLOINKY_BOX_LOCK_FAILED' });
    const lock = { assertHeld() {}, release() {} };

    const source = { canonicalRoot: '/checkout', lockIdentity: 'ploinky-box-source-0123456789ab' };
    const resolveLockPath = root => `${root}/.git/ploinky-source.lock`;
    const sequence = [wrapped, raw, lock];
    let calls = 0;
    const acquired = await acquireSourceLock({
        async acquireAt(lockPath, label) {
            assert.equal(lockPath, '/checkout/.git/ploinky-source.lock');
            assert.equal(label, source.lockIdentity);
            const next = sequence[calls++];
            if (next instanceof Error) throw next;
            return next;
        },
    }, source, { transientRetryMs: 1, resolveLockPath });
    assert.equal(acquired, lock);
    assert.equal(calls, 3, 'both transient shapes were retried');

    let unrelatedCalls = 0;
    await assert.rejects(() => acquireSourceLock({
        async acquireAt() {
            unrelatedCalls += 1;
            throw unrelated;
        },
    }, source, { transientRetryMs: 1, resolveLockPath }), error => error === unrelated);
    assert.equal(unrelatedCalls, 1, 'an unrelated lock failure propagates immediately');

    let now = 0;
    let boundedCalls = 0;
    await assert.rejects(() => acquireSourceLock({
        async acquireAt() {
            boundedCalls += 1;
            throw wrapped;
        },
    }, source, {
        transientRetryMs: 1,
        transientTimeoutMs: 100,
        now: () => now,
        delay: async ms => { now += 40; },
        resolveLockPath,
    }), error => error === wrapped);
    assert.equal(boundedCalls, 4, 'a persistently ownerless lock fails once the bound is reached');
});

test('the source lock lives in the per-worktree git directory of a linked worktree', async () => {
    const { ploinkySourceLockPath, resolveCheckoutGitDirectory } = await import('../../cli/utils/git/sourceLock.js');
    const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-source-gitdir-')));
    try {
        const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(scratch, 'gitconfig') };
        for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[name];
        fs.writeFileSync(env.GIT_CONFIG_GLOBAL, '[user]\n\tname = Ploinky Test\n\temail = test@example.invalid\n');
        const main = path.join(scratch, 'main');
        const linked = path.join(scratch, 'linked');
        execFileSync('git', ['init', '-q', '-b', 'main', main], { env });
        fs.writeFileSync(path.join(main, 'file'), 'x\n');
        execFileSync('git', ['-C', main, 'add', '.'], { env });
        execFileSync('git', ['-C', main, 'commit', '-q', '-m', 'one'], { env });
        execFileSync('git', ['-C', main, 'worktree', 'add', '-q', '-b', 'side', linked], { env });

        assert.equal(ploinkySourceLockPath(main), path.join(main, '.git', 'ploinky-source.lock'));
        const perWorktree = String(execFileSync('git', ['-C', linked, 'rev-parse', '--absolute-git-dir'], { env, encoding: 'utf8' })).trim();
        assert.equal(resolveCheckoutGitDirectory(linked), fs.realpathSync(perWorktree));
        assert.equal(ploinkySourceLockPath(linked), path.join(fs.realpathSync(perWorktree), 'ploinky-source.lock'));
        assert.notEqual(ploinkySourceLockPath(linked), ploinkySourceLockPath(main), 'each worktree has its own source lock');

        const plain = path.join(scratch, 'plain');
        fs.mkdirSync(plain);
        assert.throws(() => resolveCheckoutGitDirectory(plain), { code: 'PLOINKY_SOURCE_LOCK_PATH_INVALID' });
        fs.writeFileSync(path.join(plain, '.git'), 'not a gitdir line\n');
        assert.throws(() => resolveCheckoutGitDirectory(plain), { code: 'PLOINKY_SOURCE_LOCK_PATH_INVALID' });
    } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
    }
});

test('a relative gitdir line resolves against the checkout, not the current directory', async () => {
    const { ploinkySourceLockPath } = await import('../../cli/utils/git/sourceLock.js');
    const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-source-relative-')));
    try {
        // Submodule layout: <super>/.git/modules/ploinky holds the git directory.
        const checkout = path.join(scratch, 'super', 'ploinky');
        const gitDirectory = path.join(scratch, 'super', '.git', 'modules', 'ploinky');
        fs.mkdirSync(checkout, { recursive: true });
        fs.mkdirSync(gitDirectory, { recursive: true });
        fs.writeFileSync(path.join(checkout, '.git'), 'gitdir: ../.git/modules/ploinky\n');
        assert.notEqual(process.cwd(), checkout);
        assert.equal(ploinkySourceLockPath(checkout), path.join(gitDirectory, 'ploinky-source.lock'));
    } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
    }
});
