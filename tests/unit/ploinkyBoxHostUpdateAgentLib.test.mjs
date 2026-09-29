// The public `ploinky update` result reports the AgentLib source by its
// mode-aware identity: a local checkout by its content fingerprint and physical
// source identity, the copy a Box image supplies by that image's ID plus any
// informational build provenance. Both the current and the previous selection
// are reported, and neither side invents a fingerprint for the other mode.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    agentLibIdentity,
    agentLibIdentityEquals,
    imageSourceIdHash,
    imageSourceIdentity,
    localSourceIdHash,
} from '../../agentlib/contract.mjs';
import { buildImageSelection, buildSelection } from '../../agentlib/source.mjs';
import { projectUpdateAgentLib, runOuterCli } from '../../ploinky-box/bin/ploinky-box.mjs';
import { createMemoryUpdateHostState } from '../../ploinky-box/update/hostState.mjs';
import { buildUpdateResult } from '../../cli/commands/updateOutcome.js';
import { OUTER_IMAGE_ID_FIXTURE, writeAgentLibCheckout } from '../helpers/agentlibFixture.mjs';

const OTHER_IMAGE = `sha256:${'d4'.repeat(32)}`;
const PROVENANCE = {
    repository: 'https://github.com/AssistOS-AI/AchillesAgentLib.git', branch: 'master', commit: 'a'.repeat(40), packageVersion: '1.2.3',
};

function workspace(t) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-update-agentlib-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, '.ploinky'), { recursive: true });
    return root;
}

function localSelection(root, marker = 'v1') {
    const sourceDir = path.join(root, 'achillesAgentLib');
    fs.mkdirSync(sourceDir, { recursive: true });
    writeAgentLibCheckout(sourceDir);
    fs.appendFileSync(path.join(sourceDir, 'index.mjs'), `// ${marker}\n`);
    return buildSelection({ workspaceRoot: root, sourceDir, resolvedCommit: 'b'.repeat(40) });
}

test('a local source projects its fingerprint and physical source identity, and no image fields', (t) => {
    const root = workspace(t);
    const current = localSelection(root, 'after');
    const previous = localSelection(root, 'before');
    const projected = projectUpdateAgentLib({ agentLib: current, previous, changed: true });
    assert.deepEqual(projected, {
        changed: true,
        current: { mode: 'local', fingerprint: current.contentFingerprint, sourceIdHash: localSourceIdHash(current.sourceId) },
        previous: { mode: 'local', fingerprint: previous.contentFingerprint, sourceIdHash: localSourceIdHash(previous.sourceId) },
    });
    assert.notEqual(projected.current.fingerprint, projected.previous.fingerprint);
    for (const side of [projected.current, projected.previous]) {
        for (const invented of ['supplyingImageId', 'provenance']) assert.equal(Object.hasOwn(side, invented), false);
    }
});

test('an image source projects the supplying image, source identity and provenance, and no fingerprint', (t) => {
    const root = workspace(t);
    const current = buildImageSelection({ workspaceRoot: root, supplyingImageId: OUTER_IMAGE_ID_FIXTURE, provenance: PROVENANCE });
    const previous = buildImageSelection({ workspaceRoot: root, supplyingImageId: OTHER_IMAGE });
    const projected = projectUpdateAgentLib({ agentLib: current, previous, changed: true });
    assert.deepEqual(projected, {
        changed: true,
        current: {
            mode: 'image',
            supplyingImageId: OUTER_IMAGE_ID_FIXTURE,
            sourceIdHash: imageSourceIdHash(imageSourceIdentity(OUTER_IMAGE_ID_FIXTURE)),
            provenance: PROVENANCE,
        },
        previous: {
            mode: 'image',
            supplyingImageId: OTHER_IMAGE,
            sourceIdHash: imageSourceIdHash(imageSourceIdentity(OTHER_IMAGE)),
            provenance: { repository: null, branch: null, commit: null, packageVersion: null },
        },
    });
    for (const side of [projected.current, projected.previous]) {
        for (const invented of ['fingerprint', 'contentFingerprint', 'commit']) assert.equal(Object.hasOwn(side, invented), false);
    }
});

