import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
    createAgentRouteEntries,
    createLeaseCommittedAgent,
    handleRouterMcp,
    pinAggregateAsyncTaskRoute,
    proxyHttpBuffered,
    proxyHttpPassthrough,
} from '../../cli/server/routerHandlers.js';
import { createRootAgentDialContext } from '../../cli/server/rootAgentDial.js';
import { createAgentRootUpgradeDialAgent } from '../../cli/server/wsAgentRootProxy.js';
import { serveAgentStaticRequest } from '../../cli/server/static/index.js';
import { __testables as edgeRouteTestables } from '../../cli/server/edgeRoutePlan.js';

function responseCapture() {
    let resolve;
    const completed = new Promise((done) => { resolve = done; });
    return {
        headersSent: false,
        statusCode: 0,
        headers: {},
        body: '',
        completed,
        writeHead(statusCode, headers = {}) {
            this.statusCode = statusCode;
            this.headers = { ...headers };
            this.headersSent = true;
            return this;
        },
        end(value = '') {
            this.body += Buffer.isBuffer(value) ? value.toString('utf8') : String(value || '');
            resolve();
        },
    };
}

test('edge additional-port runtime resolution preserves the Docker and Podman relay ABI', () => {
    const route = {
        container: 'alpha-runtime',
        repo: 'repo',
        agent: 'alpha-agent',
    };
    const baseRecord = {
        type: 'agent',
        repoName: 'repo',
        agentName: 'alpha-agent',
        containerId: 'a'.repeat(64),
        instanceId: 'instance-1',
        enableGeneration: 'generation-1',
    };
    const snapshotFor = (runtime) => ({
        agents: {
            'alpha-runtime': {
                ...baseRecord,
                ...(runtime === undefined ? {} : { runtime }),
            },
        },
        manifests: {},
    });

    for (const runtime of ['docker', 'podman']) {
        assert.equal(
            edgeRouteTestables.exactAgentRuntime(snapshotFor(runtime), 'alpha', route).runtime,
            runtime,
        );
    }
    for (const runtime of [undefined, null, '', 'container', 'Podman', ' podman ', 'podman ']) {
        assert.equal(
            edgeRouteTestables.exactAgentRuntime(snapshotFor(runtime), 'alpha', route),
            null,
            `runtime ${JSON.stringify(runtime)} must not produce a relay target`,
        );
    }
});

test('edge root owner attestation is exact for bwrap and seatbelt and rejects malformed runtimes', () => {
    const route = {
        container: 'alpha-runtime',
        repo: 'repo',
        agent: 'alpha-agent',
    };
    const owner = Object.freeze({
        role: 'service',
        pid: 1234,
        runtimeKey: 'alpha-runtime',
        routeKey: 'alpha',
        rootPort: 4123,
        instanceId: 'instance-1',
        enableGeneration: 'generation-1',
    });
    const snapshotFor = (runtime) => ({
        agents: {
            'alpha-runtime': {
                type: 'agent',
                runtime,
                pid: 1234,
                repoName: 'repo',
                agentName: 'alpha-agent',
                instanceId: 'instance-1',
                enableGeneration: 'generation-1',
                bwrapOwner: owner,
            },
        },
    });

    for (const runtime of ['bwrap', 'seatbelt']) {
        assert.deepEqual(
            edgeRouteTestables.sandboxRootOwnerAttestation(snapshotFor(runtime), 'alpha', route, 4123),
            { kind: 'sandbox', runtime, owner },
        );
    }
    for (const runtime of [undefined, 'container', 'docker', ' bwrap ', ' seatbelt ']) {
        assert.deepEqual(
            edgeRouteTestables.sandboxRootOwnerAttestation(snapshotFor(runtime), 'alpha', route, 4123),
            { kind: 'not-sandbox' },
        );
    }
});

