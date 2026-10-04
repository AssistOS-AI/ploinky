import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { manifestFixture, expectationFixture } from './test_support_codex.mjs';
import { ownedRegistration, fixtureNames } from './owned_ids_codex.mjs';
import { projectNormalUpdate, validateExpectation } from './execution_codex.mjs';
import { createOperationRecord, buildUpdateResult } from '../../../cli/commands/updateOutcome.js';
import { pinIdFor } from '../../../cli/utils/dependencies/store/gitPins.mjs';

test('the derived registration, package source and pin id equal the product derivations', async () => {
    const { value: manifest } = manifestFixture(), owned = ownedRegistration(manifest), names = fixtureNames(manifest.runId);
    assert.equal(owned.repoName, names.repoName); assert.equal(owned.packageSource, `.ploinky/repos/${names.repoName}/${names.agentName}/package.json`);
    assert.equal(owned.pinId, pinIdFor({ scope: 'registration', registration: owned.containerName, packageSource: owned.packageSource }, 'dependencies', names.packageName));
    assert.match(owned.pinId, /^[a-f0-9]{64}$/);
    // The product's own container-name function over a workspace directory with the same base name and hash input.
    const parent = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'uc-owned-')); const workspace = path.join(parent, 'testExplorerFresh'); fs.mkdirSync(path.join(workspace, '.ploinky'), { recursive: true });
    try {
        process.env.PLOINKY_WORKSPACE_ROOT = workspace;
        const { getAgentContainerName } = await import('../../../cli/sandbox/docker/common.js');
        const alternate = structuredClone(manifest); alternate.workspace.path = workspace;
        assert.equal(ownedRegistration(alternate).containerName, getAgentContainerName(names.agentName, names.repoName));
    } finally { fs.rmSync(parent, { recursive: true, force: true }); }
    const other = structuredClone(manifest); other.runId = 'update-cache-20261004T120000Z-99999999_codex';
    assert.notEqual(ownedRegistration(other).pinId, owned.pinId); assert.notEqual(ownedRegistration(other).repoName, owned.repoName);
});

function realisticObservation(manifest, { pinId, withPin = true, extra = [], pinOutcome = 'changed' } = {}) {
    const owned = ownedRegistration(manifest);
    const records = [
        createOperationRecord({ phase: 'registered-repository', id: owned.repoName, outcome: 'unchanged', required: true, code: 'current' }),
        ...(withPin ? [createOperationRecord({ phase: 'git-pin', id: pinId ?? owned.pinId, outcome: pinOutcome, required: true, code: pinOutcome === 'failed' ? 'git-pin-unreachable' : 'git-pin-verified', details: { registration: owned.containerName } })] : []),
        createOperationRecord({ phase: 'activation', id: 'workspace-graph', outcome: 'changed', required: false, code: 'restarted' }), ...extra];
    const context = { schema: 'ploinky-update-context', version: 1, workspace: { instance: manifest.workspace.instance, workspaceRoot: manifest.workspace.path }, request: { kind: 'all', folder: null, folderPath: null },
        scope: null, box: { containerId: manifest.box.id, engine: manifest.engine.identity, imageId: manifest.box.imageId } };
    const result = buildUpdateResult({ command: ['update'], records, context }); result.activation = { outcome: 'restarted', activationAllowed: true };
    return { result, failed: pinOutcome === 'failed', activation: result.activation };
}

test('a realistic update (owned repository record plus its 64-hex Git pin) projects with zero errors and zero blockers', () => {
    const { value: manifest } = manifestFixture(), owned = ownedRegistration(manifest);
    const expected = { errors: [], blockedBy: [], recordIds: ['workspace-graph', owned.repoName, owned.pinId] };
    const proof = projectNormalUpdate(realisticObservation(manifest), { manifest, operation: 'normal-update', returnedCode: 0, expected });
    assert.deepEqual(proof.result.records.map(row => [row.phase, row.id]).sort(), [['activation', 'workspace-graph'], ['git-pin', owned.pinId], ['registered-repository', owned.repoName]].sort());
    assert.equal(proof.result.exitCode, 0);
    // The settling update has no pin record because every owned registration was disabled first.
    const settled = projectNormalUpdate(realisticObservation(manifest, { withPin: false }), { manifest, operation: 'settling-update'.replace('settling-update', 'normal-update'), returnedCode: 0, expected: { errors: [], blockedBy: [], recordIds: ['workspace-graph', owned.repoName] } });
    assert.equal(settled.result.exitCode, 0);
});

test('foreign pin ids, unexpected records and an extra failure are refused; only the run-owned ids are admitted', () => {
    const { value: manifest } = manifestFixture(), owned = ownedRegistration(manifest), { expected } = expectationFixture(manifest);
    const other = structuredClone(manifest); other.runId = 'update-cache-20261004T120000Z-99999999_codex'; const foreign = ownedRegistration(other);
    for (const id of [foreign.pinId, foreign.repoName, 'f'.repeat(64), `${owned.pinId}0`]) assert.throws(() => validateExpectation({ ...expected, recordIds: [...expected.recordIds, id] }, manifest), error => error.code === 'update-expectation', id);
    assert.doesNotThrow(() => validateExpectation({ ...expected, recordIds: [...expected.recordIds, owned.repoName, owned.pinId, `AssistOSExplorer->${owned.repoName}`] }, manifest));
    const set = { errors: [], blockedBy: [], recordIds: ['workspace-graph', owned.repoName, owned.pinId] };
    assert.throws(() => projectNormalUpdate(realisticObservation(manifest, { pinId: foreign.pinId }), { manifest, operation: 'normal-update', returnedCode: 0, expected: set }), error => error.code === 'update-record');
    assert.throws(() => projectNormalUpdate(realisticObservation(manifest, { withPin: false }), { manifest, operation: 'normal-update', returnedCode: 0, expected: set }), error => error.code === 'update-records-incomplete');
    assert.throws(() => projectNormalUpdate(realisticObservation(manifest, { pinOutcome: 'failed' }), { manifest, operation: 'normal-update', returnedCode: 1, expected: set }), error => error.code === 'update-unexpected-records', 'a failed pin is an unexpected error, never absorbed');
    const unexpected = realisticObservation(manifest, { extra: [createOperationRecord({ phase: 'registered-repository', id: 'AssistOSExplorer', outcome: 'failed', required: false, code: 'diverged' })] });
    assert.throws(() => projectNormalUpdate(unexpected, { manifest, operation: 'normal-update', returnedCode: 1, expected: { ...set, recordIds: [...set.recordIds, 'AssistOSExplorer'] } }));
});
