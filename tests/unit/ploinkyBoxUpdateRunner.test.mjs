import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { runUpdateExec } from '../../ploinky-box/update/coreRunner.mjs';

const NONCE = 'a'.repeat(32);

function sink() {
    let text = '';
    return { write(chunk) { text += String(chunk); }, value: () => text };
}

function nodeChild(script) {
    return { command: process.execPath, args: ['-e', script] };
}

test('a normal exit keeps its status, streams output and keeps only bounded tails', async () => {
    const stdout = sink();
    const child = nodeChild("process.stdout.write('x'.repeat(5000)+'END'); process.exit(0)");
    const result = await runUpdateExec({ ...child, nonce: NONCE, stdout, stderr: sink(), tailBytes: 64 });
    assert.equal(result.cause, 'exited');
    assert.equal(result.status, 0);
    assert.equal(result.quiescence.state, 'confirmed');
    assert.equal(result.quiescence.method, 'exec-exit-status');
    assert.equal(stdout.value().length, 5003);
    assert.ok(result.tails.stdout.length <= 65);
    assert.match(result.tails.stdout, /END$/);
});

test('a TERM-resistant client is escalated to KILL and quiescence is proven by the engine', async () => {
    const probes = [];
    const processRef = new EventEmitter();
    let ready;
    const readySeen = new Promise(resolve => { ready = resolve; });
    const stdout = { write(chunk) { if (String(chunk).includes('ready')) ready(); } };
    // The handler is installed before 'ready' is printed, so SIGTERM is ignored.
    const child = nodeChild("process.on('SIGTERM',()=>{}); setInterval(()=>{},1000); process.stdout.write('ready')");
    const started = Date.now();
    const promise = runUpdateExec({
        ...child,
        nonce: NONCE,
        stdout,
        stderr: sink(),
        processRef,
        timeoutMs: 60_000,
        termGraceMs: 300,
        killGraceMs: 5_000,
        probe: ({ nonce }) => { probes.push(nonce); return { ok: true, pids: [] }; },
    });
    await readySeen;
    processRef.emit('SIGTERM');
    const result = await promise;
    assert.equal(result.cause, 'signal:SIGTERM');
    assert.equal(result.escalation, 'SIGKILL');
    assert.equal(result.signal, 'SIGKILL');
    assert.equal(result.clientExited, true);
    assert.deepEqual(probes, [NONCE]);
    assert.deepEqual(result.quiescence, { state: 'confirmed', method: 'engine-probe' });
    assert.ok(Date.now() - started < 10_000);
});

test('in-Box processes that survive the client are signalled TERM then KILL until the engine confirms', async () => {
    const kills = [];
    let remaining = [41, 42];
    const result = await runUpdateExec({
        ...nodeChild('setInterval(()=>{},1000)'),
        nonce: NONCE,
        stdout: sink(),
        stderr: sink(),
        timeoutMs: 100,
        termGraceMs: 200,
        killGraceMs: 200,
        probeIntervalMs: 20,
        probe: () => ({ ok: true, pids: remaining }),
        killInBox: (pids, signal) => {
            kills.push([signal, [...pids]]);
            if (signal === 'KILL') remaining = [];
        },
    });
    assert.deepEqual(kills, [['TERM', [41, 42]], ['KILL', [41, 42]]]);
    assert.equal(result.quiescence.state, 'confirmed');
    assert.equal(result.quiescence.method, 'engine-probe-after-KILL');
});

test('quiescence stays uncertain without a probe, with a failing probe, or with surviving processes', async () => {
    const run = probe => runUpdateExec({
        ...nodeChild('setInterval(()=>{},1000)'),
        nonce: NONCE,
        stdout: sink(),
        stderr: sink(),
        timeoutMs: 50,
        termGraceMs: 100,
        killGraceMs: 100,
        probeIntervalMs: 20,
        probe,
        killInBox: () => {},
    });
    assert.equal((await run(null)).quiescence.state, 'uncertain');
    const failing = await run(() => ({ ok: false, detail: 'engine unavailable' }));
    assert.deepEqual([failing.quiescence.state, failing.quiescence.detail], ['uncertain', 'engine unavailable']);
    const surviving = await run(() => ({ ok: true, pids: [7] }));
    assert.equal(surviving.quiescence.state, 'uncertain');
    assert.deepEqual(surviving.quiescence.pids, [7]);
    const thrown = await run(() => { throw new Error('probe crashed'); });
    assert.equal(thrown.quiescence.state, 'uncertain');
});

test('exceeding the output limit cancels the update and is never a normal exit', async () => {
    const result = await runUpdateExec({
        ...nodeChild("setInterval(()=>process.stdout.write('y'.repeat(4096)),1)"),
        nonce: NONCE,
        stdout: sink(),
        stderr: sink(),
        outputLimitBytes: 16 * 1024,
        termGraceMs: 500,
        probe: () => ({ ok: true, pids: [] }),
    });
    assert.equal(result.cause, 'output-limit');
    assert.equal(result.quiescence.state, 'confirmed');
    assert.ok(result.tails.stdout.length > 0);
});

