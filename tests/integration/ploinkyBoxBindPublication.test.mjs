import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { buildImageSelection } from '../../agentlib/source.mjs';
import { BOX_LABELS, BOX_MEDIA_PORT, BOX_USERNS } from '../../ploinky-box/constants.mjs';
import { validateContainerConfiguration } from '../../ploinky-box/contract/container.mjs';
import { normalizeImageId } from '../../ploinky-box/contract/image-id.mjs';
import { discoverBoxOwnership } from '../../ploinky-box/engine/discovery.mjs';
import { selectHostReachableIpv4 } from '../../ploinky-box/hostNetwork.mjs';
import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import { probeImageAgentLib } from '../../ploinky-box/image-agentlib.mjs';
import { reconcileBoxContainer } from '../../ploinky-box/lifecycle/transactions.mjs';
import { createMutationLockManager } from '../../ploinky-box/locks.mjs';
import { createProcessRunner } from '../../ploinky-box/process.mjs';
import {
    assertRouterBindingAssignable,
    createRouterBindingStore,
    deriveRouterBindingHosts,
    parseRouterBindingMapping,
} from '../../ploinky-box/routerBinding.mjs';
import { inspectWorkspaceDataPaths } from '../../ploinky-box/workspace-data.mjs';

// Opt in with an immutable ID already present in native rootless Podman:
// PLOINKY_BIND_PUBLICATION_TEST_IMAGE=sha256:... node --test <this file>
// This exercises real Box reconciliation and publication with a tiny HTTP/UDP
// fixture. It does not start an agent graph or claim full Router/Explorer E2E.
const imageInput = process.env.PLOINKY_BIND_PUBLICATION_TEST_IMAGE;
const repositoryRoot = path.resolve(import.meta.dirname, '../..');

async function unusedTcpPort() {
    const socket = net.createServer();
    await new Promise((resolve, reject) => {
        socket.once('error', reject);
        socket.listen({ host: '0.0.0.0', port: 0 }, resolve);
    });
    const { port } = socket.address();
    await new Promise((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
    return port;
}

async function unusedUdpPort() {
    const socket = dgram.createSocket('udp4');
    await new Promise((resolve, reject) => {
        socket.once('error', reject);
        socket.bind(0, '0.0.0.0', resolve);
    });
    const { port } = socket.address();
    await new Promise((resolve) => socket.close(resolve));
    return port;
}

function request(hostname, port, hostHeader = `${hostname}:${port}`) {
    return new Promise((resolve, reject) => {
        const outgoing = http.get({ hostname, port, path: '/', headers: { Host: hostHeader }, agent: false }, (response) => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => { body += chunk; });
            response.on('end', () => resolve({ status: response.statusCode, body }));
        });
        outgoing.setTimeout(1500, () => outgoing.destroy(new Error('Fixture HTTP request timed out')));
        outgoing.on('error', reject);
    });
}

async function waitForHttp(hostname, port, token) {
    const deadline = Date.now() + 10_000;
    let failure;
    do {
        try {
            assert.deepEqual(await request(hostname, port), { status: 200, body: token });
            return;
        } catch (error) {
            failure = error;
        }
        await delay(100);
    } while (Date.now() < deadline);
    throw failure;
}

function udpRoundTrip(hostname, port, token) {
    return new Promise((resolve, reject) => {
        const socket = dgram.createSocket('udp4');
        const timer = setTimeout(() => finish(new Error('Fixture UDP response timed out')), 3000);
        function finish(error, message) {
            clearTimeout(timer);
            socket.close();
            if (error) reject(error);
            else resolve(String(message));
        }
        socket.once('error', finish);
        socket.once('message', (message) => finish(null, message));
        socket.send(token, port, hostname);
    });
}

function fixtureServer(token) {
    return [
        "import http from 'node:http';",
        "import dgram from 'node:dgram';",
        "import { normalizeExactHost } from '/opt/ploinky/cli/server/edgeRoutePlan.js';",
        "import { isTrustedPublicRouterHost } from '/opt/ploinky/cli/utils/publicRouterHosts.mjs';",
        `const token = ${JSON.stringify(token)};`,
        'http.createServer((request, response) => {',
        '    const host = normalizeExactHost(request.headers.host);',
        "    const admitted = host === '127.0.0.1' || host === 'localhost' || isTrustedPublicRouterHost(host);",
        '    response.statusCode = admitted ? 200 : 421;',
        "    response.end(admitted ? token : 'UNKNOWN_HOST');",
        "}).listen(8080, '0.0.0.0');",
        "const media = dgram.createSocket('udp4');",
        "media.on('message', (message, remote) => {",
        '    if (String(message) === token) media.send(token, remote.port, remote.address);',
        '});',
        `media.bind(${BOX_MEDIA_PORT}, '0.0.0.0');`,
        '',
    ].join('\n');
}

