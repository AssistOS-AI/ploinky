// Runtime integration of the immutable dependency cache (P2c/P1b): the shared
// reuse decision, receipts, predecessor protection and per-path wiring.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createCacheStore } from '../../cli/utils/dependencies/store/objectStore.mjs';
import { sha256Hex } from '../../cli/utils/dependencies/store/canonical.mjs';
import { hashInstalledTree } from '../../cli/utils/dependencies/store/treeHash.mjs';
import { buildPin } from '../../cli/utils/dependencies/store/gitPins.mjs';
import {
    admittedDependencyRecord,
    attachAdmittedDependencies,
    noCacheDependencyRecord,
    issueDependencyRebuildRequest,
    planRuntimeDependencies,
    prepareRuntimeDependencies,
    runtimeCarriesRebuildToken,
    settleDependencyRebuildRequest,
    registrationIdFor,
    runtimeDependencyReuseProblem,
} from '../../cli/utils/dependencies/store/runtimeDependencies.mjs';
import { ensureSeatbeltCodeNodeModules, liveSeatbeltSourceConsumers } from '../../cli/sandbox/seatbelt/seatbeltServiceManager.js';
import { hasAdmittedDependencyMount, selectPredecessorRemovalRecord } from '../../cli/sandbox/docker/agentServiceManager.js';
import { withDependencyRefresh } from '../../cli/utils/dependencies/dependencyRefresh.mjs';
import { fakeInstaller, fakeLease, hostProbe, makeAgentLib, tempRoot } from './dependencyStoreFixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const IMAGE_A = `sha256:${'a'.repeat(64)}`;
const IMAGE_B = `sha256:${'b'.repeat(64)}`;
const GLOBAL = Object.freeze({ name: 'ploinky-global-deps', version: '1.0.0', dependencies: { 'left-pad': '1.3.0' } });
const FAMILIES = Object.freeze({
    container: { runtimeKey: 'container-linux-x64-glibc-node20', engine: 'podman', image: 'node:20' },
    bwrap: { runtimeKey: 'bwrap-darwin-arm64-node25' },
    seatbelt: { runtimeKey: 'seatbelt-darwin-arm64-node25' },
});

function world(t) {
    const root = tempRoot(t, 'depstore-runtime-');
    const { lease, assertLease } = fakeLease();
    const store = createCacheStore({ depsDir: path.join(root, '.ploinky', 'deps'), workspaceRoot: root, assertLease, checkDiskSpace: () => ({ ok: true }) });
    const agentCodePath = path.join(root, 'repo', 'agent', 'code');
    fs.mkdirSync(agentCodePath, { recursive: true });
    fs.writeFileSync(path.join(agentCodePath, 'package.json'), JSON.stringify({ name: 'agent', dependencies: { chalk: '5.0.0' } }));
    const state = {
        agentLib: makeAgentLib(root),
        images: { 'node:20': IMAGE_A },
        installer: fakeInstaller(),
        leaseRequests: 0,
    };
    const deps = {
        store,
        workspaceRoot: root,
        memo: null,
        inspectImage: ({ image }) => state.images[image],
        probeHostToolchain: () => hostProbe(),
        npmConfigSources: () => ({ env: {}, files: [] }),
        readGlobalPackage: () => GLOBAL,
        agentLibSelection: () => state.agentLib,
        sdkBundle: () => null,
        hostRuntimeKey: (family) => FAMILIES[family].runtimeKey,
        createInstaller: () => state.installer,
        resolveLease: (given) => {
            state.leaseRequests += 1;
            if (given) assertLease(given);
            return { lease, release() {} };
        },
    };
    return { root, store, lease, agentCodePath, state, deps };
}

function input(family, w, registration = 'ploinky_repo_agent') {
    const { runtimeKey, engine = '', image = '' } = FAMILIES[family];
    return { family, runtimeKey, engine, image, agentCodePath: w.agentCodePath, registration };
}

function consumer(family, name = 'ploinky_repo_agent') {
    return { kind: `${family}-service`, key: `${family}:${name}:inst:gen-1`, containerName: name, phase: 'creating' };
}

function reuseProblem(family, w, record, overrides = {}) {
    const { engine = '', image = '' } = FAMILIES[family];
    return runtimeDependencyReuseProblem({
        record, family, needsDependencies: true, agentCodePath: w.agentCodePath, registration: 'ploinky_repo_agent',
        engine, image, ...overrides,
    }, w.deps);
}

