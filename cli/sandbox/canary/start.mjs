// Workspace mutations enter through runCanaryCommand under the workspace lease.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { assertCanaryEligibility, inspectCanarySource, exportCanarySource } from './export.mjs';
import { openReceipt, readReceipt as loadReceipt, receiptPath, updateReceipt } from './receipt.mjs';
import { probeCanaryContainer } from './probe.mjs';
import { endCanary } from './teardown.mjs';
import { isCanaryRecord, validateCanaryField } from '../canaryRecord.mjs';
import {
    abortEdgeRoutingPreparation, assertActiveEdgeRoutingSourcesCurrent, commitAdditiveEdgeRoutingGeneration, edgePreparationOwnerStopped,
    loadActiveEdgeRoutingGeneration, loadEdgeRoutingGenerationForEvidence, readCurrentEdgeTopology,
    prepareAdditiveEdgeRoutingGeneration, readEdgeRoutingPreparationOwner, resolveEdgeGenerationPaths,
    retireAbandonedActiveBoundPreparation, withEdgeGenerationApplyLock,
} from '../edgeGeneration.js';
import { withNetworkLifecycleLockAsync } from '../networkLifecycle.js';
import { deriveCanaryNetworkAlias } from '../networkContract.js';
import { inspectExactContainerById, assertExactContainerOwnership } from '../docker/containerOwnership.js';
import { workspaceNetworkIdentity } from '../networkIdentity.js';
import { normalizeImageId } from '../docker/runtimeImageIdentity.js';
import { verifyRegisteredLaunchId } from '../../utils/security/agentIdentityEnv.js';
import { getRuntimeForAgent } from '../docker/common.js';
import { ensureAgentService } from '../docker/agentServiceManager.js';
import { buildRelayReadinessRoute, waitForAgentReady } from '../../server/utils/agentReadiness.js';
import { waitForEnabledAgentReadiness } from '../../utils/agents.js';
import { resolveManifestRuntimeProfile } from '../../utils/runtime/profileService.js';
import { resolveRouterEndpoint } from '../routerPort.js';
import { readRuntimeCandidate, retireRuntimeCandidate } from '../runtimeCandidateStore.js';

const exactId = /^[a-f0-9]{64}$/;

function checkedReceiptPath(routeKey, options) {
    const file = receiptPath(routeKey, options);
    let directory = path.resolve(options.workspaceRoot);
    for (const part of path.relative(directory, path.dirname(file)).split(path.sep)) {
        directory = path.join(directory, part);
        const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
        if (stat && !stat.isDirectory()) throw new Error('canary receipts require real workspace directories');
    }
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (stat && !stat.isFile()) throw new Error('canary receipt requires a regular file');
    return file;
}

function readReceipt(routeKey, options) {
    checkedReceiptPath(routeKey, options);
    return loadReceipt(routeKey, options);
}

