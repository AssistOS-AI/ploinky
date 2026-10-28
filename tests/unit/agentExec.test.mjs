import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';

import {
    AgentExecManager,
    listMarkedProcessTree,
    normalizeAgentExecRequest,
    selectAgentExecTarget,
} from '../../cli/server/agentExec/agentExecManager.js';
import { procUnmaskArgs, procUnmaskReuseReason } from '../../cli/sandbox/docker/procUnmask.js';
import { AGENT_EXEC_PATH } from '../../cli/server/edgeRoutePlan.js';

const CONTAINER_ID = 'a'.repeat(64);
const CALLER = Object.freeze({ agentId: 'agent:AchillesIDE/roboTeamAgent', instanceId: 'i', enableGeneration: 'g' });

function snapshot(overrides = {}) {
    return {
        agents: {
            ploinky_AchillesIDE_gitAgent_work_1: {
                type: 'agent', runtime: 'podman', runMode: 'global', containerId: CONTAINER_ID,
                containerName: 'ploinky_AchillesIDE_gitAgent_work_1', instanceId: 'x', enableGeneration: 'y',
                repoName: 'AchillesIDE', agentName: 'gitAgent', ...overrides,
            },
        },
    };
}

test('agent exec requests are bounded: target, absolute argv[0], normalized cwd and no PLOINKY_ variables', () => {
    const request = normalizeAgentExecRequest({ target: 'AchillesIDE/gitAgent', argv: ['/usr/bin/node', '-v'], cwd: '/work/project', env: { HOME: '/h' } });
    assert.deepEqual([request.target, request.argv, request.cwd, request.env], ['AchillesIDE/gitAgent', ['/usr/bin/node', '-v'], '/work/project', { HOME: '/h' }]);
    for (const bad of [
        { target: 'gitAgent', argv: ['/x'], cwd: '/w' },
        { target: 'a/b', argv: ['node'], cwd: '/w' },
        { target: 'a/b', argv: ['/x'], cwd: 'relative' },
        { target: 'a/b', argv: ['/x'], cwd: '/w/../etc' },
        { target: 'a/b', argv: ['/x'], cwd: '/w', env: { PLOINKY_AGENT_SECRET: 's' } },
        { target: 'a/b', argv: ['/x'], cwd: '/w', env: { 'BAD-NAME': 'v' } },
    ]) assert.throws(() => normalizeAgentExecRequest(bad), { code: 'AGENT_EXEC_REQUEST_INVALID' });
});

test('only a running global-mode podman agent other than the caller can be targeted', () => {
    assert.equal(selectAgentExecTarget(snapshot(), 'AchillesIDE/gitAgent', CALLER).containerId, CONTAINER_ID);
    assert.throws(() => selectAgentExecTarget(snapshot(), 'AchillesIDE/dpuAgent', CALLER), { code: 'AGENT_EXEC_TARGET_UNKNOWN' });
    assert.throws(() => selectAgentExecTarget(snapshot({ runMode: 'isolated' }), 'AchillesIDE/gitAgent', CALLER), { code: 'AGENT_EXEC_TARGET_NOT_GLOBAL' });
    assert.throws(() => selectAgentExecTarget(snapshot({ containerId: '' }), 'AchillesIDE/gitAgent', CALLER), { code: 'AGENT_EXEC_TARGET_UNAVAILABLE' });
    assert.throws(() => selectAgentExecTarget(snapshot(), 'AchillesIDE/gitAgent', { ...CALLER, agentId: 'agent:AchillesIDE/gitAgent' }),
        { code: 'AGENT_EXEC_TARGET_IS_CALLER' });
});

test('global podman agents run without /proc masks and are recreated when the mask mode differs', () => {
    assert.deepEqual(procUnmaskArgs({ runtime: 'podman', runMode: 'global', descriptor: { containerSecurity: {} } }),
        ['--security-opt', 'unmask=/proc/*', '--label', 'ploinky.procunmask=proc-v1']);
    assert.deepEqual(procUnmaskArgs({ runtime: 'podman', runMode: 'isolated' }), []);
    assert.deepEqual(procUnmaskArgs({ runtime: 'podman', runMode: 'global', descriptor: { containerSecurity: { privileged: true } } }), []);
    assert.equal(procUnmaskReuseReason({ runtime: 'podman', runMode: 'global' }, ''), 'procUnmaskChanged');
    assert.equal(procUnmaskReuseReason({ runtime: 'podman', runMode: 'global' }, 'proc-v1'), '');
    assert.equal(procUnmaskReuseReason({ runtime: 'podman', runMode: 'isolated' }, 'proc-v1'), 'procUnmaskChanged');
    assert.equal(procUnmaskReuseReason({ runtime: 'podman', runMode: 'isolated' }, ''), '');
});

