import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeRuntimeExpectation } from '../../core-services/webtty/native-runtime.mjs';
import { BOX_LABELS } from '../../ploinky-box/constants.mjs';
import { IMAGE_CONTRACT, inspectAndValidateExistingImage } from '../../ploinky-box/contract/image.mjs';
import { imageRefreshPolicyFromSecrets, imageRefreshPolicyOf } from '../../cli/sandbox/docker/imageRefreshPolicy.mjs';
import { readImageRefreshPolicyFile } from '../../ploinky-box/inbox/readImageRefreshPolicy.mjs';
import { boxImageRolledBackRecord, boxImageUpdateRecord,
    refreshBoxImageForUpdate } from '../../ploinky-box/update/boxImageRefresh.mjs';

const IMAGE_REF = 'docker.io/x/box:latest';
const OLD_ID = `sha256:${'d'.repeat(64)}`;
const NEW_ID = `sha256:${'c'.repeat(64)}`;
const REMOTE = `sha256:${'b'.repeat(64)}`;
const LOCAL_DIGEST = `sha256:${'a'.repeat(64)}`;
const ENGINE = { name: 'podman', identity: 'engine' };

// ---- 1. Pure pieces and the step ----

test('policy rule: off disables, on and empty are the default, anything else is ignored and reported', () => {
    assert.deepEqual(imageRefreshPolicyOf(''), { policy: 'refresh', ignoredValue: '' });
    assert.deepEqual(imageRefreshPolicyOf('on'), { policy: 'refresh', ignoredValue: '' });
    assert.deepEqual(imageRefreshPolicyOf('off'), { policy: 'off', ignoredValue: '' });
    assert.deepEqual(imageRefreshPolicyOf(' off '), { policy: 'off', ignoredValue: '' });
    assert.deepEqual(imageRefreshPolicyOf('bogus'), { policy: 'refresh', ignoredValue: 'bogus' });
});

test('policy from secrets follows aliases; a cycle resolves to refresh', () => {
    assert.equal(imageRefreshPolicyFromSecrets({ PLOINKY_IMAGE_REFRESH: '$X', X: 'off' }).policy, 'off');
    assert.equal(imageRefreshPolicyFromSecrets({ PLOINKY_IMAGE_REFRESH: '$A', A: '$B', B: '$A' }).policy, 'refresh');
    assert.equal(imageRefreshPolicyFromSecrets({}).policy, 'refresh');
});

test('readImageRefreshPolicyFile: missing and empty files refresh and are never written; failures are unknown', () => {
    const writes = [];
    const fsApi = (read) => ({ readFileSync: read, writeFileSync: (...args) => writes.push(args) });
    const enoent = () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };
    assert.deepEqual(readImageRefreshPolicyFile('/s', { fsApi: fsApi(enoent), decrypt: () => ({}) }),
        { policy: 'refresh' });
    assert.deepEqual(readImageRefreshPolicyFile('/s', { fsApi: fsApi(() => '  \n'),
        decrypt: () => assert.fail('empty') }),
        { policy: 'refresh' });
    assert.deepEqual(readImageRefreshPolicyFile('/s', { fsApi: fsApi(() => 'cipher'),
        decrypt: () => ({ PLOINKY_IMAGE_REFRESH: 'off' }) }),
        { policy: 'off' });
    assert.deepEqual(readImageRefreshPolicyFile('/s', { fsApi: fsApi(() => 'cipher'),
        decrypt: () => { throw new Error('bad key'); } }),
        { policy: 'unknown' });
    const eacces = () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
    assert.deepEqual(readImageRefreshPolicyFile('/s', { fsApi: fsApi(eacces), decrypt: () => ({}) }),
        { policy: 'unknown' });
    assert.deepEqual(writes, [], 'the program never writes');
});

function stepContainer(overrides = {}) {
    return {
        id: 'e'.repeat(64),
        labels: { [BOX_LABELS.imageRef]: IMAGE_REF },
        runtime: { running: true, imageId: OLD_ID },
        ...overrides,
    };
}

