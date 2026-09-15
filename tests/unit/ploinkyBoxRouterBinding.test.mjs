import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import {
    assertRouterBindingAssignable,
    assertRouterBindingStateConfined,
    createRouterBindingStore,
    deriveRouterBindingHosts,
    describeRouterBinding,
    normalizeRouterPublication,
    parseRouterBindingMapping,
    routerBindingBrowserUrls,
    routerBindingProbeTargets,
    routerBindingPublicAuthority,
    sameRouterBinding,
} from '../../ploinky-box/routerBinding.mjs';
import { containerCreateArgs } from '../../ploinky-box/lifecycle/container.mjs';
import { validateContainerConfiguration } from '../../ploinky-box/contract/container.mjs';

const INTERFACES = Object.freeze({
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    wlp0s20f3: [
        { address: '192.168.1.63', family: 'IPv4', internal: false },
        { address: 'fe80::1', family: 'IPv6', internal: false },
    ],
    tailscale0: [{ address: '100.76.22.69', family: 'IPv4', internal: false }],
    podman0: [{ address: '10.88.0.1', family: 'IPv4', internal: false }],
    docker0: [{ address: '172.17.0.1', family: 'IPv4', internal: false }],
});

function binding(address, hostPort) {
    return { address, hostPort, containerPort: 8080 };
}

test('bind mappings accept the documented address and port forms', () => {
    assert.deepEqual(parseRouterBindingMapping('0:8083:8080'), binding('0.0.0.0', 8083));
    assert.deepEqual(parseRouterBindingMapping('0.0.0.0:8083:8080'), binding('0.0.0.0', 8083));
    assert.deepEqual(parseRouterBindingMapping('192.168.1.50:8083:8080'), binding('192.168.1.50', 8083));
    assert.deepEqual(parseRouterBindingMapping('127.0.0.1:8083:8080'), binding('127.0.0.1', 8083));
    // 8081 is valid as a physical-host port; only the in-Box target is fixed.
    assert.deepEqual(parseRouterBindingMapping('0:8081:8080'), binding('0.0.0.0', 8081));
    assert.deepEqual(parseRouterBindingMapping('0:1:8080'), binding('0.0.0.0', 1));
    assert.deepEqual(parseRouterBindingMapping('0:65535:8080'), binding('0.0.0.0', 65535));
});

test('bind mappings name the invalid field and never target private or agent ports', () => {
    for (const [value, pattern] of [
        ['', /must be BIND_ADDRESS:HOST_TCP_PORT:IN_BOX_ROUTER_PORT/],
        ['0:8083', /exactly three fields/],
        ['0:8083:8080:1', /exactly three fields/],
        ['::1:8083:8080', /exactly three fields.*IPv6/],
        ['localhost:8083:8080', /BIND_ADDRESS.*host names are not resolved/],
        ['192.168.001.50:8083:8080', /BIND_ADDRESS/],
        ['192.168.1:8083:8080', /BIND_ADDRESS/],
        ['256.1.1.1:8083:8080', /BIND_ADDRESS/],
        [' 0:8083:8080', /BIND_ADDRESS/],
        ['127.0.0.2:8083:8080', /cannot publish the Router/],
        ['169.254.1.1:8083:8080', /cannot publish the Router/],
        ['224.0.0.1:8083:8080', /cannot publish the Router/],
        ['0:0:8080', /HOST_TCP_PORT/],
        ['0:65536:8080', /HOST_TCP_PORT/],
        ['0:08083:8080', /HOST_TCP_PORT/],
        ['0::8080', /HOST_TCP_PORT/],
        ['0:port:8080', /HOST_TCP_PORT/],
        ['0:8083:8081', /IN_BOX_ROUTER_PORT must be 8080.*8081 is the private Router listener/],
        ['0:8083:7000', /IN_BOX_ROUTER_PORT must be 8080.*agent and service ports/],
        ['0:8083:80', /IN_BOX_ROUTER_PORT must be 8080/],
        ['0:8083:08080', /IN_BOX_ROUTER_PORT/],
        ['0:8083:', /IN_BOX_ROUTER_PORT/],
    ]) {
        assert.throws(
            () => parseRouterBindingMapping(value),
            (error) => error.code === 'PLOINKY_BOX_BIND_INVALID' && pattern.test(error.message),
            JSON.stringify(value),
        );
    }
});

