import assert from 'node:assert/strict';
import test from 'node:test';

import {
    CLOUDFLARE_ORIGIN,
    CloudflarePublicationController,
} from '../../ploinky-box/cloudflared/publicationController.mjs';
import {
    materializeManagedCloudflarePublicationPlan,
    normalizeCloudflarePublicationDesired,
} from '../../ploinky-box/cloudflared/publicationPlan.mjs';
import { desiredFor, domainFixture, rootHost, siblingHost } from './directDomainFixtures.mjs';

// A Box-managed legacy host and an externally managed apex share one
// Ploinky-managed tunnel, as in the two-host window and its retirement.
const MANAGED = 'managed.synthetic.test';
const EXTERNAL = 'external.synthetic.test';
const API_TOKEN = 'synthetic-api-token';
const TERMINAL = { service: 'http_status:404' };

function publicationInput(hosts, generationCharacter = 'a', cloudflare = {}) {
    return {
        configurationGeneration: `sha256:${generationCharacter.repeat(64)}`,
        cloudflare: {
            accountId: 'account_123',
            zoneId: 'zone_123',
            tunnelName: 'synthetic-production',
            apiTokenSecret: 'publication/synthetic-api',
            deleteTunnelOnTeardown: true,
            ...cloudflare,
        },
        hosts: Object.fromEntries(hosts.map((hostname) => [hostname, hostname === EXTERNAL
            ? { agent: 'fixtures/explorer', dnsManagement: 'external' }
            : { agent: 'fixtures/explorer' }])),
    };
}

const legacy = (character) => publicationInput([MANAGED], character);
const dual = (character) => publicationInput([MANAGED, EXTERNAL], character);
const single = (character) => publicationInput([EXTERNAL], character);

function createMemoryJournal() {
    let value = null;
    return {
        read() { return value ? structuredClone(value) : null; },
        write(next) { value = { updatedAt: new Date().toISOString(), ...structuredClone(next) }; return structuredClone(value); },
    };
}

function createMemoryManagedTunnelRegistry(events) {
    const entries = [];
    let nextOwnership = 1;
    const same = (entry, { accountId, zoneId, tunnelName }) => entry.accountId === accountId
        && entry.zoneId === zoneId && entry.requestedName === tunnelName;
    return {
        entries,
        findDesired(desired) { return structuredClone(entries.find((entry) => same(entry, desired)) || null); },
        findScope({ accountId, tunnelId }) {
            return structuredClone(entries.find((entry) => entry.accountId === accountId && entry.tunnelId === tunnelId) || null);
        },
        begin(desired) {
            const existing = entries.find((entry) => same(entry, desired));
            const result = existing || (() => {
                const ownershipId = `00000000-0000-4000-8000-${String(nextOwnership++).padStart(12, '0')}`;
                const entry = {
                    ownershipId, accountId: desired.accountId, zoneId: desired.zoneId, requestedName: desired.tunnelName,
                    cloudflareName: `${desired.tunnelName}--ploinky-${ownershipId}`, tunnelId: '',
                    deleteOnTeardown: desired.deleteOnTeardown === true,
                };
                entries.push(entry);
                return entry;
            })();
            events.push({ event: 'registry.begin', ownershipId: result.ownershipId });
            return structuredClone(result);
        },
        commit({ ownershipId, tunnelId }) {
            const entry = entries.find((candidate) => candidate.ownershipId === ownershipId);
            entry.tunnelId = tunnelId;
            return structuredClone(entry);
        },
        remove({ ownershipId }) {
            const index = entries.findIndex((entry) => entry.ownershipId === ownershipId);
            if (index >= 0) entries.splice(index, 1);
            return index >= 0;
        },
    };
}