test('a switch between modes and a first selection project each side by its own mode', (t) => {
    const root = workspace(t);
    const local = localSelection(root);
    const image = buildImageSelection({ workspaceRoot: root, supplyingImageId: OUTER_IMAGE_ID_FIXTURE });
    const toImage = projectUpdateAgentLib({ agentLib: image, previous: local, changed: true });
    assert.equal(toImage.current.mode, 'image');
    assert.equal(toImage.previous.mode, 'local');
    assert.equal(agentLibIdentityEquals(image, local), false);
    const first = projectUpdateAgentLib({ agentLib: local, previous: null, changed: true });
    assert.equal(first.previous, null);
    assert.equal(first.current.mode, 'local');
    assert.equal(projectUpdateAgentLib({ agentLib: null }), null);
    assert.equal(projectUpdateAgentLib(undefined), null);
    assert.deepEqual(projectUpdateAgentLib({ agentLib: image, previous: image, changed: false }).changed, false);
});

test('the mode-aware identity also accepts a Box contract, so mounted-only paths report consistently', () => {
    const contract = {
        mode: 'image', sourceDir: '/opt/ploinky-agentlib', sourceRelativePath: 'image',
        sourceIdHash: imageSourceIdHash(imageSourceIdentity(OUTER_IMAGE_ID_FIXTURE)), supplyingImageId: OUTER_IMAGE_ID_FIXTURE,
    };
    assert.deepEqual(agentLibIdentity(contract, { provenance: false }), {
        mode: 'image', supplyingImageId: OUTER_IMAGE_ID_FIXTURE, sourceIdHash: contract.sourceIdHash,
    });
});

test('the public update result carries the projection through the real host update flow', async (t) => {
    const root = workspace(t);
    const current = buildImageSelection({ workspaceRoot: root, supplyingImageId: OUTER_IMAGE_ID_FIXTURE, provenance: PROVENANCE });
    const previous = localSelection(root);
    const identity = { instance: 'ploinky-box-workspace-123456789abc', workspaceRoot: root };
    const reports = [];
    const output = { isTTY: false, write() { return true; } };
    const code = await runOuterCli(['update'], {
        env: {},
        cwd: () => root,
        detectInsideBox: () => false,
        input: { isTTY: false },
        output,
        errorOutput: output,
        updateHostState: createMemoryUpdateHostState(),
        onUpdateResult: (report) => reports.push(report),
        async updateHostSource() { return { updated: false }; },
        relaunch() { return 0; },
        supervisor: {
            resolveWorkspaceIdentity: () => identity,
            runUpdateTransaction: async () => ({
                activation: { outcome: 'not-required' },
                agentLib: current,
                previous,
                changed: true,
            }),
        },
    });
    assert.equal(code, 0);
    assert.equal(reports.length, 1);
    const { agentLib } = reports[0].result;
    assert.equal(agentLib.changed, true);
    assert.equal(agentLib.current.mode, 'image');
    assert.equal(agentLib.current.supplyingImageId, OUTER_IMAGE_ID_FIXTURE);
    assert.deepEqual(agentLib.current.provenance, PROVENANCE);
    assert.equal(agentLib.previous.mode, 'local');
    assert.equal(agentLib.previous.fingerprint, previous.contentFingerprint);
    assert.equal(Object.hasOwn(agentLib, 'fingerprint'), false, 'no ambiguous top-level fingerprint remains');
    assert.equal(Object.hasOwn(agentLib, 'previousFingerprint'), false);
    assert.doesNotThrow(() => JSON.stringify(reports[0].result));
    // The same projection is what the shared result builder embeds.
    assert.deepEqual(buildUpdateResult({ agentLib: projectUpdateAgentLib({ agentLib: current, previous, changed: true }) }).agentLib, agentLib);
});