function treeSnapshot(record) {
    const manifest = fs.readFileSync(path.join(path.dirname(record.payloadPath), 'manifest.json'));
    return {
        tree: hashInstalledTree(record.payloadPath, { approvedExternalTargets: [JSON.parse(manifest).approvedExternalTargets].flat() }).hash,
        link: fs.readlinkSync(path.join(record.nodeModulesPath, 'achillesAgentLib')),
        manifest: sha256Hex(manifest),
    };
}

for (const family of Object.keys(FAMILIES)) {
    test(`dependency store runtime ${family}: an unchanged generation is reused with zero installer calls`, (t) => {
        const w = world(t);
        const first = prepareRuntimeDependencies(input(family, w), { consumer: consumer(family) }, w.deps);
        assert.equal(first.status, 'built');
        assert.equal(first.record.mode, 'store');
        assert.equal(first.record.family, family);
        assert.equal(reuseProblem(family, w, { runtime: family, dependencies: first.record }), '');
        const calls = w.state.installer.calls.length;
        const warm = prepareRuntimeDependencies(input(family, w), { consumer: consumer(family) }, w.deps);
        assert.equal(warm.status, 'hit');
        assert.equal(w.state.installer.calls.length, calls, 'warm start performs no installer calls');
        assert.equal(warm.record.generationId, first.record.generationId);
        assert.equal(fs.readdirSync(w.store.paths.readerReceipts).length, 1, 'the same consumer re-acquires one idempotent receipt');
    });

    test(`dependency store runtime ${family}: package, AgentLib and rebuild-token changes require replacement without touching the predecessor`, (t) => {
        const w = world(t);
        const first = prepareRuntimeDependencies(input(family, w), { consumer: consumer(family) }, w.deps);
        const admitted = { runtime: family, dependencies: first.record };
        const before = treeSnapshot(first.record);

        fs.writeFileSync(path.join(w.agentCodePath, 'package.json'), JSON.stringify({ name: 'agent', dependencies: { chalk: '5.1.0' } }));
        assert.equal(reuseProblem(family, w, admitted), 'dependency inputs changed');
        const next = prepareRuntimeDependencies(input(family, w), { consumer: consumer(family, 'ploinky_repo_agent__candidate_0123456789ab') }, w.deps);
        assert.notEqual(next.record.objectId, first.record.objectId);
        assert.deepEqual(treeSnapshot(first.record), before, 'predecessor bytes, AgentLib link text and manifest unchanged');
        fs.writeFileSync(path.join(w.agentCodePath, 'package.json'), JSON.stringify({ name: 'agent', dependencies: { chalk: '5.0.0' } }));
        assert.equal(reuseProblem(family, w, admitted), '', 'restored inputs match the admitted generation again');

        w.state.agentLib = { ...w.state.agentLib, fingerprint: 'fp-2' };
        assert.equal(reuseProblem(family, w, admitted), 'dependency inputs changed');
        w.state.agentLib = { ...w.state.agentLib, fingerprint: 'fp-1' };

        const tokenFile = path.join(w.store.root, 'state', 'rebuild', `${sha256Hex('ploinky_repo_agent')}.json`);
        fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
        fs.writeFileSync(tokenFile, JSON.stringify({ schema: 1, registration: 'ploinky_repo_agent', revision: 1, admittedToken: 'rebuild-1', desired: null }));
        assert.equal(reuseProblem(family, w, admitted), 'dependency inputs changed');
        assert.deepEqual(treeSnapshot(first.record), before);
    });

    test(`dependency store runtime ${family}: unrecorded, missing and corrupt admitted generations require replacement`, (t) => {
        const w = world(t);
        // A node_modules bind outside the store with no dependency record (for
        // example one an older release left) is unknown, never a generation.
        const unrecordedSource = path.join(w.root, '.ploinky', 'deps', 'agents', 'repo', 'agent', FAMILIES[family].runtimeKey, 'node_modules');
        fs.mkdirSync(unrecordedSource, { recursive: true });
        const unrecorded = { runtime: family, config: { binds: [{ source: unrecordedSource, target: '/code/node_modules', ro: true }] } };
        assert.deepEqual(admittedDependencyRecord(unrecorded), { mode: 'unknown' });
        assert.equal(reuseProblem(family, w, unrecorded), 'admitted runtime has no dependency generation record');
        assert.equal(reuseProblem(family, w, unrecorded, { needsDependencies: false }), '',
            'a runtime that needs no dependencies mounts no store generation and is reused');
        assert.equal(attachAdmittedDependencies(unrecorded, { consumer: { kind: `${family}-attachment`, process: { pid: process.pid } } }, w.deps), null,
            'an unrecorded tree is never attached');
        assert.equal(fs.existsSync(w.store.paths.readerReceipts) ? fs.readdirSync(w.store.paths.readerReceipts).length : 0, 0);
        assert.equal(w.state.installer.calls.length, 0, 'the decision is read-only');
        assert.equal(reuseProblem(family, w, { runtime: family }), 'admitted runtime has no dependency generation record');
        const first = prepareRuntimeDependencies(input(family, w), { consumer: consumer(family) }, w.deps);
        fs.appendFileSync(path.join(first.nodeModulesPath, 'left-pad', 'index.js'), '// tampered');
        assert.match(reuseProblem(family, w, { runtime: family, dependencies: first.record }), /installed tree hash mismatch/);
    });
}

