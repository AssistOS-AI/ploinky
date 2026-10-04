// M-NW-01 D2-S: the frozen v1 `slots` schema of the hardware-availability policy.
// Staging, resolution and the latcher are separate slices; this file holds the
// leaves of the schema the store validates now (writers write `slots: {}`).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';

import { initializeFreshEdgeRoutingSources } from '../../cli/sandbox/edgeGeneration.js';
import { readHardwareAvailabilityPolicy } from '../../cli/sandbox/hardwareAvailabilityStore.mjs';
import { SCHEMA, commit, entryFor, makeWorkspace, sha256, slotFor, uuid } from './hardwareAvailabilityFixtures.mjs';

const UNREADABLE = 'HARDWARE_AVAILABILITY_POLICY_UNREADABLE';
const readStore = (paths) => readHardwareAvailabilityPolicy({ paths });

// The revision formula, computed independently of the implementation.
function independentStable(value) {
    if (Array.isArray(value)) return value.map(independentStable);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, independentStable(value[key])]));
    return value;
}
const independentRevision = ({ schema, storeId, entries, slots }) => `sha256:${crypto.createHash('sha256')
    .update(JSON.stringify(independentStable({ schema, storeId, entries, slots }))).digest('hex')}`;

function newStore(t, entries = { alpha: entryFor('alpha') }) {
    const workspace = makeWorkspace(t);
    initializeFreshEdgeRoutingSources({ workspaceRoot: workspace.root });
    commit(workspace.root, workspace.paths, { expectedRevision: readStore(workspace.paths).revision, entries });
    return workspace;
}

