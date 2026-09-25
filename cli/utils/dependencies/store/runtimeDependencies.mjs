// Runtime integration of the immutable dependency cache.
//
// Every runtime (Docker/Podman, bwrap, seatbelt) obtains its dependency tree
// through this one resolver, so full-graph preparation and runtime-level reuse
// agree on the desired generation (the plan is memoized per lifecycle command).
//
// Admitted runtimes carry a `dependencies` record:
//   { schema: 1, mode: 'store', family, runtimeKey, imageId, inputKey,
//     generationId, objectId, payloadPath, nodeModulesPath }
//   { schema: 1, mode: 'none', reason, family, runtimeKey?, imageId? }
// Records without it are legacy: a legacy cache mount is a different
// generation (replacement, never adoption), and legacy caches are never
// prepared, repaired or deleted here.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { DEPS_DIR, PLOINKY_WORKSPACE_ROOT } from '../../config.js';
import { readGlobalDepsPackage } from '../dependencyInstaller.js';
import { activeAgentLibSelection } from '../agentLibLink.js';
import { dependencyRefreshOperation } from '../dependencyRefresh.mjs';
import { detectHostRuntimeKey, parseRuntimeKey } from '../dependencyRuntimeKey.js';
import { activeBoxMcpSdkBundle } from '../../../../ploinky-box/agent-dependencies/mcp-sdk.mjs';
import {
    createWorkspaceMutationLease,
    heldWorkspaceMutationLease,
    releaseWorkspaceMutationLease,
    assertWorkspaceMutationLease,
} from '../../runtime/maintenanceLocks.js';
import { readProcessStartIdentity } from '../../../sandbox/processIdentity.js';
import { dependencyStoreError, canonicalDigest, sha256Hex } from './canonical.mjs';
import {
    buildAgentInstallPlan,
    buildProviderContract,
    buildSeedInstallPlan,
    containerToolchainIdentity,
    defaultInspectImage,
    defaultProbeHostToolchain,
    hostToolchainIdentity,
    normalizeImageId,
} from './installContract.mjs';
import { containerNpmPolicy, defaultNpmConfigSources, resolveHostNpmPolicy } from './npmPolicy.mjs';
import { createContainerNpmInstaller, createHostNpmInstaller } from './installers.mjs';
import { createCacheStore, DEPENDENCY_STORE_DIRNAME } from './objectStore.mjs';
import { readBootScope } from './receipts.mjs';

export const DEPENDENCY_RECORD_SCHEMA = 1;
const CANDIDATE_SUFFIX = /__candidate_[a-f0-9]{12}$/i;

let defaultStoreInstance = null;
function defaultStore() {
    const root = path.resolve(PLOINKY_WORKSPACE_ROOT);
    if (!defaultStoreInstance || defaultStoreInstance.__root !== root) {
        const store = createCacheStore({ depsDir: DEPS_DIR, workspaceRoot: root });
        defaultStoreInstance = Object.assign(Object.create(store), { __root: root });
    }
    return defaultStoreInstance;
}

function seams(deps = {}) {
    return {
        store: deps.store || defaultStore(),
        inspectImage: deps.inspectImage || defaultInspectImage,
        probeHostToolchain: deps.probeHostToolchain || defaultProbeHostToolchain,
        npmConfigSources: deps.npmConfigSources || (() => defaultNpmConfigSources({ env: process.env })),
        readGlobalPackage: deps.readGlobalPackage || readGlobalDepsPackage,
        agentLibSelection: deps.agentLibSelection || (() => activeAgentLibSelection()),
        sdkBundle: deps.sdkBundle || (() => activeBoxMcpSdkBundle()),
        workspaceRoot: deps.workspaceRoot || PLOINKY_WORKSPACE_ROOT,
        createInstaller: deps.createInstaller || null,
        resolveLease: deps.resolveLease || resolveDependencyLease,
        memo: deps.memo === undefined ? dependencyRefreshOperation() : deps.memo,
        hostRuntimeKey: deps.hostRuntimeKey || detectHostRuntimeKey,
    };
}

/** One logical registration per container/sandbox name; candidates share it. */
export function registrationIdFor(containerName) {
    return String(containerName || '').replace(CANDIDATE_SUFFIX, '');
}

function realOrResolved(target) {
    try { return fs.realpathSync(target); } catch { return path.resolve(target); }
}

