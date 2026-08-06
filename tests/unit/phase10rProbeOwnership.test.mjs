import assert from 'node:assert/strict';
import test from 'node:test';

import {
    buildManagedProbeRunArgs,
} from '../../cli/sandbox/docker/probeOwnership.js';
import { buildShellDetectionRunArgs } from '../../cli/sandbox/docker/shellDetection.js';
import { buildContainerInstallRunArgs } from '../../cli/utils/dependencies/dependencyCache.js';
import { buildContainerRuntimeKeyProbeRunArgs } from '../../cli/utils/dependencies/dependencyRuntimeKey.js';
import { buildContainerAuthorityHelperCreateArgs } from '../../cli/sandbox/routerAuthorityAttestation.js';

const IMAGE_ID = 'a'.repeat(64);
const RELEASE_GENERATION = 'b'.repeat(64);
const OWNER = 'demo/codex';
const WORKSPACE_PATH = '/workspace';

function probeOptions(purpose) {
    return {
        purpose,
        owner: OWNER,
        imageId: IMAGE_ID,
        releaseGeneration: RELEASE_GENERATION,
        workspacePath: WORKSPACE_PATH,
    };
}

function labels(args) {
    const result = new Map();
    for (let index = 0; index < args.length; index += 1) {
        if (args[index] !== '--label') continue;
        const [key, ...value] = String(args[index + 1]).split('=');
        result.set(key, value.join('='));
    }
    return result;
}

function assertOwnedProbe(args, purpose, { authorityNonce = '' } = {}) {
    assert.equal(args.filter((value) => value === '--name').length, 1);
    assert.equal(args.filter((value) => value === '--pull=never').length, 1);
    const name = args[args.indexOf('--name') + 1];
    assert.match(name, /^ploinky-probe-[a-f0-9]{12}-[a-f0-9]{16}$/);
    const observed = labels(args);
    assert.deepEqual([...observed.keys()].sort(), [
        ...(authorityNonce ? ['io.assistos.ploinky.authority-helper'] : []),
        'io.assistos.ploinky.enable-generation',
        'io.assistos.ploinky.instance-id',
        'io.assistos.ploinky.managed',
        'io.assistos.ploinky.network-contract',
        'io.assistos.ploinky.network-schema',
        'io.assistos.ploinky.probe-image',
        'io.assistos.ploinky.probe-owner',
        'io.assistos.ploinky.probe-purpose',
        'io.assistos.ploinky.release-generation',
        'io.assistos.ploinky.resource',
        'io.assistos.ploinky.workspace',
    ].sort());
    assert.equal(observed.get('io.assistos.ploinky.managed'), '1');
    assert.equal(observed.get('io.assistos.ploinky.resource'), 'probe');
    assert.equal(observed.get('io.assistos.ploinky.probe-purpose'), purpose);
    assert.equal(observed.get('io.assistos.ploinky.probe-owner'), OWNER);
    assert.equal(observed.get('io.assistos.ploinky.probe-image'), IMAGE_ID);
    assert.equal(observed.get('io.assistos.ploinky.release-generation'), RELEASE_GENERATION);
    if (authorityNonce) {
        assert.equal(observed.get('io.assistos.ploinky.authority-helper'), authorityNonce);
    }
    assert.match(observed.get('io.assistos.ploinky.workspace'), /^[a-f0-9]{12}$/);
    assert.match(observed.get('io.assistos.ploinky.network-contract'), /^[a-f0-9]{64}$/);
    assert.match(observed.get('io.assistos.ploinky.instance-id'), /^[a-f0-9]{64}$/);
    assert.match(observed.get('io.assistos.ploinky.enable-generation'), /^[a-f0-9]{64}$/);
    return name;
}

test('managed disposable probes have deterministic complete positive ownership', () => {
    const first = buildManagedProbeRunArgs(probeOptions('runtime-key'));
    const second = buildManagedProbeRunArgs(probeOptions('runtime-key'));
    assert.deepEqual(second, first);
    const firstName = assertOwnedProbe(first, 'runtime-key');
    const otherName = assertOwnedProbe(
        buildManagedProbeRunArgs(probeOptions('shell-detection')),
        'shell-detection',
    );
    assert.notEqual(firstName, otherName);
});

test('all disposable run builders use the complete probe contract and never pull', () => {
    const cases = [
        ['runtime-key', buildContainerRuntimeKeyProbeRunArgs(
            IMAGE_ID,
            probeOptions('runtime-key'),
        )],
        ['shell-detection', buildShellDetectionRunArgs(
            IMAGE_ID,
            '/bin/sh',
            probeOptions('shell-detection'),
        )],
        ['dependency-install', buildContainerInstallRunArgs({
            cwd: '/workspace/.ploinky/cache',
            image: IMAGE_ID,
            runtime: 'podman',
            shellPath: '/bin/sh',
            installScript: 'true',
            probeOwnership: probeOptions('dependency-install'),
        })],
    ];
    for (const [purpose, args] of cases) {
        assertOwnedProbe(args, purpose);
        assert.equal(args.includes('pull'), false);
    }
});

test('authority helper uses the descriptor raw Node image and complete ownership', () => {
    const args = buildContainerAuthorityHelperCreateArgs({
        helperImageId: IMAGE_ID,
        nonce: 'c'.repeat(64),
        intent: {
            physicalOrigin: 'http://host.containers.internal:8080',
            requestAuthority: 'host.containers.internal:8080',
            publicAuthority: '127.0.0.1:18080',
        },
        plan: {
            alias: 'fixture',
            attachments: [{ name: 'test-network', primary: true }],
            args: [
                '--network', 'test-network',
                '--network-alias', 'fixture',
                '--add-host', 'host.containers.internal:host-gateway',
            ],
        },
        probeOwnership: probeOptions('router-authority'),
    });
    assertOwnedProbe(args, 'router-authority', { authorityNonce: 'c'.repeat(64) });
    assert.ok(args.indexOf('--pull=never') < args.indexOf(IMAGE_ID));
    assert.equal(args.includes('docker.io/library/node:24-bookworm-slim'), false);
    assert.equal(args.filter((value) => value === IMAGE_ID).length, 1);
});
