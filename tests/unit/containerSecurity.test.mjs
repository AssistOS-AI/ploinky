import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildContainerSecurityArgs,
    resolveContainerSecurity,
} from '../../cli/sandbox/docker/containerSecurity.js';

test('container security defaults to no extra runtime flags', () => {
    assert.deepEqual(resolveContainerSecurity({}, null), {
        privileged: false,
        nestedPodman: false,
    });
    assert.deepEqual(buildContainerSecurityArgs(resolveContainerSecurity({}, null)), []);
});

test('container security emits only the allowlisted privileged flag', () => {
    const manifest = {
        containerSecurity: {
            privileged: true,
        },
    };

    assert.deepEqual(resolveContainerSecurity(manifest, null), {
        privileged: true,
        nestedPodman: false,
    });
    assert.deepEqual(buildContainerSecurityArgs(resolveContainerSecurity(manifest, null)), ['--privileged']);
});

test('container security emits the bounded nested Podman runtime contract', () => {
    const security = resolveContainerSecurity({
        containerSecurity: {
            nestedPodman: true,
        },
    }, null);

    assert.deepEqual(security, {
        privileged: false,
        nestedPodman: true,
    });
    assert.deepEqual(buildContainerSecurityArgs(security), [
        '--cap-add', 'SYS_ADMIN',
        '--cap-add', 'NET_ADMIN',
        '--device', '/dev/fuse',
        '--device', '/dev/net/tun',
        '--security-opt', 'label=disable',
        '--security-opt', 'seccomp=/opt/ploinky/ploinky-box/seccomp/podman-nested-pid-fallback.json',
    ]);
});

test('profile container security is rejected instead of diverging from root rendering', () => {
    const manifest = { containerSecurity: { privileged: true } };
    const profile = { containerSecurity: { privileged: false } };

    assert.throws(
        () => resolveContainerSecurity(manifest, profile),
        (error) => error.code === 'PLOINKY_MANIFEST_SECURITY_PROFILE_UNSUPPORTED',
    );
});

test('container security rejects malformed and unknown root fields', () => {
    for (const containerSecurity of [null, [], 'true', 1]) {
        assert.throws(
            () => resolveContainerSecurity({ containerSecurity }, null),
            (error) => error.code === 'PLOINKY_MANIFEST_SECURITY_INVALID',
        );
    }
    assert.throws(
        () => resolveContainerSecurity({ containerSecurity: { privileged: 'true' } }, null),
        (error) => error.code === 'PLOINKY_MANIFEST_SECURITY_INVALID',
    );
    assert.throws(
        () => resolveContainerSecurity({ containerSecurity: { nestedPodman: 'true' } }, null),
        (error) => error.code === 'PLOINKY_MANIFEST_SECURITY_INVALID',
    );
    assert.throws(
        () => resolveContainerSecurity({
            containerSecurity: { privileged: true, nestedPodman: true },
        }, null),
        (error) => error.code === 'PLOINKY_MANIFEST_SECURITY_INVALID',
    );
    assert.throws(
        () => resolveContainerSecurity({ containerSecurity: { rawArgs: ['--privileged'] } }, null),
        (error) => error.code === 'PLOINKY_MANIFEST_SECURITY_INVALID',
    );
});
