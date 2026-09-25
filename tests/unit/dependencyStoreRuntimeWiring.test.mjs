// Behavioral runtime-wiring proofs for the dependency store. Each test drives
// the production ensureAgentService / seatbelt link guard in a child process
// against a temporary workspace and the stateful fake engine on PATH; no
// production seam is injected (liveness, receipts, registry and the image
// inspection all use their defaults).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
    CONTAINER,
    driveWiring,
    payloadSnapshot,
    readerReceiptsDir,
    registration,
    stepValue,
    wiringWorkspace,
} from './dependencyStoreWiringHarness.mjs';

const IMAGE_A = `sha256:${'a'.repeat(64)}`;
const IMAGE_B = `sha256:${'b'.repeat(64)}`;

function firstStart(w, { containerName = CONTAINER, record = {}, label = 'first', hostRouter = false, routeKey } = {}) {
    return [
        { action: 'register', containerName, record: { ...registration(record), projectPath: path.join(w.ws, '.data', record.alias || 'demo') } },
        { action: 'prepare-lease' },
        { label, action: 'ensure-with-lease', containerName, startPath: true, activate: true, hostRouter, routeKey },
    ];
}

test('dependency store wiring: a new image ID under the same tag builds a new object through the real start path', (t) => {
    const w = wiringWorkspace(t);
    const first = stepValue(driveWiring(w, [{ action: 'init-edge' }, ...firstStart(w)]), 'first');
    assert.equal(first.dependencies.mode, 'store');
    assert.equal(first.dependencies.imageId, IMAGE_A);
    assert.equal(w.engine.state().installs.length, 1);
    const before = payloadSnapshot(first.dependencies);

    // Same tag (node:20), different immutable image ID from the engine.
    const after = driveWiring(w, [
        { action: 'prepare-lease' },
        { label: 'retagged', action: 'ensure-with-lease', containerName: CONTAINER, startPath: true, activate: true },
        { label: 'predecessor', action: 'validate-object', objectId: first.dependencies.objectId, inputKey: first.dependencies.inputKey },
    ], { env: { FAKE_ENGINE_IMAGE_HEX: 'b'.repeat(64) } });
    const retagged = stepValue(after, 'retagged');
    assert.equal(retagged.createdByThisLaunch, true, 'the runtime is replaced for the new image');
    assert.equal(retagged.dependencies.imageId, IMAGE_B);
    assert.notEqual(retagged.dependencies.objectId, first.dependencies.objectId, 'a new store object is published for the new image ID');
    assert.notEqual(retagged.dependencies.inputKey, first.dependencies.inputKey, 'the image ID is part of the input key');
    assert.equal(w.engine.state().installs.length, 2, 'the installer ran again for the new image');
    assert.deepEqual(w.engine.state().installs[1].preexisting, [], 'the new object installs from empty npm state');
    assert.deepEqual(retagged.stored, retagged.dependencies, 'the runtime record references the new object');
    assert.equal(stepValue(after, 'predecessor').valid, true, 'the predecessor object stays valid');
    assert.deepEqual(payloadSnapshot(first.dependencies), before, 'predecessor payload bytes unchanged');
});

const SEATBELT_MANIFEST = { 'lite-sandbox': true, start: 'node index.js', network: { mode: 'host' }, readiness: { protocol: 'none' } };
const SEATBELT_SKIP = process.platform !== 'darwin' && 'seatbelt runs on macOS only';
const ALIAS_B = 'ploinky_repo_demo_b';

function seatbeltWorkspace(t) {
    const w = wiringWorkspace(t, { manifest: SEATBELT_MANIFEST, prefix: 'depstore-seatbelt-' });
    // The fake sandbox-exec runs `sleep 30`; kill exactly the sandboxes this
    // test started (their PIDs come from the admitted registry records).
    w.sandboxPids = new Set();
    t.after(() => {
        for (const pid of w.sandboxPids) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    });
    return w;
}

function seatbeltStart(w, containerName, record, label) {
    return [
        { action: 'register', containerName, record: { ...registration(record), runtime: 'seatbelt', projectPath: path.join(w.ws, '.data', record.alias || 'demo') } },
        { action: 'prepare-lease' },
        { label, action: 'ensure-with-lease', hostRouter: true, containerName, startPath: true, activate: true, routeKey: record.alias || 'demo' },
    ];
}

function alive(pid) {
    try { process.kill(pid, 0); return true; } catch { return false; }
}

