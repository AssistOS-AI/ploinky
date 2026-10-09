import fs from 'fs';
import path from 'path';
import { AsyncResource } from 'node:async_hooks';
import { withWorkspaceMutationLease } from '../../utils/runtime/maintenanceLocks.js';
import { uninstallRepositoryUnderLease } from '../../utils/repositoryUninstall.mjs';
import { installRepositoryLinks, removeRepositoryLinks } from '../../utils/repositoryInstall.mjs';

import * as reposSvc from '../../utils/repos.js';
import { resolveSkillRepositorySource } from '../../utils/skillRepositorySource.js';
import { listAgentRepositoryNames, workspaceAgentRepositoryPath, runWithRepositoryResolutionScope } from '../../utils/agentRepositorySource.mjs';
import { prefetchWorkspaceRepositoryOrigins } from '../../utils/repositorySource.mjs';
import { PLOINKY_WORKSPACE_ROOT } from '../../utils/config.js';
import * as agentsSvc from '../../utils/agents.js';
import * as workspaceSvc from '../../utils/workspace.js';
import { collectAgentRuntimeStates } from '../../sandbox/agentRuntimeState.js';
import { collectLiveAgentContainersAsync } from '../../sandbox/docker/containerRegistry.js';
import { debugLog } from '../../utils/utils.js';
import { readAgentRegistrySnapshot } from '../../utils/agentRegistrySnapshot.js';
import {
    createNoWaitRunBinding,
    observeBoundNoWaitRun,
    readNoWaitRunMarker,
    summarizeNoWaitFailure,
} from '../../commands/noWaitLogObserver.js';
import {
    mapNoWaitObservationForMarketplace,
    observeNoWaitAgentRecord,
} from '../noWaitAgentStartupState.js';
import { collectAgentsSummary } from '../../utils/status.js';
import { isAdminUser } from '../auth/localService.js';
import { projectMarketplaceAgent, projectMarketplaceRepository, projectRepositorySource } from './marketplaceProjection.js';
import { canonicalControlOrigin, verifyAdminMutationRequest } from '../adminControlSecurity.js';
import { verifyBrowserMutationRequest } from '../browserMutationSecurity.js';
import { resolveAuthContextForRouteKey } from './authContext.js';
import { computeRchHttp, sha256RawBodyHash } from '../../../Agent/lib/requestHash.mjs';
import { verifyAgentAssertion } from '../mcp-proxy/invocationMinter.js';
import { createTokenReplayCache } from '../security/tokens/JwsCodec.js';
import { runMarketplaceEnableWorker } from '../marketplaceEnableWorker.js';
import { repositoryWorkerEligible, runMarketplaceRepositoryWorker } from '../marketplaceRepositoryWorker.mjs';
import { diagnosticIdentity } from '../marketplaceRepositoryDiagnostics.mjs';
import { authService, LOCAL_AUTH_COOKIE_NAME, parseCookies, sendJson, sessionTokenService, SSO_AUTH_COOKIE_NAME } from './shared.js';
import { localSessionAllowedForRoutePlan } from './authContext.js';
import { findHardwareOutcome, formatHardwareOutcome } from '../../sandbox/hardwareLimits/errors.mjs';
import { handleHardwareLimitsRoutes } from './hardwareLimitsRoutes.mjs';
import { readEdgeRoutingSelection } from '../../sandbox/edgeGeneration.js';

export const MARKETPLACE_PATH = '/api/marketplace';
export const MARKETPLACE_AGENT_TARGET = 'ploinky-router';
export const MARKETPLACE_READ_TOOL = 'marketplace.read';
export const MARKETPLACE_ENABLE_TOOL = 'marketplace.enable_agent';
const marketplaceAssertionReplayCache = createTokenReplayCache({ maxSize: 4096 });

const SAFE_LIFECYCLE_ERRORS = new Map([
    ['PLOINKY_MARKETPLACE_REPOSITORY_RECOVERY_REQUIRED', { status: 503, message: 'Repository operation requires workspace recovery. Stop the exact Box from its host workspace, then start it again.' }],
    ['EDGE_GENERATION_CHANGED', { status: 503, message: 'The routing generation changed. Refresh Marketplace before retrying.' }],
    ['PLOINKY_BOX_RUNTIME_CAPABILITY_UNSUPPORTED', { status: 422, message: 'The requested runtime capability is unavailable in Ploinky Box.' }],
    ['PLOINKY_MANIFEST_SECURITY_INVALID', { status: 422, message: 'The agent manifest contains invalid runtime security settings.' }],
    ['PLOINKY_MANIFEST_SECURITY_PROFILE_UNSUPPORTED', { status: 422, message: 'Runtime security settings are only supported at the manifest root.' }],
    ['PLOINKY_BOX_MARKER_INVALID', { status: 409, message: 'The Ploinky Box identity marker is invalid.' }],
    ['PLOINKY_RUNTIME_INPUT_CHANGED', { status: 409, message: 'The admitted runtime input changed before launch.' }],
    ['PLOINKY_BWRAP_CAPABILITY_UNAVAILABLE', { status: 422, message: 'The required Bubblewrap capability is unavailable.' }],
    ['PLOINKY_OPEN_INTERPRETER_BOX_UNAVAILABLE', { status: 422, message: 'Open Interpreter is unavailable in this Ploinky Box.' }],
    ['PLOINKY_MARKETPLACE_ENABLE_TIMEOUT', { status: 504, message: 'Agent activation timed out.' }],
    ['PLOINKY_AGENT_ENABLE_MODE_UNSUPPORTED', { status: 422, message: 'The agent does not support the selected run mode.' }],
    ['PLOINKY_MANIFEST_ENABLE_MODES_INVALID', { status: 422, message: 'The agent manifest declares invalid enable modes.' }],
]);
// The agent listing reads the container engine (two child processes). At most this many inventories run at once; every other request waits for
// a slot and then collects for itself, so no inventory result is ever shared between requests.
const MARKETPLACE_INVENTORY_MAX_IN_FLIGHT = 2;
const MARKETPLACE_INVENTORY_SKIPPED = Symbol('marketplace.inventory.skipped');
const MARKETPLACE_REQUEST_CLOSED = Symbol('marketplace.request.closed');

