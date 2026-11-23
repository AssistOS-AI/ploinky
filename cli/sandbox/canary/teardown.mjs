import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { PLOINKY_WORKSPACE_ROOT } from '../../utils/config.js';
import { withHeldOrAcquiredWorkspaceMutationLease } from '../../utils/runtime/maintenanceLocks.js';
import { assertManifestVolumeStoragePolicy, resolveAgentDataPath } from '../../utils/runtime/agentDataPathPolicy.js';
import { isManagedManifestVolumeSource } from '../runtimeCapabilities.js';
import { workspaceNetworkIdentity } from '../networkIdentity.js';
import { readRuntimeCandidate, retireRuntimeCandidate } from '../runtimeCandidateStore.js';
import { withNetworkLifecycleLockReclaimingStoppedOwner } from '../networkLifecycle.js';
import { inspectCanaryContainer, removeCanaryContainer } from '../docker/containerFleet.js';
import { validateCanaryField, validateCanaryLinks } from '../canaryRecord.mjs';
import { rolloutThresholds } from '../../server/canary/tripRules.js';
import { IMMUTABLE_CONTAINER_ID } from '../docker/containerOwnership.js';
import {
    abortEdgeRoutingPreparation, applyEdgeRoutingGeneration, assertActiveEdgeRoutingSourcesCurrent,
    commitAdditiveEdgeRoutingGeneration, loadEdgeRoutingGenerationForEvidence, prepareAdditiveEdgeRoutingGeneration,
    readEdgeRoutingSelection, resolveEdgeGenerationPaths,
    retireAbandonedActiveBoundPreparation, withEdgeGenerationApplyLock,
} from '../edgeGeneration.js';
import { closeReceipt, readReceipt, receiptPath, updateReceipt } from './receipt.mjs';

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const keyPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const digest = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');

function sync(file) {
    const fd = fs.openSync(file, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function syncReceipt(context) {
    const file = receiptPath(context.routeKey, context);
    sync(file);
    sync(path.dirname(file));
}

function save(context, fields) {
    context.receipt = updateReceipt({ ...context.receipt, fields }, context);
    syncReceipt(context);
}

function snapshotSources(paths) {
    return { routing: fs.readFileSync(paths.routingFile), agents: fs.readFileSync(paths.agentsFile) };
}

function parseSources(bytes) {
    return { routing: JSON.parse(bytes.routing), agents: JSON.parse(bytes.agents) };
}

function writeSource(file, bytes) {
    const temp = file + '.' + randomUUID() + '.tmp';
    try {
        fs.writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 });
        sync(temp);
        fs.renameSync(temp, file);
        sync(path.dirname(file));
    } finally {
        fs.rmSync(temp, { force: true });
    }
}

function pair({ routeKey, receipt, workspaceRoot }, { routing, agents }) {
    const route = routing.routes?.[routeKey];
    const field = route?.canary;
    const names = Object.keys(agents).filter(name => agents[name]?.canaryOf === routeKey);
    if (!field && names.length === 0) return null;
    if (names.length !== 1 || names[0] !== field?.container || field.rolloutId !== receipt?.rolloutId
        || !field.container.endsWith('__canary') || field.container === route.container) {
        throw new Error('canary receipt, route and registry must identify the same rollout');
    }
    validateCanaryField(field, 'canary', { allowHistoricalThresholds: true });
    validateCanaryLinks(routing, agents, workspaceRoot);
    return { route, field, record: agents[field.container] };
}

function sameIfRecorded(left, right, label) {
    if (left != null && left !== right) throw new Error('canary ' + label + ' disagrees with receipt');
}

function unpublishedRecord(receipt) {
    return {
        ...receipt.canaryRecord,
        type: 'agent', runtime: 'podman', canaryOf: receipt.routeKey,
        repoName: receipt.repoName, agentName: receipt.agentName,
        instanceId: receipt.canaryInstanceId, enableGeneration: receipt.canaryEnableGeneration,
        containerId: receipt.canaryContainerId, launchId: receipt.canaryLaunchId,
    };
}

