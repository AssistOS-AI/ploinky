import assert from 'node:assert/strict';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { BOX_LABELS } from '../../ploinky-box/constants.mjs';
import { normalizeContainerRuntime } from '../../ploinky-box/contract/container.mjs';
import {
    preflightPublications,
    probeTcpAvailability,
    recheckReleasedPublications,
    resolveEffectiveHostPort,
} from '../../ploinky-box/ports.mjs';

function owned(port = 19090, {
    running = true,
    publications,
    authority,
    labelPort,
    mediaPort = 17891,
    mediaLabelPort,
} = {}) {
    return {
        state: 'owned',
        handles: {
            container: {
                labels: {
                    [BOX_LABELS.routerHostPort]: String(labelPort ?? port),
                    [BOX_LABELS.mediaHostPort]: String(mediaLabelPort ?? mediaPort),
                },
                runtime: {
                    complete: true,
                    running,
                    environment: { PLOINKY_PUBLIC_AUTHORITY: authority ?? `127.0.0.1:${port}` },
                    publications: publications ?? [
                        { containerPort: '7882', protocol: 'udp', hostIp: '0.0.0.0', hostPort: String(mediaPort) },
                        { containerPort: '8080', protocol: 'tcp', hostIp: '127.0.0.1', hostPort: String(port) },
                    ],
                },
            },
        },
    };
}

// A Box recorded by `ploinky bind`: every metadata field can be varied to
// prove that label, trusted hosts, authority, and publication agree.
function bound(port, options = {}) {
    const {
        address,
        hosts,
        authority,
        running = true,
        mediaPort = 17891,
        publications,
    } = options;
    // An explicit undefined label models a Box that never recorded one.
    const labelAddress = Object.hasOwn(options, 'labelAddress') ? options.labelAddress : address;
    return {
        state: 'owned',
        handles: {
            container: {
                labels: {
                    [BOX_LABELS.routerHostPort]: String(port),
                    [BOX_LABELS.mediaHostPort]: String(mediaPort),
                    ...(labelAddress === undefined ? {} : { [BOX_LABELS.routerBindAddress]: labelAddress }),
                },
                runtime: {
                    complete: true,
                    running,
                    environment: {
                        PLOINKY_PUBLIC_AUTHORITY: authority
                            ?? `${address === '0.0.0.0' ? '127.0.0.1' : address}:${port}`,
                        ...(hosts === undefined ? {} : { PLOINKY_PUBLIC_ROUTER_HOSTS: hosts }),
                    },
                    publications: publications ?? [
                        { containerPort: '7882', protocol: 'udp', hostIp: '0.0.0.0', hostPort: String(mediaPort) },
                        { containerPort: '8080', protocol: 'tcp', hostIp: address, hostPort: String(port) },
                    ],
                },
            },
        },
    };
}

test('port selection honors explicit, existing, then default precedence', () => {
    assert.deepEqual(resolveEffectiveHostPort({
        explicitPort: '20000',
        explicitMediaPort: '20001',
        ownership: { state: 'absent' },
    }), {
        hostPort: 20000,
        mediaHostPort: 20001,
        address: '127.0.0.1',
        hosts: null,
        source: 'explicit',
        existingPublication: null,
    });
    const existing = resolveEffectiveHostPort({ ownership: owned(19090) });
    assert.equal(existing.hostPort, 19090);
    assert.equal(existing.mediaHostPort, 17891);
    const defaults = resolveEffectiveHostPort({ ownership: { state: 'absent' } });
    assert.equal(defaults.hostPort, 8080);
    assert.equal(defaults.mediaHostPort, 7882);
    const mediaOnly = resolveEffectiveHostPort({
        explicitMediaPort: 20002,
        ownership: owned(19090),
    });
    assert.equal(mediaOnly.hostPort, 19090);
    assert.equal(mediaOnly.mediaHostPort, 20002);
});

test('existing label, publication, and authority must agree exactly', () => {
    assert.throws(() => resolveEffectiveHostPort({ ownership: owned(19090, { labelPort: 19091 }) }), /publication/);
    assert.throws(() => resolveEffectiveHostPort({ ownership: owned(19090, { authority: '127.0.0.1:8080' }) }), /authority/);
    assert.throws(() => resolveEffectiveHostPort({ ownership: owned(19090, { mediaLabelPort: 17892 }) }), /publication/);
    assert.throws(() => resolveEffectiveHostPort({ ownership: owned(19090, {
        publications: [
            { containerPort: '7882', protocol: 'udp', hostIp: '0.0.0.0', hostPort: '7882' },
            { containerPort: '8080', protocol: 'tcp', hostIp: '0.0.0.0', hostPort: '19090' },
        ],
    }) }), /publications/);
    assert.throws(() => resolveEffectiveHostPort({ ownership: owned(19090, {
        publications: [
            { containerPort: '7882', protocol: 'udp', hostIp: '0.0.0.0', hostPort: '7883' },
            { containerPort: '8080', protocol: 'tcp', hostIp: '127.0.0.1', hostPort: '19090' },
        ],
    }) }), /publications/);
});