/**
 * The package source that reaches the installer: `<agentCodePath>/package.json`,
 * where agentCodePath already follows current `code/` precedence.
 */
export function agentPackageSourceAt(agentCodePath, { workspaceRoot = PLOINKY_WORKSPACE_ROOT } = {}) {
    const codePath = realOrResolved(agentCodePath);
    const packagePath = path.join(codePath, 'package.json');
    const relativePath = path.relative(realOrResolved(workspaceRoot), packagePath).split(path.sep).join('/');
    const selection = path.basename(codePath) === 'code' ? 'code' : 'root';
    let bytes;
    try { bytes = fs.readFileSync(packagePath); }
    catch (error) {
        if (error?.code === 'ENOENT') return { selection, relativePath, sha256: null, manifest: null };
        throw error;
    }
    return { selection, relativePath, sha256: sha256Hex(bytes), manifest: JSON.parse(bytes.toString('utf8')) };
}

function memoized(memo, key, compute) {
    if (!memo || typeof memo.get !== 'function') return compute();
    const full = `dependency-store:${key}`;
    if (memo.has(full)) return memo.get(full);
    const value = compute();
    memo.set(full, value);
    return value;
}

/**
 * Compute the desired dependency generation of one runtime from effective
 * inputs. Pure except for image inspection, host toolchain probing and
 * reading npm configuration; never builds anything.
 *
 * @param {{ family: 'container'|'bwrap'|'seatbelt', runtimeKey: string, engine?: string, image?: string,
 *   imageId?: string, agentCodePath: string, registration: string, rebuildToken?: string|null }} input
 */
export function planRuntimeDependencies(input, deps = {}) {
    const s = seams(deps);
    const { family, runtimeKey, engine = '', image = '', agentCodePath, registration } = input;
    const parsed = parseRuntimeKey(runtimeKey);
    if (!parsed || parsed.family !== family) {
        throw dependencyStoreError('PLOINKY_DEPS_RUNTIME_KEY_INVALID', `runtime key ${runtimeKey} does not match runtime family ${family}`);
    }
    const registrationId = registrationIdFor(registration);
    // A reinstall issued in this command acts on its DESIRED token (and builds
    // from empty state); every other lifecycle keys on the ADMITTED token.
    const requested = input.rebuildToken === undefined ? requestedRebuildToken(s.memo, registrationId) : null;
    const rebuildState = s.store.readRebuildState(registrationId);
    const recordedToken = input.admittedRecord?.dependencies?.mode === 'store'
        ? input.admittedRecord.dependencies.rebuildToken : null;
    // Activation can succeed before persisting the rebuild settlement fails.
    // The caller's durable launch authority then proves which pending token
    // was installed; never roll that runtime back to an older metadata token.
    const activatedPendingToken = recordedToken && rebuildState.desired?.token === recordedToken
        ? recordedToken : null;
    const rebuildToken = input.rebuildToken !== undefined
        ? input.rebuildToken
        : (requested || activatedPendingToken || rebuildState.admittedToken);
    let imageId = input.imageId || null;
    let toolchainIdentity;
    let npmPolicy;
    let transport = null;
    let hostProbe = null;
    if (family === 'container') {
        imageId = imageId ? normalizeImageId(imageId) : containerToolchainIdentity({ runtime: engine, image, inspectImage: s.inspectImage }).identity.imageId;
        toolchainIdentity = { kind: 'container', engine, imageId };
        npmPolicy = containerNpmPolicy();
    } else {
        hostProbe = memoized(s.memo, `host-probe:${process.env.PATH || ''}`, () => s.probeHostToolchain({ env: process.env }));
        toolchainIdentity = hostToolchainIdentity({ runtimeKey, probe: hostProbe });
        const resolved = resolveHostNpmPolicy(s.npmConfigSources());
        npmPolicy = resolved.policy;
        transport = resolved.transport;
    }
    const agentPackage = agentPackageSourceAt(agentCodePath, { workspaceRoot: s.workspaceRoot });
    const agentLibSelection = s.agentLibSelection();
    const sdkBundle = s.sdkBundle();
    const provider = buildProviderContract({ runtimeKey, toolchain: toolchainIdentity, npmPolicy, sdkBundle, agentLib: agentLibSelection });
    const globalPackage = s.readGlobalPackage();
    const pinState = s.store.readPins().pins;
    const sourceIdentity = canonicalDigest({ provider, globalPackage, pinState });
    const memoKey = `plan:${family}:${runtimeKey}:${engine}:${imageId || ''}:${registrationId}:${rebuildToken || ''}:${agentPackage.relativePath}:${agentPackage.sha256 || ''}:${sourceIdentity}`;
    return memoized(s.memo, memoKey, () => {
        const seedPlan = buildSeedInstallPlan({ provider, globalPackage, sdkBundle, agentLibSelection, pinState });
        const agentPlan = buildAgentInstallPlan({
            provider, globalPackage, agentPackage, registration: registrationId, rebuildToken, sdkBundle, agentLibSelection, pinState,
        });
        const createInstaller = () => {
            if (s.createInstaller) return s.createInstaller({ family, engine, imageId, hostProbe, npmPolicy, transport });
            return family === 'container'
                ? createContainerNpmInstaller({ engine, imageId })
                : createHostNpmInstaller({ toolchain: hostProbe, policy: npmPolicy, transport, ceilingDirectories: [s.workspaceRoot] });
        };
        return Object.freeze({
            family, runtimeKey, engine, imageId, registration: registrationId, rebuildToken,
            bypassSeeds: Boolean(requested), provider, seedPlan, agentPlan, createInstaller,
        });
    });
}

