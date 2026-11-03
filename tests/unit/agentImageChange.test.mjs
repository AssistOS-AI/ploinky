import test from 'node:test';
import assert from 'node:assert/strict';

const { containerImageChange } = await import('../../cli/sandbox/docker/agentServiceManager.js');

const A = `sha256:${'a'.repeat(64)}`;
const B = `sha256:${'b'.repeat(64)}`;
const base = { runtime: 'podman', containerName: 'ploinky_repo_demo', imageRef: 'docker.io/o/r:runtime' };

test('equal image IDs report no change', () => {
    assert.equal(containerImageChange(base, { readContainerImageId: () => A, readImageId: () => A }), null);
});

test('different image IDs report observed and desired', () => {
    assert.deepEqual(
        containerImageChange(base, { readContainerImageId: () => A, readImageId: () => B }),
        { observed: A, desired: B },
    );
});

test('an unreadable side never forces a replacement', () => {
    assert.equal(containerImageChange(base, { readContainerImageId: () => null, readImageId: () => B }), null);
    assert.equal(containerImageChange(base, { readContainerImageId: () => A, readImageId: () => null }), null);
});

test('an empty reference, a missing container name or a sandbox runtime report no change', () => {
    const readers = { readContainerImageId: () => A, readImageId: () => B };
    assert.equal(containerImageChange({ ...base, imageRef: '  ' }, readers), null);
    assert.equal(containerImageChange({ ...base, containerName: '' }, readers), null);
    assert.equal(containerImageChange({ ...base, runtime: 'bwrap' }, readers), null);
});