function stepHarness({ policy = '{"policy":"refresh"}', repoDigests = [`docker.io/x/box@${LOCAL_DIGEST}`],
    remote = { status: 'ok', digest: REMOTE },
    afterId = NEW_ID, pullThrows = null, validateThrows = null, probeThrows = null, policyOk = true } = {}) {
    const calls = { query: [], pulls: [], fetches: 0, validate: [], probe: [], logs: [] };
    const runner = {
        query(command, args, options) {
            calls.query.push({ command, args, options });
            if (args[0] === 'container') return policyOk ? { ok: true, stdout: `${policy}\n` } : { ok: false,
                stdout: '' };
            if (args.includes('{{json .RepoDigests}}')) return { ok: true, stdout: JSON.stringify(repoDigests) };
            return { ok: true, stdout: `${afterId}\n` };
        },
    };
    const deps = {
        runner,
        fetchDigest: async () => { calls.fetches += 1; return remote; },
        pullImage: async (engine, ref) => { calls.pulls.push([engine, ref]); if (pullThrows) throw pullThrows; },
        validateExisting: (...args) => { calls.validate.push(args); if (validateThrows) throw validateThrows; },
        probeAgentLib: (...args) => { calls.probe.push(args); if (probeThrows) throw probeThrows; },
    };
    const stderr = { write: (line) => calls.logs.push(line) };
    const run = (overrides = {}, env = {}) => refreshBoxImageForUpdate({
        engine: ENGINE, container: stepContainer(), imageRef: IMAGE_REF, workspaceRoot: '/work/space',
        activity: { undetermined: false }, env, stdout: { write() {} }, stderr, ...overrides,
    }, deps);
    return { run, calls };
}

test('step: no container, pinned, unqualified, localhost and a different label skip with no runner call', async () => {
    for (const [overrides] of [
        [{ container: null }],
        [{ imageRef: `docker.io/x/box@sha256:${'e'.repeat(64)}` }],
        [{ imageRef: 'ploinky-box:latest' }],
        [{ imageRef: 'localhost:5000/x' }],
        [{ imageRef: 'localhost/x:1' }],
        [{ container: stepContainer({ labels: { [BOX_LABELS.imageRef]: 'docker.io/x/box:other' } }) }],
    ]) {
        const { run, calls } = stepHarness();
        const result = await run(overrides);
        assert.equal(result.outcome, 'skip', JSON.stringify(overrides));
        assert.equal(calls.query.length + calls.fetches + calls.pulls.length, 0);
    }
});

test('step: a stopped Box or undetermined graph activity defers without any I/O', async () => {
    for (const overrides of [
        { container: stepContainer({ runtime: { running: false, imageId: OLD_ID } }) },
        { activity: { undetermined: true } },
    ]) {
        const { run, calls } = stepHarness();
        assert.equal((await run(overrides)).outcome, 'deferred');
        assert.equal(calls.query.length + calls.fetches, 0);
    }
});

test('step: policy off logs one line and records nothing; an unreadable policy is policy-unavailable', async () => {
    const off = stepHarness({ policy: '{"policy":"off"}' });
    const result = await off.run();
    assert.equal(result.outcome, 'off');
    assert.equal(boxImageUpdateRecord(result, null), null);
    assert.equal(off.calls.logs.filter((line) => /turned off for this workspace/.test(line)).length, 1);
    assert.equal(off.calls.fetches + off.calls.pulls.length, 0);
    const exec = off.calls.query[0];
    assert.deepEqual(exec.args.slice(0, 5), ['container', 'exec', '--user', 'podman', '--workdir']);
    assert.equal(exec.args.at(-1), '/opt/ploinky/ploinky-box/inbox/readImageRefreshPolicy.mjs');
    assert.equal(exec.options.timeoutMs, 15_000);
    for (const bad of [{ policy: 'unknown' }, { policy: '{"policy":"refresh","x":1}' }, { policy: 'garbage' },
        { policyOk: false }, { policy: '{"policy":"maybe"}' }]) {
        const { run, calls } = stepHarness(bad);
        const outcome = await run();
        assert.equal(outcome.outcome, 'policy-unavailable', JSON.stringify(bad));
        assert.equal(boxImageUpdateRecord(outcome, null).code, 'box-image-policy-unavailable');
        assert.equal(calls.fetches + calls.pulls.length, 0);
    }
});

