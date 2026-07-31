import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { writeGeneratedRouterDescriptorFile } from '../../cli/utils/security/generatedRouterDescriptor.js';

test('descriptor publication is 0600, exact, and never overwrites an existing launch artifact', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-router-producer-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const target = path.join(root, '00000000-0000-4000-8000-000000000000.json');
    const original = Buffer.from('{"payload":{},"signature":"fixture"}');
    writeGeneratedRouterDescriptorFile(target, original);
    assert.deepEqual(fs.readFileSync(target), original);
    assert.equal(fs.lstatSync(target).mode & 0o777, 0o600);
    assert.throws(
        () => writeGeneratedRouterDescriptorFile(target, Buffer.from('{"replacement":true}')),
        /failed to write generated Router descriptor atomically/,
    );
    assert.deepEqual(fs.readFileSync(target), original);
});

test('managed producer source enforces attestation, ordered generation checkpoints, then credentials', () => {
    const source = fs.readFileSync(
        new URL('../../cli/sandbox/docker/agentServiceManager.js', import.meta.url),
        'utf8',
    );
    const attestation = source.indexOf('const attested = attestRouterAuthority(');
    const preCredentials = source.indexOf("generationLease.checkpoint('pre-credentials')", attestation);
    const signing = source.indexOf('signGeneratedRouterDescriptorEnvelope(payload)', preCredentials);
    const credentialMint = source.indexOf('buildAgentCredentialEnv(principalId, runtimeIdentity)', signing);
    const preStartHook = source.indexOf('const preStartGeneratedRouterLaunch', credentialMint);
    const preRuntime = source.indexOf("launch.generationLease.checkpoint('pre-runtime')", preStartHook);
    const postInspection = source.indexOf("launch.generationLease.checkpoint('post-inspection')", preRuntime);
    const imagePreparation = source.indexOf('ensureImagePresent(image, { runtime })');
    const managedTransaction = source.indexOf('networkLifecycle.runManagedContainerTransaction({', imagePreparation);
    assert.ok(attestation > 0 && attestation < preCredentials);
    assert.ok(preCredentials < signing && signing < credentialMint);
    assert.ok(credentialMint < preStartHook && preStartHook < preRuntime && preRuntime < postInspection);
    assert.ok(imagePreparation > 0 && imagePreparation < managedTransaction);
    assert.match(source, /preStartLaunch: preStartGeneratedRouterLaunch/);
    assert.match(source, /managed generated-local launch state is required before container creation/);
    assert.match(source, /`--userns=\$\{managedKeepIdUserNamespace\(launch\.attested\)\}`/);
    assert.match(source, /return `keep-id:uid=\$\{uid\},gid=\$\{gid\}`/);
    assert.match(source, /io\.podman\.annotations\.userns/);
    assert.match(source, /managed candidate attestation lacks an exact numeric non-root UID:GID/);
});

test('authority helper uses the exact image, init, final user, namespace, and mandatory immutable cleanup', () => {
    const source = fs.readFileSync(
        new URL('../../cli/sandbox/routerAuthorityAttestation.js', import.meta.url),
        'utf8',
    );
    assert.match(source, /'--init'/);
    assert.match(source, /\['image', 'inspect', '--format', '\{\{\.Config\.User\}\}', imageId\]/);
    assert.doesNotMatch(source, /runBounded\(runtime, \['image', 'inspect', imageId\]\)/);
    assert.match(source, /\^\(\[1-9\]\[0-9\]\*\):\(\[1-9\]\[0-9\]\*\)\$/);
    assert.match(source, /exact numeric non-root UID:GID/);
    assert.match(source, /'--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges'/);
    assert.match(source, /\.\.\.\(plan\?\.args \|\| \[\]\)/);
    assert.match(source, /AUTHORITY_HELPER_INSPECT_FORMAT/);
    assert.match(source, /'container', 'inspect', '--format', AUTHORITY_HELPER_INSPECT_FORMAT, id/);
    assert.doesNotMatch(source, /runBounded\(runtime, \['container', 'inspect', id\]\)/);
    assert.match(source, /String\(inspected\.user \|\| ''\) !== finalUser/);
    assert.match(source, /statusField\('CapBnd'\)/);
    assert.match(source, /statusField\('NoNewPrivs'\) !== '1'/);
    assert.match(source, /helper cleanup could not prove exact immutable ID and nonce ownership/);
    assert.match(source, /\['container', 'exists', helperId\]/);
});

test('descriptor cleanup is confined to an immutable container ID and exact recorded inode', () => {
    const fleet = fs.readFileSync(
        new URL('../../cli/sandbox/docker/containerFleet.js', import.meta.url),
        'utf8',
    );
    assert.match(fleet, /withLock = withNetworkLifecycleLock/);
    assert.match(fleet, /return withLock\(\(\) => \{/);
    assert.match(fleet, /actualId !== expectedId \|\| actualName !== name/);
    assert.match(fleet, /control\(runtime, \['rm', '-f', expectedId\]\)/);
    assert.match(fleet, /inspect\(runtime, expectedId\)/);
    assert.match(fleet, /NETWORK_LABELS\.instanceId/);
    assert.match(fleet, /NETWORK_LABELS\.enableGeneration/);
    assert.match(fleet, /current\.dev !== artifact\.dev \|\| current\.ino !== artifact\.ino/);
    assert.match(fleet, /fs\.unlinkSync\(artifact\.source\)/);

    const lifecycle = fs.readFileSync(
        new URL('../../cli/sandbox/networkLifecycle.js', import.meta.url),
        'utf8',
    );
    assert.match(lifecycle, /launchArtifactCleanupSafe/);
    assert.match(lifecycle, /launch artifact preserved because exact candidate absence was not proven/);

    const manager = fs.readFileSync(
        new URL('../../cli/sandbox/docker/agentServiceManager.js', import.meta.url),
        'utf8',
    );
    assert.match(manager, /current\.dev !== descriptorIdentity\.dev/);
    assert.match(manager, /current\.ino !== descriptorIdentity\.ino/);
    assert.match(manager, /if \(exactCleanupPerformed && generatedLaunch\?\.cleanup\)/);
    assert.match(manager, /descriptor preserved because exact candidate absence was not proven/);
});
