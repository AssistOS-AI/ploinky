import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
    buildRouterAuthorityTopologyIntent,
    validateRouterAuthorityObservation,
} from '../../cli/sandbox/routerAuthorityAttestation.js';
import { BOX_MARKER_CONTENT } from '../../ploinky-box/constants.mjs';

const FIXTURES = path.resolve('tests/fixtures/router-descriptor');
const proof = Object.freeze({ backend: 'netavark', engine: 'podman', remote: false, rootless: true });
const networkFingerprint = `sha256:${'1'.repeat(64)}`;
const missingBox = { lstatSync() { const error = new Error('missing'); error.code = 'ENOENT'; throw error; } };
const presentBox = {
    lstatSync() { return { isSymbolicLink: () => false, isFile: () => true, nlink: 1 }; },
    readFileSync() { return Buffer.from(BOX_MARKER_CONTENT); },
};

function intent(fsApi, runtimeProof = proof, platform = 'linux') {
    return buildRouterAuthorityTopologyIntent({
        networkMode: 'default',
        runtimeProof,
        networkFingerprint,
        routerHostPort: 18080,
        edgeTopologyFile: '/run/ploinky/edge-topology/current.json',
        platform,
        fsApi,
    });
}

function generationSnapshot(fixture) {
    return Object.freeze({
        generation: fixture.evidence.generationId,
        routing: Object.freeze({ static: Object.freeze({ agent: 'explorer' }) }),
    });
}

test('Box/remote select public+loopback authority while native managed selects HCI:8080', () => {
    const box = intent(presentBox);
    const remote = intent(missingBox, { ...proof, remote: true });
    const managed = intent(missingBox);
    assert.deepEqual([box.listenerClass, box.requestAuthority], ['public', '127.0.0.1:18080']);
    assert.deepEqual([remote.listenerClass, remote.requestAuthority], ['public', '127.0.0.1:18080']);
    assert.deepEqual([managed.listenerClass, managed.requestAuthority], ['managed', 'host.containers.internal:8080']);
    assert.equal(managed.publicAuthority, '127.0.0.1:18080');
});

test('AppleHV remote uses its dedicated exact loopback proxy evidence cell', () => {
    const macosFixture = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'macos-remote-attestation.json')));
    const macosRemote = intent(missingBox, { ...proof, remote: true }, 'darwin');
    assert.deepEqual(
        [macosRemote.topology, macosRemote.listenerClass, macosRemote.requestAuthority],
        ['macos-remote-public-loopback', 'public', '127.0.0.1:18080'],
    );
    assert.doesNotThrow(() => validateRouterAuthorityObservation({
        intent: macosRemote,
        nonce: macosFixture.evidence.nonce,
        records: macosFixture.evidence.records,
        external: macosFixture.evidence.external,
        generationId: macosFixture.evidence.generationId,
        generationSnapshot: generationSnapshot(macosFixture),
    }));

    const linuxRemote = intent(missingBox, { ...proof, remote: true }, 'linux');
    assert.throws(() => validateRouterAuthorityObservation({
        intent: linuxRemote,
        nonce: macosFixture.evidence.nonce,
        records: macosFixture.evidence.records,
        external: macosFixture.evidence.external,
        generationId: macosFixture.evidence.generationId,
        generationSnapshot: generationSnapshot(macosFixture),
    }), /fixed topology cell/);
});

test('frozen public and managed two-Host evidence validates only in its intended topology cell', () => {
    const publicFixture = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'public-attestation.json')));
    const managedFixture = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'managed-attestation.json')));
    const validate = (topology, fixture) => validateRouterAuthorityObservation({
        intent: topology,
        nonce: fixture.evidence.nonce,
        records: fixture.evidence.records,
        external: fixture.evidence.external,
        generationId: fixture.evidence.generationId,
        generationSnapshot: generationSnapshot(fixture),
    });
    assert.doesNotThrow(() => validate(intent(presentBox), publicFixture));
    assert.doesNotThrow(() => validate(intent(missingBox), managedFixture));
    assert.throws(() => validate(intent(missingBox), publicFixture), /fixed topology cell/);
    assert.throws(() => validate(intent(presentBox), managedFixture), /fixed topology cell/);
});
