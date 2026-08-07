import assert from 'node:assert/strict';
import test from 'node:test';

import { BOX_LABELS } from '../../ploinky-box/constants.mjs';
import { normalizeContainerRuntime } from '../../ploinky-box/contract/container.mjs';
import {
    preflightPublications,
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

test('port selection honors explicit, existing, then default precedence', () => {
    assert.deepEqual(resolveEffectiveHostPort({
        explicitPort: '20000',
        explicitMediaPort: '20001',
        ownership: { state: 'absent' },
    }), {
        hostPort: 20000,
        mediaHostPort: 20001,
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