// Runs `job` with at most `maxInFlight` jobs active. A job resolves to its own result, or to MARKETPLACE_INVENTORY_SKIPPED when
// `isCancelled()` was true at the moment its turn came (it never starts). The job runs in the async context of the caller that enqueued it,
// not in the context of whichever job released the slot.
function createInventoryLimiter(maxInFlight = MARKETPLACE_INVENTORY_MAX_IN_FLIGHT) {
    let inFlight = 0;
    const queue = [];
    const drain = () => {
        while (inFlight < maxInFlight && queue.length) {
            const entry = queue.shift();
            if (entry.isCancelled()) {
                entry.resolve(MARKETPLACE_INVENTORY_SKIPPED);
                continue;
            }
            inFlight += 1;
            let running;
            try {
                running = Promise.resolve(entry.job());
            } catch (error) {
                running = Promise.reject(error);
            }
            running.then(entry.resolve, entry.reject).finally(() => {
                inFlight -= 1;
                drain();
            });
        }
    };
    return (job, { isCancelled = () => false } = {}) => new Promise((resolve, reject) => {
        queue.push({ job: AsyncResource.bind(job), isCancelled, resolve, reject });
        drain();
    });
}
const inventoryLimiter = createInventoryLimiter();

// "Closed" is the response's own close without a completed end: the request's close event can also fire once its body has been consumed.
function watchResponseClose(res) {
    let closed = false;
    const onClose = () => { if (!res.writableEnded) closed = true; };
    if (typeof res?.once === 'function') res.once('close', onClose);
    return {
        isClosed: () => closed || (!res?.writableEnded && (res?.closed === true || res?.destroyed === true)),
        stop: () => { if (typeof res?.removeListener === 'function') res.removeListener('close', onClose); },
    };
}

async function runPreparedRepositoryRead(res, build, { catalog = false } = {}) {
    const watch = watchResponseClose(res);
    const controller = new AbortController();
    const onClose = () => { if (watch.isClosed()) controller.abort(); };
    res.once?.('close', onClose);
    try {
        if (watch.isClosed()) return MARKETPLACE_REQUEST_CLOSED;
        return await runWithRepositoryResolutionScope(async () => {
            const roots = [PLOINKY_WORKSPACE_ROOT];
            // Skill catalog resolution uses the canonical spelling. Query both
            // exact spellings in one pool; neither identity substitutes for the other.
            if (catalog) roots.push(fs.realpathSync(PLOINKY_WORKSPACE_ROOT));
            await prefetchWorkspaceRepositoryOrigins(roots, { signal: controller.signal });
            if (watch.isClosed()) return MARKETPLACE_REQUEST_CLOSED;
            const result = await build();
            return watch.isClosed() ? MARKETPLACE_REQUEST_CLOSED : result;
        }, { signal: controller.signal });
    } catch (error) {
        if (watch.isClosed()) return MARKETPLACE_REQUEST_CLOSED;
        throw error;
    } finally {
        watch.stop();
        res.removeListener?.('close', onClose);
    }
}

const marketplaceEnableFlights = new Map();
let marketplaceEnableQueue = Promise.resolve();

function parseMarketplacePath(pathname = '') {
    const parts = String(pathname || '').split('/').filter(Boolean);
    if (parts.length < 2 || parts[0] !== 'api' || parts[1] !== 'marketplace') {
        return null;
    }
    if (parts.length > 3) return null;
    return {
        resource: parts[2] || ''
    };
}

function sendMarketplaceError(res, status, code, message = '', details = {}) {
    sendJson(res, status, {
        ok: false,
        error: code,
        ...(message ? { message } : {}),
        ...(details.cause ? { cause: details.cause } : {}),
    });
}

function safeLifecycleCause(error) {
    const code = String(error?.cause?.code || '');
    return SAFE_LIFECYCLE_ERRORS.has(code) ? { code } : null;
}

function sendLifecycleError(res, error) {
    // A hardware refusal (422) or dependency block (424) carries its bounded
    // typed outcome; no stack, body or environment is returned.
    const hardwareOutcome = findHardwareOutcome(error);
    if (hardwareOutcome) {
        sendJson(res, hardwareOutcome.state === 'blocked' ? 424 : 422, {
            ok: false,
            error: hardwareOutcome.code,
            message: formatHardwareOutcome(hardwareOutcome),
            hardwareOutcome,
        });
        return true;
    }
    const code = String(error?.code || '');
    const contract = SAFE_LIFECYCLE_ERRORS.get(code);
    if (!contract) return false;
    sendMarketplaceError(res, contract.status, code, contract.message, {
        cause: safeLifecycleCause(error),
    });
    return true;
}

