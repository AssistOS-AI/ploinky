import assert from 'node:assert/strict';
import test from 'node:test';
import {
    createRepositoryProcessObserver, proveRepositoryQuiescence, REPOSITORY_OPERATION_MARKER,
} from '../../cli/server/marketplaceRepositoryProcessGroup.mjs';

const operationId = '01234567-89ab-cdef-0123-456789abcdef';

function procFixture() {
    const processes = new Map();
    let handles = 0;
    let opens = 0;
    let mutate = () => {};
    let beforeOpen = async () => {};
    function add(pid, options = {}) {
        processes.set(pid, { pid, birth: `${pid}00`, parent: 1, group: pid, session: pid,
            state: 'S', namespace: 'pid:[42]', uid: 1000, argv: ['/node', '/supervisor.mjs'],
            env: [], ...options });
    }
    function value(pid, name) {
        const record = processes.get(pid);
        if (!record) throw Object.assign(new Error('absent'), { code: 'ENOENT' });
        if (record.unreadable === name) throw Object.assign(new Error('unreadable'), { code: 'EACCES' });
        if (name === 'stat') return Buffer.from(`${pid} (fixture (name)) ${record.state} ${record.parent} ${record.group} ${record.session} ${Array(15).fill('0').join(' ')} ${record.birth}\n`);
        if (name === 'status') return Buffer.from(`Uid:\t${Array(4).fill(record.uid).join('\t')}\n`);
        if (name === 'cmdline') return Buffer.from(record.argv.length ? `${record.argv.join('\0')}\0` : '');
        if (name === 'environ') return Buffer.from(record.env.length ? `${record.env.join('\0')}\0` : '');
        throw new Error(`unexpected field ${name}`);
    }
    const fsApi = {
        async opendir() {
            const entries = [...processes.keys()].map((pid) => ({ name: String(pid) }));
            handles += 1;
            return { async read() { return entries.shift() || null; }, async close() { handles -= 1; } };
        },
        async open(file) {
            const [, pid, name] = file.match(/\/([0-9]+)\/(.+)$/);
            await beforeOpen(Number(pid), name);
            const bytes = value(Number(pid), name);
            opens += 1;
            handles += 1;
            mutate(Number(pid), name);
            return {
                async read(target, offset, length, position) {
                    const part = bytes.subarray(position, position + length);
                    part.copy(target, offset);
                    return { bytesRead: part.length };
                },
                async close() { handles -= 1; },
            };
        },
        async readlink(file) {
            const [, pid, name] = file.match(/\/([0-9]+)\/(.+)$/);
            const record = processes.get(Number(pid));
            if (!record) throw Object.assign(new Error('absent'), { code: 'ENOENT' });
            if (record.unreadable === name) throw Object.assign(new Error('unreadable'), { code: 'EACCES' });
            return name === 'exe' ? '/node' : record.namespace;
        },
    };
    return { fsApi, processes, add, setMutate: (fn) => { mutate = fn; },
        setBeforeOpen: (fn) => { beforeOpen = fn; }, handles: () => handles, opens: () => opens };
}

async function initialized() {
    const fixture = procFixture();
    fixture.add(10);
    fixture.add(11, { unreadable: 'environ' }); // unrelated preexisting sentinel
    const observer = createRepositoryProcessObserver({ fsApi: fixture.fsApi });
    const baseline = await observer.scan();
    assert.equal(baseline.complete, true);
    const router = baseline.records.find((entry) => entry.pid === 10);
    fixture.add(20, { parent: 10 });
    const coordinator = await observer.read(20, { executable: true });
    return { fixture, observer, options: { baseline: baseline.records, router, coordinator, operationId } };
}

test('cohort includes detached marker, untagged group member and remembered identity without owning the sentinel', async () => {
    const { fixture, observer, options } = await initialized();
    fixture.add(21, { parent: 20, group: 20, session: 20 });
    fixture.add(22, { env: [`${REPOSITORY_OPERATION_MARKER}=${operationId}`] });
    let observed = await observer.scan(options);
    assert.equal(observed.complete, true);
    assert.deepEqual(observed.writers.map((entry) => entry.pid).sort(), [21, 22]);
    fixture.processes.get(22).env = [];
    observed = await observer.scan({ ...options, remembered: observed.members });
    assert.deepEqual(observed.writers.map((entry) => entry.pid).sort(), [21, 22]);
    assert.equal(observed.members.some((entry) => entry.pid === 11), false);
    assert.equal(fixture.handles(), 0);
});