function assertIdentity(context, observed) {
    const saved = context.receipt.teardown;
    if (!observed) return;
    const { field, record } = observed;
    sameIfRecorded(saved?.name ?? context.receipt.canaryContainerName, field.container, 'container name');
    sameIfRecorded(saved?.id ?? context.receipt.canaryContainerId, record.containerId, 'container ID');
    sameIfRecorded(saved?.launchId ?? context.receipt.canaryLaunchId, record.launchId, 'launch ID');
    sameIfRecorded(saved?.commit ?? context.receipt.canaryCommit, field.commit, 'commit');
    sameIfRecorded(saved?.instanceId ?? context.receipt.canaryInstanceId, record.instanceId, 'instance ID');
    sameIfRecorded(saved?.enableGeneration ?? context.receipt.canaryEnableGeneration, record.enableGeneration, 'generation');
}

function checkedExport(context, commit, codePath) {
    if (!SHA.test(commit)) throw new Error('canary teardown requires its recorded commit');
    const relative = path.join('.ploinky', 'canary', context.routeKey, commit);
    if (codePath != null && codePath !== relative && codePath !== relative + '/code') {
        throw new Error('canary export does not match this route and commit');
    }
    let dir = context.workspaceRoot;
    for (const part of relative.split(path.sep)) {
        dir = path.join(dir, part);
        const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
        if (stat && !stat.isDirectory()) throw new Error('canary export requires real workspace directories');
    }
    return dir;
}

function removeExport(dir) {
    const parent = path.dirname(dir);
    if (!fs.existsSync(parent)) return;
    // S2 freezes the archive directories. Re-enable deletion on directories
    // only; archive symlinks are unlinked without following their targets.
    const thaw = directory => {
        fs.chmodSync(directory, 0o700);
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            if (entry.isDirectory()) thaw(path.join(directory, entry.name));
        }
    };
    if (fs.lstatSync(dir, { throwIfNoEntry: false })) {
        thaw(dir);
        fs.rmSync(dir, { recursive: true });
    }
    sync(parent);
}

