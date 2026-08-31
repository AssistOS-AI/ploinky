import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildAgentWorkerEnvironment } from '../../cli/server/webtty/agentWorkerEnvironment.mjs';
import {
    AGENT_WORKER_CLEANUP_DEADLINE_MS,
    AgentTerminalWorker,
    agentFallbackReadinessCommand,
    agentReadinessCommand,
    captureExactAgentPodmanClient,
    drainExactAgentExecRecordAsync,
    fixedAgentPodmanArgv,
    inspectExactAgentTarget,
    inspectExactAgentTargetAsync,
    selectExactNewExecId,
} from '../../cli/server/webtty/agentTerminalWorker.mjs';
import { agentWorkerMessage } from '../../cli/server/webtty/agentWorkerProtocol.mjs';

const TERMINAL_ID = 'abcdefghijklmnopqrstuvwx';
const CONTAINER_ID = 'a'.repeat(64);
const EXEC_ID = 'b'.repeat(64);
const MARKER = 'marker_abcdefghijklmnopqrstuvwx';
const READINESS_CHALLENGE = 'c'.repeat(43);
const FALLBACK_READINESS_CHALLENGE = 'd'.repeat(43);
const STALE_READINESS_CHALLENGE = 's'.repeat(43);
const MARKER_ARGUMENT = `ploinky-webtty-marker:${MARKER}`;
const BASH_WRAPPER_COMMAND = 'PS1=\'$PWD $ \'; export PS1; /bin/bash --noprofile --norc; ploinky_webtty_status=$?; case "$ploinky_webtty_status" in 126|127) exit 124 ;; *) exit "$ploinky_webtty_status" ;; esac';
const SH_WRAPPER_COMMAND = 'PS1=\'$PWD $ \'; export PS1; /bin/sh -i; ploinky_webtty_status=$?; exit "$ploinky_webtty_status"';
const CLIENT = Object.freeze({
    pid: 4200,
    uid: 1000,
    startToken: 'linux-proc:42000',
    processGroupId: 4200,
    sessionId: 4200,
    foregroundProcessGroupId: 4200,
    ttyNumber: 34816,
});

test('Podman client capture independently binds UID and exact fixed argv', () => {
    const args = fixedAgentPodmanArgv(init());
    const identity = {
        pid: 4200,
        startToken: 'linux-proc:42000',
        processGroupId: 4200,
        sessionId: 4200,
        foregroundProcessGroupId: 4200,
        ttyNumber: 34816,
    };
    const files = new Map([
        ['/proc/4200/status', 'Name:\tpodman\nUid:\t1000\t1000\t1000\t1000\n'],
        ['/proc/4200/cmdline', Buffer.from(['/usr/bin/podman', ...args, ''].join('\0'))],
    ]);
    assert.deepEqual(captureExactAgentPodmanClient(4200, args, {
        fsApi: { readFileSync: (name) => files.get(name) },
        capturePty: () => identity,
    }), { ...identity, uid: 1000 });
    files.set('/proc/4200/cmdline', Buffer.from('/usr/bin/podman\0container\0exec\0--privileged\0'));
    assert.throws(() => captureExactAgentPodmanClient(4200, args, {
        fsApi: { readFileSync: (name) => files.get(name) },
        capturePty: () => identity,
    }));
});
const INNER = Object.freeze({
    boxPid: 4300,
    boxStartToken: 'linux-proc:43000',
    boxProcessGroupId: 4300,
    boxSessionId: 4300,
    pidNamespace: 'pid:[9001]',
    nspid: Object.freeze([4300, 42]),
    nspgid: Object.freeze([4300, 42]),
    nssid: Object.freeze([4300, 42]),
    innerPid: 42,
    innerProcessGroupId: 42,
    innerSessionId: 42,
    innerUid: 1000,
    innerStartToken: 'linux-proc:43000',
    containerInitBoxPid: 4299,
    containerInitStartToken: 'linux-proc:42990',
});

function markerWrapperIdentity(overrides = {}) {
    return {
        pid: INNER.boxPid,
        state: 'S',
        startToken: INNER.boxStartToken,
        parentPid: INNER.containerInitBoxPid,
        processGroupId: INNER.boxProcessGroupId,
        sessionId: INNER.boxSessionId,
        pidNamespace: INNER.pidNamespace,
        nspid: INNER.nspid,
        nspgid: INNER.nspgid,
        nssid: INNER.nssid,
        innerUid: INNER.innerUid,
        argv: [
            '/bin/bash', '--noprofile', '--norc', '-p', '-c',
            BASH_WRAPPER_COMMAND, MARKER_ARGUMENT,
        ],
        ...overrides,
    };
}
class FakeProcess extends EventEmitter {
    constructor() {
        super();
        this.connected = true;
        this.sent = [];
        this.exitCode = null;
    }

    send(message, callback) {
        this.sent.push(message);
        callback?.(null);
    }

    disconnect() { this.connected = false; }
    exit() {}
}

function init(overrides = {}) {
    return agentWorkerMessage('init-agent', TERMINAL_ID, {
        runtime: 'podman',
        containerId: CONTAINER_ID,
        targetUser: '1000:1000',
        translatedCwd: '/workspace/demo',
        marker: MARKER,
        cols: 80,
        rows: 24,
        ...overrides,
    });
}

