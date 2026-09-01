import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const NESTED_PODMAN_SECCOMP_RELATIVE_PATH =
    'ploinky-box/seccomp/podman-nested-pid-fallback.json';
export const NESTED_PODMAN_SECCOMP_BOX_PATH =
    path.posix.join('/opt/ploinky', NESTED_PODMAN_SECCOMP_RELATIVE_PATH);

export function nestedPodmanSeccompProfilePath(repositoryRoot) {
    const root = path.resolve(String(repositoryRoot || ''));
    return path.join(root, NESTED_PODMAN_SECCOMP_RELATIVE_PATH);
}

export function nestedPodmanSeccompProfileContract(repositoryRoot, { fsApi = fs } = {}) {
    const root = path.resolve(String(repositoryRoot || ''));
    const profilePath = nestedPodmanSeccompProfilePath(repositoryRoot);
    const stat = fsApi.lstatSync(profilePath);
    assert.equal(stat.isSymbolicLink(), false, 'nested Podman seccomp profile must not be a symlink');
    assert.equal(stat.isFile(), true, 'nested Podman seccomp profile must be a regular file');
    assert.equal(
        fsApi.realpathSync(profilePath),
        path.join(fsApi.realpathSync(root), NESTED_PODMAN_SECCOMP_RELATIVE_PATH),
        'nested Podman seccomp profile must resolve inside the repository');
    const profileBytes = fsApi.readFileSync(profilePath);
    const profile = JSON.parse(profileBytes.toString('utf8'));
    assert.equal(profile.defaultAction, 'SCMP_ACT_ERRNO');
    const matching = profile.syscalls?.filter((entry) => entry.names?.includes('name_to_handle_at'));
    assert.deepEqual(matching?.map((entry) => ({
        action: entry.action,
        errnoRet: entry.errnoRet,
    })), [{ action: 'SCMP_ACT_ERRNO', errnoRet: 95 }],
    'name_to_handle_at must return ENOTSUP so nested Podman uses start-time PID identity');
    return Object.freeze({
        path: profilePath,
        fingerprint: crypto.createHash('sha256').update(profileBytes).digest('hex'),
    });
}

export function validateNestedPodmanSeccompProfile(repositoryRoot, options) {
    return nestedPodmanSeccompProfileContract(repositoryRoot, options).path;
}
