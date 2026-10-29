import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';

import { RelayFrameDecoder, encodeRelayFrame } from '../../Agent/lib/runtimeRelayProtocol.mjs';
import { NETWORK_LABELS } from '../../cli/sandbox/networkLifecycle.js';
import { finalizePlanAfterAdmission } from '../../cli/server/proxy/RoutePlan.js';
import { RelayRequestMinter } from '../../cli/server/runtimeRelay/relayRequestMinter.js';
import { RuntimeRelayManager } from '../../cli/server/runtimeRelay/RuntimeRelayManager.js';
import {
    PROVIDER_REQUEST_INVALID,
    PROVIDER_UNAVAILABLE,
    isTaskReferenceId,
    planProviderEndpoint,
    validateTaskEventsQuery,
} from '../../cli/server/executionProvider/providerEndpointPlan.mjs';
import { domainFixture } from './directDomainFixtures.mjs';

const ID = 'A'.repeat(22);
const LONG_ID = `${'b'.repeat(63)}_`;
const providerOf = (name, port, extra = {}) => ({
    version: 1,
    port,
    taskReferences: { path: `/${name}/task-refs` },
    terminals: { path: `/${name}/terminal-control` },
    ...extra,
});

function writeManifest(world, name, change) {
    const file = path.join(world.root, 'fixtures', name, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    change(manifest);
    fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
}

function fixture(t) {
    const world = domainFixture(t, { mode: 'dual' });
    for (const [name, hostPort] of [['explorer', 43101], ['bizanso', 43102]]) {
        world.agents[`${name}-container`].config = { ports: [{ containerPort: 7000, hostPort, hostIp: '127.0.0.1', protocol: 'tcp' }] };
    }
    world.write(world.paths.agentsFile, world.agents);
    writeManifest(world, 'explorer', (m) => { m.executionProvider = providerOf('explorer', 7300); });
    writeManifest(world, 'bizanso', (m) => { m.executionProvider = providerOf('bizanso', 7400, { terminals: undefined, taskReferences: { path: '/bizanso/refs' } }); });
    world.apply();
    // A harmless manifest edit that makes the next generation differ.
    world.newGeneration = () => {
        writeManifest(world, 'unrelated', (m) => { m.note = (m.note || 0) + 1; });
        world.apply();
    };
    return world;
}

const terminal = { routeKey: 'explorer', endpoint: 'terminals', method: 'GET', transport: 'websocket' };
const refs = (extra) => ({ routeKey: 'explorer', endpoint: 'taskReferences', ...extra });

test('two providers resolve independently from the active generation, with their own port, path and runtime identity', (t) => {
    const world = fixture(t);
    const first = planProviderEndpoint(terminal);
    assert.equal(first.ok, true);
    assert.equal(first.kind, 'provider-endpoint');
    assert.equal(first.surfaceKind, 'provider-endpoint');
    assert.equal(first.routeKey, 'explorer');
    assert.equal(first.port, 7300);
    assert.equal(first.unmatchedSuffix, '/explorer/terminal-control');
    assert.equal(first.transport, 'websocket');
    assert.equal(first.relay.targetAgentId, 'agent:fixtures/explorer');
    assert.equal(first.relay.effectiveInstanceId, 'explorer-instance');
    assert.equal(first.owner.enableGeneration, 'explorer-enable');
    assert.deepEqual(first.deniedPorts, []);
    assert.equal(first.generationDigest, first.lease.id);
    assert.equal(first.targetPath, undefined, 'authorization has not happened, so there is no target path yet');
    assert.equal(Object.isFrozen(first), true);

    const second = planProviderEndpoint({ routeKey: 'bizanso', endpoint: 'taskReferences', subpath: `/${ID}`, method: 'GET' });
    assert.equal(second.ok, true);
    assert.equal(second.port, 7400);
    assert.equal(second.relay.targetAgentId, 'agent:fixtures/bizanso');
    assert.equal(second.relay.containerId, world.agents['bizanso-container'].containerId);
    assert.notEqual(second.relay.containerId, first.relay.containerId);
    assert.equal(finalizePlanAfterAdmission(second).targetPath, `/bizanso/refs/${ID}`);
    assert.equal(finalizePlanAfterAdmission(first).targetPath, '/explorer/terminal-control');
    // The plan is a distinct kind: nothing that accepts an `agent-port` plan accepts it.
    assert.notEqual(second.kind, 'agent-port');
    assert.notEqual(second.surfaceKind, 'agent-port-convention');
});

test('a host-network provider plan carries the Router ports in its deny set, as an agent-port plan does', (t) => {
    const world = fixture(t);
    assert.deepEqual(planProviderEndpoint(terminal).deniedPorts, []);
    writeManifest(world, 'bizanso', (m) => { m.network = { mode: 'host' }; });
    world.agents['bizanso-container'].config = { ports: [] };
    world.write(world.paths.agentsFile, world.agents);
    world.apply();
    const plan = planProviderEndpoint({ routeKey: 'bizanso', endpoint: 'taskReferences', subpath: `/${ID}` });
    assert.equal(plan.ok, true);
    assert.equal(plan.relay.networkMode, 'host');
    assert.deepEqual(plan.deniedPorts, [8080, 8081]);
});

test('the operation grammar is fixed: terminals and task references accept only their listed operations', (t) => {
    fixture(t);
    const okPlan = (input, target) => {
        const plan = planProviderEndpoint(input);
        assert.equal(plan.ok, true, JSON.stringify(input));
        assert.equal(finalizePlanAfterAdmission(plan).targetPath, target, JSON.stringify(input));
        assert.equal(plan.query, input.query ?? '');
    };
    okPlan(terminal, '/explorer/terminal-control');
    okPlan({ routeKey: 'explorer', endpoint: 'terminals', subpath: '/targets', method: 'POST' }, '/explorer/terminal-control/targets');
    okPlan(refs({ subpath: `/${ID}` }), `/explorer/task-refs/${ID}`);
    okPlan(refs({ subpath: `/${LONG_ID}` }), `/explorer/task-refs/${LONG_ID}`);
    okPlan(refs({ subpath: `/${ID}/events` }), `/explorer/task-refs/${ID}/events`);
    okPlan(refs({ subpath: `/${ID}/events`, query: 'after=0&limit=1000' }), `/explorer/task-refs/${ID}/events`);
    okPlan(refs({ subpath: `/${ID}/control`, method: 'POST' }), `/explorer/task-refs/${ID}/control`);
    okPlan(refs({ subpath: '/lookup', method: 'POST' }), '/explorer/task-refs/lookup');

    const invalid = [
        { ...terminal, transport: 'http' }, { ...terminal, method: 'POST' }, { ...terminal, subpath: '/targets' },
        { ...terminal, query: 'a=1' }, { ...terminal, subpath: '/other' },
        { routeKey: 'explorer', endpoint: 'terminals', subpath: '/targets', method: 'GET' },
        { routeKey: 'explorer', endpoint: 'terminals', subpath: '/targets', method: 'POST', transport: 'websocket' },
        { routeKey: 'explorer', endpoint: 'terminals', subpath: '/targets', method: 'POST', query: 'x=1' },
        refs({ subpath: '' }), refs({ subpath: '/' }), refs({ subpath: '/lookup' }), refs({ subpath: '/lookup', method: 'POST', query: 'x' }),
        refs({ subpath: `/${ID}`, method: 'POST' }), refs({ subpath: `/${ID}`, query: 'after=0&limit=1' }),
        refs({ subpath: `/${ID}/control` }), refs({ subpath: `/${ID}/control`, method: 'POST', query: 'x=1' }),
        refs({ subpath: `/${ID}/events`, method: 'POST' }), refs({ subpath: `/${ID}/other` }), refs({ subpath: `/${ID}/events/x` }),
        refs({ subpath: `/${'A'.repeat(21)}` }), refs({ subpath: `/${'A'.repeat(65)}` }), refs({ subpath: '/abc.def' }),
        refs({ subpath: `/${ID}/` }), refs({ subpath: `//${ID}` }), refs({ subpath: `/../${ID}` }), refs({ subpath: '/../../api/coord' }),
        refs({ subpath: `/${ID}%2Fevents` }), refs({ subpath: `/${ID}`, transport: 'websocket' }), refs({ subpath: `/${ID}`, method: 'get' }),
        refs({ subpath: `/${ID}/events`, query: 'limit=5&after=0' }),
    ];
    for (const input of invalid) {
        const plan = planProviderEndpoint(input);
        assert.equal(plan.ok, false, JSON.stringify(input));
        assert.equal(plan.code, PROVIDER_REQUEST_INVALID, JSON.stringify(input));
        assert.equal(plan.status, 400);
    }
});

test('task identifiers and the events query use the plan grammar', () => {
    assert.equal(isTaskReferenceId('A'.repeat(22)), true);
    assert.equal(isTaskReferenceId('a-_9'.repeat(16)), true);
    for (const id of ['A'.repeat(21), 'A'.repeat(65), '', 'a b'.repeat(8), `${'A'.repeat(21)}=`, `${'A'.repeat(21)}.`, 7, null]) {
        assert.equal(isTaskReferenceId(id), false, String(id));
    }
    assert.deepEqual(validateTaskEventsQuery(''), { ok: true, after: null, limit: null });
    assert.deepEqual(validateTaskEventsQuery('after=0&limit=1'), { ok: true, after: 0, limit: 1 });
    assert.deepEqual(validateTaskEventsQuery('after=9007199254740991&limit=1000'), { ok: true, after: 9007199254740991, limit: 1000 });
    for (const query of ['after=9007199254740992&limit=5', 'after=9999999999999999&limit=5', 'after=00&limit=5', 'after=01&limit=5',
        'after=-1&limit=5', 'after=+1&limit=5', 'after=1.5&limit=5', 'after=&limit=5', 'after=1&limit=0', 'after=1&limit=1001',
        'after=1&limit=05', 'after=1&limit=-1', 'after=1', 'limit=5', 'limit=5&after=1', 'after=1&after=2&limit=5', 'after=1&limit=5&limit=6',
        'after=1&limit=5&x=1', 'after=1&limit=5&', '&after=1&limit=5', 'after=1&limit=5#f', 'After=1&limit=5', 'after=0x10&limit=5',
        'after=%31&limit=5', 'after=1;limit=5', 'x=1', '?after=1&limit=5', ' after=1&limit=5', null, undefined, 5]) {
        assert.equal(validateTaskEventsQuery(query).ok, false, String(query));
    }
});

test('the input is exact: unknown keys, wrong types and unknown endpoints are refused as caller bugs', (t) => {
    fixture(t);
    for (const input of [null, undefined, [], 'x', 7]) assert.throws(() => planProviderEndpoint(input), TypeError);
    // No caller-supplied request, snapshot, lease, URL or port.
    for (const key of ['req', 'request', 'snapshot', 'lease', 'url', 'baseUrl', 'port', 'host', 'headers', 'path', 'body']) {
        assert.throws(() => planProviderEndpoint({ ...terminal, [key]: key === 'port' ? 7300 : {} }), /unsupported input key/, key);
    }
    assert.throws(() => planProviderEndpoint({ endpoint: 'terminals' }), TypeError);
    assert.throws(() => planProviderEndpoint({ routeKey: 'explorer' }), TypeError);
    assert.throws(() => planProviderEndpoint({ ...terminal, routeKey: 7 }), TypeError);
    assert.throws(() => planProviderEndpoint({ ...terminal, query: 7 }), TypeError);
    assert.throws(() => planProviderEndpoint({ ...terminal, endpoint: 'coordinator' }), /unknown endpoint/);
    assert.throws(() => planProviderEndpoint({ ...terminal, endpoint: '__proto__' }), /unknown endpoint/);
});

test('missing, disabled, draining, undeclared and malformed providers report explicit unavailability, never a fallback', (t) => {
    const world = fixture(t);
    const unavailable = (input, label) => {
        const plan = planProviderEndpoint(input);
        assert.equal(plan.ok, false, label);
        assert.equal(plan.status, 503, label);
        assert.equal(plan.code, PROVIDER_UNAVAILABLE, label);
    };
    unavailable({ ...terminal, routeKey: 'nobody' }, 'unknown route');
    unavailable({ ...terminal, routeKey: 'unrelated' }, 'no declaration');
    unavailable({ routeKey: 'bizanso', endpoint: 'terminals', method: 'GET', transport: 'websocket' }, 'endpoint not declared');
    unavailable({ ...terminal, routeKey: '__proto__' }, 'prototype key');
    unavailable({ ...terminal, routeKey: 'constructor' }, 'inherited key');

    world.routing.routes.explorer.draining = true;
    world.write(world.paths.routingFile, world.routing);
    world.apply();
    unavailable(terminal, 'draining');
    assert.equal(planProviderEndpoint({ routeKey: 'bizanso', endpoint: 'taskReferences', subpath: `/${ID}` }).ok, true, 'the other provider is unaffected');

    delete world.routing.routes.explorer.draining;
    const bizansoRefs = { routeKey: 'bizanso', endpoint: 'taskReferences', subpath: `/${ID}` };
    world.routing.routes.bizanso.disabled = true;
    world.write(world.paths.routingFile, world.routing);
    world.apply();
    unavailable(bizansoRefs, 'disabled');
    assert.equal(planProviderEndpoint(terminal).ok, true, 'the other provider is unaffected');

    delete world.routing.routes.bizanso.disabled;
    world.write(world.paths.routingFile, world.routing);
    world.apply();
    assert.equal(planProviderEndpoint(terminal).ok, true);
    assert.equal(planProviderEndpoint(bizansoRefs).ok, true);
    // A runtime that is not the exact registered one is unavailable too.
    delete world.agents['explorer-container'].containerId;
    world.write(world.paths.agentsFile, world.agents);
    world.apply();
    unavailable(terminal, 'runtime identity missing');
});

// ---- generation changes before checkout or OPEN prevent forwarding ----

class FakeRelayChild extends EventEmitter {
    constructor() {
        super();
        this.frames = [];
        this.stdout = new PassThrough();
        this.stderr = new PassThrough();
        const decoder = new RelayFrameDecoder();
        decoder.on('frame', (frame) => {
            this.frames.push(frame);
            if (frame.type === 'HELLO') {
                setImmediate(() => this.stdout.write(encodeRelayFrame({
                    type: 'READY',
                    containerId: frame.containerId,
                    effectiveInstanceId: frame.effectiveInstanceId,
                    enableGeneration: frame.enableGeneration,
                    generationDigest: frame.generationDigest,
                    denySetDigest: frame.denySetDigest,
                })));
            }
        });
        this.stdin = new Writable({ write: (chunk, _e, callback) => { decoder.push(chunk); callback(); } });
    }

    kill() {}
}

function relayHarness(t, world) {
    const children = [];
    let opened = 0;
    const manager = new RuntimeRelayManager({
        minter: new RelayRequestMinter({ resolveAgentSecret: () => assert.fail('channel key expected'), createNonce: () => `n-${++opened}` }),
        inspectContainer: async (_runtime, containerId) => {
            const [name, record] = Object.entries(world.agents).find(([, value]) => value.containerId === containerId);
            return {
                Id: containerId,
                Name: `/${name}`,
                State: { Running: true },
                HostConfig: { NetworkMode: 'bridge' },
                Config: { Labels: {
                    [NETWORK_LABELS.managed]: '1',
                    [NETWORK_LABELS.resource]: 'agent',
                    [NETWORK_LABELS.instanceId]: record.instanceId,
                    [NETWORK_LABELS.enableGeneration]: record.enableGeneration,
                } },
            };
        },
        resolveSocket: () => ({ path: '/test/runtime-relay.sock' }),
        openTransport: async () => { const child = new FakeRelayChild(); children.push(child); return child; },
        channelIdleTimeoutMs: 5_000,
    });
    t.after(() => manager.close());
    return { manager, children };
}

const turns = async (count = 10) => { for (let i = 0; i < count; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

test('a finalized provider plan forwards through the relay to its own port and path', async (t) => {
    const world = fixture(t);
    const { manager, children } = relayHarness(t, world);
    for (const [input, port, target, mode] of [
        [terminal, '7300', '/explorer/terminal-control', 'websocket'],
        [{ routeKey: 'bizanso', endpoint: 'taskReferences', subpath: `/${ID}/events`, query: 'after=3&limit=7' }, '7400', `/bizanso/refs/${ID}/events`, 'http1'],
    ]) {
        const plan = finalizePlanAfterAdmission(planProviderEndpoint(input));
        const checkout = await manager.checkout({ plan, lease: plan.lease, authorized: true });
        const stream = await checkout.openRequest({ plan, bodyMode: 'none' });
        stream.on('error', () => {});
        await turns();
        const open = children.at(-1).frames.find((frame) => frame.type === 'OPEN');
        assert.equal(open.port, port);
        assert.equal(open.path, target);
        assert.equal(open.mode, mode);
        assert.equal(open.query, input.query || '');
        checkout.close();
    }
    assert.equal(children.length, 2, 'each provider has its own channel');
});

test('a generation change before checkout prevents forwarding: no transport, no OPEN', async (t) => {
    const world = fixture(t);
    const { manager, children } = relayHarness(t, world);
    const plan = finalizePlanAfterAdmission(planProviderEndpoint(terminal));
    assert.equal(plan.lease.commit(), true);
    world.newGeneration();
    assert.equal(plan.lease.commit(), false);
    await assert.rejects(() => manager.checkout({ plan, lease: plan.lease, authorized: true }), /generation lease is stale/);
    await turns();
    assert.equal(children.length, 0);
});

test('a generation change between checkout and OPEN prevents forwarding: no OPEN is written', async (t) => {
    const world = fixture(t);
    const { manager, children } = relayHarness(t, world);
    const plan = finalizePlanAfterAdmission(planProviderEndpoint(terminal));
    const checkout = await manager.checkout({ plan, lease: plan.lease, authorized: true });
    world.newGeneration();
    await assert.rejects(() => checkout.openRequest({ plan, bodyMode: 'none' }), /generation lease is stale/);
    await turns();
    assert.equal(children.at(-1).frames.some((frame) => frame.type === 'OPEN'), false);
    checkout.close();
    // Planning again captures the new generation and forwards.
    const fresh = finalizePlanAfterAdmission(planProviderEndpoint(terminal));
    assert.notEqual(fresh.generationDigest, plan.generationDigest);
    assert.equal(fresh.lease.commit(), true);
});

test('planning allocates no relay and grants no authorization', async (t) => {
    const world = fixture(t);
    const { manager, children } = relayHarness(t, world);
    const plan = planProviderEndpoint(terminal);
    assert.equal(children.length, 0);
    assert.equal(manager.channels.size, 0);
    // An unauthorized checkout is refused whatever the plan says.
    await assert.rejects(() => manager.checkout({ plan: finalizePlanAfterAdmission(plan), lease: plan.lease }), /authorization must complete/);
    assert.equal(children.length, 0);
    // An unfinalized plan cannot open a request.
    const checkout = await manager.checkout({ plan, lease: plan.lease, authorized: true });
    await assert.rejects(() => checkout.openRequest({ plan, bodyMode: 'none' }), /finalized route plan required/);
    checkout.close();
});