function harness(overrides = {}) {
    const processApi = new FakeProcess();
    const ptyState = {
        writes: [], resizes: [], kills: [], disposed: 0, onData: null, onExit: null,
    };
    const spawnCalls = [];
    let inspectionCalls = 0;
    const inspectTarget = () => {
        inspectionCalls += 1;
        return {
            absent: false,
            id: CONTAINER_ID,
            running: true,
            initPid: 4299,
            execIds: inspectionCalls === 1 ? [] : [EXEC_ID],
        };
    };
    const pty = {
        pid: 4200,
        onData(handler) {
            ptyState.onData = handler;
            if (overrides.preReadinessOutput) handler(overrides.preReadinessOutput);
        },
        onExit(handler) { ptyState.onExit = handler; },
        write(data) {
            ptyState.writes.push(data);
            if (data.includes('__PLOINKY_AGENT_READY__')) {
                ptyState.onData(`${data.replace(/\r$/, '')}\r\n`);
                if (overrides.autoReady !== false) {
                    ptyState.onData(`__PLOINKY_AGENT_READY__${MARKER}|${READINESS_CHALLENGE}|42|42|42|1000|43000\r\n`);
                }
            }
        },
        resize(cols, rows) { ptyState.resizes.push([cols, rows]); },
        kill(signal) { ptyState.kills.push(signal); },
        dispose() { ptyState.disposed += 1; },
    };
    const exactInspectTarget = overrides.inspectTarget || inspectTarget;
    const exactDrainExec = overrides.drainExec || (() => 'automatic');
    const worker = new AgentTerminalWorker({
        processApi,
        workerEnvironment: buildAgentWorkerEnvironment(),
        loadNodePty: () => ({
            spawn(command, args, options) {
                spawnCalls.push({ command, args, options });
                return pty;
            },
        }),
        inspectTarget: exactInspectTarget,
        inspectTargetCleanup: overrides.inspectTargetCleanup
            || (async (containerId, options) => exactInspectTarget(containerId, options)),
        drainExecCleanup: overrides.drainExecCleanup
            || (async (containerId, execId, options) => exactDrainExec(
                containerId,
                execId,
                options,
            )),
        captureClient: overrides.captureClient || (() => CLIENT),
        captureInner: overrides.captureInner || (async () => INNER),
        captureSession: overrides.captureSession || (async () => []),
        listSession: overrides.listSession || (async () => []),
        signalSession: overrides.signalSession || (async () => {}),
        readInnerIdentity: overrides.readInnerIdentity || (async (pid) => {
            if (pid === 4299) return {
                pid: 4299,
                state: 'S',
                startToken: 'linux-proc:42990',
                pidNamespace: 'pid:[9001]',
            };
            const error = new Error('gone');
            error.code = 'WEBTTY_AGENT_PROCESS_IDENTITY_STALE';
            throw error;
        }),
        signalClient: overrides.signalClient || (() => {}),
        waitClientExit: overrides.waitClientExit || (async () => true),
        createReadinessChallenge: overrides.createReadinessChallenge
            || (() => {
                assert.equal(spawnCalls.length > 0, true, 'challenge must be generated post-spawn');
                return READINESS_CHALLENGE;
            }),
        startupTimeoutMs: 100,
    });
    return { worker, processApi, ptyState, spawnCalls };
}

test('fixed backend argv contains no browser-controlled shell, flags, env, or no-session mode', () => {
    const argv = fixedAgentPodmanArgv(init());
    assert.deepEqual(argv, [
        'container', 'exec', '--interactive', '--tty',
        '--user', '1000:1000',
        '--workdir', '/workspace/demo',
        '--env', 'TERM=xterm-256color',
        '--env', 'PS1=$PWD $ ',
        '--env', `PLOINKY_WEBTTY_MARKER=${MARKER}`,
        CONTAINER_ID,
        '/bin/bash', '--noprofile', '--norc', '-p', '-c',
        BASH_WRAPPER_COMMAND, MARKER_ARGUMENT,
    ]);
    assert.equal(argv.includes('--no-session'), false);
    assert.equal(argv.includes('--privileged'), false);
    assert.equal(argv.includes(READINESS_CHALLENGE), false);
});

test('Bash and sh use exact fixed same-shell wrapper argv and marker position', () => {
    for (const [shell, shellArgs] of [
        ['/bin/bash', ['--noprofile', '--norc', '-p', '-c', BASH_WRAPPER_COMMAND, MARKER_ARGUMENT]],
        ['/bin/sh', ['-p', '-c', SH_WRAPPER_COMMAND, MARKER_ARGUMENT]],
    ]) {
        const argv = fixedAgentPodmanArgv(init(), shell);
        assert.deepEqual(argv.slice(-(2 + shellArgs.length)), [
            CONTAINER_ID,
            shell,
            ...shellArgs,
        ]);
        assert.equal(argv.includes('--no-session'), false);
        assert.equal(argv.includes('/usr/local/bin/node'), false);
        assert.equal(argv.at(-1), MARKER_ARGUMENT);
    }
});

test('the Bash wrapper cannot forward target-controlled fallback statuses', () => {
    for (const status of [126, 127]) {
        const result = spawnSync('/bin/bash', [
            '--noprofile', '--norc', '-p', '-c',
            BASH_WRAPPER_COMMAND,
            MARKER_ARGUMENT,
        ], {
            encoding: 'utf8',
            input: `exit ${status}\n`,
            timeout: 1_000,
        });
        assert.equal(result.status, 124, result.stderr);
        assert.equal(result.signal, null);
    }
});