test('aggregate async task metadata is pinned to the captured Router route key', () => {
    const upstream = {
        content: [{ type: 'text', text: 'Task queued' }],
        metadata: {
            taskId: 'task-1',
            agent: 'agent:demo/demo',
            status: 'queued',
        },
    };

    assert.deepEqual(pinAggregateAsyncTaskRoute(upstream, 'demo'), {
        content: upstream.content,
        metadata: {
            taskId: 'task-1',
            agent: 'demo',
            status: 'queued',
        },
    });
    assert.equal(pinAggregateAsyncTaskRoute({ content: [] }, 'demo').metadata, undefined);
    assert.equal(upstream.metadata.agent, 'agent:demo/demo');
});

test('lease guard runs synchronously inside the actual connection factory', async () => {
    let guardCalls = 0;
    let connectionFactoryCalls = 0;
    const dialContext = createRootAgentDialContext({
        routePlan: {
            lease: {
                snapshot: { agents: {} },
                commit: () => {
                    guardCalls += 1;
                    return false;
                },
            },
        },
        route: { hostPort: 9 },
        targetPort: 9,
    });
    const agent = createLeaseCommittedAgent(dialContext, {
        createConnection() {
            connectionFactoryCalls += 1;
            throw new Error('connection factory must not run for a stale lease');
        },
    });

    await new Promise((resolve, reject) => {
        const request = agent.createConnection({ host: '127.0.0.1', port: 9 }, (error) => {
            try {
                assert.equal(error.code, 'EDGE_GENERATION_CHANGED');
                resolve();
            } catch (assertionError) {
                reject(assertionError);
            }
        });
        assert.equal(request, undefined);
        assert.equal(guardCalls, 1);
        assert.equal(connectionFactoryCalls, 0);
    });
});

test('fabricated unbranded dial contexts cannot authorize a root socket', () => {
    const agent = createLeaseCommittedAgent({ targetPort: 9, commit: () => true });
    assert.equal(agent, undefined);
});

test('guarded root agents reject non-loopback hosts and non-numeric ports before commit or socket', async () => {
    let leaseCommits = 0;
    let connectionFactoryCalls = 0;
    const dialContext = createRootAgentDialContext({
        routePlan: {
            lease: {
                snapshot: { agents: {} },
                commit: () => {
                    leaseCommits += 1;
                    return true;
                },
            },
        },
        route: { hostPort: 4127 },
        targetPort: 4127,
    });
    const agent = createLeaseCommittedAgent(dialContext, {
        createConnection() {
            connectionFactoryCalls += 1;
            throw new Error('invalid target must never reach the socket factory');
        },
    });

    for (const options of [
        { host: '203.0.113.1', port: 4127 },
        { host: '127.0.0.1', port: '4127' },
    ]) {
        await new Promise((resolve, reject) => {
            agent.createConnection(options, (error) => {
                try {
                    assert.equal(error.code, 'EDGE_GENERATION_CHANGED');
                    resolve();
                } catch (assertionError) {
                    reject(assertionError);
                }
            });
        });
    }
    assert.equal(leaseCommits, 0);
    assert.equal(connectionFactoryCalls, 0);
    assert.throws(
        () => createRootAgentDialContext({
            routePlan: { lease: { snapshot: { agents: {} }, commit: () => true } },
            route: { hostPort: '4127' },
        }),
        /exact target port/,
    );
});

