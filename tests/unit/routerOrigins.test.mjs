import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readEdgeTopology } from '../../Agent/lib/edgeTopology.mjs';
import {
    canonicalRouterOriginList,
    isCanonicalRouterOrigin,
    parseRouterOriginList,
} from '../../Agent/lib/routerOrigins.mjs';
import { readCurrentEdgeTopology } from '../../cli/sandbox/edgeGeneration.js';
import {
    capturePublicRouterHosts,
    deriveRouterOrigins,
} from '../../cli/utils/publicRouterHosts.mjs';
import { deriveRouterBindingHosts } from '../../ploinky-box/routerBinding.mjs';

const INTERFACES = {
    lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    enp3s0: [{ family: 'IPv4', address: '192.168.1.10', internal: false }],
    tailscale0: [{ family: 'IPv4', address: '100.73.151.25', internal: false }],
    podman0: [{ family: 'IPv4', address: '10.88.0.1', internal: false }],
    docker0: [{ family: 'IPv4', address: '172.17.0.1', internal: false }],
    wlp2s0: [{ family: 'IPv6', address: 'fe80::1', internal: false }],
};

function originsFor(binding, { hostname = 'pgx.example.lan' } = {}) {
    const hosts = deriveRouterBindingHosts(binding, { interfaces: INTERFACES, hostname });
    return deriveRouterOrigins(capturePublicRouterHosts(hosts ? { PLOINKY_PUBLIC_ROUTER_HOSTS: JSON.stringify(hosts) } : {}), binding.hostPort);
}

test('loopback-only binding publishes no automatic Router origins', () => {
    assert.deepEqual(originsFor({ address: '127.0.0.1', hostPort: 3000 }), []);
    assert.deepEqual(capturePublicRouterHosts({}), []);
    assert.deepEqual(capturePublicRouterHosts({ PLOINKY_PUBLIC_ROUTER_HOSTS: '' }), []);
});

test('wildcard binding expands only the admitted host addresses and host-name aliases', () => {
    assert.deepEqual(originsFor({ address: '0.0.0.0', hostPort: 3000 }), [
        'http://100.73.151.25:3000',
        'http://192.168.1.10:3000',
        'http://pgx.example.lan:3000',
        'http://pgx.local:3000',
        'http://pgx:3000',
    ]);
    const origins = originsFor({ address: '0.0.0.0', hostPort: 3000 });
    for (const excluded of ['0.0.0.0', '127.0.0.1', '10.88.0.1', '172.17.0.1', 'localhost', '*']) {
        assert.equal(origins.some((origin) => new URL(origin).hostname === excluded), false, excluded);
    }
});

test('a specific-address binding trusts that LAN or Tailscale address plus host names only', () => {
    assert.deepEqual(originsFor({ address: '100.73.151.25', hostPort: 3000 }), [
        'http://100.73.151.25:3000',
        'http://pgx.example.lan:3000',
        'http://pgx.local:3000',
        'http://pgx:3000',
    ]);
    assert.deepEqual(originsFor({ address: '192.168.1.10', hostPort: 3000 }, { hostname: 'localhost' }), [
        'http://192.168.1.10:3000',
    ]);
});

test('the selected outer port is exact and the HTTP default port is canonicalized', () => {
    assert.deepEqual(deriveRouterOrigins(['192.168.1.10', 'pgx'], 8083), ['http://192.168.1.10:8083', 'http://pgx:8083']);
    assert.deepEqual(deriveRouterOrigins(['pgx'], 80), ['http://pgx']);
    for (const port of [0, 65536, '3000', 3000.5, undefined]) {
        assert.throws(() => deriveRouterOrigins(['pgx'], port), /outer Router port/, String(port));
    }
});

test('derivation rejects wildcard, unspecified, loopback, credential, port, path, and reserved hosts', () => {
    for (const host of ['0.0.0.0', '*', '*.example.test', '127.0.0.1', 'localhost', 'user@pgx', 'pgx:3000',
        'pgx/path', 'pgx?x', '[::1]', 'host.containers.internal', 'pgx.']) {
        assert.throws(() => deriveRouterOrigins([host], 3000), { code: 'PLOINKY_PUBLIC_ROUTER_HOSTS_INVALID' }, host);
    }
    for (const text of ['["pgx", "10.0.0.2"]', '["pgx","pgx"]', '{"hosts":[]}', 'not-json', '["0.0.0.0"]']) {
        assert.throws(() => capturePublicRouterHosts({ PLOINKY_PUBLIC_ROUTER_HOSTS: text }), { code: 'PLOINKY_PUBLIC_ROUTER_HOSTS_INVALID' }, text);
    }
});

