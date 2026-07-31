import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import {
    buildRelayReadinessRoute,
    waitForAgentReady,
} from '../../cli/server/utils/agentReadiness.js';
import {
    buildBlockingReadinessEntryFromNode,
    runCliWithDependencies,
    waitForReadinessEntries,
} from '../../cli/commands/workspaceUtil.js';

function agentCliHarness({ noTTY = false, endpointError = null } = {}) {
    const events = [];
    const logs = [];
    let enabled = false;
    const record = {
        containerName: 'nested-explorer',
        record: {
            repoName: 'AssistOSExplorer',
            agentName: 'explorer',
        },
    };
    return {
        events,
        logs,
        dependencies: {
            env: noTTY ? { PLOINKY_NO_TTY: '1' } : {},
            resolveEnabledAgentRecord: () => enabled ? record : null,
            findAgent: () => ({
                repo: 'AssistOSExplorer',
                manifestPath: '/fixtures/AssistOSExplorer/explorer/manifest.json',
                shortAgentName: 'explorer',
            }),
            enableAgent: reference => {
                events.push(['enable', reference]);
                enabled = true;
            },
            readManifest: () => ({
                cli: '/Agent/default_cli.sh',
                readiness: { protocol: 'mcp' },
            }),
            resolveRouterEndpointForManifest: () => {
                if (endpointError) throw endpointError;
                return {
                    mode: 'default',
                    host: 'host.containers.internal',
                    port: 49123,
                    url: 'http://host.containers.internal:49123',
                    env: {
                        PLOINKY_ROUTER_HOST: 'host.containers.internal',
                        PLOINKY_ROUTER_PORT: '49123',
                        PLOINKY_ROUTER_URL: 'http://host.containers.internal:49123',
                    },
                };
            },
            ensureAgentService: () => {
                events.push(['ensure']);
                return { containerName: 'nested-explorer', hostPort: 15517 };
            },
            waitForAgentReady: async () => {
                events.push(['ready']);
                return true;
            },
            loadAgentsMap: () => ({
                'nested-explorer': {
                    runtime: 'container',
                    containerImage: 'docker.io/assistos/ploinky-node:24-bookworm-tools',
                },
            }),
            attachInteractive: (containerName, projectPath, command) => {
                events.push(['attach', containerName, projectPath, command]);
            },
            projectPath: '/workspace',
            log: line => {
                logs.push(line);
                if (line.startsWith('[ploinky] image=')) events.push(['banner']);
            },
            warn: line => logs.push(line),
        },
    };
}

function listenOnEphemeralPort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer((socket) => {
            // Accept and immediately drop connections; the readiness probe
            // only needs the TCP handshake to succeed for protocol 'tcp'.
            socket.destroy();
        });
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({ server, port });
        });
    });
}

function findFreePort() {
    // Open a server to reserve a port number, then close it so the port is
    // (almost certainly) free and refusing connections for the test.
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close((err) => {
                if (err) {
                    reject(err);
                    return;
                }
                resolve(port);
            });
        });
    });
}