test('new unreadable environment and a truncated proc field stay unknown', async () => {
    const { fixture, observer, options } = await initialized();
    fixture.add(30, { unreadable: 'environ' });
    let observed = await observer.scan(options);
    assert.equal(observed.complete, false);
    assert.deepEqual(observed.diagnostic.unknowns[0], { category: 'permission', field: 'environment', errno: 'EACCES', count: 1 });
    assert.equal((await proveRepositoryQuiescence(observer, options, { barrier: true })).ok, false);
    fixture.processes.get(30).unreadable = null;
    fixture.processes.get(30).env = ['x'.repeat(65_537)];
    observed = await observer.scan(options);
    assert.equal(observed.complete, false);
    assert.equal(observed.diagnostic.unknowns[0].category, 'truncated');
    assert.equal(fixture.handles(), 0);
});

test('unstable birth, replaced coordinator and foreign replacement cannot authorize signals', async () => {
    const { fixture, observer, options } = await initialized();
    const sent = [];
    const kill = (...args) => sent.push(args);
    fixture.setMutate((pid, field) => {
        if (pid === 20 && field === 'cmdline') fixture.processes.get(20).birth += '1';
    });
    assert.equal(await observer.signal(options.coordinator, 'SIGKILL', { coordinator: options.coordinator, group: true, kill }), false);
    fixture.setMutate(() => {});
    assert.equal(await observer.signal(options.coordinator, 'SIGTERM', { kill }), false);
    assert.deepEqual(sent, []);
    const observed = await observer.scan(options);
    assert.equal(observed.members.some((entry) => entry.pid === 20), false, 'reused numeric group has no owned anchor');
});

test('quiescence requires the barrier and two complete observations, with a live writer invalidating either pass', async () => {
    let calls = 0;
    const observer = { async scan() {
        calls += 1;
        return { complete: true, members: [], writers: calls === 2 ? [{ pid: 99 }] : [] };
    } };
    assert.equal((await proveRepositoryQuiescence(observer, {}, { barrier: false })).ok, false);
    assert.equal(calls, 0);
    const proof = await proveRepositoryQuiescence(observer, {}, { barrier: true });
    assert.equal(proof.ok, false);
    assert.equal(proof.reason, 'writer');
    assert.equal(calls, 2);
});

test('census overflow and observation timeout never become a complete empty list', async () => {
    const fixture = procFixture();
    for (let pid = 1; pid <= 8_193; pid += 1) fixture.add(pid);
    const observer = createRepositoryProcessObserver({ fsApi: fixture.fsApi });
    const overflow = await observer.scan();
    assert.equal(overflow.complete, false);
    assert.equal(overflow.diagnostic.unknowns[0].category, 'entry-overflow');
    assert.equal(fixture.opens(), 0, 'overflow is refused before process reads');
    assert.equal(fixture.handles(), 0);
    let clock = 0;
    const timed = createRepositoryProcessObserver({ fsApi: fixture.fsApi, now: () => { clock += 600; return clock; } });
    const timeout = await timed.scan();
    assert.equal(timeout.complete, false);
    assert.equal(timeout.diagnostic.unknowns[0].category, 'deadline');
    assert.equal(fixture.handles(), 0);
});

test('only an unchanged executable/module/group anchor may authorize a group signal', async () => {
    const { fixture, observer, options } = await initialized();
    const sent = [];
    assert.equal(await observer.signal(options.coordinator, 'SIGTERM', {
        coordinator: options.coordinator, group: true, kill: (...args) => sent.push(args),
    }), true);
    assert.deepEqual(sent, [[-20, 'SIGTERM']]);
    fixture.processes.get(20).argv = ['/node', '/foreign.mjs'];
    assert.equal(await observer.signal(options.coordinator, 'SIGKILL', {
        coordinator: options.coordinator, group: true, kill: (...args) => sent.push(args),
    }), false);
    assert.equal(sent.length, 1);
});

test('visible nested-namespace marker, remembered identity and validated lineage remain writers', async () => {
    const { fixture, observer, options } = await initialized();
    fixture.add(30, { namespace: 'pid:[99]', env: [`${REPOSITORY_OPERATION_MARKER}=${operationId}`] });
    fixture.add(31, { parent: 30, namespace: 'pid:[100]' });
    let observed = await observer.scan(options);
    assert.equal(observed.complete, true);
    assert.deepEqual(observed.writers.map((entry) => entry.pid).sort(), [30, 31]);
    assert.equal((await proveRepositoryQuiescence(observer, options, { barrier: true })).ok, false);
    fixture.processes.get(30).env = [];
    observed = await observer.scan({ ...options, remembered: observed.members });
    assert.equal(observed.complete, true);
    assert.deepEqual(observed.writers.map((entry) => entry.pid).sort(), [30, 31]);
    const sent = [];
    for (const writer of observed.writers) await observer.signal(writer, 'SIGTERM', { kill: (...args) => sent.push(args) });
    assert.deepEqual(sent.sort((left, right) => left[0] - right[0]), [[30, 'SIGTERM'], [31, 'SIGTERM']]);
    assert.equal(fixture.handles(), 0);
});