test('a specific bind address must be assigned to this physical host', () => {
    assert.equal(
        assertRouterBindingAssignable({ address: '192.168.1.63', hostPort: 8083 }, { interfaces: INTERFACES }).address,
        '192.168.1.63',
    );
    for (const address of ['0.0.0.0', '127.0.0.1']) {
        assert.equal(assertRouterBindingAssignable({ address, hostPort: 8083 }, { interfaces: {} }).address, address);
    }
    assert.throws(
        () => assertRouterBindingAssignable({ address: '192.168.1.50', hostPort: 8083 }, { interfaces: INTERFACES }),
        (error) => error.code === 'PLOINKY_BOX_BIND_ADDRESS_UNASSIGNED'
            && /not assigned.*not the browser machine/.test(error.message),
    );
    // An address listed only on loopback-internal entries is not a host interface.
    assert.throws(
        () => assertRouterBindingAssignable({ address: '192.168.1.63', hostPort: 8083 }, {
            interfaces: { lo: [{ address: '192.168.1.63', family: 'IPv4', internal: true }] },
        }),
        { code: 'PLOINKY_BOX_BIND_ADDRESS_UNASSIGNED' },
    );
});

test('trusted outer hosts come from host interfaces and names, never container bridges', () => {
    assert.equal(deriveRouterBindingHosts(
        { address: '127.0.0.1', hostPort: 8080 },
        { interfaces: INTERFACES, hostname: 'apparatus' },
    ), null);
    assert.deepEqual(deriveRouterBindingHosts(
        { address: '0.0.0.0', hostPort: 8083 },
        { interfaces: INTERFACES, hostname: 'Apparatus' },
    ), ['100.76.22.69', '192.168.1.63', 'apparatus', 'apparatus.local']);
    assert.deepEqual(deriveRouterBindingHosts(
        { address: '192.168.1.63', hostPort: 8083 },
        { interfaces: INTERFACES, hostname: 'pgx01.lab.example.test' },
    ), ['192.168.1.63', 'pgx01', 'pgx01.lab.example.test', 'pgx01.local']);
    for (const hostname of ['localhost', 'localhost.localdomain', '', 'bad_name', '192.168.1.63']) {
        assert.deepEqual(deriveRouterBindingHosts(
            { address: '0.0.0.0', hostPort: 8083 },
            { interfaces: {}, hostname },
        ), [], hostname);
    }
    const crowded = Object.fromEntries(Array.from({ length: 70 }, (_, index) => [
        `eth${index}`, [{ address: `10.0.${Math.floor(index / 250)}.${(index % 250) + 1}`, family: 'IPv4', internal: false }],
    ]));
    assert.throws(
        () => deriveRouterBindingHosts({ address: '0.0.0.0', hostPort: 8083 }, { interfaces: crowded, hostname: 'x' }),
        /bind one specific IPv4 address instead/,
    );
});

test('probe targets, authorities, and browser URLs never use the wildcard as a destination', () => {
    const wildcard = { address: '0.0.0.0', hostPort: 8083, hosts: ['192.168.1.63', 'apparatus'] };
    const specific = { address: '192.168.1.63', hostPort: 8083, hosts: ['192.168.1.63'] };
    const loopback = { address: '127.0.0.1', hostPort: 8081, hosts: null };
    assert.deepEqual(routerBindingProbeTargets(wildcard), [
        { hostname: '127.0.0.1', authority: '127.0.0.1:8083' },
        { hostname: '192.168.1.63', authority: '192.168.1.63:8083' },
    ]);
    assert.deepEqual(routerBindingProbeTargets(specific), [
        { hostname: '192.168.1.63', authority: '192.168.1.63:8083' },
    ]);
    assert.deepEqual(routerBindingProbeTargets(loopback), [
        { hostname: '127.0.0.1', authority: '127.0.0.1:8081' },
    ]);
    assert.deepEqual(routerBindingBrowserUrls(wildcard), ['http://192.168.1.63:8083/', 'http://127.0.0.1:8083/']);
    assert.deepEqual(routerBindingBrowserUrls(specific), ['http://192.168.1.63:8083/']);
    assert.equal(routerBindingPublicAuthority(wildcard), '127.0.0.1:8083');
    assert.equal(routerBindingPublicAuthority(specific), '192.168.1.63:8083');
    assert.equal(routerBindingPublicAuthority(loopback), '127.0.0.1:8081');
    assert.equal(describeRouterBinding(wildcard), '0.0.0.0:8083 -> public Router 8080/tcp');
    for (const value of [wildcard, specific, loopback]) {
        assert.equal(routerBindingBrowserUrls(value).some((url) => url.includes('0.0.0.0')), false);
        assert.equal(routerBindingProbeTargets(value).some((target) => target.hostname === '0.0.0.0'), false);
    }
});