function createFakeApi(events) {
    const ingress = new Map();
    const dns = new Map();
    const tunnels = new Map();
    let nextRecordId = 1;
    let nextTunnelId = 1;
    const dnsEvent = (event, zoneId, hostname, extra = {}) => events.push({ event, zoneId, hostname, ...extra });
    return {
        ingress,
        dns,
        async validateAccountZone() { events.push({ event: 'api.validateAccountZone' }); return { ok: true }; },
        async validateScope() { events.push({ event: 'api.validateScope' }); return { ok: true }; },
        async listTunnels({ accountId, name }) {
            events.push({ event: 'api.listTunnels' });
            return [...tunnels.values()].filter((tunnel) => tunnel.account_tag === accountId && tunnel.name === name)
                .map((tunnel) => structuredClone(tunnel));
        },
        async createTunnel({ accountId, name }) {
            events.push({ event: 'api.createTunnel' });
            const tunnel = { id: `managed_tunnel_${nextTunnelId++}`, account_tag: accountId, name, config_src: 'cloudflare', deleted_at: null };
            tunnels.set(tunnel.id, tunnel);
            return structuredClone(tunnel);
        },
        async getTunnelToken({ tunnelId }) { return `managed-connector-token-${tunnelId}`; },
        async deleteTunnel() { events.push({ event: 'api.deleteTunnel' }); },
        async putTunnelIngress(input) {
            events.push({ event: 'api.putIngress', ingress: structuredClone(input.ingress) });
            ingress.set(input.tunnelId, structuredClone(input.ingress));
            return structuredClone(input.ingress);
        },
        async readTunnelIngress(input) { return structuredClone(ingress.get(input.tunnelId) || []); },
        async listDnsRecords({ zoneId, hostname }) {
            dnsEvent('api.listDns', zoneId, hostname);
            const record = dns.get(`${zoneId}/${hostname}`);
            return record ? [structuredClone(record)] : [];
        },
        async createDnsRecord({ zoneId, record }) {
            dnsEvent('api.createDns', zoneId, record.name);
            const saved = { id: `record-${nextRecordId++}`, ...structuredClone(record) };
            dns.set(`${zoneId}/${record.name}`, saved);
            return structuredClone(saved);
        },
        async updateDnsRecord({ zoneId, recordId, record }) {
            dnsEvent('api.updateDns', zoneId, record.name, { recordId });
            const saved = { id: recordId, ...structuredClone(record) };
            dns.set(`${zoneId}/${record.name}`, saved);
            return structuredClone(saved);
        },
        async deleteDnsRecord({ zoneId, recordId }) {
            const key = [...dns.keys()].find((candidate) => candidate.startsWith(`${zoneId}/`) && dns.get(candidate).id === recordId);
            dnsEvent('api.deleteDns', zoneId, key?.slice(zoneId.length + 1), { recordId });
            if (key) dns.delete(key);
            return { id: recordId };
        },
        async listTunnelConnections() { return [{ id: 'pre-existing-connection' }]; },
    };
}

function createHarness({ probeHostname } = {}) {
    const events = [];
    const api = createFakeApi(events);
    const journal = createMemoryJournal();
    const managedTunnelRegistry = createMemoryManagedTunnelRegistry(events);
    let running = false;
    const connector = {
        async start() { events.push({ event: 'connector.start' }); running = true; return { pid: 1 }; },
        async stop(reason) { events.push({ event: 'connector.stop', reason }); running = false; },
        isRunning() { return running; },
    };
    const routes = {
        active: false,
        async inactivate() { events.push({ event: 'routes.inactivate' }); routes.active = false; },
        async inactivateForStop() { routes.active = false; return null; },
        async commit(input) { events.push({ event: 'routes.commit', publicationState: input.publicationState }); routes.active = true; },
    };
    const controller = new CloudflarePublicationController({
        api,
        connector,
        journal,
        managedTunnelRegistry,
        secretStore: { readAll: () => ({ 'publication/synthetic-api': API_TOKEN }) },
        routeCoordinator: routes,
        probeConnector: async () => ({ ok: true }),
        probeHostname: probeHostname || (async ({ hostname }) => {
            events.push({ event: 'probe.hostname', hostname });
            return { ok: true };
        }),
        publishState: async () => {},
        audit: () => {},
    });
    const since = (mark, predicate) => events.slice(mark).filter(predicate);
    return { controller, events, api, journal, connector, routes, managedTunnelRegistry, since };
}