test('mid-census parent PID reuse cannot adopt or signal an unrelated replacement child', async () => {
    const { fixture, observer, options } = await initialized();
    fixture.add(21, { parent: 20, group: 20, session: 20 });
    fixture.add(30, { parent: 21 });
    let parentStatReads = 0;
    let parentCaptured;
    let replaced = false;
    const parentSnapshot = new Promise((resolve) => { parentCaptured = resolve; });
    fixture.setMutate((pid, field) => {
        // The second stat's bytes already contain A's birth identity. Its
        // read can now finish even though B will replace it before C is read.
        if (pid === 21 && field === 'stat' && ++parentStatReads === 2) parentCaptured();
    });
    fixture.setBeforeOpen(async (pid, field) => {
        if (pid !== 30 || field !== 'stat' || replaced) return;
        await parentSnapshot;
        fixture.add(21, { birth: '9100' }); // B is unrelated, reusing A's PID.
        fixture.add(30, { birth: '9300', parent: 21 }); // C belongs to B.
        replaced = true;
    });
    const observed = await observer.scan(options);
    assert.equal(replaced, true, 'the reuse occurred within this census');
    assert.ok(observed.records.some((entry) => entry.pid === 21 && entry.birth === '2100'), 'census captured owned A');
    assert.ok(observed.records.some((entry) => entry.pid === 30 && entry.birth === '9300'), 'census captured foreign C');
    assert.equal(observed.complete, false, 'a replaced lineage anchor leaves unknown ownership');
    assert.equal(observed.diagnostic.unknowns[0].category, 'lineage');
    assert.equal(observed.members.some((entry) => entry.pid === 30), false, 'numeric PPID does not establish ownership');
    const sent = [];
    for (const writer of observed.writers) await observer.signal(writer, 'SIGKILL', { kill: (...args) => sent.push(args) });
    assert.deepEqual(sent, [], 'neither replacement B nor foreign C can be signaled');
    assert.equal(fixture.handles(), 0);
});

test('protected preexisting namespace denial blocks baseline and later proof instead of classifying it as unrelated', async () => {
    const fixture = procFixture();
    fixture.add(10);
    fixture.add(11, { unreadable: 'ns/pid' });
    const observer = createRepositoryProcessObserver({ fsApi: fixture.fsApi });
    const baseline = await observer.scan();
    assert.equal(baseline.complete, false);
    assert.deepEqual(baseline.diagnostic.unknowns[0], { category: 'permission', field: 'namespace', errno: 'EACCES', count: 1 });
    assert.equal(baseline.records.some((entry) => entry.pid === 11), false);
    assert.equal((await observer.scan({ baseline: baseline.records })).complete, false);
    assert.equal(fixture.handles(), 0);

    const initializedFixture = await initialized();
    initializedFixture.fixture.processes.get(11).unreadable = 'ns/pid';
    const proof = await proveRepositoryQuiescence(initializedFixture.observer, initializedFixture.options, { barrier: true });
    assert.equal(proof.ok, false);
    assert.equal(proof.reason, 'unknown');
    assert.equal(initializedFixture.fixture.handles(), 0);
});

test('a parent disappearing during the fresh child observation cannot establish lineage', async () => {
    const { fixture, observer, options } = await initialized();
    fixture.add(21, { parent: 20, group: 20, session: 20 });
    fixture.add(30, { parent: 21 });
    let childStatReads = 0;
    fixture.setMutate((pid, field) => {
        // Two ordinary and two environment-associated stat reads finish the
        // census. The fifth starts the fresh child read between parent probes.
        if (pid === 30 && field === 'stat' && ++childStatReads === 5) fixture.processes.delete(21);
    });
    const observed = await observer.scan(options);
    assert.ok(childStatReads >= 5, 'the parent vanished during lineage validation');
    assert.equal(observed.complete, false);
    assert.equal(observed.members.some((entry) => entry.pid === 30), false);
    const sent = [];
    for (const writer of observed.writers) await observer.signal(writer, 'SIGKILL', { kill: (...args) => sent.push(args) });
    assert.deepEqual(sent, []);
    assert.equal(fixture.handles(), 0);
});

