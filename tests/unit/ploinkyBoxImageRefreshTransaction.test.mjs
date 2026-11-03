import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BOX_IMAGE_REFERENCE, BOX_LABELS } from '../../ploinky-box/constants.mjs';
import { reconcileBoxContainer } from '../../ploinky-box/lifecycle/transactions.mjs';
import { createOperationRecord } from '../../cli/commands/updateOutcome.js';
import { verifiedRecord } from '../helpers/fakeUpdateCore.mjs';
import {
    containerHandle,
    fixture,
    harness,
    imageAgentLibFixture,
    lifecycleContainer,
    reconciliationArguments,
} from '../helpers/boxTransactionHarness.mjs';
import { createUpdateBoxScenario } from '../helpers/updateBoxScenario.mjs';

const IMAGE_REF = 'docker.io/x/box:latest';
const OLD_ID = `sha256:${'d'.repeat(64)}`;
const NEW_ID = `sha256:${'c'.repeat(64)}`;
const REMOTE = `sha256:${'b'.repeat(64)}`;
const ENGINE = { name: 'podman', identity: 'engine' };

// ---- 2. Transaction ----

const pulls = (h) => h.calls.filter((call) => call[0] === 'stream' && call[2] === 'pull');

function reusableBox(state, running = true) {
    return lifecycleContainer(state, running);
}

test('transaction: replaceImage replaces a reusable Box with one tag pull', async (t) => {
    const state = fixture(t);
    const initial = reusableBox(state);
    const h = harness(state, { initial });
    const result = await reconcileBoxContainer({ ...reconciliationArguments(state, h, initial), replaceImage: true },
        h.seams);
    assert.equal(result.action, 'replaced');
    assert.equal(pulls(h).length, 1);
    assert.deepEqual(pulls(h)[0].slice(2), ['pull', BOX_IMAGE_REFERENCE]);
});

test('transaction: refreshImageTag with the same image ID reuses the Box after one pull', async (t) => {
    const state = fixture(t);
    const initial = reusableBox(state);
    const h = harness(state, { initial, candidateImage: 'd'.repeat(64) });
    const result = await reconcileBoxContainer({ ...reconciliationArguments(state, h, initial),
        refreshImageTag: true }, h.seams);
    assert.equal(result.action, 'reused');
    assert.equal(result.imageRefresh.outcome, 'current');
    assert.equal(pulls(h).length, 1);
});

test('transaction: refreshImageTag with a new ID in local mode replaces without a second pull', async (t) => {
    const state = fixture(t);
    const initial = reusableBox(state);
    const h = harness(state, { initial, candidateImage: 'c'.repeat(64) });
    const result = await reconcileBoxContainer({ ...reconciliationArguments(state, h, initial),
        refreshImageTag: true }, h.seams);
    assert.equal(result.action, 'replaced');
    assert.equal(pulls(h).length, 1, 'the refresh pull is the only one');
    assert.equal(result.imageId, 'c'.repeat(64));
    assert.deepEqual([result.imageRefresh.outcome, result.imageRefresh.afterId], ['replace',
        `sha256:${'c'.repeat(64)}`]);
    assert.equal(Object.hasOwn(result.imageRefresh, 'image'), false);
});

test('transaction: image mode with a selection that differs from the new ID keeps the Box as pending-agentlib',
    async (t) => {
    const state = fixture(t);
    fs.rmSync(state.agentLib.sourceDir, { recursive: true });
    state.agentLib = imageAgentLibFixture();
    const initial = containerHandle({
        identity: state.identity, agentLib: state.agentLib, repositoryRoot: state.root,
        imageId: state.agentLib.supplyingImageId, imageRef: BOX_IMAGE_REFERENCE, hostPort: 8080, id: 'e'.repeat(64),
    });
    const h = harness(state, { initial, candidateImage: `sha256:${'1'.repeat(64)}` });
    h.seams.probeAgentLib = () => ({ supplyingImageId: state.agentLib.supplyingImageId });
    const result = await reconcileBoxContainer({ ...reconciliationArguments(state, h, initial),
        refreshImageTag: true }, h.seams);
    assert.equal(result.action, 'reused');
    assert.equal(result.imageRefresh.outcome, 'pending-agentlib');
});

test('transaction: a failing pull or validation leaves the Box in place with the reason', async (t) => {
    const state = fixture(t);
    const initial = reusableBox(state);
    const failedPull = harness(state, { initial, failPull: true });
    const pullResult = await reconcileBoxContainer({ ...reconciliationArguments(state, failedPull, initial),
        refreshImageTag: true }, failedPull.seams);
    assert.equal(pullResult.action, 'reused');
    assert.equal(pullResult.imageRefresh.outcome, 'pull-failed');
    const invalid = harness(state, { initial });
    invalid.seams.validateImage = () => { throw new Error('contract violated'); };
    const invalidResult = await reconcileBoxContainer({ ...reconciliationArguments(state, invalid, initial),
        refreshImageTag: true }, invalid.seams);
    assert.equal(invalidResult.action, 'reused');
    assert.deepEqual([invalidResult.imageRefresh.outcome, invalidResult.imageRefresh.reason], ['invalid',
        'contract violated']);
});

