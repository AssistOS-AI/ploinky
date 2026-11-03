import test from 'node:test';
import assert from 'node:assert/strict';

import { parseImageReference, repoDigestSet } from '../../cli/sandbox/docker/imageReference.mjs';

const HEX = 'a'.repeat(64);

test('a Docker Hub reference with an explicit host parses to the registry API host', () => {
    const parsed = parseImageReference('docker.io/assistos/roboteam-agent:runtime');
    assert.equal(parsed.registry, 'docker.io');
    assert.equal(parsed.apiHost, 'registry-1.docker.io');
    assert.equal(parsed.repository, 'assistos/roboteam-agent');
    assert.equal(parsed.tag, 'runtime');
    assert.equal(parsed.explicitRegistry, true);
    assert.equal(parsed.pinned, false);
    assert.equal(parsed.canonical, 'docker.io/assistos/roboteam-agent:runtime');
});

test('an unqualified reference is not explicit and defaults to Docker Hub', () => {
    const parsed = parseImageReference('node:18-alpine');
    assert.equal(parsed.explicitRegistry, false);
    assert.equal(parsed.registry, 'docker.io');
    assert.equal(parsed.repository, 'library/node');
    assert.equal(parsed.tag, '18-alpine');
});

test('docker.io/node becomes library/node:latest; index.docker.io normalizes to docker.io', () => {
    const parsed = parseImageReference('docker.io/node');
    assert.equal(parsed.repository, 'library/node');
    assert.equal(parsed.tag, 'latest');
    assert.equal(parseImageReference('index.docker.io/o/r:t').registry, 'docker.io');
});

test('a host with a port keeps it in the API host, and the tag follows the last colon after the last slash', () => {
    const parsed = parseImageReference('localhost:5000/a/b:t');
    assert.equal(parsed.registry, 'localhost:5000');
    assert.equal(parsed.apiHost, 'localhost:5000');
    assert.equal(parsed.repository, 'a/b');
    assert.equal(parsed.tag, 't');
    assert.equal(parseImageReference('localhost/a:1').registry, 'localhost');
    const ghcr = parseImageReference('ghcr.io/o/r:t');
    assert.equal(ghcr.apiHost, 'ghcr.io');
    assert.equal(ghcr.explicitRegistry, true);
});

test('digest references are pinned for any algorithm; malformed references return null', () => {
    assert.equal(parseImageReference(`repo/x:tag@sha256:${HEX}`).pinned, true);
    assert.equal(parseImageReference(`ghcr.io/o/r@sha512:${'b'.repeat(128)}`).pinned, true);
    assert.equal(parseImageReference('ghcr.io/o/r@sha256:short').pinned, false);
    for (const bad of ['', '   ', 'a b', 'ghcr.io/Owner/Repo:t', 'repo:', 'repo@']) {
        assert.equal(parseImageReference(bad), null, JSON.stringify(bad));
    }
    assert.equal(parseImageReference(undefined), null);
});

test('repoDigestSet handles the Docker form, the Podman form with two digests, null, [] and foreign repositories', () => {
    const parsed = parseImageReference('docker.io/assistos/x:runtime');
    const other = 'c'.repeat(64);
    assert.deepEqual([...repoDigestSet([`assistos/x@sha256:${HEX}`], parsed)], [`sha256:${HEX}`]);
    const podman = repoDigestSet([`docker.io/assistos/x@sha256:${HEX}`, `docker.io/assistos/x@sha256:${other}`], parsed);
    assert.deepEqual([...podman].sort(), [`sha256:${HEX}`, `sha256:${other}`].sort());
    assert.equal(repoDigestSet(null, parsed).size, 0);
    assert.equal(repoDigestSet([], parsed).size, 0);
    assert.equal(repoDigestSet([`docker.io/assistos/y@sha256:${HEX}`, `ghcr.io/assistos/x@sha256:${HEX}`, 'junk'], parsed).size, 0);
});
