import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildContainerSecurityArgs,
    resolveContainerSecurity,
} from '../../cli/sandbox/docker/containerSecurity.js';
import { hasExactNestedBwrapSecurityContract } from '../../cli/sandbox/docker/agentServiceManager.js';

test('container security defaults to no extra runtime flags', () => {
    assert.deepEqual(resolveContainerSecurity({}, null), { privileged: false, nestedBwrap: false });
    assert.deepEqual(buildContainerSecurityArgs(resolveContainerSecurity({}, null)), []);
});

test('container security emits only the allowlisted privileged flag', () => {
    const manifest = {
        containerSecurity: {
            privileged: true,
        },
    };

    assert.deepEqual(resolveContainerSecurity(manifest, null), { privileged: true, nestedBwrap: false });
    assert.deepEqual(buildContainerSecurityArgs(resolveContainerSecurity(manifest, null)), ['--privileged']);
});

test('nested provider bwrap emits only the exact proc-unmask grant', () => {
    const security = resolveContainerSecurity({
        containerSecurity: { nestedBwrap: true },
    }, null);

    assert.deepEqual(security, { privileged: false, nestedBwrap: true });
    assert.deepEqual(buildContainerSecurityArgs(security), [
        '--security-opt', 'unmask=ALL',
        '--label', 'ploinky.security.nested-bwrap=unmask-all-v1',
    ]);
});

test('nested bwrap adoption requires the exact label and inspected OCI unmask grant', () => {
    const nestedDescriptor = { containerSecurity: { nestedBwrap: true } };
    const containerDescriptor = { containerSecurity: { nestedBwrap: false } };
    const record = (label, securityOpt) => ({
        Config: { Labels: label ? { 'ploinky.security.nested-bwrap': label } : {} },
        HostConfig: { SecurityOpt: securityOpt },
    });

    assert.equal(hasExactNestedBwrapSecurityContract(
        record('unmask-all-v1', ['unmask=ALL']),
        nestedDescriptor,
    ), true);
    assert.equal(hasExactNestedBwrapSecurityContract(
        record('unmask-all-v1', ['label=disable', 'unmask=all']),
        nestedDescriptor,
    ), true);
    assert.equal(hasExactNestedBwrapSecurityContract(
        record('unmask-all-v1', []),
        nestedDescriptor,
    ), false);
    assert.equal(hasExactNestedBwrapSecurityContract(
        record('', ['unmask=ALL']),
        nestedDescriptor,
    ), false);
    assert.equal(hasExactNestedBwrapSecurityContract(
        record('unmask-all-v1', ['unmask=ALL', 'unmask=ALL']),
        nestedDescriptor,
    ), false);
    assert.equal(hasExactNestedBwrapSecurityContract(
        record('unmask-all-v1', ['unmask=/proc/sys']),
        nestedDescriptor,
    ), false);
    assert.equal(hasExactNestedBwrapSecurityContract(
        record('', ['unmask=ALL']),
        containerDescriptor,
    ), false);
    assert.equal(hasExactNestedBwrapSecurityContract(
        record('', ['no-new-privileges']),
        containerDescriptor,
    ), true);
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
        () => resolveContainerSecurity({ containerSecurity: { nestedBwrap: 'true' } }, null),
        (error) => error.code === 'PLOINKY_MANIFEST_SECURITY_INVALID',
    );
    assert.throws(
        () => resolveContainerSecurity({ containerSecurity: { rawArgs: ['--privileged'] } }, null),
        (error) => error.code === 'PLOINKY_MANIFEST_SECURITY_INVALID',
    );
});
