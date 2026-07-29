import assert from 'node:assert/strict';
import test from 'node:test';

import {
    CLOUDFLARE_ORIGIN,
    CLOUDFLARE_TERMINAL_SERVICE,
    materializeManagedCloudflarePublicationPlan,
    normalizeCloudflarePublicationDesired,
    publicPlanSummary,
    redactCloudflareText,
} from '../../ploinky-box/cloudflared/publicationPlan.mjs';

const GENERATION = `sha256:${'a'.repeat(64)}`;
const COMPLETE = Object.freeze({
    accountId: 'account_123',
    zoneId: 'zone_123',
    tunnelId: 'tunnel_123',
    tunnelTokenSecret: 'publication/cloudflare-connector',
    apiTokenSecret: 'publication/cloudflare-api',
});
const CONNECTOR_ONLY = Object.freeze({
    tunnelTokenSecret: 'publication/cloudflare-connector',
});
const MANAGED = Object.freeze({
    accountId: 'account_123',
    zoneId: 'zone_123',
    tunnelName: 'explorer-qa',
    apiTokenSecret: 'publication/cloudflare-api',
});
const HOSTS = Object.freeze({
    'office.example.test': {
        agent: 'AssistOSExplorer/onlyOffice',
    },
    'explorer.example.test': {
        agent: 'AssistOSExplorer/explorer',
        routerSurfaces: ['browser-auth', 'topology-projection'],
    },
});
test('wholly absent Cloudflare tuple and hosts selects explicit local-only mode', () => {
    const plan = normalizeCloudflarePublicationDesired({ configurationGeneration: GENERATION });
    assert.equal(plan.mode, 'local-only');
    assert.equal(plan.management, null);
    assert.deepEqual(plan.hosts, []);
    assert.match(plan.desiredDigest, /^sha256:[a-f0-9]{64}$/);
});

test('complete tuple produces deterministic fixed-origin ingress and CNAME plan', () => {
    const plan = normalizeCloudflarePublicationDesired({
        configurationGeneration: GENERATION,
        cloudflare: COMPLETE,
        hosts: HOSTS,
    });
    assert.equal(plan.mode, 'cloudflare');
    assert.equal(plan.management, 'api-managed');
    assert.equal(plan.tunnelManagement, 'existing');
    assert.deepEqual(plan.hosts.map((entry) => entry.hostname), [
        'explorer.example.test',
        'office.example.test',
    ]);
    assert.deepEqual(plan.ingress, [
        { hostname: 'explorer.example.test', service: CLOUDFLARE_ORIGIN },
        { hostname: 'office.example.test', service: CLOUDFLARE_ORIGIN },
        { service: CLOUDFLARE_TERMINAL_SERVICE },
    ]);
    assert.ok(plan.dns.every((entry) => entry.content === 'tunnel_123.cfargotunnel.com'));
    assert.ok(plan.dns.every((entry) => entry.proxied === true && entry.ttl === 1));
    assert.equal(plan.desiredDigest, normalizeCloudflarePublicationDesired({
        configurationGeneration: GENERATION,
        cloudflare: { ...COMPLETE },
        hosts: {
            'explorer.example.test': HOSTS['explorer.example.test'],
            'office.example.test': HOSTS['office.example.test'],
        },
    }).desiredDigest);
});