function sync(file) {
    const fd = fs.openSync(file, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function saveReceipt(identity, fields, workspaceRoot, open = false) {
    const file = checkedReceiptPath(identity.routeKey, { workspaceRoot });
    (open ? openReceipt : updateReceipt)({ ...identity, fields }, { workspaceRoot });
    sync(file);
    sync(path.dirname(file));
    if (open) {
        // The first receipt may have just created the canary directory.
        sync(path.dirname(path.dirname(file)));
    }
}

function replaceCanaryFileDurably(file, bytes, mode = 0o600) {
    const temporary = file + '.' + randomUUID() + '.tmp';
    fs.writeFileSync(temporary, bytes, { mode, flag: 'wx' });
    try {
        sync(temporary);
        fs.renameSync(temporary, file);
        sync(path.dirname(file));
    } finally { fs.rmSync(temporary, { force: true }); }
}

export function canaryReceipts(workspaceRoot) {
    const dir = path.dirname(checkedReceiptPath('route', { workspaceRoot }));
    let names;
    try { names = fs.readdirSync(dir); } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
    return names.filter(name => name.endsWith('.json')).map(name => readReceipt(name.slice(0, -5), { workspaceRoot }));
}

function target(workspaceRoot, agentRef) {
    const { generation, selector } = loadActiveEdgeRoutingGeneration({ workspaceRoot });
    const matches = Object.entries(generation.routing.routes).filter(([, r]) => agentRef === r.repo + '/' + r.agent);
    if (matches.length !== 1) throw new Error('canary requires one enabled route for ' + agentRef);
    const [routeKey, route] = matches[0];
    const primary = generation.agents[route.container];
    if (primary?.type !== 'agent' || isCanaryRecord(primary) || primary.agentName !== route.agent || primary.repoName !== route.repo) {
        throw new Error('canary requires an exact enabled primary record');
    }
    return { generation, selector, routeKey, route, primary, manifest: generation.manifests[routeKey] };
}

// Inventory and the measured requirement come from the operator's S10/U9
// evidence. Deployment can pass the cache confirmation independently.
function admission({ agentRef, routeKey, commit, generation, admissionEvidence }) {
    const evidence = admissionEvidence ?? JSON.parse(process.env.PLOINKY_CANARY_ADMISSION || '{}');
    let cacheConfirmation = admissionEvidence ? evidence.cacheConfirmation :
        process.env.PLOINKY_CANARY_CACHE_CONFIRMATION || evidence.cacheConfirmation;
    const purge = /^purged-no-store ([a-z0-9.-]+) ([a-f0-9]+)$/.exec(cacheConfirmation || '');
    if (purge) {
        const hosts = Object.entries(generation.desired.hosts || {}).filter(([, host]) =>
            [host.agent, host.rootApplication?.agent].some(ref => ref === agentRef || ref === routeKey));
        cacheConfirmation = purge[2] === commit && hosts.length === 1 && hosts[0][0] === purge[1]
            ? 'no-store-and-purge-verified' : null;
    } else if (cacheConfirmation !== 'no-shared-html-cache') cacheConfirmation = null;
    return {
        inventoryRow: evidence.agentRef === agentRef && evidence.commit === commit ? evidence.inventoryRow : null,
        availableMemoryBytes: Math.min(os.freemem(), process.availableMemory?.() ?? os.freemem()),
        cacheConfirmation,
    };
}

async function observePrimary({ workspaceRoot, primary, route, manifest, generationDigest }) {
    if (!exactId.test(primary.containerId) || !primary.launchId) throw new Error('primary has no exact launch binding');
    const live = inspectExactContainerById('podman', primary.containerId);
    assertExactContainerOwnership(route.container, primary, live, primary.containerId, workspaceNetworkIdentity(workspaceRoot).hash);
    if (!live.State?.Running) throw new Error('primary is not running');
    verifyRegisteredLaunchId(primary.launchId, live.Config.Env);
    const imageId = normalizeImageId(live.Image);
    if (!imageId) throw new Error('primary has no immutable image');
    const mounts = live.Mounts || [];
    const code = mounts.filter(m => m.Destination === '/code' && m.Type === 'bind');
    const skills = mounts.filter(m => m.Destination === '/code/skills' && m.Type === 'bind');
    if (code.length !== 1 || skills.length > 1) throw new Error('primary code mounts are ambiguous');
    const codeDir = fs.realpathSync(code[0].Source);
    const nestedSkills = path.join(codeDir, 'skills');
    const skillsDir = skills[0]?.Source || (fs.existsSync(nestedSkills) ? nestedSkills : null);
    const mountPoints = mounts.filter(m => m.Destination.startsWith('/code/') && m.Destination !== '/code/skills')
        .map(m => ({ target: m.Destination, type: fs.statSync(m.Source).isDirectory() ? 'directory' : 'file' }));
    // A private application port need not be a published or Router-authorized port.
    const port = manifest.canary.probe.port;
    const readiness = buildRelayReadinessRoute({
        manifest: { readiness: { port } }, generationDigest,
        runtimeResult: { containerId: primary.containerId, containerName: route.container, registryRecord: primary },
    });
    const listening = readiness.relay && await waitForAgentReady(readiness, {
        protocol: 'tcp', timeoutMs: 0, probeTimeoutMs: 5000,
    });
    const servedPorts = listening ? [port] : [];
    return { imageId, codeDir, skillsDir, mountPoints, servedPorts };
}

function prepare(workspaceRoot, selector, routing, agents, reason) {
    return withEdgeGenerationApplyLock(applyLockCapability => prepareAdditiveEdgeRoutingGeneration({
        workspaceRoot, expectedActiveGeneration: selector.generation, routing, agents, reason, applyLockCapability,
    }), { workspaceRoot }).preparationLease;
}

const digest = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');

function publish(workspaceRoot, preparationLease, routing, agents, save) {
    return withEdgeGenerationApplyLock(applyLockCapability => {
        const { generation, selector, paths } = assertActiveEdgeRoutingSourcesCurrent({ workspaceRoot });
        const topology = readCurrentEdgeTopology({ workspaceRoot });
        if (topology.authorizationGeneration !== selector.generation
            || selector.activationId !== preparationLease.selectorActivationId) {
            throw new Error('canary publication no longer owns its predecessor');
        }
        save({ preparationLease, publication: {
            before: { routing: generation.sourceDigests.routing, agents: generation.sourceDigests.agents },
            after: { routing: digest(JSON.stringify(routing, null, 2)), agents: digest(JSON.stringify(agents, null, 2)) },
            topologyVersion: topology.publicationGeneration, topologyDigest: digest(fs.readFileSync(paths.topologyCurrentFile)),
        } });
        return commitAdditiveEdgeRoutingGeneration(preparationLease, { workspaceRoot, routing, agents, applyLockCapability });
    }, { workspaceRoot, preparationLease });
}

function preparedRecord(primary, routeKey, networkAlias) {
    const record = {
        type: 'agent', runtime: 'podman', canaryOf: routeKey, networkAlias,
        instanceId: randomUUID(), enableGeneration: randomUUID(), createdAt: new Date().toISOString(),
    };
    for (const key of ['repoName', 'agentName', 'containerImage', 'alias', 'auth', 'profile', 'projectPath', 'runMode', 'develRepo']) {
        if (Object.hasOwn(primary, key)) record[key] = primary[key];
    }
    return record;
}

export async function startCanary({ workspaceRoot, agentRef, commit, share = 10, testAccounts = [], admissionEvidence }, deps = {}) {
    const { generation, selector, routeKey, route, primary, manifest } = target(workspaceRoot, agentRef);
    if (Object.values(generation.routing.routes).some(r => r.canary) || Object.values(generation.agents).some(isCanaryRecord)
        || canaryReceipts(workspaceRoot).some(r => !r.terminal)) throw new Error('workspace already has a canary rollout');
    if (!manifest.canary?.probe) throw new Error('manifest has no canary probe declaration');
    if (primary.runtime !== 'podman' || (deps.runtimeForAgent || getRuntimeForAgent)(manifest) !== 'podman') {
        throw new Error('canary requires the Podman runtime');
    }
    const containerName = route.container + '__canary';
    if (Object.hasOwn(generation.agents, containerName)) throw new Error('canary container name is occupied');
    const profile = resolveManifestRuntimeProfile(manifest, {
        agentName: agentRef, persistedProfileName: primary.profile, path: 'manifest(' + agentRef + ')',
    });
    if (!['default', 'bridge'].includes(profile.network.mode)) throw new Error('canary requires a managed network with a loopback publication');
    const evidence = (deps.admission || admission)({ agentRef, routeKey, commit, generation, admissionEvidence });
    assertCanaryEligibility({ ...evidence, routeKey });
    const agentPath = fs.realpathSync(route.hostPath);
    const observed = await (deps.observePrimary || observePrimary)({
        workspaceRoot, route, primary, agentPath, manifest, generationDigest: selector.generation,
    });
    const siblingDirs = new Set(Object.values(generation.routing.routes).filter(r => r.repo === route.repo && r.agent !== route.agent)
        .map(r => r.hostPath));
    for (const r of Object.values(generation.agents)) {
        if (r?.type === 'agent' && r.repoName === route.repo && r.agentName !== route.agent) {
            siblingDirs.add(path.join(path.dirname(agentPath), r.agentName));
        }
    }
    const inspectSource = () => inspectCanarySource({
        repoRoot: path.dirname(agentPath), codeDir: observed.codeDir, skillsDir: observed.skillsDir,
        siblingDirs: [...siblingDirs], servedPorts: observed.servedPorts, manifestPath: path.join(agentPath, 'manifest.json'), commit,
    });
    const source = inspectSource();
    const rolloutId = randomUUID();
    const codePath = path.posix.join('.ploinky', 'canary', routeKey, commit);
    const record = preparedRecord(primary, routeKey, deriveCanaryNetworkAlias(route.agent, rolloutId));
    const field = {
        container: containerName, rolloutId, commit, codePath: codePath + '/code', share, testAccounts, mode: 'split',
        salt: randomUUID(), probe: source.probe, thresholds: {},
        splitStartedAt: new Date().toISOString(), codeDigest: 'sha256:' + '0'.repeat(64),
    };
    validateCanaryField(field, 'canary');
    const identity = { routeKey, rolloutId };
    const save = fields => saveReceipt(identity, fields, workspaceRoot);
    // Refuse pre-existing exports before assigning ownership in the receipt.
    if (fs.lstatSync(path.join(workspaceRoot, codePath), { throwIfNoEntry: false })) throw new Error('canary export already exists');
    saveReceipt(identity, {
        oldCommit: source.oldCommit, canaryCommit: commit, repoName: route.repo, agentName: route.agent,
        oldContainerName: route.container, oldContainerId: primary.containerId, oldLaunchId: primary.launchId,
        oldInstanceId: primary.instanceId, oldEnableGeneration: primary.enableGeneration,
        canaryContainerName: containerName, canaryInstanceId: record.instanceId, canaryEnableGeneration: record.enableGeneration,
        networkAlias: record.networkAlias, codePath, repoRoot: source.repoRoot,
        canaryRecord: record, workspaceIdentity: workspaceNetworkIdentity(workspaceRoot).hash, intent: 'export',
    }, workspaceRoot, true);
    let lease;
    try {
        const exported = exportCanarySource({ workspaceRoot, routeKey, source, mountPoints: observed.mountPoints });
        field.codeDigest = exported.codeDigest;
        field.splitStartedAt = new Date().toISOString();
        save({ step: 'exported', intent: 'prepare', codeDigest: field.codeDigest });
        const routing = structuredClone(generation.routing);
        routing.routes[routeKey].canary = field;
        const agents = { ...generation.agents, [containerName]: record };
        lease = prepare(workspaceRoot, selector, routing, agents, 'canary-start:' + rolloutId);
        save({ intent: 'create', preparationLease: lease });
        await (deps.withNetwork || withNetworkLifecycleLockAsync)(async networkLifecycleCapability => {
            const started = await (deps.ensureService || ensureAgentService)(route.agent, manifest, agentPath, {
                containerName, profileName: primary.profile, profileResolution: profile,
                alias: primary.alias, routerEndpoint: resolveRouterEndpoint(profile.network.mode, { routingFile: path.join(workspaceRoot, '.ploinky', 'routing.json') }),
                preservePreparedRegistryRecord: true, preparedRegistryRecord: record, preparationLease: lease,
                hardwareInstanceKey: containerName, instanceId: record.instanceId, enableGeneration: record.enableGeneration,
                networkLifecycleCapability, canaryLaunch: true,
                canaryInputs: { codePath: exported.codePath, skillsPath: exported.skillsPath, imageId: observed.imageId,
                    rolloutId, networkAlias: record.networkAlias, onCreated({ containerId, launchId }) {
                        save({ step: 'created', intent: 'readiness', canaryContainerId: containerId, canaryLaunchId: launchId,
                            canaryRecord: { ...record, containerId, launchId } });
                    } },
            });
            const final = started.registryRecord;
            const created = readReceipt(routeKey, { workspaceRoot });
            if (started.containerName !== containerName || !exactId.test(started.containerId)
                || final?.containerId !== started.containerId || final.containerId !== created.canaryContainerId
                || !final.launchId || final.launchId !== created.canaryLaunchId || final.launchId === primary.launchId
                || final.networkAlias !== record.networkAlias || final.canaryOf !== routeKey || final.runtime !== 'podman'
                || final.instanceId !== record.instanceId || final.enableGeneration !== record.enableGeneration
                || !Number.isInteger(started.hostPort) || started.hostPort < 1 || started.hostPort > 65535) {
                throw new Error('canary launch did not return the exact prepared runtime');
            }
            await (deps.readiness || waitForEnabledAgentReadiness)(route.agent, manifest, started, {
                networkMode: profile.network.mode, generationDigest: lease.preparedGeneration,
            });
            const result = await (deps.probe || probeCanaryContainer)({ runtime: 'podman', containerId: started.containerId,
                containerName, workspaceRoot, registryRecord: final, ...source.probe, timeoutMs: 5000 });
            if (!result?.ok || result.status !== source.probe.status) throw new Error('canary operator probe failed');
            if (!isDeepStrictEqual(inspectSource(), source)) throw new Error('canary checkout changed during preparation');
            save({ intent: 'publish' });
            agents[containerName] = { ...final, hostPort: started.hostPort, ...(result.startedAt ? { startedAt: result.startedAt } : {}) };
            publish(workspaceRoot, lease, routing, agents, save);
            lease = null;
            if (started.durableCandidate) retireRuntimeCandidate(started.durableCandidate, { workspaceRoot });
            save({ step: 'published', intent: null, preparationLease: null, publication: null });
        });
        return rolloutId;
    } catch (error) {
        // The network lock has unwound. Recover this rollout only, preserving
        // the launch error and its open receipt if exact cleanup cannot finish.
        try {
            const owner = readEdgeRoutingPreparationOwner({ workspaceRoot });
            if (lease && owner?.pid === process.pid && owner.reason === 'canary-start:' + rolloutId) {
                abortEdgeRoutingPreparation(lease, { workspaceRoot });
            }
            const receipt = readReceipt(routeKey, { workspaceRoot });
            if (receipt?.rolloutId === rolloutId && !receipt.terminal) {
                await reconcileReceipt(receipt, workspaceRoot, deps.end || endCanary);
            }
        } catch { error.canaryRecoveryPending = true; }
        throw error;
    }
}

function matchingReceipt(routeKey, route, workspaceRoot) {
    const r = readReceipt(routeKey, { workspaceRoot });
    if (!r || r.terminal || r.rolloutId !== route.canary?.rolloutId || r.repoName !== route.repo || r.agentName !== route.agent
        || r.canaryCommit !== route.canary.commit || r.canaryContainerName !== route.canary.container) {
        throw new Error('no matching open canary rollout');
    }
    assertReceiptWorkspace(r, workspaceRoot);
    return r;
}

function assertReceiptWorkspace(receipt, workspaceRoot) {
    if (receipt.workspaceIdentity && receipt.workspaceIdentity !== workspaceNetworkIdentity(workspaceRoot).hash) {
        throw new Error('canary rollout belongs to another workspace');
    }
}

function promotionStarted(r) {
    return Boolean(r.failurePhase) || [r.lastCompletedStep, r.promotionStep, r.step, r.intent].some(value => Number(value) >= 1);
}

export async function changeCanary({ workspaceRoot, agentRef, action, share, status }) {
    const { generation, selector, routeKey, route } = target(workspaceRoot, agentRef);
    const receipt = matchingReceipt(routeKey, route, workspaceRoot);
    const readRow = async () => (await status()).rollouts.find(r => r.routeKey === routeKey && r.rolloutId === receipt.rolloutId);
    const row = await readRow();
    const allowed = action === 'resume' ? ['paused', 'tripped'] : ['split', 'paused', 'tripped'];
    if (!['resume', 'set'].includes(action) || !row || !allowed.includes(row.state) || route.canary.mode !== 'split'
        || promotionStarted(receipt) || row.exposureVersion == null) {
        throw new Error('cannot ' + action + ' a canary in this state');
    }
    const routing = structuredClone(generation.routing);
    const field = routing.routes[routeKey].canary;
    if (action === 'set') field.share = share;
    // A settings publication must be distinguishable even within one millisecond.
    field.splitStartedAt = new Date(Math.max(Date.now(), Date.parse(field.splitStartedAt) + 1)).toISOString();
    validateCanaryField(field, 'canary');
    const fields = { intent: action, previousSettingsChange: receipt.settingsChange ?? null,
        settingsChange: { action, splitStartedAt: field.splitStartedAt, exposureVersion: row.exposureVersion } };
    const save = fields => saveReceipt(receipt, fields, workspaceRoot);
    save(fields);
    const lease = prepare(workspaceRoot, selector, routing, generation.agents, 'canary-' + action + ':' + receipt.rolloutId);
    try { publish(workspaceRoot, lease, routing, generation.agents, save); }
    catch (error) { abortEdgeRoutingPreparation(lease, { workspaceRoot }); throw error; }
    save({ intent: null, previousSettingsChange: null, publication: null, preparationLease: null });
    if (action === 'resume') {
        const applied = await readRow();
        if (applied?.state !== 'split' || !(Date.parse(applied.splitStartedAt) >= Date.parse(field.splitStartedAt))) {
            throw new Error('Router did not confirm the resumed split at the requested exposure');
        }
    }
}

export async function abortCanary({ workspaceRoot, agentRef }, { end = endCanary } = {}) {
    const { routeKey, route } = target(workspaceRoot, agentRef);
    const receipt = readReceipt(routeKey, { workspaceRoot });
    if (receipt?.terminal?.outcome === 'aborted' && !route.canary
        && receipt.repoName === route.repo && receipt.agentName === route.agent) {
        assertReceiptWorkspace(receipt, workspaceRoot);
        return { ended: true, outcome: 'aborted' };
    }
    matchingReceipt(routeKey, route, workspaceRoot);
    if (!['split', 'withdrawn'].includes(route.canary.mode) || promotionStarted(receipt)) {
        throw new Error('cannot abort after promotion has begun');
    }
    return end({ routeKey, workspaceRoot, reason: 'abort' });
}

// A commit installs routing, registry and topology before flipping the
// selector. Validate the entire repair before restoring any predecessor bytes.
function recoverPublication(receipt, options) {
    const journal = receipt.publication;
    const lease = receipt.preparationLease;
    const { selector, generation, paths } = loadActiveEdgeRoutingGeneration(options);
    const topology = readCurrentEdgeTopology(options);
    if (selector.activationId !== lease.selectorActivationId) {
        assertActiveEdgeRoutingSourcesCurrent(options);
        if (generation.sourceDigests.routing !== journal.after.routing || generation.sourceDigests.agents !== journal.after.agents
            || topology.authorizationGeneration !== selector.generation) throw new Error('canary publication candidate changed');
        return;
    }
    if (selector.generation !== lease.predecessorGeneration || selector.selectorDigest !== lease.selectorDigest) {
        throw new Error('canary publication predecessor changed');
    }
    const file = path.join(paths.generationsDir, selector.generation.slice(7) + '.json');
    const persisted = JSON.parse(fs.readFileSync(file)).sources;
    const restores = [];
    for (const key of ['routing', 'agents']) {
        const before = Buffer.from(persisted[key], 'base64');
        const destination = paths[key + 'File'];
        const current = digest(fs.readFileSync(destination));
        if (digest(before) !== generation.sourceDigests[key] || digest(before) !== journal.before[key]
            || current !== journal.before[key] && current !== journal.after[key]) {
            throw new Error('canary publication sources changed during recovery');
        }
        if (current !== journal.before[key]) restores.push([destination, before]);
    }
    const current = fs.readFileSync(paths.topologyCurrentFile);
    if (digest(current) !== journal.topologyDigest) {
        const candidate = loadEdgeRoutingGenerationForEvidence(topology.authorizationGeneration, options);
        const immutable = (id, version) => path.join(paths.topologyGenerationsDir, id.slice(7) + '-' + version + '.json');
        if (!Number.isSafeInteger(journal.topologyVersion) || topology.publicationGeneration !== journal.topologyVersion + 1
            || !isDeepStrictEqual(candidate.sourceDigests, { ...generation.sourceDigests, ...journal.after })
            || !current.equals(fs.readFileSync(immutable(candidate.generation, topology.publicationGeneration)))) {
            throw new Error('canary publication topology changed during recovery');
        }
        const before = fs.readFileSync(immutable(selector.generation, journal.topologyVersion));
        if (digest(before) !== journal.topologyDigest) throw new Error('canary predecessor topology changed');
        restores.push([paths.topologyCurrentFile, before, 0o644]);
    }
    for (const args of restores) replaceCanaryFileDurably(...args);
    assertActiveEdgeRoutingSourcesCurrent(options);
}

// Called under the workspace mutation lease, before S2 or S5 reads mutable
// routing and registry sources. This recovers only the exact S2 preparation.
export function recoverCanaryPreparation(receipt, workspaceRoot) {
    assertReceiptWorkspace(receipt, workspaceRoot);
    const options = { workspaceRoot };
    const owner = readEdgeRoutingPreparationOwner(options);
    const owns = owner?.mode === 'additive' && ['start', 'set', 'resume'].some(action =>
        owner.reason === 'canary-' + action + ':' + receipt.rolloutId);
    if (!owns && !receipt.publication) return;
    if (!isDeepStrictEqual(readReceipt(receipt.routeKey, options), receipt)) throw new Error('canary recovery receipt changed');
    // A kill after prepare but before recording its lease still has the
    // rollout-specific reason. Re-check that exact lease under the apply lock.
    let preparationLease;
    if (owns) {
        preparationLease = JSON.parse(fs.readFileSync(resolveEdgeGenerationPaths(options).preparationLeaseFile));
        if (preparationLease.reason !== owner.reason || preparationLease.pid !== owner.pid
            || receipt.preparationLease && receipt.preparationLease.transactionId !== preparationLease.transactionId) {
            throw new Error('canary preparation changed during recovery');
        }
    }
    withEdgeGenerationApplyLock(applyLockCapability => {
        if (owns && !edgePreparationOwnerStopped(owner)) throw new Error('canary preparation is still owned by a running process');
        if (receipt.publication) recoverPublication(receipt, options);
        if (owns) retireAbandonedActiveBoundPreparation({ ...options, applyLockCapability });
        saveReceipt(receipt, { publication: null, preparationLease: null }, workspaceRoot);
    }, { ...options, preparationLease });
}

function exactCandidate(receipt, workspaceRoot) {
    if (!receipt.canaryRecord) return null;
    const candidate = readRuntimeCandidate(receipt.canaryContainerName, receipt.canaryRecord, { workspaceRoot });
    if (candidate && candidate.containerId !== receipt.canaryContainerId) {
        throw new Error('runtime candidate differs from canary creation receipt');
    }
    return candidate;
}

// S5 teardown proves the launch environment and managed tuple (including a
// name-to-immutable-ID reinspection if create returned before onCreated ran).
async function reconcileReceipt(receipt, workspaceRoot, end) {
    const { routeKey, rolloutId } = receipt;
    assertReceiptWorkspace(receipt, workspaceRoot);
    const candidate = exactCandidate(receipt, workspaceRoot);
    if (receipt.terminal) {
        if (candidate && receipt.teardown?.id === candidate.containerId) retireRuntimeCandidate(candidate, { workspaceRoot });
        return;
    }
    recoverCanaryPreparation(receipt, workspaceRoot);
    const { generation } = loadActiveEdgeRoutingGeneration({ workspaceRoot });
    const field = generation.routing.routes[routeKey]?.canary;
    if (field && field.rolloutId !== rolloutId) throw new Error('canary receipt and active rollout disagree');
    if (field) {
        const record = generation.agents[field.container];
        if (field.container !== receipt.canaryContainerName || field.commit !== receipt.canaryCommit
            || record?.containerId !== receipt.canaryContainerId || record?.launchId !== receipt.canaryLaunchId
            || record?.instanceId !== receipt.canaryInstanceId || record?.enableGeneration !== receipt.canaryEnableGeneration) {
            throw new Error('published canary differs from start receipt');
        }
        if (candidate) retireRuntimeCandidate(candidate, { workspaceRoot });
    }
    if (promotionStarted(receipt) || ['all', 'retiring'].includes(field?.mode)) return;
    const save = fields => saveReceipt(receipt, fields, workspaceRoot);
    if (field && ['created', 'exported'].includes(receipt.step)) {
        save({ step: 'published', intent: null, preparationLease: null, publication: null });
    } else if (field && ['set', 'resume'].includes(receipt.intent)) {
        const applied = receipt.settingsChange?.splitStartedAt === field.splitStartedAt;
        save({ intent: null, publication: null, preparationLease: null, previousSettingsChange: null,
            settingsChange: applied ? receipt.settingsChange : receipt.previousSettingsChange ?? null });
    } else if (receipt.teardown || !field || field.mode === 'withdrawn') {
        if (!field && !receipt.teardown && receipt.step === 'published') {
            throw new Error('published canary is missing its route and registry pair');
        }
        await end({ routeKey, workspaceRoot, reason: receipt.teardown?.reason || (field ? 'abort' : 'interrupted-start') });
        if (!field && candidate) retireRuntimeCandidate(candidate, { workspaceRoot });
    }
}

export async function reconcileCanaryCommands(workspaceRoot, { end = endCanary } = {}) {
    for (const receipt of canaryReceipts(workspaceRoot)) await reconcileReceipt(receipt, workspaceRoot, end);
}