const namesExternal = (entry) => entry.hostname === EXTERNAL;
const isDnsCall = (entry) => entry.event.endsWith('Dns');
const isDnsMutation = (entry) => ['api.createDns', 'api.updateDns', 'api.deleteDns'].includes(entry.event);

test('external hosts never produce DNS materialization and need an API-managed tunnel', () => {
    const existing = normalizeCloudflarePublicationDesired({
        ...dual(),
        cloudflare: {
            accountId: 'account_123', zoneId: 'zone_123', tunnelId: 'tunnel_123',
            tunnelTokenSecret: 'publication/synthetic-connector', apiTokenSecret: 'publication/synthetic-api',
        },
    });
    assert.deepEqual(existing.dns.map((entry) => entry.hostname), [MANAGED]);
    assert.deepEqual(existing.ingress.map((entry) => entry.hostname), [EXTERNAL, MANAGED, undefined]);
    const managed = normalizeCloudflarePublicationDesired(dual());
    assert.deepEqual(materializeManagedCloudflarePublicationPlan(managed, 'managed_tunnel_1').dns.map((entry) => entry.hostname),
        [MANAGED]);
    assert.throws(() => normalizeCloudflarePublicationDesired({
        ...dual(), hosts: { [EXTERNAL]: { agent: 'fixtures/explorer', dnsManagement: 'unowned' } },
    }), { code: 'CLOUDFLARE_HOST_INVALID' });
    assert.throws(() => normalizeCloudflarePublicationDesired({
        configurationGeneration: `sha256:${'a'.repeat(64)}`,
        cloudflare: { tunnelTokenSecret: 'publication/synthetic-connector' },
        hosts: { [EXTERNAL]: { agent: 'fixtures/explorer', dnsManagement: 'external' } },
    }), { code: 'CLOUDFLARE_CONFIGURATION_INVALID' });
});

test('dual reconcile on the same managed tunnel adds external ingress and probes with zero external DNS calls', async () => {
    const harness = createHarness();
    assert.equal((await harness.controller.reconcile(legacy('a'))).state, 'ready');
    const allocation = harness.managedTunnelRegistry.entries[0].ownershipId;
    const managedRecord = harness.api.dns.get(`zone_123/${MANAGED}`);
    const mark = harness.events.length;

    const status = await harness.controller.reconcile(dual('b'));
    assert.equal(status.state, 'ready');
    assert.equal(status.connectorState, 'running');
    assert.deepEqual(status.hostnames, [EXTERNAL, MANAGED]);
    assert.deepEqual(harness.events.filter((entry) => isDnsCall(entry) && namesExternal(entry)), []);
    assert.deepEqual(harness.since(mark, (entry) => entry.event === 'api.createTunnel'), []);
    assert.deepEqual(harness.since(mark, (entry) => entry.event === 'registry.begin').map((entry) => entry.ownershipId),
        [allocation]);
    assert.equal(CLOUDFLARE_ORIGIN, 'http://127.0.0.1:8080');
    assert.deepEqual(harness.api.ingress.get('managed_tunnel_1'), [
        { hostname: EXTERNAL, service: CLOUDFLARE_ORIGIN },
        { hostname: MANAGED, service: CLOUDFLARE_ORIGIN },
        TERMINAL,
    ]);
    assert.deepEqual(harness.since(mark, (entry) => entry.event === 'probe.hostname').map((entry) => entry.hostname),
        [EXTERNAL, MANAGED]);
    assert.deepEqual(harness.api.dns.get(`zone_123/${MANAGED}`), managedRecord);
    const journal = harness.journal.read();
    assert.deepEqual(journal.managedDnsRecords.map((entry) => entry.hostname), [MANAGED]);
    assert.deepEqual([...journal.managedIngressHostnames].sort(), [EXTERNAL, MANAGED]);
});

