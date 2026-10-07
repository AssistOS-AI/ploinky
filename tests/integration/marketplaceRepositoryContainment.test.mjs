import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createMarketplaceRepositoryRunner } from '../../cli/server/marketplaceRepositoryWorker.mjs';
import { createRepositoryProcessObserver } from '../../cli/server/marketplaceRepositoryProcessGroup.mjs';

// Run only in the explicitly selected disposable Linux container, with this
// candidate mounted read-only outside /tmp and container engines unavailable.
// Missing kernel prerequisites fail the check rather than producing a skip.
async function fixture(t, orphan = false) {
    assert.equal(process.platform, 'linux');
    await fs.access('/usr/bin/bwrap');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'repository-contained-'));
    const workspace = path.join(root, 'workspace');
    const origin = path.join(root, 'origin');
    const bin = path.join(root, 'bin');
    await Promise.all([fs.mkdir(workspace), fs.mkdir(origin), fs.mkdir(bin)]);
    const git = (...args) => {
        const result = spawnSync('/usr/bin/git', args, { cwd: origin, encoding: 'utf8',
            env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
                GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } });
        assert.equal(result.status, 0, result.stderr);
    };
    git('init', '-b', 'main');
    await fs.writeFile(path.join(origin, 'fixture.txt'), 'contained clone\n');
    git('add', 'fixture.txt'); git('commit', '-m', 'Fixture');
    // The exact workspace bind must survive private /tmp. The clone source is
    // intentionally inside that bind too, not hidden by the private tmpfs.
    const source = path.join(workspace, 'source');
    await fs.cp(origin, source, { recursive: true });
    const marker = path.join(workspace, 'orphan_codex.json');
    const orphanScript = path.join(workspace, 'orphan_codex.mjs');
    await fs.writeFile(orphanScript, `import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ namespace: fs.readlinkSync('/proc/self/ns/pid') }));
setTimeout(() => {}, 60000);
`);
    const wrapper = path.join(workspace, 'git');
    const gitReady = path.join(workspace, 'git_ready_codex.json');
    await fs.writeFile(wrapper, `#!${process.execPath}
const fs = require('node:fs');
const { spawn, spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const result = spawnSync('/usr/bin/git', args, { stdio: 'inherit' });
if (${orphan} && args.includes('clone') && result.status === 0) {
    const child = spawn(process.execPath, [${JSON.stringify(orphanScript)}], { detached: true, stdio: 'ignore', env: {} });
    child.unref();
}
if (args.includes('clone')) {
    const stat = fs.readFileSync('/proc/self/stat', 'utf8');
    const identity = { pid: process.pid, birth: stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\\s+/)[19],
        namespace: fs.readlinkSync('/proc/self/ns/pid'), operationId: process.env.PLOINKY_MARKETPLACE_REPOSITORY_OPERATION };
    fs.writeFileSync(${JSON.stringify(gitReady)}, JSON.stringify(identity));
    const release = ${JSON.stringify(workspace)} + '/git_release_' + identity.operationId + '_codex';
    const until = Date.now() + 750;
    const timer = setInterval(() => {
        if (fs.existsSync(release) || Date.now() >= until) { clearInterval(timer); process.exitCode = result.status ?? 1; }
    }, 5);
} else process.exitCode = result.status ?? 1;
`, { mode: 0o755 });
    const previousPath = process.env.PATH;
    process.env.PATH = `${workspace}:/usr/local/bin:/usr/bin:/bin`;
    const real = createRepositoryProcessObserver();
    const claims = new Map();
    let coordinatedExits = 0;
    const observer = { ...real, async scan(options) {
        if (options?.coordinator) {
            // Observe actual supervisor frames solely to coordinate our own
            // Git wrapper's lifetime. Ownership data is never replaced.
            const deadline = Date.now() + 700;
            while (Date.now() < deadline) {
                let ready;
                try { ready = JSON.parse(await fs.readFile(gitReady, 'utf8')); }
                catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
                if (ready?.operationId === options.operationId && claims.get(options.operationId)?.some(record =>
                    record.pid === ready.pid && record.birth === ready.birth && record.namespace === ready.namespace)) {
                    await fs.writeFile(path.join(workspace, `git_release_${options.operationId}_codex`), 'release');
                    for (;;) {
                        try { await fs.access(`/proc/${ready.pid}/stat`); }
                        catch (error) {
                            if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error;
                            coordinatedExits += 1;
                            return real.scan(options);
                        }
                        assert.ok(Date.now() < deadline, 'controlled Git wrapper must actually disappear within the original census budget');
                        await new Promise(resolve => setTimeout(resolve, 5));
                    }
                }
                await new Promise(resolve => setTimeout(resolve, 5));
            }
        }
        return real.scan(options);
    } };
    const runner = createMarketplaceRepositoryRunner({ observer, diagnosticSink: () => {}, spawnProcess(...args) {
        const child = spawn(...args);
        child.on('message', frame => { if (frame?.type === 'cohort') claims.set(frame.operationId, frame.members); });
        return child;
    } });
    let authorizations = 0;
    t.after(async () => {
        await runner.shutdown();
        t.diagnostic(JSON.stringify({ firstCause: runner.diagnostics().firstCause, snapshot: runner.snapshot(), coordinatedExits }));
        if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
        await fs.rm(root, { recursive: true, force: true });
    });
    const run = name => runner.run({ operation: { action: 'install_repo', url: source, name, branch: 'main' },
        rawBodyBytes: 128, cwd: workspace, workspaceRoot: workspace, authorize: async () => {
            const lock = JSON.parse(await fs.readFile(path.join(workspace, '.ploinky', 'running', 'workspace-start.json'), 'utf8'));
            const owner = await real.read(lock.ownerPid, { executable: true });
            assert.notEqual(lock.ownerPid, process.pid, 'a separate outer supervisor owns the lease');
            assert.equal(owner.namespace, await fs.readlink('/proc/self/ns/pid'));
            assert.equal(lock.ownerIdentity.startIdentity, `linux-proc:${owner.birth}`);
            assert.equal(lock.requireQuiescenceOnOwnerDeath, true);
            assert.ok(owner.argv[1].endsWith('/marketplaceRepositorySupervisor.mjs'));
            authorizations += 1;
            return true;
        } });
    return { runner, workspace, run, marker, source, authorizations: () => authorizations };
}

