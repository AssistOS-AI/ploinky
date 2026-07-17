import assert from 'node:assert/strict';
import test from 'node:test';

import {
    CLOUDFLARE_ORIGIN,
    CLOUDFLARE_TERMINAL_SERVICE,
    normalizeCloudflarePublicationDesired,
    publicPlanSummary,
    redactCloudflareText,
} from '../../cli/services/cloudflarePublicationPlan.js';

const GENERATION = `sha256:${'a'.repeat(64)}`;
const COMPLETE = Object.freeze({
    accountId: 'account_123',
    zoneId: 'zone_123',
    tunnelId: 'tunnel_123',
    tunnelTokenSecret: 'publication/cloudflare-connector',
    apiTokenSecret: 'publication/cloudflare-api',
});
const HOSTS = Object.freeze({
    'office.example.test': {
        agent: 'AssistOSExplorer/onlyOffice',
        httpService: 'onlyoffice-editor',
    },
    'explorer.example.test': {
        agent: 'AssistOSExplorer/explorer',
        routerSurfaces: ['browser-auth', 'topology-projection'],
    },
});
test('wholly absent Cloudflare tuple and hosts selects explicit local-only mode', () => {
    const plan = normalizeCloudflarePublicationDesired({ configurationGeneration: GENERATION });
    assert.equal(plan.mode, 'local-only');
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

test('hosts without credentials and credentials without hosts are both partial', () => {
    assert.throws(
        () => normalizeCloudflarePublicationDesired({ configurationGeneration: GENERATION, hosts: HOSTS }),
        (error) => error.code === 'CLOUDFLARE_CONFIGURATION_PARTIAL',
    );
    assert.throws(
        () => normalizeCloudflarePublicationDesired({ configurationGeneration: GENERATION, cloudflare: COMPLETE }),
        (error) => error.code === 'CLOUDFLARE_CONFIGURATION_PARTIAL',
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
    for (const field of ['apiToken', 'tunnelToken', 'tunnelName', 'apiBaseUrl', 'mode']) {
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
            hosts: { 'office.example.test': { httpService: 'onlyoffice-editor' } },
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