test('the marked process tree covers marked processes and their descendants only', () => {
    const proc = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-agent-exec-proc-'));
    try {
        const write = (pid, ppid, env) => {
            fs.mkdirSync(path.join(proc, String(pid)));
            fs.writeFileSync(path.join(proc, String(pid), 'stat'), `${pid} (node) S ${ppid} 1 1 0`);
            fs.writeFileSync(path.join(proc, String(pid), 'environ'), `${env.join('\0')}\0`);
        };
        write(10, 1, ['HOME=/h', 'PLOINKY_AGENT_EXEC_ID=m1']);
        write(11, 10, ['A=1']);
        write(12, 11, []);
        write(20, 1, ['PLOINKY_AGENT_EXEC_ID=m2']);
        assert.deepEqual(listMarkedProcessTree('m1', { procRoot: proc }).sort((a, b) => a - b), [10, 11, 12]);
    } finally { fs.rmSync(proc, { recursive: true, force: true }); }
});

function fakeChild() {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const written = [];
    child.stdin = new Writable({ write(chunk, _enc, done) { written.push(Buffer.from(chunk)); done(); } });
    child.written = written;
    child.signals = [];
    child.kill = (signal) => child.signals.push(signal);
    return child;
}

function fakeResponse() {
    const res = new EventEmitter();
    res.chunks = [];
    res.writeHead = (status, headers) => { res.status = status; res.headers = headers; };
    res.write = (chunk) => { res.chunks.push(String(chunk)); return true; };
    res.end = () => { res.ended = true; res.emit('close'); };
    res.lines = () => res.chunks.join('').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    return res;
}

test('an exec starts through env -i in the target, streams output, takes input and is killed by its marker', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-agent-exec-ws-'));
    try {
        const inspect = [{
            Id: CONTAINER_ID, Name: 'ploinky_AchillesIDE_gitAgent_work_1', State: { Running: true, Status: 'running' },
            Config: { User: 'node', Env: ['PATH=/usr/local/bin:/usr/bin', 'PLOINKY_AGENT_SECRET=secret'], Labels: {} },
            HostConfig: { Init: true, NetworkMode: 'bridge' },
            Mounts: [{ Type: 'bind', Source: workspace, Destination: workspace, RW: true }],
        }];
        const spawned = [];
        const child = fakeChild();
        const killed = [];
        const manager = new AgentExecManager({
            execFileImpl: (_cmd, _args, _opts, callback) => callback(null, JSON.stringify(inspect), ''),
            spawnImpl: (command, args) => { spawned.push([command, args]); return child; },
            listProcessTree: (marker) => (marker ? [101, 102] : []),
            killImpl: (pid, signal) => killed.push([pid, signal]),
            workspaceIdentity: () => ({ hash: 'abc' }),
            // Real Ploinky ownership labels are checked by assertExactContainerOwnership elsewhere.
            assertOwned: (_candidate, inspected) => inspected,
            limits: { killGraceMs: 10, retainAfterExitMs: 10 },
        });
        const started = await manager.start({ snapshot: snapshot(), caller: CALLER,
            body: JSON.stringify({ target: 'AchillesIDE/gitAgent', argv: ['/opt/node', 'ala.mjs'], cwd: workspace, env: { PATH: '/opt/bin', HOME: '/h' } }) });
        const [command, args] = spawned[0];
        assert.equal(command, '/usr/bin/podman');
        assert.deepEqual(args.slice(0, 7), ['container', 'exec', '--interactive', '--user', 'node', '--workdir', workspace]);
        assert.ok(args.includes('/usr/bin/env') && args.includes('-i'));
        assert.ok(args.includes('PATH=/opt/bin:/usr/local/bin:/usr/bin'));
        assert.ok(!args.some((arg) => arg.includes('PLOINKY_AGENT_SECRET')));
        assert.ok(started.execId);
        const strangerCwd = manager.start({ snapshot: snapshot(), caller: CALLER,
            body: JSON.stringify({ target: 'AchillesIDE/gitAgent', argv: ['/opt/node'], cwd: '/elsewhere' }) });
        await assert.rejects(strangerCwd, { code: 'AGENT_EXEC_CWD_UNAVAILABLE' });
    } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});

