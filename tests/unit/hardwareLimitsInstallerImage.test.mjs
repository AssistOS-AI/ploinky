// W4: the dependency installer's identity of an image must be one value for the same image in every launch path. A GPU
// share client is created from the prepared image's immutable ID (a security property that stays), while the dependency
// generation the reference start admitted records the image the resolved reference names. The immutable dependency store
// (runtimeDependencyReuseProblem) compares resolved immutable image IDs, so a recreate by the ID of the same image is no
// dependency change, and the dependency sites keep the resolved reference as their installer identity.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { selectLaunchImages } from '../../cli/sandbox/docker/agentServiceManager.js';
import { noCacheDependencyRecord, runtimeDependencyReuseProblem } from '../../cli/utils/dependencies/store/runtimeDependencies.mjs';

const REFERENCE = `docker.io/assistos/ploinky-node@sha256:${'a'.repeat(64)}`;
const IMAGE_ID = 'b'.repeat(64);
const OTHER = `docker.io/assistos/ploinky-node@sha256:${'c'.repeat(64)}`;
const RUNTIME_KEY = 'container-linux-x64-glibc-node24';
// What the engine reports for each name: the reference and its own immutable ID are one image (podman prints bare hex).
const IDENTITIES = new Map([[REFERENCE, `sha256:${IMAGE_ID}`], [IMAGE_ID, IMAGE_ID], [OTHER, `sha256:${'c'.repeat(64)}`]]);
const inspectImage = ({ image }) => {
    if (!IDENTITIES.has(image)) throw new Error(`unknown image ${image}`);
    return IDENTITIES.get(image);
};
// The dependency record the reference start admitted: no dependency generation is needed for this image, and the record names the
// immutable image ID it was admitted against.
const admittedFor = (reference) => ({ dependencies: noCacheDependencyRecord('no-node-image', {
    family: 'container', runtimeKey: RUNTIME_KEY, imageId: `sha256:${inspectImage({ image: reference }).replace(/^sha256:/, '')}`,
}) });
const reuseProblem = (record, image) => runtimeDependencyReuseProblem({
    record, family: 'container', needsDependencies: true, agentCodePath: '/unused', registration: 'ploinky_demo_agent', engine: 'podman', image, noNodeAllowed: true,
}, { inspectImage });

test('W4.a-start-by-reference-then-a-recreate-by-id-of-the-same-image-is-no-installer-change', () => {
    // The reference start: the container and the installer both use the resolved reference.
    const first = selectLaunchImages({ resolvedImage: REFERENCE, launch: null });
    assert.deepEqual({ ...first }, { image: REFERENCE, installerImage: REFERENCE });
    const admitted = admittedFor(first.installerImage);
    assert.equal(reuseProblem(admitted, first.installerImage), '', 'the admitted runtime is reusable for its own image');
    // The MPS recreate: the container is created from the immutable ID, the installer identity is unchanged.
    const recreate = selectLaunchImages({ resolvedImage: REFERENCE, launch: { imageId: IMAGE_ID } });
    assert.deepEqual({ ...recreate }, { image: IMAGE_ID, installerImage: REFERENCE });
    assert.equal(reuseProblem(admitted, recreate.installerImage), '');
    // The immutable ID resolves to the same image identity as the reference, so even the ID is no "runtime image changed".
    assert.equal(reuseProblem(admitted, recreate.image), '');
});

test('W4.a-different-image-still-reports-an-installer-change', () => {
    const admitted = admittedFor(REFERENCE);
    for (const launch of [null, { imageId: IMAGE_ID }]) {
        const { installerImage } = selectLaunchImages({ resolvedImage: OTHER, launch });
        assert.equal(installerImage, OTHER);
        assert.equal(reuseProblem(admitted, installerImage), 'runtime image changed', launch ? 'a recreate of another image' : 'a start of another image');
    }
});

test('W4.the-dependency-preparation-sites-use-the-installer-identity-and-the-container-uses-the-launch-image', () => {
    const source = fs.readFileSync(new URL('../../cli/sandbox/docker/agentServiceManager.js', import.meta.url), 'utf8');
    assert.match(source, /detectRuntimeKeyForAgent\(manifest, repoName, agentName, profileConfig, installerImage\)/);
    // The immutable dependency store sites: the adoption reuse check, the preparation and the no-cache record take the installer identity.
    assert.match(source, /containerDependencyReuseProblem\(\{\s*agentName, manifest, profileConfig, record: launchRecord, runtime, image: installerImage, containerName,/);
    assert.match(source, /prepareRuntimeDependencies\(\{\s*family: 'container',\s*runtimeKey,\s*engine: runtime,\s*image: installerImage,/);
    assert.match(source, /inspectContainerImageId\(runtime, installerImage\)/);
    assert.match(source, /args\.push\(image\);/, 'the container itself is created from the launch image');
    assert.match(source, /ensureImagePresent\(image, \{ runtime \}\)/);
});