test('production contained clone settles short Git children without recovery and advances the queue', async t => {
    const f = await fixture(t);
    const first = f.run('first');
    const second = f.run('second');
    first.catch(() => {}); second.catch(() => {});
    assert.equal((await first).installed, true);
    assert.equal((await second).installed, true);
    assert.equal(await fs.readFile(path.join(f.workspace, '.ploinky', 'repos', 'first', 'fixture.txt'), 'utf8'), 'contained clone\n');
    assert.equal(f.runner.snapshot().recoveryDebt, false);
    assert.equal(f.runner.snapshot().active, false);
    assert.equal(f.runner.diagnostics().firstCause, null);
    assert.equal(f.authorizations(), 2);
});

test('production contained clone refuses a detached markerless orphan, retains recovery and does not advance queued work', async t => {
    const f = await fixture(t, true);
    const first = f.run('with-orphan');
    const second = f.run('must-not-start');
    first.catch(() => {}); second.catch(() => {});
    await assert.rejects(first, { code: 'PLOINKY_MARKETPLACE_REPOSITORY_RECOVERY_REQUIRED' });
    await assert.rejects(second, { code: 'PLOINKY_MARKETPLACE_REPOSITORY_RECOVERY_REQUIRED' });
    const marker = JSON.parse(await fs.readFile(f.marker, 'utf8'));
    assert.match(marker.namespace, /^pid:\[\d+\]$/);
    assert.equal(f.runner.diagnostics().firstCause.predicate, 'namespace-writer');
    assert.equal(f.runner.snapshot().recoveryDebt, true);
    await assert.rejects(fs.access(path.join(f.workspace, '.ploinky', 'repos', 'must-not-start')));
    const survivors = [];
    for (const name of await fs.readdir('/proc')) if (/^[1-9][0-9]*$/.test(name)) {
        try { if (await fs.readlink(`/proc/${name}/ns/pid`) === marker.namespace) survivors.push(name); }
        catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
    }
    assert.deepEqual(survivors, [], 'bounded cleanup terminates only the independently verified namespace');
    assert.equal(f.authorizations(), 1);
});