test('an operator signal cancels the client and removes every forwarded handler', async () => {
    const processRef = new EventEmitter();
    const promise = runUpdateExec({
        ...nodeChild('setInterval(()=>{},1000)'),
        nonce: NONCE,
        stdout: sink(),
        stderr: sink(),
        processRef,
        termGraceMs: 500,
        probe: () => ({ ok: true, pids: [] }),
    });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(processRef.listenerCount('SIGINT'), 1);
    processRef.emit('SIGINT');
    const result = await promise;
    assert.equal(result.cause, 'signal:SIGINT');
    assert.equal(processRef.listenerCount('SIGINT'), 0);
    assert.equal(processRef.listenerCount('SIGTERM'), 0);
});

test('a client that survives KILL stops the wait and leaves the answer to the engine', async () => {
    const child = new EventEmitter();
    child.pid = 999_999;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    const signals = [];
    const result = await runUpdateExec({
        command: 'engine',
        args: [],
        nonce: NONCE,
        spawnImpl: () => child,
        killGroup: (pid, signal) => signals.push([pid, signal]),
        timeoutMs: 20,
        termGraceMs: 20,
        killGraceMs: 20,
        probe: () => ({ ok: false, detail: 'engine did not answer' }),
    });
    assert.deepEqual(signals, [[999_999, 'SIGTERM'], [999_999, 'SIGKILL']]);
    assert.equal(result.clientExited, false);
    assert.equal(result.quiescence.state, 'uncertain');
});