test('managed tunnel desired state materializes only after Cloudflare assigns its id', () => {
    const desired = normalizeCloudflarePublicationDesired({
        configurationGeneration: GENERATION,
        cloudflare: MANAGED,
        hosts: HOSTS,
    });
    assert.equal(desired.mode, 'cloudflare');
    assert.equal(desired.management, 'api-managed');
    assert.equal(desired.tunnelManagement, 'ploinky-managed');
    assert.deepEqual(desired.managedTunnel, {
        name: 'explorer-qa',
        deleteOnTeardown: false,
    });
    assert.equal(Object.hasOwn(desired, 'scope'), false);
    assert.equal(Object.hasOwn(desired, 'dns'), false);
    assert.deepEqual(desired.secretHandles, {
        apiToken: 'publication/cloudflare-api',
    });

    const materialized = materializeManagedCloudflarePublicationPlan(desired, 'managed_tunnel_123');
    assert.deepEqual(materialized.scope, {
        accountId: 'account_123',
        zoneId: 'zone_123',
        tunnelId: 'managed_tunnel_123',
    });
    assert.ok(materialized.dns.every(
        (entry) => entry.content === 'managed_tunnel_123.cfargotunnel.com',
    ));
    assert.equal(materialized.desiredDigest, desired.desiredDigest);
    assert.deepEqual(publicPlanSummary(materialized).scope, materialized.scope);
    assert.doesNotMatch(
        JSON.stringify(publicPlanSummary(materialized)),
        /publication\/cloudflare-api/,
    );
});

test('connector-only accepts one or multiple exact hosts without API-managed fields', () => {
    const plan = normalizeCloudflarePublicationDesired({
        configurationGeneration: GENERATION,
        cloudflare: CONNECTOR_ONLY,
        hosts: HOSTS,
    });
    assert.equal(plan.mode, 'cloudflare');
    assert.equal(plan.management, 'connector-only');
    assert.equal(plan.originService, CLOUDFLARE_ORIGIN);
    assert.deepEqual(plan.hosts.map((entry) => entry.hostname), [
        'explorer.example.test',
        'office.example.test',
    ]);
    assert.deepEqual(plan.secretHandles, {
        tunnelToken: 'publication/cloudflare-connector',
    });
    assert.equal(Object.hasOwn(plan, 'scope'), false);
    assert.equal(Object.hasOwn(plan, 'ingress'), false);
    assert.equal(Object.hasOwn(plan, 'dns'), false);
});

test('connector-only and API-managed digests are separated and both summaries omit handles', () => {
    const connector = normalizeCloudflarePublicationDesired({
        configurationGeneration: GENERATION,
        cloudflare: CONNECTOR_ONLY,
        hosts: HOSTS,
    });
    const apiManaged = normalizeCloudflarePublicationDesired({
        configurationGeneration: GENERATION,
        cloudflare: COMPLETE,
        hosts: HOSTS,
    });
    assert.notEqual(connector.desiredDigest, apiManaged.desiredDigest);
    assert.equal(publicPlanSummary(connector).management, 'connector-only');
    assert.equal(publicPlanSummary(apiManaged).management, 'api-managed');
    assert.doesNotMatch(
        JSON.stringify([publicPlanSummary(connector), publicPlanSummary(apiManaged)]),
        /publication\/cloudflare|TokenSecret|apiToken/i,
    );
});

test('secret handle names do not enter the desired-state digest or public summary', () => {
    const first = normalizeCloudflarePublicationDesired({
        configurationGeneration: GENERATION,
        cloudflare: COMPLETE,
        hosts: HOSTS,
    });
    const second = normalizeCloudflarePublicationDesired({
        configurationGeneration: GENERATION,
        cloudflare: {
            ...COMPLETE,
            tunnelTokenSecret: 'rotated/connector',
            apiTokenSecret: 'rotated/api',
        },
        hosts: HOSTS,
    });
    assert.equal(first.desiredDigest, second.desiredDigest);
    const serialized = JSON.stringify(publicPlanSummary(first));
    assert.doesNotMatch(serialized, /publication\/cloudflare|TokenSecret|apiToken/i);
});

test('every partial Cloudflare tuple is rejected instead of falling back to local-only', () => {
    for (const missing of Object.keys(COMPLETE)) {
        const partial = { ...COMPLETE };
        delete partial[missing];
        assert.throws(
            () => normalizeCloudflarePublicationDesired({
                configurationGeneration: GENERATION,
                cloudflare: partial,
                hosts: HOSTS,
            }),
            (error) => error.code === 'CLOUDFLARE_CONFIGURATION_PARTIAL' && /partial/.test(error.message),
            missing,
        );
    }
});

