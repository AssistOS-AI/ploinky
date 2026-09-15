import assert from 'node:assert/strict';
import test from 'node:test';

import { BOX_READY_LINE } from '../../ploinky-box/constants.mjs';
import {
    startContainerAndWaitReady,
    waitForReadyLine,
} from '../../ploinky-box/lifecycle/container.mjs';

const CONTAINER_ID = 'a'.repeat(64);
const OLD_TIME = '2026-09-15T09:00:00.000000000Z';
const BOOT_TIME = '2026-09-15T12:00:01.123456789+03:00';
const EMPTY_BASELINE = Object.freeze({ stdout: '', stderr: '' });

function stored(message, timestamp = BOOT_TIME) {
    return `${timestamp} ${message}\n`;
}

function warning(second) {
    return `time="2026-09-15T12:00:${second}+03:00" level=warning msg="The cgroupv2 manager is set to systemd but there is no systemd user session available"\n`;
}

function output() {
    return { value: '', write(chunk) { this.value += chunk; } };
}

test('changing Podman warnings do not change stored history or hide container warnings', async () => {
    const calls = [];
    const oldStdout = stored(BOX_READY_LINE, OLD_TIME);
    const oldStderr = stored('old diagnostic', OLD_TIME);
    const applicationWarning = warning('00').trimEnd();
    const currentStderr = stored(applicationWarning);
    let started = false;
    let polls = 0;
    const runner = {
        query(command, args) {
            calls.push([command, ...args]);
            if (args[1] !== 'logs') return { ok: true, stdout: 'running\n', stderr: '' };
            if (!started) {
                return { ok: true, stdout: oldStdout, stderr: warning('00') + oldStderr };
            }
            polls += 1;
            return {
                ok: true,
                stdout: oldStdout + stored('preparing') + (polls > 1 ? stored(BOX_READY_LINE) : ''),
                stderr: warning(`0${polls}`) + oldStderr + currentStderr + warning(`0${polls}`),
            };
        },
        run(command, args) {
            calls.push([command, ...args]);
            started = true;
        },
    };
    const stdout = output();
    const stderr = output();
    await startContainerAndWaitReady({ name: 'podman' }, CONTAINER_ID, runner, {
        stdout, stderr, intervalMs: 0, timeoutMs: 1000, delay: async () => {},
    });
    assert.equal(polls, 2);
    assert.equal(stdout.value, `preparing\n${BOX_READY_LINE}\n`);
    assert.equal(stderr.value, warning('00') + `${applicationWarning}\n`);
    assert.deepEqual(calls[0], ['podman', 'container', 'logs', '--timestamps', CONTAINER_ID]);
    assert.deepEqual(calls[1], ['podman', 'container', 'start', CONTAINER_ID]);
    for (const call of calls.filter((entry) => entry[2] === 'logs')) {
        assert.deepEqual(call, ['podman', 'container', 'logs', '--timestamps', CONTAINER_ID]);
    }
});

test('real stderr history drift still rejects when Podman warnings change', async () => {
    const runner = {
        query(_command, args) {
            return args[1] === 'logs'
                ? { ok: true, stdout: stored(BOX_READY_LINE), stderr: warning('02') + stored('changed') }
                : { ok: true, stdout: 'running\n', stderr: '' };
        },
    };
    await assert.rejects(() => waitForReadyLine({ name: 'podman' }, CONTAINER_ID, runner, {
        logBaseline: { stdout: '', stderr: stored('original'), diagnostics: warning('01') },
        stdout: output(), stderr: output(),
    }), { code: 'PLOINKY_BOX_LOG_HISTORY_DRIFT' });
});

test('a Podman log reader error cannot be admitted as a successful baseline', async () => {
    let started = false;
    const runner = {
        query() {
            return {
                ok: true,
                stdout: stored(BOX_READY_LINE),
                stderr: 'time="2026-09-15T09:00:00Z" level=error msg="Failed to get journal entry"\n',
            };
        },
        run() { started = true; },
    };
    await assert.rejects(() => startContainerAndWaitReady({ name: 'podman' }, CONTAINER_ID, runner),
        /Could not capture Box container logs before start.*Failed to get journal entry/);
    assert.equal(started, false);
});

test('an unframed readiness marker cannot prove container readiness', async () => {
    const runner = {
        query(_command, args) {
            return args[1] === 'logs'
                ? { ok: true, stdout: `${BOX_READY_LINE}\n`, stderr: warning('01') }
                : { ok: true, stdout: 'running\n', stderr: '' };
        },
    };
    await assert.rejects(() => waitForReadyLine({ name: 'podman' }, CONTAINER_ID, runner, {
        logBaseline: EMPTY_BASELINE,
        stdout: output(), stderr: output(), timeoutMs: 0,
    }), { code: 'PLOINKY_BOX_READY_TIMEOUT' });
});

test('log reader errors during readiness cannot be overridden by a fresh marker', async () => {
    const runner = {
        query(_command, args) {
            return args[1] === 'logs'
                ? { ok: true, stdout: stored(BOX_READY_LINE), stderr: 'ERRO[0001] Failed to parse journal entry\n' }
                : { ok: true, stdout: 'running\n', stderr: '' };
        },
    };
    await assert.rejects(() => waitForReadyLine({ name: 'podman' }, CONTAINER_ID, runner, {
        logBaseline: EMPTY_BASELINE,
        stdout: output(), stderr: output(), timeoutMs: 0,
    }), /Timed out waiting.*Failed to parse journal entry/);
});

test('container messages retain their own timestamp and diagnostic-like text', async () => {
    const message = `${OLD_TIME} WARN[0000] application warning`;
    const runner = {
        query(_command, args) {
            return args[1] === 'logs'
                ? { ok: true, stdout: stored(message) + stored(BOX_READY_LINE), stderr: 'WARN[0000] host warning\n' }
                : { ok: true, stdout: 'running\n', stderr: '' };
        },
    };
    const stdout = output();
    const stderr = output();
    await waitForReadyLine({ name: 'podman' }, CONTAINER_ID, runner, {
        logBaseline: EMPTY_BASELINE, stdout, stderr, timeoutMs: 1000,
    });
    assert.equal(stdout.value, `${message}\n${BOX_READY_LINE}\n`);
    assert.equal(stderr.value, 'WARN[0000] host warning\n');
});