test('a recorded publication carries exactly the trusted hosts its address requires', () => {
    assert.deepEqual(normalizeRouterPublication({ address: '127.0.0.1', hosts: null }), {
        address: '127.0.0.1',
        hosts: null,
    });
    assert.deepEqual(normalizeRouterPublication({ address: '0.0.0.0', hosts: ['apparatus', '192.168.1.63'] }), {
        address: '0.0.0.0',
        hosts: ['192.168.1.63', 'apparatus'],
    });
    assert.throws(() => normalizeRouterPublication({ address: '127.0.0.1', hosts: [] }), /loopback/);
    assert.throws(() => normalizeRouterPublication({ address: '0.0.0.0' }), /requires its trusted outer host list/);
    assert.throws(
        () => normalizeRouterPublication({ address: '192.168.1.63', hosts: ['apparatus'] }),
        /must trust its own address/,
    );
    assert.throws(() => normalizeRouterPublication({ address: '0.0.0.0', hosts: ['*'] }), /invalid or reserved host/);
    assert.equal(sameRouterBinding(
        { address: '0.0.0.0', hostPort: 8083, hosts: ['192.168.1.63'] },
        { address: '0.0.0.0', hostPort: 8083, hosts: ['192.168.1.63', 'apparatus'] },
    ), false);
    assert.equal(sameRouterBinding(
        { address: '0.0.0.0', hostPort: 8083, hosts: ['192.168.1.63'] },
        { address: '0.0.0.0', hostPort: 8083, hosts: ['192.168.1.63'] },
    ), true);
});

function storeFixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-router-binding-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const home = path.join(root, 'home');
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(home, { mode: 0o700 });
    fs.mkdirSync(path.join(workspace, '.ploinky'), { recursive: true });
    const identity = buildWorkspaceIdentity(workspace, { markerFound: true });
    const lock = { assertHeld(instance) { assert.equal(instance, identity.instance); } };
    return { root, home, identity, lock, store: createRouterBindingStore({ homeDirectory: home }) };
}

test('saved bindings round-trip privately and atomically for one exact workspace', (t) => {
    const state = storeFixture(t);
    assert.equal(state.store.read(state.identity), null);
    state.store.write(state.identity, { address: '0.0.0.0', hostPort: 8083 }, state.lock);
    const target = state.store.pathFor(state.identity);
    assert.equal(path.dirname(target), path.join(state.home, '.ploinky-box', 'router-bindings'));
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
    assert.equal(fs.statSync(state.store.directory).mode & 0o777, 0o700);
    assert.deepEqual(state.store.read(state.identity), binding('0.0.0.0', 8083));
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), {
        version: 1,
        instance: state.identity.instance,
        pathHash: state.identity.pathHash,
        workspaceRoot: state.identity.workspaceRoot,
        address: '0.0.0.0',
        hostPort: 8083,
        containerPort: 8080,
    });
    assert.deepEqual(fs.readdirSync(state.store.directory), [path.basename(target)]);

    const otherRoot = path.join(state.root, 'other');
    fs.mkdirSync(path.join(otherRoot, '.ploinky'), { recursive: true });
    assert.equal(state.store.read(buildWorkspaceIdentity(otherRoot, { markerFound: true })), null);

    state.store.write(state.identity, { address: '127.0.0.1', hostPort: 8083 }, state.lock);
    assert.deepEqual(state.store.read(state.identity), binding('127.0.0.1', 8083));
    state.store.restore(state.identity, null, state.lock);
    assert.equal(state.store.read(state.identity), null);
    assert.throws(
        () => state.store.write(state.identity, { address: '0.0.0.0', hostPort: 8083 }, null),
        /workspace mutation lock/,
    );
    assert.throws(
        () => state.store.write(state.identity, { address: '0.0.0.0', hostPort: 8083, containerPort: 8081 }, state.lock),
        /IN_BOX_ROUTER_PORT must be 8080/,
    );
});