test('hosts require credentials while complete API credentials without hosts select teardown', () => {
    assert.throws(
        () => normalizeCloudflarePublicationDesired({ configurationGeneration: GENERATION, hosts: HOSTS }),
        (error) => error.code === 'CLOUDFLARE_CONFIGURATION_PARTIAL',
    );
    const teardown = normalizeCloudflarePublicationDesired({
        configurationGeneration: GENERATION,
        cloudflare: COMPLETE,
    });
    assert.equal(teardown.mode, 'local-only');
    assert.equal(teardown.management, 'api-managed');
    assert.deepEqual(teardown.hosts, []);
    assert.deepEqual(teardown.scope, {
        accountId: 'account_123',
        zoneId: 'zone_123',
        tunnelId: 'tunnel_123',
    });
    assert.throws(
        () => normalizeCloudflarePublicationDesired({
            configurationGeneration: GENERATION,
            cloudflare: CONNECTOR_ONLY,
        }),
        (error) => error.code === 'CLOUDFLARE_CONFIGURATION_PARTIAL',
    );
    assert.throws(
        () => normalizeCloudflarePublicationDesired({
            configurationGeneration: GENERATION,
            cloudflare: {},
        }),
        (error) => error.code === 'CLOUDFLARE_CONFIGURATION_PARTIAL',
    );
});

test('managed tunnel credentials without hosts select an explicit ownership-aware teardown', () => {
    const teardown = normalizeCloudflarePublicationDesired({
        configurationGeneration: GENERATION,
        cloudflare: {
            ...MANAGED,
            deleteTunnelOnTeardown: true,
        },
    });
    assert.equal(teardown.mode, 'local-only');
    assert.equal(teardown.management, 'api-managed');
    assert.equal(teardown.tunnelManagement, 'ploinky-managed');
    assert.deepEqual(teardown.managedTunnel, {
        name: 'explorer-qa',
        deleteOnTeardown: true,
    });
    assert.equal(Object.hasOwn(teardown, 'scope'), false);
    assert.deepEqual(
        materializeManagedCloudflarePublicationPlan(teardown, 'managed_tunnel_123').scope,
        {
            accountId: 'account_123',
            zoneId: 'zone_123',
            tunnelId: 'managed_tunnel_123',
        },
    );
});

test('connector-only mixed with incomplete API-managed fields is rejected as partial', () => {
    for (const [field, value] of [
        ['accountId', 'fixture-account'],
        ['zoneId', 'fixture-zone'],
        ['tunnelId', 'fixture-tunnel'],
        ['apiTokenSecret', 'fixture-api'],
        ['apiTokenSecret', ''],
    ]) {
        assert.throws(
            () => normalizeCloudflarePublicationDesired({
                configurationGeneration: GENERATION,
                cloudflare: { ...CONNECTOR_ONLY, [field]: value },
                hosts: HOSTS,
            }),
            (error) => error.code === 'CLOUDFLARE_CONFIGURATION_PARTIAL',
            field,
        );
    }
});

test('existing and Ploinky-managed tunnel declarations cannot be mixed', () => {
    for (const cloudflare of [
        { ...COMPLETE, tunnelName: 'explorer-qa' },
        { ...MANAGED, tunnelId: 'tunnel_123' },
        { ...MANAGED, tunnelTokenSecret: 'publication/cloudflare-connector' },
    ]) {
        assert.throws(
            () => normalizeCloudflarePublicationDesired({
                configurationGeneration: GENERATION,
                cloudflare,
                hosts: HOSTS,
            }),
            (error) => error.code === 'CLOUDFLARE_CONFIGURATION_PARTIAL',
        );
    }
});