test('single reconcile removes only the owned legacy record and keeps the tunnel, then a reverse recreates it only when absent', async () => {
    const harness = createHarness();
    await harness.controller.reconcile(legacy('a'));
    await harness.controller.reconcile(dual('b'));
    const allocation = harness.managedTunnelRegistry.entries[0].ownershipId;
    const legacyRecord = harness.api.dns.get(`zone_123/${MANAGED}`);
    let mark = harness.events.length;

    const retired = await harness.controller.reconcile(single('c'));
    assert.equal(retired.state, 'ready');
    assert.deepEqual(retired.hostnames, [EXTERNAL]);
    assert.deepEqual(harness.since(mark, isDnsMutation), [
        { event: 'api.deleteDns', zoneId: 'zone_123', hostname: MANAGED, recordId: legacyRecord.id },
    ]);
    assert.deepEqual(harness.since(mark, (entry) => ['api.createTunnel', 'api.deleteTunnel'].includes(entry.event)), []);
    assert.deepEqual(harness.since(mark, (entry) => entry.event === 'registry.begin').map((entry) => entry.ownershipId),
        [allocation]);
    assert.deepEqual(harness.managedTunnelRegistry.entries.map((entry) => entry.tunnelId), ['managed_tunnel_1']);
    assert.deepEqual(harness.api.ingress.get('managed_tunnel_1'), [{ hostname: EXTERNAL, service: CLOUDFLARE_ORIGIN }, TERMINAL]);
    assert.deepEqual(harness.since(mark, (entry) => entry.event === 'probe.hostname').map((entry) => entry.hostname), [EXTERNAL]);
    assert.deepEqual(harness.journal.read().managedDnsRecords, []);

    mark = harness.events.length;
    assert.equal((await harness.controller.reconcile(dual('d'))).state, 'ready');
    const recreated = harness.since(mark, isDnsMutation);
    assert.deepEqual(recreated.map(({ event, hostname }) => [event, hostname]), [['api.createDns', MANAGED]]);
    assert.notEqual(harness.api.dns.get(`zone_123/${MANAGED}`).id, legacyRecord.id);

    mark = harness.events.length;
    assert.equal((await harness.controller.reconcile(legacy('e'))).state, 'ready');
    assert.deepEqual(harness.since(mark, (entry) => entry.event === 'api.createDns'), []);
    assert.deepEqual(harness.events.filter((entry) => isDnsCall(entry) && namesExternal(entry)), []);
    assert.deepEqual(harness.api.ingress.get('managed_tunnel_1'), [{ hostname: MANAGED, service: CLOUDFLARE_ORIGIN }, TERMINAL]);
    assert.deepEqual(harness.since(0, (entry) => entry.event === 'api.createTunnel').length, 1);
});

test('managed-to-external DNS transfer is refused before any ingress or DNS mutation', async () => {
    const harness = createHarness();
    await harness.controller.reconcile(publicationInput([MANAGED, 'owned.synthetic.test'], 'a'));
    const ownedRecord = harness.api.dns.get('zone_123/owned.synthetic.test');
    const ingress = harness.api.ingress.get('managed_tunnel_1');
    const mark = harness.events.length;
    const transfer = publicationInput([MANAGED], 'b');
    transfer.hosts['owned.synthetic.test'] = { agent: 'fixtures/explorer', dnsManagement: 'external' };

    await assert.rejects(harness.controller.reconcile(transfer), { code: 'CLOUDFLARE_EXTERNAL_DNS_TRANSFER_REFUSED' });
    assert.deepEqual(harness.since(mark, (entry) => entry.event === 'api.putIngress' || isDnsCall(entry)), []);
    assert.deepEqual(harness.api.dns.get('zone_123/owned.synthetic.test'), ownedRecord);
    assert.deepEqual(harness.api.ingress.get('managed_tunnel_1'), ingress);
    assert.equal(harness.controller.getStatus().state, 'error');
    assert.equal(harness.controller.getStatus().error.code, 'CLOUDFLARE_EXTERNAL_DNS_TRANSFER_REFUSED');
    assert.deepEqual(harness.journal.read().managedDnsRecords.map((entry) => entry.hostname).sort(),
        [MANAGED, 'owned.synthetic.test']);
});