test('publication mismatch reports the normalized observed and expected bindings', () => {
    const mismatched = owned(19090, {
        publications: [
            { containerPort: '7882', protocol: 'udp', hostIp: '', hostPort: '7882' },
            { containerPort: '8080', protocol: 'tcp', hostIp: '127.0.0.1', hostPort: '19090' },
        ],
    });

    assert.throws(
        () => resolveEffectiveHostPort({ ownership: mismatched }),
        (error) => {
            assert.match(error.message, /observed=.*\"hostIp\":\"\"/);
            assert.match(error.message, /expected=.*\"hostIp\":\"0\.0\.0\.0\"/);
            return true;
        },
    );
});

test('Podman empty HostIp inspection normalizes to an explicit wildcard', () => {
    const runtime = normalizeContainerRuntime({
        Config: { Env: [] },
        HostConfig: {
            PortBindings: {
                '7882/udp': [{ HostIp: '', HostPort: '7882' }],
                '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '19090' }],
            },
        },
        State: { Running: true },
    });

    assert.deepEqual(runtime.publications, [
        { containerPort: '7882', protocol: 'udp', hostIp: '0.0.0.0', hostPort: '7882' },
        { containerPort: '8080', protocol: 'tcp', hostIp: '127.0.0.1', hostPort: '19090' },
    ]);
});

test('preflight reports conflicts before a caller can perform engine mutation', async () => {
    const calls = [];
    await assert.rejects(() => preflightPublications({
        hostPort: 19090,
        checkTcp: async () => { calls.push('tcp'); return false; },
        checkUdp: async () => { calls.push('udp'); return true; },
    }), /TCP/);
    assert.deepEqual(calls, ['tcp', 'udp']);

    await assert.rejects(() => preflightPublications({
        hostPort: 19090,
        checkTcp: async () => true,
        checkUdp: async () => false,
    }), /UDP/);
});

test('only a validated running current Box receives the self-reservation exception', async () => {
    const existingPublication = resolveEffectiveHostPort({ ownership: owned(19090) }).existingPublication;
    const result = await preflightPublications({
        hostPort: 19090,
        mediaHostPort: 17891,
        existingPublication,
        checkTcp: async () => false,
        checkUdp: async () => false,
    });
    assert.equal(result.reusedSelfReservation, true);
    assert.equal(result.tcp, '127.0.0.1:19090:8080/tcp');
    assert.equal(result.udp, '0.0.0.0:17891:7882/udp');

    await assert.rejects(() => preflightPublications({
        hostPort: 19090,
        mediaHostPort: 17891,
        existingPublication: { ...existingPublication, running: false },
        checkTcp: async () => false,
        checkUdp: async () => false,
    }), /TCP/);

    await assert.rejects(() => preflightPublications({
        hostPort: 19091,
        mediaHostPort: 17892,
        existingPublication,
        checkTcp: async () => true,
        checkUdp: async () => false,
    }), /UDP.*17892/);

    const udpOnlyReuse = await preflightPublications({
        hostPort: 19091,
        mediaHostPort: 17891,
        existingPublication,
        checkTcp: async () => true,
        checkUdp: async () => false,
    });
    assert.equal(udpOnlyReuse.reusedSelfReservation, true);
});

test('legacy loopback Boxes without bind metadata remain loopback publications', () => {
    const plan = resolveEffectiveHostPort({ ownership: owned(19090) });
    assert.equal(plan.source, 'existing');
    assert.equal(plan.address, '127.0.0.1');
    assert.equal(plan.hosts, null);
    assert.equal(plan.existingPublication.address, '127.0.0.1');
    assert.equal(plan.existingPublication.hosts, null);
});

test('non-loopback publications require an exact label, trusted host list, and authority', () => {
    const wildcard = resolveEffectiveHostPort({
        ownership: bound(19090, { address: '0.0.0.0', hosts: '["192.168.1.63","apparatus"]' }),
    });
    assert.equal(wildcard.address, '0.0.0.0');
    assert.deepEqual(wildcard.hosts, ['192.168.1.63', 'apparatus']);
    assert.equal(wildcard.existingPublication.tcp.hostIp, '0.0.0.0');
    const specific = resolveEffectiveHostPort({
        ownership: bound(19090, { address: '192.168.1.63', hosts: '["192.168.1.63"]' }),
    });
    assert.equal(specific.address, '192.168.1.63');
    assert.deepEqual(specific.hosts, ['192.168.1.63']);

    const udp = { containerPort: '7882', protocol: 'udp', hostIp: '0.0.0.0', hostPort: '17891' };
    for (const [name, ownership, pattern] of [
        ['wildcard publication without a label', bound(19090, {
            address: '0.0.0.0', labelAddress: undefined, authority: '127.0.0.1:19090',
        }), /publications/],
        ['trusted hosts without a label', bound(19090, {
            address: '127.0.0.1', labelAddress: undefined, hosts: '["192.168.1.63"]',
        }), /without a Router bind address label/],
        ['labelled loopback', bound(19090, {
            address: '127.0.0.1', hosts: '[]',
        }), /must remain unlabelled/],
        ['label without trusted hosts', bound(19090, { address: '0.0.0.0' }), /no trusted outer host list/],
        ['non-canonical trusted hosts', bound(19090, {
            address: '0.0.0.0', hosts: '["apparatus","192.168.1.63"]',
        }), /trusted outer Router hosts are invalid/],
        ['specific address not trusted', bound(19090, {
            address: '192.168.1.63', hosts: '["apparatus"]',
        }), /do not include its bind address/],
        ['label and publication disagree', bound(19090, {
            address: '192.168.1.63', labelAddress: '0.0.0.0', hosts: '["192.168.1.63"]', authority: '127.0.0.1:19090',
        }), /publications/],
        ['specific binding with loopback authority', bound(19090, {
            address: '192.168.1.63', hosts: '["192.168.1.63"]', authority: '127.0.0.1:19090',
        }), /authority/],
        ['a third agent publication', bound(19090, {
            address: '0.0.0.0',
            hosts: '["192.168.1.63"]',
            publications: [
                { containerPort: '7000', protocol: 'tcp', hostIp: '0.0.0.0', hostPort: '17000' },
                udp,
                { containerPort: '8080', protocol: 'tcp', hostIp: '0.0.0.0', hostPort: '19090' },
            ],
        }), /publications/],
        ['the private Router listener', bound(19090, {
            address: '0.0.0.0',
            hosts: '["192.168.1.63"]',
            publications: [
                udp,
                { containerPort: '8081', protocol: 'tcp', hostIp: '0.0.0.0', hostPort: '19090' },
            ],
        }), /publications/],
    ]) {
        assert.throws(() => resolveEffectiveHostPort({ ownership }), pattern, name);
    }
});

test('a requested binding selects address and trusted hosts while an explicit port keeps precedence', () => {
    const requested = { address: '0.0.0.0', hostPort: 8083, hosts: ['192.168.1.63'] };
    const plan = resolveEffectiveHostPort({ ownership: owned(19090), routerBinding: requested });
    assert.equal(plan.hostPort, 8083);
    assert.equal(plan.mediaHostPort, 17891);
    assert.equal(plan.address, '0.0.0.0');
    assert.deepEqual(plan.hosts, ['192.168.1.63']);
    assert.equal(plan.source, 'binding');
    assert.equal(plan.existingPublication.address, '127.0.0.1');

    const explicit = resolveEffectiveHostPort({ explicitPort: '9090', ownership: owned(19090), routerBinding: requested });
    assert.equal(explicit.hostPort, 9090);
    assert.equal(explicit.address, '0.0.0.0');
    assert.equal(explicit.source, 'explicit');

    const keepsPort = resolveEffectiveHostPort({
        ownership: owned(19090),
        routerBinding: { address: '127.0.0.1', hosts: null },
    });
    assert.equal(keepsPort.hostPort, 19090);
    assert.throws(() => resolveEffectiveHostPort({
        ownership: { state: 'absent' },
        routerBinding: { address: '0.0.0.0', hostPort: 8083 },
    }), /requires its trusted outer host list/);
});

test('widening onto the wildcard defers the old listener but detects other interfaces first', async () => {
    const existingPublication = resolveEffectiveHostPort({ ownership: owned(19090) }).existingPublication;
    const probes = [];
    const result = await preflightPublications({
        hostPort: 19090,
        mediaHostPort: 17891,
        address: '0.0.0.0',
        existingPublication,
        // The old Box still holds 127.0.0.1:19090, so the wildcard probe fails.
        checkTcp: async (port, { host }) => {
            probes.push(`${host}:${port}`);
            return host !== '0.0.0.0';
        },
        checkUdp: async () => false,
        localAddresses: () => ['100.76.22.69', '127.0.0.1', '192.168.1.63'],
    });
    assert.equal(result.tcp, '0.0.0.0:19090:8080/tcp');
    assert.equal(result.udp, '0.0.0.0:17891:7882/udp');
    assert.deepEqual(result.recheckAfterRelease, { tcp: true, udp: true });
    assert.deepEqual(probes, ['0.0.0.0:19090', '100.76.22.69:19090', '192.168.1.63:19090']);

    await assert.rejects(() => preflightPublications({
        hostPort: 19090,
        mediaHostPort: 17891,
        address: '0.0.0.0',
        existingPublication,
        checkTcp: async (_port, { host }) => !['0.0.0.0', '192.168.1.63'].includes(host),
        checkUdp: async () => true,
        localAddresses: () => ['127.0.0.1', '192.168.1.63'],
    }), (error) => error.code === 'PLOINKY_BOX_TCP_CONFLICT'
        && /192\.168\.1\.63:19090 is already in use by another listener/.test(error.message));

    // Distinct specific addresses never share a listener, so no exemption.
    await assert.rejects(() => preflightPublications({
        hostPort: 19090,
        mediaHostPort: 17891,
        address: '192.168.1.63',
        existingPublication,
        checkTcp: async () => false,
        checkUdp: async () => true,
        localAddresses: () => [],
    }), /TCP 192\.168\.1\.63:19090 is already in use/);

    await assert.rejects(() => preflightPublications({
        hostPort: 19090,
        mediaHostPort: 17891,
        address: '0.0.0.0',
        existingPublication: { ...existingPublication, running: false },
        checkTcp: async () => false,
        checkUdp: async () => true,
    }), /TCP 0\.0\.0\.0:19090 is already in use/);

    // Narrowing from the wildcard is excused only until the release recheck.
    const wildcardPublication = resolveEffectiveHostPort({
        ownership: bound(19090, { address: '0.0.0.0', hosts: '["192.168.1.63"]' }),
    }).existingPublication;
    const narrowed = await preflightPublications({
        hostPort: 19090,
        mediaHostPort: 17891,
        address: '127.0.0.1',
        existingPublication: wildcardPublication,
        checkTcp: async () => false,
        checkUdp: async () => true,
        localAddresses: () => assert.fail('narrowing needs no per-interface probe'),
    });
    assert.deepEqual(narrowed.recheckAfterRelease, { tcp: true, udp: false });
});

test('the release recheck proves a deferred reservation or reports the foreign listener', async () => {
    const preflight = {
        hostPort: 19090,
        mediaHostPort: 17891,
        address: '0.0.0.0',
        recheckAfterRelease: { tcp: true, udp: false },
    };
    let attempts = 0;
    await recheckReleasedPublications(preflight, {
        checkTcp: async (port, { host }) => {
            assert.equal(port, 19090);
            assert.equal(host, '0.0.0.0');
            attempts += 1;
            return attempts >= 3;
        },
        checkUdp: async () => assert.fail('UDP was not deferred'),
        timeoutMs: 1_000,
        intervalMs: 0,
        delay: async () => {},
    });
    assert.equal(attempts, 3);

    await assert.rejects(() => recheckReleasedPublications(preflight, {
        checkTcp: async () => false,
        timeoutMs: 0,
        delay: async () => {},
    }), (error) => error.code === 'PLOINKY_BOX_TCP_CONFLICT'
        && /0\.0\.0\.0:19090 is still in use after the previous Box released it/.test(error.message));

    await recheckReleasedPublications({ recheckAfterRelease: { tcp: false, udp: false } }, {
        checkTcp: async () => assert.fail('nothing was deferred'),
        checkUdp: async () => assert.fail('nothing was deferred'),
    });
    await recheckReleasedPublications(undefined);
});

test('TCP probes bind the requested address and reject addresses this host does not own', async (t) => {
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const { port } = server.address();
    assert.equal(await probeTcpAvailability(port, { host: '127.0.0.1' }), false);
    // A wildcard listener would collide with the specific loopback listener.
    assert.equal(await probeTcpAvailability(port, { host: '0.0.0.0' }), false);
    await assert.rejects(
        () => probeTcpAvailability(port, { host: '192.0.2.1' }),
        { code: 'PLOINKY_BOX_BIND_ADDRESS_UNASSIGNED' },
    );
});

test('wildcard TCP availability rejects a specific-address listener even if wildcard bind would succeed', async () => {
    const checked = [];
    const available = await probeTcpAvailability(19090, {
        host: '0.0.0.0',
        listAddresses: () => ['127.0.0.1', '10.20.30.40'],
        createServer() {
            const server = new EventEmitter();
            server.listen = ({ host }, callback) => {
                checked.push(host);
                queueMicrotask(() => host === '10.20.30.40'
                    ? server.emit('error', Object.assign(new Error('busy'), { code: 'EADDRINUSE' }))
                    : callback());
            };
            server.close = callback => callback();
            return server;
        },
    });
    assert.equal(available, false);
    assert.deepEqual(checked, ['127.0.0.1', '10.20.30.40']);
});
