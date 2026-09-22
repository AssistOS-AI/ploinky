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
const missingSummary = 'The Box AchillesAgentLib bundle is missing or failed verification. '
    + 'Build or pull a compatible Ploinky Box image containing the pinned AchillesAgentLib copy';

function contractInspection(id) {
    return JSON.stringify([{
        Id: id, Os: 'linux', Architecture: 'arm64', Config: {
            User: IMAGE_CONTRACT.user, WorkingDir: IMAGE_CONTRACT.workdir,
            Env: Object.entries(IMAGE_CONTRACT.environment).map(([key, value]) => `${key}=${value}`),
            Entrypoint: [IMAGE_CONTRACT.entrypoint], Cmd: [], Labels: {}, Volumes: {},
        },
    }]);
}

function verificationMessage(result) {
    try {
        probeImageAgentLib('podman', imageId, { query: () => result });
    } catch (error) {
        assert.equal(error.code, 'PLOINKY_BOX_AGENTLIB_INCOMPATIBLE');
        return error.message;
    }
    return assert.fail('verification must fail');
}

test('an offline bundle load never pulls when its image inspection fails', async () => {
    for (const streaming of [false, true]) {
        const calls = [];
        const runner = {
            query(command, args) {
                calls.push([command, ...args]);
                return { ok: false, status: 125, stderr: 'image is no longer present' };
            },
            run(command, args) { calls.push([command, ...args]); },
            ...(streaming ? {
                async stream(command, args) {
                    calls.push([command, ...args]);
                    return { ok: true };
                },
            } : {}),
        };
        await assert.rejects(() => loadBoxAgentLibImage({
            engine, runner, imageRef: 'pinned-image', allowPull: false,
        }), { code: 'PLOINKY_BOX_AGENTLIB_INCOMPATIBLE' });
        assert.deepEqual(calls, [['podman', 'image', 'inspect', 'pinned-image']]);
    }
});

test('image source has no host binds and survives reconstruction with the exact image identity', () => {
    const contract = normalizeBoxAgentLib(selection);
    assert.deepEqual(agentLibMountArgs(contract), []);
    assert.deepEqual(expectedAgentLibMounts(contract), {});
    const container = { labels: agentLibLabels(contract), runtime: { imageId, mounts: [] } };
    assert.deepEqual(agentLibContractFromContainer(container), contract);
    assert.deepEqual(agentLibContractFromContainer({
        ...container, runtime: { ...container.runtime, imageId: imageId.slice(7) },
    }), contract);
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
    assert.deepEqual(probeImageAgentLib('podman', imageId.slice(7), runner), { ...metadata, imageId });
    assert.equal(calls[1].args[5], imageId.slice(7));
    for (const result of [
        { ok: false, status: 1 }, { ok: true, stdout: '{}' },
        { ok: true, stdout: JSON.stringify({ ...metadata, commit: '0'.repeat(40) }) },
        { ok: true, stdout: JSON.stringify({ ...metadata, fingerprint: '' }) },
    ]) assert.throws(() => probeImageAgentLib('podman', imageId, { query: () => result }),
        { code: 'PLOINKY_BOX_AGENTLIB_INCOMPATIBLE' });
});

test('a failed verification prints its own cause, not only the generic summary', () => {
    const mismatch = 'PLOINKY_AGENTLIB_IMAGE_PIN_MISMATCH: The Box image bundles achillesAgentLib '
        + `${'c'.repeat(40)}, but Ploinky requires ${commit}. Rebuild or select a Box image with the required pinned revision.`;
    const missingModule = `Error: Cannot find module '${IMAGE_AGENTLIB_PROBE_PATH}'`;
    const ownership = 'PLOINKY_AGENTLIB_IMAGE_INVALID: Image AgentLib path must be owned by root and not writable '
        + 'by the runtime user: /opt/ploinky-agentlib/package.json.';
    for (const [result, reason] of [
        [{ ok: false, status: 1, stderr: `${mismatch}\n` },
            `The verification command exited with status 1: ${mismatch}`],
        [{ ok: false, status: 1, stderr: `${ownership}\n` },
            `The verification command exited with status 1: ${ownership}`],
        [{ ok: false, status: 1, stderr: ['node:internal/modules/cjs/loader:1386', '  throw err;', '  ^', '',
            missingModule, '    at Function._resolveFilename (node:internal/modules/cjs/loader:1383:15)', '',
            'Node.js v24.8.0', ''].join('\n') },
        `The verification command exited with status 1: ${missingModule}`],
        [{ ok: false, status: 126, stderr: 'crun: unknown version specified\nAuthorization: Bearer secret-verifier-token\n' },
            'The verification command exited with status 126: crun: unknown version specified'],
        [{ ok: false, status: 1, stderr: '', signal: 'SIGTERM',
            error: Object.assign(new Error('spawnSync podman ETIMEDOUT'), { code: 'ETIMEDOUT' }) },
        'The verification command timed out after 60 s.'],
        [{ ok: false, status: 1, stderr: '', error: Object.assign(new Error('spawnSync podman ENOENT'), { code: 'ENOENT' }) },
            'The verification command failed with ENOENT.'],
        [{ ok: false, status: 1, stderr: '', signal: 'SIGKILL' },
            'The verification command was terminated by SIGKILL without output.'],
        [{ ok: false, status: 1 }, 'The verification command exited with status 1 without output.'],
    ]) assert.equal(verificationMessage(result), `${missingSummary}. ${reason}`);
    const redacted = verificationMessage({ ok: false, status: 125,
        stderr: 'Error: registry login failed: token=secret-verifier-token\n' });
    assert.match(redacted, /status 125: Error: registry login failed: token=\[REDACTED\]$/);
    assert.doesNotMatch(redacted, /secret-verifier-token/);
});

