import assert from 'node:assert/strict';
import test from 'node:test';

import {
    CLOUDFLARE_ORIGIN,
    CloudflarePublicationController,
    CloudflarePublicationError,
} from '../../ploinky-box/cloudflared/publicationController.mjs';
import { createEdgePublicationRouteCoordinator } from '../../ploinky-box/cloudflared/runtime.mjs';

const CONNECTOR_TOKEN = 'connector-secret-value';
const API_TOKEN = 'api-secret-value';

function desired(hostnames = ['office.example.test'], generationCharacter = 'a', cloudflare = {}) {
    return {
        configurationGeneration: `sha256:${generationCharacter.repeat(64)}`,
        cloudflare: {
            accountId: 'account_123',
            zoneId: 'zone_123',
            tunnelId: 'tunnel_123',
            tunnelTokenSecret: 'publication/cloudflare-connector',
            apiTokenSecret: 'publication/cloudflare-api',
            ...cloudflare,
        },
        hosts: Object.fromEntries(hostnames.map((hostname) => [hostname, {
            agent: `repo/${hostname.split('.')[0]}`,
        }])),
    };
}

function connectorDesired(hostnames = ['office.example.test'], generationCharacter = 'a') {
    return {
        configurationGeneration: `sha256:${generationCharacter.repeat(64)}`,
        cloudflare: {
            tunnelTokenSecret: 'publication/cloudflare-connector',
        },
        hosts: Object.fromEntries(hostnames.map((hostname) => [hostname, {
            agent: `repo/${hostname.split('.')[0]}`,
        }])),
    };
}

function managedDesired(
    hostnames = ['office.example.test'],
    generationCharacter = 'a',
    {
        deleteTunnelOnTeardown = false,
        tunnelName = 'explorer-qa',
    } = {},
) {
    return {
        configurationGeneration: `sha256:${generationCharacter.repeat(64)}`,
        cloudflare: {
            accountId: 'account_123',
            zoneId: 'zone_123',
            tunnelName,
            apiTokenSecret: 'publication/cloudflare-api',
            deleteTunnelOnTeardown,
        },
        hosts: Object.fromEntries(hostnames.map((hostname) => [hostname, {
            agent: `repo/${hostname.split('.')[0]}`,
        }])),
    };
}

function localDesired(generationCharacter = 'f') {
    return { configurationGeneration: `sha256:${generationCharacter.repeat(64)}` };
}

function createMemoryJournal(initial = null) {
    let value = initial ? structuredClone(initial) : null;
    const writes = [];
    return {
        writes,
        read() { return value ? structuredClone(value) : null; },
        write(next) {
            value = {
                updatedAt: new Date().toISOString(),
                ...structuredClone(next),
            };
            writes.push(structuredClone(value));
            return structuredClone(value);
        },
    };
}

function createMemoryManagedTunnelRegistry() {
    const entries = [];
    let nextOwnership = 1;
    return {
        entries,
        findDesired({ accountId, zoneId, tunnelName }) {
            return structuredClone(entries.find((entry) => (
                entry.accountId === accountId
                && entry.zoneId === zoneId
                && entry.requestedName === tunnelName
            )) || null);
        },
        findScope({ accountId, tunnelId }) {
            return structuredClone(entries.find((entry) => (
                entry.accountId === accountId && entry.tunnelId === tunnelId
            )) || null);
        },
        begin({ accountId, zoneId, tunnelName, deleteOnTeardown }) {
            const existing = entries.find((entry) => (
                entry.accountId === accountId
                && entry.zoneId === zoneId
                && entry.requestedName === tunnelName
            ));
            if (existing) {
                existing.deleteOnTeardown = deleteOnTeardown === true;
                return structuredClone(existing);
            }
            const ownershipId = `00000000-0000-4000-8000-${String(nextOwnership++).padStart(12, '0')}`;
            const entry = {
                ownershipId,
                accountId,
                zoneId,
                requestedName: tunnelName,
                cloudflareName: `${tunnelName}--ploinky-${ownershipId}`,
                tunnelId: '',
                deleteOnTeardown: deleteOnTeardown === true,
            };
            entries.push(entry);
            return structuredClone(entry);
        },
        commit({ ownershipId, tunnelId }) {
            const entry = entries.find((candidate) => candidate.ownershipId === ownershipId);
            assert.ok(entry);
            if (entry.tunnelId) assert.equal(entry.tunnelId, tunnelId);
            entry.tunnelId = tunnelId;
            return structuredClone(entry);
        },
        remove({ ownershipId, tunnelId }) {
            const index = entries.findIndex((entry) => entry.ownershipId === ownershipId);
            if (index < 0) return false;
            assert.equal(entries[index].tunnelId, tunnelId);
            entries.splice(index, 1);
            return true;
        },
    };
}