/**
 * The held workspace mutation lease, or a transient one when this process
 * holds none. Never waits: a busy workspace fails closed with a named error
 * (waiting here could invert lock order with a caller's maintenance lock).
 */
export function resolveDependencyLease(lease = null) {
    if (lease) return { lease: assertWorkspaceMutationLease(lease), release() {} };
    const held = heldWorkspaceMutationLease();
    if (held) return { lease: held, release() {} };
    let transient;
    try {
        transient = createWorkspaceMutationLease({ operation: 'dependency-preparation' });
    } catch (error) {
        if (error?.code !== 'PLOINKY_WORKSPACE_MUTATION_BUSY') throw error;
        throw dependencyStoreError('PLOINKY_DEPS_WORKSPACE_LEASE_BUSY',
            `dependency preparation needs the workspace mutation lease, which is held by another operation (${error.message}); retry after it completes`);
    }
    return { lease: transient, release() { releaseWorkspaceMutationLease(transient); } };
}

export function dependencyRecordFrom(plan, generation) {
    return Object.freeze({
        schema: DEPENDENCY_RECORD_SCHEMA,
        mode: 'store',
        family: plan.family,
        runtimeKey: plan.runtimeKey,
        imageId: plan.imageId || null,
        inputKey: generation.inputKey,
        generationId: generation.generationId,
        objectId: generation.objectId,
        payloadPath: generation.payloadPath,
        nodeModulesPath: generation.nodeModulesPath,
        rebuildToken: plan.rebuildToken || null,
    });
}

/**
 * Whether an activated runtime actually carries a reinstall request's token.
 * No-cache runtimes carry no dependency object and trivially satisfy it.
 */
export function runtimeCarriesRebuildToken(registryRecord, token) {
    const dependencies = registryRecord?.dependencies;
    if (!dependencies || dependencies.schema !== DEPENDENCY_RECORD_SCHEMA) return false;
    if (dependencies.mode === 'none') return true;
    if (dependencies.mode !== 'store') return false;
    return dependencies.rebuildToken === token;
}

export function noCacheDependencyRecord(reason, { family, runtimeKey = null, imageId = null } = {}) {
    return Object.freeze({ schema: DEPENDENCY_RECORD_SCHEMA, mode: 'none', reason, family, runtimeKey, imageId });
}

/**
 * Resolve (or build) the desired generation under the held workspace lease
 * and publish the consumer's reader receipt before the path is returned.
 *
 * @returns {{ plan, record, nodeModulesPath: string, readerReceipt: object, status: string }}
 */