test('stale bwrap owner assertion prevents the kernel socket after the captured lease commits', async () => {
    let leaseCommits = 0;
    let ownerAssertions = 0;
    let connectionFactoryCalls = 0;
    const owner = Object.freeze({
        role: 'service',
        pid: 1234,
        runtimeKey: 'alpha-runtime',
        routeKey: 'alpha',
        rootPort: 4123,
        instanceId: 'instance-1',
        enableGeneration: 'generation-1',
    });
    const route = Object.freeze({
        container: 'alpha-runtime',
        repo: 'repo',
        agent: 'alpha-agent',
        hostPort: 4123,
    });
    const routePlan = Object.freeze({
        lease: Object.freeze({
            snapshot: Object.freeze({
                agents: Object.freeze({
                    'alpha-runtime': Object.freeze({
                        type: 'agent',
                        runtime: 'bwrap',
                        pid: 1234,
                        repoName: 'repo',
                        agentName: 'alpha-agent',
                        instanceId: 'instance-1',
                        enableGeneration: 'generation-1',
                        bwrapOwner: owner,
                    }),
                }),
            }),
            commit: () => {
                leaseCommits += 1;
                return true;
            },
        }),
    });
    const dialContext = createRootAgentDialContext({
        routePlan,
        routeKey: 'alpha',
        route,
        targetPort: 4123,
    });
    const agent = createLeaseCommittedAgent(dialContext, {
        assertServiceOwner() {
            ownerAssertions += 1;
            throw new Error('pid start time changed');
        },
        createConnection() {
            connectionFactoryCalls += 1;
            throw new Error('stale owner must never reach the socket factory');
        },
    });

    await new Promise((resolve, reject) => {
        agent.createConnection({ host: '127.0.0.1', port: 4123 }, (error) => {
            try {
                assert.equal(error.code, 'EDGE_GENERATION_CHANGED');
                resolve();
            } catch (assertionError) {
                reject(assertionError);
            }
        });
    });
    assert.equal(leaseCommits, 1);
    assert.equal(ownerAssertions, 1);
    assert.equal(connectionFactoryCalls, 0);
});

test('seatbelt root dials require the same exact owner assertion before the kernel socket', async () => {
    let ownerAssertions = 0;
    let connectionFactoryCalls = 0;
    const owner = Object.freeze({
        role: 'service',
        pid: 1234,
        runtimeKey: 'alpha-runtime',
        routeKey: 'alpha',
        rootPort: 4128,
        instanceId: 'instance-1',
        enableGeneration: 'generation-1',
    });
    const route = Object.freeze({
        container: 'alpha-runtime',
        repo: 'repo',
        agent: 'alpha-agent',
        hostPort: 4128,
    });
    const routePlan = Object.freeze({
        kind: 'agent-root',
        routeKey: 'alpha',
        route,
        target: Object.freeze({ hostPort: 4128 }),
        ownerAttestation: owner,
        lease: Object.freeze({
            snapshot: Object.freeze({
                agents: Object.freeze({
                    'alpha-runtime': Object.freeze({
                        type: 'agent',
                        runtime: 'seatbelt',
                        pid: 1234,
                        repoName: 'repo',
                        agentName: 'alpha-agent',
                        instanceId: 'instance-1',
                        enableGeneration: 'generation-1',
                        bwrapOwner: owner,
                    }),
                }),
            }),
            commit: () => true,
        }),
    });
    const agent = createLeaseCommittedAgent(createRootAgentDialContext({ routePlan }), {
        assertServiceOwner() {
            ownerAssertions += 1;
            throw new Error('seatbelt process identity changed');
        },
        createConnection() {
            connectionFactoryCalls += 1;
            throw new Error('stale owner must never reach the socket factory');
        },
    });

    await new Promise((resolve, reject) => {
        agent.createConnection({ host: '127.0.0.1', port: 4128 }, (error) => {
            try {
                assert.equal(error.code, 'EDGE_GENERATION_CHANGED');
                resolve();
            } catch (assertionError) {
                reject(assertionError);
            }
        });
    });
    assert.equal(ownerAssertions, 1);
    assert.equal(connectionFactoryCalls, 0);
});

