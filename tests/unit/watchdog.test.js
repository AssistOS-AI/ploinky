process.env.PLOINKY_WATCHDOG_TEST_MODE = '1';
process.env.PORT = '8080';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const {
    determineShouldRestart,
    calculateBackoff,
    resetBackoff,
    resetManagerState,
    checkCircuitBreaker,
    state,
    CONFIG,
    getTestLogs,
    clearTestLogs,
    getRouterNodeExecutable,
    performHealthCheck,
} = await import('../../cli/server/Watchdog.js');

const extractEvents = () => getTestLogs().map(entry => entry.event);

test('does not restart after clean exits', () => {
    resetManagerState();
    clearTestLogs();

    const shouldRestart = determineShouldRestart(0, null);

    assert.equal(shouldRestart, false);
    assert.ok(extractEvents().includes('clean_exit'));
});

test('does not restart after configuration errors', () => {
    resetManagerState();
    clearTestLogs();

    const shouldRestart = determineShouldRestart(2, null);

    assert.equal(shouldRestart, false);
    assert.ok(extractEvents().includes('configuration_error'));
});

test('does not restart after fatal exit codes', () => {
    resetManagerState();
    clearTestLogs();

    const shouldRestart = determineShouldRestart(150, null);

    assert.equal(shouldRestart, false);
    assert.ok(extractEvents().includes('fatal_error_no_restart'));
});

test('does not restart when terminated intentionally', () => {
    resetManagerState();
    clearTestLogs();

    const shouldRestart = determineShouldRestart(null, 'SIGTERM');

    assert.equal(shouldRestart, false);
    assert.ok(extractEvents().includes('intentional_signal'));
});

test('restarts after unexpected exits', () => {
    resetManagerState();
    clearTestLogs();

    const shouldRestart = determineShouldRestart(1, null);

    assert.equal(shouldRestart, true);
    assert.ok(extractEvents().includes('unexpected_exit'));
});

test('exponential backoff caps at configured maximum', () => {
    resetManagerState();
    clearTestLogs();

    const observed = [];
    for (let i = 0; i < 8; i++) {
        observed.push(calculateBackoff());
    }

    assert.equal(observed[0], CONFIG.INITIAL_BACKOFF_MS);
    assert.equal(observed[1], CONFIG.INITIAL_BACKOFF_MS * CONFIG.BACKOFF_MULTIPLIER);
    assert.equal(observed[2], observed[1] * CONFIG.BACKOFF_MULTIPLIER);
    assert.equal(observed.at(-1), CONFIG.MAX_BACKOFF_MS);
    assert.equal(state.currentBackoff, CONFIG.MAX_BACKOFF_MS);

    resetBackoff();
    assert.equal(state.currentBackoff, CONFIG.INITIAL_BACKOFF_MS);
    assert.equal(state.consecutiveFailures, 0);
    assert.equal(state.healthCheckFailures, 0);
});

test('circuit breaker trips after repeated crashes within window', () => {
    resetManagerState();
    clearTestLogs();

    const now = Date.now();
    for (let i = 0; i < CONFIG.MAX_RESTARTS_IN_WINDOW; i++) {
        state.restartHistory.push(now - 1000);
    }

    const tripped = checkCircuitBreaker();

    assert.equal(tripped, true);
    assert.equal(state.circuitBreakerTripped, true);
    assert.ok(extractEvents().includes('circuit_breaker_tripped'));
});

test('restarts after health check kill even with clean exit', () => {
    resetManagerState();
    clearTestLogs();

    // Simulate health check setting the flag before killing the process
    state.pendingHealthCheckRestart = true;

    // Process exits cleanly (code 0) after receiving SIGTERM from health check
    const shouldRestart = determineShouldRestart(0, null);

    assert.equal(shouldRestart, true, 'Should restart when health check initiated the kill');
    assert.equal(state.pendingHealthCheckRestart, false, 'Flag should be cleared');
    assert.ok(extractEvents().includes('health_check_restart'));
});

test('pendingHealthCheckRestart flag is cleared after restart decision', () => {
    resetManagerState();
    clearTestLogs();

    state.pendingHealthCheckRestart = true;
    determineShouldRestart(0, null);

    // Flag should be cleared after first call
    assert.equal(state.pendingHealthCheckRestart, false);

    // Second call should not restart (normal clean exit)
    clearTestLogs();
    const shouldRestart = determineShouldRestart(0, null);
    assert.equal(shouldRestart, false);
    assert.ok(extractEvents().includes('clean_exit'));
});

test('watchdog reuses the current node executable for router launches', () => {
    assert.equal(getRouterNodeExecutable(), process.execPath);
});

test('watchdog forwards its validated port to every router child', () => {
    const source = fs.readFileSync(
        fileURLToPath(new URL('../../cli/server/Watchdog.js', import.meta.url)),
        'utf8'
    );

    assert.match(source, /PORT: String\(CONFIG\.PORT\)/);
});

test('watchdog health uses the supervisor-only Unix socket, not anonymous TCP', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-watchdog-health-'));
    const socketPath = path.join(dir, 'router-health.sock');
    const previousSocket = CONFIG.HEALTH_SOCKET;
    const server = http.createServer((req, res) => {
        assert.equal(req.url, '/health');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'healthy' }));
    });
    t.after(async () => {
        CONFIG.HEALTH_SOCKET = previousSocket;
        await new Promise(resolve => server.close(resolve));
        fs.rmSync(dir, { recursive: true, force: true });
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, resolve);
    });
    CONFIG.HEALTH_SOCKET = socketPath;
    resetManagerState();
    assert.equal(await performHealthCheck(), true);
});

test('watchdog defaults to fixed Router port 8080 and rejects malformed overrides', () => {
    const watchdogUrl = new URL('../../cli/server/Watchdog.js', import.meta.url).href;
    const runWithPort = (value) => {
        const env = {
            ...process.env,
            PLOINKY_WATCHDOG_TEST_MODE: '1',
        };
        if (value === undefined) delete env.PORT;
        else env.PORT = value;
        const result = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(watchdogUrl)})`], {
            env,
            encoding: 'utf8',
        });
        return result;
    };
    for (const value of [undefined, '', '8080']) {
        const result = runWithPort(value);
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    }
    for (const value of ['+8080', '8080junk', '0', '65536']) {
        const result = runWithPort(value);
        assert.notEqual(result.status, 0, `expected PORT=${JSON.stringify(value)} to fail`);
        assert.match(result.stderr, /Watchdog PORT must be exactly 8080/);
    }
});