test('dependency store wiring (seatbelt): a package change never switches the shared source link under a live alias (production liveness)', { skip: SEATBELT_SKIP }, (t) => {
    const w = seatbeltWorkspace(t);
    const link = path.join(w.agentDir, 'code', 'node_modules');
    const started = driveWiring(w, [
        { action: 'init-edge' },
        { action: 'enable-sandbox' },
        ...seatbeltStart(w, CONTAINER, {}, 'a'),
        ...seatbeltStart(w, ALIAS_B, { alias: 'demob', instanceId: 'inst-b', enableGeneration: 'gen-b' }, 'b'),
    ]);
    const a = stepValue(started, 'a');
    const b = stepValue(started, 'b');
    assert.equal(a.runtime, 'seatbelt');
    assert.equal(b.runtime, 'seatbelt');
    assert.equal(b.dependencies.objectId, a.dependencies.objectId, 'both aliases of one source share one object');
    assert.equal(fs.readlinkSync(link), a.dependencies.nodeModulesPath);
    for (const started of [a, b]) {
        assert.ok(Number.isInteger(started.pid) && started.pid > 0, 'the registry records the sandbox process');
        w.sandboxPids.add(started.pid);
    }
    assert.notEqual(a.pid, b.pid);
    assert.ok(alive(a.pid) && alive(b.pid), 'both aliases run as real live sandbox processes');

    fs.writeFileSync(path.join(w.agentDir, 'code', 'package.json'), JSON.stringify({ name: 'demo', dependencies: { 'left-pad': '1.3.1' } }));
    const changed = driveWiring(w, [
        { label: 'replace-a', action: 'ensure-with-lease', hostRouter: true, containerName: CONTAINER, activate: true, allowFailure: true },
    ]);
    assert.equal(changed['replace-a'].ok, false, `A must not switch the link under live B: ${JSON.stringify(changed['replace-a'])}`);
    // The sandbox start path wraps the guard's error; the guard's own code
    // is preserved as the cause.
    assert.equal(changed['replace-a'].code, 'PLOINKY_HOST_SANDBOX_START_FAILED');
    assert.equal(changed['replace-a'].causeCode, 'PLOINKY_DEPS_SEATBELT_LIVE_SWITCH');
    assert.match(changed['replace-a'].message, new RegExp(`refusing to switch .* another seatbelt consumer of this source is live \\(${ALIAS_B}\\)`));
    assert.equal(fs.readlinkSync(link), b.dependencies.nodeModulesPath, 'the live consumer keeps its admitted payload path');
    assert.ok(alive(b.pid), 'the live consumer was not stopped');
});

test('dependency store wiring (seatbelt): an unreadable reader receipt fails the shared link switch closed', { skip: SEATBELT_SKIP }, (t) => {
    const w = seatbeltWorkspace(t);
    const link = path.join(w.agentDir, 'code', 'node_modules');
    const a = stepValue(driveWiring(w, [
        { action: 'init-edge' },
        { action: 'enable-sandbox' },
        ...seatbeltStart(w, CONTAINER, {}, 'a'),
    ]), 'a');
    w.sandboxPids.add(a.pid);
    assert.equal(fs.readlinkSync(link), a.dependencies.nodeModulesPath);
    // A second, fully built generation the link would be switched to.
    fs.writeFileSync(path.join(w.agentDir, 'code', 'package.json'), JSON.stringify({ name: 'demo', dependencies: { 'left-pad': '1.3.1' } }));
    // Valid JSON that belongs to another workspace: liveness is unprovable.
    fs.writeFileSync(path.join(readerReceiptsDir(w), 'zz-foreign.json'), JSON.stringify({
        schema: 1, workspaceId: 'another-workspace', objectId: a.dependencies.objectId,
        consumer: { kind: 'seatbelt-attachment', sourceLink: link, process: { pid: process.pid } },
    }));
    const result = driveWiring(w, [
        { label: 'switch', action: 'ensure-with-lease', hostRouter: true, containerName: CONTAINER, activate: true, allowFailure: true },
    ]);
    assert.equal(result.switch.ok, false, `an unreadable receipt must fail closed: ${JSON.stringify(result.switch)}`);
    assert.match(result.switch.message, /\[seatbelt\] demo: failed to inspect .*reader receipt zz-foreign\.json is unreadable/);
    assert.equal(fs.readlinkSync(link), a.dependencies.nodeModulesPath, 'the shared link is unchanged');
});

test('dependency store wiring: the admitted registry record, not the desired state, selects an activated pending rebuild', (t) => {
    const w = wiringWorkspace(t);
    const first = stepValue(driveWiring(w, [{ action: 'init-edge' }, ...firstStart(w)]), 'first');
    assert.equal(first.dependencies.rebuildToken, null);

    // Reinstall's first half: issue the desired rebuild request and replace
    // the runtime inside the same command scope, then activate it. The
    // settlement that would promote the token to "admitted" never happens.
    const reinstall = driveWiring(w, [
        { label: 'request', action: 'issue-rebuild', containerName: CONTAINER },
        { label: 'rebuilt', action: 'ensure-with-lease', containerName: CONTAINER, activate: true, options: { forceRecreate: true } },
    ], { refresh: 'reinstall' });
    const token = stepValue(reinstall, 'request').token;
    const rebuilt = stepValue(reinstall, 'rebuilt');
    assert.equal(rebuilt.dependencies.rebuildToken, token);
    assert.notEqual(rebuilt.dependencies.objectId, first.dependencies.objectId, 'the rebuild published its own object');
    assert.deepEqual(rebuilt.stored, rebuilt.dependencies, 'the activated record carries the pending token');
    assert.equal(w.engine.state().installs.length, 2);

    // The runtime disappears; a later start (a new command, no rebuild memo)
    // must key on the token its admitted record proves, not fall back to the
    // older admitted metadata token.
    const state = JSON.parse(fs.readFileSync(w.engine.stateFile, 'utf8'));
    state.containers = {};
    fs.writeFileSync(w.engine.stateFile, JSON.stringify(state, null, 2));
    const later = driveWiring(w, [
        { label: 'rebuild-state', action: 'read-rebuild-state', containerName: CONTAINER },
        { label: 'restart', action: 'ensure-with-lease', containerName: CONTAINER, activate: true },
    ], { refresh: 'start' });
    const rebuildState = stepValue(later, 'rebuild-state');
    assert.equal(rebuildState.desired?.token, token, 'the request is still pending');
    assert.notEqual(rebuildState.admittedToken, token);
    const restarted = stepValue(later, 'restart');
    assert.equal(restarted.createdByThisLaunch, true);
    assert.equal(restarted.dependencies.rebuildToken, token, 'the admitted record\'s activated token is kept');
    assert.equal(restarted.dependencies.objectId, rebuilt.dependencies.objectId, 'the rebuilt object is reused, not the pre-rebuild one');
    assert.equal(w.engine.state().installs.length, 2, 'no further install');
});
