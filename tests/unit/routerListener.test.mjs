import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { waitForRouterQuiescence } from '../../cli/commands/sessionControl.js';
import { buildRouterEnv, waitForRouterReady } from '../../cli/commands/workspaceUtil.js';

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const routingServerPath = path.join(repoRoot, 'cli/server/RoutingServer.js');

test('Router shutdown barrier covers the Watchdog 15s grace and 1s forced-exit delay', () => {
    let elapsedMs = 0;
    const sleeps = [];

    const remainingPids = waitForRouterQuiescence({
        targetedPids: new Set([41001]),
        isPidAlive: () => elapsedMs < 16_000,
        findPids: () => elapsedMs < 16_100 ? [41002] : [],
        now: () => elapsedMs,
        sleep(milliseconds) {
            sleeps.push(milliseconds);
            elapsedMs += milliseconds;
        },
    });

    assert.deepEqual(remainingPids, []);
    assert.equal(elapsedMs, 16_100);
    assert.equal(sleeps.every((milliseconds) => milliseconds <= 100), true);
});

test('Router shutdown barrier expires at 20s and reports both Watchdog and listener PIDs', () => {
    let elapsedMs = 0;

    const remainingPids = waitForRouterQuiescence({
        targetedPids: new Set([42001]),
        isPidAlive: () => true,
        findPids: () => [42002],
        now: () => elapsedMs,
        sleep(milliseconds) {
            elapsedMs += milliseconds;
        },
    });

    assert.equal(elapsedMs, 20_000);
    assert.deepEqual(remainingPids, [42001, 42002]);
});

test('Router source authority comes only from the bounded process environment', () => {
    const localSha = 'a'.repeat(64);
    const localRef = `file:/opt/ploinky/node_modules/.ploinky-local-agentlib/${localSha}.tgz`;
    const environment = buildRouterEnv({
        loadEnvFileImpl: () => ({
            PLOINKY_LOCAL_AGENTLIB_SHA: 'b'.repeat(64),
            PLOINKY_AGENTLIB_REF: 'file:/workspace-controlled.tgz',
            FROM_ENV_FILE: 'kept',
        }),
        readSecretsFileImpl: () => ({
            PLOINKY_LOCAL_AGENTLIB_SHA: 'c'.repeat(64),
            PLOINKY_AGENTLIB_REF: 'file:/secrets-controlled.tgz',
            FROM_SECRETS: 'kept',
        }),
        processEnvironment: {
            PLOINKY_PROD: 'false',
            PLOINKY_LOCAL_AGENTLIB_SHA: localSha,
            PLOINKY_AGENTLIB_REF: localRef,
            FROM_PROCESS: 'kept',
        },
    });

    assert.equal(environment.PLOINKY_PROD, undefined);
    assert.equal(environment.PLOINKY_LOCAL_AGENTLIB_SHA, localSha);
    assert.equal(environment.PLOINKY_AGENTLIB_REF, localRef);
    assert.equal(environment.FROM_ENV_FILE, 'kept');
    assert.equal(environment.FROM_SECRETS, 'kept');
    assert.equal(environment.FROM_PROCESS, 'kept');
});

