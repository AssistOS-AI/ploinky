// W4: the dependency installer's identity of an image must be one value for the same image in every launch path. A GPU
// share client is created from the prepared image's immutable ID (a security property that stays), while the cache stamp
// the reference start wrote records the resolved reference; comparing the ID with that stamp reports "installer image
// changed", which reinstalls the dependency caches during Apply or, for a managed adoption, replaces the runtime.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { selectLaunchImages } from '../../cli/sandbox/docker/agentServiceManager.js';
import { isAgentCacheValid, writeStamp } from '../../cli/utils/dependencies/dependencyCache.js';

const REFERENCE = `docker.io/assistos/ploinky-node@sha256:${'a'.repeat(64)}`;
const IMAGE_ID = 'b'.repeat(64);
const RUNTIME_KEY = 'container-linux-x64-glibc-node24';
const installerFor = image => ({ runtimeFamily: 'container', nodeMajor: 24, platform: 'linux', arch: 'x64', variant: 'glibc', installerRuntime: 'podman', image });

function stampedCache(t, image) {
    const cachePath = fs.mkdtempSync(path.join(os.tmpdir(), 'hwl-installer-'));
    t.after(() => fs.rmSync(cachePath, { recursive: true, force: true }));
    fs.mkdirSync(path.join(cachePath, 'node_modules', 'mcp-sdk'), { recursive: true });
    writeStamp(cachePath, { runtimeKey: RUNTIME_KEY, mergedPackageHash: 'm'.repeat(64), agentPackageHash: null, installer: installerFor(image) });
    return cachePath;
}
const valid = (cachePath, image) => isAgentCacheValid(cachePath, { runtimeKey: RUNTIME_KEY, mergedPackageHash: 'm'.repeat(64), agentPackageHash: null, installer: installerFor(image), mcpSdk: null });

test('W4.a-start-by-reference-then-a-recreate-by-id-of-the-same-image-is-no-installer-change', t => {
    // The reference start: the container and the installer both use the resolved reference.
    const first = selectLaunchImages({ resolvedImage: REFERENCE, launch: null });
    assert.deepEqual({ ...first }, { image: REFERENCE, installerImage: REFERENCE });
    const cache = stampedCache(t, first.installerImage);
    // The MPS recreate: the container is created from the immutable ID, the installer identity is unchanged.
    const recreate = selectLaunchImages({ resolvedImage: REFERENCE, launch: { imageId: IMAGE_ID } });
    assert.deepEqual({ ...recreate }, { image: IMAGE_ID, installerImage: REFERENCE });
    assert.deepEqual(valid(cache, recreate.installerImage), { valid: true, reason: 'ok' });
    // What the ID would have reported (the defect): the stamp of the reference start no longer matches.
    assert.match(valid(cache, recreate.image).reason, /^installer image changed \(/);
});

test('W4.a-different-image-still-reports-an-installer-change', t => {
    const cache = stampedCache(t, REFERENCE);
    const other = `docker.io/assistos/ploinky-node@sha256:${'c'.repeat(64)}`;
    for (const launch of [null, { imageId: IMAGE_ID }]) {
        const { installerImage } = selectLaunchImages({ resolvedImage: other, launch });
        assert.equal(installerImage, other);
        assert.match(valid(cache, installerImage).reason, /^installer image changed \(/, launch ? 'a recreate of another image' : 'a start of another image');
    }
});

test('W4.the-dependency-preparation-sites-use-the-installer-identity-and-the-container-uses-the-launch-image', () => {
    const source = fs.readFileSync(new URL('../../cli/sandbox/docker/agentServiceManager.js', import.meta.url), 'utf8');
    assert.match(source, /detectRuntimeKeyForAgent\(manifest, repoName, agentName, profileConfig, installerImage\)/);
    assert.equal((source.match(/image: installerImage,\n\s+runtime,/g) || []).length, 2, 'inspectAgentCache and prepareAgentCache');
    assert.match(source, /args\.push\(image\);/, 'the container itself is created from the launch image');
    assert.match(source, /ensureImagePresent\(image, \{ runtime \}\)/);
});