test('a plan owner that differs from the captured bwrap record is rejected before dialing', async () => {
    let connectionFactoryCalls = 0;
    let ownerAssertions = 0;
    const targetPort = 4126;
    const recordOwner = Object.freeze({
        role: 'service',
        pid: 1234,
        runtimeKey: 'alpha-runtime',
        routeKey: 'alpha',
        rootPort: targetPort,
        instanceId: 'instance-1',
        enableGeneration: 'generation-1',
    });
    const route = Object.freeze({
        container: 'alpha-runtime',
        repo: 'repo',
        agent: 'alpha-agent',
        hostPort: targetPort,
    });
    const routePlan = Object.freeze({
        routeKey: 'alpha',
        route,
        target: Object.freeze({ hostPort: targetPort }),
        ownerAttestation: Object.freeze({ ...recordOwner, pid: 9999 }),
        lease: Object.freeze({
            snapshot: Object.freeze({
                agents: Object.freeze({
                    'alpha-runtime': Object.freeze({
                        type: 'agent',
                        runtime: 'bwrap',
                        pid: 1234,
                        repoName: 'repo',
                        agentName: 'alpha-agent',
                        instanceId: 'instance-1',
                        enableGeneration: 'generation-1',
                        bwrapOwner: recordOwner,
                    }),
                }),
            }),
            commit: () => true,
        }),
    });
    const agent = createLeaseCommittedAgent(createRootAgentDialContext({ routePlan }), {
        assertServiceOwner() {
            ownerAssertions += 1;
        },
        createConnection() {
            connectionFactoryCalls += 1;
        },
    });

    await new Promise((resolve, reject) => {
        agent.createConnection({ host: '127.0.0.1', port: targetPort }, (error) => {
            try {
                assert.equal(error.code, 'EDGE_GENERATION_CHANGED');
                resolve();
            } catch (assertionError) {
                reject(assertionError);
            }
        });
    });
    assert.equal(ownerAssertions, 0);
    assert.equal(connectionFactoryCalls, 0);
});

test('container root dials commit the lease without running the bwrap owner assertion', () => {
    let ownerAssertions = 0;
    let connectionFactoryCalls = 0;
    const route = Object.freeze({
        container: 'alpha-runtime',
        repo: 'repo',
        agent: 'alpha-agent',
        hostPort: 4124,
    });
    const dialContext = createRootAgentDialContext({
        routePlan: Object.freeze({
            lease: Object.freeze({
                snapshot: Object.freeze({
                    agents: Object.freeze({
                        'alpha-runtime': Object.freeze({
                            type: 'agent',
                            runtime: 'docker',
                            repoName: 'repo',
                            agentName: 'alpha-agent',
                        }),
                    }),
                }),
                commit: () => true,
            }),
        }),
        routeKey: 'alpha',
        route,
        targetPort: 4124,
    });
    const sentinel = {};
    const agent = createLeaseCommittedAgent(dialContext, {
        assertServiceOwner() {
            ownerAssertions += 1;
        },
        createConnection() {
            connectionFactoryCalls += 1;
            return sentinel;
        },
    });

    assert.equal(
        agent.createConnection({ host: '127.0.0.1', port: 4124 }, () => {}),
        sentinel,
    );
    assert.equal(connectionFactoryCalls, 1);
    assert.equal(ownerAssertions, 0);
});

test('websocket root upgrade refuses a stale bwrap owner before creating its socket', async () => {
    let ownerAssertions = 0;
    let connectionFactoryCalls = 0;
    const targetPort = 4125;
    const plan = Object.freeze({
        kind: 'agent-root',
        routeKey: 'alpha',
        route: Object.freeze({
            container: 'alpha-runtime',
            repo: 'repo',
            agent: 'alpha-agent',
        }),
        target: Object.freeze({ hostPort: targetPort }),
        ownerAttestation: Object.freeze({
            role: 'service',
            pid: 1234,
            runtimeKey: 'alpha-runtime',
            routeKey: 'alpha',
            rootPort: targetPort,
            instanceId: 'instance-1',
            enableGeneration: 'generation-1',
        }),
        lease: Object.freeze({
            snapshot: Object.freeze({
                agents: Object.freeze({
                    'alpha-runtime': Object.freeze({
                        type: 'agent',
                        runtime: 'bwrap',
                        pid: 1234,
                        repoName: 'repo',
                        agentName: 'alpha-agent',
                        instanceId: 'instance-1',
                        enableGeneration: 'generation-1',
                        bwrapOwner: Object.freeze({
                            role: 'service',
                            pid: 1234,
                            runtimeKey: 'alpha-runtime',
                            routeKey: 'alpha',
                            rootPort: targetPort,
                            instanceId: 'instance-1',
                            enableGeneration: 'generation-1',
                        }),
                    }),
                }),
            }),
            commit: () => true,
        }),
    });
    const agent = createAgentRootUpgradeDialAgent(plan, targetPort, {
        assertServiceOwner() {
            ownerAssertions += 1;
            throw new Error('stale websocket owner');
        },
        createConnection() {
            connectionFactoryCalls += 1;
            throw new Error('stale websocket owner must not dial');
        },
    });

    await new Promise((resolve, reject) => {
        agent.createConnection({ host: '127.0.0.1', port: targetPort }, (error) => {
            try {
                assert.equal(error.code, 'EDGE_GENERATION_CHANGED');
                resolve();
            } catch (assertionError) {
                reject(assertionError);
            }
        });
    });
    assert.equal(ownerAssertions, 1);
    assert.equal(connectionFactoryCalls, 0);
});

