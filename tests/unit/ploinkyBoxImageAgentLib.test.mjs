import assert from 'node:assert/strict';
import test from 'node:test';
import {
    canonicalAgentLibRemote,
    imageSourceId,
} from '../../agentlib/contract.mjs';
import {
    agentLibContractFromContainer,
    agentLibLabels,
    agentLibMountArgs,
    agentLibSelectionChanged,
    expectedAgentLibMounts,
    normalizeBoxAgentLib,
} from '../../ploinky-box/contract/agentlib.mjs';
import { IMAGE_CONTRACT } from '../../ploinky-box/contract/image.mjs';
import {
    IMAGE_AGENTLIB_PROBE_PATH,
    loadBoxAgentLibImage,
    probeImageAgentLib,
    revalidateContainerAgentLib,
} from '../../ploinky-box/image-agentlib.mjs';

const imageId = `sha256:${'a'.repeat(64)}`;
const fingerprint = 'b'.repeat(64);
const commit = canonicalAgentLibRemote().commit;
const metadata = { schemaVersion: 1, commit, fingerprint };
const engine = { name: 'podman' };
const selection = {
    mode: 'image', imageId, sourceDir: '/opt/ploinky-agentlib',
    sourceRelativePath: 'image', contentFingerprint: fingerprint,
    resolvedCommit: commit, sourceId: imageSourceId(imageId, fingerprint),
};

test('image source has no host binds and survives reconstruction with the exact image identity', () => {
    const contract = normalizeBoxAgentLib(selection);
    assert.deepEqual(agentLibMountArgs(contract), []);
    assert.deepEqual(expectedAgentLibMounts(contract), {});
    const container = { labels: agentLibLabels(contract), runtime: { imageId, mounts: [] } };
    assert.deepEqual(agentLibContractFromContainer(container), contract);
    assert.equal(agentLibSelectionChanged(contract, normalizeBoxAgentLib(contract)), false);
    assert.equal(agentLibSelectionChanged(contract, { ...contract, mode: 'local' }), true);
    assert.throws(() => agentLibContractFromContainer({
        ...container, runtime: { ...container.runtime, imageId: `sha256:${'c'.repeat(64)}` },
    }), /immutable identity/);
    assert.throws(() => agentLibContractFromContainer({
        ...container, runtime: { ...container.runtime, mounts: [{ destination: '/opt/ploinky-agentlib' }] },
    }), /must not have a source bind/);
    for (const change of [
        { sourceDir: '/tmp/fake' }, { sourceRelativePath: 'fake' }, { resolvedCommit: '' },
        { sourceId: { device: '1', inode: '2' } }, { imageId: 'latest' },
    ]) assert.throws(() => normalizeBoxAgentLib({ ...selection, ...change }));
});

test('immutable image probe runs offline and checks the required pin', () => {
    const calls = [];
    const runner = { query(command, args, options) {
        calls.push({ command, args, options });
        return { ok: true, stdout: JSON.stringify(metadata) };
    } };
    assert.deepEqual(probeImageAgentLib('podman', imageId, runner), { ...metadata, imageId });
    assert.deepEqual(calls[0].args, [
        'run', '--rm', '--network=none', '--pull=never', '--entrypoint=/usr/local/bin/node',
        imageId, IMAGE_AGENTLIB_PROBE_PATH, 'verify', '--expected-commit', commit,
    ]);
    assert.equal(calls[0].options.timeoutMs, 60_000);
    for (const result of [
        { ok: false, status: 1 }, { ok: true, stdout: '{}' },
        { ok: true, stdout: JSON.stringify({ ...metadata, commit: '0'.repeat(40) }) },
        { ok: true, stdout: JSON.stringify({ ...metadata, fingerprint: '' }) },
    ]) assert.throws(() => probeImageAgentLib('podman', imageId, { query: () => result }),
        { code: 'PLOINKY_BOX_AGENTLIB_INCOMPATIBLE' });
    assert.throws(() => probeImageAgentLib('podman', 'latest', runner), /immutable image ID/);
});

test('bundle loader uses a cached image without pulling and never runs host Git', async () => {
    const calls = [];
    const runner = { query(command, args) {
        calls.push([command, ...args]);
        if (args[0] === 'image') return { ok: true, stdout: JSON.stringify([{
            Id: imageId, Os: 'linux', Architecture: 'arm64', Config: {
                User: IMAGE_CONTRACT.user, WorkingDir: IMAGE_CONTRACT.workdir,
                Env: Object.entries(IMAGE_CONTRACT.environment).map(([key, value]) => `${key}=${value}`),
                Entrypoint: [IMAGE_CONTRACT.entrypoint], Cmd: [], Labels: {}, Volumes: {},
            },
        }]) };
        return { ok: true, stdout: JSON.stringify(metadata) };
    }, run() { assert.fail('cached bundle must not pull or run a host command'); } };
    assert.deepEqual(await loadBoxAgentLibImage({ engine, runner, imageRef: 'pinned-image' }), { ...metadata, imageId });
    assert.deepEqual(calls.map(call => call.slice(0, 2)), [['podman', 'image'], ['podman', 'run']]);
});

test('running bundle verification rejects fingerprint drift and uses the admitted revision', () => {
    const contract = normalizeBoxAgentLib(selection);
    let args;
    const context = { engine, containerId: 'container', runner: { query(_command, input) {
        args = input;
        return { ok: true, stdout: JSON.stringify(metadata) };
    } } };
    assert.equal(revalidateContainerAgentLib(contract, context), contract);
    assert.deepEqual(args.slice(0, 3), ['exec', 'container', '/usr/local/bin/node']);
    assert.equal(args.at(-1), commit);
    assert.throws(() => revalidateContainerAgentLib(contract, {
        ...context, runner: { query: () => ({ ok: true, stdout: JSON.stringify({ ...metadata, fingerprint: 'c'.repeat(64) }) }) },
    }), /fingerprint changed/);
});