test('dependency store runtime container: a new image ID under the same tag requires replacement', (t) => {
    const w = world(t);
    const first = prepareRuntimeDependencies(input('container', w), { consumer: consumer('container') }, w.deps);
    const admitted = { runtime: 'podman', dependencies: first.record };
    assert.equal(first.record.imageId, IMAGE_A);
    w.state.images['node:20'] = IMAGE_B;
    assert.equal(reuseProblem('container', w, admitted), 'runtime image changed');
    delete w.state.images['node:20'];
    assert.match(reuseProblem('container', w, admitted), /desired dependency identity unavailable/);
});

test('dependency store runtime: no-cache agents and no-node images keep their existing paths', (t) => {
    const w = world(t);
    const noCache = { runtime: 'podman', dependencies: noCacheDependencyRecord('no-core-deps', { family: 'container' }) };
    assert.equal(reuseProblem('container', w, noCache, { needsDependencies: false }), '');
    assert.equal(reuseProblem('container', w, { runtime: 'podman' }, { needsDependencies: false }), '', 'start-only records without a dependency record reuse');
    const noNode = { runtime: 'podman', dependencies: noCacheDependencyRecord('no-node-image', { family: 'container', runtimeKey: 'container-no-node', imageId: IMAGE_A }) };
    assert.equal(reuseProblem('container', w, noNode, { noNodeAllowed: true }), '');
    assert.match(reuseProblem('container', w, noNode, { noNodeAllowed: false }), /dependency mode changed/);
    const first = prepareRuntimeDependencies(input('container', w), { consumer: consumer('container') }, w.deps);
    assert.equal(reuseProblem('container', w, { runtime: 'podman', dependencies: first.record }, { needsDependencies: false }),
        'runtime no longer needs its dependency cache');
    assert.equal(w.state.installer.calls.length, 1);
});

test('dependency store runtime: candidates share their registration and preparation always uses the caller lease', (t) => {
    const w = world(t);
    assert.equal(registrationIdFor('ploinky_repo_agent__candidate_0123456789ab'), 'ploinky_repo_agent');
    const tokenFile = path.join(w.store.root, 'state', 'rebuild', `${sha256Hex('ploinky_repo_agent')}.json`);
    fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
    fs.writeFileSync(tokenFile, JSON.stringify({ schema: 1, registration: 'ploinky_repo_agent', revision: 1, admittedToken: 'rebuild-7', desired: null }));
    const candidate = prepareRuntimeDependencies(input('container', w, 'ploinky_repo_agent__candidate_0123456789ab'),
        { consumer: consumer('container', 'ploinky_repo_agent__candidate_0123456789ab'), lease: w.lease }, w.deps);
    assert.equal(candidate.plan.rebuildToken, 'rebuild-7', 'the candidate sees its logical registration token');
    assert.equal(w.state.leaseRequests, 1);
    candidate.updateConsumer({ containerId: 'c'.repeat(64), phase: 'created' });
    const receipt = JSON.parse(fs.readFileSync(candidate.readerReceipt.path, 'utf8'));
    assert.equal(receipt.consumer.containerId, 'c'.repeat(64));
    assert.equal(receipt.consumer.phase, 'created');
});

test('dependency store runtime: one command computes one desired plan for graph preparation and runtime reuse', (t) => {
    const w = world(t);
    const memo = new Map();
    const deps = { ...w.deps, memo };
    const planA = planRuntimeDependencies(input('container', w), deps);
    const planB = planRuntimeDependencies(input('container', w), deps);
    assert.equal(planA, planB, 'memoized per lifecycle command');
    fs.writeFileSync(path.join(w.agentCodePath, 'package.json'), JSON.stringify({ name: 'agent', dependencies: { chalk: '9.0.0' } }));
    assert.notEqual(planRuntimeDependencies(input('container', w), deps).agentPlan.inputKey, planA.agentPlan.inputKey,
        'changed package bytes are never served from the memo');
});

