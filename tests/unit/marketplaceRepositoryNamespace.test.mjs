import assert from 'node:assert/strict';
import test from 'node:test';
import { createRepositoryNamespaceObserver } from '../../cli/server/marketplaceRepositoryNamespace.mjs';
import { INSTALL_BWRAP, INSTALL_PROCESS, installUnitArguments } from '../../cli/server/marketplaceRepositoryInstallUnit.mjs';
import { REPOSITORY_OPERATION_MARKER } from '../../cli/server/marketplaceRepositoryProcessGroup.mjs';

function fixture() {
    const coordinator = { pid: 10, birth: '100', namespace: 'pid:[1]', uids: '1000:1000:1000:1000', parent: 1, state: 'S' };
    const options = { coordinator, launcherPid: 20, initPid: 21, workspaceRoot: '/workspace', cwd: '/workspace', executable: '/node',
        operationId: '01234567-89ab-cdef-0123-456789abcdef' };
    const launcher = { ...coordinator, pid: 20, birth: '200', parent: 10, exe: INSTALL_BWRAP,
        argv: [INSTALL_BWRAP, ...installUnitArguments(options)],
        environment: [`${REPOSITORY_OPERATION_MARKER}=${options.operationId}`] };
    const init = { ...coordinator, pid: 21, birth: '210', namespace: 'pid:[2]', parent: 20 };
    const privateInit = { ...init, pid: 1, parent: 0, group: 0, session: 0 };
    const helper = { ...privateInit, pid: 2, birth: '220', parent: 1, exe: '/node', argv: ['/node', INSTALL_PROCESS] };
    const records = new Map([[10, coordinator], [20, launcher], [21, init]]);
    let visible = [privateInit, helper];
    let complete = true;
    let type = 0x9fa0;
    let closed = 0;
    const signals = [];
    const observer = createRepositoryNamespaceObserver({
        outer: { async read(pid) { if (!records.has(pid)) throw Object.assign(Error(), { code: 'ENOENT' }); return { ...records.get(pid) }; },
            async signal(record, signal, { isAllowed }) { if (!isAllowed()) return false; signals.push({ record, signal }); return true; } },
        fsApi: { async open() { return { fd: 30 + closed, async close() { closed += 1; } }; },
            async readlink() { return 'pid:[2]'; }, async statfs() { return { type }; } },
        observerFactory: () => ({ async read(pid) { return pid === 1 ? privateInit : helper; },
            async scan() { return { complete, records: visible, members: [], writers: [] }; } }),
    });
    return { options, observer, launcher, init, helper, privateInit, records, signals,
        setVisible: value => { visible = value; }, setComplete: value => { complete = value; },
        setType: value => { type = value; }, closed: () => closed };
}

test('real foreign namespace with expected helper refuses a forged direct parent edge before gaining a handle', async () => {
    for (const mutate of [f => { f.init.parent = 99; }, f => { f.launcher.parent = 99; },
        f => { f.init.namespace = 'pid:[1]'; }, f => { f.launcher.exe = '/foreign'; },
        f => { f.helper.argv = ['/node', '/foreign']; }, f => { f.launcher.environment = []; }, f => f.setType(0x1234)]) {
        const f = fixture(); mutate(f);
        await assert.rejects(f.observer.attest(f.options), { code: 'PLOINKY_MARKETPLACE_REPOSITORY_RECOVERY_REQUIRED' });
        assert.deepEqual(f.signals, []);
    }
});

test('private census treats a detached reparented markerless process as a writer and blocks settlement', async () => {
    const f = fixture();
    const handle = await f.observer.attest(f.options);
    f.setVisible([f.privateInit, f.helper, { ...f.helper, pid: 16, parent: 1, group: 16, session: 16, birth: '1600', argv: [] }]);
    const result = await handle.scan();
    assert.equal(result.writers.length, 1);
    await assert.rejects(handle.proveBarrier());
    await handle.close();
    assert.equal(f.closed(), 2);
    assert.equal(await handle.signal('SIGKILL'), false);
});

test('termination requires gone init and a complete empty pinned view independently', async () => {
    const f = fixture();
    const handle = await f.observer.attest(f.options);
    await handle.proveBarrier();
    await assert.rejects(handle.proveTerminated());
    f.records.delete(21);
    await assert.rejects(handle.proveTerminated());
    f.setVisible([]); f.setComplete(false);
    await assert.rejects(handle.proveTerminated());
    f.setComplete(true);
    await handle.proveTerminated();
    await handle.close();
});