export function prepareRuntimeDependencies(input, { lease = null, consumer, reinstall = false, operation = 'runtime-start' } = {}, deps = {}) {
    const s = seams(deps);
    const held = s.resolveLease(lease);
    try {
        const plan = planRuntimeDependencies(input, deps);
        const result = s.store.ensureAgentGeneration(held.lease, {
            agentPlan: plan.agentPlan,
            seedPlan: plan.seedPlan,
            installer: plan.createInstaller(),
            consumer,
            operation,
            reinstall: reinstall || plan.bypassSeeds,
        });
        return {
            plan,
            record: dependencyRecordFrom(plan, result),
            nodeModulesPath: result.nodeModulesPath,
            readerReceipt: result.readerReceipt,
            status: result.status,
            updateConsumer(patch) {
                const current = s.resolveLease(lease);
                try { return s.store.updateReaderReceipt(current.lease, result.readerReceipt, patch); }
                finally { current.release(); }
            },
            release() { return s.store.releaseReaderReceipt(result.readerReceipt); },
        };
    } finally {
        held.release();
    }
}

const REBUILD_MEMO_PREFIX = 'dependency-store:rebuild-request:';

function requestedRebuildToken(memo, registration) {
    if (!memo || typeof memo.get !== 'function') return null;
    return memo.get(`${REBUILD_MEMO_PREFIX}${registration}`) || null;
}

/**
 * Reinstall: issue (or reuse) the DESIRED rebuild request of one exact logical
 * registration under the held lease and bind it to this lifecycle command.
 * A pending or failed request is reused, so retries never mint unbounded new
 * keys; a new token is minted only after the previous request was admitted.
 *
 * @returns {{ registration: string, token: string, reused: boolean }}
 */
export function issueDependencyRebuildRequest(registration, { lease = null } = {}, deps = {}) {
    const s = seams(deps);
    const registrationId = registrationIdFor(registration);
    if (!registrationId) throw dependencyStoreError('PLOINKY_DEPS_REGISTRATION_REQUIRED', 'a rebuild request needs one exact registration');
    const held = s.resolveLease(lease);
    try {
        let issued = null;
        s.store.updateRebuildState(held.lease, registrationId, (state) => {
            const reuse = state.desired && ['pending', 'failed'].includes(state.desired.status);
            const token = reuse ? state.desired.token : randomUUID();
            issued = { registration: registrationId, token, reused: Boolean(reuse) };
            return {
                ...state,
                desired: {
                    token,
                    status: 'pending',
                    requestedAt: reuse ? state.desired.requestedAt : new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                },
            };
        });
        if (s.memo && typeof s.memo.set === 'function') s.memo.set(`${REBUILD_MEMO_PREFIX}${registrationId}`, issued.token);
        return issued;
    } finally {
        held.release();
    }
}

/**
 * Settle a desired rebuild request after the replaced runtime was admitted
 * (it becomes the admitted token) or failed (the admitted token is kept and
 * the desired request records the failure for a retry).
 */
export function settleDependencyRebuildRequest(registration, token, { lease = null, outcome, error = null } = {}, deps = {}) {
    const s = seams(deps);
    const registrationId = registrationIdFor(registration);
    const held = s.resolveLease(lease);
    try {
        return s.store.updateRebuildState(held.lease, registrationId, (state) => {
            if (state.desired?.token !== token) return state;
            if (outcome === 'admitted') return { ...state, admittedToken: token, desired: null };
            return {
                ...state,
                desired: { ...state.desired, status: 'failed', updatedAt: new Date().toISOString(), error: String(error?.message || error || 'failed').slice(0, 500) },
            };
        });
    } finally {
        held.release();
        if (s.memo && typeof s.memo.delete === 'function') s.memo.delete(`${REBUILD_MEMO_PREFIX}${registrationId}`);
    }
}

function legacyCacheMount(record) {
    for (const bind of record?.config?.binds || []) {
        const source = String(bind?.source || '');
        if (path.basename(source) !== 'node_modules') continue;
        const resolved = path.resolve(source);
        const deps = path.resolve(DEPS_DIR);
        if (resolved.startsWith(`${deps}${path.sep}`) && !resolved.startsWith(`${path.join(deps, DEPENDENCY_STORE_DIRNAME)}${path.sep}`)) {
            return resolved;
        }
    }
    return null;
}

/** The dependency state an admitted runtime actually uses. */
export function admittedDependencyRecord(record) {
    const dependencies = record?.dependencies;
    if (dependencies?.schema === DEPENDENCY_RECORD_SCHEMA && ['store', 'none'].includes(dependencies.mode)) return dependencies;
    const legacy = legacyCacheMount(record);
    if (legacy) return { mode: 'legacy', nodeModulesPath: legacy };
    return { mode: 'unknown' };
}

/**
 * Why an admitted store generation cannot serve the desired inputs, or ''.
 * Read-only: validation never writes receipts, marks or indexes.
 */