function createFakeApi(events) {
    const ingress = new Map();
    const dns = new Map();
    const tunnels = new Map();
    let nextRecordId = 1;
    let nextTunnelId = 1;
    const api = {
        ingress,
        dns,
        tunnels,
        failValidate: null,
        failCreateDnsOnce: null,
        failDeleteDnsRecordIdOnce: null,
        blockPutIngress: null,
        async validateAccountZone(input) {
            events.push({
                event: 'api.validateAccountZone',
                accountId: input.accountId,
                zoneId: input.zoneId,
            });
            if (api.failValidate) throw api.failValidate;
            return { ok: true };
        },
        async validateScope(input) {
            events.push({ event: 'api.validateScope', scope: {
                accountId: input.accountId,
                zoneId: input.zoneId,
                tunnelId: input.tunnelId,
            } });
            if (api.failValidate) throw api.failValidate;
            return { ok: true };
        },
        async listTunnels({ accountId, name }) {
            events.push({ event: 'api.listTunnels', accountId, name });
            return [...tunnels.values()]
                .filter((tunnel) => tunnel.account_tag === accountId
                    && tunnel.name === name
                    && !tunnel.deleted_at)
                .map((tunnel) => structuredClone(tunnel));
        },
        async createTunnel({ accountId, name }) {
            events.push({ event: 'api.createTunnel', accountId, name });
            const tunnel = {
                id: `managed_tunnel_${nextTunnelId++}`,
                account_tag: accountId,
                name,
                config_src: 'cloudflare',
                deleted_at: null,
            };
            tunnels.set(tunnel.id, tunnel);
            return structuredClone(tunnel);
        },
        async getTunnelToken({ tunnelId }) {
            events.push({ event: 'api.getTunnelToken', tunnelId });
            assert.ok(tunnels.has(tunnelId));
            return `managed-connector-token-${tunnelId}`;
        },
        async deleteTunnel({ accountId, tunnelId }) {
            events.push({ event: 'api.deleteTunnel', accountId, tunnelId });
            const tunnel = tunnels.get(tunnelId);
            assert.equal(tunnel?.account_tag, accountId);
            tunnel.deleted_at = new Date().toISOString();
            return structuredClone(tunnel);
        },
        async putTunnelIngress(input) {
            events.push({ event: 'api.putIngress', tunnelId: input.tunnelId, ingress: structuredClone(input.ingress) });
            if (api.blockPutIngress) await api.blockPutIngress;
            ingress.set(`${input.accountId}/${input.tunnelId}`, structuredClone(input.ingress));
            return structuredClone(input.ingress);
        },
        async readTunnelIngress(input) {
            events.push({ event: 'api.readIngress', tunnelId: input.tunnelId });
            return structuredClone(ingress.get(`${input.accountId}/${input.tunnelId}`) || []);
        },
        async listDnsRecords({ zoneId, hostname }) {
            events.push({ event: 'api.listDns', zoneId, hostname });
            const record = dns.get(`${zoneId}/${hostname}`);
            return record ? [structuredClone(record)] : [];
        },
        async createDnsRecord({ zoneId, record }) {
            events.push({ event: 'api.createDns', zoneId, hostname: record.name });
            if (api.failCreateDnsOnce) {
                const error = api.failCreateDnsOnce;
                api.failCreateDnsOnce = null;
                throw error;
            }
            const saved = { id: `record-${nextRecordId++}`, ...structuredClone(record) };
            dns.set(`${zoneId}/${record.name}`, saved);
            return structuredClone(saved);
        },
        async updateDnsRecord({ zoneId, recordId, record }) {
            events.push({ event: 'api.updateDns', zoneId, hostname: record.name, recordId });
            const saved = { id: recordId, ...structuredClone(record) };
            dns.set(`${zoneId}/${record.name}`, saved);
            return structuredClone(saved);
        },
        async deleteDnsRecord({ zoneId, recordId }) {
            events.push({ event: 'api.deleteDns', zoneId, recordId });
            if (api.failDeleteDnsRecordIdOnce === recordId) {
                api.failDeleteDnsRecordIdOnce = null;
                throw new CloudflarePublicationError('temporary DNS delete failure', {
                    code: 'CLOUDFLARE_API_OPERATION_FAILED',
                    operation: 'delete-dns-record',
                    retryable: true,
                });
            }
            for (const [key, record] of dns.entries()) {
                if (key.startsWith(`${zoneId}/`) && record.id === recordId) dns.delete(key);
            }
            return { id: recordId };
        },
        async listTunnelConnections(input) {
            events.push({ event: 'api.listConnections', tunnelId: input.tunnelId });
            return [{ id: 'pre-existing-connection' }];
        },
    };
    return api;
}

function createFakeConnector(events) {
    let running = false;
    let exitCallback = null;
    const connector = {
        starts: 0,
        async start({ tunnelToken, onExit }) {
            events.push({ event: 'connector.start', tunnelToken });
            if (connector.failStart) throw connector.failStart;
            connector.starts += 1;
            running = true;
            exitCallback = onExit;
            return { pid: 1000 + connector.starts };
        },
        failStart: null,
        async stop(reason) {
            events.push({ event: 'connector.stop', reason });
            running = false;
        },
        isRunning() { return running; },
        exit({ code = 1, signal = null, error = null } = {}) {
            running = false;
            exitCallback?.({ code, signal, error, intentional: false });
        },
    };
    return connector;
}

function createHarness({
    secrets = {
        'publication/cloudflare-connector': CONNECTOR_TOKEN,
        'publication/cloudflare-api': API_TOKEN,
    },
    journal = createMemoryJournal(),
    probeHostname,
    probeConnector,
    restartPolicy,
    lazyApi = false,
    managedTunnelRegistry = createMemoryManagedTunnelRegistry(),
    routeCoordinator = null,
} = {}) {
    const events = [];
    const audits = [];
    const states = [];
    const api = createFakeApi(events);
    const connector = createFakeConnector(events);
    const routes = {
        active: false,
        hosts: {},
        commits: [],
        async inactivate(input) {
            events.push({ event: 'routes.inactivate', input: structuredClone(input) });
            routes.active = false;
            routes.hosts = {};
        },
        async commit(input) {
            events.push({ event: 'routes.commit', input: structuredClone(input) });
            routes.active = true;
            routes.hosts = structuredClone(input.hosts);
            routes.commits.push(structuredClone(input));
        },
    };
    let apiFactoryCalls = 0;
    const controller = new CloudflarePublicationController({
        ...(lazyApi ? {
            apiFactory: () => {
                apiFactoryCalls += 1;
                return api;
            },
        } : { api }),
        connector,
        journal,
        managedTunnelRegistry,
        secretStore: { readAll: () => ({ ...secrets }) },
        routeCoordinator: routeCoordinator || routes,
        probeConnector: probeConnector || (async (input) => {
            events.push({ event: 'probe.connector', tunnelId: input.scope.tunnelId });
            assert.equal(input.connector.isRunning(), true);
            return { ok: true };
        }),
        probeHostname: probeHostname || (async (input) => {
            events.push({ event: 'probe.hostname', hostname: input.hostname });
            return { ok: true };
        }),
        publishState: async (state) => { states.push(structuredClone(state)); },
        audit: (event, value) => audits.push({ event, value: structuredClone(value) }),
        restartPolicy,
    });
    return {
        controller,
        events,
        audits,
        states,
        api,
        connector,
        journal,
        managedTunnelRegistry,
        routes,
        get apiFactoryCalls() { return apiFactoryCalls; },
    };
}

