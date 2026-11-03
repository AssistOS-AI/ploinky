import test from 'node:test';
import assert from 'node:assert/strict';

const { containerImageChange, desiredImageRef, imageChangeDetail, readRuntimeContainerImageId } = await import('../../cli/sandbox/docker/imageChange.mjs');

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

test('the container reader accepts Podman bare hex and Docker sha256: forms and fails closed otherwise', () => {
    const reply = (stdout, status = 0) => () => ({ status, stdout });
    const hex = 'a'.repeat(64);
    assert.equal(readRuntimeContainerImageId('podman', 'c', reply(`${hex}\n`)), A);
    assert.equal(readRuntimeContainerImageId('docker', 'c', reply(`${A}\n`)), A);
    assert.equal(readRuntimeContainerImageId('podman', 'c', reply('nope')), null);
    assert.equal(readRuntimeContainerImageId('podman', 'c', reply(hex, 1)), null);
    assert.equal(readRuntimeContainerImageId('podman', 'c', () => { throw new Error('spawn'); }), null);
    let seen;
    readRuntimeContainerImageId('podman', 'cont', (command, args) => { seen = [command, args]; return { status: 0, stdout: hex }; });
    assert.deepEqual(seen, ['podman', ['container', 'inspect', '--format', '{{.Image}}', 'cont']]);
});

test('Podman bare hex against a Docker-style desired ID is not a change', () => {
    const hex = 'a'.repeat(64);
    const spawn = () => ({ status: 0, stdout: hex });
    assert.equal(containerImageChange(base, {
        readContainerImageId: (runtime, name) => readRuntimeContainerImageId(runtime, name, spawn),
        readImageId: () => A,
    }), null);
});

test('desiredImageRef prefers the catalog image, falls back to the manifest image, and is empty when unresolvable', () => {
    assert.equal(desiredImageRef({ imageRef: ' ghcr.io/o/llm:1 ' }, () => 'manifest:1'), 'ghcr.io/o/llm:1');
    assert.equal(desiredImageRef(null, () => 'manifest:1'), 'manifest:1');
    assert.equal(desiredImageRef({ imageRef: '' }, () => { throw new Error('${X} unresolved'); }), '');
});

test('imageChangeDetail shortens both IDs to twelve digits', () => {
    assert.equal(imageChangeDetail({ observed: A, desired: B }), `image ${'a'.repeat(12)} -> ${'b'.repeat(12)}`);
});