test('origin lists are exact, bounded, sorted, and duplicate-free', () => {
    assert.deepEqual(canonicalRouterOriginList(['http://pgx:3000', 'http://100.73.151.25:3000', 'http://pgx:3000']), [
        'http://100.73.151.25:3000',
        'http://pgx:3000',
    ]);
    assert.deepEqual(parseRouterOriginList([]), []);
    assert.deepEqual(parseRouterOriginList(['https://workspace.example.test']), ['https://workspace.example.test']);
    for (const origin of [
        'http://pgx:80', 'https://pgx:443', 'http://PGX:3000', 'http://pgx:3000/', 'http://pgx:3000/path',
        'http://pgx:3000?x=1', 'http://pgx:3000#x', 'http://user:pass@pgx:3000', 'http://0.0.0.0:3000',
        'http://0.1.2.3:3000', 'http://[::1]:3000', 'http://*.example.test', 'null', 'file:///etc/passwd',
        'ws://pgx:3000', 'http://1.2.3.256:3000', 'http://pgx.:3000', ' http://pgx:3000', 42,
    ]) {
        assert.equal(isCanonicalRouterOrigin(origin), false, String(origin));
        assert.throws(() => parseRouterOriginList([origin]), { code: 'ROUTER_ORIGINS_INVALID' }, String(origin));
    }
    assert.throws(() => parseRouterOriginList(['http://pgx:3000', 'http://100.73.151.25:3000']), /sorted/);
    assert.throws(() => parseRouterOriginList(['http://pgx:3000', 'http://pgx:3000']), /duplicate-free/);
    assert.throws(() => parseRouterOriginList('http://pgx:3000'), { code: 'ROUTER_ORIGINS_INVALID' });
    const tooMany = Array.from({ length: 65 }, (_, index) => `http://h${String(index).padStart(2, '0')}.example.test`);
    assert.throws(() => parseRouterOriginList(tooMany), /at most 64/);
    // eslint-disable-next-line no-sparse-arrays
    assert.throws(() => parseRouterOriginList([, 'http://pgx:3000']), { code: 'ROUTER_ORIGINS_INVALID' });
});

test('topology readers reject a missing or malformed Router origin list', (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-router-origins-topology-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    const topologyDir = path.join(workspace, '.ploinky', 'run', 'edge-topology');
    fs.mkdirSync(topologyDir, { recursive: true });
    const file = path.join(topologyDir, 'current.json');
    const base = {
        configurationGeneration: `sha256:${'1'.repeat(64)}`,
        authorizationGeneration: `sha256:${'2'.repeat(64)}`,
        publicationGeneration: 3,
        state: 'ready',
    };
    const write = (value) => fs.writeFileSync(file, JSON.stringify(value));

    write(base);
    assert.throws(() => readEdgeTopology({ file }), /invalid routerOrigins/);
    assert.throws(() => readCurrentEdgeTopology({ workspaceRoot: workspace }), { code: 'EDGE_TOPOLOGY_INVALID' });

    for (const routerOrigins of [[], ['http://100.73.151.25:3000', 'http://pgx:3000']]) {
        write({ ...base, routerOrigins });
        assert.deepEqual(readEdgeTopology({ file }).routerOrigins, routerOrigins);
        assert.deepEqual(readCurrentEdgeTopology({ workspaceRoot: workspace }).routerOrigins, routerOrigins);
    }
    for (const routerOrigins of [null, 'http://pgx:3000', ['http://pgx:3000/'], ['http://pgx:3000', 'http://100.73.151.25:3000'], [{}]]) {
        write({ ...base, routerOrigins });
        assert.throws(() => readEdgeTopology({ file }), /invalid routerOrigins/, JSON.stringify(routerOrigins));
        assert.throws(() => readCurrentEdgeTopology({ workspaceRoot: workspace }), { code: 'EDGE_TOPOLOGY_INVALID' });
    }
});