test('waitForAgentReady resolves true when the host port is open (tcp)', async () => {
    const { server, port } = await listenOnEphemeralPort();
    try {
        const ready = await waitForAgentReady({ hostPort: port }, {
            protocol: 'tcp',
            timeoutMs: 2000,
        });
        assert.equal(ready, true);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test('waitForAgentReady resolves false within the timeout for a closed port (tcp)', async () => {
    const port = await findFreePort();
    const startedAt = Date.now();
    const ready = await waitForAgentReady({ hostPort: port }, {
        protocol: 'tcp',
        timeoutMs: 600,
        intervalMs: 100,
        probeTimeoutMs: 100,
    });
    const elapsedMs = Date.now() - startedAt;
    assert.equal(ready, false);
    // Must give up around the timeout, not hang indefinitely.
    assert.ok(elapsedMs < 4000, `expected to bail out fast, took ${elapsedMs}ms`);
});

test('explicit readiness port builds a confined relay target from the exact runtime identity', () => {
    const containerId = 'a'.repeat(64);
    const route = buildRelayReadinessRoute({
        route: { container: 'nested-api' },
        manifest: {
            start: 'node server.mjs',
            readiness: { protocol: 'tcp', port: 7000 },
        },
        runtimeResult: {
            containerName: 'nested-api',
            registryRecord: {
                runtime: 'podman',
                containerId,
                instanceId: 'instance-1',
                enableGeneration: 'enable-1',
                repoName: 'example',
                agentName: 'api',
            },
        },
        networkMode: 'managed',
        generationDigest: 'generation-digest',
    });

    assert.deepEqual(route.primaryService, { port: 7000 });
    assert.equal(route.relay.runtime, 'podman');
    assert.equal(route.relay.containerId, containerId);
    assert.equal(route.relay.containerName, 'nested-api');
    assert.equal(route.relay.effectiveInstanceId, 'instance-1');
    assert.equal(route.relay.enableGeneration, 'enable-1');
    assert.equal(route.owner.effectiveInstanceId, 'instance-1');
    assert.equal(route.owner.enableGeneration, 'enable-1');
    assert.equal(route.generationDigest, 'generation-digest');
    assert.deepEqual(route.deniedPorts, []);
});

test('waitForAgentReady probes a confined relay without requiring a published host port', async () => {
    const attempts = [];
    const progress = [];
    const ready = await waitForAgentReady({
        relay: {
            kind: 'container-exec-stdio',
            runtime: 'podman',
            containerId: 'b'.repeat(64),
            containerName: 'nested-api',
            targetAgentId: 'agent:example/api',
            effectiveInstanceId: 'instance-1',
            enableGeneration: 'enable-1',
        },
        owner: {
            effectiveInstanceId: 'instance-1',
            enableGeneration: 'enable-1',
        },
        primaryService: { port: 7000 },
        deniedPorts: [],
        generationDigest: 'generation-digest',
    }, {
        protocol: 'tcp',
        timeoutMs: 1000,
        intervalMs: 1,
        relayProbe: async (route, protocol, timeoutMs) => {
            attempts.push({ route, protocol, timeoutMs });
            return attempts.length === 2;
        },
        onProgress: event => progress.push(event),
    });

    assert.equal(ready, true);
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].protocol, 'tcp');
    assert.equal(attempts[0].route.primaryService.port, 7000);
    assert.equal(progress[0].stage, 'waiting_for_relay');
    assert.equal(progress[1].stage, 'ready');
});

test('blocking startup readiness allows protocol none without a host port', () => {
    const entry = buildBlockingReadinessEntryFromNode({
        id: 'worker',
        shortAgentName: 'worker',
        isStatic: false,
        manifest: {
            readiness: { protocol: 'none' },
        },
    }, {}, 'explorer');

    assert.equal(entry.protocol, 'none');
    assert.equal(entry.route?.hostPort, undefined);
});

test('blocking startup readiness still requires a host port for tcp agents', () => {
    assert.throws(() => buildBlockingReadinessEntryFromNode({
        id: 'api',
        shortAgentName: 'api',
        isStatic: false,
        manifest: {
            readiness: { protocol: 'tcp' },
        },
    }, {}, 'explorer'), /did not expose a host port/);
});

test('blocking startup readiness accepts a confined relay target without a host port', () => {
    const route = {
        container: 'api-container',
        relay: {
            kind: 'container-exec-stdio',
        },
        primaryService: { port: 7000 },
    };
    const entry = buildBlockingReadinessEntryFromNode({
        id: 'api',
        shortAgentName: 'api',
        isStatic: false,
        manifest: {
            start: 'node server.mjs',
            readiness: { protocol: 'tcp', port: 7000 },
        },
    }, route, 'explorer');

    assert.equal(entry.protocol, 'tcp');
    assert.equal(entry.route, route);
});

test('start-only script readiness is blocking without a host port and carries the route container', () => {
    const entry = buildBlockingReadinessEntryFromNode({
        id: 'database',
        shortAgentName: 'database',
        isStatic: false,
        manifest: {
            start: 'postgres',
            health: {
                readiness: {
                    script: 'healthcheck.sh',
                    interval: 2,
                    timeout: 3,
                    failureThreshold: 4,
                },
            },
        },
    }, { container: 'database-container', hostPort: 0 }, 'explorer');

    assert.equal(entry.protocol, 'script');
    assert.equal(entry.route.container, 'database-container');
    assert.equal(entry.route.hostPort, 0);
    assert.equal(entry.scriptProbe.script, 'healthcheck.sh');
    assert.equal(entry.scriptProbe.failureThreshold, 4);
});

test('explicit MCP readiness takes precedence over a declared health script', () => {
    const entry = buildBlockingReadinessEntryFromNode({
        id: 'runner',
        shortAgentName: 'runner',
        isStatic: false,
        manifest: {
            agent: 'sh /Agent/server/AgentServer.sh',
            readiness: { protocol: 'mcp' },
            health: { readiness: { script: 'healthcheck.sh' } },
        },
    }, { container: 'runner-container', hostPort: 31234 }, 'explorer');

    assert.equal(entry.protocol, 'mcp');
    assert.equal(entry.scriptProbe, undefined);
});

test('start-only readiness remains TCP when the primary target has a resolved private route', () => {
    const entry = buildBlockingReadinessEntryFromNode({
        id: 'private-api',
        shortAgentName: 'private-api',
        isStatic: false,
        manifest: { start: 'node server.mjs' },
    }, {
        container: 'private-api-container',
        hostPort: 42345,
    }, 'explorer');

    assert.equal(entry.protocol, 'tcp');
    assert.equal(entry.route.hostPort, 42345);
});

test('start-only readiness without a port, script, or none policy fails with a manifest contract error', () => {
    assert.throws(() => buildBlockingReadinessEntryFromNode({
        id: 'broken-service',
        shortAgentName: 'broken-service',
        isStatic: false,
        manifest: { start: 'node service.mjs' },
    }, { container: 'broken-service-container', hostPort: 0 }, 'explorer'), /start-only.*readiness\.port.*health\.readiness\.script.*readiness\.protocol none/i);
});

test('script readiness success is dispatched against the route container', async () => {
    const calls = [];
    const entry = buildBlockingReadinessEntryFromNode({
        id: 'service',
        shortAgentName: 'service',
        isStatic: false,
        manifest: {
            start: 'serve',
            health: { readiness: { script: 'ready.sh' } },
        },
    }, { container: 'service-container', hostPort: 0 }, 'explorer');

    await waitForReadinessEntries([entry], {
        runContainerScriptReadinessImpl(agentName, containerName, probe) {
            calls.push({ agentName, containerName, probe });
            return { status: 'success', detail: 'ready' };
        },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].agentName, 'service');
    assert.equal(calls[0].containerName, 'service-container');
    assert.equal(calls[0].probe.script, 'ready.sh');
});

test('script readiness failure blocks the caller', async () => {
    const entry = buildBlockingReadinessEntryFromNode({
        id: 'service',
        shortAgentName: 'service',
        isStatic: false,
        manifest: {
            start: 'serve',
            health: { readiness: { script: 'ready.sh', failureThreshold: 1 } },
        },
    }, { container: 'service-container', hostPort: 0 }, 'explorer');

    await assert.rejects(
        waitForReadinessEntries([entry], {
            runContainerScriptReadinessImpl() {
                return { status: 'failed', reason: 'exit 7', detail: 'not ready' };
            },
        }),
        /service.*ready\.sh.*exit 7.*not ready/i,
    );
});

test('runCli auto-enables waits identifies final image then attaches', async () => {
    const harness = agentCliHarness();
    await runCliWithDependencies(
        'explorer',
        ['--help'],
        harness.dependencies,
    );
    assert.deepEqual(
        harness.events.map(event => event[0]),
        ['enable', 'ensure', 'ready', 'banner', 'attach'],
    );
    assert.deepEqual(harness.logs.slice(-3), [
        "[ploinky] Attaching to agent 'explorer'",
        '[ploinky] container=nested-explorer',
        '[ploinky] image=docker.io/assistos/ploinky-node:24-bookworm-tools',
    ]);
});

test('runCli no-tty suppresses banners but preserves attachment', async () => {
    const harness = agentCliHarness({ noTTY: true });
    await runCliWithDependencies('explorer', [], harness.dependencies);
    assert.equal(harness.logs.some(line => line.startsWith('[ploinky]')), false);
    assert.ok(harness.events.some(event => event[0] === 'attach'));
});

test('runCli holds its maintenance transaction through readiness and activation', async () => {
    const harness = agentCliHarness();
    let releaseReadiness;
    let markReadinessEntered;
    const readinessEntered = new Promise((resolve) => { markReadinessEntered = resolve; });
    const readinessGate = new Promise((resolve) => { releaseReadiness = resolve; });
    harness.dependencies.withMaintenanceLock = async (_containerName, _options, fn) => {
        harness.events.push(['lock-enter']);
        try {
            return await fn();
        } finally {
            harness.events.push(['lock-exit']);
        }
    };
    harness.dependencies.waitForAgentReady = async () => {
        harness.events.push(['ready-enter']);
        markReadinessEntered();
        await readinessGate;
        harness.events.push(['ready-exit']);
        return true;
    };
    harness.dependencies.activateRuntimeAfterReadiness = async () => {
        harness.events.push(['activate']);
    };

    const running = runCliWithDependencies('explorer', [], harness.dependencies);
    await readinessEntered;
    assert.deepEqual(
        harness.events.map(([name]) => name),
        ['enable', 'lock-enter', 'ensure', 'ready-enter'],
    );
    releaseReadiness();
    await running;
    assert.deepEqual(
        harness.events.map(([name]) => name),
        ['enable', 'lock-enter', 'ensure', 'ready-enter', 'ready-exit', 'activate', 'lock-exit', 'banner', 'attach'],
    );
});

test('runCli resolves the router endpoint before auto-enable mutation', async () => {
    const harness = agentCliHarness({ endpointError: new Error('persisted router port is invalid') });
    await assert.rejects(
        runCliWithDependencies('explorer', [], harness.dependencies),
        /persisted router port is invalid/,
    );
    assert.deepEqual(harness.events, []);
});
