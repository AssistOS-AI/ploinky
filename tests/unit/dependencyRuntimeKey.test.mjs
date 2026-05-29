import test from 'node:test';
import assert from 'node:assert/strict';

import {
    detectHostRuntimeKey,
    detectContainerRuntimeKey,
    parseContainerProbeOutput,
    parseRuntimeKey,
    normalizeRuntimeFamily,
    buildRuntimeKey,
    SUPPORTED_FAMILIES,
} from '../../cli/services/dependencyRuntimeKey.js';

test('detectHostRuntimeKey returns <family>-<platform>-<arch>-node<major> for bwrap', () => {
    const key = detectHostRuntimeKey('bwrap');
    const parsed = parseRuntimeKey(key);
    assert.ok(parsed, 'key should parse');
    assert.equal(parsed.family, 'bwrap');
    assert.equal(parsed.platform, process.platform);
    assert.equal(parsed.arch, process.arch);
    assert.equal(parsed.nodeMajor, parseInt(process.versions.node.split('.')[0], 10));
});

test('detectHostRuntimeKey works for seatbelt', () => {
    const key = detectHostRuntimeKey('seatbelt');
    assert.ok(key.startsWith('seatbelt-'), `unexpected: ${key}`);
});

test('detectHostRuntimeKey rejects container family', () => {
    assert.throws(() => detectHostRuntimeKey('container'), /does not support container/);
});

test('normalizeRuntimeFamily maps docker/podman to container', () => {
    assert.equal(normalizeRuntimeFamily('docker'), 'container');
    assert.equal(normalizeRuntimeFamily('podman'), 'container');
    assert.equal(normalizeRuntimeFamily('bwrap'), 'bwrap');
    assert.equal(normalizeRuntimeFamily('seatbelt'), 'seatbelt');
});

test('buildRuntimeKey rejects unsupported family', () => {
    assert.throws(
        () => buildRuntimeKey({ family: 'foo', platform: 'linux', arch: 'x64', nodeMajor: 20 }),
        /Unsupported runtime family/,
    );
});

test('buildRuntimeKey rejects incomplete inputs', () => {
    assert.throws(
        () => buildRuntimeKey({ family: 'bwrap', platform: '', arch: 'x64', nodeMajor: 20 }),
        /Incomplete runtime-key inputs/,
    );
});

test('parseRuntimeKey round-trips', () => {
    const key = buildRuntimeKey({ family: 'bwrap', platform: 'linux', arch: 'x64', nodeMajor: 20 });
    assert.equal(key, 'bwrap-linux-x64-node20');
    assert.deepEqual(parseRuntimeKey(key), {
        family: 'bwrap',
        platform: 'linux',
        arch: 'x64',
        variant: '',
        nodeMajor: 20,
    });
});

test('buildRuntimeKey supports container variant suffixes', () => {
    const key = buildRuntimeKey({ family: 'container', platform: 'linux', arch: 'x64', variant: 'musl', nodeMajor: 20 });
    assert.equal(key, 'container-linux-x64-musl-node20');
    assert.deepEqual(parseRuntimeKey(key), {
        family: 'container',
        platform: 'linux',
        arch: 'x64',
        variant: 'musl',
        nodeMajor: 20,
    });
});

test('parseRuntimeKey returns null for malformed input', () => {
    assert.equal(parseRuntimeKey('not-a-key'), null);
    assert.equal(parseRuntimeKey(''), null);
    assert.equal(parseRuntimeKey(null), null);
});

test('parseContainerProbeOutput validates libc-aware probe payloads', () => {
    assert.deepEqual(
        parseContainerProbeOutput('{"platform":"linux","arch":"x64","nodeMajor":20,"libc":"musl"}'),
        { platform: 'linux', arch: 'x64', nodeMajor: 20, variant: 'musl' },
    );
    assert.deepEqual(
        parseContainerProbeOutput('{"platform":"linux","arch":"arm64","nodeMajor":22,"libc":"glibc"}'),
        { platform: 'linux', arch: 'arm64', nodeMajor: 22, variant: 'glibc' },
    );
});

test('detectContainerRuntimeKey accepts injected probe executor', () => {
    const key = detectContainerRuntimeKey({
        image: 'node:20-alpine',
        runtime: 'podman',
        ensureImage() {},
        execProbe() {
            return '{"platform":"linux","arch":"x64","nodeMajor":20,"libc":"musl"}';
        },
    });
    assert.equal(key, 'container-linux-x64-musl-node20');
});

test('detectContainerRuntimeKey ensures the image is present before probing', () => {
    const calls = [];
    const key = detectContainerRuntimeKey({
        image: 'node:20-alpine',
        runtime: 'podman',
        ensureImage({ image }) {
            calls.push(`ensure:${image}`);
        },
        execProbe({ image }) {
            calls.push(`probe:${image}`);
            return '{"platform":"linux","arch":"x64","nodeMajor":20,"libc":"musl"}';
        },
    });
    assert.deepEqual(calls, ['ensure:node:20-alpine', 'probe:node:20-alpine']);
    assert.equal(key, 'container-linux-x64-musl-node20');
});

test('detectContainerRuntimeKey resolves manifest image templates before probing', () => {
    let probedImage = '';
    const key = detectContainerRuntimeKey({
        manifest: {
            container: 'example/service:${SERVICE_VERSION}',
            env: [
                {
                    name: 'SERVICE_VERSION',
                    default: 'v9',
                },
            ],
        },
        runtime: 'podman',
        ensureImage() {},
        execProbe({ image }) {
            probedImage = image;
            return '{"platform":"linux","arch":"x64","nodeMajor":20,"libc":"glibc"}';
        },
    });

    assert.equal(probedImage, 'example/service:v9');
    assert.equal(key, 'container-linux-x64-glibc-node20');
});

test('detectContainerRuntimeKey requires an image', () => {
    assert.throws(() => detectContainerRuntimeKey({ execProbe: () => '' }), /requires an image/);
});

test('SUPPORTED_FAMILIES includes bwrap, seatbelt, container', () => {
    assert.ok(SUPPORTED_FAMILIES.has('bwrap'));
    assert.ok(SUPPORTED_FAMILIES.has('seatbelt'));
    assert.ok(SUPPORTED_FAMILIES.has('container'));
});