test('rejected bundle metadata names the mismatch in the printed message', () => {
    assert.throws(() => probeImageAgentLib('podman', imageId, {
        query: () => ({ ok: true, stdout: JSON.stringify({ ...metadata, commit: '0'.repeat(40) }) }),
    }), {
        code: 'PLOINKY_BOX_AGENTLIB_INCOMPATIBLE',
        message: new RegExp('^The Box AchillesAgentLib bundle does not match the required revision or fingerprint\\. '
            + `Build or pull [^.]+\\. The Box image bundles achillesAgentLib 0{40}, but Ploinky requires ${commit}\\.`),
    });
});

test('image probe delegates the inspected ID to the engine without a format gate', () => {
    for (const inspectedId of ['engine-image-id', 'a'.repeat(12), imageId.slice(7)]) {
        const engineFailure = new Error('engine rejected the image');
        assert.throws(() => probeImageAgentLib('podman', inspectedId, {
            query(_engine, args) {
                assert.equal(args[5], inspectedId);
                throw engineFailure;
            },
        }), error => error === engineFailure);
    }
});

for (const inspectedId of [imageId, imageId.slice(7)]) {
    test(`bundle loader accepts ${inspectedId.startsWith('sha256:') ? 'prefixed' : 'bare'} IDs without pulling or host Git`, async () => {
        const calls = [];
        const runner = { query(command, args) {
            calls.push([command, ...args]);
            if (args[0] === 'image') return { ok: true, stdout: JSON.stringify([{
                Id: inspectedId, Os: 'linux', Architecture: 'arm64', Config: {
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
}

test('a refreshing bundle load pulls a present reference before selecting from it', async () => {
    for (const streaming of [false, true]) {
        const calls = [];
        const runner = {
            query(_command, args) {
                calls.push(args.slice(0, 2).join(' '));
                return args[0] === 'image'
                    ? { ok: true, stdout: contractInspection(imageId) }
                    : { ok: true, stdout: JSON.stringify(metadata) };
            },
            run(_command, args) { calls.push(args.join(' ')); },
            ...(streaming ? {
                async stream(_command, args) {
                    calls.push(args.join(' '));
                    return { ok: true };
                },
            } : {}),
        };
        assert.deepEqual(await loadBoxAgentLibImage({ engine, runner, imageRef: 'pinned-image', refresh: true }),
            { ...metadata, imageId });
        assert.deepEqual(calls, ['pull pinned-image', 'image inspect', 'run --rm']);
    }
});

test('a failed refresh never falls back to the older local tag', async () => {
    const calls = [];
    const runner = {
        query(_command, args) {
            calls.push(args.slice(0, 2).join(' '));
            return { ok: true, stdout: contractInspection(imageId) };
        },
        async stream(_command, args) {
            calls.push(args.join(' '));
            return { ok: false, status: 125, stderr: 'Error: registry unreachable' };
        },
    };
    await assert.rejects(() => loadBoxAgentLibImage({ engine, runner, imageRef: 'pinned-image', refresh: true }),
        { code: 'PLOINKY_BOX_AGENTLIB_INCOMPATIBLE', message: /^Unable to pull the Box image/ });
    assert.deepEqual(calls, ['pull pinned-image']);
});

test('an image refresh is refused where pulling is not allowed', async () => {
    await assert.rejects(() => loadBoxAgentLibImage({
        engine, imageRef: 'pinned-image', refresh: true, allowPull: false,
        runner: { query: () => assert.fail('a refused refresh must not inspect the image') },
    }), { code: 'PLOINKY_BOX_AGENTLIB_REFRESH_INVALID' });
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