test('native Box Router publications preserve the public-only boundary across bind changes', {
    skip: !imageInput,
    timeout: 180_000,
}, async (t) => {
    assert.equal(process.platform, 'linux', 'this publication test requires native Linux rootless Podman');
    assert.match(imageInput, /^(?:sha256:)?[a-f0-9]{64}$/, 'select an existing immutable local Box image ID');
    const imageId = normalizeImageId(imageInput);
    const address = selectHostReachableIpv4();
    assert.ok(address, 'this publication test requires an assigned non-loopback host IPv4 address');
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-bind-publication-')));
    const workspace = path.join(root, 'workspace');
    const stateHome = path.join(root, 'host-state');
    fs.mkdirSync(path.join(workspace, '.ploinky'), { recursive: true });
    fs.mkdirSync(stateHome, { mode: 0o700 });
    const token = crypto.randomUUID();
    fs.writeFileSync(path.join(workspace, 'bind-publication-fixture.mjs'), fixtureServer(token), { mode: 0o600 });
    const identity = buildWorkspaceIdentity(workspace, { markerFound: true });
    const store = createRouterBindingStore({ homeDirectory: stateHome });
    const native = createProcessRunner();
    const createdIds = new Set();
    const guardedArgs = (args) => {
        assert.notEqual(args[0], 'pull', 'publication integration must never pull an image');
        if (args[0] === 'run' || (args[0] === 'container' && args[1] === 'create')) {
            return [...args.slice(0, args[0] === 'run' ? 1 : 2), '--pull=never', ...args.slice(args[0] === 'run' ? 1 : 2)];
        }
        return args;
    };
    const runner = {
        query(command, args, options) { return native.query(command, guardedArgs(args), options); },
        run(command, args, options) {
            const result = native.run(command, guardedArgs(args), options);
            if (args[0] === 'container' && args[1] === 'create') {
                const id = String(result).trim();
                assert.match(id, /^[a-f0-9]{64}$/);
                createdIds.add(id);
            }
            return result;
        },
    };
    let lock;
    let engine;
    t.after(() => {
        try {
            const remaining = discoverBoxOwnership(identity, { runner });
            assert.ok(['absent', 'owned'].includes(remaining.state), remaining.message);
            if (engine) assert.equal(remaining.engine.identity, engine.identity, 'cleanup engine identity must match');
            if (remaining.state === 'owned') {
                const handle = remaining.handles.container;
                assert.ok(createdIds.has(handle.id), 'cleanup may remove only a captured fixture container ID');
                const record = JSON.parse(String(runner.run('podman', ['container', 'inspect', handle.id])))[0];
                assert.equal(record.Id, handle.id);
                assert.equal(record.Name.replace(/^\//, ''), identity.instance);
                assert.equal(record.Config.Labels[BOX_LABELS.pathHash], identity.pathHash);
                assert.equal(normalizeImageId(record.Image), imageId);
                assert.ok(record.Mounts.some((mount) => mount.Source === workspace && mount.Destination === workspace));
                runner.run('podman', ['container', 'rm', '--force', '--time', '0', handle.id]);
            }
            assert.equal(discoverBoxOwnership(identity, { runner }).state, 'absent');
            lock?.release();
            lock = null;
            fs.rmSync(root, { recursive: true });
            t.diagnostic(`Fixture cleanup verified: ${identity.instance}; workspace removed`);
        } finally {
            lock?.release();
        }
    });
    const initial = discoverBoxOwnership(identity, { runner });
    assert.equal(initial.state, 'absent', initial.message);
    engine = initial.engine;
    assert.equal(engine.hostKind, 'native-linux');
    lock = await createMutationLockManager({ homeDirectory: stateHome }).acquire(identity.instance);
    const imageBundle = probeImageAgentLib(engine.name, imageId, runner);
    const agentLib = buildImageSelection({ workspaceRoot: workspace, imageBundle });
    const hostPort = await unusedTcpPort();
    const mediaHostPort = await unusedUdpPort();
    let previousId = null;
    for (const mapping of [null, `0:${hostPort}:8080`, `${address}:${hostPort}:8080`, `127.0.0.1:${hostPort}:8080`]) {
        const parsed = mapping ? assertRouterBindingAssignable(parseRouterBindingMapping(mapping)) : null;
        const binding = parsed ? { ...parsed, hosts: deriveRouterBindingHosts(parsed) } : null;
        const result = await reconcileBoxContainer({
            identity, ownership: discoverBoxOwnership(identity, { runner }), engine, runner, lock,
            repositoryRoot, agentLib, explicitPort: hostPort, explicitMediaPort: mediaHostPort,
            routerBinding: binding, imageRef: imageId, imagePolicy: 'preserve',
        });
        const handle = result.ownership.handles.container;
        assert.notEqual(handle.id, previousId, 'each address change must replace the outer Box');
        previousId = handle.id;
        const selected = result.routerBinding;
        const publication = validateContainerConfiguration(handle, {
            identity, agentLib, hostPort, mediaHostPort, routerBinding: selected, imageId: handle.runtime.imageId,
            imageRef: imageId, repositoryRoot, dataFingerprints: inspectWorkspaceDataPaths({ identity }).fingerprints,
        });
        assert.equal(normalizeImageId(handle.runtime.imageId), imageId);
        assert.equal(handle.runtime.publications.length, 2);
        assert.deepEqual(publication.tcp, { containerPort: '8080', protocol: 'tcp', hostIp: selected.address, hostPort: String(hostPort) });
        assert.deepEqual(publication.udp, { containerPort: '7882', protocol: 'udp', hostIp: '0.0.0.0', hostPort: String(mediaHostPort) });
        assert.equal(handle.runtime.user, 'podman');
        assert.equal(handle.runtime.privileged, false);
        assert.equal(handle.runtime.init, true);
        assert.ok(handle.runtime.createCommand.includes(BOX_USERNS));
        assert.equal(handle.runtime.mounts.find((mount) => mount.destination === '/opt/ploinky').rw, false);
        runner.run('podman', [
            'container', 'exec', '--detach', '--user', 'podman', '--workdir', identity.workspaceRoot, handle.id,
            '/usr/local/bin/node', path.join(identity.workspaceRoot, 'bind-publication-fixture.mjs'),
        ]);
        const connectAddress = selected.address === '0.0.0.0' ? address : selected.address;
        await waitForHttp(connectAddress, hostPort, token);
        assert.deepEqual(await request(connectAddress, hostPort, `foreign.invalid:${hostPort}`), { status: 421, body: 'UNKNOWN_HOST' });
        assert.equal(await udpRoundTrip(address, mediaHostPort, token), token);
        if (selected.address === '127.0.0.1') {
            await assert.rejects(() => request(address, hostPort), 'loopback must not accept a connection through the host LAN address');
        } else if (selected.address === address) {
            await assert.rejects(() => request('127.0.0.1', hostPort), 'a specific LAN publication must not listen on loopback');
        } else {
            assert.deepEqual(await request('127.0.0.1', hostPort), { status: 200, body: token });
            assert.deepEqual(await request('localhost', hostPort), { status: 200, body: token });
            if (engine.rootlessNetworkCmd === 'pasta') {
                assert.ok(handle.runtime.createCommand.includes('pasta:--ipv4-only'));
                // A dual-stack pasta socket can accept ::1 and then reset the
                // HTTP stream, preventing browser localhost fallback to IPv4.
                await assert.rejects(() => new Promise((resolve, reject) => {
                    const socket = net.createConnection({ host: '::1', port: hostPort });
                    socket.once('connect', () => { socket.destroy(); resolve(); });
                    socket.once('error', reject);
                    socket.setTimeout(1500, () => socket.destroy(new Error('IPv6 listener probe timed out')));
                }), { code: 'ECONNREFUSED' });
            }
        }
        result.finalize();
        if (binding) {
            store.write(identity, binding, lock);
            assert.deepEqual(store.read(identity), parsed);
        } else {
            assert.equal(store.read(identity), null);
        }
        t.diagnostic(`Verified ${selected.address}:${hostPort}:8080/tcp + 0.0.0.0:${mediaHostPort}:7882/udp; container ${handle.id}`);
    }
    assert.equal(createdIds.size, 4, 'all four publication generations used distinct real containers');
    t.diagnostic(`Immutable Box image ${imageId}; non-loopback HTTP and UDP checked through ${address}`);
});
