import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    assertRouterEndpoint,
    buildRouterEndpoint,
    parseRouterHostPort,
    parseRouterPort,
    resolveInitialRouterPort,
    resolvePersistedRouterPort,
    resolveRouterEndpoint,
    selectedRouterHostPort,
} from '../../cli/sandbox/routerPort.js';

function tempRouting(contents) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-router-port-'));
    const routingFile = path.join(root, '.ploinky', 'routing.json');
    if (contents !== undefined) {
        fs.mkdirSync(path.dirname(routingFile), { recursive: true });
        fs.writeFileSync(routingFile, contents);
    }
    return { root, routingFile };
}

test('parseRouterPort accepts only the fixed in-box Router port', () => {
    assert.equal(parseRouterPort(8080), 8080);
    assert.equal(parseRouterPort('8080'), 8080);
});

test('selected physical Router host port comes only from the supervisor environment', () => {
    assert.equal(selectedRouterHostPort({ PLOINKY_ROUTER_HOST_PORT: '19194' }), 19194);
    assert.equal(selectedRouterHostPort({}), 8080);
    assert.equal(parseRouterHostPort(65535), 65535);
    for (const value of ['019194', ' 19194', '19194 ', '19194x', '', null, true, 0, 65536, 1.5]) {
        assert.throws(() => parseRouterHostPort(value), {
            code: 'PLOINKY_ROUTER_HOST_PORT_INVALID',
        });
    }
});

test('parseRouterPort rejects missing, signed, fractional, padded, junk, and out-of-range inputs', () => {
    const invalid = [
        undefined, null, '', ' ', ' 8080', '8080 ', '08080', '+8080', '-1',
        '1.5', 1.5, '8080x', '0', 0, '1', 1, '8097', 8097, '65536', 65536, Number.MAX_SAFE_INTEGER,
        '９', '1e3', {}, [], true,
    ];
    for (const value of invalid) {
        assert.throws(() => parseRouterPort(value), {
            code: 'PLOINKY_ROUTER_PORT_INVALID',
        }, `expected ${JSON.stringify(value)} to be rejected`);
    }
});

test('only initial resolution may choose 8080 when no port has been persisted', () => {
    const { root, routingFile } = tempRouting();
    try {
        assert.equal(resolveInitialRouterPort({ routingFile }), 8080);
        assert.equal(fs.existsSync(routingFile), false, 'read-only resolver does not persist by itself');
        assert.throws(() => resolvePersistedRouterPort({ routingFile }), {
            code: 'PLOINKY_ROUTER_PORT_REQUIRED',
        });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('persisted resolution rejects every pre-v5 non-fixed inner port', () => {
    const { root, routingFile } = tempRouting(JSON.stringify({ port: '8080', routes: {} }));
    try {
        assert.equal(resolvePersistedRouterPort({ routingFile }), 8080);
        assert.equal(resolvePersistedRouterPort({ explicitPort: 8080, routingFile }), 8080);
        assert.throws(
            () => resolvePersistedRouterPort({ explicitPort: '8097', routingFile }),
            { code: 'PLOINKY_ROUTER_PORT_INVALID' },
        );
        assert.equal(resolveInitialRouterPort({ explicitPort: 8080, routingFile }), 8080);
        fs.writeFileSync(routingFile, JSON.stringify({ port: 8097, routes: {} }));
        assert.throws(() => resolvePersistedRouterPort({ routingFile }), {
            code: 'PLOINKY_ROUTER_PORT_INVALID',
        });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('corrupt persisted router ports fail instead of becoming defaults', () => {
    for (const contents of [
        '{',
        '[]',
        JSON.stringify({ port: '' }),
        JSON.stringify({ port: '+8080' }),
        JSON.stringify({ port: '1.5' }),
        JSON.stringify({ port: '8080junk' }),
        JSON.stringify({ port: 0 }),
        JSON.stringify({ port: 65536 }),
    ]) {
        const { root, routingFile } = tempRouting(contents);
        try {
            assert.throws(() => resolvePersistedRouterPort({ routingFile }), {
                code: 'PLOINKY_ROUTER_PORT_INVALID',
            });
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    }
});

test('endpoint matrix is canonical for default, bridge, host, and none', () => {
    const { root, routingFile } = tempRouting(JSON.stringify({ port: 8080 }));
    try {
        for (const mode of ['default', 'bridge']) {
            assert.deepEqual(resolveRouterEndpoint(mode, { routingFile }), buildRouterEndpoint(mode, 8080));
            assert.deepEqual(resolveRouterEndpoint(mode, { routingFile }).env, {
                PLOINKY_ROUTER_HOST: 'host.containers.internal',
                PLOINKY_ROUTER_PORT: '8080',
                PLOINKY_ROUTER_URL: 'http://host.containers.internal:8080',
            });
        }
        assert.deepEqual(resolveRouterEndpoint('host', { routingFile }).env, {
            PLOINKY_ROUTER_HOST: '127.0.0.1',
            PLOINKY_ROUTER_PORT: '8080',
            PLOINKY_ROUTER_URL: 'http://127.0.0.1:8080',
        });
        assert.equal(resolveRouterEndpoint('none', { routingFile }), null);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('none mode never reads or validates router ports and requires explicit null downstream', () => {
    const missing = tempRouting();
    const corrupt = tempRouting(JSON.stringify({ port: '8080x' }));
    try {
        assert.equal(resolveRouterEndpoint('none', {
            explicitPort: 'not-a-port',
            routingFile: missing.routingFile,
        }), null);
        assert.equal(resolveRouterEndpoint('none', {
            explicitPort: 0,
            routingFile: corrupt.routingFile,
        }), null);
        assert.equal(assertRouterEndpoint(null, 'none', { explicitPort: 'not-a-port' }), null);
        assert.throws(() => assertRouterEndpoint(undefined, 'none'), {
            code: 'PLOINKY_ROUTER_ENDPOINT_INVALID',
        });
        assert.throws(() => assertRouterEndpoint(buildRouterEndpoint('host', 8080), 'none'), {
            code: 'PLOINKY_ROUTER_ENDPOINT_INVALID',
        });
    } finally {
        fs.rmSync(missing.root, { recursive: true, force: true });
        fs.rmSync(corrupt.root, { recursive: true, force: true });
    }
});

test('assertRouterEndpoint rejects arbitrary host, URL, and env overrides', () => {
    const expected = buildRouterEndpoint('bridge', 8080);
    assert.deepEqual(assertRouterEndpoint(expected, 'bridge'), expected);
    for (const endpoint of [
        { ...expected, host: 'host.docker.internal' },
        { ...expected, url: 'http://127.0.0.1:8080' },
        { ...expected, env: { ...expected.env, PLOINKY_ROUTER_PORT: '8097' } },
    ]) {
        assert.throws(() => assertRouterEndpoint(endpoint, 'bridge'), {
            code: 'PLOINKY_ROUTER_ENDPOINT_INVALID',
        });
    }
});
