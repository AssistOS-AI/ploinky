import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
    NESTED_PODMAN_SECCOMP_RELATIVE_PATH,
    nestedPodmanSeccompProfileContract,
    nestedPodmanSeccompProfilePath,
    validateNestedPodmanSeccompProfile,
} from '../../ploinky-box/seccomp.mjs';

const repositoryRoot = path.resolve(new URL('../..', import.meta.url).pathname);

test('nested Podman seccomp profile pins the PID-handle fallback contract', () => {
    const profilePath = validateNestedPodmanSeccompProfile(repositoryRoot);
    const contract = nestedPodmanSeccompProfileContract(repositoryRoot);
    assert.equal(profilePath, path.join(repositoryRoot, NESTED_PODMAN_SECCOMP_RELATIVE_PATH));
    assert.equal(contract.path, profilePath);
    assert.equal(contract.fingerprint, '4a226832feffda3ad82f745b0595cdd23f65a6203041ba5b4487cda43e838f99');
    const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    const matching = profile.syscalls.filter((entry) => (
        entry.names.includes('name_to_handle_at')
    ));
    assert.deepEqual(matching.map(({ names, action, errnoRet }) => ({
        names,
        action,
        errnoRet,
    })), [{
        names: ['name_to_handle_at'],
        action: 'SCMP_ACT_ERRNO',
        errnoRet: 95,
    }]);
    assert.equal(profile.syscalls.some((entry) => (
        entry.action === 'SCMP_ACT_ALLOW'
        && entry.names.includes('name_to_handle_at')
    )), false);
});