test('NW1.S-frozen-v1-slot-schema-and-cross-field-rules-refuse-without-a-partial-write', async (t) => {
    // Accepted: the full frozen shape, with the revision over {schema, storeId, entries, slots}.
    const ok = newStore(t);
    const slots = { beta: slotFor('beta', { startupGraceMs: 0 }), gamma: slotFor('gamma', { startupGraceMs: 300000 }) };
    const committed = commit(ok.root, ok.paths, { expectedRevision: readStore(ok.paths).revision, slots });
    assert.equal(committed.committed, true);
    const read = readStore(ok.paths);
    assert.deepEqual(read.slots, slots);
    assert.deepEqual(Object.keys(read.entries), ['alpha']);
    const file = JSON.parse(fs.readFileSync(ok.paths.availabilityPolicyFile, 'utf8'));
    assert.deepEqual(Object.keys(file).sort(), ['entries', 'revision', 'schema', 'slots', 'storeId']);
    assert.equal(file.schema, SCHEMA);
    assert.equal(file.revision, independentRevision(file));
    assert.notEqual(file.revision, independentRevision({ ...file, slots: {} }), 'the slots are part of the revision');
    // An entry and a slot of one route with different run ids coexist.
    const alphaSlot = slotFor('alpha');
    commit(ok.root, ok.paths, { expectedRevision: read.revision, slots: { ...slots, alpha: alphaSlot } });
    assert.equal(readStore(ok.paths).slots.alpha.runId, alphaSlot.runId);

    const mutate = (change) => () => { const slot = slotFor('beta'); change(slot); return { beta: slot }; };
    const refused = {
        '257 slots': [() => Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`s${index}`, slotFor(`s${index}`)])), 'HARDWARE_AVAILABILITY_POLICY_FULL'],
        'an unsupported extra key': [mutate((slot) => { slot.extra = 1; })],
        'a missing key': [mutate((slot) => { delete slot.waveIndex; })],
        'a key with a path separator': [() => ({ beta: slotFor('beta', { key: '../beta', statusFile: `../beta.${uuid()}.json` }) })],
        'an empty key': [mutate((slot) => { slot.key = ''; })],
        'an instance id equal to the enable generation': [mutate((slot) => { slot.enableGeneration = slot.instanceId; })],
        'an unsafe instance id': [mutate((slot) => { slot.instanceId = 'has space'; })],
        'a non-canonical run id (upper case)': [mutate((slot) => { slot.runId = slot.runId.toUpperCase(); slot.statusFile = `${slot.key}.${slot.runId}.json`; })],
        'a run id that is not a uuid': [mutate((slot) => { slot.runId = 'run-1'; slot.statusFile = `${slot.key}.run-1.json`; })],
        'a status file that is not key.runId.json': [mutate((slot) => { slot.statusFile = 'other.json'; })],
        'a wave index over the protocol bound': [mutate((slot) => { slot.waveIndex = 1024; })],
        'a negative run start': [mutate((slot) => { slot.runStartedAtMs = -1; })],
        'a missing startupGraceMs': [mutate((slot) => { delete slot.startupGraceMs; })],
        'a negative startupGraceMs': [mutate((slot) => { slot.startupGraceMs = -1; })],
        'a startupGraceMs over the protocol bound': [mutate((slot) => { slot.startupGraceMs = 300001; })],
        'a fractional startupGraceMs': [mutate((slot) => { slot.startupGraceMs = 1.5; })],
        'a string startupGraceMs': [mutate((slot) => { slot.startupGraceMs = '60'; })],
        'two slots for one key': [() => ({ beta: slotFor('beta', { key: 'ploinky_fixtures_beta' }), betaTwo: slotFor('betaTwo', { key: 'ploinky_fixtures_beta' }) })],
        'a reserved route key': [() => JSON.parse(`{"__proto__": ${JSON.stringify(slotFor('beta'))}}`)],
        'a slot that is not an object': [() => ({ beta: 'slot' })],
    };
    for (const [label, [build, code = 'HARDWARE_AVAILABILITY_POLICY_INVALID']] of Object.entries(refused)) {
        await t.test(label, () => {
            const workspace = newStore(t);
            const bytes = sha256(workspace.paths.availabilityPolicyFile);
            assert.throws(() => commit(workspace.root, workspace.paths, { expectedRevision: readStore(workspace.paths).revision, slots: build() }), (error) => error.code === code, label);
            assert.equal(sha256(workspace.paths.availabilityPolicyFile), bytes, 'the old policy is intact');
            assert.deepEqual(fs.readdirSync(workspace.paths.availabilityStoreDir), ['policy.json'], 'no temp and no partial write');
        });
    }

    await t.test('an entry and a slot of one route sharing a run id', () => {
        const sharedRun = uuid();
        const workspace = newStore(t, { alpha: entryFor('alpha', { runId: sharedRun }) });
        const bytes = sha256(workspace.paths.availabilityPolicyFile);
        assert.throws(() => commit(workspace.root, workspace.paths, {
            expectedRevision: readStore(workspace.paths).revision,
            slots: { alpha: slotFor('alpha', { runId: sharedRun }) },
        }), (error) => error.code === 'HARDWARE_AVAILABILITY_POLICY_INVALID' && /share a run id/.test(error.message));
        assert.equal(sha256(workspace.paths.availabilityPolicyFile), bytes);
        assert.deepEqual(fs.readdirSync(workspace.paths.availabilityStoreDir), ['policy.json']);
    });

    // A policy file edited by hand is judged by the same rules, even with a recomputed revision.
    await t.test('the reader refuses hand-written violations with a valid revision', () => {
        for (const damage of [
            (document) => { delete document.slots.beta.startupGraceMs; },
            (document) => { document.slots.beta.startupGraceMs = 300001; },
            (document) => { document.slots.alpha = slotFor('alpha', { runId: document.entries.alpha.source.runId }); },
        ]) {
            const workspace = newStore(t);
            commit(workspace.root, workspace.paths, { expectedRevision: readStore(workspace.paths).revision, slots: { beta: slotFor('beta') } });
            const document = JSON.parse(fs.readFileSync(workspace.paths.availabilityPolicyFile, 'utf8'));
            damage(document);
            document.revision = independentRevision(document);
            fs.writeFileSync(workspace.paths.availabilityPolicyFile, JSON.stringify(document));
            assert.throws(() => readStore(workspace.paths), (error) => error.code === UNREADABLE);
        }
    });
});