test('saved bindings fail closed on unsafe modes, links, schemas, sizes, and foreign workspaces', (t) => {
    const state = storeFixture(t);
    state.store.write(state.identity, { address: '192.168.1.63', hostPort: 8083 }, state.lock);
    const target = state.store.pathFor(state.identity);
    const valid = JSON.parse(fs.readFileSync(target, 'utf8'));
    const rewrite = (content, mode = 0o600) => {
        fs.rmSync(target, { force: true });
        fs.writeFileSync(target, content, { mode });
        fs.chmodSync(target, mode);
    };
    const rejects = (pattern) => assert.throws(
        () => state.store.read(state.identity),
        (error) => error.code === 'PLOINKY_BOX_ROUTER_BINDING_STATE_INVALID' && pattern.test(error.message),
    );

    rewrite(JSON.stringify(valid), 0o640);
    rejects(/private to the current user/);
    rewrite('{not json');
    rejects(/not valid JSON/);
    rewrite(JSON.stringify({ ...valid, extra: true }));
    rejects(/unsupported schema/);
    rewrite(JSON.stringify({ ...valid, version: 2 }));
    rejects(/version/);
    rewrite(JSON.stringify({ ...valid, containerPort: 8081 }));
    rejects(/public Router port/);
    rewrite(JSON.stringify({ ...valid, pathHash: '0'.repeat(12) }));
    rejects(/belongs to another workspace/);
    rewrite(JSON.stringify({ ...valid, workspaceRoot: '/elsewhere' }));
    rejects(/belongs to another workspace/);
    rewrite(JSON.stringify({ ...valid, address: '192.168.1.063' }));
    rejects(/is invalid/);
    rewrite(JSON.stringify({ ...valid, hostPort: '8083' }));
    rejects(/is invalid/);
    rewrite(`${JSON.stringify(valid)}${' '.repeat(5000)}`);
    rejects(/exceeds 4096 bytes/);

    const decoy = path.join(state.root, 'decoy.json');
    fs.writeFileSync(decoy, JSON.stringify(valid), { mode: 0o600 });
    fs.rmSync(target, { force: true });
    fs.symlinkSync(decoy, target);
    rejects(/non-symlink/);
    assert.throws(
        () => state.store.write(state.identity, { address: '0.0.0.0', hostPort: 8083 }, state.lock),
        /non-regular Router binding state path/,
    );
    fs.rmSync(target, { force: true });
    fs.linkSync(decoy, target);
    rejects(/non-linked regular file/);
    fs.rmSync(target, { force: true });

    fs.chmodSync(state.store.directory, 0o777);
    rejects(/group- or world-writable/);
    fs.chmodSync(state.store.directory, 0o700);
    assert.equal(state.store.read(state.identity), null);
});