test('step: a digest already local is current and the RepoDigests are read by image ID, not by tag', async () => {
    const { run, calls } = stepHarness({ remote: { status: 'ok', digest: LOCAL_DIGEST } });
    assert.equal((await run()).outcome, 'current');
    const inspect = calls.query.find((entry) => entry.args.includes('{{json .RepoDigests}}'));
    assert.equal(inspect.args.at(-1), OLD_ID);
    assert.equal(calls.pulls.length, 0);
});

test('step: an unreachable registry keeps the Box; an undetermined answer or a proxy defers to the tag path',
    async () => {
    for (const reason of ['ENOTFOUND', 'registry answered HTTP 429']) {
        const { run, calls } = stepHarness({ remote: { status: 'unavailable', reason } });
        const result = await run();
        assert.equal(result.outcome, 'unreachable');
        assert.equal(boxImageUpdateRecord(result, null).code, 'registry-unreachable');
        assert.equal(calls.pulls.length, 0);
    }
    for (const reason of ['registry answered HTTP 403', 'TLS error (CERT_HAS_EXPIRED)']) {
        const { run, calls } = stepHarness({ remote: { status: 'undetermined', reason } });
        const result = await run();
        assert.deepEqual([result.outcome, result.refreshImageTag, result.replaceImage], ['tag-refresh', true, false]);
        assert.equal(calls.pulls.length, 0, 'the transaction pulls, not the step');
    }
    const proxied = stepHarness();
    const viaProxy = await proxied.run({}, { HTTPS_PROXY: 'http://proxy:3128' });
    assert.equal(viaProxy.outcome, 'tag-refresh');
    assert.equal(proxied.calls.fetches, 0);
});

test('step: a different digest is pulled once by digest with the engine object; success asks for a replacement',
    async () => {
    const { run, calls } = stepHarness();
    const result = await run();
    assert.equal(calls.pulls.length, 1);
    assert.equal(calls.pulls[0][0], ENGINE, 'the engine object, not its name');
    assert.equal(calls.pulls[0][1], `docker.io/x/box@${REMOTE}`);
    assert.deepEqual([result.outcome, result.replaceImage, result.refreshImageTag, result.digestRef],
        ['replace', true, false, `docker.io/x/box@${REMOTE}`]);
    assert.deepEqual([calls.validate[0][1], calls.probe[0][1]], [NEW_ID, NEW_ID], 'validated by the pulled image ID');
});

test('step: an equal image ID after the pull is current; a failed pull or validation moves nothing', async () => {
    assert.equal((await stepHarness({ afterId: OLD_ID }).run()).outcome, 'current');
    const failedPull = await stepHarness({ pullThrows: new Error('pull failed') }).run();
    assert.deepEqual([failedPull.outcome, failedPull.replaceImage], ['pull-failed', false]);
    for (const option of [{ validateThrows: new Error('contract') }, { probeThrows: new Error('no agentlib') }]) {
        const result = await stepHarness(option).run();
        assert.deepEqual([result.outcome, result.replaceImage], ['invalid', false]);
    }
});

test('step: it never rejects, whatever throws', async () => {
    const throwing = {
        runner: { query() { throw new Error('engine gone'); } },
        fetchDigest: async () => { throw new Error('fetch'); },
    };
    const result = await refreshBoxImageForUpdate({
        engine: ENGINE, container: stepContainer(), imageRef: IMAGE_REF, workspaceRoot: '/work/space',
        activity: {}, env: {}, stdout: { write() {} }, stderr: { write() {} },
    }, throwing);
    assert.equal(result.outcome, 'error');
    assert.equal(boxImageUpdateRecord(result, null).code, 'box-image-check-error');
    const broken = await refreshBoxImageForUpdate({
        engine: ENGINE, container: stepContainer(), imageRef: IMAGE_REF, workspaceRoot: '/work/space',
        activity: {}, env: {}, stdout: { write() {} }, stderr: { write() {} },
    }, { runner: { query: (_c, args) => (args[0] === 'container' ? { ok: true,
        stdout: '{"policy":"refresh"}' } : { ok: false }) } });
    assert.equal(broken.outcome, 'error');
});

