import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeServiceSpec } from '../../cli/server/httpServiceRoutes.js';
import {
    explicitHttpServicePorts,
    validateManifestHttpServices,
} from '../../cli/sandbox/httpServicePortConfig.js';
import { resolveManifestRuntimeProfile } from '../../cli/utils/runtime/profileService.js';

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