test('saved bindings are refused wherever the workspace could alias the state directory', (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-router-binding-home-workspace-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    fs.mkdirSync(path.join(workspace, '.ploinky'));
    const identity = buildWorkspaceIdentity(workspace, { markerFound: true });
    const lock = { assertHeld(instance) { assert.equal(instance, identity.instance); } };
    // The home directory is the workspace, so agents could write the record.
    const store = createRouterBindingStore({ homeDirectory: workspace });
    assert.throws(
        () => store.write(identity, { address: '0.0.0.0', hostPort: 8083 }, lock),
        /overlaps writable Box source .*agents can write it/,
    );
    assert.throws(() => store.read(identity), /overlaps writable Box source/);
    assert.equal(fs.existsSync(path.join(workspace, '.ploinky-box')), false);

    fs.mkdirSync(store.directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(store.directory), 0o700);
    fs.writeFileSync(store.pathFor(identity), JSON.stringify({
        version: 1,
        instance: identity.instance,
        pathHash: identity.pathHash,
        workspaceRoot: identity.workspaceRoot,
        address: '0.0.0.0',
        hostPort: 8083,
        containerPort: 8080,
    }), { mode: 0o600 });
    assert.throws(() => store.read(identity), /overlaps writable Box source/);
});

test('saved bindings reject writable cache aliases before reading or creating state', (t) => {
    const state = storeFixture(t);
    fs.mkdirSync(state.identity.boxDataRoot);
    for (const key of ['dependencies', 'images']) {
        for (const destination of [state.home, path.dirname(state.store.directory), state.store.directory]) {
            // The latter two targets do not exist yet. A later first bind must
            // not materialize host authority under an existing cache alias.
            fs.symlinkSync(destination, state.identity.dataPaths[key]);
            assert.throws(() => state.store.read(state.identity), /overlaps writable Box source/);
            assert.throws(
                () => state.store.write(state.identity, { address: '0.0.0.0', hostPort: 8083 }, state.lock),
                /overlaps writable Box source/,
            );
            assert.equal(fs.existsSync(state.store.directory), false);
            fs.unlinkSync(state.identity.dataPaths[key]);
        }
    }
    state.store.write(state.identity, { address: '127.0.0.1', hostPort: 8083 }, state.lock);
    const before = fs.readFileSync(state.store.pathFor(state.identity));
    fs.symlinkSync(state.store.directory, state.identity.dataPaths.images);
    assert.throws(() => state.store.read(state.identity), /overlaps writable Box source/);
    assert.throws(
        () => state.store.write(state.identity, { address: '0.0.0.0', hostPort: 8083 }, state.lock),
        /overlaps writable Box source/,
    );
    assert.deepEqual(fs.readFileSync(state.store.pathFor(state.identity)), before);
});

test('host-state confinement resolves aliases through workspace cache parents', (t) => {
    const state = storeFixture(t);
    fs.mkdirSync(state.identity.boxDataRoot);
    fs.symlinkSync(state.store.directory, state.identity.dataPaths.images);
    const external = path.join(state.root, 'external-state');
    fs.renameSync(state.identity.anchorPath, external);
    fs.symlinkSync(external, state.identity.anchorPath);
    assert.throws(() => state.store.read(state.identity), /overlaps writable Box source/);
});

test('host-state confinement detects directory inode aliases as well as symlinks', (t) => {
    const state = storeFixture(t);
    state.store.write(state.identity, { address: '127.0.0.1', hostPort: 8083 }, state.lock);
    fs.mkdirSync(state.identity.dataPaths.images, { recursive: true });
    const stat = fs.statSync(state.store.directory);
    // A bind mount retains its distinct realpath but exposes the same device
    // and inode. Model that kernel observation without requiring mount rights.
    const fsApi = {
        ...fs,
        statSync(target) {
            return target === state.identity.dataPaths.images ? stat : fs.statSync(target);
        },
    };
    assert.throws(
        () => assertRouterBindingStateConfined(state.identity, { homeDirectory: state.home, fsApi }),
        /overlaps writable Box source/,
    );
});

test('Box creation and existing-container admission enforce host-state confinement', (t) => {
    const state = storeFixture(t);
    fs.mkdirSync(state.identity.boxDataRoot);
    fs.symlinkSync(path.join(os.homedir(), '.ploinky-box'), state.identity.dataPaths.images);
    // Both entry points reject before consulting image or runtime metadata.
    assert.throws(() => containerCreateArgs({ identity: state.identity }), /overlaps writable Box source/);
    assert.throws(
        () => validateContainerConfiguration(null, { identity: state.identity }),
        /overlaps writable Box source/,
    );
});
