import assert from 'node:assert/strict';
import test from 'node:test';

import {
    WEBTTY_AGENT_BACKEND,
    WEBTTY_AGENT_PROTOCOL_LIMITS,
    WEBTTY_AGENT_WORKER_PROTOCOL,
    agentWorkerMessage,
    validateAgentWorkerToRouterMessage,
    validateRouterToAgentWorkerMessage,
} from '../../cli/server/webtty/agentWorkerProtocol.mjs';

const TERMINAL_ID = 'abcdefghijklmnopqrstuvwx';
const CONTAINER_ID = 'a'.repeat(64);
const EXEC_ID = 'b'.repeat(64);
const MARKER = 'marker_abcdefghijklmnopqrstuvwx';

function init(overrides = {}) {
    return agentWorkerMessage('init-agent', TERMINAL_ID, {
        runtime: 'podman',
        containerId: CONTAINER_ID,
        targetUser: '1000:1000',
        translatedCwd: '/workspace/repo/src',
        marker: MARKER,
        cols: 80,
        rows: 24,
        ...overrides,
    });
}

function recovery(overrides = {}) {
    return {
        backend: WEBTTY_AGENT_BACKEND,
        runtime: 'podman',
        containerId: CONTAINER_ID,
        targetUser: '1000:1000',
        translatedCwd: '/workspace/repo/src',
        marker: MARKER,
        execId: EXEC_ID,
        clientProcess: {
            pid: 4100,
            uid: 1000,
            startToken: 'linux-proc:41000',
            processGroupId: 4100,
            sessionId: 4100,
            foregroundProcessGroupId: 4100,
            ttyNumber: 34816,
        },
        innerProcess: {
            boxPid: 4200,
            boxStartToken: 'linux-proc:42000',
            boxProcessGroupId: 4200,
            boxSessionId: 4200,
            pidNamespace: 'pid:[9001]',
            nspid: [4200, 42],
            nspgid: [4200, 42],
            nssid: [4200, 42],
            innerPid: 42,
            innerProcessGroupId: 42,
            innerSessionId: 42,
            innerUid: 1000,
            innerStartToken: 'linux-proc:42000',
            containerInitBoxPid: 4199,
            containerInitStartToken: 'linux-proc:41990',
        },
        ...overrides,
    };
}

function startup(overrides = {}) {
    return {
        backend: WEBTTY_AGENT_BACKEND,
        runtime: 'podman',
        containerId: CONTAINER_ID,
        targetUser: '1000:1000',
        translatedCwd: '/workspace/repo/src',
        marker: MARKER,
        baselineExecIds: ['c'.repeat(64)],
        containerInitProcess: {
            pid: 4199,
            startToken: 'linux-proc:41990',
            pidNamespace: 'pid:[9001]',
        },
        ...overrides,
    };
}

test('agent protocol accepts only the exact ordered server-derived init', () => {
    assert.equal(validateRouterToAgentWorkerMessage(init()).type, 'init-agent');
    assert.equal(validateRouterToAgentWorkerMessage(
        agentWorkerMessage('start-agent', TERMINAL_ID),
        { initialized: true, expectedTerminalId: TERMINAL_ID },
    ).type, 'start-agent');
    assert.equal(validateRouterToAgentWorkerMessage(
        agentWorkerMessage('input', TERMINAL_ID, { data: 'pwd\r' }),
        { initialized: true, expectedTerminalId: TERMINAL_ID },
    ).type, 'input');
    assert.equal(validateRouterToAgentWorkerMessage(
        agentWorkerMessage('resize', TERMINAL_ID, { cols: 120, rows: 40 }),
        { initialized: true },
    ).type, 'resize');
    assert.equal(validateRouterToAgentWorkerMessage(
        agentWorkerMessage('close', TERMINAL_ID),
        { initialized: true, closing: true },
    ).type, 'close');
    assert.equal(validateRouterToAgentWorkerMessage(
        agentWorkerMessage('close', TERMINAL_ID),
        { initialized: false, closing: true },
    ).type, 'close');
    assert.throws(() => validateRouterToAgentWorkerMessage(
        agentWorkerMessage('input', TERMINAL_ID, { data: 'x' }),
    ), (error) => error.category === 'pre-init');
    assert.throws(() => validateRouterToAgentWorkerMessage(init(), { initialized: true }),
        (error) => error.category === 'duplicate-init');
});