test('records: every row of the outcome table', () => {
    const base = { canonical: IMAGE_REF, beforeId: OLD_ID };
    const record = (boxImage, prepared = null) => boxImageUpdateRecord({ ...base, ...boxImage }, prepared);
    const row = (value) => [value.outcome, value.code, value.required, value.phase, value.id];
    assert.deepEqual(row(record({ outcome: 'replace', afterId: NEW_ID }, { action: 'replaced', imageId: NEW_ID })),
        ['changed', 'box-image-refreshed', false, 'image', `box:${IMAGE_REF}`]);
    assert.deepEqual(record({ outcome: 'replace', afterId: NEW_ID }, { action: 'replaced', imageId: NEW_ID }).after,
        { imageId: NEW_ID });
    assert.equal(record({ outcome: 'tag-refresh' }, { action: 'replaced', imageId: NEW_ID,
        imageRefresh: { outcome: 'replace', afterId: NEW_ID } }).code,
        'box-image-refreshed');
    assert.equal(record({ outcome: 'tag-refresh' }, { action: 'reused', imageRefresh: { outcome: 'current' } }).code,
        'box-image-current');
    assert.equal(record({ outcome: 'tag-refresh' }, { action: 'reused',
        imageRefresh: { outcome: 'pending-agentlib' } }).code,
        'box-image-refresh-pending');
    assert.equal(record({ outcome: 'tag-refresh' }, { action: 'reused', imageRefresh: { outcome: 'pull-failed',
        reason: 'x' } }).code,
        'box-image-pull-failed');
    assert.equal(record({ outcome: 'tag-refresh' }, { action: 'reused', imageRefresh: { outcome: 'invalid' } }).code,
        'box-image-invalid');
    for (const [outcome, expected, code] of [
        ['current', 'unchanged', 'box-image-current'],
        ['unreachable', 'skipped', 'registry-unreachable'],
        ['pull-failed', 'skipped', 'box-image-pull-failed'],
        ['invalid', 'skipped', 'box-image-invalid'],
        ['deferred', 'skipped', 'box-image-check-deferred'],
        ['policy-unavailable', 'skipped', 'box-image-policy-unavailable'],
        ['error', 'skipped', 'box-image-check-error'],
    ]) {
        const made = record({ outcome });
        assert.deepEqual([made.outcome, made.code, made.required], [expected, code, false], outcome);
    }
    assert.equal(record({ outcome: 'skip' }), null);
    assert.equal(record({ outcome: 'off' }), null);
});


// ---- Real validator with a Podman-shaped engine ----

const PODMAN_HEX = 'c'.repeat(64);

// Answers `image inspect` the way Podman does: a bare-hex Id with no sha256: prefix.
function podmanValidatorRunner() {
    const record = [{ Id: PODMAN_HEX, Os: 'linux', Architecture: 'amd64', Config: {
        User: IMAGE_CONTRACT.user, WorkingDir: IMAGE_CONTRACT.workdir,
        Env: Object.entries(IMAGE_CONTRACT.environment).map(([key, value]) => `${key}=${value}`),
        Entrypoint: [IMAGE_CONTRACT.entrypoint], Cmd: [], Volumes: {}, Labels: {},
    } }];
    const probe = {
        ...nativeRuntimeExpectation({ platform: 'linux', architecture: 'amd64' }),
        nativeArtifactSha256: 'a'.repeat(64), sourceSha: 'b'.repeat(40), uid: 1000, gid: 1000,
        pty: { import: true, input: true, output: true, resize: true, exit: true, reap: true, identity: true },
    };
    const binaries = [...IMAGE_CONTRACT.requiredBinaries, IMAGE_CONTRACT.networkHelpers[0]];
    return { query(_engine, args) {
        if (args[0] === 'image' && args[1] === 'inspect') return { ok: true, stdout: JSON.stringify(record),
            stderr: '' };
        if (args.includes('--entrypoint=/bin/bash')) {
            const paths = binaries.map((name) => (name.startsWith('/') ? name : `/usr/bin/${name}`));
            return { ok: true, stdout: paths.join('\n'), stderr: '' };
        }
        return { ok: true, stdout: JSON.stringify(probe), stderr: '' };
    } };
}