test('dependency store runtime: attachments reuse the admitted generation read-only with their own receipt', (t) => {
    const w = world(t);
    const first = prepareRuntimeDependencies(input('bwrap', w), { consumer: consumer('bwrap') }, w.deps);
    const calls = w.state.installer.calls.length;
    const attached = attachAdmittedDependencies({ runtime: 'bwrap', dependencies: first.record },
        { consumer: { kind: 'bwrap-attachment', process: { pid: process.pid } } }, w.deps);
    assert.equal(attached.nodeModulesPath, first.nodeModulesPath);
    assert.equal(fs.readdirSync(w.store.paths.readerReceipts).length, 2, 'service and attachment receipts are separate');
    attached.release();
    assert.equal(fs.readdirSync(w.store.paths.readerReceipts).length, 1);
    assert.equal(w.state.installer.calls.length, calls, 'attachments never build');
    fs.appendFileSync(path.join(first.nodeModulesPath, 'left-pad', 'index.js'), '// tampered');
    assert.throws(() => attachAdmittedDependencies({ runtime: 'bwrap', dependencies: first.record },
        { consumer: { kind: 'bwrap-attachment', process: { pid: process.pid } } }, w.deps), { code: 'PLOINKY_DEPS_GENERATION_INVALID' });
    assert.equal(fs.readdirSync(w.store.paths.readerReceipts).length, 1, 'a failed attachment leaves no receipt');
    assert.equal(attachAdmittedDependencies({ runtime: 'bwrap' }, { consumer: { kind: 'bwrap-attachment' } }, w.deps), null);
});

test('dependency store runtime: an activated rebuild survives failure to settle its metadata', (t) => {
    const w = world(t);
    const command = { ...w.deps, memo: new Map() };
    const old = prepareRuntimeDependencies(input('container', w), { consumer: consumer('container') }, command);
    const request = issueDependencyRebuildRequest('ploinky_repo_agent', {}, command);
    const activated = prepareRuntimeDependencies(input('container', w), { consumer: consumer('container') }, command);
    // Simulate successful activation followed by a failed state write: the
    // registry has the activated generation, while the desired request remains.
    const next = { ...w.deps, memo: new Map() };
    const record = { dependencies: activated.record };
    assert.equal(runtimeDependencyReuseProblem({ ...input('container', w), record, needsDependencies: true }, next), '');
    const restarted = prepareRuntimeDependencies({ ...input('container', w), admittedRecord: record }, { consumer: consumer('container') }, next);
    assert.equal(restarted.record.objectId, activated.record.objectId);
    assert.equal(restarted.record.rebuildToken, request.token);
    assert.notEqual(restarted.record.objectId, old.record.objectId);
    assert.equal(w.store.readRebuildState('ploinky_repo_agent').admittedToken, null);
    assert.equal(runtimeCarriesRebuildToken({}, request.token), false);
});