function readAuthorizationBearer(req) {
    const raw = req?.headers?.authorization ?? req?.headers?.Authorization;
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value !== 'string' || !value.toLowerCase().startsWith('bearer ')) return '';
    return value.slice(7).trim();
}

function readMarketplaceBody(req, { maxBytes = 1024 * 1024 } = {}) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let bytes = 0;
        let tooLarge = false;
        req.on('data', (chunk) => {
            bytes += chunk.length;
            if (bytes > maxBytes) {
                tooLarge = true;
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            try {
                if (tooLarge) {
                    reject(new Error('request_body_too_large'));
                    return;
                }
                const rawBody = Buffer.concat(chunks);
                const text = rawBody.toString('utf8');
                resolve({ rawBody, body: text ? JSON.parse(text) : {} });
            } catch (error) {
                reject(error);
            }
        });
        req.on('error', reject);
    });
}

function verifyMarketplaceAgentRequest({ req, method, query = '', tool, requestPath = MARKETPLACE_PATH, rawBody = Buffer.alloc(0), replayCache = marketplaceAssertionReplayCache }) {
    const token = readAuthorizationBearer(req);
    if (!token) throw new Error('missing_agent_assertion');
    const rch = computeRchHttp({
        method,
        path: requestPath,
        query,
        bodyHash: sha256RawBodyHash(rawBody),
    });
    return verifyAgentAssertion({
        token,
        method,
        path: requestPath,
        tool,
        rch,
        targetAgentId: MARKETPLACE_AGENT_TARGET,
        replayCache,
    });
}

// Set only by a successful assertion verification; a Bearer header alone never qualifies.
function verifiedAgentCaller(req) {
    return Boolean(req?.marketplaceAgent);
}

function hasUserDelegation(req) {
    const raw = req?.headers?.['x-ploinky-user-delegation'];
    return (Array.isArray(raw) ? raw : [raw]).some(value => value !== undefined && value !== null && String(value).trim() !== '');
}

function ensureMarketplaceAgentRequest(req, res, details) {
    let verified;
    try {
        verified = verifyMarketplaceAgentRequest({ req, ...details });
    } catch (_) {
        sendMarketplaceError(res, 401, 'agent_assertion_rejected', 'Agent authentication failed.');
        return false;
    }
    // Marketplace defines no delegated-user projection: an explicitly delegated
    // request is refused rather than served as a machine request, and its
    // unverified delegation data is never read as roles.
    if (hasUserDelegation(req)) {
        sendMarketplaceError(res, 403, 'user_delegation_unsupported', 'Delegated user context is not supported for Marketplace requests.');
        return false;
    }
    req.marketplaceAgent = verified;
    return true;
}

function normalizeMarketplaceRepoName(value) {
    const name = String(value || '').trim();
    if (!name || !/^[a-zA-Z0-9_.-]+$/.test(name)) {
        throw new Error('invalid_repository_name');
    }
    return name;
}

function normalizeOptionalMarketplaceRepoName(value) {
    const name = String(value || '').trim();
    return name ? normalizeMarketplaceRepoName(name) : null;
}

function normalizeMarketplaceUrl(value) {
    const url = String(value || '').trim();
    if (!url) throw new Error('missing_repository_url');
    if (/[\r\n]/.test(url)) throw new Error('invalid_repository_url');
    return url;
}

function normalizeMarketplaceAgentRef(value) {
    const ref = String(value || '').trim();
    const parts = ref.split('/').filter(Boolean);
    if (parts.length !== 2 || parts.some(part => !/^[a-zA-Z0-9_.-]+$/.test(part))) {
        throw new Error('invalid_agent_ref');
    }
    return `${parts[0]}/${parts[1]}`;
}

// An empty mode lets enableAgent apply the manifest's default enable mode.
function normalizeMarketplaceEnableMode(value) {
    const mode = String(value || '').trim().toLowerCase();
    if (!mode || mode === 'default') return '';
    if (!agentsSvc.isEnableAgentMode(mode)) {
        throw new Error('invalid_enable_mode');
    }
    return mode;
}

function enqueueMarketplaceEnable(agentRef, mode, runEnableWorker) {
    const key = `${agentRef}\u0000${mode}`;
    const existing = marketplaceEnableFlights.get(key);
    if (existing) return existing;

    const scheduled = marketplaceEnableQueue.then(() => runEnableWorker({ agentRef, mode }));
    marketplaceEnableQueue = scheduled.catch(() => {});
    const tracked = scheduled.finally(() => {
        if (marketplaceEnableFlights.get(key) === tracked) marketplaceEnableFlights.delete(key);
    });
    marketplaceEnableFlights.set(key, tracked);
    return tracked;
}

export async function enableMarketplaceAgent(body, {
    enable,
    runEnableWorker = runMarketplaceEnableWorker,
    beforeEnable = () => {},
} = {}) {
    const ref = normalizeMarketplaceAgentRef(body?.agentRef);
    const mode = normalizeMarketplaceEnableMode(body?.mode || body?.enableMode);
    const repoName = ref.split('/')[0];
    const result = typeof enable === 'function'
        ? await enable(ref, mode || undefined, mode === 'devel' ? repoName : undefined)
        : await enqueueMarketplaceEnable(ref, mode, async (options) => {
            beforeEnable();
            return runEnableWorker(options);
        });
    return { ref, mode, result };
}