test('stale HTTP/SSE and buffered leases return 503 before opening a target connection', async () => {
    const streamingReq = new PassThrough();
    streamingReq.method = 'GET';
    streamingReq.headers = { accept: 'text/event-stream' };
    const streamingRes = responseCapture();
    proxyHttpPassthrough(streamingReq, streamingRes, 9, '/events', {}, {
        dialContext: createRootAgentDialContext({
            routePlan: { lease: { snapshot: { agents: {} }, commit: () => false } },
            route: { hostPort: 9 },
            targetPort: 9,
        }),
    });
    streamingReq.end();
    await streamingRes.completed;
    assert.equal(streamingRes.statusCode, 503);
    assert.match(streamingRes.body, /edge_generation_changed/);

    const bufferedReq = new PassThrough();
    bufferedReq.method = 'POST';
    bufferedReq.headers = { 'content-type': 'application/json' };
    const bufferedRes = responseCapture();
    proxyHttpBuffered(
        bufferedReq,
        bufferedRes,
        9,
        '/submit',
        Buffer.from('{"ok":true}'),
        {},
        {
            dialContext: createRootAgentDialContext({
                routePlan: { lease: { snapshot: { agents: {} }, commit: () => false } },
                route: { hostPort: 9 },
                targetPort: 9,
            }),
        },
    );
    await bufferedRes.completed;
    assert.equal(bufferedRes.statusCode, 503);
    assert.match(bufferedRes.body, /edge_generation_changed/);
});

test('aggregate MCP clients refuse a stale captured generation before dialing', async () => {
    const routePlan = {
        lease: {
            snapshot: {
                routing: {
                    routes: {
                        captured: { hostPort: 9 },
                    },
                },
            },
            commit: () => false,
        },
    };
    const entries = createAgentRouteEntries(routePlan);
    assert.deepEqual(entries.map((entry) => entry.agentName), ['captured']);
    await assert.rejects(
        entries[0].client.listTools(),
        (error) => error?.code === 'EDGE_GENERATION_CHANGED',
    );
});

test('aggregate MCP request returns 503 when its captured lease is stale', async () => {
    const routePlan = {
        lease: {
            snapshot: {
                routing: { routes: { captured: { hostPort: 9 } } },
            },
            commit: () => false,
        },
    };
    const req = new PassThrough();
    req.method = 'POST';
    req.headers = { 'content-type': 'application/json' };
    const res = responseCapture();

    await handleRouterMcp(req, res, routePlan);
    req.end(JSON.stringify({ command: 'list_tools' }));
    await res.completed;

    assert.equal(res.statusCode, 503);
    assert.match(res.body, /edge_generation_changed/);
});

test('agent static dispatch refuses a stale generation before opening a file', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-edge-static-'));
    fs.writeFileSync(path.join(root, 'index.html'), '<h1>captured</h1>');
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const res = responseCapture();
    const handled = await serveAgentStaticRequest({
        url: '/captured/index.html',
        headers: { host: 'localhost' },
    }, res, {
        routeKey: 'captured',
        hostPath: root,
        beforeRead: () => false,
    });

    await res.completed;
    assert.equal(handled, true);
    assert.equal(res.statusCode, 503);
    assert.match(res.body, /edge_generation_changed/);
});