test('an expired cleanup budget prevents a signal after identity validation completes', async () => {
    const { observer, options } = await initialized();
    const sent = [];
    assert.equal(await observer.signal(options.coordinator, 'SIGKILL', {
        coordinator: options.coordinator, group: true, isAllowed: () => false, kill: (...args) => sent.push(args),
    }), false);
    assert.deepEqual(sent, []);
});

test('field failures report only category and errno, and malformed identities never expose contents', async () => {
    for (const [rawField, field] of [['stat', 'stat'], ['status', 'status'], ['cmdline', 'argv'], ['ns/pid', 'namespace']]) {
        const fixture = procFixture();
        fixture.add(10, { unreadable: rawField });
        const observer = createRepositoryProcessObserver({ fsApi: fixture.fsApi });
        const result = await observer.scan();
        assert.equal(result.complete, false);
        assert.deepEqual(result.diagnostic.unknowns[0], { category: 'permission', field, errno: 'EACCES', count: 1 });
    }
    for (const [property, value, field] of [['birth', 'SECRET_CANARY', 'stat'], ['uid', 'SECRET_CANARY', 'status'], ['namespace', 'SECRET_CANARY', 'namespace']]) {
        const fixture = procFixture(); fixture.add(10, { [property]: value });
        const result = await createRepositoryProcessObserver({ fsApi: fixture.fsApi }).scan();
        assert.equal(result.complete, false);
        assert.deepEqual(result.diagnostic.unknowns[0], { category: 'malformed', field, count: 1 });
        assert.doesNotMatch(JSON.stringify(result.diagnostic), /SECRET_CANARY/);
    }
});

test('identity instability identifies the changing field without changing the unknown decision', async () => {
    for (const [property, value, field] of [['birth', '999', 'birth'], ['namespace', 'pid:[99]', 'namespace'],
        ['uid', 999, 'status'], ['parent', 999, 'parent'], ['group', 999, 'group'], ['session', 999, 'session'],
        ['argv', ['SECRET_CANARY'], 'argv']]) {
        const fixture = procFixture(); fixture.add(10);
        fixture.setMutate((pid, name) => { if (name === 'cmdline') fixture.processes.get(pid)[property] = value; });
        const result = await createRepositoryProcessObserver({ fsApi: fixture.fsApi }).scan();
        assert.equal(result.complete, false);
        assert.deepEqual(result.diagnostic.unknowns[0], { category: 'unstable', field, count: 1 });
        assert.doesNotMatch(JSON.stringify(result.diagnostic), /SECRET_CANARY/);
    }
});

test('confirmed disappearance is not an unknown while a readable replacement remains unconfirmed', async () => {
    for (const replacement of [false, true]) {
        const fixture = procFixture(); fixture.add(10);
        let calls = 0;
        const open = fixture.fsApi.open;
        fixture.fsApi.open = async (...args) => {
            if (++calls === 1 || !replacement) throw Object.assign(new Error('SECRET_CANARY'), { code: 'ENOENT' });
            return open(...args);
        };
        const result = await createRepositoryProcessObserver({ fsApi: fixture.fsApi }).scan();
        assert.equal(result.complete, !replacement);
        assert.deepEqual(result.diagnostic.unknowns, replacement ? [{ category: 'disappearance-unconfirmed', field: 'stat', count: 1 }] : []);
    }
});

test('overlap and reader saturation have separate bounded diagnostics', async () => {
    const fixture = procFixture(); fixture.add(10);
    let unblock;
    const hold = new Promise(resolve => { unblock = resolve; });
    fixture.setBeforeOpen(() => hold);
    const observer = createRepositoryProcessObserver({ fsApi: fixture.fsApi });
    const active = observer.scan();
    await Promise.resolve();
    const overlap = await observer.scan();
    assert.equal(overlap.diagnostic.unknowns[0].category, 'overlap');
    unblock(); await active;

    let release;
    const blocked = new Promise(resolve => { release = resolve; });
    fixture.setBeforeOpen(() => blocked);
    const reads = Array.from({ length: 8 }, () => observer.read(10));
    await assert.rejects(observer.read(10), error => error.diagnostic.category === 'reader-saturation');
    const saturated = await observer.scan();
    assert.equal(saturated.complete, false);
    assert.ok(saturated.diagnostic.unknowns.some(row => row.category === 'reader-saturation'));
    release(); await Promise.all(reads);
    assert.equal(fixture.handles(), 0);
});
