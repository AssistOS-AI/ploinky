import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildContainerSecurityArgs,
    resolveContainerSecurity,
} from '../../cli/sandbox/docker/containerSecurity.js';

test('container security defaults to no extra runtime flags', () => {
    assert.deepEqual(resolveContainerSecurity({}, null), { privileged: false });
    assert.deepEqual(buildContainerSecurityArgs(resolveContainerSecurity({}, null)), []);
});

test('container security emits only the allowlisted privileged flag', () => {
    const manifest = {
        containerSecurity: {
            privileged: true,
            raw: ['--cap-add=SYS_ADMIN'],
        },
    };

    assert.deepEqual(resolveContainerSecurity(manifest, null), { privileged: true });
    assert.deepEqual(buildContainerSecurityArgs(resolveContainerSecurity(manifest, null)), ['--privileged']);
});

test('profile container security overrides root security', () => {
    const manifest = { containerSecurity: { privileged: true } };
    const profile = { containerSecurity: { privileged: false } };

    assert.deepEqual(resolveContainerSecurity(manifest, profile), { privileged: false });
    assert.deepEqual(buildContainerSecurityArgs(resolveContainerSecurity(manifest, profile)), []);
});