test('workspace files cannot invent AgentLib authority and an explicit production ref survives', () => {
    const withoutProcessAuthority = buildRouterEnv({
        loadEnvFileImpl: () => ({
            PLOINKY_LOCAL_AGENTLIB_SHA: 'd'.repeat(64),
            PLOINKY_AGENTLIB_REF: 'file:/workspace-controlled.tgz',
        }),
        readSecretsFileImpl: () => ({
            PLOINKY_LOCAL_AGENTLIB_SHA: 'e'.repeat(64),
            PLOINKY_AGENTLIB_REF: 'file:/secrets-controlled.tgz',
        }),
        processEnvironment: {},
    });
    assert.equal(withoutProcessAuthority.PLOINKY_LOCAL_AGENTLIB_SHA, undefined);
    assert.equal(withoutProcessAuthority.PLOINKY_AGENTLIB_REF, undefined);

    const productionRef = 'git+https://github.com/example/AchillesAgentLib.git#candidate';
    const withProductionOverride = buildRouterEnv({
        loadEnvFileImpl: () => ({}),
        readSecretsFileImpl: () => ({}),
        processEnvironment: {
            PLOINKY_PROD: 'true',
            PLOINKY_AGENTLIB_REF: productionRef,
        },
    });
    assert.equal(withProductionOverride.PLOINKY_PROD, undefined);
    assert.equal(withProductionOverride.PLOINKY_LOCAL_AGENTLIB_SHA, undefined);
    assert.equal(withProductionOverride.PLOINKY_AGENTLIB_REF, productionRef);
});

test('router readiness is TCP-only against 127.0.0.1', async () => {
    const attempts = [];
    await waitForRouterReady(8080, null, 500, {
        createConnection(options) {
            attempts.push(options);
            const socket = new EventEmitter();
            socket.destroy = () => {};
            socket.setTimeout = () => {};
            queueMicrotask(() => socket.emit('connect'));
            return socket;
        },
    });
    assert.deepEqual(attempts, [{ host: '127.0.0.1', port: 8080 }]);
    await assert.rejects(
        () => waitForRouterReady(42817, null, 1),
        /must be exactly 8080/,
    );
});

test('RoutingServer fixes public 8080 and delegates private 8081 to exact interface listeners', () => {
    const source = fs.readFileSync(routingServerPath, 'utf8');
    assert.match(source, /server\.listen\(port, '0\.0\.0\.0'/);
    assert.doesNotMatch(source, /router\.sock|routerSocketServer|net\.createServer/);

    assert.match(source, /const port = 8080/);
    assert.match(source, /createPrivateListenerSet\(\{/);
    assert.match(source, /port: privatePort/);
    assert.match(source, /privateListenerSet\.start\(\)/);
    const classifierStart = source.indexOf('await interfaceClassifier.start()');
    const privateStart = source.indexOf('await privateListenerSet.start()');
    assert.ok(
        classifierStart >= 0 && classifierStart < privateStart,
        'interface classification must be primed before private listener readiness',
    );
    assert.doesNotMatch(
        fs.readFileSync(path.join(repoRoot, 'cli/server/listenerInterfaceClassifier.js'), 'utf8')
            .match(/function classify[\s\S]*?\n    }/)?.[0] || '',
        /\brefresh\(/,
    );
    assert.doesNotMatch(source, /privateServer\.listen\(/);
    assert.doesNotMatch(source, /privateServer\.prependListener\('connection'/);
    const authGate = source.indexOf('const authResult = await ensureAuthenticated(req, res, parsedUrl, { routePlan });');
    const tcpHealth = source.indexOf("if (pathname === '/health')", authGate);
    assert.ok(authGate >= 0 && tcpHealth > authGate, 'TCP health must dispatch only after authentication');
    assert.match(source.slice(tcpHealth, tcpHealth + 800), /requireAdminControlRequest\(req, res\)/);
    assert.match(source, /const task = await readAuthenticatedAgentTask\(\{/);
    assert.match(source, /sendJsonResponse\(res, 200, \{ task \}, \{ 'Cache-Control': 'no-store' \}\)/);

    for (const port of ['', '+8080', '8080x', '0', '65536', '8081']) {
        const env = { ...process.env };
        env.PORT = port;
        const result = spawnSync(process.execPath, [routingServerPath], {
            cwd: repoRoot,
            env,
            encoding: 'utf8',
            timeout: 5000,
        });
        assert.notEqual(result.status, 0, `PORT=${JSON.stringify(port)} unexpectedly started`);
        assert.match(`${result.stderr}\n${result.stdout}`, /managed Router requires PORT to be exactly 8080/);
    }
});
