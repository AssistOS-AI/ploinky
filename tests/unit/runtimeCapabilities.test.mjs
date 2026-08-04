import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { BOX_MARKER_CONTENT } from '../../ploinky-box/constants.mjs';
import { networkContractHash } from '../../cli/sandbox/networkContract.js';
import {
    admitManifestRuntimeCapabilities,
    assertRuntimeAdmissionCurrent,
    assertRuntimeCapabilitiesAllowed,
    RUNTIME_ADMISSION_SCHEMA_VERSION,
    renderContainerSecurityArgs,
    renderRuntimePolicyArgs,
    resolveEffectiveRuntimeCapabilities,
    runtimeCapabilityDigest,
    validateManifestRuntimeCapabilities,
} from '../../cli/sandbox/runtimeCapabilities.js';

function markerFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-runtime-capability-'));
    const markerPath = path.join(root, 'ploinky-box');
    fs.writeFileSync(markerPath, BOX_MARKER_CONTENT);
    return { root, markerPath };
}

test('runtime capability validation checks every profile, selected or not', () => {
    const manifest = {
        profiles: {
            default: {},
            qa: { containerSecurity: {} },
        },
    };
    assert.throws(
        () => validateManifestRuntimeCapabilities(manifest),
        (error) => error.code === 'PLOINKY_MANIFEST_SECURITY_PROFILE_UNSUPPORTED',
    );
});

test('canonical profile mount modes remain valid while raw capability aliases are rejected', () => {
    assert.doesNotThrow(() => validateManifestRuntimeCapabilities({
        profiles: {
            default: { mounts: { code: 'ro', skills: 'ro' } },
        },
    }));
    for (const field of ['devices', 'rawArgs', 'securityOpt']) {
        assert.throws(
            () => validateManifestRuntimeCapabilities({ [field]: [] }),
            (error) => error.code === 'PLOINKY_MANIFEST_SECURITY_INVALID',
        );
    }
});