test('the bounded update command carries the nonce and context and never throws on a nonzero exit', async () => {
    const { runBoundedUpdateCommand } = await import('../../ploinky-box/supervisor.mjs');
    const { agentLibFixture } = await import('../helpers/agentlibFixture.mjs');
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-update-runner-')));
    try {
        const spawned = [];
        const result = await runBoundedUpdateCommand({ name: 'podman' }, 'c'.repeat(64), ['update', 'repos'], 8080, 7882, {
            query: (_engine, args) => ({ ok: true, stdout: args[1] === 'inspect' ? 'true' : '[]' }),
        }, {
            workspaceRoot: root,
            agentLib: agentLibFixture(root),
            reportNonce: NONCE,
            reportContext: { schema: 'ploinky-update-context', workspace: { instance: 'x' } },
            stdout: sink(),
            stderr: sink(),
            env: { PATH: '/bin' },
            runnerOptions: {
                spawnImpl(command, args, options) {
                    spawned.push([command, args, options]);
                    const child = new EventEmitter();
                    child.pid = 4242;
                    child.stdout = new EventEmitter();
                    child.stderr = new EventEmitter();
                    setImmediate(() => child.emit('close', 7, null));
                    return child;
                },
            },
        });
        assert.equal(result.status, 7);
        assert.equal(result.quiescence.state, 'confirmed');
        const [[command, args, options]] = spawned;
        assert.equal(command, 'podman');
        assert.equal(options.detached, true, 'the exec client owns its own process group');
        assert.deepEqual(options.env, { PATH: '/bin' });
        const envs = args.flatMap((value, index) => (args[index - 1] === '--env' ? [value] : []));
        assert.ok(envs.includes(`PLOINKY_UPDATE_REPORT_NONCE=${NONCE}`));
        assert.ok(envs.includes('PLOINKY_UPDATE_REPORT_CONTEXT={"schema":"ploinky-update-context","workspace":{"instance":"x"}}'));
        assert.deepEqual(args.slice(-6), ['--workdir', root, 'c'.repeat(64), '/opt/ploinky/bin/ploinky-local', 'update', 'repos']);
        await assert.rejects(runBoundedUpdateCommand({ name: 'podman' }, 'c'.repeat(64), ['update'], 8080, 7882, {}, {
            workspaceRoot: root, agentLib: agentLibFixture(root), reportNonce: 'bad', reportContext: {},
        }), { code: 'PLOINKY_BOX_UPDATE_REPORT_INVALID' });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('the engine probe treats a stopped or removed Box as quiescent and anything unanswerable as unproven', async () => {
    const { probeInBoxUpdateProcesses } = await import('../../ploinky-box/supervisor.mjs');
    const engine = { name: 'podman' };
    const runner = responses => ({
        calls: [],
        query(command, args) { this.calls.push(args); return responses.shift(); },
    });
    assert.deepEqual(probeInBoxUpdateProcesses(engine, 'id', runner([{ ok: true, stdout: 'false\n' }]), NONCE).pids, []);
    assert.equal(probeInBoxUpdateProcesses(engine, 'id', runner([{ ok: false, stderr: 'Error: no such container id' }]), NONCE).ok, true);
    assert.equal(probeInBoxUpdateProcesses(engine, 'id', runner([{ ok: false, stderr: 'engine unavailable' }]), NONCE).ok, false);
    const listing = runner([{ ok: true, stdout: 'true\n' }, { ok: true, stdout: '[12,13]' }]);
    assert.deepEqual(probeInBoxUpdateProcesses(engine, 'id', listing, NONCE), { ok: true, pids: [12, 13] });
    assert.equal(listing.calls[1].at(-1), `PLOINKY_UPDATE_REPORT_NONCE=${NONCE}`);
    assert.equal(probeInBoxUpdateProcesses(engine, 'id', runner([{ ok: true, stdout: 'true' }, { ok: true, stdout: 'nope' }]), NONCE).ok, false);
});

test('the in-Box probe script finds exactly the processes carrying the operation nonce', async (t) => {
    const { IN_BOX_NONCE_PROBE_SCRIPT } = await import('../../ploinky-box/update/coreRunner.mjs');
    const fs = await import('node:fs');
    if (!fs.existsSync('/proc/self/environ')) {
        t.skip('requires Linux /proc; the Box runs Linux');
        return;
    }
    const { spawn, spawnSync } = await import('node:child_process');
    const marked = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
        env: { ...process.env, PLOINKY_UPDATE_REPORT_NONCE: NONCE },
    });
    try {
        const listed = spawnSync(process.execPath, ['-e', IN_BOX_NONCE_PROBE_SCRIPT, `PLOINKY_UPDATE_REPORT_NONCE=${NONCE}`]);
        assert.deepEqual(JSON.parse(listed.stdout.toString()), [marked.pid]);
    } finally {
        marked.kill('SIGKILL');
    }
});

test('the bounded restart runner marks only its own operation and returns nonzero ends', async () => {
    const { runBoundedRestartCommand } = await import('../../ploinky-box/supervisor.mjs');
    const { agentLibFixture } = await import('../helpers/agentlibFixture.mjs');
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-restart-runner-')));
    try {
        const spawned = [];
        const queries = [];
        const result = await runBoundedRestartCommand({ name: 'podman' }, 'c'.repeat(64), ['restart'], 8080, 7882, {
            query(_command, args) {
                queries.push(args);
                return args[1] === 'inspect' ? { ok: true, stdout: 'true' } : { ok: true, stdout: '[]' };
            },
        }, {
            workspaceRoot: root,
            agentLib: agentLibFixture(root),
            operationId: NONCE,
            stdout: sink(),
            stderr: sink(),
            env: {},
            runnerOptions: {
                timeoutMs: 20,
                termGraceMs: 20,
                spawnImpl(command, args) {
                    spawned.push(args);
                    const child = new EventEmitter();
                    child.pid = 4343;
                    child.stdout = new EventEmitter();
                    child.stderr = new EventEmitter();
                    child.kill = () => {};
                    return child;
                },
                killGroup: () => {},
                killGraceMs: 20,
            },
        });
        const envs = spawned[0].flatMap((value, index) => (spawned[0][index - 1] === '--env' ? [value] : []));
        assert.ok(envs.includes(`PLOINKY_UPDATE_OPERATION=${NONCE}`));
        assert.equal(envs.some(value => value.startsWith('PLOINKY_UPDATE_REPORT_')), false);
        assert.deepEqual(spawned[0].slice(-2), ['/opt/ploinky/bin/ploinky-local', 'restart']);
        assert.equal(result.cause, 'timeout');
        assert.equal(result.quiescence.state, 'confirmed');
        assert.equal(queries.at(-1).at(-1), `PLOINKY_UPDATE_OPERATION=${NONCE}`, 'the probe looks for this restart only');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

for (const status of [1, 125]) {
    test(`engine-client exit ${status} requires proof that remaining writers stopped`, async () => {
        let pids = [31415];
        const calls = [];
        const result = await runUpdateExec({
            ...nodeChild(`process.exit(${status})`), nonce: NONCE,
            stdout: sink(), stderr: sink(), termGraceMs: 20, killGraceMs: 20, probeIntervalMs: 5,
            probe() { calls.push('probe'); return { ok: true, pids }; },
            killInBox(selected, signal) { calls.push([signal, selected]); pids = []; },
        });
        assert.equal(result.status, status);
        assert.equal(result.quiescence.method, 'engine-probe-after-TERM');
        assert.deepEqual(calls, ['probe', ['TERM', [31415]], 'probe']);
    });
}

test('successful update clients also probe for detached writers', async () => {
    const result = await runUpdateExec({
        ...nodeChild('process.exit(0)'), nonce: NONCE, probeOnSuccess: true,
        stdout: sink(), stderr: sink(), probe: () => ({ ok: false, detail: 'engine unavailable' }),
    });
    assert.equal(result.quiescence.state, 'uncertain');
});

test('a detached writer discovered after successful exit invalidates the completed input snapshot', async () => {
    let pids = [42];
    const result = await runUpdateExec({
        ...nodeChild('process.exit(0)'), nonce: NONCE, probeOnSuccess: true,
        stdout: sink(), stderr: sink(), termGraceMs: 20, killGraceMs: 20,
        probe: () => ({ ok: true, pids }), killInBox: () => { pids = []; },
    });
    assert.equal(result.quiescence.state, 'confirmed');
    assert.equal(result.cause, 'writer-outlived-command', 'stopping a late writer cannot verify the prior report');
});