// A repository uninstall is one workspace mutation under a lease this request
// acquires itself; see uninstallRepositoryUnderLease for the ordering.
export async function uninstallMarketplaceRepository(body, {
    workspaceLeaseWaitMs,
    agentDisableDependencies = {},
} = {}) {
    const target = String(body?.target || body?.name || '').trim();
    return uninstallRepositoryUnderLease(target, {
        withLease: withWorkspaceMutationLease,
        workspaceLeaseWaitMs,
        agentDisableDependencies,
        stdio: 'pipe',
    });
}

function normalizeMarketplaceContainerSegment(value) {
    return String(value || '').replace(/[^a-zA-Z0-9_.-]/g, '_');
}

function marketplaceContainerMatchesAgent(containerName, repoName, agentName) {
    const prefix = `ploinky_${normalizeMarketplaceContainerSegment(repoName)}_${normalizeMarketplaceContainerSegment(agentName)}_`;
    return String(containerName || '').startsWith(prefix);
}

function collectMarketplaceNoWaitStates(registry, {
    readRunMarker = readNoWaitRunMarker,
    createRunBinding = createNoWaitRunBinding,
    observeRun = observeBoundNoWaitRun,
    summarizeFailure = summarizeNoWaitFailure,
    readRegistrySnapshot = readAgentRegistrySnapshot,
    observeRecord = observeNoWaitAgentRecord,
    mapObservation = mapNoWaitObservationForMarketplace,
} = {}) {
    const states = new Map();
    for (const [containerName, record] of Object.entries(registry || {})) {
        if (!record || record.type !== 'agent') continue;
        try {
            const observation = observeRecord(containerName, record, {
                readRunMarker,
                createRunBinding,
                observeRun,
                readRegistrySnapshot,
            });
            const mapped = mapObservation(observation, { summarizeFailure });
            if (mapped) states.set(containerName, mapped);
        } catch (error) {
            if (error?.code === 'NO_WAIT_RUN_SUPERSEDED') continue;
            if (error?.code === 'NO_WAIT_OBSERVATION_STALE') {
                states.set(containerName, {
                    status: 'failed',
                    detail: 'Background startup expired before reaching a terminal state.',
                });
                continue;
            }
            states.set(containerName, {
                status: 'unknown',
                detail: 'Background startup state could not be verified.',
            });
        }
    }
    return states;
}

function normalizeMarketplaceAgentStatus({ active, runtimeState, noWaitState } = {}) {
    if (!active) return { status: 'disabled', detail: '' };
    if (runtimeState?.running === true) return { status: 'running', detail: '' };

    const noWaitStatus = String(noWaitState?.status || '').trim().toLowerCase();
    if (['starting', 'failed', 'unknown'].includes(noWaitStatus)) {
        return {
            status: noWaitStatus,
            detail: String(noWaitState?.detail || '').trim(),
        };
    }

    const runtimeStatus = String(runtimeState?.status || '').trim().toLowerCase();
    if (['created', 'configured', 'restarting', 'starting'].includes(runtimeStatus)) {
        return { status: 'starting', detail: '' };
    }
    if (runtimeStatus === 'dead' || runtimeStatus === 'failed') {
        return { status: 'failed', detail: '' };
    }
    if (runtimeStatus === 'paused') {
        return { status: 'paused', detail: '' };
    }
    if (!runtimeStatus || ['exited', 'removing', 'stopped'].includes(runtimeStatus)) {
        return { status: 'stopped', detail: '' };
    }
    return { status: 'unknown', detail: '' };
}