export function storeGenerationReuseProblem(admitted, desiredInputKey, deps = {}) {
    const s = seams(deps);
    if (admitted.mode !== 'store') return `admitted runtime has no store dependency generation (${admitted.mode})`;
    if (admitted.inputKey !== desiredInputKey) return 'dependency inputs changed';
    const validation = s.store.validateObject(admitted.objectId, { inputKey: desiredInputKey });
    if (!validation.valid) return `admitted dependency generation is not usable: ${validation.reason}`;
    if (validation.generationId !== admitted.generationId
        || path.join(validation.payloadPath, 'node_modules') !== path.resolve(admitted.nodeModulesPath || '')) {
        return 'admitted dependency generation path drifted';
    }
    return '';
}

/**
 * The one reuse decision every runtime path consults before reusing or
 * adopting an admitted runtime: '' means the admitted dependency tree is the
 * desired generation; any other value requires replacement (a new runtime).
 *
 * @param {{ record: object, family: 'container'|'bwrap'|'seatbelt', needsDependencies: boolean,
 *   agentCodePath: string, registration: string, engine?: string, image?: string,
 *   noNodeAllowed?: boolean }} input
 */
export function runtimeDependencyReuseProblem(input, deps = {}) {
    const s = seams(deps);
    const admitted = admittedDependencyRecord(input.record);
    if (!input.needsDependencies) {
        return admitted.mode === 'store' || admitted.mode === 'legacy' ? 'runtime no longer needs its dependency cache' : '';
    }
    if (admitted.mode === 'legacy') return 'admitted runtime mounts a legacy dependency cache';
    if (admitted.mode === 'unknown') return 'admitted runtime has no dependency generation record';
    let runtimeKey = admitted.runtimeKey;
    let imageId = null;
    try {
        if (input.family === 'container') {
            imageId = containerToolchainIdentity({ runtime: input.engine, image: input.image, inspectImage: s.inspectImage }).identity.imageId;
            if (admitted.imageId !== imageId) return 'runtime image changed';
        } else {
            runtimeKey = s.hostRuntimeKey(input.family);
            if (admitted.runtimeKey !== runtimeKey) return 'host runtime key changed';
        }
    } catch (error) {
        return `desired dependency identity unavailable: ${error?.message || error}`;
    }
    if (admitted.mode === 'none') {
        return admitted.reason === 'no-node-image' && input.noNodeAllowed === true ? '' : `dependency mode changed (${admitted.reason})`;
    }
    let plan;
    try {
        plan = planRuntimeDependencies({
            family: input.family,
            runtimeKey,
            engine: input.engine,
            image: input.image,
            imageId,
            agentCodePath: input.agentCodePath,
            registration: input.registration,
            admittedRecord: input.record,
        }, deps);
    } catch (error) {
        return `desired dependency generation unavailable: ${error?.message || error}`;
    }
    return storeGenerationReuseProblem(admitted, plan.agentPlan.inputKey, deps);
}

/**
 * Interactive attachments reuse the service's admitted tree read-only with
 * their own receipt (released by the caller in `finally`). Nothing is built.
 *
 * @returns {{ nodeModulesPath: string, release: Function }|null}
 */
export function attachAdmittedDependencies(record, { consumer, lease = null }, deps = {}) {
    const s = seams(deps);
    const admitted = admittedDependencyRecord(record);
    if (admitted.mode === 'store') {
        const held = s.resolveLease(lease);
        try {
            const handle = s.store.acquireAttachmentReceipt(held.lease, {
                objectId: admitted.objectId,
                generationId: admitted.generationId,
                inputKey: admitted.inputKey,
                payloadPath: admitted.payloadPath,
            }, consumer);
            return { nodeModulesPath: admitted.nodeModulesPath, release: () => s.store.releaseReaderReceipt(handle), receipt: handle };
        } finally {
            held.release();
        }
    }
    if (admitted.mode === 'legacy') return { nodeModulesPath: admitted.nodeModulesPath, release() { return false; }, receipt: null };
    return null;
}

/** Process identity of a spawned sandbox for reader receipts. */
export function sandboxProcessIdentity(pid) {
    return { pid, processStart: readProcessStartIdentity(pid), bootScope: readBootScope() };
}

export function runtimeDependencyStore(deps = {}) {
    return seams(deps).store;
}