test('transaction: refresh options are refused before any engine call when they cannot be honoured', async (t) => {
    const state = fixture(t);
    const initial = reusableBox(state);
    for (const [options, pattern] of [
        [{ replaceImage: true, refreshImageTag: true }, /cannot be combined/],
        [{ replaceImage: true, imagePolicy: 'preserve' }, /preserve/],
        [{ refreshImageTag: true, imagePolicy: 'preserve' }, /preserve/],
        [{ replaceImage: true, allowReplacement: false }, /may replace the Box/],
        [{ refreshImageTag: true, allowReplacement: false }, /may replace the Box/],
        [{ replaceImage: true, requireExistingContainerId: 'e'.repeat(64) }, /required existing Box/],
        [{ refreshImageTag: true, requireExistingContainerId: 'e'.repeat(64) }, /required existing Box/],
    ]) {
        const h = harness(state, { initial });
        await assert.rejects(reconcileBoxContainer({ ...reconciliationArguments(state, h, initial), ...options },
            h.seams), pattern);
        assert.deepEqual(h.calls, [], `no discover, pull or stop call: ${JSON.stringify(options)}`);
    }
});

// ---- 3. Supervisor ----

function scenarioWithBox(t, { boxImage, container = null, env = {}, core = null, stderr = null } = {}) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-box-image-supervisor-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const reconcileOptions = [];
    const loadedRefs = [];
    const refreshCalls = [];
    let scenario;
    const ownership = () => ({
        state: 'owned',
        engine: ENGINE,
        handles: { container: { id: 'a'.repeat(64), runtime: { running: true }, ...(container || {}) } },
    });
    scenario = createUpdateBoxScenario({
        root,
        core: core || { records: () => [verifiedRecord()] },
        overrides: {
            env,
            ...(stderr ? { stderr } : {}),
            discover: ownership,
            loadAgentLibImage: async (options) => { loadedRefs.push(options.imageRef); return {}; },
            ...(boxImage === undefined ? {} : {
                refreshBoxImage: async (input, deps) => { refreshCalls.push([input, deps]); return boxImage; },
            }),
            updateWorkspacePloinky: async () => ({
                found: true, updated: false, skipped: true, scopeExcluded: true, reason: 'fixture',
                    repoPath: '/ws/ploinky',
            }),
            reconcile: async (options) => { reconcileOptions.push(options); return scenario.prepared; },
            updateAgentLib: async ({ loadImageBundle }) => {
                await loadImageBundle();
                return { selection: scenario.selection, changed: false, previous: scenario.selection };
            },
            selectAgentLib: async ({ loadImageBundle }) => {
                await loadImageBundle();
                return { selection: scenario.selection };
            },
        },
    });
    return { scenario, reconcileOptions, loadedRefs, refreshCalls };
}

test('supervisor: replaceImage and the digest ref reach the reconcile; the record sits between its neighbours',
    async (t) => {
    const boxImage = { outcome: 'replace', replaceImage: true, refreshImageTag: false,
        digestRef: `docker.io/x/box@${REMOTE}`,
        beforeId: OLD_ID, afterId: NEW_ID, canonical: IMAGE_REF, reason: '' };
    const { scenario, reconcileOptions, refreshCalls, loadedRefs } = scenarioWithBox(t, { boxImage });
    scenario.prepared.action = 'replaced';
    scenario.prepared.imageId = NEW_ID;
    const result = await scenario.supervisor.runUpdateTransaction(['update']);
    assert.equal(refreshCalls.length, 1);
    assert.equal(refreshCalls[0][1].runner !== undefined, true);
    assert.equal(reconcileOptions[0].replaceImage, true);
    assert.equal(reconcileOptions[0].refreshImageTag, false);
    assert.deepEqual(loadedRefs, [`docker.io/x/box@${REMOTE}`], 'the AgentLib is selected from the digest ref');
    const ids = result.records.map((record) => `${record.phase}:${record.code}`);
    const boxIndex = ids.indexOf('image:box-image-refreshed');
    assert.ok(boxIndex > 0, ids.join(','));
    assert.equal(result.records[boxIndex - 1].phase, 'workspace-ploinky', 'after the workspace-Ploinky record');
    assert.equal(result.records[boxIndex + 1].phase, 'agentlib', 'followed by the AgentLib record');
});