test('step: the digest path validates the pulled image with the real validator and a bare-hex Podman ID', async () => {
    const validatorRunner = podmanValidatorRunner();
    const probed = [];
    const bareOld = 'd'.repeat(64);
    const result = await refreshBoxImageForUpdate({
        engine: ENGINE, container: stepContainer({ runtime: { running: true, imageId: bareOld } }), imageRef: IMAGE_REF,
        workspaceRoot: '/work/space', activity: {}, env: {}, stdout: { write() {} }, stderr: { write() {} },
    }, {
        runner: { query(command, args, options) {
            if (args[0] === 'container') return { ok: true, stdout: '{"policy":"refresh"}' };
            if (args.includes('{{json .RepoDigests}}')) return { ok: true,
                stdout: JSON.stringify([`docker.io/x/box@${LOCAL_DIGEST}`]) };
            if (args.includes('{{.Id}}')) return { ok: true, stdout: `${PODMAN_HEX}\n` };
            return validatorRunner.query(command, args, options);
        } },
        fetchDigest: async () => ({ status: 'ok', digest: REMOTE }),
        pullImage: async () => {},
        validateExisting: inspectAndValidateExistingImage,
        probeAgentLib: (_engine, id) => { probed.push(id); },
    });
    assert.equal(result.outcome, 'replace', result.reason);
    assert.equal(result.replaceImage, true);
    assert.deepEqual(probed, [PODMAN_HEX], 'the probe gets the ID exactly as Podman reports it');
    assert.equal(result.afterId, `sha256:${PODMAN_HEX}`, 'the record keeps the normalized form');
});

test('step: an error after the digest pull keeps the canonical reference, so its record id is box:<ref>', async () => {
    const failing = await refreshBoxImageForUpdate({
        engine: ENGINE, container: stepContainer(), imageRef: IMAGE_REF, workspaceRoot: '/work/space',
        activity: {}, env: {}, stdout: { write() {} }, stderr: { write() {} },
    }, { runner: { query: (_c, args) => {
        if (args[0] === 'container') return { ok: true, stdout: '{"policy":"refresh"}' };
        if (args.includes('{{json .RepoDigests}}')) return { ok: true, stdout: '[]' };
        return { ok: false };
    } }, fetchDigest: async () => ({ status: 'ok', digest: REMOTE }), pullImage: async () => {} });
    assert.equal(failing.outcome, 'error');
    assert.equal(boxImageUpdateRecord(failing, null).id, `box:${IMAGE_REF}`);
});

test('records: attempted flags, the restored image of a rollback, and after taken from the replaced Box', () => {
    const base = { canonical: IMAGE_REF, beforeId: OLD_ID };
    const make = (boxImage, prepared) => boxImageUpdateRecord({ ...base, ...boxImage }, prepared);
    assert.equal(make({ outcome: 'replace', afterId: NEW_ID }, { action: 'replaced',
        imageId: 'prepared-id' }).attempted, true);
    assert.deepEqual(make({ outcome: 'replace', afterId: NEW_ID }, { action: 'replaced',
        imageId: 'prepared-id' }).after,
        { imageId: 'prepared-id' }, 'after is the image the replaced Box actually runs');
    for (const outcome of ['current', 'unreachable', 'deferred', 'policy-unavailable', 'error']) {
        assert.equal(make({ outcome }).attempted, false, outcome);
    }
    for (const outcome of ['pull-failed', 'invalid']) assert.equal(make({ outcome }).attempted, true, outcome);
    const rolledBack = boxImageRolledBackRecord({ ...base, outcome: 'replace' }, { action: 'replaced' });
    assert.deepEqual([rolledBack.outcome, rolledBack.code, rolledBack.required], ['skipped', 'box-image-rolled-back',
        false]);
    assert.deepEqual([rolledBack.before, rolledBack.after], [{ imageId: OLD_ID }, { imageId: OLD_ID }]);
});