async function waitFor(predicate, timeoutMs = 1000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail('condition was not reached before timeout');
}

test('no tuple selects local-only, commits no public hosts, and never starts cloudflared', async () => {
    const harness = createHarness();
    const status = await harness.controller.reconcile(localDesired());
    assert.equal(status.state, 'local-only');
    assert.equal(status.connectorState, 'absent');
    assert.deepEqual(status.hostnames, []);
    assert.equal(harness.connector.starts, 0);
    assert.deepEqual(harness.routes.hosts, {});
    assert.equal(harness.routes.commits.at(-1).mode, 'local-only');
    assert.equal(harness.routes.commits.at(-1).publicationState, 'ready');
    assert.equal(harness.journal.writes.at(-1).phase, 'local-only');
    assert.equal(harness.events.some((entry) => entry.event.startsWith('api.')), false);
});

test('selected ready state is adopted without a duplicate route apply', async () => {
    const harness = createHarness();
    const status = await harness.controller.reconcile({
        ...localDesired(),
        selectedPublicationState: 'ready',
    });
    assert.equal(status.state, 'local-only');
    assert.equal(status.configurationGeneration, localDesired().configurationGeneration);
    assert.equal(harness.events.some((entry) => entry.event === 'routes.inactivate'), false);
    assert.equal(harness.events.some((entry) => entry.event === 'routes.commit'), false);
    assert.equal(harness.journal.writes.at(-1).phase, 'local-only');
});

test('selected ready state still coordinates prior Cloudflare teardown', async () => {
    const harness = createHarness();
    await harness.controller.reconcile(desired());
    const status = await harness.controller.reconcile({
        ...localDesired('b'),
        selectedPublicationState: 'ready',
    });
    assert.equal(status.state, 'local-only');
    assert.equal(harness.events.filter((entry) => entry.event === 'routes.inactivate').length, 2);
    assert.equal(harness.routes.commits.at(-1).publicationState, 'ready');
});

test('complete publication verifies remote state before route commit and proves connector plus every host', async () => {
    const harness = createHarness();
    const input = desired(['office.example.test', 'meet.example.test']);
    const status = await harness.controller.reconcile(input);
    assert.equal(status.state, 'ready');
    assert.equal(status.connectorState, 'running');
    assert.deepEqual(status.hostnames, ['meet.example.test', 'office.example.test']);
    const installedIngress = harness.api.ingress.get('account_123/tunnel_123');
    assert.deepEqual(installedIngress, [
        { hostname: 'meet.example.test', service: CLOUDFLARE_ORIGIN },
        { hostname: 'office.example.test', service: CLOUDFLARE_ORIGIN },
        { service: 'http_status:404' },
    ]);
    const commitIndexes = harness.events
        .map((entry, index) => ({ entry, index }))
        .filter(({ entry }) => entry.event === 'routes.commit');
    const reconcilingCommit = commitIndexes.find(({ entry }) => entry.input.publicationState === 'reconciling');
    const readyCommit = commitIndexes.find(({ entry }) => entry.input.publicationState === 'ready');
    const remoteVerifyIndex = harness.events.map((entry) => entry.event).lastIndexOf('api.readIngress');
    const connectorIndex = harness.events.findIndex((entry) => entry.event === 'connector.start');
    const lastProbeIndex = harness.events.map((entry) => entry.event).lastIndexOf('probe.hostname');
    assert.ok(remoteVerifyIndex >= 0 && remoteVerifyIndex < reconcilingCommit.index);
    assert.ok(reconcilingCommit.index < connectorIndex);
    assert.ok(lastProbeIndex < readyCommit.index);
    assert.equal(harness.routes.commits.length, 2);
    assert.deepEqual(
        harness.events.filter((entry) => entry.event === 'probe.hostname').map((entry) => entry.hostname),
        ['meet.example.test', 'office.example.test'],
    );
    assert.equal(harness.routes.active, true);
    assert.deepEqual(Object.keys(harness.routes.hosts).sort(), ['meet.example.test', 'office.example.test']);
    assert.equal(harness.journal.writes.at(-1).phase, 'ready');
});

test('managed publication creates one owned tunnel and reuses it without persisting a connector token', async () => {
    const harness = createHarness({
        secrets: { 'publication/cloudflare-api': API_TOKEN },
    });
    const first = await harness.controller.reconcile(managedDesired());
    assert.equal(first.state, 'ready');
    assert.equal(first.management, 'api-managed');
    assert.equal(first.scope.tunnelId, 'managed_tunnel_1');
    assert.equal(
        harness.events.filter((entry) => entry.event === 'api.createTunnel').length,
        1,
    );
    assert.equal(
        harness.events.find((entry) => entry.event === 'connector.start').tunnelToken,
        'managed-connector-token-managed_tunnel_1',
    );
    assert.equal(harness.managedTunnelRegistry.entries.length, 1);
    assert.equal(harness.managedTunnelRegistry.entries[0].tunnelId, 'managed_tunnel_1');
    assert.equal(
        JSON.stringify(harness.journal.writes).includes('managed-connector-token'),
        false,
    );

    await harness.controller.reconcile(managedDesired(['office.example.test'], 'b'));
    assert.equal(
        harness.events.filter((entry) => entry.event === 'api.createTunnel').length,
        1,
    );
    assert.equal(
        harness.events.filter((entry) => entry.event === 'api.getTunnelToken').length,
        2,
    );
});

test('managed creation recovers an API response loss from its durable ownership intent', async () => {
    const harness = createHarness({
        secrets: { 'publication/cloudflare-api': API_TOKEN },
    });
    const originalCreate = harness.api.createTunnel.bind(harness.api);
    let failResponseOnce = true;
    harness.api.createTunnel = async (input) => {
        const created = await originalCreate(input);
        if (failResponseOnce) {
            failResponseOnce = false;
            throw new CloudflarePublicationError('response lost after create', {
                code: 'CLOUDFLARE_API_UNREACHABLE',
                operation: 'create-managed-tunnel',
                retryable: true,
            });
        }
        return created;
    };

    await assert.rejects(
        harness.controller.reconcile(managedDesired()),
        (error) => error.code === 'CLOUDFLARE_API_UNREACHABLE',
    );
    assert.equal(harness.api.tunnels.size, 1);
    assert.equal(harness.managedTunnelRegistry.entries[0].tunnelId, '');

    const status = await harness.controller.reconcile(managedDesired(['office.example.test'], 'b'));
    assert.equal(status.state, 'ready');
    assert.equal(harness.api.tunnels.size, 1);
    assert.equal(
        harness.events.filter((entry) => entry.event === 'api.createTunnel').length,
        1,
    );
    assert.equal(harness.managedTunnelRegistry.entries[0].tunnelId, 'managed_tunnel_1');
});