test('supervisor: refreshImageTag reaches the reconcile', async (t) => {
    const boxImage = { outcome: 'tag-refresh', replaceImage: false, refreshImageTag: true, digestRef: '',
        beforeId: OLD_ID,
        afterId: '', canonical: IMAGE_REF, reason: 'proxy' };
    const { scenario, reconcileOptions } = scenarioWithBox(t, { boxImage });
    scenario.prepared.imageRefresh = { outcome: 'current', beforeId: OLD_ID, afterId: OLD_ID, reason: '' };
    const result = await scenario.supervisor.runUpdateTransaction(['update']);
    assert.deepEqual([reconcileOptions[0].replaceImage, reconcileOptions[0].refreshImageTag], [false, true]);
    assert.ok(result.records.some((record) => record.code === 'box-image-current'));
});

test('supervisor: a targeted update never calls the Box image step', async (t) => {
    const { scenario, refreshCalls } = scenarioWithBox(t, { boxImage: { outcome: 'skip' } });
    await scenario.supervisor.runUpdateTransaction(['update', 'repos']);
    assert.equal(refreshCalls.length, 0);
});

test('supervisor: without the option there is no step, no record and no refresh option', async (t) => {
    const { scenario, reconcileOptions } = scenarioWithBox(t);
    const result = await scenario.supervisor.runUpdateTransaction(['update']);
    assert.equal(reconcileOptions[0].replaceImage, false);
    assert.equal(reconcileOptions[0].refreshImageTag, false);
    assert.equal(result.records.some((record) => record.phase === 'image'), false);
});

