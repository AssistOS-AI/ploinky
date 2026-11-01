import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { verifyCgroupContainerConfiguration, CGROUP_ENTRYPOINT, CGROUP_HELPER_DIRECTORY,
    CGROUP_HELPER_SOURCE, CGROUP_SUBTREE_PATH } from '../../cli/sandbox/cgroupSubtree.mjs';

const podmanHostConfig = JSON.parse(fs.readFileSync(new URL('../fixtures/cgroup/podman-inspect-host-config.json', import.meta.url)));
const id = 'a'.repeat(64);
const descriptor = { cgroupDelegation: { cgroupNamespace: 'cgroup:[100]', pidNamespace: 'pid:[101]' } };
function verify(HostConfig) {
    verifyCgroupContainerConfiguration({ descriptor, containerId: id, record: {
        Id: id, HostConfig, Config: { User: '', Entrypoint: [CGROUP_ENTRYPOINT],
            Cmd: ['cgroup:[100]', 'pid:[101]'], Env: [`PLOINKY_CGROUP_SUBTREE=${CGROUP_SUBTREE_PATH}`] },
        Mounts: [{ Source: CGROUP_HELPER_SOURCE, Destination: CGROUP_HELPER_DIRECTORY, RW: false }],
    } });
}

test('actual never-started Podman inspection reports private cgroup namespace as CgroupMode', () => {
    assert.equal(podmanHostConfig.CgroupMode, 'private');
    assert.equal(podmanHostConfig.CgroupnsMode, null);
    assert.doesNotThrow(() => verify(podmanHostConfig));
});

test('Docker-compatible private cgroup namespace is accepted when Podman field is absent', () => {
    assert.doesNotThrow(() => verify({ PidMode: 'private', CgroupnsMode: 'private' }));
    assert.doesNotThrow(() => verify({ PidMode: 'private', CgroupMode: null, CgroupnsMode: 'private' }));
    assert.doesNotThrow(() => verify({ PidMode: 'private', CgroupMode: 'private', CgroupnsMode: 'private' }));
});

test('conflicting, absent, host, empty or malformed cgroup namespace inspection refuses', () => {
    for (const fields of [
        { CgroupMode: 'host', CgroupnsMode: 'private' },
        { CgroupMode: 'private', CgroupnsMode: 'host' },
        { CgroupMode: 'private', CgroupnsMode: '' },
        { CgroupMode: '' }, { CgroupMode: 'host' }, { CgroupMode: true },
        { CgroupMode: 'private', CgroupnsMode: ['private'] }, {},
    ]) assert.throws(() => verify({ PidMode: 'private', ...fields }), { code: 'PLOINKY_CGROUP_DELEGATION_UNAVAILABLE' });
});

test('accepting Podman cgroup field does not accept a shared PID namespace', () => {
    assert.throws(() => verify({ ...podmanHostConfig, PidMode: 'host' }), { code: 'PLOINKY_CGROUP_DELEGATION_UNAVAILABLE' });
});