test('managed publication refuses to replace an owned tunnel deleted outside Ploinky', async () => {
    const harness = createHarness({
        secrets: { 'publication/cloudflare-api': API_TOKEN },
    });
    await harness.controller.reconcile(managedDesired());
    harness.api.tunnels.get('managed_tunnel_1').deleted_at = new Date().toISOString();

    await assert.rejects(
        harness.controller.reconcile(managedDesired(['office.example.test'], 'b')),
        (error) => error.code === 'CLOUDFLARE_MANAGED_TUNNEL_OWNERSHIP_LOST',
    );
    assert.equal(
        harness.events.filter((entry) => entry.event === 'api.createTunnel').length,
        1,
    );
    assert.equal(harness.managedTunnelRegistry.entries[0].tunnelId, 'managed_tunnel_1');
});

test('managed teardown deletes only an owned tunnel when explicitly requested', async () => {
    const harness = createHarness({
        secrets: { 'publication/cloudflare-api': API_TOKEN },
    });
    await harness.controller.reconcile(managedDesired(
        ['office.example.test'],
        'a',
        { deleteTunnelOnTeardown: true },
    ));
    const status = await harness.controller.reconcile(managedDesired(
        [],
        'b',
        { deleteTunnelOnTeardown: true },
    ));
    assert.equal(status.state, 'local-only');
    assert.equal(harness.journal.read().mode, 'local-only');
    assert.equal(harness.managedTunnelRegistry.entries.length, 0);
    assert.equal(harness.api.tunnels.get('managed_tunnel_1').deleted_at !== null, true);
    assert.equal(
        harness.events.filter((entry) => entry.event === 'api.deleteTunnel').length,
        1,
    );
});

test('managed teardown can opt into deletion after an earlier retained deployment', async () => {
    const harness = createHarness({
        secrets: { 'publication/cloudflare-api': API_TOKEN },
    });
    await harness.controller.reconcile(managedDesired());
    await harness.controller.reconcile(managedDesired(
        [],
        'b',
        { deleteTunnelOnTeardown: true },
    ));
    assert.equal(harness.managedTunnelRegistry.entries.length, 0);
    assert.ok(harness.api.tunnels.get('managed_tunnel_1').deleted_at);
    assert.equal(
        harness.events.filter((entry) => entry.event === 'api.deleteTunnel').length,
        1,
    );
});

test('managed teardown retains its allocation by default for a later redeploy', async () => {
    const harness = createHarness({
        secrets: { 'publication/cloudflare-api': API_TOKEN },
    });
    await harness.controller.reconcile(managedDesired());
    await harness.controller.reconcile(managedDesired([], 'b'));
    assert.equal(
        harness.events.filter((entry) => entry.event === 'api.deleteTunnel').length,
        0,
    );
    assert.equal(harness.managedTunnelRegistry.entries.length, 1);

    await harness.controller.reconcile(managedDesired(['office.example.test'], 'c'));
    assert.equal(
        harness.events.filter((entry) => entry.event === 'api.createTunnel').length,
        1,
    );
});

test('managed scope replacement retains the old allocation until its own explicit teardown', async () => {
    const harness = createHarness({
        secrets: { 'publication/cloudflare-api': API_TOKEN },
    });
    await harness.controller.reconcile(managedDesired(
        ['office.example.test'],
        'a',
        { deleteTunnelOnTeardown: true },
    ));
    const status = await harness.controller.reconcile(managedDesired(
        ['office.example.test'],
        'b',
        { tunnelName: 'explorer-qa-replacement' },
    ));

    assert.equal(status.state, 'ready');
    assert.equal(status.scope.tunnelId, 'managed_tunnel_2');
    assert.equal(harness.api.tunnels.get('managed_tunnel_1').deleted_at, null);
    assert.equal(harness.api.tunnels.get('managed_tunnel_2').deleted_at, null);
    assert.equal(
        harness.events.filter((entry) => entry.event === 'api.deleteTunnel').length,
        0,
    );
    assert.deepEqual(
        harness.managedTunnelRegistry.entries.map((entry) => entry.tunnelId),
        ['managed_tunnel_1', 'managed_tunnel_2'],
    );

    await harness.controller.reconcile(managedDesired(
        [],
        'c',
        { tunnelName: 'explorer-qa-replacement' },
    ));
    await harness.controller.reconcile(managedDesired(
        [],
        'd',
        { tunnelName: 'explorer-qa', deleteTunnelOnTeardown: true },
    ));
    assert.ok(harness.api.tunnels.get('managed_tunnel_1').deleted_at);
    assert.equal(harness.api.tunnels.get('managed_tunnel_2').deleted_at, null);
    assert.deepEqual(
        harness.managedTunnelRegistry.entries.map((entry) => entry.tunnelId),
        ['managed_tunnel_2'],
    );
});

test('API-managed reconciliation refuses an integrated connector on a shared tunnel', async () => {
    const harness = createHarness();
    const sharedIngress = [
        { hostname: 'soul.example.test', service: 'http://localhost:8042' },
        {
            hostname: 'search.example.test',
            path: '^/api/',
            service: 'http://localhost:8043',
            originRequest: { connectTimeout: 30 },
        },
        { service: 'http_status:418' },
    ];
    harness.api.ingress.set('account_123/tunnel_123', structuredClone(sharedIngress));

    await assert.rejects(
        harness.controller.reconcile(desired(['office.example.test'])),
        (error) => error.code === 'CLOUDFLARE_SHARED_TUNNEL_UNSAFE'
            && error.operation === 'reconcile-ingress',
    );
    assert.deepEqual(harness.api.ingress.get('account_123/tunnel_123'), sharedIngress);
    assert.equal(harness.events.some((entry) => entry.event === 'api.putIngress'), false);
    assert.equal(harness.connector.starts, 0);
});