// Listing stays available when a manifest is unreadable or declares invalid
// modes; enabling that agent reports the manifest error instead.
function readMarketplaceEnableModes(manifestPath) {
    try {
        return agentsSvc.resolveManifestEnableModes(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
    } catch {
        return { modes: [...agentsSvc.ENABLE_AGENT_MODES], defaultMode: agentsSvc.DEFAULT_ENABLE_AGENT_MODE };
    }
}

function enabledMarketplaceAgents(agentsRegistry) {
    return Object.entries(agentsRegistry)
        .filter(([, record]) => record && record.type === 'agent')
        .map(([containerName, record]) => ({
            repoName: String(record.repoName || ''),
            agentName: String(record.agentName || ''),
            containerName: String(containerName || ''),
            alias: String(record.alias || ''),
            runMode: String(record.runMode || agentsSvc.DEFAULT_ENABLE_AGENT_MODE),
            runtime: String(record.runtime || 'container')
        }));
}

// Local filesystem locations are visible to genuine administrators (Ploinky's
// role-based, guest-rejecting predicate) and to bound agent-assertion callers,
// which are machine principals with no user session. Every other caller,
// including a missing user, receives the path-free projection.
function mayViewLocalPaths({ user = null, machine = false } = {}) {
    return machine === true || isAdminUser(user);
}

function buildMarketplaceRepositories({ registry, user = null, machine = false } = {}) {
    const predefined = reposSvc.getPredefinedRepos();
    const sources = reposSvc.getRepoSources();
    const installed = new Set(listAgentRepositoryNames());
    const agentsRegistry = registry || workspaceSvc.loadAgents();
    const activeAgentsByRepo = new Map();
    for (const record of enabledMarketplaceAgents(agentsRegistry)) {
        const repoName = record.repoName;
        if (!repoName) continue;
        activeAgentsByRepo.set(repoName, (activeAgentsByRepo.get(repoName) || 0) + 1);
    }
    const skillRepos = new Map(reposSvc.getSkillRepositoryRecommendations().map(repo => [repo.name, repo]));
    const bootRepos = new Set(reposSvc.getDefaultBootRepos().map(repo => repo.name));
    const commonRepositories = new Map(reposSvc.listRepositorySources().map(repo => [repo.name, repo]));
    const repoNames = new Set([...commonRepositories.keys(), ...Object.keys(predefined), ...Object.keys(sources), ...installed, ...listAgentRepositoryNames(), ...skillRepos.keys()]);
    const repositories = [...repoNames].sort((left, right) => left.localeCompare(right)).map((name) => {
        const predefinedEntry = predefined[name] || {};
        const sourceEntry = sources[name] || {};
        const kind = skillRepos.get(name)?.kind || predefinedEntry.kind || sourceEntry.kind || reposSvc.classifyRepoKind(name);
        const url = predefinedEntry.url || sourceEntry.url || skillRepos.get(name)?.url || '';
        const localPath = workspaceAgentRepositoryPath(name);
        // Expose a workspace-relative label for the checkout, never an assumed
        // runtime mount prefix or the physical host path.
        const workspacePath = localPath ? `./${path.basename(localPath)}` : '';
        return {
            name,
            displayName: workspacePath || name,
            workspacePath,
            repositorySource: commonRepositories.get(name) || null,
            url,
            description: predefinedEntry.description || '',
            kind,
            ...(['skills', 'mixed'].includes(kind) ? { skillSource: resolveSkillRepositorySource(name, url), warnings: skillRepos.get(name)?.warnings || [] } : {}),
            installed: installed.has(name),
            default: bootRepos.has(name),
            branch: sourceEntry.branch || '',
            activeAgentsCount: activeAgentsByRepo.get(name) || 0
        };
    });
    return { repositories: mayViewLocalPaths({ user, machine }) ? repositories : repositories.map(projectMarketplaceRepository) };
}

function buildMarketplaceAgents(user = null, options = {}) {
    const agentsRegistry = options.registry || workspaceSvc.loadAgents();
    const enabledAgents = enabledMarketplaceAgents(agentsRegistry);
    const enabledKeys = new Set(enabledAgents.map(record => `${record.repoName}/${record.agentName}`));
    const enabledByContainer = new Map(enabledAgents.map(record => [record.containerName, record]));
    const enabledByRef = new Map(enabledAgents.map(record => [`${record.repoName}/${record.agentName}`, record]));
    const runtimeEntries = Object.hasOwn(options, 'runtimeEntries')
        ? (options.runtimeEntries || [])
        : collectAgentRuntimeStates({ registry: agentsRegistry, ...(Object.hasOwn(options, 'liveContainers') ? { liveContainers: options.liveContainers } : {}) });
    const noWaitStates = Object.hasOwn(options, 'noWaitStates')
        ? (options.noWaitStates || new Map())
        : collectMarketplaceNoWaitStates(agentsRegistry);
    const summaries = Object.hasOwn(options, 'summaries')
        ? (options.summaries || [])
        : collectAgentsSummary({ includeInactive: true });
    const agents = [];
    for (const repo of summaries) {
        for (const agent of repo.agents || []) {
            const ref = `${agent.repo}/${agent.name}`;
            const runtimeEntry = runtimeEntries.find((entry) => {
                const containerName = String(entry?.containerName || '');
                const registryRecord = enabledByContainer.get(containerName);
                if (registryRecord && `${registryRecord.repoName}/${registryRecord.agentName}` === ref) return true;
                if (`${entry?.repoName || ''}/${entry?.agentName || ''}` === ref) return true;
                return marketplaceContainerMatchesAgent(containerName, agent.repo, agent.name);
            });
            const runtimeState = runtimeEntry ? {
                backend: String(runtimeEntry?.runtime || '').trim().toLowerCase() || 'container',
                status: String(runtimeEntry?.state?.status || '').trim().toLowerCase() || 'unknown',
                running: Boolean(runtimeEntry?.state?.running),
                pid: runtimeEntry?.state?.pid || null,
                containerName: String(runtimeEntry?.containerName || '')
            } : null;
            const active = enabledKeys.has(ref);
            const enabledRecord = enabledByRef.get(ref) || null;
            const noWaitState = enabledRecord
                ? (noWaitStates instanceof Map
                    ? noWaitStates.get(enabledRecord.containerName)
                    : noWaitStates[enabledRecord.containerName])
                : null;
            const lifecycle = normalizeMarketplaceAgentStatus({ active, runtimeState, noWaitState });
            const enableModes = readMarketplaceEnableModes(agent.manifestPath);
            agents.push({
                ref,
                repo: agent.repo,
                name: agent.name,
                about: agent.about === '-' ? '' : (agent.about || ''),
                active,
                enableMode: enabledRecord?.runMode || enableModes.defaultMode,
                enableModes: enableModes.modes,
                runtime: runtimeState?.backend || enabledRecord?.runtime || '',
                status: lifecycle.status,
                ...(lifecycle.detail ? { statusDetail: lifecycle.detail } : {}),
                running: runtimeState?.running || false,
                pid: runtimeState?.pid || null,
                containerName: runtimeState?.containerName || enabledRecord?.containerName || '',
                manifestPath: agent.manifestPath || ''
            });
        }
    }
    return {
        user: user ? {
            id: String(user.id || ''),
            username: String(user.username || user.name || ''),
            roles: Array.isArray(user.roles) ? [...user.roles] : []
        } : null,
        permissions: {
            canManage: isAdminUser(user)
        },
        agents: agents.sort((left, right) => left.ref.localeCompare(right.ref))
            .map(agent => (mayViewLocalPaths({ user, machine: options.machine }) ? agent : projectMarketplaceAgent(agent))),
        enabledAgents
    };
}

// Combined view retained for internal tests; no HTTP route exposes it.
function buildMarketplaceState(user = null, options = {}) {
    const registry = options.registry || workspaceSvc.loadAgents();
    return { ...buildMarketplaceAgents(user, { ...options, registry }), ...buildMarketplaceRepositories({ registry, user, machine: options.machine }) };
}

function publicMarketplaceAuthContext(routePlan) {
    const routeKey = String(routePlan?.hostSelection?.record?.routeKey || '').trim();
    const snapshot = routePlan?.snapshot || routePlan?.lease?.snapshot;
    if (routePlan?.ok !== true || routePlan.kind !== 'router-surface'
        || routePlan.surface !== 'marketplace-ui' || routePlan.listener !== 'public'
        || routePlan.hostSelection?.kind !== 'agent-root' || !routeKey
        || !snapshot || typeof routePlan.lease?.commit !== 'function') return null;
    const context = resolveAuthContextForRouteKey(routeKey, { snapshot });
    if (context.mode !== 'sso') return null;
    return { ...context, boundHostRouteKey: routeKey, mutationRouteKey: `marketplace:${routeKey}` };
}

async function ensureMarketplaceAdmin(req, res, parsedUrl, { routePlan = null } = {}) {
    const authResult = await ensureMarketplaceUser(req, res, { routePlan });
    if (!authResult.ok) return false;
    if (!isAdminUser(req.user)) {
        sendMarketplaceError(res, 403, 'admin_required', 'Administrator access is required.');
        return false;
    }
    return true;
}

async function ensureMarketplaceUser(req, res, { routePlan = null } = {}) {
    const cookies = parseCookies(req);
    const localSessionId = cookies.get(LOCAL_AUTH_COOKIE_NAME);
    if (routePlan?.hostSelection?.kind === 'agent-root') {
        const context = publicMarketplaceAuthContext(routePlan);
        const ssoSessionId = cookies.get(SSO_AUTH_COOKIE_NAME);
        const session = context && ssoSessionId && authService.isConfigured()
            ? await authService.validateSession(ssoSessionId) : null;
        if (!session?.user || (session.expiresAt && Date.now() > session.expiresAt)) {
            sendMarketplaceError(res, 401, 'not_authenticated', 'Authentication is required for this workspace.');
            return { ok: false };
        }
        req.user = session.user;
        req.session = session;
        req.sessionId = ssoSessionId;
        req.authMode = 'sso';
        return { ok: true, session };
    }
    if (localSessionId) {
        const session = await sessionTokenService.getUserSession(localSessionId);
        if (session?.user && localSessionAllowedForRoutePlan(session, routePlan)) {
            req.user = session.user;
            req.session = session;
            req.sessionId = localSessionId;
            req.authMode = 'local';
            return { ok: true, session };
        }
    }

    const ssoSessionId = cookies.get(SSO_AUTH_COOKIE_NAME);
    if (ssoSessionId && authService.isConfigured()) {
        const session = await authService.validateSession(ssoSessionId);
        if (session?.user && (!session.expiresAt || Date.now() <= session.expiresAt)) {
            req.user = session.user;
            req.session = session;
            req.sessionId = ssoSessionId;
            req.authMode = 'sso';
            return { ok: true, session };
        }
    }

    sendMarketplaceError(res, 401, 'not_authenticated', 'Authentication is required.');
    return { ok: false };
}

export async function handleMarketplaceRoutes(req, res, parsedUrl, {
    routePlan = null,
    ensureAdmin = ensureMarketplaceAdmin,
    enableAgentAction = (body) => enableMarketplaceAgent(body, {
        beforeEnable: () => {
            if (routePlan?.lease?.commit && routePlan.lease.commit() !== true) {
                const error = new Error('The routing generation changed before agent activation.');
                error.code = 'EDGE_GENERATION_CHANGED';
                throw error;
            }
        },
    }),
    disableAgentAction = (ref) => agentsSvc.disableAgent(ref),
    agentListOptions = {}, // a test's listing observes its own live containers
    collectContainers = collectLiveAgentContainersAsync,
    uninstallRepositoryAction = (body) => uninstallMarketplaceRepository(body),
    repositoryWorker = runMarketplaceRepositoryWorker,
    repositoryWorkerEligibility = repositoryWorkerEligible,
} = {}) {
    const route = parseMarketplacePath(parsedUrl.pathname || '/');
    if (!route) return false;
    const receivedAt = Date.now();
    const routerElapsedMs = Math.floor(process.uptime() * 1_000);

    if (routePlan?.lease?.commit && routePlan.lease.commit() !== true) {
        sendMarketplaceError(res, 503, 'edge_generation_changed');
        return true;
    }

    const method = (req.method || 'GET').toUpperCase();

    if (route.resource === 'hardware-limits') {
        return handleHardwareLimitsRoutes(req, res, parsedUrl, {
            ensureAdmin: (request, response, url) => ensureAdmin(request, response, url, { routePlan }),
            verifyMutation: (request) => {
                const publicContext = publicMarketplaceAuthContext(routePlan);
                return publicContext
                    ? verifyBrowserMutationRequest(request, { routePlan, authContext: publicContext, sessionId: request.sessionId })
                    : verifyAdminMutationRequest(request, request.sessionId);
            },
            verifyLease: () => !routePlan?.lease?.commit || routePlan.lease.commit() === true,
            readSelection: readEdgeRoutingSelection,
            runReadScope: build => runPreparedRepositoryRead(res, build),
        });
    }

    const authorizeRead = async () => {
        if (readAuthorizationBearer(req)) {
            return ensureMarketplaceAgentRequest(req, res, {
                method: 'GET',
                query: parsedUrl.search ? parsedUrl.search.slice(1) : '',
                tool: MARKETPLACE_READ_TOOL,
                requestPath: parsedUrl.pathname,
            });
        }
        const authResult = await ensureMarketplaceUser(req, res, { routePlan });
        return authResult.ok;
    };
    // Resolves to MARKETPLACE_REQUEST_CLOSED when the client went away while the inventory waited for a slot: nothing is built or sent then.
    const agentsMarketplace = async () => {
        let options = agentListOptions;
        if (!Object.hasOwn(agentListOptions, 'runtimeEntries') && !Object.hasOwn(agentListOptions, 'liveContainers')) {
            const watch = watchResponseClose(res);
            let liveContainers;
            try {
                liveContainers = await inventoryLimiter(async () => {
                    try {
                        return (await collectContainers()) || [];
                    } catch (error) {
                        debugLog(`marketplace agent inventory: ${error?.message || error}`);
                        return [];
                    }
                }, { isCancelled: watch.isClosed });
            } finally {
                watch.stop();
            }
            if (liveContainers === MARKETPLACE_INVENTORY_SKIPPED || watch.isClosed()) return MARKETPLACE_REQUEST_CLOSED;
            options = { ...agentListOptions, liveContainers };
        }
        // Agent-assertion callers are machine principals; every session caller is judged by role.
        options = { ...options, machine: verifiedAgentCaller(req) };
        return {
            ...buildMarketplaceAgents(req.user, options),
            permissions: {
                canManage: isAdminUser(req.user)
                    && Boolean(publicMarketplaceAuthContext(routePlan) || canonicalControlOrigin(req)),
            },
        };
    };

    // Raw repository source listing for the repository client.
    if (route.resource === 'list-repos') {
        if (method !== 'GET') {
            res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'GET' });
            res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }));
            return true;
        }
        if (!await authorizeRead()) return true;
        const repositories = await runPreparedRepositoryRead(res, () => reposSvc.listRepositorySources(), { catalog: true });
        if (repositories === MARKETPLACE_REQUEST_CLOSED) return true;
        const visible = mayViewLocalPaths({ user: req.user, machine: verifiedAgentCaller(req) })
            ? repositories : repositories.map(projectRepositorySource);
        sendJson(res, 200, { ok: true, repositories: visible });
        return true;
    }

    if (route.resource !== 'repos' && route.resource !== 'agents') {
        sendMarketplaceError(res, 404, 'not_found', 'Marketplace resource not found.');
        return true;
    }

    const isRepos = route.resource === 'repos';
    const marketplacePayload = async () => runPreparedRepositoryRead(res, () => (isRepos ? buildMarketplaceRepositories({ user: req.user, machine: verifiedAgentCaller(req) }) : agentsMarketplace()), { catalog: isRepos });

    if (method === 'GET') {
        if (!await authorizeRead()) return true;
        const marketplace = await marketplacePayload();
        if (marketplace === MARKETPLACE_REQUEST_CLOSED) return true;
        sendJson(res, 200, { ok: true, marketplace });
        return true;
    }

    if (method === 'POST') {
        const agentRequest = Boolean(readAuthorizationBearer(req));
        if (!agentRequest) {
            if (!(await ensureAdmin(req, res, parsedUrl, { routePlan }))) {
                return true;
            }
            const publicContext = publicMarketplaceAuthContext(routePlan);
            const mutationDecision = publicContext
                ? verifyBrowserMutationRequest(req, { routePlan, authContext: publicContext, sessionId: req.sessionId })
                : verifyAdminMutationRequest(req, req.sessionId);
            if (!mutationDecision.ok) {
                sendMarketplaceError(res, 403, mutationDecision.code.toLowerCase(), 'Exact control Origin and CSRF proof are required.');
                return true;
            }
        }

        let rawBody;
        let body;
        try {
            ({ rawBody, body } = await readMarketplaceBody(req));
        } catch (_) {
            sendMarketplaceError(res, 400, 'invalid_json', 'Request body must be valid JSON.');
            return true;
        }
        if (routePlan?.lease?.commit && routePlan.lease.commit() !== true) {
            sendMarketplaceError(res, 503, 'edge_generation_changed');
            return true;
        }

        const action = String(body?.action || '').trim();
        const repoActions = ['install', 'remove', 'install_repo', 'uninstall_repo'];
        const agentActions = ['enable_agent', 'disable_agent'];
        const allowedActions = isRepos ? repoActions : agentActions;
        if (!allowedActions.includes(action)) {
            sendMarketplaceError(res, 400, 'unknown_action', 'Unsupported marketplace action.');
            return true;
        }
        if (agentRequest) {
            const agentAllowed = isRepos ? ['install', 'remove', 'install_repo'] : ['enable_agent'];
            if (!agentAllowed.includes(action)) {
                sendMarketplaceError(res, 403, 'agent_action_forbidden', 'Unsupported agent repository action.');
                return true;
            }
            if (!ensureMarketplaceAgentRequest(req, res, {
                method: 'POST',
                query: parsedUrl.search ? parsedUrl.search.slice(1) : '',
                tool: action === 'enable_agent' ? MARKETPLACE_ENABLE_TOOL : action === 'install_repo' ? 'repositories.prepare' : `repositories.${action}`,
                requestPath: parsedUrl.pathname,
                rawBody,
            })) return true;
        }

        let mutationWatch;
        try {
            let result;
            if (action === 'install') {
                result = await withWorkspaceMutationLease({ operation: 'repositories-install' }, () => {
                    const repositories = new Map(reposSvc.listRepositorySources().filter(repo => repo.origin !== 'remote').map(repo => [repo.name, repo]));
                    return installRepositoryLinks(body, { resolveRepository: name => repositories.get(name) });
                });
            } else if (action === 'remove') {
                result = await withWorkspaceMutationLease({ operation: 'repositories-remove' }, () => removeRepositoryLinks(body?.paths));
            } else if (action === 'install_repo' || action === 'uninstall_repo') {
                const operation = action === 'install_repo'
                    ? { action, url: normalizeMarketplaceUrl(body?.url), name: normalizeOptionalMarketplaceRepoName(body?.name),
                        branch: String(body?.branch || '').trim() || null }
                    : { action, target: String(body?.target || body?.name || '').trim() };
                if (repositoryWorkerEligibility()) {
                    mutationWatch = watchResponseClose(res);
                    if (mutationWatch.isClosed()) return true;
                    const rawBodyBytes = rawBody.byteLength;
                    rawBody = undefined;
                    body = undefined;
                    const originalLease = routePlan?.lease;
                    result = await repositoryWorker({ operation, rawBodyBytes, cwd: process.cwd(),
                        workspaceRoot: PLOINKY_WORKSPACE_ROOT, response: res,
                        diagnosticContext: {
                            caller: agentRequest ? 'agent-assertion' : publicMarketplaceAuthContext(routePlan) ? 'browser-public' : 'browser-control',
                            routeLease: Boolean(originalLease), receivedAt, routerElapsedMs,
                            graphReadiness: 'unavailable',
                            ...(diagnosticIdentity(originalLease?.id) ? { generation: diagnosticIdentity(originalLease.id) } : {}),
                        },
                        authorize: () => !originalLease?.commit || originalLease.commit() === true });
                } else if (action === 'install_repo') {
                    result = await withWorkspaceMutationLease({ operation: 'repositories-prepare' }, () => (
                        reposSvc.installRepo(operation.url, operation.name, operation.branch, { stdio: 'pipe' })
                    ));
                } else result = await uninstallRepositoryAction(body);
            } else if (action === 'enable_agent') {
                ({ result } = await enableAgentAction(body));
            } else if (action === 'disable_agent') {
                const ref = normalizeMarketplaceAgentRef(body?.agentRef);
                result = await disableAgentAction(ref);
                if (result?.status && result.status !== 'removed' && result.status !== 'static-removed') {
                    sendMarketplaceError(res, 409, 'agent_disable_blocked', result.status);
                    return true;
                }
            }
            if (mutationWatch?.isClosed()) return true;
            const marketplace = await marketplacePayload();
            if (marketplace === MARKETPLACE_REQUEST_CLOSED) return true;
            sendJson(res, 200, { ok: true, action, result, marketplace });
            return true;
        } catch (error) {
            if (mutationWatch?.isClosed()) return true;
            if (error?.code === 'marketplace_repository_busy') {
                sendMarketplaceError(res, 429, 'marketplace_repository_busy', 'Repository operation queue is full. Retry later.');
                return true;
            }
            if (sendLifecycleError(res, error)) return true;
            sendMarketplaceError(res, 400, 'marketplace_action_failed', error?.message || 'Marketplace action failed.');
            return true;
        } finally {
            mutationWatch?.stop();
        }
    }

    res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'GET, POST' });
    res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }));
    return true;
}
export const __testables = {
    createInventoryLimiter,
    MARKETPLACE_INVENTORY_SKIPPED,
    buildMarketplaceState,
    collectMarketplaceNoWaitStates,
    normalizeMarketplaceAgentStatus,
    readAuthorizationBearer,
    sendLifecycleError,
    verifyMarketplaceAgentRequest,
};
