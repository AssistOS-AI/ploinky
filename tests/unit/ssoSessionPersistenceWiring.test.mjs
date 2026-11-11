import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const routerSource = fs.readFileSync(new URL('../../cli/server/RoutingServer.js', import.meta.url), 'utf8');
const lifecycleSource = fs.readFileSync(new URL('../../cli/server/utils/processLifecycle.js', import.meta.url), 'utf8');

function assertOrdered(source, labels) {
    let previous = -1;
    for (const label of labels) {
        const next = source.indexOf(label, previous + 1);
        assert.ok(next > previous, `expected '${label}' after the prior wiring step`);
        previous = next;
    }
}

function sliceBetween(source, startLabel, endLabel) {
    const start = source.indexOf(startLabel);
    const end = source.indexOf(endLabel, start);
    assert.ok(start >= 0 && end > start, `expected a block from '${startLabel}' to '${endLabel}'`);
    return source.slice(start, end);
}

test('the Router arms session persistence before any listener starts', () => {
    assertOrdered(routerSource, [
        "process.env.PLOINKY_SSO_SESSION_PERSISTENCE",
        'authService.configureSessionPersistence(',
        'setupProcessLifecycle(',
        'await interfaceClassifier.start();',
        'await privateListenerSet.start();',
        'healthServer.listen(',
        "server.listen(port, '0.0.0.0'",
    ]);
    const configure = sliceBetween(routerSource, 'if (ssoSessionPersistence) {', 'prepareHealthSocket();');
    assert.match(configure, /configureSessionPersistence\(\{ directory: ssoSessionDirectory, log: appendLog \}\)/);
    assert.match(configure, /process\.exit\(2\)/, 'a failed arming is fatal at start');
});

test('persistence is on by default and only a trimmed, case-insensitive "off" opts out', () => {
    assert.match(
        routerSource,
        /const ssoSessionPersistence = String\(process\.env\.PLOINKY_SSO_SESSION_PERSISTENCE \|\| ''\)\.trim\(\)\.toLowerCase\(\) !== 'off';/,
    );
});

test('the session directory is the router-security data directory under the Ploinky dir', () => {
    assert.match(routerSource, /const ssoSessionDirectory = path\.join\(PLOINKY_DIR, 'data', 'router-security'\);/);
});

test('openSessionStore is the first statement of the public listen callback and precedes the ready mark', () => {
    const callback = sliceBetween(routerSource, "server.listen(port, '0.0.0.0', () => {", 'appendLog(\'server_start\'');
    const body = callback.slice(callback.indexOf('{') + 1);
    const firstStatement = body.replace(/^(\s*\/\/[^\n]*\n)*\s*/, '');
    assert.ok(firstStatement.startsWith('try {'), 'the store hand-over is guarded and comes first');
    assertOrdered(callback, [
        'authService.openSessionStore()',
        "appendLog('sso_session_store_opened'",
        'catch (error) {',
        'cloudflaredRouterIntegration.markPublicListenerReady();',
    ]);
    const guarded = sliceBetween(callback, 'try {', 'cloudflaredRouterIntegration.markPublicListenerReady();');
    assert.match(guarded, /sso_session_store_open_error/, 'an unexpected failure is logged, not rethrown');
    assert.doesNotMatch(guarded, /\bthrow\b/);
});

test('the opt-out branch discards the persisted file and never configures persistence', () => {
    const callback = sliceBetween(routerSource, "server.listen(port, '0.0.0.0', () => {", 'cloudflaredRouterIntegration.markPublicListenerReady();');
    const elseBranch = callback.slice(callback.indexOf('} else {'));
    assert.match(elseBranch, /discardPersistedSessions\(\{ directory: ssoSessionDirectory, log: appendLog \}\)/);
    assert.doesNotMatch(elseBranch, /openSessionStore/);
    // Arming is only reachable when persistence is on.
    const configureAt = routerSource.indexOf('authService.configureSessionPersistence(');
    const guardAt = routerSource.lastIndexOf('if (ssoSessionPersistence) {', configureAt);
    assert.ok(guardAt >= 0 && configureAt - guardAt < 200, 'configure sits directly inside the persistence guard');
    assert.equal(routerSource.split('configureSessionPersistence(').length - 1, 1);
});

test('the Router registers the final flush as a beforeListenersClose hook, only when persistence is on', () => {
    assert.match(
        routerSource,
        /beforeListenersClose: ssoSessionPersistence \? \[\(\) => authService\.closeSessionStore\(\)\] : \[\],/,
    );
    const lifecycleCall = sliceBetween(routerSource, 'const lifecycle = setupProcessLifecycle(', 'requiredBeforeClose:');
    assert.match(lifecycleCall, /beforeListenersClose:/);
});

test('closeServers runs the listener hooks before the listeners close, in the same tick', () => {
    const closeServers = sliceBetween(lifecycleSource, 'const closeServers = () => {', 'const callbacks = Array.isArray(beforeClose)');
    assertOrdered(closeServers, [
        'for (const hook of listenerHooks)',
        'hook();',
        'shutdown_preclose_error',
        'entry.close(afterClose)',
    ]);
    assert.doesNotMatch(closeServers.slice(0, closeServers.indexOf('entry.close(afterClose)')), /await|\.then\(|setImmediate|setTimeout|nextTick/);
});

test('beforeListenersClose hooks run before the listeners close, survive a throwing hook and never block the close', async (t) => {
    // Own workspace root so the lifecycle logger never writes into a real tree.
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-lifecycle-'));
    const priorRoot = process.env.PLOINKY_WORKSPACE_ROOT;
    process.env.PLOINKY_WORKSPACE_ROOT = workspace;
    const realExit = process.exit;
    t.after(async () => {
        process.exit = realExit;
        if (priorRoot === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT;
        else process.env.PLOINKY_WORKSPACE_ROOT = priorRoot;
        await new Promise((resolve) => setTimeout(resolve, 50));
        fs.rmSync(workspace, { recursive: true, force: true });
    });
    const { createGracefulShutdown } = await import('../../cli/server/utils/processLifecycle.js');

    const events = [];
    const fakeServer = (name) => ({
        close(callback) { events.push(`${name}:close`); setImmediate(() => callback(null)); },
        unref() { events.push(`${name}:unref`); },
        address() { return null; },
    });
    const exited = new Promise((resolve) => {
        process.exit = (code) => { events.push(`exit:${code}`); resolve(code); };
    });
    const originalError = console.error;
    console.error = () => {};
    t.after(() => { console.error = originalError; });

    const shutdown = createGracefulShutdown(
        [fakeServer('public'), fakeServer('health')],
        {},
        { clear() { events.push('sessions:clear'); } },
        {
            beforeClose: [() => { events.push('beforeClose'); }],
            beforeListenersClose: [
                () => { events.push('hook:1'); throw new Error('flush failed'); },
                () => { events.push('hook:2'); },
                'not a function',
            ],
        },
    );
    shutdown('TEST', 0);
    const code = await exited;

    assert.equal(code, 0, 'a failing hook does not change the exit code');
    assert.deepEqual(events.slice(0, 6), [
        'beforeClose',
        'hook:1',
        'hook:2',
        'public:close',
        'health:close',
        'public:unref',
    ], 'hooks run after beforeClose and before the first listener close, and a throwing hook does not stop the next one');
    assert.ok(events.includes('exit:0'));
});
