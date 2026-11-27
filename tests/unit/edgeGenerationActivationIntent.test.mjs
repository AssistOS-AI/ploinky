import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    ACTIVATION_CONTEXT_ENV,
    activationCommitHooks,
    activationMarkerPath,
    activationRecordPath,
    buildActivationBarrierMarker,
    readActivationRequest,
} from '../../cli/sandbox/activationRecords.mjs';
import { applyEdgeRoutingGeneration, loadActiveEdgeRoutingGeneration } from '../../cli/sandbox/edgeGeneration.js';
import { stageProdGates, writeProdGates } from '../../cli/utils/runtime/mcpProdGates.mjs';

// Q30 AC2: the in-Box crash windows of a start's selector commit (W0-W3) and
// the marker removal rules on commit.

const OWN = '1'.repeat(32);
const SETTLED = '2'.repeat(32);
const CONTAINER = 'c'.repeat(64);

function createFixture(t) {
    const workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-activation-intent-')));
    const ploinkyDir = path.join(workspace, '.ploinky');
    const edgeDir = path.join(ploinkyDir, 'data', 'edge-routing');
    const policyDir = path.join(ploinkyDir, 'data', 'router-security');
    const alphaDir = path.join(ploinkyDir, 'repos', 'fixtures', 'alpha');
    fs.mkdirSync(edgeDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(policyDir, { recursive: true });
    fs.mkdirSync(alphaDir, { recursive: true });
    fs.writeFileSync(path.join(alphaDir, 'manifest.json'), '{}');
    fs.writeFileSync(path.join(ploinkyDir, 'routing.json'), JSON.stringify({
        static: { agent: 'alpha', port: 7777 },
        routes: { alpha: { repo: 'fixtures', agent: 'alpha', container: 'alpha-container', hostPath: alphaDir, hostPort: 43101 } },
    }, null, 2));
    fs.writeFileSync(path.join(ploinkyDir, 'agents.json'), JSON.stringify({
        'alpha-container': {
            type: 'agent', repoName: 'fixtures', agentName: 'alpha', instanceId: 'alpha-instance',
            enableGeneration: 'alpha-enable-generation', auth: { mode: 'sso' },
        },
    }, null, 2));
    fs.writeFileSync(path.join(edgeDir, 'desired.json'), JSON.stringify({ hosts: {} }, null, 2));
    fs.writeFileSync(path.join(policyDir, 'policy-state.json'), JSON.stringify({ schema: 'router-policy', httpRoutes: [], mcpTools: [] }));
    const saved = {
        PLOINKY_WORKSPACE_ROOT: process.env.PLOINKY_WORKSPACE_ROOT,
        PLOINKY_ROUTER_HOST_PORT: process.env.PLOINKY_ROUTER_HOST_PORT,
        PLOINKY_MEDIA_HOST_PORT: process.env.PLOINKY_MEDIA_HOST_PORT,
    };
    process.env.PLOINKY_WORKSPACE_ROOT = workspace;
    process.env.PLOINKY_ROUTER_HOST_PORT = '18080';
    process.env.PLOINKY_MEDIA_HOST_PORT = '17891';
    t.after(() => {
        for (const [name, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
        readActivationRequest({});
        fs.rmSync(workspace, { recursive: true, force: true });
    });
    const policyFile = path.join(ploinkyDir, 'data', 'mcp-prod-gates.json');
    // The predecessor policy, weaker than the capture about to be staged.
    writeProdGates({ schema: 1, prod: false, routes: { alpha: { tools: ['old'], sha256: null } } }, { file: policyFile });
    // An active predecessor generation, as a running workspace has.
    applyEdgeRoutingGeneration({ workspaceRoot: workspace });
    return { workspace, policyFile, policyBytes: fs.readFileSync(policyFile) };
}

const CAPTURE = Object.freeze({ schema: 1, prod: true, routes: { alpha: { tools: ['new'], sha256: null } } });

function admit(fixture, purpose, settlesOperationId = null) {
    const context = {
        schema: 'ploinky-activation-context', version: 1,
        operation: purpose === 'restore' ? 'start' : 'restart',
        purpose, settlesOperationId, operationId: OWN,
        instance: 'ploinky-box-workspace-123456789abc', containerId: CONTAINER, workspaceRoot: fixture.workspace,
    };
    return readActivationRequest({ [ACTIVATION_CONTEXT_ENV]: JSON.stringify(context) });
}

function commit(fixture, { request, testHooks = {}, afterCommit = null }) {
    let activated = false;
    const hooks = activationCommitHooks({
        prodCapture: CAPTURE,
        activationRequest: request,
        workspaceRoot: fixture.workspace,
        stageProdGates: (capture) => stageProdGates(capture, { file: fixture.policyFile }),
        onActivated() { activated = true; },
        log() {},
    });
    const options = { workspaceRoot: fixture.workspace, ...hooks, testHooks };
    if (afterCommit) {
        options.afterSelectorCommit = (payload) => {
            hooks.afterSelectorCommit(payload);
            afterCommit(payload);
        };
    }
    let result;
    let error;
    try {
        result = applyEdgeRoutingGeneration(options);
    } catch (caught) {
        error = caught;
    }
    return { result, error, activated: () => activated };
}

const intentFile = (fixture) => activationRecordPath(fixture.workspace, OWN, 'intent');
const receiptFile = (fixture) => activationRecordPath(fixture.workspace, OWN, 'receipt');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const liveSelector = (fixture) => loadActiveEdgeRoutingGeneration({ workspaceRoot: fixture.workspace })?.selector
    ?? readJson(path.join(fixture.workspace, '.ploinky', 'data', 'edge-routing', 'active.json'));
const policy = (fixture) => readJson(fixture.policyFile);

function placeMarker(fixture, state, operationId) {
    const marker = buildActivationBarrierMarker({ operation: 'restart', operationId, state, containerId: CONTAINER });
    fs.writeFileSync(activationMarkerPath(fixture.workspace), JSON.stringify(marker), { mode: 0o600 });
    return fs.readFileSync(activationMarkerPath(fixture.workspace));
}

test('W0: a failure before the intent leaves no intent, an inactive selector and the predecessor policy', (t) => {
    const fixture = createFixture(t);
    const { error } = commit(fixture, {
        request: admit(fixture, 'activate'),
        testHooks: { afterGenerationTempFsync() { throw new Error('W0'); } },
    });
    assert.equal(error?.message, 'W0');
    assert.equal(fs.existsSync(intentFile(fixture)), false);
    assert.equal(readJson(path.join(fixture.workspace, '.ploinky', 'data', 'edge-routing', 'active.json')).state, 'inactive');
    assert.deepEqual(fs.readFileSync(fixture.policyFile), fixture.policyBytes);
});

test('W1: a failure after the intent and before the rename leaves the intent, a not-committed receipt and the predecessor policy', (t) => {
    const fixture = createFixture(t);
    const markerBytes = placeMarker(fixture, 'activated', SETTLED);
    let intended;
    const { error } = commit(fixture, {
        request: admit(fixture, 'settle', SETTLED),
        testHooks: { beforeSelectorWrite({ selector }) { intended = selector; throw new Error('W1'); } },
    });
    assert.equal(error?.message, 'W1');
    const intent = readJson(intentFile(fixture));
    assert.equal(intent.intended.selectorDigest, intended.selectorDigest);
    assert.equal(intent.predecessor.state, 'inactive');
    assert.equal(intent.policyStaged, true);
    assert.equal(readJson(receiptFile(fixture)).outcome, 'not-committed');
    const live = readJson(path.join(fixture.workspace, '.ploinky', 'data', 'edge-routing', 'active.json'));
    assert.equal(live.state, 'inactive');
    assert.notEqual(live.selectorDigest, intended.selectorDigest);
    assert.deepEqual(fs.readFileSync(fixture.policyFile), fixture.policyBytes, 'the policy is back at the predecessor bytes');
    assert.deepEqual(fs.readFileSync(activationMarkerPath(fixture.workspace)), markerBytes, 'a pre-publication failure removes nothing');
});

test('W2: a failure after the rename keeps the published selector, the intent and the staged policy', (t) => {
    const fixture = createFixture(t);
    let intendedDigest;
    let intentBeforeRename = null;
    const { error } = commit(fixture, {
        request: admit(fixture, 'activate'),
        testHooks: {
            afterSelectorRename({ selector }) {
                intendedDigest = selector.selectorDigest;
                intentBeforeRename = fs.existsSync(intentFile(fixture));
                throw new Error('directory sync failed');
            },
        },
    });
    assert.equal(intentBeforeRename, true, 'the intent exists before the rename');
    assert.equal(error?.edgeSelectorCommitted, true);
    assert.equal(liveSelector(fixture).selectorDigest, intendedDigest);
    assert.equal(fs.existsSync(receiptFile(fixture)), false, 'no not-committed receipt after publication');
    const staged = policy(fixture);
    assert.equal(staged.prod, true, 'never weaker than the capture');
    assert.deepEqual(staged.routes.alpha.tools, ['new', 'old'], 'still the staged union, not finalized');
});

test('W3: a settlement failure after the commit keeps the selector with a committed receipt', (t) => {
    const fixture = createFixture(t);
    let committedDigest;
    const { error, activated } = commit(fixture, {
        request: admit(fixture, 'activate'),
        afterCommit({ selector }) { committedDigest = selector.selectorDigest; throw new Error('settlement failed'); },
    });
    assert.equal(error?.message, 'settlement failed');
    assert.equal(error.edgeSelectorCommitted, true);
    assert.equal(activated(), true);
    assert.equal(liveSelector(fixture).selectorDigest, committedDigest);
    assert.equal(readJson(receiptFile(fixture)).outcome, 'committed');
    assert.deepEqual(policy(fixture), CAPTURE, 'the policy was finalized before the later failure');
});

test('W3: an activation keeps its own markers; a settle removes only the settled non-writer marker', (t) => {
    const cases = [
        ['activate keeps its own writer marker', 'activate', null, 'writer', OWN, true],
        ['activate keeps its own activated marker', 'activate', null, 'activated', OWN, true],
        ['activate removes a stale marker of another operation', 'activate', null, 'indeterminate', SETTLED, false],
        ['activate keeps another operation\'s writer marker', 'activate', null, 'writer', SETTLED, true],
        ['settle removes the settled activated marker', 'settle', SETTLED, 'activated', SETTLED, false],
        ['settle keeps a writer marker of the settled id', 'settle', SETTLED, 'writer', SETTLED, true],
        ['settle keeps an unrelated marker', 'settle', SETTLED, 'activated', '3'.repeat(32), true],
        ['restore keeps every marker', 'restore', null, 'activated', SETTLED, true],
    ];
    for (const [label, purpose, settles, state, markerId, kept] of cases) {
        const fixture = createFixture(t);
        const bytes = placeMarker(fixture, state, markerId);
        const { error, activated } = commit(fixture, { request: admit(fixture, purpose, settles) });
        assert.equal(error, undefined, label);
        assert.equal(activated(), true, label);
        assert.equal(fs.existsSync(activationMarkerPath(fixture.workspace)), kept, label);
        if (kept) assert.deepEqual(fs.readFileSync(activationMarkerPath(fixture.workspace)), bytes, label);
        if (purpose === 'restore') {
            assert.equal(fs.existsSync(intentFile(fixture)), false, `${label}: no intent`);
            assert.equal(fs.existsSync(receiptFile(fixture)), false, `${label}: no receipt`);
            assert.deepEqual(policy(fixture), CAPTURE, `${label}: the policy is still staged and finalized`);
        } else {
            assert.equal(readJson(receiptFile(fixture)).outcome, 'committed', label);
        }
    }
});

test('without a request or a capture the hooks only mark the workspace activated', (t) => {
    const fixture = createFixture(t);
    let activated = false;
    const hooks = activationCommitHooks({ workspaceRoot: fixture.workspace, onActivated() { activated = true; } });
    assert.deepEqual(Object.keys(hooks), ['afterSelectorCommit']);
    applyEdgeRoutingGeneration({ workspaceRoot: fixture.workspace, ...hooks });
    assert.equal(activated, true);
    assert.equal(fs.existsSync(path.join(fixture.workspace, '.ploinky', 'data', 'edge-routing', 'activations')), false);
});