test('exec output is resumable, input reaches stdin, kill signals the tree and exit ends the stream', async () => {
    const manager = new AgentExecManager({
        listProcessTree: () => [7],
        killImpl: (pid, signal) => killed.push([pid, signal]),
        limits: { killGraceMs: 5, retainAfterExitMs: 5, maxBufferedOutputBytes: 6 },
    });
    const killed = [];
    const child = fakeChild();
    const entry = { id: 'f'.repeat(32), marker: 'm', callerId: CALLER.agentId, child, events: [], firstSeq: 0, nextSeq: 0,
        bufferedBytes: 0, exit: null, listeners: new Set() };
    manager.execs.set(entry.id, entry);
    manager.record(entry, 'stdout', Buffer.from('abc'));
    manager.record(entry, 'stderr', Buffer.from('de'));
    assert.throws(() => manager.owned(entry.id, { agentId: 'agent:other/x' }), { code: 'AGENT_EXEC_UNKNOWN' });
    manager.input(entry.id, CALLER, JSON.stringify({ data: Buffer.from('{"type":"prompt"}\n').toString('base64') }));
    assert.equal(Buffer.concat(child.written).toString(), '{"type":"prompt"}\n');
    const res = fakeResponse();
    manager.stream(entry.id, CALLER, 1, res);
    assert.deepEqual(res.lines().map((line) => [line.seq, line.type]), [[1, 'stderr']]);
    manager.record(entry, 'stdout', Buffer.from('fghijk'));
    assert.equal(entry.firstSeq, 2, 'old output is dropped past the buffer limit');
    const behind = fakeResponse();
    manager.stream(entry.id, CALLER, 0, behind);
    assert.equal(behind.lines()[0].type, 'gap');
    assert.deepEqual(manager.kill(entry.id, CALLER), { ok: true, finished: false });
    assert.deepEqual(killed, [[7, 'SIGTERM']]);
    manager.finish(entry, { code: 0, signal: null });
    assert.equal(res.ended, true);
    assert.deepEqual(res.lines().at(-1), { seq: 3, type: 'exit', code: 0, signal: null });
    assert.throws(() => manager.input(entry.id, CALLER, '{}'), { code: 'AGENT_EXEC_FINISHED' });
    assert.ok(AGENT_EXEC_PATH.startsWith('/api/edge/'));
});

test('agent exec callers come from the generation manifests and never change the compiled generation', async () => {
    const { agentExecConsumersOf } = await import('../../cli/sandbox/edgeGeneration.js');
    const generation = {
        routing: { routes: {
            roboTeamAgent: { repo: 'AchillesIDE', agent: 'roboTeamAgent', container: 'rt' },
            gitAgent: { repo: 'AchillesIDE', agent: 'gitAgent', container: 'git' },
        } },
        manifests: { roboTeamAgent: { routerAccess: { agentExec: true } }, gitAgent: {} },
        agents: {
            rt: { type: 'agent', repoName: 'AchillesIDE', agentName: 'roboTeamAgent', instanceId: 'i', enableGeneration: 'g' },
            git: { type: 'agent', repoName: 'AchillesIDE', agentName: 'gitAgent', instanceId: 'j', enableGeneration: 'h' },
        },
    };
    assert.deepEqual(agentExecConsumersOf(generation).map((entry) => [entry.agentId, entry.instanceId]),
        [['agent:AchillesIDE/roboTeamAgent', 'i']]);
    assert.deepEqual(agentExecConsumersOf({}), []);
    const source = fs.readFileSync(new URL('../../cli/sandbox/edgeGeneration.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /agentExecConsumers,/, 'compiled.security keeps its existing fields');
});
