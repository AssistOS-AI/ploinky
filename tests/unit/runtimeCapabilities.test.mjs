import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { BOX_MARKER_CONTENT } from '../../ploinky-box/constants.mjs';
import {
    admitManifestRuntimeCapabilities,
    assertRuntimeCapabilitiesAllowed,
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

test('strict Box marker admits only the fixed nested Podman capability contract', () => {
    const fixture = markerFixture();
    try {
        const privileged = resolveEffectiveRuntimeCapabilities({
            containerSecurity: { privileged: true },
        });
        assert.throws(
            () => assertRuntimeCapabilitiesAllowed(privileged, {
                boxMarkerOptions: { markerPath: fixture.markerPath },
            }),
            (error) => error.code === 'PLOINKY_BOX_RUNTIME_CAPABILITY_UNSUPPORTED'
                && error.context.unsupported.includes('privileged'),
        );
        const nestedManifest = { containerSecurity: { nestedPodman: true } };
        const nestedBytes = Buffer.from(JSON.stringify(nestedManifest));
        const nestedAdmission = admitManifestRuntimeCapabilities(nestedManifest, {
            manifestBytes: nestedBytes,
            boxMarkerOptions: { markerPath: fixture.markerPath },
        });
        assert.deepEqual(renderContainerSecurityArgs(nestedAdmission.descriptor), [
            '--cap-add', 'SYS_ADMIN',
            '--cap-add', 'NET_ADMIN',
            '--device', '/dev/fuse',
            '--device', '/dev/net/tun',
            '--security-opt', 'label=disable',
            '--security-opt', 'seccomp=/opt/ploinky/ploinky-box/seccomp/podman-nested-pid-fallback.json',
        ]);
        assert.throws(
            () => assertRuntimeCapabilitiesAllowed(nestedAdmission.descriptor, {
                runtimeKind: 'bwrap',
                boxMarkerOptions: { markerPath: fixture.markerPath },
            }),
            (error) => error.code === 'PLOINKY_BOX_RUNTIME_CAPABILITY_UNSUPPORTED'
                && error.context.unsupported.includes('nested-podman'),
        );
        const cases = [
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
        const hostNetwork = resolveEffectiveRuntimeCapabilities({ network: { mode: 'host' } });
        assert.equal(hostNetwork.capabilities.hostNetwork, true);
        assert.doesNotThrow(() => assertRuntimeCapabilitiesAllowed(hostNetwork, {
            boxMarkerOptions: { markerPath: fixture.markerPath },
        }));
        assert.throws(
            () => assertRuntimeCapabilitiesAllowed(hostNetwork, {
                runtimeKind: 'bwrap',
                boxMarkerOptions: { markerPath: fixture.markerPath },
            }),
            (error) => error.code === 'PLOINKY_BOX_RUNTIME_CAPABILITY_UNSUPPORTED'
                && error.context.unsupported.includes('box-host-sandbox'),
        );
        const nestedPodman = resolveEffectiveRuntimeCapabilities({
            containerSecurity: { nestedPodman: true },
        });
        assert.equal(nestedPodman.capabilities.nestedPodman, true);
        assert.doesNotThrow(() => assertRuntimeCapabilitiesAllowed(nestedPodman, {
            boxMarkerOptions: { markerPath: fixture.markerPath },
        }));
        assert.throws(
            () => assertRuntimeCapabilitiesAllowed(nestedPodman, {
                runtimeKind: 'bwrap',
                boxMarkerOptions: { markerPath: fixture.markerPath },
            }),
            (error) => error.code === 'PLOINKY_BOX_RUNTIME_CAPABILITY_UNSUPPORTED'
                && error.context.unsupported.includes('nested-podman'),
        );
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test('production environment cannot redirect the canonical Box marker decision', () => {
    const fixture = markerFixture();
    const previous = process.env.PLOINKY_BOX_MARKER_PATH;
    process.env.PLOINKY_BOX_MARKER_PATH = path.join(fixture.root, 'absent-attacker-marker');
    try {
        const descriptor = resolveEffectiveRuntimeCapabilities({
            llmRuntime: { runtimePolicy: { securityOpt: ['label=disable'] } },
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

test('nested Podman is Box-only and mutually exclusive with privileged mode', () => {
    assert.throws(
        () => validateManifestRuntimeCapabilities({
            containerSecurity: { nestedPodman: true, privileged: true },
        }),
        (error) => error.code === 'PLOINKY_MANIFEST_SECURITY_INVALID',
    );
    const descriptor = resolveEffectiveRuntimeCapabilities({
        containerSecurity: { nestedPodman: true },
    });
    assert.throws(
        () => assertRuntimeCapabilitiesAllowed(descriptor, {
            runtimeKind: 'container',
            insideBox: false,
        }),
        (error) => error.code === 'PLOINKY_BOX_RUNTIME_CAPABILITY_UNSUPPORTED'
            && error.context.unsupported.includes('nested-podman-outside-box'),
    );
});