test('owned-route teardown preserves routes another controller added later', async () => {
    const harness = createHarness();
    await harness.controller.reconcile(desired(['office.example.test']));
    harness.api.ingress.set('account_123/tunnel_123', [
        { hostname: 'soul.example.test', service: 'http://localhost:8042' },
        {
            hostname: 'search.example.test',
            path: '^/api/',
            service: 'http://localhost:8043',
            originRequest: { connectTimeout: 30 },
        },
        { hostname: 'office.example.test', service: CLOUDFLARE_ORIGIN },
        { service: 'http_status:418' },
    ]);

    await harness.controller.reconcile(localDesired('b'));
    assert.deepEqual(harness.api.ingress.get('account_123/tunnel_123'), [
        { hostname: 'soul.example.test', service: 'http://localhost:8042' },
        {
            hostname: 'search.example.test',
            path: '^/api/',
            service: 'http://localhost:8043',
            originRequest: { connectTimeout: 30 },
        },
        { service: 'http_status:418' },
    ]);
});

test('connector-only proves every host, commits reconciling then ready, and owns no API or journal state', async () => {
    const harness = createHarness({ lazyApi: true });
    const writesBefore = harness.journal.writes.length;
    const status = await harness.controller.reconcile(connectorDesired([
        'office.example.test',
        'meet.example.test',
    ]));
    assert.equal(status.state, 'ready');
    assert.equal(status.management, 'connector-only');
    assert.equal(status.scope, null);
    assert.equal(harness.apiFactoryCalls, 0);
    assert.equal(harness.events.some((entry) => entry.event.startsWith('api.')), false);
    assert.equal(harness.journal.writes.length, writesBefore);
    assert.deepEqual(harness.routes.commits.map((entry) => entry.publicationState), [
        'reconciling',
        'ready',
    ]);
    assert.deepEqual(
        harness.events.filter((entry) => entry.event === 'probe.hostname').map((entry) => entry.hostname),
        ['meet.example.test', 'office.example.test'],
    );
});

test('ready apply-lock contention recovers without a new activation or duplicate connector launch', async () => {
    const input = connectorDesired();
    const generationDesired = {
        cloudflare: structuredClone(input.cloudflare),
        hosts: structuredClone(input.hosts),
    };
    let inactive = false;
    let activation = 0;
    let readyApplyAttempts = 0;
    const committedStates = [];
    const inactivations = [];
    const busy = Object.assign(new Error('edge generation apply is already in progress'), {
        code: 'EDGE_GENERATION_BUSY',
    });
    const edgeOps = {
        load() {
            if (inactive) {
                throw Object.assign(new Error('edge generation inactive'), {
                    code: 'EDGE_GENERATION_INACTIVE',
                });
            }
            return {
                selector: {
                    state: 'active',
                    generation: input.configurationGeneration,
                    activationId: `activation-${activation}`,
                },
                generation: { desired: generationDesired },
            };
        },
        selection() {
            return {
                selector: {
                    state: 'inactive',
                    generation: input.configurationGeneration,
                },
            };
        },
        inactivate(reason) {
            inactive = true;
            inactivations.push(reason);
        },
        apply(options) {
            if (options.publicationState === 'ready') {
                readyApplyAttempts += 1;
                if (readyApplyAttempts === 1) throw busy;
            }
            inactive = false;
            activation += 1;
            committedStates.push(options.publicationState);
            return {
                selector: {
                    state: 'active',
                    generation: input.configurationGeneration,
                    activationId: `activation-${activation}`,
                },
                generation: { desired: generationDesired },
            };
        },
    };
    const routeCoordinator = createEdgePublicationRouteCoordinator({
        workspaceRoot: '/fixture',
        edgeOps,
        edgeApplyBusyRetryAttempts: 2,
        sleep: async () => {},
    });
    const harness = createHarness({ lazyApi: true, routeCoordinator });

    const status = await harness.controller.reconcile(input);

    assert.equal(status.state, 'ready');
    assert.equal(status.connectorState, 'running');
    assert.equal(harness.connector.starts, 1);
    assert.equal(readyApplyAttempts, 2);
    assert.deepEqual(committedStates, ['reconciling', 'ready']);
    assert.deepEqual(inactivations, ['coordinated-apply']);
    assert.equal(harness.controller.getStatus().error, null);
});

test('connector-only unresolved token commits the exact public generation to error without API or journal writes', async () => {
    const harness = createHarness({
        secrets: {},
        lazyApi: true,
    });
    await assert.rejects(
        harness.controller.reconcile(connectorDesired()),
        (error) => error.code === 'CLOUDFLARE_CONNECTOR_SECRET_UNRESOLVED',
    );
    assert.equal(harness.apiFactoryCalls, 0);
    assert.equal(harness.journal.writes.length, 0);
    assert.deepEqual(harness.routes.commits.map((entry) => entry.publicationState), [
        'reconciling',
        'error',
    ]);
    assert.equal(harness.routes.active, true);
    assert.deepEqual(Object.keys(harness.routes.hosts), ['office.example.test']);
    assert.equal(harness.controller.getStatus().state, 'error');
    assert.equal(harness.connector.isRunning(), false);
});

