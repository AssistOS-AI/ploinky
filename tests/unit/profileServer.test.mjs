import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createProfileServerPublish,
    normalizeProfileServer,
    resolvePublishedProfileServer,
    resolveProfileServer
} from '../../cli/utils/runtime/profileServer.js';
import {
    buildProfileServerPath,
    resolveProfileServerTarget
} from '../../cli/server/profileServerProxy.js';

test('normalizeProfileServer accepts port strings', () => {
    assert.deepEqual(
        normalizeProfileServer('3000', { mode: 'container' }),
        { url: 'http://127.0.0.1:3000', mode: 'container' }
    );
});

test('normalizeProfileServer accepts host:port strings', () => {
    assert.deepEqual(
        normalizeProfileServer('127.0.0.1:3000', { mode: 'container' }),
        { url: 'http://127.0.0.1:3000', mode: 'container' }
    );
});

test('normalizeProfileServer rejects URL strings', () => {
    assert.throws(
        () => normalizeProfileServer('https://127.0.0.1:3000'),
        /expected port or host:port/
    );
});

test('resolveProfileServer switches to host mode for host-network profiles', () => {
    const manifest = { network: { mode: 'host' } };
    const profile = { additionalServerPort: '3000' };
    assert.deepEqual(
        resolveProfileServer(manifest, profile, { runtimeMode: 'container' }),
        { url: 'http://127.0.0.1:3000', mode: 'host' }
    );
});

test('resolveProfileServer rejects legacy profile server field', () => {
    assert.throws(
        () => resolveProfileServer({}, { server: 'http://127.0.0.1:3000' }),
        /renamed to 'additionalServerPort'/
    );
});

test('createProfileServerPublish publishes container profile servers on loopback ephemeral host ports', () => {
    const publish = createProfileServerPublish(
        { url: 'http://127.0.0.1:3000', mode: 'container' },
        [{ containerPort: 7000, hostPort: 45993, hostIp: '127.0.0.1', protocol: 'tcp' }]
    );

    assert.deepEqual(publish, {
        publishArg: '127.0.0.1::3000',
        mapping: {
            hostIp: '127.0.0.1',
            hostPort: 0,
            containerPort: 3000,
            protocol: 'tcp',
            profileServer: true
        }
    });
});

test('createProfileServerPublish does not duplicate declared server port mappings', () => {
    const publish = createProfileServerPublish(
        { url: 'http://127.0.0.1:3000', mode: 'container' },
        [{ containerPort: 3000, hostPort: 31000, hostIp: '127.0.0.1', protocol: 'tcp' }]
    );

    assert.equal(publish, null);
});

test('resolvePublishedProfileServer rewrites container server URL to resolved host port', () => {
    const resolved = resolvePublishedProfileServer(
        { url: 'http://127.0.0.1:3000/app', mode: 'container' },
        [{ containerPort: 3000, hostPort: 37421, hostIp: '127.0.0.1', protocol: 'tcp' }]
    );

    assert.deepEqual(resolved, {
        url: 'http://127.0.0.1:37421/app',
        mode: 'host',
        containerUrl: 'http://127.0.0.1:3000/app'
    });
});

test('buildProfileServerPath forwards root-mounted host paths and preserves query string', () => {
    assert.equal(
        buildProfileServerPath('/assets/app.js?x=1', 'http://127.0.0.1:3000'),
        '/assets/app.js?x=1'
    );
    assert.equal(
        buildProfileServerPath('/', 'http://127.0.0.1:3000/app'),
        '/app/'
    );
    assert.equal(
        buildProfileServerPath('/api/session?x=1', 'http://127.0.0.1:3000/app'),
        '/app/api/session?x=1'
    );
});

test('resolveProfileServerTarget leaves host-mode loopback unchanged', () => {
    const resolved = resolveProfileServerTarget({
        additionalServerPort: { url: 'http://127.0.0.1:3000/', mode: 'host' }
    });
    assert.equal(resolved.target.hostname, '127.0.0.1');
    assert.equal(resolved.target.port, '3000');
});