test('Box rejects absolute, parent-relative, and symlink-escaping host mounts', () => {
    const fixture = markerFixture();
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-runtime-volume-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-runtime-volume-outside-'));
    fs.symlinkSync(outside, path.join(workspace, 'escape'));
    try {
        for (const source of ['/etc', '../outside', 'escape/new-child']) {
            const descriptor = resolveEffectiveRuntimeCapabilities({
                volumes: { [source]: '/inside' },
            }, { workspaceRoot: workspace });
            assert.throws(
                () => assertRuntimeCapabilitiesAllowed(descriptor, {
                    boxMarkerOptions: { markerPath: fixture.markerPath },
                }),
                (error) => error.code === 'PLOINKY_BOX_RUNTIME_CAPABILITY_UNSUPPORTED',
            );
        }
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
        fs.rmSync(workspace, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
    }
});

test('effective descriptor is frozen and binds policy, profile, and manifest identity', () => {
    const descriptor = resolveEffectiveRuntimeCapabilities({
        containerSecurity: {},
        network: { mode: 'managed' },
        llmRuntime: { runtimePolicy: { resources: { memory: '2g' } } },
    }, {
        agentId: 'repo/agent',
        profileName: 'qa',
        manifestDigest: `sha256:${'a'.repeat(64)}`,
    });
    assert.equal(Object.isFrozen(descriptor), true);
    assert.equal(Object.isFrozen(descriptor.runtimePolicy), true);
    assert.equal(descriptor.profileName, 'qa');
    assert.equal(descriptor.runtimePolicy.resources.memory, '2g');
    assert.match(runtimeCapabilityDigest(descriptor), /^sha256:[a-f0-9]{64}$/);
    const manifest = { containerSecurity: {} };
    const admission = admitManifestRuntimeCapabilities(manifest, {
        manifestBytes: Buffer.from(JSON.stringify(manifest)),
        insideBox: false,
    });
    assert.deepEqual(renderContainerSecurityArgs(admission.descriptor), []);
});

test('argument renderers reject a forged public-version descriptor', () => {
    const forged = Object.freeze({
        policyVersion: 'ploinky-runtime-capabilities-v1',
        containerSecurity: Object.freeze({ privileged: true }),
        runtimePolicy: Object.freeze({ securityOpt: Object.freeze(['seccomp=unconfined']) }),
    });
    assert.throws(
        () => renderContainerSecurityArgs(forged),
        { code: 'PLOINKY_RUNTIME_INPUT_CHANGED' },
    );
    assert.throws(
        () => renderRuntimePolicyArgs(forged, { runtime: 'podman' }),
        { code: 'PLOINKY_RUNTIME_INPUT_CHANGED' },
    );
});

test('strict Box marker permits admitted bwrap host networking but rejects other unsupported capabilities', () => {
    const fixture = markerFixture();
    try {
        const cases = [
            { containerSecurity: { privileged: true } },
            { llmRuntime: { runtimePolicy: { devices: [{ type: 'cdi', value: 'nvidia.com/gpu=all' }] } } },
            { llmRuntime: { runtimePolicy: { ipc: 'host' } } },
            { llmRuntime: { runtimePolicy: { securityOpt: ['label=disable'] } } },
        ];
        for (const manifest of cases) {
            const descriptor = resolveEffectiveRuntimeCapabilities(manifest);
            assert.throws(
                () => assertRuntimeCapabilitiesAllowed(descriptor, {
                    boxMarkerOptions: { markerPath: fixture.markerPath },
                }),
                (error) => error.code === 'PLOINKY_BOX_RUNTIME_CAPABILITY_UNSUPPORTED',
            );
        }
        const hostNetwork = resolveEffectiveRuntimeCapabilities({}, { network: { mode: 'host' } });
        assert.equal(hostNetwork.capabilities.hostNetwork, true);
        assert.doesNotThrow(() => assertRuntimeCapabilitiesAllowed(hostNetwork, {
            boxMarkerOptions: { markerPath: fixture.markerPath },
        }));
        assert.doesNotThrow(() => assertRuntimeCapabilitiesAllowed(hostNetwork, {
            runtimeKind: 'bwrap',
            boxMarkerOptions: { markerPath: fixture.markerPath },
        }));
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test('strict sandbox admission schema records absent declaration and effective network hash', () => {
    const manifest = { 'lite-sandbox': true };
    const admission = admitManifestRuntimeCapabilities(manifest, {
        manifestBytes: Buffer.from(JSON.stringify(manifest)),
        runtime: 'bwrap',
        runtimeKind: 'bwrap',
        network: { mode: 'host', source: 'platform-lite-sandbox' },
        insideBox: false,
    });
    assert.equal(admission.schemaVersion, RUNTIME_ADMISSION_SCHEMA_VERSION);
    assert.equal(admission.networkAdmission.declaration, 'absent');
    assert.deepEqual(admission.networkAdmission.effectiveContract, {
        mode: 'host',
        source: 'platform-lite-sandbox',
    });
    assert.match(admission.networkAdmission.effectiveHash, /^[a-f0-9]{64}$/);
    assert.equal(admission.descriptor.capabilities.hostNetwork, true);
    assert.doesNotThrow(() => assertRuntimeAdmissionCurrent(admission, {
        manifestBytes: Buffer.from(JSON.stringify(manifest)),
        runtimeKind: 'bwrap',
    }));

    const staleSchema = structuredClone(admission);
    staleSchema.schemaVersion = 1;
    assert.throws(
        () => assertRuntimeAdmissionCurrent(staleSchema),
        { code: 'PLOINKY_RUNTIME_INPUT_CHANGED' },
    );
    const alteredNetwork = structuredClone(admission);
    alteredNetwork.networkAdmission.effectiveHash = '0'.repeat(64);
    assert.throws(
        () => assertRuntimeAdmissionCurrent(alteredNetwork),
        { code: 'PLOINKY_RUNTIME_INPUT_CHANGED' },
    );
    const malformedNetwork = structuredClone(admission);
    delete malformedNetwork.networkAdmission.effectiveContract;
    assert.throws(
        () => assertRuntimeAdmissionCurrent(malformedNetwork),
        { code: 'PLOINKY_RUNTIME_INPUT_CHANGED' },
    );

    assert.throws(
        () => admitManifestRuntimeCapabilities(manifest, {
            runtimeKind: 'container',
            insideBox: false,
        }),
        { code: 'PLOINKY_SANDBOX_POLICY_CONFLICT' },
    );
    assert.throws(
        () => admitManifestRuntimeCapabilities({
            'lite-sandbox': true,
            container: 'legacy-image',
        }, { runtimeKind: 'bwrap', insideBox: false }),
        { code: 'PLOINKY_SANDBOX_CONTAINER_CONFLICT' },
    );
});

test('host runtime admission requires the exact derived platform network contract', () => {
    const manifest = { 'lite-sandbox': true };
    for (const runtimeKind of ['bwrap', 'seatbelt']) {
        const admission = admitManifestRuntimeCapabilities(manifest, {
            manifestBytes: Buffer.from(JSON.stringify(manifest)),
            runtime: runtimeKind,
            runtimeKind,
            network: { mode: 'host', source: 'platform-lite-sandbox' },
            insideBox: false,
        });

        for (const effectiveContract of [
            { mode: 'none' },
            { mode: 'host' },
        ]) {
            const forgedAdmission = structuredClone(admission);
            forgedAdmission.networkAdmission.effectiveContract = effectiveContract;
            forgedAdmission.networkAdmission.effectiveHash = networkContractHash(effectiveContract);
            assert.throws(
                () => assertRuntimeAdmissionCurrent(forgedAdmission),
                { code: 'PLOINKY_RUNTIME_INPUT_CHANGED' },
            );
        }
    }
});

test('production environment cannot redirect the canonical Box marker decision', () => {
    const fixture = markerFixture();
    const previous = process.env.PLOINKY_BOX_MARKER_PATH;
    process.env.PLOINKY_BOX_MARKER_PATH = path.join(fixture.root, 'absent-attacker-marker');
    try {
        const descriptor = resolveEffectiveRuntimeCapabilities({
            containerSecurity: { privileged: true },
        });
        assert.throws(
            () => assertRuntimeCapabilitiesAllowed(descriptor, {
                boxMarkerOptions: { markerPath: fixture.markerPath },
            }),
            (error) => error.code === 'PLOINKY_BOX_RUNTIME_CAPABILITY_UNSUPPORTED',
        );
    } finally {
        if (previous === undefined) delete process.env.PLOINKY_BOX_MARKER_PATH;
        else process.env.PLOINKY_BOX_MARKER_PATH = previous;
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test('invalid Box marker fails closed with the marker error code', () => {
    const fixture = markerFixture();
    try {
        fs.writeFileSync(fixture.markerPath, 'wrong\n');
        const descriptor = resolveEffectiveRuntimeCapabilities({});
        assert.throws(
            () => assertRuntimeCapabilitiesAllowed(descriptor, {
                boxMarkerOptions: { markerPath: fixture.markerPath },
            }),
            (error) => error.code === 'PLOINKY_BOX_MARKER_INVALID',
        );
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test('host sandboxes reject container-only capabilities and isolated networking', () => {
    const descriptor = resolveEffectiveRuntimeCapabilities({
        network: { mode: 'managed' },
    });
    assert.throws(
        () => assertRuntimeCapabilitiesAllowed(descriptor, {
            runtimeKind: 'bwrap',
            insideBox: false,
        }),
        (error) => error.code === 'PLOINKY_BOX_RUNTIME_CAPABILITY_UNSUPPORTED',
    );
});