test('connector-only spawn and external proof failures stop the connector and commit error', async () => {
    const spawnFailure = createHarness({ lazyApi: true });
    spawnFailure.connector.failStart = new CloudflarePublicationError('spawn failed', {
        code: 'CLOUDFLARED_START_FAILED',
        operation: 'connector-start',
        retryable: true,
    });
    await assert.rejects(
        spawnFailure.controller.reconcile(connectorDesired()),
        (error) => error.code === 'CLOUDFLARED_START_FAILED',
    );
    assert.deepEqual(spawnFailure.routes.commits.map((entry) => entry.publicationState), [
        'reconciling',
        'error',
    ]);
    assert.equal(spawnFailure.connector.isRunning(), false);

    const proofFailure = createHarness({
        lazyApi: true,
        probeHostname: async () => ({ ok: false, status: 404 }),
    });
    await assert.rejects(
        proofFailure.controller.reconcile(connectorDesired()),
        (error) => error.code === 'CLOUDFLARE_HOST_PROBE_FAILED',
    );
    assert.deepEqual(proofFailure.routes.commits.map((entry) => entry.publicationState), [
        'reconciling',
        'error',
    ]);
    assert.equal(proofFailure.connector.isRunning(), false);
    assert.equal(proofFailure.journal.writes.length, 0);

    let exitDuringProof;
    exitDuringProof = createHarness({
        lazyApi: true,
        probeHostname: async () => {
            exitDuringProof.connector.exit({ code: 9 });
            return { ok: true };
        },
    });
    await assert.rejects(
        exitDuringProof.controller.reconcile(connectorDesired()),
        (error) => error.code === 'CLOUDFLARED_NOT_RUNNING',
    );
    assert.deepEqual(exitDuringProof.routes.commits.map((entry) => entry.publicationState), [
        'reconciling',
        'error',
    ]);
});

test('connector-only superseded generation cannot commit ready or error after its probe returns', async () => {
    let probeCalls = 0;
    let releaseFirst;
    const firstProbe = new Promise((resolve) => { releaseFirst = resolve; });
    const harness = createHarness({
        lazyApi: true,
        probeHostname: async () => {
            probeCalls += 1;
            if (probeCalls === 1) await firstProbe;
            return { ok: true };
        },
    });
    const first = harness.controller.reconcile(connectorDesired(['office.example.test'], 'a'));
    await waitFor(() => probeCalls === 1);
    const second = harness.controller.reconcile(connectorDesired(['meet.example.test'], 'b'));
    releaseFirst();
    await assert.rejects(
        first,
        (error) => error.code === 'CLOUDFLARE_RECONCILIATION_SUPERSEDED',
    );
    await second;
    assert.deepEqual(
        harness.routes.commits.filter((entry) => entry.publicationState !== 'reconciling')
            .map((entry) => [entry.configurationGeneration, entry.publicationState]),
        [[`sha256:${'b'.repeat(64)}`, 'ready']],
    );
});

test('API-managed ownership requires verified local-only teardown before connector-only', async () => {
    const harness = createHarness();
    await harness.controller.reconcile(desired());
    const writesBeforeRejectedTransition = harness.journal.writes.length;
    await assert.rejects(
        harness.controller.reconcile(connectorDesired(['office.example.test'], 'b')),
        (error) => error.code === 'CLOUDFLARE_MANAGEMENT_TRANSITION_UNSAFE'
            && /apply local-only first.*verify API-managed teardown.*apply connector-only/.test(error.message),
    );
    assert.equal(harness.journal.writes.length, writesBeforeRejectedTransition);
    assert.equal(harness.journal.read().mode, 'cloudflare');

    const local = await harness.controller.reconcile(localDesired('c'));
    assert.equal(local.state, 'local-only');
    assert.equal(harness.journal.read().mode, 'local-only');
    const connector = await harness.controller.reconcile(
        connectorDesired(['office.example.test'], 'd'),
    );
    assert.equal(connector.management, 'connector-only');
    assert.equal(connector.state, 'ready');
    assert.equal(harness.journal.read().mode, 'local-only');
});

