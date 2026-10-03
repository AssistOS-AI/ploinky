import assert from 'node:assert/strict';
import test from 'node:test';
import { imageSourceIdentity } from '../../agentlib/contract.mjs';
import {
    agentLibContractFromContainer,
    agentLibEnvArgs,
    agentLibLabels,
    agentLibMountArgs,
    agentLibSelectionChanged,
    boxImageIdEnv,
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
const engine = { name: 'podman' };
const PROVENANCE = {
    schema: 'ploinky.box.library/v1', library: 'achillesAgentLib', packageName: 'ploinky-agent-lib', packageVersion: '1.2.3',
    repository: 'https://github.com/AssistOS-AI/AchillesAgentLib.git', branch: 'master', commit: 'c'.repeat(40),
};
const report = {
    schema: 'ploinky.box.library-inspect/v1', library: 'achillesAgentLib',
    packageName: 'ploinky-agent-lib', packageVersion: '1.2.3', provenance: PROVENANCE,
};
const informational = {
    repository: PROVENANCE.repository, branch: 'master', commit: 'c'.repeat(40), packageVersion: '1.2.3',
};
const selection = {
    mode: 'image', supplyingImageId: imageId, sourceDir: '/opt/ploinky-agentlib',
    sourceRelativePath: 'image', sourceId: imageSourceIdentity(imageId),
};
const missingSummary = 'The Box AchillesAgentLib package is missing or failed inspection. '
    + 'Build or pull a compatible Ploinky Box image containing a usable AchillesAgentLib package';

function contractInspection(id) {
    return JSON.stringify([{
        Id: id, Os: 'linux', Architecture: 'arm64', Config: {
            User: IMAGE_CONTRACT.user, WorkingDir: IMAGE_CONTRACT.workdir,
            Env: Object.entries(IMAGE_CONTRACT.environment).map(([key, value]) => `${key}=${value}`),
            Entrypoint: [IMAGE_CONTRACT.entrypoint], Cmd: [], Labels: {}, Volumes: {},
        },
    }]);
}

function inspectionMessage(result) {
    try {
        probeImageAgentLib('podman', imageId, { query: () => result });
    } catch (error) {
        assert.equal(error.code, 'PLOINKY_BOX_AGENTLIB_INCOMPATIBLE');
        return error.message;
    }
    return assert.fail('inspection must fail');
}

test('an offline image load never pulls when its image inspection fails', async () => {
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

test('an image source has no host binds and survives reconstruction with the exact image identity', () => {
    const contract = normalizeBoxAgentLib(selection);
    assert.equal(contract.supplyingImageId, imageId);
    for (const absent of ['fingerprint', 'commit', 'imageId']) {
        assert.equal(Object.hasOwn(contract, absent), false, `an image contract must not carry ${absent}`);
    }
    assert.deepEqual(agentLibMountArgs(contract), []);
    assert.deepEqual(expectedAgentLibMounts(contract), {});
    const container = { labels: agentLibLabels(contract), runtime: { imageId, mounts: [] } };
    assert.deepEqual(Object.keys(container.labels).sort(), [
        'io.assistos.ploinky-box.agentlib-mode',
        'io.assistos.ploinky-box.agentlib-source-id',
        'io.assistos.ploinky-box.agentlib-source-path',
    ], 'no fingerprint or commit label is emitted for an image source');
    assert.deepEqual(agentLibContractFromContainer(container), contract);
    assert.deepEqual(agentLibContractFromContainer({
        ...container, runtime: { ...container.runtime, imageId: imageId.slice(7) },
    }), contract);
    assert.equal(agentLibSelectionChanged(contract, normalizeBoxAgentLib(contract)), false);
    assert.equal(agentLibSelectionChanged(contract, { ...contract, mode: 'local' }), true);
    assert.equal(agentLibSelectionChanged(contract, normalizeBoxAgentLib({
        ...selection, supplyingImageId: `sha256:${'d'.repeat(64)}`, sourceId: imageSourceIdentity(`sha256:${'d'.repeat(64)}`),
    })), true, 'a different supplying image is a change');
    assert.throws(() => agentLibContractFromContainer({
        ...container, runtime: { ...container.runtime, imageId: `sha256:${'c'.repeat(64)}` },
    }), /incompatible path or immutable identity/);
    assert.throws(() => agentLibContractFromContainer({
        ...container, runtime: { ...container.runtime, mounts: [{ destination: '/opt/ploinky-agentlib' }] },
    }), /must not have a source bind/);
    for (const change of [
        { sourceDir: '/tmp/fake' }, { sourceRelativePath: 'fake' },
        { sourceId: { device: '1', inode: '2' } }, { supplyingImageId: 'latest' },
    ]) assert.throws(() => normalizeBoxAgentLib({ ...selection, ...change }));
    // The shape earlier versions wrote for an image Box (fingerprint labels) is not an image contract,
    // and the refusal carries the existing incompatible-Box recovery guidance.
    assert.throws(() => agentLibContractFromContainer({
        labels: {
            ...container.labels,
            'io.assistos.ploinky-box.agentlib-source-id': 'e'.repeat(64),
            'io.assistos.ploinky-box.agentlib-fingerprint': 'f'.repeat(64),
            'io.assistos.ploinky-box.agentlib-commit': 'b'.repeat(40),
        },
        runtime: { imageId, mounts: [] },
    }), (error) => error.code === 'PLOINKY_BOX_AGENTLIB_INCOMPATIBLE'
        && /incompatible path or immutable identity/.test(error.message)
        && /back up any Box-only data, then run 'ploinky stop' and 'ploinky destroy' before retrying$/.test(error.message));
});

test('the Box environment carries the outer image ID in both modes and no fingerprint for an image source', () => {
    const contract = normalizeBoxAgentLib(selection);
    const env = Object.fromEntries(agentLibEnvArgs(contract).filter((_, index) => index % 2 === 1).map((entry) => entry.split(/=(.*)/s).slice(0, 2)));
    assert.deepEqual(Object.keys(env).sort(), ['PLOINKY_AGENTLIB_DIR', 'PLOINKY_AGENTLIB_MODE', 'PLOINKY_AGENTLIB_SOURCE_ID']);
    assert.deepEqual(boxImageIdEnv(imageId), { PLOINKY_BOX_IMAGE_ID: imageId });
    assert.deepEqual(boxImageIdEnv(imageId.slice(7)), { PLOINKY_BOX_IMAGE_ID: imageId }, 'a bare engine ID is normalized');
    for (const bad of ['docker.io/assistos/ploinky-box:latest', '', undefined]) {
        assert.throws(() => boxImageIdEnv(bad), /immutable sha256/, String(bad));
    }
});

test('the immutable image probe runs offline, asks the image to inspect its own package and compares no revision', () => {
    const calls = [];
    const runner = { query(command, args, options) {
        calls.push({ command, args, options });
        return { ok: true, stdout: JSON.stringify(report) };
    } };
    const bundle = probeImageAgentLib('podman', imageId, runner);
    assert.deepEqual(bundle, {
        packageName: 'ploinky-agent-lib', packageVersion: '1.2.3', provenance: informational, supplyingImageId: imageId,
    });
    assert.deepEqual(calls[0].args, [
        'run', '--rm', '--network=none', '--pull=never', '--entrypoint=/usr/local/bin/node',
        imageId, IMAGE_AGENTLIB_PROBE_PATH, 'inspect', 'achillesAgentLib',
    ]);
    assert.equal(IMAGE_AGENTLIB_PROBE_PATH, '/usr/local/share/ploinky/smoke-libraries.mjs');
    assert.equal(calls[0].options.timeoutMs, 60_000);
    assert.deepEqual(probeImageAgentLib('podman', imageId.slice(7), runner).supplyingImageId, imageId);
    assert.equal(calls[1].args[5], imageId.slice(7));
    for (const result of [
        { ok: false, status: 1 }, { ok: true, stdout: '{}' }, { ok: true, stdout: 'not json' },
        { ok: true, stdout: JSON.stringify({ ...report, packageName: 'something-else' }) },
    ]) assert.throws(() => probeImageAgentLib('podman', imageId, { query: () => result }),
        { code: 'PLOINKY_BOX_AGENTLIB_INCOMPATIBLE' });
});

test('provenance is optional: an absent, partial or malformed record never blocks a usable package', () => {
    const unavailable = { repository: null, branch: null, commit: null, packageVersion: null };
    for (const [stdout, expected] of [
        // The package's own version is reported even when the build record is not.
        [{ packageName: 'ploinky-agent-lib', packageVersion: '1.2.3', provenance: null }, { ...unavailable, packageVersion: '1.2.3' }],
        [{ packageName: 'ploinky-agent-lib' }, unavailable],
        [{ packageName: 'ploinky-agent-lib', provenance: { commit: 'not-a-commit', branch: 7 } }, unavailable],
        [{ packageName: 'ploinky-agent-lib', provenance: { commit: 'a'.repeat(40) } }, { ...unavailable, commit: 'a'.repeat(40) }],
    ]) {
        const bundle = probeImageAgentLib('podman', imageId, { query: () => ({ ok: true, stdout: JSON.stringify(stdout) }) });
        assert.equal(bundle.packageName, 'ploinky-agent-lib');
        assert.deepEqual(bundle.provenance, expected);
    }
});

test('a failed inspection prints its own cause, not only the generic summary', () => {
    const missingModule = `Error: Cannot find module '${IMAGE_AGENTLIB_PROBE_PATH}'`;
    const smokeFailure = 'ploinky-box library check failed: The AgentLib copy is missing LLMAgents/openAiAgenticResponder.mjs';
    const ownership = 'PLOINKY_AGENTLIB_IMAGE_INVALID: Image AgentLib path must be owned by root and not writable '
        + 'by the runtime user: /opt/ploinky-agentlib/package.json.';
    for (const [result, reason] of [
        [{ ok: false, status: 1, stderr: `${ownership}\n` },
            `The inspection command exited with status 1: ${ownership}`],
        [{ ok: false, status: 1, stderr: `${smokeFailure}\n` },
            `The inspection command exited with status 1: ${smokeFailure}`],
        [{ ok: false, status: 1, stderr: ['node:internal/modules/cjs/loader:1386', '  throw err;', '  ^', '',
            missingModule, '    at Function._resolveFilename (node:internal/modules/cjs/loader:1383:15)', '',
            'Node.js v24.8.0', ''].join('\n') },
        `The inspection command exited with status 1: ${missingModule}`],
        [{ ok: false, status: 126, stderr: 'crun: unknown version specified\nAuthorization: Bearer secret-verifier-token\n' },
            'The inspection command exited with status 126: crun: unknown version specified'],
        [{ ok: false, status: 1, stderr: '', signal: 'SIGTERM',
            error: Object.assign(new Error('spawnSync podman ETIMEDOUT'), { code: 'ETIMEDOUT' }) },
        'The inspection command timed out after 60 s.'],
        [{ ok: false, status: 1, stderr: '', error: Object.assign(new Error('spawnSync podman ENOENT'), { code: 'ENOENT' }) },
            'The inspection command failed with ENOENT.'],
        [{ ok: false, status: 1, stderr: '', signal: 'SIGKILL' },
            'The inspection command was terminated by SIGKILL without output.'],
        [{ ok: false, status: 1 }, 'The inspection command exited with status 1 without output.'],
    ]) assert.equal(inspectionMessage(result), `${missingSummary}. ${reason}`);
    const redacted = inspectionMessage({ ok: false, status: 125,
        stderr: 'Error: registry login failed: token=secret-verifier-token\n' });
    assert.match(redacted, /status 125: Error: registry login failed: token=\[REDACTED\]$/);
    assert.doesNotMatch(redacted, /secret-verifier-token/);
});

test('an image that supplies another package is rejected with the reported name', () => {
    assert.throws(() => probeImageAgentLib('podman', imageId, {
        query: () => ({ ok: true, stdout: JSON.stringify({ packageName: 'something-else' }) }),
    }), {
        code: 'PLOINKY_BOX_AGENTLIB_INCOMPATIBLE',
        message: /^The Box image does not supply the achillesAgentLib package\. Build or pull [^.]+\. It reported package "something-else"\./,
    });
});

test('the image probe delegates the inspected ID to the engine without a format gate', () => {
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
    test(`image loader accepts ${inspectedId.startsWith('sha256:') ? 'prefixed' : 'bare'} IDs without pulling or host Git`, async () => {
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
            return { ok: true, stdout: JSON.stringify(report) };
        }, run() { assert.fail('a cached image must not pull or run a host command'); } };
        const bundle = await loadBoxAgentLibImage({ engine, runner, imageRef: 'pinned-image' });
        assert.equal(bundle.supplyingImageId, imageId);
        assert.equal(bundle.packageName, 'ploinky-agent-lib');
        assert.deepEqual(calls.map(call => call.slice(0, 2)), [['podman', 'image'], ['podman', 'run']]);
    });
}

test('a refreshing image load pulls a present reference before selecting from it', async () => {
    for (const streaming of [false, true]) {
        const calls = [];
        const runner = {
            query(_command, args) {
                calls.push(args.slice(0, 2).join(' '));
                return args[0] === 'image'
                    ? { ok: true, stdout: contractInspection(imageId) }
                    : { ok: true, stdout: JSON.stringify(report) };
            },
            run(_command, args) { calls.push(args.join(' ')); },
            ...(streaming ? {
                async stream(_command, args) {
                    calls.push(args.join(' '));
                    return { ok: true };
                },
            } : {}),
        };
        const bundle = await loadBoxAgentLibImage({ engine, runner, imageRef: 'pinned-image', refresh: true });
        assert.equal(bundle.supplyingImageId, imageId);
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

test('L1 an image built from any revision loads silently: no expected commit, warning, policy or host Git', async () => {
    for (const commit of ['c'.repeat(40), '9'.repeat(40), null]) {
        const calls = [];
        const writes = { stdout: [], stderr: [] };
        const runner = { query(_command, args) {
            calls.push(args);
            return args[0] === 'image'
                ? { ok: true, stdout: contractInspection(imageId) }
                : { ok: true, stdout: JSON.stringify({ ...report, provenance: commit ? { ...PROVENANCE, commit } : null }) };
        } };
        const bundle = await loadBoxAgentLibImage({
            engine, runner, imageRef: 'pinned-image',
            stdout: { write(text) { writes.stdout.push(text); } },
            stderr: { write(text) { writes.stderr.push(text); } },
            // The removed pin policy inputs are simply not part of the contract any more.
            pinPolicy: 'strict', lockCommit: 'a'.repeat(40), repositoryRoot: '/nonexistent',
        });
        assert.equal(bundle.provenance.commit, commit);
        assert.equal(bundle.supplyingImageId, imageId);
        const probe = calls.find((args) => args[0] === 'run');
        assert.equal(probe.length, 9);
        assert.equal(probe.includes('--expected-commit'), false);
        assert.deepEqual(writes, { stdout: [], stderr: [] });
    }
});

test('L2 an inspection failure stays fatal with the image and package cause', async () => {
    const runner = { query: (_command, args) => (args[0] === 'image'
        ? { ok: true, stdout: contractInspection(imageId) }
        : { ok: false, status: 1, stderr: 'ploinky-box library check failed: package.json is missing\n' }) };
    await assert.rejects(loadBoxAgentLibImage({ engine, runner, imageRef: 'pinned-image' }), (error) => {
        assert.equal(error.code, 'PLOINKY_BOX_AGENTLIB_INCOMPATIBLE');
        assert.ok(error.message.startsWith('The Box AchillesAgentLib package is missing or failed inspection'));
        assert.match(error.message, /package\.json is missing/);
        return true;
    });
});

test('running package revalidation asks the admitted container to inspect its own package', () => {
    const contract = normalizeBoxAgentLib(selection);
    let args;
    const context = { engine, containerId: 'container', runner: { query(_command, input) {
        args = input;
        return { ok: true, stdout: JSON.stringify(report) };
    } } };
    assert.equal(revalidateContainerAgentLib(contract, context), contract);
    assert.deepEqual(args, ['exec', 'container', '/usr/local/bin/node', IMAGE_AGENTLIB_PROBE_PATH, 'inspect', 'achillesAgentLib']);
    // A changed revision is not a failure; an unusable package is.
    assert.equal(revalidateContainerAgentLib(contract, { ...context, runner: { query: () => ({
        ok: true, stdout: JSON.stringify({ ...report, provenance: { ...PROVENANCE, commit: '0'.repeat(40) } }),
    }) } }), contract);
    assert.throws(() => revalidateContainerAgentLib(contract, {
        ...context, runner: { query: () => ({ ok: false, status: 1, stderr: 'ploinky-box library check failed: gone\n' }) },
    }), { code: 'PLOINKY_BOX_AGENTLIB_INCOMPATIBLE' });
});