test('browser-like exec fields, unknown runtime, and mutable identity fail closed', () => {
    for (const candidate of [
        { ...init(), shell: '/bin/zsh' },
        { ...init(), argv: ['-c', 'id'] },
        { ...init(), env: { TOKEN: 'secret' } },
        { ...init(), runtimeFlags: ['--privileged'] },
        init({ runtime: 'docker' }),
        init({ containerId: 'agent-name' }),
        init({ targetUser: '--privileged' }),
        init({ translatedCwd: '/workspace/../etc' }),
        init({ translatedCwd: 'relative/path' }),
    ]) assert.throws(() => validateRouterToAgentWorkerMessage(candidate));
    assert.throws(() => validateRouterToAgentWorkerMessage({
        protocol: WEBTTY_AGENT_WORKER_PROTOCOL,
        type: '__proto__',
        terminalId: TERMINAL_ID,
    }));
});

test('agent protocol bounds input and dimensions', () => {
    assert.throws(() => validateRouterToAgentWorkerMessage(init({ cols: 1 })));
    assert.throws(() => validateRouterToAgentWorkerMessage(init({ rows: 513 })));
    assert.throws(() => validateRouterToAgentWorkerMessage(init({ marker: 'short' })));
    assert.throws(() => validateRouterToAgentWorkerMessage(
        agentWorkerMessage('input', TERMINAL_ID, {
            data: '💥'.repeat((WEBTTY_AGENT_PROTOCOL_LIMITS.maxInputBytes / 4) + 1),
        }),
        { initialized: true },
    ));
});

test('ready message requires the persistent exec ID and complete inner identity proof', () => {
    assert.equal(validateAgentWorkerToRouterMessage(
        agentWorkerMessage('prepared', TERMINAL_ID, { startupEvidence: startup() }),
    ).type, 'prepared');
    for (const evidence of [
        startup({ baselineExecIds: ['short'] }),
        startup({ baselineExecIds: ['c'.repeat(64), 'c'.repeat(64)] }),
        startup({ containerInitProcess: { ...startup().containerInitProcess, pidNamespace: 'host' } }),
        { ...startup(), shell: '/bin/bash' },
    ]) assert.throws(() => validateAgentWorkerToRouterMessage(
        agentWorkerMessage('prepared', TERMINAL_ID, { startupEvidence: evidence }),
    ));
    const ready = agentWorkerMessage('ready', TERMINAL_ID, { recoveryEvidence: recovery() });
    assert.equal(validateAgentWorkerToRouterMessage(ready).type, 'ready');
    for (const evidence of [
        recovery({ backend: 'no-session' }),
        recovery({ execId: null }),
        recovery({ containerId: 'a'.repeat(12) }),
        recovery({ innerProcess: { ...recovery().innerProcess, innerStartToken: 'linux-proc:999' } }),
        recovery({ clientProcess: { ...recovery().clientProcess, pid: 0 } }),
        { ...recovery(), command: 'bash' },
    ]) {
        assert.throws(() => validateAgentWorkerToRouterMessage(
            agentWorkerMessage('ready', TERMINAL_ID, { recoveryEvidence: evidence }),
        ));
    }
});

test('worker output, exits, errors, and terminal correlation are exact and bounded', () => {
    assert.equal(validateAgentWorkerToRouterMessage(
        agentWorkerMessage('output', TERMINAL_ID, { sequence: 1, data: 'ok' }),
    ).sequence, 1);
    assert.equal(validateAgentWorkerToRouterMessage(
        agentWorkerMessage('exit', TERMINAL_ID, {
            exitCode: 0,
            signal: null,
            category: 'clean',
            cleanupProven: true,
        }),
    ).category, 'clean');
    assert.equal(validateAgentWorkerToRouterMessage(
        agentWorkerMessage('error', TERMINAL_ID, { category: 'target-stale' }),
    ).category, 'target-stale');
    assert.throws(() => validateAgentWorkerToRouterMessage(
        agentWorkerMessage('output', TERMINAL_ID, { sequence: 0, data: 'x' }),
    ));
    assert.throws(() => validateAgentWorkerToRouterMessage(
        agentWorkerMessage('error', TERMINAL_ID, { category: 'stack:/workspace/secret' }),
    ));
    assert.throws(() => validateAgentWorkerToRouterMessage(
        agentWorkerMessage('ready', TERMINAL_ID, { recoveryEvidence: recovery() }),
        { expectedTerminalId: 'z'.repeat(24) },
    ));
});