test('unexpected connector-only exits commit error and use bounded exact-state restart', async () => {
    const harness = createHarness({
        lazyApi: true,
        restartPolicy: {
            maximumRestarts: 1,
            windowMs: 10000,
            initialBackoffMs: 0,
            maximumBackoffMs: 0,
        },
    });
    await harness.controller.reconcile(connectorDesired());
    harness.connector.exit({ code: 7 });
    await waitFor(() => (
        harness.connector.starts === 2
        && harness.controller.getStatus().state === 'ready'
    ));
    harness.connector.exit({ code: 8 });
    await waitFor(() => harness.controller.getStatus().retry?.exhausted === true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(harness.connector.starts, 2);
    assert.equal(harness.apiFactoryCalls, 0);
    assert.equal(harness.journal.writes.length, 0);
    assert.equal(harness.routes.commits.at(-1).publicationState, 'error');
    assert.equal(harness.controller.getStatus().state, 'error');
});

test('tokens and secret handles are absent from status, audit, journal, and route state', async () => {
    const harness = createHarness();
    await harness.controller.reconcile(desired());
    const observable = JSON.stringify({
        status: harness.controller.getStatus(),
        audits: harness.audits,
        journal: harness.journal.writes,
        routes: harness.routes.commits,
    });
    for (const forbidden of [
        CONNECTOR_TOKEN,
        API_TOKEN,
        'publication/cloudflare-connector',
        'publication/cloudflare-api',
        'tunnelTokenSecret',
        'apiTokenSecret',
    ]) {
        assert.equal(observable.includes(forbidden), false, forbidden);
    }
});

test('partial tuple fails closed instead of selecting local-only', async () => {
    const harness = createHarness();
    const input = desired();
    delete input.cloudflare.apiTokenSecret;
    await assert.rejects(
        harness.controller.reconcile(input),
        (error) => error.code === 'CLOUDFLARE_CONFIGURATION_PARTIAL',
    );
    const status = harness.controller.getStatus();
    assert.equal(status.state, 'error');
    assert.notEqual(status.mode, 'local-only');
    assert.equal(harness.routes.active, false);
    assert.equal(harness.connector.starts, 0);
    assert.equal(harness.events.some((entry) => entry.event.startsWith('api.')), false);
});

test('unresolved encrypted connector handle fails before any Cloudflare API call', async () => {
    const harness = createHarness({
        secrets: { 'publication/cloudflare-api': API_TOKEN },
    });
    await assert.rejects(
        harness.controller.reconcile(desired()),
        (error) => error.code === 'CLOUDFLARE_CONNECTOR_SECRET_UNRESOLVED',
    );
    assert.equal(harness.events.some((entry) => entry.event.startsWith('api.')), false);
    assert.equal(harness.routes.active, false);
    assert.equal(harness.connector.starts, 0);
});

test('API permission error remains actionable but redacts both credentials everywhere', async () => {
    const harness = createHarness();
    harness.api.failValidate = new CloudflarePublicationError(
        `DNS edit denied for ${API_TOKEN}; connector ${CONNECTOR_TOKEN}`,
        {
            code: 'CLOUDFLARE_API_OPERATION_FAILED',
            operation: 'validate-dns-edit',
        },
    );
    await assert.rejects(harness.controller.reconcile(desired()), (error) => {
        assert.equal(error.operation, 'validate-dns-edit');
        assert.doesNotMatch(error.message, /api-secret-value|connector-secret-value/);
        return true;
    });
    const observable = JSON.stringify({
        status: harness.controller.getStatus(),
        audits: harness.audits,
        journal: harness.journal.writes,
    });
    assert.doesNotMatch(observable, /api-secret-value|connector-secret-value/);
    assert.match(observable, /validate-dns-edit/);
    assert.equal(harness.routes.active, false);
});

test('partial DNS mutation retains an error journal and explicit retry converges to the same desired state', async () => {
    const harness = createHarness();
    harness.api.failCreateDnsOnce = new CloudflarePublicationError('temporary DNS failure', {
        code: 'CLOUDFLARE_API_OPERATION_FAILED',
        operation: 'create-dns-record',
        retryable: true,
    });
    await assert.rejects(harness.controller.reconcile(desired()), /temporary DNS failure/);
    assert.equal(harness.controller.getStatus().state, 'error');
    assert.equal(harness.journal.writes.at(-1).phase, 'error');
    assert.equal(harness.routes.active, false);
    const status = await harness.controller.retry();
    assert.equal(status.state, 'ready');
    assert.equal(harness.api.dns.size, 1);
    assert.equal(harness.routes.active, true);
    assert.equal(harness.routes.commits.length, 2);
});

test('reapplying the same selected state is idempotent and does not duplicate DNS records', async () => {
    const harness = createHarness();
    const input = desired();
    await harness.controller.reconcile(input);
    const firstRecordId = [...harness.api.dns.values()][0].id;
    await harness.controller.reconcile(input);
    assert.equal(harness.api.dns.size, 1);
    assert.equal([...harness.api.dns.values()][0].id, firstRecordId);
    assert.equal(harness.events.filter((entry) => entry.event === 'api.createDns').length, 1);
    assert.equal(harness.events.filter((entry) => entry.event === 'api.updateDns').length, 1);
});

test('host removal first removes ingress, then deletes only the journal-owned DNS record', async () => {
    const harness = createHarness();
    await harness.controller.reconcile(desired(['office.example.test', 'meet.example.test']));
    const removedRecord = harness.api.dns.get('zone_123/meet.example.test');
    await harness.controller.reconcile(desired(['office.example.test'], 'b'));
    assert.equal(harness.api.dns.has('zone_123/meet.example.test'), false);
    assert.equal(harness.api.dns.has('zone_123/office.example.test'), true);
    assert.ok(harness.events.some((entry) => entry.event === 'api.deleteDns' && entry.recordId === removedRecord.id));
    assert.deepEqual(harness.api.ingress.get('account_123/tunnel_123'), [
        { hostname: 'office.example.test', service: CLOUDFLARE_ORIGIN },
        { service: 'http_status:404' },
    ]);
    assert.deepEqual(Object.keys(harness.routes.hosts), ['office.example.test']);
});

test('removing the final hostname verifies terminal ingress and owned DNS deletion before local-only commit', async () => {
    const harness = createHarness();
    await harness.controller.reconcile(desired(['office.example.test']));
    const owned = harness.api.dns.get('zone_123/office.example.test');
    const eventStart = harness.events.length;

    const status = await harness.controller.reconcile(localDesired('b'));
    assert.equal(status.state, 'local-only');
    assert.equal(harness.api.dns.has('zone_123/office.example.test'), false);
    assert.deepEqual(harness.api.ingress.get('account_123/tunnel_123'), [
        { service: 'http_status:404' },
    ]);
    assert.equal(harness.journal.writes.at(-1).phase, 'local-only');
    assert.equal(harness.journal.writes.at(-1).mode, 'local-only');
    assert.deepEqual(harness.routes.hosts, {});

    const events = harness.events.slice(eventStart);
    const ingressWrite = events.findIndex((entry) => entry.event === 'api.putIngress');
    const ingressVerify = events.findIndex((entry, index) => (
        index > ingressWrite && entry.event === 'api.readIngress'
    ));
    const dnsDelete = events.findIndex((entry) => entry.event === 'api.deleteDns' && entry.recordId === owned.id);
    const localCommit = events.findIndex((entry) => (
        entry.event === 'routes.commit' && entry.input.mode === 'local-only'
    ));
    assert.ok(ingressWrite >= 0 && ingressVerify > ingressWrite && dnsDelete > ingressVerify && localCommit > dnsDelete);
});

test('partial final-host teardown preserves only the still-owned DNS journal entries', async () => {
    const harness = createHarness();
    await harness.controller.reconcile(desired(['office.example.test', 'meet.example.test']));
    const office = harness.api.dns.get('zone_123/office.example.test');
    const meet = harness.api.dns.get('zone_123/meet.example.test');
    harness.api.failDeleteDnsRecordIdOnce = office.id;

    await assert.rejects(
        harness.controller.reconcile(localDesired('b')),
        (error) => error.code === 'CLOUDFLARE_API_OPERATION_FAILED',
    );
    assert.equal(harness.api.dns.has('zone_123/meet.example.test'), false);
    assert.equal(harness.api.dns.has('zone_123/office.example.test'), true);
    assert.equal(harness.events.some((entry) => (
        entry.event === 'api.deleteDns' && entry.recordId === meet.id
    )), true);
    assert.equal(harness.routes.active, false);
    assert.equal(harness.journal.writes.at(-1).mode, 'cloudflare');
    assert.equal(harness.journal.writes.at(-1).phase, 'error');
    assert.deepEqual(
        harness.journal.writes.at(-1).managedDnsRecords.map((entry) => entry.hostname),
        ['office.example.test'],
    );
});

test('a restarted controller preserves Cloudflare ownership journal and fails closed without teardown handles', async () => {
    const journal = createMemoryJournal({
        mode: 'cloudflare',
        configurationGeneration: `sha256:${'a'.repeat(64)}`,
        desiredDigest: `sha256:${'c'.repeat(64)}`,
        phase: 'ready',
        scope: { accountId: 'account_123', zoneId: 'zone_123', tunnelId: 'tunnel_123' },
        ingressDigest: `sha256:${'d'.repeat(64)}`,
        managedDnsRecords: [{
            hostname: 'office.example.test',
            recordId: 'record-1',
            zoneId: 'zone_123',
            content: 'tunnel_123.cfargotunnel.com',
        }],
        lastError: null,
        updatedAt: new Date().toISOString(),
    });
    const harness = createHarness({ journal });
    await assert.rejects(
        harness.controller.reconcile(localDesired('b')),
        (error) => error.code === 'CLOUDFLARE_TEARDOWN_CREDENTIALS_REQUIRED',
    );
    assert.equal(harness.routes.active, false);
    assert.equal(harness.events.some((entry) => entry.event.startsWith('api.')), false);
    assert.equal(journal.writes.at(-1).mode, 'cloudflare');
    assert.equal(journal.writes.at(-1).managedDnsRecords.length, 1);
    assert.equal(journal.writes.at(-1).phase, 'error');
});

test('a restarted controller uses an explicit API-managed empty-host state to tear down owned routes', async () => {
    const first = createHarness();
    await first.controller.reconcile(desired(['office.example.test']));
    const journal = first.journal;
    const second = createHarness({ journal });
    second.api.ingress.set(
        'account_123/tunnel_123',
        structuredClone(first.api.ingress.get('account_123/tunnel_123')),
    );
    second.api.dns.set(
        'zone_123/office.example.test',
        structuredClone(first.api.dns.get('zone_123/office.example.test')),
    );

    const status = await second.controller.reconcile({
        configurationGeneration: `sha256:${'b'.repeat(64)}`,
        cloudflare: {
            accountId: 'account_123',
            zoneId: 'zone_123',
            tunnelId: 'tunnel_123',
            tunnelTokenSecret: 'publication/cloudflare-connector',
            apiTokenSecret: 'publication/cloudflare-api',
        },
        hosts: {},
    });
    assert.equal(status.state, 'local-only');
    assert.deepEqual(second.api.ingress.get('account_123/tunnel_123'), [
        { service: 'http_status:404' },
    ]);
    assert.equal(second.api.dns.has('zone_123/office.example.test'), false);
    assert.equal(journal.read().mode, 'local-only');
});

test('controller stop persists a redacted stopped state after connector teardown', async () => {
    const harness = createHarness();
    await harness.controller.reconcile(connectorDesired());
    await harness.controller.stop();
    assert.equal(harness.connector.isRunning(), false);
    assert.equal(harness.states.at(-1).state, 'stopped');
    assert.equal(harness.states.at(-1).connectorState, 'stopped');
    assert.equal(harness.controller.getStatus().state, 'stopped');
});

test('changed DNS ownership is never deleted during host removal', async () => {
    const harness = createHarness();
    await harness.controller.reconcile(desired(['office.example.test', 'meet.example.test']));
    harness.api.dns.set('zone_123/meet.example.test', {
        id: 'external-record',
        type: 'CNAME',
        name: 'meet.example.test',
        content: 'external.example.net',
        ttl: 1,
        proxied: true,
    });
    await assert.rejects(
        harness.controller.reconcile(desired(['office.example.test'], 'b')),
        (error) => error.code === 'CLOUDFLARE_DNS_OWNERSHIP_LOST',
    );
    assert.equal(harness.api.dns.get('zone_123/meet.example.test').id, 'external-record');
    assert.equal(harness.routes.active, false);
});

test('connector or external probe failure stops connector and inactivates committed routes', async () => {
    const harness = createHarness({
        probeHostname: async () => ({ ok: false }),
    });
    await assert.rejects(
        harness.controller.reconcile(desired()),
        (error) => error.code === 'CLOUDFLARE_HOST_PROBE_FAILED',
    );
    assert.equal(harness.connector.isRunning(), false);
    assert.equal(harness.routes.active, false);
    assert.equal(harness.controller.getStatus().state, 'error');
    assert.equal(harness.journal.writes.at(-1).phase, 'error');
});

test('a superseded generation cannot commit routes after its remote call returns', async () => {
    const harness = createHarness();
    let release;
    harness.api.blockPutIngress = new Promise((resolve) => { release = resolve; });
    const first = harness.controller.reconcile(desired(['office.example.test'], 'a'));
    await waitFor(() => harness.events.some((entry) => entry.event === 'api.putIngress'));
    const second = harness.controller.reconcile(desired(['meet.example.test'], 'b'));
    release();
    await assert.rejects(first, (error) => error.code === 'CLOUDFLARE_RECONCILIATION_SUPERSEDED');
    harness.api.blockPutIngress = null;
    const status = await second;
    assert.equal(status.state, 'ready');
    assert.equal(harness.routes.commits.length, 2);
    assert.ok(harness.routes.commits.every((entry) => entry.configurationGeneration === `sha256:${'b'.repeat(64)}`));
    assert.deepEqual(harness.routes.commits.map((entry) => entry.publicationState), [
        'reconciling',
        'ready',
    ]);
    assert.deepEqual(Object.keys(harness.routes.hosts), ['meet.example.test']);
});

test('unexpected connector exits use bounded exact-state restart and stop after the threshold', async () => {
    const harness = createHarness({
        restartPolicy: {
            maximumRestarts: 1,
            windowMs: 10000,
            initialBackoffMs: 0,
            maximumBackoffMs: 0,
        },
    });
    await harness.controller.reconcile(desired());
    harness.connector.exit({ code: 7 });
    await waitFor(() => harness.connector.starts === 2 && harness.controller.getStatus().state === 'ready');
    harness.connector.exit({ code: 8 });
    await waitFor(() => harness.controller.getStatus().retry?.exhausted === true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(harness.connector.starts, 2);
    assert.equal(harness.routes.active, false);
    assert.equal(harness.controller.getStatus().state, 'error');
});