test('production wiring: the Box CLI constructs the supervisor with refreshBoxImageForUpdate', () => {
    const source = fs.readFileSync(new URL('../../ploinky-box/bin/ploinky-box.mjs', import.meta.url), 'utf8');
    assert.match(source, /createBoxSupervisor\(\{[^}]*refreshBoxImage: refreshBoxImageForUpdate/s);
});

// ---- 4. Cross-workspace: a tag moved by another workspace never makes a non-replacing command replace or refuse ----

const RUNNING_BOX = {
    labels: { [BOX_LABELS.imageRef]: IMAGE_REF },
    runtime: { running: true, imageId: OLD_ID },
};

test('cross-workspace: a generic command and a targeted update select the AgentLib from the image the Box runs',
    async (t) => {
    const generic = scenarioWithBox(t, { container: RUNNING_BOX, env: { PLOINKY_BOX_IMAGE: IMAGE_REF } });
    await generic.scenario.supervisor.prepareBoxForCommand({ imageRef: IMAGE_REF });
    assert.deepEqual(generic.loadedRefs, [OLD_ID], 'loads O, not the moved tag');
    assert.equal(generic.reconcileOptions[0].imageRef, IMAGE_REF);

    const targeted = scenarioWithBox(t, { container: RUNNING_BOX, env: { PLOINKY_BOX_IMAGE: IMAGE_REF } });
    await targeted.scenario.supervisor.runUpdateTransaction(['update', 'repos']);
    assert.deepEqual(targeted.loadedRefs, [OLD_ID]);
});

test('cross-workspace: a changed reference still selects from the new reference, and a full update reads the tag',
    async (t) => {
    const changed = scenarioWithBox(t, { container: RUNNING_BOX,
        env: { PLOINKY_BOX_IMAGE: 'docker.io/x/other:latest' } });
    await changed.scenario.supervisor.prepareBoxForCommand({ imageRef: 'docker.io/x/other:latest' });
    assert.deepEqual(changed.loadedRefs, ['docker.io/x/other:latest']);
    const full = scenarioWithBox(t, { container: RUNNING_BOX, env: { PLOINKY_BOX_IMAGE: IMAGE_REF } });
    await full.scenario.supervisor.runUpdateTransaction(['update']);
    assert.deepEqual(full.loadedRefs, [IMAGE_REF], 'a full update keeps reading the tag');
});

test('cross-workspace: a guarded start of an existing Box selects from its image (source check)', () => {
    const source = fs.readFileSync(new URL('../../ploinky-box/supervisor.mjs', import.meta.url), 'utf8');
    assert.match(source, /imageBundleLoader\(ownership, startImageSource\(ownership, existing, options\)\)/);
    assert.match(source, /return existing \? existingBoxImageSource\(ownership, ref\) : ref;/);
});

// ---- Rollback, hint and AgentLib source for the other outcomes ----

const requiredFailure = () => createOperationRecord({
    phase: 'registered-repository', id: 'Beta', outcome: 'skipped', required: true,
});

const replaceBoxImage = {
    outcome: 'replace', replaceImage: true, refreshImageTag: false, digestRef: `docker.io/x/box@${REMOTE}`,
    beforeId: OLD_ID, afterId: NEW_ID, canonical: IMAGE_REF, reason: '',
};

test('rollback: blocked activation after a replacement rewrites the Box record as rolled back', async (t) => {
    const { scenario } = scenarioWithBox(t, { boxImage: replaceBoxImage, container: RUNNING_BOX,
        core: { records: () => [requiredFailure()] } });
    scenario.prepared.action = 'replaced';
    scenario.prepared.imageId = NEW_ID;
    const result = await scenario.supervisor.runUpdateTransaction(['update']);
    assert.equal(result.decision.exitCode, 1);
    assert.ok(scenario.events.includes('rollback'));
    const box = result.records.filter((record) => record.phase === 'image');
    assert.equal(box.length, 1);
    assert.deepEqual([box[0].outcome, box[0].code, box[0].after], ['skipped', 'box-image-rolled-back',
        { imageId: OLD_ID }]);
});

test('rollback: a failing core update after a replacement reports the rolled-back record', async (t) => {
    const { scenario } = scenarioWithBox(t, { boxImage: replaceBoxImage, container: RUNNING_BOX,
        core: { onCall() { throw new Error('core update failed'); } } });
    scenario.prepared.action = 'replaced';
    scenario.prepared.imageId = NEW_ID;
    await assert.rejects(scenario.supervisor.runUpdateTransaction(['update']), (error) => {
        const box = (error.updateRecords || []).filter((record) => record.phase === 'image');
        assert.deepEqual(box.map((record) => record.code), ['box-image-rolled-back']);
        return true;
    });
    assert.ok(scenario.events.includes('rollback'));
});

test('rollback: an invalid tag-path image prints the manual rollback hint with the previous image ID', async (t) => {
    const lines = [];
    const boxImage = { outcome: 'tag-refresh', replaceImage: false, refreshImageTag: true, digestRef: '',
        beforeId: OLD_ID,
        afterId: '', canonical: IMAGE_REF, reason: 'proxy' };
    const { scenario } = scenarioWithBox(t, {
        boxImage, container: RUNNING_BOX, env: { PLOINKY_BOX_IMAGE: IMAGE_REF },
            stderr: { write: (line) => lines.push(line) },
    });
    scenario.prepared.imageRefresh = { outcome: 'invalid', beforeId: OLD_ID, afterId: NEW_ID, reason: 'contract' };
    const result = await scenario.supervisor.runUpdateTransaction(['update']);
    assert.ok(lines.includes(`[ploinky] To roll back: podman tag ${'d'.repeat(64)} ${IMAGE_REF}\n`), lines.join(''));
    assert.ok(result.records.some((record) => record.code === 'box-image-invalid'));
});

for (const [name, boxImage] of [
    ['policy off', { outcome: 'off', canonical: IMAGE_REF }],
    ['an unreachable registry', { outcome: 'unreachable', canonical: IMAGE_REF, beforeId: OLD_ID,
        reason: 'ENOTFOUND' }],
    ['a deferral', { outcome: 'deferred', canonical: IMAGE_REF }],
    ['a skip', { outcome: 'skip' }],
    ['a current image', { outcome: 'current', canonical: IMAGE_REF, beforeId: OLD_ID }],
]) {
    test(`full update with ${name}: the AgentLib comes from the running image, not the moved tag`, async (t) => {
        const { scenario, loadedRefs } = scenarioWithBox(t, { boxImage, container: RUNNING_BOX,
            env: { PLOINKY_BOX_IMAGE: IMAGE_REF } });
        await scenario.supervisor.runUpdateTransaction(['update']);
        assert.deepEqual(loadedRefs, [OLD_ID]);
    });
}

test('transaction: a refresh that pulled the tag does not pull it again for another replacement reason', async (t) => {
    const state = fixture(t);
    const initial = lifecycleContainer(state);
    const same = harness(state, { initial, candidateImage: 'd'.repeat(64) });
    const sameResult = await reconcileBoxContainer(
        { ...reconciliationArguments(state, same, initial, true), refreshImageTag: true }, same.seams,
    );
    assert.equal(sameResult.action, 'replaced', 'a changed port replaces the Box');
    assert.equal(pulls(same).length, 1, 'one tag pull for the refresh and the replacement together');
    const failed = harness(state, { initial, failPull: true });
    await assert.rejects(reconcileBoxContainer(
        { ...reconciliationArguments(state, failed, initial, true), refreshImageTag: true }, failed.seams,
    ), /image refresh did not complete \(pull-failed/);
    assert.equal(pulls(failed).length, 1, 'no second pull after the failed one');
    assert.equal(failed.current(), initial, 'the old Box is untouched');
});