async function directUnit(t, fixture, options = {}) {
    const { createRepositoryInstallUnit } = await import('../../cli/server/marketplaceRepositoryInstallUnit.mjs');
    const { createRepositoryNamespaceObserver } = await import('../../cli/server/marketplaceRepositoryNamespace.mjs');
    const operationId = randomUUID();
    const outer = createRepositoryProcessObserver();
    const coordinator = await outer.read(process.pid);
    const unit = createRepositoryInstallUnit({ operationId, cwd: fixture.workspace, workspaceRoot: fixture.workspace, ...options });
    let handle;
    t.after(async () => { await handle?.signal('SIGKILL'); unit.close(); await handle?.close(); });
    const hint = await unit.ready;
    handle = await createRepositoryNamespaceObserver({ outer }).attest({ ...hint, coordinator, operationId,
        cwd: fixture.workspace, workspaceRoot: fixture.workspace });
    return { unit, handle, hint };
}

test('native inert bootstrap ignores loader injection and preserves source/workspace mount permissions', async t => {
    const f = await fixture(t);
    const canary = path.join(f.workspace, 'preload_canary_codex');
    const preload = path.join(f.workspace, 'preload_codex.cjs');
    await fs.writeFile(preload, `require('node:fs').writeFileSync(${JSON.stringify(canary)}, 'unexpected');\n`);
    const previous = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = `--require=${preload}`;
    let prepared;
    try { prepared = await directUnit(t, f); }
    finally { if (previous === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previous; }
    await assert.rejects(fs.access(canary));
    const mounts = (await fs.readFile(`/proc/${prepared.hint.initPid}/mountinfo`, 'utf8')).split('\n')
        .filter(Boolean).map(line => line.split(' '));
    const optionsFor = async mount => {
        const handle = await fs.open(`/proc/${prepared.hint.initPid}/root${mount}`, 'r');
        try {
            // mountinfo can contain covered mounts at the same path. Bind the
            // assertion to the actual opened view's mount ID, not its first row.
            const fdinfo = await fs.readFile(`/proc/self/fdinfo/${handle.fd}`, 'utf8');
            const id = fdinfo.match(/^mnt_id:\s*([0-9]+)$/m)?.[1];
            assert.ok(id, 'opened mount has a kernel mount identity');
            return mounts.find(fields => fields[0] === id)?.[5].split(',');
        } finally { await handle.close(); }
    };
    assert.ok((await optionsFor('/opt/ploinky'))?.includes('ro'), 'candidate source remains read-only');
    assert.ok((await optionsFor(f.workspace))?.includes('rw'), 'only the selected workspace bind becomes writable');
    assert.ok((await optionsFor('/tmp'))?.includes('rw'), 'private temporary storage exists before workspace bind');
    assert.notEqual((await fs.stat(`/proc/${prepared.hint.initPid}/root/tmp`)).dev, (await fs.stat('/tmp')).dev,
        'the writable temporary filesystem is private');
    await prepared.handle.proveBarrier();
    await prepared.unit.release();
    await prepared.handle.proveTerminated();
    await assert.rejects(fs.access(canary));
});

test('native monitor exit with surviving orphan cannot satisfy synchronization or termination proof', async t => {
    const f = await fixture(t, true);
    let monitorExited = false;
    const prepared = await directUnit(t, f, { spawnProcess(...args) {
        const child = spawn(...args); child.once('exit', () => { monitorExited = true; }); return child;
    } });
    const result = await prepared.unit.run({ action: 'install_repo', url: f.source, name: 'primitive-orphan', branch: 'main' }, process.env);
    assert.equal(result.ok, true);
    await assert.rejects(prepared.handle.proveBarrier());
    let synchronized = false;
    // This primitive-only probe deliberately exits the helper despite the
    // failed barrier. The production Router never grants that release.
    const release = prepared.unit.release().then(() => { synchronized = true; });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(monitorExited, true);
    assert.equal(synchronized, false);
    await assert.rejects(prepared.handle.proveTerminated());
    assert.equal(await prepared.handle.signal('SIGKILL'), true);
    await release;
    await prepared.handle.proveTerminated();
});