test('managed tunnel names reserve room for the Ploinky ownership suffix', () => {
    assert.doesNotThrow(() => normalizeCloudflarePublicationDesired({
        configurationGeneration: GENERATION,
        cloudflare: { ...MANAGED, tunnelName: 'a'.repeat(48) },
        hosts: HOSTS,
    }));
    assert.throws(
        () => normalizeCloudflarePublicationDesired({
            configurationGeneration: GENERATION,
            cloudflare: { ...MANAGED, tunnelName: 'a'.repeat(49) },
            hosts: HOSTS,
        }),
        (error) => error.code === 'CLOUDFLARE_CONFIGURATION_INVALID',
    );
});

test('connector and API credentials require separate handles', () => {
    assert.throws(
        () => normalizeCloudflarePublicationDesired({
            configurationGeneration: GENERATION,
            cloudflare: { ...COMPLETE, apiTokenSecret: COMPLETE.tunnelTokenSecret },
            hosts: HOSTS,
        }),
        (error) => error.code === 'CLOUDFLARE_SECRET_SEPARATION_REQUIRED',
    );
});

test('literal or legacy Cloudflare configuration fields are rejected by the hard-cut schema', () => {
    for (const field of ['apiToken', 'tunnelToken', 'tunnelLabel', 'apiBaseUrl', 'mode']) {
        assert.throws(
            () => normalizeCloudflarePublicationDesired({
                configurationGeneration: GENERATION,
                cloudflare: { ...COMPLETE, [field]: 'forbidden' },
                hosts: HOSTS,
            }),
            (error) => error.code === 'CLOUDFLARE_CONFIGURATION_INVALID' && /unsupported field/.test(error.message),
            field,
        );
    }
});

test('public hostnames are exact lower-case DNS names without wildcard or local aliases', () => {
    for (const hostname of [
        '',
        'Office.example.test',
        'office.example.test.',
        '*.example.test',
        'example',
        '127.0.0.1',
        'office.localhost',
        '-office.example.test',
        `${'a'.repeat(64)}.example.test`,
    ]) {
        assert.throws(
            () => normalizeCloudflarePublicationDesired({
                configurationGeneration: GENERATION,
                cloudflare: COMPLETE,
                hosts: { [hostname]: { agent: 'repo/agent' } },
            }),
            (error) => ['CLOUDFLARE_HOST_INVALID', 'CLOUDFLARE_CONFIGURATION_PARTIAL'].includes(error.code),
            hostname || '<empty>',
        );
    }
});

test('host selector must name a validated agent and cannot be a raw scalar', () => {
    assert.throws(
        () => normalizeCloudflarePublicationDesired({
            configurationGeneration: GENERATION,
            cloudflare: COMPLETE,
        hosts: { 'office.example.test': {} },
        }),
        (error) => error.code === 'CLOUDFLARE_HOST_INVALID',
    );
    assert.throws(
        () => normalizeCloudflarePublicationDesired({
            configurationGeneration: GENERATION,
            cloudflare: COMPLETE,
            hosts: { 'office.example.test': 8080 },
        }),
        (error) => error.code === 'CLOUDFLARE_HOST_INVALID',
    );
});

test('configuration generation must be the captured immutable sha256 id', () => {
    for (const generation of ['', 'v5', 'sha256:1234', `sha256:${'g'.repeat(64)}`]) {
        assert.throws(
            () => normalizeCloudflarePublicationDesired({ configurationGeneration: generation }),
            (error) => error.code === 'CLOUDFLARE_CONFIGURATION_INVALID',
        );
    }
});

test('redaction removes exact tokens, bearer values, query tokens, and JWT-shaped material', () => {
    const secret = 'connector-super-secret';
    const text = redactCloudflareText(
        `failed ${secret} Bearer api-secret https://x.test/?token=query-secret eyJabc.def.ghi`,
        [secret],
    );
    assert.doesNotMatch(text, /connector-super-secret|api-secret|query-secret|eyJabc/);
    assert.match(text, /\[redacted\]/);
});