test('worker cleanup has a hard deadline below the Router-side worker grace', async () => {
    assert.equal(AGENT_WORKER_CLEANUP_DEADLINE_MS < 8_500, true);
    const h = harness({
        captureSession: () => new Promise(() => {}),
    });
    h.worker.cleanupDeadlineMs = 20;
    await h.worker.initialize(init());
    await h.worker.launch();
    await h.worker.cleanup('requested');
    assert.equal(h.processApi.sent.some((message) => (
        message.type === 'error' && message.category === 'cleanup-unproven'
    )), true);
    assert.equal(h.processApi.sent.some((message) => (
        message.type === 'exit' && message.cleanupProven === false
    )), true);
});

test('a hanging cleanup inspect finalizes before Router grace and cannot drain late evidence', async () => {
    let resolveInspect;
    let inspectOptions;
    let drainCalls = 0;
    const h = harness({
        captureSession: async () => [markerWrapperIdentity()],
        inspectTargetCleanup: (_containerId, options) => {
            inspectOptions = options;
            return new Promise((resolve) => { resolveInspect = resolve; });
        },
        drainExecCleanup: async () => { drainCalls += 1; },
    });
    // Keep the injected deadline far below Router grace while allowing this
    // test process to be descheduled during the repository-wide parallel run.
    h.worker.cleanupDeadlineMs = 500;
    await h.worker.initialize(init());
    await h.worker.launch();
    h.worker.execId = '';

    const startedAt = Date.now();
    await h.worker.cleanup('requested');
    const elapsed = Date.now() - startedAt;

    assert.equal(elapsed < 2_000, true, `cleanup took ${elapsed}ms`);
    assert.equal(elapsed < 8_500, true);
    assert.equal(inspectOptions.signal.aborted, true);
    assert.equal(inspectOptions.deadlineAt <= startedAt + 550, true);
    assert.equal(h.processApi.sent.find((message) => message.type === 'exit')?.cleanupProven, false);
    resolveInspect({
        absent: false,
        id: CONTAINER_ID,
        running: true,
        initPid: 4299,
        execIds: [EXEC_ID],
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(drainCalls, 0);
    assert.equal(h.worker.execId, '');
});

test('a late client-exit check cannot send SIGKILL after cleanup finalization', async () => {
    let resolveClientExit;
    const signals = [];
    const h = harness({
        signalClient: (_identity, signal) => signals.push(signal),
        waitClientExit: () => new Promise((resolve) => { resolveClientExit = resolve; }),
    });
    h.worker.cleanupDeadlineMs = 25;
    await h.worker.initialize(init());
    await h.worker.launch();
    await h.worker.cleanup('requested');
    assert.deepEqual(signals, ['SIGTERM']);
    resolveClientExit(false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(signals, ['SIGTERM']);
});

test('fallback readiness proves Bash is truly absent without a second exec topology', () => {
    const command = agentFallbackReadinessCommand(READINESS_CHALLENGE);
    assert.match(command, /^\[ ! -e \/bin\/bash \] \|\| exit 125; /);
    assert.equal(command.includes('--no-session'), false);
    assert.equal(command.endsWith('\r'), true);
    assert.throws(
        () => agentReadinessCommand('not-cryptographic-length'),
        (error) => error.code === 'WEBTTY_AGENT_READINESS_CHALLENGE_INVALID',
    );
});

test('readiness uses only shell and procfs primitives and cannot be satisfied by command echo', (t) => {
    const command = agentReadinessCommand(READINESS_CHALLENGE);
    assert.equal(command.includes(MARKER), false);
    assert.doesNotMatch(command.slice(0, -1), /[\x00-\x1f\x7f]/,
        'Readline must receive no literal control byte in the server command');
    assert.match(command, /\/proc\/\$\$\/stat/);
    assert.match(command, /\/proc\/\$\$\/status/);
    for (const unavailableDependency of [' ps ', ' id ', ' tr ', ' awk ', ' sed ']) {
        assert.equal(command.includes(unavailableDependency), false, unavailableDependency);
    }
    const procFixture = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-agent-proc-'));
    t.after(() => fs.rmSync(procFixture, { recursive: true, force: true }));
    const statTail = ['S', '1', '42', '42', ...Array(15).fill('0'), '98765', '0'];
    fs.writeFileSync(path.join(procFixture, 'stat'), `42 (sh) ${statTail.join(' ')}\n`);
    fs.writeFileSync(path.join(procFixture, 'status'), 'Name:\tsh\nUid:\t1234\t1234\t1234\t1234\n');
    const fixtureCommand = command
        .replaceAll('/proc/$$/stat', `${procFixture}/stat`)
        .replaceAll('/proc/$$/status', `${procFixture}/status`)
        .replace(/\r$/, '');
    const preserved = [
        'ploinky_agent_stat=keep-stat',
        'ploinky_agent_tail=keep-tail',
        'ploinky_agent_start=keep-start',
        'ploinky_agent_uid=keep-uid',
        'ploinky_agent_key=keep-key',
        'ploinky_agent_value=keep-value',
        'ploinky_agent_rest=keep-rest',
    ].join('; ');
    const stateFrame = "printf '__PLOINKY_AGENT_STATE__%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s\\n' \"$IFS\" \"$#\" \"$1\" \"$2\" \"$ploinky_agent_stat\" \"$ploinky_agent_tail\" \"$ploinky_agent_start\" \"$ploinky_agent_uid\" \"$ploinky_agent_key\" \"$ploinky_agent_value\" \"$ploinky_agent_rest\" \"$$\"";
    for (const [shellPath, shellArgs] of [
        ['/bin/bash', ['--noprofile', '--norc', '-c']],
        ['/bin/sh', ['-c']],
    ]) {
        const script = `IFS=:; set -- keep-one keep-two; ${preserved}; ${fixtureCommand}; ${stateFrame}`;
        const result = spawnSync(shellPath, [...shellArgs, script], {
            encoding: 'utf8',
            env: { ...process.env, PLOINKY_WEBTTY_MARKER: MARKER },
        });
        assert.equal(result.status, 0, `${shellPath}: ${result.stderr}`);
        const match = result.stdout.match(new RegExp(
            `__PLOINKY_AGENT_READY__${MARKER}\\|${READINESS_CHALLENGE}\\|(\\d+)\\|(\\d+)\\|(\\d+)\\|(\\d+)\\|(\\d+)\\n`,
        ));
        assert.ok(match, `${shellPath}: ${result.stdout}`);
        assert.equal(Number(match[2]), 42);
        assert.equal(Number(match[3]), 42);
        assert.equal(Number(match[4]), 1234);
        assert.equal(Number(match[5]), 98765);
        assert.match(result.stdout, new RegExp(
            `__PLOINKY_AGENT_STATE__:\\|2\\|keep-one\\|keep-two\\|keep-stat\\|keep-tail\\|keep-start\\|keep-uid\\|keep-key\\|keep-value\\|keep-rest\\|${match[1]}\\n$`,
        ), shellPath);
    }
});

test('worker proves numeric marker readiness, exact ExecID, and inner namespace before ready', async () => {
    const h = harness();
    await h.worker.initialize(init());
    const prepared = h.processApi.sent.find((message) => message.type === 'prepared');
    assert.deepEqual(prepared.startupEvidence.baselineExecIds, []);
    await h.worker.launch();
    assert.equal(h.spawnCalls.length, 1);
    assert.equal(h.spawnCalls[0].command, '/usr/bin/podman');
    assert.deepEqual(h.spawnCalls[0].args, fixedAgentPodmanArgv(init()));
    const ready = h.processApi.sent.find((message) => message.type === 'ready');
    assert.equal(ready.recoveryEvidence.execId, EXEC_ID);
    assert.deepEqual(ready.recoveryEvidence.clientProcess, CLIENT);
    assert.deepEqual(ready.recoveryEvidence.innerProcess, INNER);
    assert.equal(JSON.stringify(ready).includes(READINESS_CHALLENGE), false);
    assert.equal(JSON.stringify(prepared).includes(READINESS_CHALLENGE), false);
    assert.equal(
        h.processApi.sent.some((message) => message.type === 'output'
            && message.data.includes('__PLOINKY_AGENT_READY__')),
        false,
    );
    assert.equal(
        h.processApi.sent.some((message) => message.type === 'output'
            && message.data.includes('ploinky_agent_stat')),
        false,
    );

    h.worker.handleMessage(agentWorkerMessage('input', TERMINAL_ID, { data: 'pwd\r' }));
    h.worker.handleMessage(agentWorkerMessage('resize', TERMINAL_ID, { cols: 120, rows: 40 }));
    assert.equal(h.ptyState.writes.at(-1), 'pwd\r');
    assert.deepEqual(h.ptyState.resizes, [[120, 40]]);
});

test('Bash PROMPT_COMMAND cannot pre-emit readiness without the post-spawn challenge', async () => {
    let captureCalls = 0;
    const h = harness({
        autoReady: false,
        preReadinessOutput: [
            `__PLOINKY_AGENT_READY__${MARKER}|42|42|42|1000|43000\r\n`,
            `__PLOINKY_AGENT_READY__${MARKER}|${STALE_READINESS_CHALLENGE}|42|42|42|1000|43000\r\n`,
        ].join(''),
        captureInner: async () => { captureCalls += 1; return INNER; },
    });
    await h.worker.initialize(init());
    const launching = h.worker.launch();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(captureCalls, 0);
    assert.equal(h.processApi.sent.some((message) => message.type === 'ready'), false);
    assert.equal(h.ptyState.writes[0].includes(READINESS_CHALLENGE), true);

    h.ptyState.onData(`__PLOINKY_AGENT_READY__${MARKER}|${READINESS_CHALLENGE}|42|42|42|1000|43000\r\n`);
    await launching;
    assert.equal(captureCalls, 1);
    assert.equal(h.processApi.sent.some((message) => message.type === 'ready'), true);
});

test('sh ENV cannot pre-emit readiness without the post-spawn challenge', async () => {
    let captureCalls = 0;
    const h = harness({
        autoReady: false,
        preReadinessOutput: `__PLOINKY_AGENT_READY__${MARKER}|${STALE_READINESS_CHALLENGE}|42|42|42|1000|43000\r\n`,
        captureInner: async () => { captureCalls += 1; return INNER; },
    });
    await h.worker.initialize(init());
    const starting = h.worker.spawnAttempt('/bin/sh', true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(captureCalls, 0);
    assert.equal(h.ptyState.writes[0], agentFallbackReadinessCommand(READINESS_CHALLENGE));

    h.ptyState.onData(`__PLOINKY_AGENT_READY__${MARKER}|${READINESS_CHALLENGE}|42|42|42|1000|43000\r\n`);
    await starting;
    assert.equal(captureCalls, 1);
});

test('worker passes the server marker into exact cmdline-correlated inner capture', async () => {
    for (const category of ['marker-correlation', 'inner-topology']) {
        let captureRequest;
        const h = harness({
            captureInner: async (request) => {
                captureRequest = request;
                const error = new Error(`capture failed: ${category}`);
                error.code = 'WEBTTY_AGENT_PROCESS_IDENTITY_UNPROVEN';
                error.category = category;
                throw error;
            },
        });
        await h.worker.initialize(init());
        await h.worker.launch();
        assert.equal(captureRequest.marker, MARKER);
        assert.equal(captureRequest.containerInitBoxPid, 4299);
        assert.equal(captureRequest.shellPath, '/bin/bash');
        assert.equal(
            h.processApi.sent.some((message) => message.type === 'ready'),
            false,
            category,
        );
        assert.equal(h.processApi.sent.some((message) => (
            message.type === 'error' && message.category === 'target-evidence'
        )), true, category);
    }
});

test('startup refuses concurrent ExecID additions instead of claiming either', async () => {
    const foreignExecId = 'c'.repeat(64);
    const inspections = [
        { absent: false, id: CONTAINER_ID, running: true, initPid: 4299, execIds: [] },
        {
            absent: false,
            id: CONTAINER_ID,
            running: true,
            initPid: 4299,
            execIds: [EXEC_ID, foreignExecId],
        },
    ];
    const h = harness({ inspectTarget: () => inspections.shift() });
    await h.worker.initialize(init());
    await h.worker.launch();
    assert.equal(h.processApi.sent.some((message) => message.type === 'ready'), false);
    assert.equal(h.processApi.sent.some((message) => (
        message.type === 'error' && message.category === 'target-stale'
    )), true);
});

test('true Bash absence falls back through the same persistent identity-captured backend', async () => {
    const processApi = new FakeProcess();
    const spawnCalls = [];
    const disposals = [];
    let spawnIndex = 0;
    const makePty = (index) => {
        const state = { onData: null, onExit: null };
        return {
            pid: 4200 + index,
            onData(handler) { state.onData = handler; },
            onExit(handler) { state.onExit = handler; },
            write(command) {
                if (index === 0) {
                    state.onData('Error: stat /bin/bash: no such file or directory\r\n');
                    state.onExit({ exitCode: 127, signal: null });
                    return;
                }
                assert.equal(command, agentFallbackReadinessCommand(FALLBACK_READINESS_CHALLENGE));
                state.onData(`__PLOINKY_AGENT_READY__${MARKER}|${FALLBACK_READINESS_CHALLENGE}|42|42|42|1000|43000\r\n`);
            },
            dispose() { disposals.push(index); },
            resize() {},
        };
    };
    const inspections = [
        { absent: false, id: CONTAINER_ID, running: true, initPid: 4299, execIds: [] },
        { absent: false, id: CONTAINER_ID, running: true, initPid: 4299, execIds: [] },
        { absent: false, id: CONTAINER_ID, running: true, initPid: 4299, execIds: [EXEC_ID] },
    ];
    const inspectTarget = () => inspections.shift();
    const worker = new AgentTerminalWorker({
        processApi,
        workerEnvironment: buildAgentWorkerEnvironment(),
        loadNodePty: () => ({
            spawn(command, args, options) {
                spawnCalls.push({ command, args, options });
                return makePty(spawnIndex++);
            },
        }),
        inspectTarget,
        inspectTargetCleanup: async () => inspectTarget(),
        captureClient: (pid) => ({ ...CLIENT, pid, processGroupId: pid, sessionId: pid }),
        captureInner: async () => INNER,
        captureSession: async () => [],
        listSession: async () => [],
        signalSession: async () => {},
        readInnerIdentity: async (pid) => (pid === 4299 ? {
            pid,
            state: 'S',
            startToken: 'linux-proc:42990',
            pidNamespace: 'pid:[9001]',
        } : (() => {
            const error = new Error('gone');
            error.code = 'WEBTTY_AGENT_PROCESS_IDENTITY_STALE';
            throw error;
        })()),
        signalClient: () => {},
        waitClientExit: async () => true,
        drainExecCleanup: async () => 'automatic',
        createReadinessChallenge: (() => {
            const challenges = [READINESS_CHALLENGE, FALLBACK_READINESS_CHALLENGE];
            return () => challenges.shift();
        })(),
        startupTimeoutMs: 100,
    });
    await worker.initialize(init());
    await worker.launch();
    assert.equal(spawnCalls.length, 2);
    assert.deepEqual(spawnCalls[0].args, fixedAgentPodmanArgv(init(), '/bin/bash'));
    assert.deepEqual(spawnCalls[1].args, fixedAgentPodmanArgv(init(), '/bin/sh'));
    assert.equal(spawnCalls.flatMap((call) => call.args).includes('--no-session'), false);
    assert.deepEqual(disposals, [0]);
    assert.equal(processApi.sent.some((message) => message.type === 'ready'), true);
});

test('cleanup signals the captured inner session, then client, and drains only its ExecID', async () => {
    const calls = [];
    const h = harness({
        captureSession: async () => [{
            pid: 4300,
            startToken: 'linux-proc:43000',
            pidNamespace: 'pid:[9001]',
            nssid: [4300, 42],
        }],
        signalSession: async (_snapshot, signal) => calls.push(`inner:${signal}`),
        signalClient: (_identity, signal) => calls.push(`client:${signal}`),
        drainExec: (containerId, execId) => calls.push(`drain:${containerId}:${execId}`),
    });
    await h.worker.initialize(init());
    await h.worker.launch();
    await h.worker.cleanup('requested');
    assert.deepEqual(calls, [
        'inner:SIGTERM',
        'client:SIGTERM',
        `drain:${CONTAINER_ID}:${EXEC_ID}`,
    ]);
    assert.equal(h.processApi.sent.some((message) => (
        message.type === 'error' && message.category === 'cleanup-unproven'
    )), false);
});

test('cleanup correlates and drains a sole ExecID only while its exact marker is live', async () => {
    const drained = [];
    let inspections = 0;
    let markerLive = true;
    const h = harness({
        inspectTarget: () => {
            inspections += 1;
            if (inspections === 2) {
                const error = new Error('inspect failed after inner capture');
                error.code = 'WEBTTY_AGENT_PODMAN_FAILURE';
                error.category = 'inspect';
                throw error;
            }
            return {
                absent: false,
                id: CONTAINER_ID,
                running: true,
                initPid: 4299,
                execIds: inspections === 1 ? [] : [EXEC_ID],
            };
        },
        captureSession: async () => (markerLive ? [markerWrapperIdentity()] : []),
        signalSession: async (_snapshot, signal) => {
            if (signal === 'SIGTERM') markerLive = false;
        },
        readInnerIdentity: async (pid) => {
            if (pid === INNER.containerInitBoxPid) return {
                pid,
                state: 'S',
                startToken: INNER.containerInitStartToken,
                pidNamespace: INNER.pidNamespace,
            };
            if (pid === INNER.boxPid && markerLive) return markerWrapperIdentity();
            const error = new Error('gone');
            error.code = 'WEBTTY_AGENT_PROCESS_IDENTITY_STALE';
            throw error;
        },
        drainExec: (containerId, execId) => drained.push([containerId, execId]),
    });
    await h.worker.initialize(init());
    await h.worker.launch();
    assert.deepEqual(drained, [[CONTAINER_ID, EXEC_ID]]);
    assert.equal(h.processApi.sent.find((message) => message.type === 'exit')?.cleanupProven, true);
});

test('pre-ready cleanup never transfers marker ownership to a replacement foreign ExecID', async () => {
    const foreignExecId = 'f'.repeat(64);
    const drained = [];
    const signaled = [];
    let inspections = 0;
    let markerLive = true;
    let currentExecId = EXEC_ID;
    const h = harness({
        inspectTarget: () => {
            inspections += 1;
            if (inspections === 2) {
                const error = new Error('inspect failed after inner capture');
                error.code = 'WEBTTY_AGENT_PODMAN_FAILURE';
                error.category = 'inspect';
                throw error;
            }
            return {
                absent: false,
                id: CONTAINER_ID,
                running: true,
                initPid: INNER.containerInitBoxPid,
                execIds: inspections === 1 ? [] : [currentExecId],
            };
        },
        captureSession: async () => (markerLive ? [markerWrapperIdentity()] : []),
        listSession: async () => [],
        signalSession: async (_snapshot, signal) => {
            signaled.push(signal);
            if (signal === 'SIGTERM') {
                markerLive = false;
                currentExecId = foreignExecId;
            }
        },
        readInnerIdentity: async (pid) => {
            if (pid === INNER.containerInitBoxPid) return {
                pid,
                state: 'S',
                startToken: INNER.containerInitStartToken,
                pidNamespace: INNER.pidNamespace,
            };
            if (pid === INNER.boxPid && markerLive) return markerWrapperIdentity();
            const error = new Error('gone');
            error.code = 'WEBTTY_AGENT_PROCESS_IDENTITY_STALE';
            throw error;
        },
        drainExec: (_containerId, execId) => drained.push(execId),
    });

    await h.worker.initialize(init());
    await h.worker.launch();

    assert.deepEqual(signaled, ['SIGTERM']);
    assert.deepEqual(drained, [EXEC_ID]);
    assert.equal(drained.includes(foreignExecId), false);
    assert.equal(currentExecId, foreignExecId,
        'the unrelated replacement must remain outside WebTTY cleanup ownership');
    assert.equal(h.processApi.sent.find((message) => message.type === 'exit')?.cleanupProven, true);
});

test('a spawned PTY without exact client/inner identity reports cleanup unproven', async () => {
    let challengeCalls = 0;
    const h = harness({
        captureClient: () => { throw new Error('unreadable client identity'); },
        createReadinessChallenge: () => {
            challengeCalls += 1;
            return READINESS_CHALLENGE;
        },
    });
    await h.worker.initialize(init());
    await h.worker.launch();
    assert.equal(h.processApi.sent.some((message) => (
        message.type === 'error' && message.category === 'cleanup-unproven'
    )), true);
    assert.equal(challengeCalls, 0);
    assert.deepEqual(h.ptyState.writes, []);
    assert.deepEqual(h.ptyState.kills, []);
    assert.equal(h.ptyState.disposed, 0);
});

test('a PTY exit during identity capture cannot turn an unproved startup into proved cleanup', async () => {
    const drained = [];
    let worker;
    const h = harness({
        captureClient: () => {
            worker.handlePtyExit({ exitCode: 1, signal: null });
            const error = new Error('unreadable client identity');
            error.code = 'WEBTTY_PROCESS_IDENTITY_UNPROVEN';
            throw error;
        },
        drainExec: (...args) => drained.push(args),
    });
    worker = h.worker;
    await worker.initialize(init());
    await worker.launch();
    assert.equal(h.processApi.sent.some((message) => (
        message.type === 'error' && message.category === 'cleanup-provider-unproven'
    )), true);
    assert.equal(h.processApi.sent.find((message) => message.type === 'exit')?.cleanupProven, false);
    assert.deepEqual(drained, []);
    assert.equal(h.ptyState.disposed, 0);
});

test('pre-ready cleanup never claims a sole foreign ExecID from an uncorrelated diff', async () => {
    const drained = [];
    const processApi = new FakeProcess();
    const pty = {
        pid: 4200,
        onData() {},
        onExit() {},
        write() {},
        dispose() {},
    };
    const inspections = [
        { absent: false, id: CONTAINER_ID, running: true, initPid: 4299, execIds: [] },
        { absent: false, id: CONTAINER_ID, running: true, initPid: 4299, execIds: [EXEC_ID] },
    ];
    const inspectTarget = () => inspections.shift();
    const worker = new AgentTerminalWorker({
        processApi,
        workerEnvironment: buildAgentWorkerEnvironment(),
        loadNodePty: () => ({ spawn: () => pty }),
        inspectTarget,
        inspectTargetCleanup: async () => inspectTarget(),
        drainExecCleanup: async (...args) => drained.push(args),
        captureClient: () => { throw new Error('spawn failed before owned exec'); },
        readInnerIdentity: async (pid) => ({
            pid,
            state: 'S',
            startToken: 'linux-proc:42990',
            pidNamespace: 'pid:[9001]',
        }),
        startupTimeoutMs: 1,
    });
    await worker.initialize(init());
    await worker.launch();
    assert.deepEqual(drained, []);
    assert.equal(processApi.sent.find((message) => message.type === 'exit')?.cleanupProven, false);
});

test('systemic Podman startup and cleanup evidence failures retain provider scope', async () => {
    const startupProcess = new FakeProcess();
    const startupWorker = new AgentTerminalWorker({
        processApi: startupProcess,
        workerEnvironment: buildAgentWorkerEnvironment(),
        inspectTarget: () => {
            const error = new Error('Podman inspect unavailable');
            error.code = 'WEBTTY_AGENT_PODMAN_FAILURE';
            error.category = 'inspect';
            throw error;
        },
    });
    await startupWorker.initialize(init());
    assert.equal(startupProcess.sent.some((message) => (
        message.type === 'error' && message.category === 'provider-evidence'
    )), true);

    const cleanup = harness({
        drainExecCleanup: async () => {
            const error = new Error('Podman cleanup unavailable');
            error.code = 'WEBTTY_AGENT_PODMAN_FAILURE';
            error.category = 'exec-cleanup';
            throw error;
        },
    });
    await cleanup.worker.initialize(init());
    await cleanup.worker.launch();
    await cleanup.worker.cleanup('requested');
    assert.equal(cleanup.processApi.sent.some((message) => (
        message.type === 'error' && message.category === 'cleanup-provider-unproven'
    )), true);
});

test('exact-target inner ambiguity and marker correlation failures remain target scoped', async () => {
    for (const category of ['inner-process-ambiguity', 'marker-correlation']) {
        const h = harness({
            captureInner: async () => {
                const error = new Error(`exact target process evidence failed: ${category}`);
                error.code = 'WEBTTY_AGENT_PROCESS_IDENTITY_UNPROVEN';
                error.category = category;
                throw error;
            },
        });
        await h.worker.initialize(init());
        await h.worker.launch();
        assert.equal(h.processApi.sent.some((message) => (
            message.type === 'error' && message.category === 'target-evidence'
        )), true, category);
        assert.equal(h.processApi.sent.some((message) => (
            message.type === 'error' && message.category === 'provider-evidence'
        )), false, category);
    }
});

test('an exact exec residue remains target-scoped rather than disabling all agents', async () => {
    const h = harness({
        drainExec: () => {
            const error = new Error('exact exec survived cleanup');
            error.code = 'WEBTTY_AGENT_PODMAN_FAILURE';
            error.category = 'exec-not-drained';
            throw error;
        },
    });
    await h.worker.initialize(init());
    await h.worker.launch();
    await h.worker.cleanup('requested');
    assert.equal(h.processApi.sent.some((message) => (
        message.type === 'error' && message.category === 'cleanup-unproven'
    )), true);
    assert.equal(h.processApi.sent.some((message) => (
        message.type === 'error' && message.category === 'cleanup-provider-unproven'
    )), false);
});

test('a missing exact session anchor quarantines only the target', async () => {
    const h = harness({
        listSession: async () => {
            const error = new Error('recorded session leader exited first');
            error.code = 'WEBTTY_AGENT_PROCESS_IDENTITY_UNPROVEN';
            error.category = 'session-anchor-missing';
            throw error;
        },
    });
    await h.worker.initialize(init());
    await h.worker.launch();
    await h.worker.cleanup('requested');
    assert.equal(h.processApi.sent.some((message) => (
        message.type === 'error' && message.category === 'cleanup-unproven'
    )), true);
    assert.equal(h.processApi.sent.some((message) => (
        message.type === 'error' && message.category === 'cleanup-provider-unproven'
    )), false);
});

test('bounded exact inspect rejects mutable IDs and malformed exec records', () => {
    const result = (stdout, status = 0, stderr = '') => ({
        status,
        signal: null,
        stdout,
        stderr,
    });
    let observedCall;
    const options = {
        spawnSyncImpl: (command, args, spawnOptions) => {
            observedCall = { command, args, spawnOptions };
            return result(JSON.stringify([{
            Id: CONTAINER_ID,
            State: { Running: true, Pid: 4299 },
            ExecIDs: [EXEC_ID],
            }]));
        },
    };
    assert.deepEqual(inspectExactAgentTarget(CONTAINER_ID, options), {
        absent: false,
        id: CONTAINER_ID,
        running: true,
        initPid: 4299,
        execIds: [EXEC_ID],
    });
    assert.equal(observedCall.command, '/usr/bin/podman');
    assert.deepEqual(observedCall.args, ['container', 'inspect', CONTAINER_ID]);
    assert.equal(observedCall.spawnOptions.cwd, '/tmp');
    assert.equal(observedCall.spawnOptions.encoding, 'utf8');
    assert.equal(observedCall.spawnOptions.timeout, 5_000);
    assert.equal(observedCall.spawnOptions.killSignal, 'SIGKILL');
    assert.equal(observedCall.spawnOptions.maxBuffer, 1024 * 1024);
    assert.throws(() => inspectExactAgentTarget(CONTAINER_ID, {
        spawnSyncImpl: () => result(JSON.stringify([{ Id: 'short', State: { Running: true, Pid: 1 } }])),
    }));
    assert.throws(() => inspectExactAgentTarget(CONTAINER_ID, {
        spawnSyncImpl: () => result(JSON.stringify([{
            Id: CONTAINER_ID,
            State: { Running: true, Pid: 4299 },
            ExecIDs: ['mutable-name'],
        }])),
    }));
    assert.throws(() => inspectExactAgentTarget(CONTAINER_ID, {
        spawnSyncImpl: () => result('', 125, 'runtime database not found'),
    }), (error) => error.code === 'WEBTTY_AGENT_PODMAN_FAILURE'
        && error.category === 'inspect');
    for (const stdout of ['', '[]\n']) {
        assert.deepEqual(inspectExactAgentTarget(CONTAINER_ID, {
            spawnSyncImpl: () => result(stdout, 125, `Error: no such container "${CONTAINER_ID}"`),
        }), { absent: true, id: CONTAINER_ID });
    }
    assert.throws(() => inspectExactAgentTarget(CONTAINER_ID, {
        spawnSyncImpl: () => result('[]\nuntrusted', 125,
            `Error: no such container "${CONTAINER_ID}"`),
    }), (error) => error.code === 'WEBTTY_AGENT_PODMAN_FAILURE'
        && error.category === 'inspect');
    for (const stderr of [
        `Error: cannot connect to nested runtime: no such container ${CONTAINER_ID}`,
        `Error: permission denied; container ${CONTAINER_ID} does not exist in cached database`,
    ]) {
        assert.throws(() => inspectExactAgentTarget(CONTAINER_ID, {
            spawnSyncImpl: () => result('', 125, stderr),
        }), (error) => error.code === 'WEBTTY_AGENT_PODMAN_FAILURE'
            && error.category === 'inspect');
    }
    assert.throws(() => inspectExactAgentTarget(CONTAINER_ID, {
        spawnSyncImpl: () => result('', 1, `Error: no such container "${CONTAINER_ID}"`),
    }), (error) => error.code === 'WEBTTY_AGENT_PODMAN_FAILURE'
        && error.category === 'inspect');
});

test('cleanup Podman adapter uses async abortable calls against one absolute deadline', async () => {
    const controller = new AbortController();
    const deadlineAt = Date.now() + 500;
    const calls = [];
    const inspectWithExec = JSON.stringify([{
        Id: CONTAINER_ID,
        State: { Running: true, Pid: 4299 },
        ExecIDs: [EXEC_ID],
    }]);
    const inspectWithoutExec = JSON.stringify([{
        Id: CONTAINER_ID,
        State: { Running: true, Pid: 4299 },
        ExecIDs: [],
    }]);
    const outputs = [inspectWithExec, '', inspectWithoutExec];
    const result = await drainExactAgentExecRecordAsync(CONTAINER_ID, EXEC_ID, {
        deadlineAt,
        signal: controller.signal,
        timeoutMs: 500,
        execFileImpl(command, args, options, callback) {
            calls.push({ command, args, options });
            const stdout = outputs.shift();
            queueMicrotask(() => callback(null, stdout, ''));
        },
    });

    assert.equal(result, 'exact-container-cleanup');
    assert.deepEqual(calls.map((call) => call.args), [
        ['container', 'inspect', CONTAINER_ID],
        ['container', 'cleanup', '--stopped-only', '--rm', '--exec', EXEC_ID, CONTAINER_ID],
        ['container', 'inspect', CONTAINER_ID],
    ]);
    for (const call of calls) {
        assert.equal(call.command, '/usr/bin/podman');
        assert.equal(call.options.signal, controller.signal);
        assert.equal(call.options.killSignal, 'SIGKILL');
        assert.equal(call.options.timeout > 0 && call.options.timeout <= 500, true);
    }

    controller.abort();
    await assert.rejects(
        inspectExactAgentTargetAsync(CONTAINER_ID, {
            deadlineAt: Date.now() + 500,
            signal: controller.signal,
            execFileImpl: () => assert.fail('aborted operation must not spawn'),
        }),
        (error) => error.code === 'WEBTTY_AGENT_PODMAN_FAILURE'
            && error.category === 'deadline',
    );
});

test('ExecID selection tolerates unrelated removals but rejects concurrent additions', () => {
    const oldA = 'a'.repeat(64);
    const oldB = 'b'.repeat(64);
    const owned = 'c'.repeat(64);
    assert.equal(selectExactNewExecId([oldA, oldB], [oldB, owned]), owned);
    assert.throws(() => selectExactNewExecId([oldA], [oldA, owned, 'd'.repeat(64)]));
});