test('the transfer refusal also precedes a changed-scope teardown', async () => {
    const harness = createHarness();
    await harness.controller.reconcile(publicationInput([MANAGED, 'owned.synthetic.test'], 'a'));
    const mark = harness.events.length;
    const transfer = publicationInput([MANAGED], 'b', { tunnelName: 'synthetic-replacement' });
    transfer.hosts['owned.synthetic.test'] = { agent: 'fixtures/explorer', dnsManagement: 'external' };
    await assert.rejects(harness.controller.reconcile(transfer), { code: 'CLOUDFLARE_EXTERNAL_DNS_TRANSFER_REFUSED' });
    assert.deepEqual(harness.since(mark, (entry) => entry.event === 'api.putIngress' || isDnsMutation(entry)), []);
});

test('an external host probe failure stops the shared connector and fails closed like any host', async () => {
    let failExternal = false;
    const harness = createHarness({
        probeHostname: async ({ hostname }) => ({ ok: !(failExternal && hostname === EXTERNAL) }),
    });
    await harness.controller.reconcile(legacy('a'));
    failExternal = true;
    await assert.rejects(harness.controller.reconcile(dual('b')), { code: 'CLOUDFLARE_HOST_PROBE_FAILED' });
    assert.equal(harness.connector.isRunning(), false);
    assert.equal(harness.routes.active, false);
    assert.equal(harness.controller.getStatus().state, 'error');
    assert.deepEqual(harness.events.filter((entry) => isDnsCall(entry) && namesExternal(entry)), []);
});

test('a compiled generation carries external DNS management into the publication plan', (t) => {
    const world = domainFixture(t, { mode: 'legacy' });
    const desired = desiredFor('legacy');
    desired.hosts[EXTERNAL] = { agent: 'fixtures/explorer', dnsManagement: 'external' };
    world.write(world.paths.desiredFile, desired);
    world.apply();
    const { selector, generation } = world.active();
    assert.equal(generation.desired.hosts[EXTERNAL].dnsManagement, 'external');
    // Routing never reads DNS ownership, so compiled hosts stay at their base shape.
    assert.deepEqual(Object.keys(generation.compiled.hosts[EXTERNAL]).sort(), ['agent', 'kind', 'routeKey']);
    const plan = normalizeCloudflarePublicationDesired({
        configurationGeneration: selector.generation,
        cloudflare: generation.desired.cloudflare,
        hosts: generation.desired.hosts,
    });
    const materialized = materializeManagedCloudflarePublicationPlan(plan, 'managed_tunnel_1');
    assert.deepEqual(materialized.dns.map((entry) => entry.hostname), Object.keys(desiredFor('legacy').hosts));
    assert.deepEqual(plan.hosts.map((entry) => entry.hostname).sort(), [EXTERNAL, ...Object.keys(desiredFor('legacy').hosts)].sort());
});

for (const mode of ['dual', 'single']) {
    test(`R1: every ${mode} ingress rule targets the Router origin and the root host carries no DNS`, (t) => {
        const world = domainFixture(t, { mode });
        const { selector, generation } = world.active();
        assert.equal(generation.desired.hosts[rootHost].rootApplication.agent, 'fixtures/bizanso');
        const plan = normalizeCloudflarePublicationDesired({
            configurationGeneration: selector.generation,
            cloudflare: generation.desired.cloudflare,
            hosts: generation.desired.hosts,
        });
        const materialized = materializeManagedCloudflarePublicationPlan(plan, 'managed_tunnel_1');
        for (const candidate of [plan, materialized]) {
            const rules = candidate.ingress.slice(0, -1);
            assert.deepEqual(rules.map((rule) => rule.hostname).sort(), Object.keys(generation.desired.hosts).sort());
            for (const rule of rules) assert.equal(rule.service, 'http://127.0.0.1:8080', rule.hostname);
            assert.deepEqual(candidate.ingress.at(-1), TERMINAL);
        }
        assert.deepEqual(materialized.dns.map((entry) => entry.hostname), mode === 'dual' ? [siblingHost] : []);
        // The selector the probe receives keeps the application, so a
        // root-application host is published like any other host.
        assert.deepEqual(plan.hosts.find((host) => host.hostname === rootHost).selector.rootApplication,
            { agent: 'fixtures/bizanso', port: 8787 });
    });
}