function checkoutHead(dir) {
    return execFileSync('git', ['--no-optional-locks', '-C', dir, 'rev-parse', '--verify', 'HEAD^{commit}'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function terminalOutcome(context, observed, commit) {
    const { receipt, reason, dependencies } = context;
    if (reason === 'promoted') return 'promoted';
    if (Number(receipt.lastCompletedStep ?? receipt.promotionStep ?? receipt.step) >= 3) return 'reset';
    if (Number(receipt.intent?.step ?? receipt.intent) === 3 || receipt.intent === 'checkout' || receipt.failurePhase === 'checkout') {
        const dir = observed?.route.hostPath || receipt.repoRoot;
        const head = (dependencies.readCheckoutHead || checkoutHead)(dir);
        if (head === commit || head === receipt.repairCommit) return 'reset';
        if (head !== receipt.oldCommit) throw new Error('canary checkout is at an unexpected commit');
    }
    return 'aborted';
}

function checkedHome(source, workspaceRoot) {
    if (!path.isAbsolute(source) || !isManagedManifestVolumeSource(path.relative(workspaceRoot, source), { workspaceRoot })
        || assertManifestVolumeStoragePolicy(source, { workspaceRoot }) !== source) {
        throw new Error('canary home must be an exact workspace-owned agent mount');
    }
    return source;
}

function begin(context, observed, primaryRecord) {
    const { receipt, workspaceRoot, routeKey, reason } = context;
    assertIdentity(context, observed);
    const record = observed?.record || unpublishedRecord(receipt);
    const commit = observed?.field.commit || receipt.canaryCommit;
    checkedExport(context, commit, observed?.field.codePath ?? receipt.codePath);
    const name = observed?.field.container || receipt.canaryContainerName;
    if (!keyPattern.test(receipt.rolloutId) || !name || !keyPattern.test(name) || !name.endsWith('__canary')) {
        throw new Error('invalid canary rollout or container name');
    }
    const id = record?.containerId || receipt.canaryContainerId;
    if ((observed || id) && !IMMUTABLE_CONTAINER_ID.test(id)) throw new Error('missing immutable canary container ID');
    const binds = (record.config?.binds || primaryRecord?.config?.binds)?.filter(bind => bind.target === '/root') || [];
    if (binds.length > 1) throw new Error('ambiguous canary home mount');
    const home = binds.length ? checkedHome(binds[0].source, workspaceRoot)
        : resolveAgentDataPath(record.alias || primaryRecord?.alias || record.agentName || routeKey, { workspaceRoot });
    const teardown = {
        name, id, commit, home, launchId: record?.launchId || receipt.canaryLaunchId,
        instanceId: record?.instanceId, enableGeneration: record?.enableGeneration,
        runtime: record?.runtime || 'podman', published: Boolean(observed),
        outcome: terminalOutcome(context, observed, commit), reason,
    };
    save(context, { teardown, intent: 'withdraw' });
}

// Releasing an abandoned lease and inspecting its sources are one apply-lock
// operation. A newly acquired preparation (even for this same rollout) must
// retain its own authority.
function withRecoveryLock(context, reasons, callback) {
    const { preparationLeaseFile } = resolveEdgeGenerationPaths(context);
    let lease;
    try { lease = JSON.parse(fs.readFileSync(preparationLeaseFile)); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    const own = lease?.mode === 'additive' && reasons.includes(lease.reason);
    const options = { workspaceRoot: context.workspaceRoot, preparationLease: own ? lease : undefined };
    return withEdgeGenerationApplyLock(capability => {
        if (own) retireAbandonedActiveBoundPreparation({ ...options, applyLockCapability: capability });
        return callback(capability, own ? lease : null);
    }, options);
}

function predecessorBytes(paths, generation) {
    const file = path.join(paths.generationsDir, generation.generation.slice(7) + '.json');
    const persisted = JSON.parse(fs.readFileSync(file)).sources;
    const bytes = {};
    for (const key of ['routing', 'agents']) {
        bytes[key] = Buffer.from(persisted[key], 'base64');
        if (digest(bytes[key]) !== generation.sourceDigests[key]) throw new Error('invalid canary publication predecessor');
    }
    return bytes;
}

// The launcher's additive commit also writes routing and registry before its
// selector. If it stopped there, the primary-only predecessor is still serving.
// Restore just its exact source bytes after proving that every difference is
// attributable to this receipt. The orphan will then be retired by ID.
function recoverLauncher(context) {
    const { routeKey, receipt } = context;
    const action = receipt.settingsChange?.action;
    const changing = ['set', 'resume'].includes(action) && receipt.intent === action;
    const starting = receipt.preparationLease || ['prepare', 'create', 'readiness', 'publish'].includes(receipt.intent);
    if (!starting && !changing) return;
    const reason = 'canary-' + (changing ? action : 'start') + ':' + receipt.rolloutId;
    withRecoveryLock(context, [reason], (capability, abandoned) => {
        const lease = abandoned || receipt.preparationLease;
        const { selector, paths } = readEdgeRoutingSelection(context);
        if (selector.state !== 'active') return;
        const predecessor = loadEdgeRoutingGenerationForEvidence(selector.generation, context);
        const bytes = snapshotSources(paths);
        if (Object.keys(bytes).every(key => digest(bytes[key]) === predecessor.sourceDigests[key])) return;
        if (lease && lease.selectorDigest !== selector.selectorDigest) throw new Error('canary launcher predecessor changed');

        const staged = parseSources(bytes);
        const route = staged.routing.routes[routeKey];
        const field = route?.canary;
        const selected = predecessor.routing.routes[routeKey]?.canary;
        if (!field || field.rolloutId !== receipt.rolloutId || field.container !== receipt.canaryContainerName) {
            throw new Error('partial canary publication does not belong to this receipt');
        }
        if (changing) {
            if (selected?.rolloutId !== field.rolloutId || field.splitStartedAt !== receipt.settingsChange.splitStartedAt) {
                throw new Error('partial canary settings do not match the recorded intent');
            }
            field.splitStartedAt = selected.splitStartedAt;
            if (action === 'set') field.share = selected.share;
        } else {
            if (!lease || selected || !isDeepStrictEqual(field,
                loadEdgeRoutingGenerationForEvidence(lease.preparedGeneration, context).routing.routes[routeKey]?.canary)) {
                throw new Error('partial canary start differs from its preparation');
            }
            const record = staged.agents[field.container];
            if (record) {
                if (record.canaryOf !== routeKey) throw new Error('partial canary start has an unrelated registry record');
                assertIdentity(context, { record, field });
                delete staged.agents[field.container];
            }
            delete route.canary;
        }
        const original = predecessorBytes(paths, predecessor);
        for (const key of ['routing', 'agents']) {
            if (!isDeepStrictEqual(staged[key], predecessor[key])) throw new Error('unrelated changes during canary publication');
        }
        // Uninstall in reverse commit order, so a second interruption still
        // leaves either the route alone or the complete provisional pair.
        for (const key of ['agents', 'routing']) {
            if (!original[key].equals(bytes[key])) writeSource(paths[key + 'File'], original[key]);
        }
    });
}

// An additive commit installs mutable source files before it flips the
// selector. A process death between renames must be repaired before even
// parsing the pair: one half of an otherwise valid removal may be on disk.
function recoverPublication(context) {
    const journal = context.receipt.teardownPublication;
    if (!journal) return;
    withRecoveryLock(context, [journal.reason], applyLockCapability => {
        const { selector, paths } = readEdgeRoutingSelection(context);
        const bytes = snapshotSources(paths);
        if (selector.activationId !== journal.activationId) {
            // The commit may already be visible (or a later lifecycle may
            // have advanced it). Prove current sources and re-observe the pair.
            if (selector.state === 'active') assertActiveEdgeRoutingSourcesCurrent(context);
            pair(context, parseSources(bytes));
            return;
        }
        for (const key of ['routing', 'agents']) {
            const hash = digest(bytes[key]);
            if (hash !== journal.before[key] && hash !== journal.after[key]) {
                throw new Error('canary publication sources changed during recovery');
            }
        }
        if (selector.state === 'inactive') {
            // No runtime can be authorized. Complete just the intended edits
            // on any predecessor files left by an interrupted inactive apply.
            const sources = parseSources(bytes);
            mutateSources(context, sources, journal.effect);
            for (const key of ['routing', 'agents']) {
                const next = Buffer.from(JSON.stringify(sources[key], null, 2));
                if (digest(next) !== journal.after[key]) throw new Error('inactive canary recovery candidate changed');
                if (!next.equals(bytes[key])) writeSource(paths[key + 'File'], next);
            }
            applyEdgeRoutingGeneration({ ...context, applyLockCapability, activate: false, reason: journal.reason });
        } else {
            const generation = loadEdgeRoutingGenerationForEvidence(selector.generation, context);
            const original = predecessorBytes(paths, generation);
            for (const key of ['routing', 'agents']) {
                if (digest(original[key]) !== journal.before[key]) throw new Error('canary publication predecessor changed');
            }
            for (const key of ['routing', 'agents']) {
                if (!original[key].equals(bytes[key])) writeSource(paths[key + 'File'], original[key]);
            }
        }
    }, context);
    save(context, { teardownPublication: null });
}

function mutateSources(context, { routing, agents }, effect) {
    const route = routing.routes[context.routeKey];
    if (effect === 'withdraw') {
        route.canary.mode = 'withdrawn';
        // Withdrawals carry no traffic. Clear obsolete trip rules before
        // publishing the receipt's exact pair under the current schema.
        try { rolloutThresholds(route.canary.thresholds); }
        catch { route.canary.thresholds = {}; }
    } else {
        delete route.canary;
        delete agents[context.receipt.teardown.name];
    }
}

function publish(context, effect) {
    const { workspaceRoot, routeKey, receipt } = context;
    return withEdgeGenerationApplyLock(applyLockCapability => {
        const { selector, paths } = readEdgeRoutingSelection(context);
        const bytes = snapshotSources(paths);
        const sources = parseSources(bytes);
        const observed = pair(context, sources);
        assertIdentity(context, observed);
        if (!observed || (effect === 'withdraw' && observed.field.mode === 'withdrawn')) {
            if (selector.state === 'active') assertActiveEdgeRoutingSourcesCurrent(context);
            return observed;
        }
        if (effect === 'remove-pair' && observed.field.mode !== 'withdrawn') throw new Error('canary is still serving');
        mutateSources(context, sources, effect);
        const reason = ['canary-teardown', routeKey, receipt.rolloutId, effect].join(':');
        const options = { workspaceRoot, applyLockCapability, reason, ...sources };
        const journal = { reason, effect, activationId: selector.activationId, before: {}, after: {} };
        for (const key of ['routing', 'agents']) {
            journal.before[key] = digest(bytes[key]);
            journal.after[key] = digest(JSON.stringify(sources[key], null, 2));
        }
        save(context, { teardownPublication: journal });
        if (selector.state === 'inactive') {
            for (const key of ['routing', 'agents']) writeSource(paths[key + 'File'], JSON.stringify(sources[key], null, 2));
            applyEdgeRoutingGeneration({ workspaceRoot, applyLockCapability, reason, activate: false });
        } else {
            const { preparationLease } = prepareAdditiveEdgeRoutingGeneration(options);
            try { commitAdditiveEdgeRoutingGeneration(preparationLease, options); }
            catch (error) {
                abortEdgeRoutingPreparation(preparationLease, options);
                throw error;
            }
        }
        save(context, { teardownPublication: null });
        return observed;
    }, { workspaceRoot });
}

async function endLocked(context) {
    let receipt = readReceipt(context.routeKey, context);
    context.receipt = receipt;
    if (receipt?.workspaceIdentity && receipt.workspaceIdentity !== workspaceNetworkIdentity(context.workspaceRoot).hash) {
        throw new Error('canary receipt belongs to another workspace');
    }
    if (receipt && !receipt.terminal) {
        if (context.primaryContainer && receipt.oldContainerName && context.primaryContainer !== receipt.oldContainerName
            && context.primaryContainer !== receipt.replacementContainerName) {
            const current = JSON.parse(fs.readFileSync(resolveEdgeGenerationPaths(context).routingFile));
            if (current.routes?.[context.routeKey]?.container !== context.primaryContainer) return { ended: false, outcome: 'absent' };
        }
        if (receipt.teardownPublication) recoverPublication(context);
        if (!receipt.teardown) {
            if (receipt.publication) {
                // The launcher's journal also owns its topology publication.
                // Only an S2 publication can have written this receipt field.
                const { recoverCanaryPreparation } = await import('./start.mjs');
                recoverCanaryPreparation(receipt, context.workspaceRoot);
            } else {
                recoverLauncher(context);
            }
        }
    }
    const paths = resolveEdgeGenerationPaths(context);
    const readState = file => {
        try { return JSON.parse(fs.readFileSync(file)); } catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
    };
    const routing = readState(paths.routingFile);
    const agents = readState(paths.agentsFile);
    const observed = pair(context, { routing, agents });
    const primary = routing.routes?.[context.routeKey]?.container || receipt?.oldContainerName;
    if (context.primaryContainer && context.primaryContainer !== primary) {
        return { ended: false, outcome: 'absent' };
    }
    if (!receipt || receipt.terminal) {
        if (observed) throw new Error('published canary has no open receipt');
        return { ended: false, outcome: receipt?.terminal?.outcome || 'absent' };
    }
    if (!observed && !receipt.teardown && receipt.step === 'published') {
        throw new Error('published canary is missing its route and registry pair');
    }
    if (!receipt.teardown) begin(context, observed, agents[primary]);
    receipt = context.receipt;
    const saved = receipt.teardown;
    const { inspectContainer = inspectCanaryContainer, removeContainer = removeCanaryContainer, afterEffect } = context.dependencies;
    const effect = async (name, fn) => {
        save(context, { intent: name });
        const result = await fn();
        await afterEffect?.(name);
        save(context, { teardownLastEffect: name, intent: null });
        return result;
    };
    const candidate = receipt.canaryRecord && readRuntimeCandidate(saved.name, receipt.canaryRecord, context);
    if (candidate) {
        if (!saved.id && !saved.published) {
            // create persisted its exact tuple-bound candidate before the
            // launcher's receipt callback. Pin that ID before any signal.
            saved.id = candidate.containerId;
            save(context, { teardown: saved });
        }
        if (candidate.containerId !== saved.id) throw new Error('canary runtime candidate identity changed');
    }

    // An unpublished start can have a receipt and export but no selected
    // pair yet. Do not fabricate a route, adopt a name, or remove a primary.
    const withdrawn = await effect('withdraw', () => observed && publish(context, 'withdraw'));
    await effect('remove-container', async () => {
        const record = withdrawn?.record || (!saved.published && unpublishedRecord(receipt));
        const removal = {
            rolloutId: receipt.rolloutId, unpublished: !saved.published,
            onRecoveredIdentity({ containerId }) {
                saved.id = containerId;
                save(context, { teardown: saved });
            },
        };
        if (saved.id) {
            if (await inspectContainer(saved.runtime, saved.id)) {
                if (!record || record.canaryOf !== context.routeKey) throw new Error('cannot prove recorded canary runtime ownership');
                await removeContainer(saved.name, { ...record, containerId: saved.id }, removal);
            }
            if (await inspectContainer(saved.runtime, saved.id)) throw new Error('recorded canary container still exists');
        } else if (await inspectContainer(saved.runtime, saved.name)) {
            if (!record?.instanceId || !record.enableGeneration || saved.name !== receipt.oldContainerName + '__canary') {
                throw new Error('canary creation interrupted without an exact launch identity');
            }
            // The fleet helper proves the receipt tuple, persists its full ID,
            // then re-inspects by that ID immediately before any signal.
            await removeContainer(saved.name, record, removal);
            if (!saved.id || await inspectContainer(saved.runtime, saved.id)) throw new Error('unpublished canary removal unverified');
        }
    });
    if (candidate) retireRuntimeCandidate(candidate, context);
    await effect('remove-pair', () => saved.published && publish(context, 'remove-pair'));
    await effect('remove-export', () => removeExport(checkedExport(context, saved.commit)));
    await effect('remove-queue', () => {
        const home = checkedHome(saved.home, context.workspaceRoot);
        if (!keyPattern.test(receipt.rolloutId)) throw new Error('invalid canary queue ID');
        fs.rmSync(path.join(home, '.tasksQueue.canary.' + receipt.rolloutId), { force: true });
        // The home may be on a different filesystem from the receipt. Flush
        // the unlink before making the terminal outcome durable.
        if (fs.existsSync(home)) sync(home);
    });
    closeReceipt({ routeKey: context.routeKey, rolloutId: receipt.rolloutId, outcome: saved.outcome, reason: saved.reason }, context);
    syncReceipt(context);
    return { ended: true, outcome: saved.outcome };
}

function assertWorkspace(workspaceRoot) {
    if (!path.isAbsolute(workspaceRoot) || path.resolve(workspaceRoot) !== path.resolve(PLOINKY_WORKSPACE_ROOT)) {
        throw new Error('canary teardown requires the workspace that owns the runtime and mutation lease');
    }
}

function withTeardownLock(context, callback) {
    assertWorkspace(context.workspaceRoot);
    return withHeldOrAcquiredWorkspaceMutationLease({ operation: 'canary-teardown' },
        () => withNetworkLifecycleLockReclaimingStoppedOwner(callback));
}

export async function endCanary({ routeKey, reason, workspaceRoot = PLOINKY_WORKSPACE_ROOT, dependencies = {} }) {
    const context = { routeKey, reason, workspaceRoot, dependencies };
    return withTeardownLock(context, () => endLocked(context));
}

function openRoutes(context) {
    assertWorkspace(context.workspaceRoot);
    const directory = path.dirname(receiptPath('unused', context));
    let files = [];
    try { files = fs.readdirSync(directory); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    const keys = new Set(files.filter(file => file.endsWith('.json'))
        .map(file => file.slice(0, -5))
        .filter(key => (!context.routeKey || context.routeKey === key) && !readReceipt(key, context)?.terminal));
    // A missing or prematurely closed receipt must not let stop/disable fall
    // through to ordinary fleet removal with a published canary still present.
    const paths = resolveEdgeGenerationPaths(context);
    for (const [file, marker] of [[paths.routingFile, 'canary'], [paths.agentsFile, 'canaryOf']]) {
        let bytes;
        try { bytes = fs.readFileSync(file, 'utf8'); } catch (error) {
            if (error.code === 'ENOENT') continue;
            throw error;
        }
        if (!bytes.includes('"' + marker + '"')) continue;
        const source = JSON.parse(bytes);
        const published = marker === 'canary'
            ? Object.entries(source.routes || {}).filter(([, route]) => route?.canary).map(([key]) => key)
            : Object.values(source).filter(record => record?.canaryOf).map(record => record.canaryOf);
        for (const key of published) if (!context.routeKey || context.routeKey === key) keys.add(key);
    }
    return [...keys];
}

export function hasOpenCanaries({ workspaceRoot = PLOINKY_WORKSPACE_ROOT } = {}) {
    return openRoutes({ workspaceRoot }).length > 0;
}

export async function reconcileCanaries({ reason, workspaceRoot = PLOINKY_WORKSPACE_ROOT, routeKey, primaryContainer, dependencies = {} }) {
    const context = { reason, workspaceRoot, routeKey, primaryContainer, dependencies };
    if (!openRoutes(context).length) return [];
    return withTeardownLock(context, async () => {
        const results = [];
        for (const key of openRoutes(context)) {
            const { ended, outcome } = await endLocked({ ...context, routeKey: key });
            if (ended) results.push({ routeKey: key, outcome });
        }
        return results;
    });
}
