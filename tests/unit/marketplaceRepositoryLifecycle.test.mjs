import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const driver = fileURLToPath(new URL('../fixtures/marketplace-repository-lifecycle.mjs', import.meta.url));
function run(mode, requestedCode = 0, timeoutMs = 14_000) {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'repository-required-cleanup-'));
    const pidFile = path.join(workspace, 'router.pid');
    try {
        const started = performance.now();
        const result = spawnSync(process.execPath, [driver, mode, String(requestedCode)], {
            cwd: workspace, env: { ...process.env, PLOINKY_WORKSPACE_ROOT: workspace, PLOINKY_ROUTER_PID_FILE: pidFile },
            stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL',
        });
        assert.equal(result.error, undefined, result.error?.message);
        assert.equal(result.signal, null, 'fixture must exit through production lifecycle');
        assert.equal(fs.existsSync(pidFile), false, 'PID cleanup still runs');
        return { ...result, elapsed: performance.now() - started };
    } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
}

for (const [mode, requestedCode, expectedCode] of [
    ['success', 0, 0], ['failure', 0, 1], ['reject', 0, 1], ['invalid', 0, 1],
    ['legacy-reject', 0, 0], ['failure', 7, 7],
]) test(`required cleanup ${mode} preserves remaining cleanup and exits ${expectedCode} from request ${requestedCode}`, () => {
    const result = run(mode, requestedCode);
    assert.equal(result.status, expectedCode, result.stderr);
    assert.match(result.stdout, /LEGACY_CLEANUP_FINISHED/);
    assert.match(result.stdout, /SECOND_CLEANUP_FINISHED/);
    assert.match(result.stdout, /SERVER_CLOSE/);
    assert.match(result.stdout, /SESSIONS_CLEARED:0/);
    assert.ok(result.stdout.indexOf('LEGACY_CLEANUP_FINISHED') < result.stdout.indexOf('SERVER_CLOSE'));
    assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_REQUIRED_FAILURE_DETAILS/);
    if (expectedCode) {
        assert.match(result.stderr, /Required cleanup failed:/);
        assert.match(result.stderr, new RegExp(`exit ${expectedCode}`));
        assert.doesNotMatch(result.stdout, /Server closed successfully/);
    }
});

test('the production ten-second timer still forces exit when required cleanup never settles', { timeout: 18_000 }, () => {
    const result = run('hang');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Forced exit after timeout/);
    assert.match(result.stdout, /LEGACY_CLEANUP_FINISHED/);
    assert.doesNotMatch(result.stdout, /SERVER_CLOSE/);
    assert.ok(result.elapsed >= 9_000 && result.elapsed < 13_500, `forced exit elapsed ${result.elapsed}ms`);
});

test('shutdown before first repository request stays closed while a legacy callback is still pending', () => {
    const result = run('late-first-request');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /LATE_REQUEST_REJECTED:PLOINKY_MARKETPLACE_REPOSITORY_RECOVERY_REQUIRED/);
    assert.doesNotMatch(result.stdout, /UNEXPECTED_CENSUS|LATE_REQUEST_ADMITTED/);
    assert.ok(result.stdout.indexOf('REQUIRED_CLEANUP_ENTERED') < result.stdout.indexOf('LATE_REQUEST_REJECTED'));
    assert.ok(result.stdout.indexOf('LATE_REQUEST_REJECTED') < result.stdout.indexOf('SERVER_CLOSE'));
    assert.match(result.stdout, /SESSIONS_CLEARED:0/);
});

test('the fixture timeout hard-kills its owned shutdown child and remains an assertion failure', { timeout: 18_000 }, () => {
    const started = performance.now();
    assert.throws(() => run('hang', 0, 1_000), (error) => error.code === 'ERR_ASSERTION' && /ETIMEDOUT/.test(error.message));
    assert.ok(performance.now() - started < 3_000, 'owned child termination does not wait for ignored SIGTERM');
});
