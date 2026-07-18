import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeServiceSpec } from '../../cli/server/httpServiceRoutes.js';
import {
    explicitHttpServicePorts,
    resolveHostHttpServiceTargets,
    validateManifestHttpServices,
} from '../../cli/services/httpServicePortConfig.js';
import { resolveManifestRuntimeProfile } from '../../cli/services/profileService.js';

test('httpServices port accepts only an actual JSON safe integer in range', () => {
    assert.deepEqual(explicitHttpServicePorts({
        httpServices: [
            { externalPrefix: '/prefix-only/', access: 'authenticated' },
            { slug: 'dashboard', port: 3000, access: 'authenticated' },
            { slug: 'telemetry', port: 3001, access: 'guest' },
            { slug: 'dashboard-two', port: 3000, access: 'authenticated' },
        ],
    }), [3000, 3001]);

    for (const value of ['3000', true, false, 3000.5, null, '', 0, 65536, Number.MAX_SAFE_INTEGER, NaN, Infinity]) {
        assert.throws(() => explicitHttpServicePorts({
            httpServices: [{ slug: 'dashboard', port: value }],
        }), { code: 'PLOINKY_MANIFEST_HTTP_SERVICE_INVALID' }, `value ${String(value)} must fail closed`);
    }
});

test('service slugs are optional for prefix-only routes but exact when present', () => {
    assert.doesNotThrow(() => validateManifestHttpServices({
        httpServices: [{ externalPrefix: '/soul-gateway/', access: 'authenticated' }],
    }));
    for (const slug of ['Dashboard', ' dashboard', 'dashboard ', '', '/dashboard', 'dashboard_', 'dashboard-']) {
        assert.throws(() => validateManifestHttpServices({
            httpServices: [{ slug, externalPrefix: '/dashboard/' }],
        }), { code: 'PLOINKY_MANIFEST_HTTP_SERVICE_INVALID' });
    }
    const prefixOnly = normalizeServiceSpec('soul', { hostPort: 43101 }, {
        externalPrefix: '/soul-gateway/',
        internalPrefix: '/',
        access: 'authenticated',
    });
    assert.equal(Object.hasOwn(prefixOnly, 'slug'), false);
    assert.equal(prefixOnly.port, null);
});

test('removed extra service port field is rejected at manifest and profile boundaries', () => {
    const removedField = ['additional', 'ServerPort'].join('');
    assert.throws(() => resolveManifestRuntimeProfile({
        [removedField]: 3000,
    }, { agentName: 'fixtures/removed-root' }), /was removed/);
    assert.throws(() => resolveManifestRuntimeProfile({
        profiles: {
            default: {},
            production: { [removedField]: 3000 },
        },
    }, { agentName: 'fixtures/removed-profile' }), /was removed/);
});

test('httpServices reject physical-host publication-shaped fields at manifest and profile boundaries', () => {
    for (const [field, value] of [
        ['hostPort', 3000],
        ['hostIp', '127.0.0.1'],
        ['publish', true],
        ['publishedPort', 3000],
        ['expose', true],
        ['listenLan', true],
    ]) {
        for (const manifest of [
            {
                httpServices: [{
                    slug: 'dashboard',
                    externalPrefix: '/dashboard/',
                    access: 'authenticated',
                    [field]: value,
                }],
            },
            {
                profiles: {
                    default: {
                        httpServices: [{
                            slug: 'dashboard',
                            externalPrefix: '/dashboard/',
                            access: 'authenticated',
                            [field]: value,
                        }],
                    },
                },
            },
        ]) {
            assert.throws(
                () => validateManifestHttpServices(manifest),
                (error) => error?.code === 'PLOINKY_MANIFEST_HTTP_SERVICE_INVALID'
                    && /physical-host publication|private service target|httpServices\[\]\.port/.test(error.message),
            );
        }
    }
});

test('httpServices explicit ports remain private target selectors only', () => {
    const manifest = {
        httpServices: [
            { slug: 'dashboard', port: 3000, externalPrefix: '/dashboard/', access: 'authenticated' },
            { slug: 'telemetry', port: 3001, externalPrefix: '/telemetry/', access: 'guest' },
        ],
    };
    const forbiddenFields = ['hostIp', 'hostPort', 'publish', 'publishedPort', 'expose', 'listenLan'];

    assert.deepEqual(explicitHttpServicePorts(manifest), [3000, 3001]);
    const targets = resolveHostHttpServiceTargets(manifest);
    assert.deepEqual(targets, { 3000: 3000, 3001: 3001 });
    for (const field of forbiddenFields) {
        assert.equal(Object.hasOwn(targets, field), false);
    }
});

test('route service normalization rejects physical-host publication-shaped fields', () => {
    assert.throws(
        () => normalizeServiceSpec('alpha', { hostPort: 43101 }, {
            slug: 'dashboard',
            externalPrefix: '/dashboard/',
            access: 'authenticated',
            hostPort: 3000,
        }),
        (error) => error?.code === 'PLOINKY_MANIFEST_HTTP_SERVICE_INVALID'
            && /physical-host publication|private service target/.test(error.message),
    );
});