test('dependency store runtime: a command memo cannot hide a pin or provider change', (t) => {
    const w = world(t);
    fs.writeFileSync(path.join(w.agentCodePath, 'package.json'), JSON.stringify({ dependencies: { example: 'git+https://github.com/example/package.git#main' } }));
    const deps = { ...w.deps, memo: new Map() };
    const first = planRuntimeDependencies(input('container', w), deps);
    const entry = first.agentPlan.gitEntries[0];
    w.store.updatePins(w.lease, pins => ({ ...pins, [entry.pinId]: buildPin(entry, { commit: 'a'.repeat(40), verification: 'remote-verified' }) }));
    const pinned = planRuntimeDependencies(input('container', w), deps);
    assert.notEqual(pinned.agentPlan.inputKey, first.agentPlan.inputKey);
    assert.match(pinned.agentPlan.installManifest.dependencies.example, /#a{40}$/);
    w.state.agentLib = { ...w.state.agentLib, fingerprint: 'changed-source' };
    assert.notEqual(planRuntimeDependencies(input('container', w), deps).agentPlan.inputKey, pinned.agentPlan.inputKey);
});

test('dependency store runtime: actual container mounts must name the admitted payload read-only', (t) => {
    const w = world(t);
    const first = prepareRuntimeDependencies(input('container', w), { consumer: consumer('container') }, w.deps);
    const record = { dependencies: first.record };
    const staged = { Mounts: [{ Source: first.nodeModulesPath, Destination: first.nodeModulesPath, RW: false, Type: 'bind' }] };
    const nested = { Mounts: [
        { Source: first.nodeModulesPath, Destination: '/code/node_modules', RW: false, Type: 'bind' },
        { Source: first.nodeModulesPath, Destination: '/Agent/node_modules', RW: false, Type: 'bind' },
    ] };
    assert.equal(hasAdmittedDependencyMount(staged, record), true, 'Podman staged self-mount');
    assert.equal(hasAdmittedDependencyMount(nested, record), true, 'Docker nested mounts');
    assert.equal(hasAdmittedDependencyMount({ Mounts: [{ Source: '/elsewhere/node_modules', Destination: '/code/node_modules', RW: false }] }, record), false);
    assert.equal(hasAdmittedDependencyMount({ Mounts: [{ Source: first.nodeModulesPath, Destination: '/code/node_modules', RW: true }] }, record), false);
    assert.equal(hasAdmittedDependencyMount({ Mounts: [] }, { dependencies: noCacheDependencyRecord('no-core-deps', { family: 'container' }) }), true);
    assert.equal(admittedDependencyRecord({}).mode, 'unknown');
});

test('dependency store runtime seatbelt: the shared source link never switches under a live consumer', (t) => {
    const w = world(t);
    const first = prepareRuntimeDependencies(input('seatbelt', w), { consumer: consumer('seatbelt') }, w.deps);
    fs.writeFileSync(path.join(w.agentCodePath, 'package.json'), JSON.stringify({ name: 'agent', dependencies: { chalk: '5.1.0' } }));
    const second = prepareRuntimeDependencies(input('seatbelt', w), { consumer: consumer('seatbelt') }, w.deps);
    const linkPath = path.join(w.agentCodePath, 'node_modules');
    fs.symlinkSync(first.nodeModulesPath, linkPath, 'dir');
    const agents = {
        ploinky_repo_agent: { runtime: 'seatbelt', instanceId: 'i1', enableGeneration: 'g1', config: { binds: [{ source: w.agentCodePath, target: w.agentCodePath }] } },
        ploinky_repo_agent_alias: { runtime: 'seatbelt', instanceId: 'i2', enableGeneration: 'g2', config: { binds: [{ source: w.agentCodePath, target: w.agentCodePath }] } },
    };
    const options = { excludeContainer: 'ploinky_repo_agent', loadAgents: () => agents, store: w.store, isRunning: (name) => name === 'ploinky_repo_agent_alias' };
    assert.deepEqual(liveSeatbeltSourceConsumers(linkPath, options), ['ploinky_repo_agent_alias']);
    assert.throws(() => ensureSeatbeltCodeNodeModules('agent', w.agentCodePath, second.nodeModulesPath, options), { code: 'PLOINKY_DEPS_SEATBELT_LIVE_SWITCH' });
    assert.equal(fs.readlinkSync(linkPath), first.nodeModulesPath, 'the live consumer keeps its generation');
    // A live interactive attachment is also a consumer.
    const attachment = attachAdmittedDependencies({ runtime: 'seatbelt', dependencies: first.record }, {
        consumer: { kind: 'seatbelt-attachment', sourceLink: linkPath, process: { pid: process.pid, processStart: '', bootScope: 'unknown-scope' } },
    }, w.deps);
    const onlyAttachment = { ...options, isRunning: () => false };
    assert.throws(() => ensureSeatbeltCodeNodeModules('agent', w.agentCodePath, second.nodeModulesPath, onlyAttachment), { code: 'PLOINKY_DEPS_SEATBELT_LIVE_SWITCH' });
    attachment.release();
    ensureSeatbeltCodeNodeModules('agent', w.agentCodePath, second.nodeModulesPath, onlyAttachment);
    assert.equal(fs.readlinkSync(linkPath), second.nodeModulesPath, 'switches once no other consumer lives');
    assert.equal(fs.readFileSync(path.join(first.nodeModulesPath, 'left-pad', 'index.js'), 'utf8').includes('left-pad'), true);
});

function source(relative) {
    return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

function slice(text, startMarker, endMarker) {
    const start = text.indexOf(startMarker);
    assert.ok(start >= 0, startMarker);
    const end = text.indexOf(endMarker, start + startMarker.length);
    assert.ok(end > start, endMarker);
    return text.slice(start, end);
}

test('dependency store runtime wiring: every container reuse path consults the generation decision first', () => {
    const text = source('cli/sandbox/docker/agentServiceManager.js');
    const service = slice(text, 'function ensureAgentService(', '\nexport function ');
    const check = service.indexOf('const dependencyProblem = containerDependencyReuseProblem(');
    assert.ok(check > 0);
    assert.ok(check < service.indexOf('adoptManagedRuntimeOnly = !managedReconciliationPreparationLease'), 'before validation-only adoption');
    assert.ok(check < service.indexOf("debugLog(`[ensureAgentService] ${agentName}: returning early (container exists)`)"), 'before host/none early return');
    assert.ok(check < service.indexOf('const runtimeIdentity = resolveReplacementRuntimeIdentity({', check), 'before prepared-lease replacement identity');
    assert.match(service, /recreateReason \|\|= 'dependencyGenerationChanged'/);
    // The decision is not gated by preservePreparedRegistryRecord or a
    // preparation lease: the real start path (which passes both) consults it.
    assert.match(service, /if \(existingRuntimeAtEntry && !recreateReason\) \{\s*const dependencyProblem = containerDependencyReuseProblem\(/);
    assert.match(service, /hasAdmittedDependencyMount\(inspectedRecords\[0\], launchRecord\)/, 'host/none reuse checks actual mounts');
    assert.match(service, /forceRecreate = options\.forceRecreate === true\s*\|\| \(preflightAgentRuntime === 'seatbelt'\s*&& Boolean\(dependencyRefreshOperation\(\)\) && hasAgentPackageJson\(agentPath\)\)/,
        'the package-presence guard remains only for seatbelt');
    const sandbox = slice(service, "if (agentRuntime === 'bwrap' || agentRuntime === 'seatbelt') {\n        let sandboxRuntimeIdentity", 'const runtimeIdentity = resolveReplacementRuntimeIdentity({');
    assert.match(sandbox, /bwrapDependencyReuseProblem : seatbeltDependencyReuseProblem/);
    const start = slice(text, 'function startAgentContainer(', '\nfunction ');
    const storeBranch = start.indexOf("if (dependencyRecord?.mode === 'store') {");
    assert.ok(storeBranch > 0 && storeBranch < start.indexOf('ensureAgentLibCacheLink('), 'store trees are never relinked in place');
    assert.match(start, /resolveReusablePodmanStagedMounts\(existingRecord, podmanRuntimeRoot, preparedNodeModulesDir\)/);
    assert.match(start, /preparedDependencies\.updateConsumer\(\{ containerId, phase: 'created' \}\)/);
    assert.match(start, /\.\.\.\(dependencyRecord \? \{ dependencies: dependencyRecord \} : \{\}\),/);
});

test('dependency store runtime wiring: sandboxes, attachments and no-wait adoption use the shared decision', () => {
    const bwrap = source('cli/sandbox/bwrap/bwrapServiceManager.js');
    const ensure = slice(bwrap, 'function ensureBwrapService(', '\nfunction attachBwrapInteractive(');
    assert.match(ensure, /bwrapDependencyReuseProblem\(\{ agentName, manifest, record: existingRecord, containerName \}\)/);
    const attach = slice(bwrap, 'function attachBwrapInteractive(', '\nexport {');
    assert.match(attach, /attachAdmittedDependencies\(record,/);
    assert.match(attach, /\} finally \{\s*attached\?\.release\(\);\s*\}\s*\}\s*$/);
    assert.doesNotMatch(attach, /prepareRuntimeDependencies|resolveBwrapAgentNodeModules\(|ensureAgentCacheForFamily/);
    assert.doesNotMatch(bwrap, /ensureAgentCacheForFamily/);

    const seatbelt = source('cli/sandbox/seatbelt/seatbeltServiceManager.js');
    const seatbeltEnsure = slice(seatbelt, 'function ensureSeatbeltService(', '\nfunction attachSeatbeltInteractive(');
    assert.match(seatbeltEnsure, /seatbeltDependencyReuseProblem\(/);
    const seatbeltAttach = slice(seatbelt, 'function attachSeatbeltInteractive(', '\nexport {');
    assert.match(seatbeltAttach, /attachAdmittedDependencies\(record,/);
    assert.doesNotMatch(seatbeltAttach, /ensureSeatbeltCodeNodeModules\(|prepareRuntimeDependencies/, 'attachments never retarget the shared link');
    assert.doesNotMatch(seatbelt, /ensureAgentCacheForFamily/);

    const worker = source('cli/commands/noWaitWorker.js');
    const capture = slice(worker, 'capture(lifecycle) {', 'async ensure(lifecycle, context, networkLifecycleCapability) {');
    assert.match(capture, /admittedRuntimeDependencyProblem\(\{/);
    assert.match(capture, /&& !dependencyProblem/);
    assert.doesNotMatch(capture, /hasAgentPackageJson/);
});

test('dependency store runtime lease: a held lease is reused, a free workspace gets a transient one, a busy one fails closed', { timeout: 60_000 }, (t) => {
    const root = tempRoot(t, 'depstore-lease-');
    const script = `
        const { resolveDependencyLease } = await import(${JSON.stringify(path.join(ROOT, 'cli/utils/dependencies/store/runtimeDependencies.mjs'))});
        const locks = await import(${JSON.stringify(path.join(ROOT, 'cli/utils/runtime/maintenanceLocks.js'))});
        const out = {};
        const transient = resolveDependencyLease();
        out.transientOperation = transient.lease.operation;
        transient.release();
        out.transientReleased = !locks.inspectWorkspaceStartLock().active;
        await locks.withWorkspaceMutationLease({ operation: 'workspace-start' }, async (lease) => {
            const held = resolveDependencyLease();
            out.reusedHeld = held.lease === lease;
            held.release();
            out.stillHeld = locks.heldWorkspaceMutationLease() === lease;
        });
        process.stdout.write(JSON.stringify(out));
    `;
    const env = { ...process.env, PLOINKY_WORKSPACE_ROOT: root, PLOINKY_ROOT: root };
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), { transientOperation: 'dependency-preparation', transientReleased: true, reusedHeld: true, stillHeld: true });

    const holder = `
        const locks = await import(${JSON.stringify(path.join(ROOT, 'cli/utils/runtime/maintenanceLocks.js'))});
        locks.createWorkspaceMutationLease({ operation: 'other-start' });
        process.stdout.write('held');
        setTimeout(() => {}, 20000);
    `;
    const { spawn } = globalThis.process.getBuiltinModule('node:child_process');
    const child = spawn(process.execPath, ['--input-type=module', '-e', holder], { env, stdio: ['ignore', 'pipe', 'inherit'] });
    t.after(() => child.kill('SIGKILL'));
    return new Promise((resolve, reject) => {
        child.stdout.once('data', () => {
            const busy = `
                const { resolveDependencyLease } = await import(${JSON.stringify(path.join(ROOT, 'cli/utils/dependencies/store/runtimeDependencies.mjs'))});
                const started = Date.now();
                try { resolveDependencyLease(); process.stdout.write('acquired'); }
                catch (error) { process.stdout.write(JSON.stringify({ code: error.code, ms: Date.now() - started })); }
            `;
            const attempt = spawnSync(process.execPath, ['--input-type=module', '-e', busy], { env, encoding: 'utf8', timeout: 30_000 });
            try {
                const result = JSON.parse(attempt.stdout);
                assert.equal(result.code, 'PLOINKY_DEPS_WORKSPACE_LEASE_BUSY');
                assert.ok(result.ms < 5_000, 'never waits behind another operation');
                resolve();
            } catch (error) { reject(error); }
        });
    });
});

test('dependency store reinstall: one desired request per registration, empty-state build, admitted only on success', (t) => {
    const w = world(t);
    // No agent package: ordinary starts copy the exact seed.
    fs.rmSync(path.join(w.agentCodePath, 'package.json'));
    const memo = new Map();
    const deps = { ...w.deps, memo };
    const alias = prepareRuntimeDependencies(input('container', w, 'ploinky_repo_agent_b'), { consumer: consumer('container', 'ploinky_repo_agent_b') }, deps);
    const admitted = prepareRuntimeDependencies(input('container', w), { consumer: consumer('container') }, deps);
    assert.ok(['built', 'hit'].includes(admitted.status), 'aliases with identical inputs may share one object');
    assert.equal(admitted.plan.bypassSeeds, false);
    const seedObject = w.store.readIndex(admitted.plan.seedPlan.inputKey).objectId;
    const seedBefore = hashInstalledTree(path.join(w.store.paths.objects, seedObject, 'payload'), { approvedExternalTargets: [admitted.plan.agentPlan.providers.agentLib.linkTarget] }).hash;
    const aliasBefore = treeSnapshot(alias.record);
    const installsBefore = w.state.installer.calls.length;

    const request = issueDependencyRebuildRequest('ploinky_repo_agent', {}, deps);
    assert.equal(request.reused, false);
    assert.equal(w.store.readRebuildState('ploinky_repo_agent').admittedToken, null, 'the desired request is not admitted yet');
    const rebuilt = prepareRuntimeDependencies(input('container', w), { consumer: consumer('container', 'ploinky_repo_agent__candidate_0123456789ab') }, deps);
    assert.equal(rebuilt.plan.rebuildToken, request.token);
    assert.equal(rebuilt.plan.bypassSeeds, true);
    assert.equal(rebuilt.status, 'reinstalled');
    assert.equal(w.state.installer.calls.length, installsBefore + 1, 'npm ran for the target from an empty payload (no seed copy)');
    assert.notEqual(rebuilt.record.objectId, admitted.record.objectId);

    // Ordinary lifecycle still keys on the ADMITTED token until success.
    const otherCommand = { ...w.deps, memo: new Map() };
    assert.equal(planRuntimeDependencies(input('container', w), otherCommand).agentPlan.inputKey, admitted.plan.agentPlan.inputKey);

    // A failed readiness keeps the admitted generation and the request; the retry reuses the token.
    settleDependencyRebuildRequest('ploinky_repo_agent', request.token, { outcome: 'failed', error: new Error('readiness failed') }, deps);
    const failedState = w.store.readRebuildState('ploinky_repo_agent');
    assert.equal(failedState.desired.status, 'failed');
    assert.equal(failedState.admittedToken, null);
    const retryMemo = new Map();
    const retry = issueDependencyRebuildRequest('ploinky_repo_agent', {}, { ...w.deps, memo: retryMemo });
    assert.equal(retry.token, request.token);
    assert.equal(retry.reused, true);
    const retried = prepareRuntimeDependencies(input('container', w), { consumer: consumer('container', 'ploinky_repo_agent__candidate_0123456789ab') }, { ...w.deps, memo: retryMemo });
    assert.equal(retried.status, 'hit', 'the retry reuses the object it already built: no duplicate');
    assert.equal(w.state.installer.calls.length, installsBefore + 1);

    settleDependencyRebuildRequest('ploinky_repo_agent', retry.token, { outcome: 'admitted' }, { ...w.deps, memo: retryMemo });
    const admittedState = w.store.readRebuildState('ploinky_repo_agent');
    assert.equal(admittedState.admittedToken, request.token);
    assert.equal(admittedState.desired, null);
    assert.equal(planRuntimeDependencies(input('container', w), { ...w.deps, memo: new Map() }).agentPlan.inputKey, rebuilt.plan.agentPlan.inputKey);
    assert.notEqual(issueDependencyRebuildRequest('ploinky_repo_agent', {}, { ...w.deps, memo: new Map() }).token, request.token,
        'a new reinstall after admission mints a new token');

    assert.deepEqual(treeSnapshot(alias.record), aliasBefore, 'other aliases keep their bytes');
    assert.equal(hashInstalledTree(path.join(w.store.paths.objects, seedObject, 'payload'), { approvedExternalTargets: [admitted.plan.agentPlan.providers.agentLib.linkTarget] }).hash, seedBefore, 'the seed is byte-identical');
    assert.equal(w.store.readRebuildState('ploinky_repo_agent_b').admittedToken, null, 'the alias has no rebuild state');
});

test('dependency store reinstall: the desired token reaches planning through the command scope and is recorded', async (t) => {
    const w = world(t);
    const { memo, ...ambient } = w.deps;
    void memo;
    await withDependencyRefresh('reinstall', async () => {
        const request = issueDependencyRebuildRequest('ploinky_repo_agent', {}, ambient);
        const prepared = prepareRuntimeDependencies(input('container', w), { consumer: consumer('container') }, ambient);
        assert.equal(prepared.plan.rebuildToken, request.token, 'the default ALS scope carries the request');
        assert.equal(prepared.record.rebuildToken, request.token, 'the admitted record names the applied token');
        assert.equal(runtimeCarriesRebuildToken({ dependencies: prepared.record }, request.token), true);
        assert.equal(runtimeCarriesRebuildToken({ dependencies: prepared.record }, 'another'), false);
        assert.equal(runtimeCarriesRebuildToken({ dependencies: noCacheDependencyRecord('no-core-deps', { family: 'container' }) }, request.token), true);
    });
    await withDependencyRefresh('start', async () => {
        assert.equal(planRuntimeDependencies(input('container', w), ambient).rebuildToken, null, 'another command keys on the admitted token');
    });
});

test('dependency store runtime: predecessor removal proves ownership with the pre-rotation record for the same container only', () => {
    const registered = { containerId: 'c'.repeat(64), instanceId: 'rotated', enableGeneration: 'rotated' };
    const predecessor = { containerId: 'c'.repeat(64), instanceId: 'old', enableGeneration: 'old' };
    assert.equal(selectPredecessorRemovalRecord(registered, predecessor), predecessor);
    assert.equal(selectPredecessorRemovalRecord(registered, { ...predecessor, containerId: 'd'.repeat(64) }), registered,
        'a record for a different container never authorizes removal');
    assert.equal(selectPredecessorRemovalRecord({ instanceId: 'x' }, predecessor).instanceId, 'x', 'no registered container ID: no substitution');
    assert.equal(selectPredecessorRemovalRecord(registered, null), registered);
});
