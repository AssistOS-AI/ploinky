import path from 'path';

import { PLOINKY_DIR } from '../../utils/config.js';
import * as reposSvc from '../../utils/repos.js';
import * as agentsSvc from '../../utils/agents.js';
import * as workspaceSvc from '../../utils/workspace.js';
import { collectAgentRuntimeStates } from '../../sandbox/agentRuntimeState.js';
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
import { isLocalAdminUser } from '../auth/localService.js';
import { verifyAdminMutationRequest } from '../adminControlSecurity.js';
import { computeRchHttp, sha256RawBodyHash } from '../../../Agent/lib/requestHash.mjs';
import { verifyAgentAssertion } from '../mcp-proxy/invocationMinter.js';
import { createTokenReplayCache } from '../security/tokens/JwsCodec.js';
import { runMarketplaceEnableWorker } from '../marketplaceEnableWorker.js';
import { authService, LOCAL_AUTH_COOKIE_NAME, parseCookies, sendJson, sessionTokenService, SSO_AUTH_COOKIE_NAME } from './shared.js';

export const MARKETPLACE_PATH = '/api/marketplace';
export const MARKETPLACE_AGENT_TARGET = 'ploinky-router';
export const MARKETPLACE_READ_TOOL = 'marketplace.read';
export const MARKETPLACE_ENABLE_TOOL = 'marketplace.enable_agent';
const marketplaceAssertionReplayCache = createTokenReplayCache({ maxSize: 4096 });

const SAFE_LIFECYCLE_ERRORS = new Map([
    ['PLOINKY_BOX_RUNTIME_CAPABILITY_UNSUPPORTED', { status: 422, message: 'The requested runtime capability is unavailable in Ploinky Box.' }],
    ['PLOINKY_MANIFEST_SECURITY_INVALID', { status: 422, message: 'The agent manifest contains invalid runtime security settings.' }],
    ['PLOINKY_MANIFEST_SECURITY_PROFILE_UNSUPPORTED', { status: 422, message: 'Runtime security settings are only supported at the manifest root.' }],
    ['PLOINKY_BOX_MARKER_INVALID', { status: 409, message: 'The Ploinky Box identity marker is invalid.' }],
    ['PLOINKY_RUNTIME_INPUT_CHANGED', { status: 409, message: 'The admitted runtime input changed before launch.' }],
    ['PLOINKY_BWRAP_CAPABILITY_UNAVAILABLE', { status: 422, message: 'The required Bubblewrap capability is unavailable.' }],
    ['PLOINKY_OPEN_INTERPRETER_BOX_UNAVAILABLE', { status: 422, message: 'Open Interpreter is unavailable in this Ploinky Box.' }],
    ['PLOINKY_MARKETPLACE_ENABLE_TIMEOUT', { status: 504, message: 'Agent activation timed out.' }],
]);
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

function verifyMarketplaceAgentRequest({ req, method, query = '', tool, rawBody = Buffer.alloc(0), replayCache = marketplaceAssertionReplayCache }) {
    const token = readAuthorizationBearer(req);
    if (!token) throw new Error('missing_agent_assertion');
    const rch = computeRchHttp({
        method,
        path: MARKETPLACE_PATH,
        query,
        bodyHash: sha256RawBodyHash(rawBody),
    });
    return verifyAgentAssertion({
        token,
        method,
        path: MARKETPLACE_PATH,
        tool,
        rch,
        targetAgentId: MARKETPLACE_AGENT_TARGET,
        replayCache,
    });
}

function ensureMarketplaceAgentRequest(req, res, details) {
    try {
        req.marketplaceAgent = verifyMarketplaceAgentRequest({ req, ...details });
        return true;
    } catch (_) {
        sendMarketplaceError(res, 401, 'agent_assertion_rejected', 'Agent authentication failed.');
        return false;
    }
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

function normalizeMarketplaceEnableMode(value) {
    const mode = String(value || agentsSvc.DEFAULT_ENABLE_AGENT_MODE).trim().toLowerCase();
    if (!mode || mode === 'default') return agentsSvc.DEFAULT_ENABLE_AGENT_MODE;
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
} = {}) {
    const ref = normalizeMarketplaceAgentRef(body?.agentRef);
    const mode = normalizeMarketplaceEnableMode(body?.mode || body?.enableMode);
    const repoName = ref.split('/')[0];
    const result = typeof enable === 'function'
        ? await enable(ref, mode === 'isolated' ? undefined : mode, mode === 'devel' ? repoName : undefined)
        : await enqueueMarketplaceEnable(ref, mode, runEnableWorker);
    return { ref, mode, result };
}

function disableMarketplaceAgentsForRepo(repoName) {
    const targetRepo = String(repoName || '').trim();
    if (!targetRepo) return [];
    const containerNames = Object.entries(workspaceSvc.loadAgents())
        .filter(([, record]) => record && record.type === 'agent' && record.repoName === targetRepo && record.agentName)
        .map(([containerName]) => containerName);
    return agentsSvc.disableAgentContainers(containerNames);
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

function buildMarketplaceState(user = null, options = {}) {
    const reposDir = path.join(PLOINKY_DIR, 'repos');
    const predefined = reposSvc.getPredefinedRepos();
    const sources = reposSvc.getRepoSources();
    const installed = new Set(reposSvc.getInstalledRepos(reposDir));
    const agentsRegistry = options.registry || workspaceSvc.loadAgents();
    const enabledAgents = Object.entries(agentsRegistry)
        .filter(([, record]) => record && record.type === 'agent')
        .map(([containerName, record]) => ({
            repoName: String(record.repoName || ''),
            agentName: String(record.agentName || ''),
            containerName: String(containerName || ''),
            alias: String(record.alias || ''),
            runMode: String(record.runMode || agentsSvc.DEFAULT_ENABLE_AGENT_MODE),
            runtime: String(record.runtime || 'container')
        }));
    const activeAgentsByRepo = new Map();
    for (const record of enabledAgents) {
        const repoName = record.repoName;
        if (!repoName) continue;
        activeAgentsByRepo.set(repoName, (activeAgentsByRepo.get(repoName) || 0) + 1);
    }
    const bootRepos = new Set(reposSvc.getDefaultBootRepos().map(repo => repo.name));
    const repoNames = new Set([...Object.keys(predefined), ...Object.keys(sources), ...installed]);
    const repositories = [...repoNames].sort((left, right) => left.localeCompare(right)).map((name) => {
        const predefinedEntry = predefined[name] || {};
        const sourceEntry = sources[name] || {};
        return {
            name,
            url: predefinedEntry.url || sourceEntry.url || '',
            description: predefinedEntry.description || '',
            kind: predefinedEntry.kind || sourceEntry.kind || reposSvc.classifyRepoKind(name),
            installed: installed.has(name),
            default: bootRepos.has(name),
            branch: sourceEntry.branch || '',
            activeAgentsCount: activeAgentsByRepo.get(name) || 0
        };
    });
    const enabledKeys = new Set(enabledAgents.map(record => `${record.repoName}/${record.agentName}`));
    const enabledByContainer = new Map(enabledAgents.map(record => [record.containerName, record]));
    const enabledByRef = new Map(enabledAgents.map(record => [`${record.repoName}/${record.agentName}`, record]));
    const runtimeEntries = Object.hasOwn(options, 'runtimeEntries')
        ? (options.runtimeEntries || [])
        : collectAgentRuntimeStates({ registry: agentsRegistry });
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
            agents.push({
                ref,
                repo: agent.repo,
                name: agent.name,
                about: agent.about === '-' ? '' : (agent.about || ''),
                active,
                enableMode: enabledRecord?.runMode || agentsSvc.DEFAULT_ENABLE_AGENT_MODE,
                enableModes: agentsSvc.ENABLE_AGENT_MODES,
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
            canManage: isLocalAdminUser(user)
        },
        repositories,
        agents: agents.sort((left, right) => left.ref.localeCompare(right.ref)),
        enabledAgents
    };
}

async function ensureMarketplaceAdmin(req, res, parsedUrl) {
    const authResult = await ensureMarketplaceUser(req, res);
    if (!authResult.ok) return false;
    if (!isLocalAdminUser(req.user)) {
        sendMarketplaceError(res, 403, 'admin_required', 'Administrator access is required.');
        return false;
    }
    return true;
}

async function ensureMarketplaceUser(req, res) {
    const cookies = parseCookies(req);
    const localSessionId = cookies.get(LOCAL_AUTH_COOKIE_NAME);
    if (localSessionId) {
        const session = await sessionTokenService.getUserSession(localSessionId);
        if (session?.user) {
            req.user = session.user;
            req.session = session;
            req.sessionId = localSessionId;
            req.authMode = 'local';
            return { ok: true, session };
        }
    }

    const ssoSessionId = cookies.get(SSO_AUTH_COOKIE_NAME);
    if (ssoSessionId && authService.isConfigured()) {
        const session = authService.getSession(ssoSessionId);
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
    enableAgentAction = enableMarketplaceAgent,
} = {}) {
    const route = parseMarketplacePath(parsedUrl.pathname || '/');
    if (!route) return false;

    const method = (req.method || 'GET').toUpperCase();
    if (method === 'GET' && !route.resource) {
        if (readAuthorizationBearer(req)) {
            if (!ensureMarketplaceAgentRequest(req, res, {
                method: 'GET',
                query: parsedUrl.search ? parsedUrl.search.slice(1) : '',
                tool: MARKETPLACE_READ_TOOL,
            })) return true;
        } else {
            const authResult = await ensureMarketplaceUser(req, res);
            if (!authResult.ok) return true;
        }
        sendJson(res, 200, {
            ok: true,
            marketplace: buildMarketplaceState(req.user)
        });
        return true;
    }

    if (method === 'POST' && !route.resource) {
        const agentRequest = Boolean(readAuthorizationBearer(req));
        if (!agentRequest) {
            if (!(await ensureAdmin(req, res, parsedUrl))) {
                return true;
            }
            const mutationDecision = verifyAdminMutationRequest(req, req.sessionId);
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
        if (agentRequest) {
            if (action !== 'enable_agent') {
                sendMarketplaceError(res, 403, 'agent_action_forbidden', 'Agents may only enable installed agents.');
                return true;
            }
            if (!ensureMarketplaceAgentRequest(req, res, {
                method: 'POST',
                query: parsedUrl.search ? parsedUrl.search.slice(1) : '',
                tool: MARKETPLACE_ENABLE_TOOL,
                rawBody,
            })) return true;
        }

        try {
            if (action === 'install_repo') {
                const url = normalizeMarketplaceUrl(body?.url);
                const name = normalizeOptionalMarketplaceRepoName(body?.name);
                const branch = String(body?.branch || '').trim() || null;
                const result = reposSvc.installRepo(url, name, branch, { stdio: 'pipe' });
                sendJson(res, 200, {
                    ok: true,
                    action,
                    result,
                    marketplace: buildMarketplaceState(req.user)
                });
                return true;
            }

            if (action === 'uninstall_repo') {
                const target = String(body?.target || body?.name || '').trim();
                const repoName = reposSvc.resolveInstalledRepoTarget(target);
                const disabledAgents = disableMarketplaceAgentsForRepo(repoName);
                const result = {
                    ...reposSvc.uninstallRepo(repoName, { stdio: 'pipe' }),
                    disabledAgents
                };
                sendJson(res, 200, {
                    ok: true,
                    action,
                    result,
                    marketplace: buildMarketplaceState(req.user)
                });
                return true;
            }

            if (action === 'enable_agent') {
                const { result } = await enableAgentAction(body);
                sendJson(res, 200, {
                    ok: true,
                    action,
                    result,
                    marketplace: buildMarketplaceState(req.user)
                });
                return true;
            }

            if (action === 'disable_agent') {
                const ref = normalizeMarketplaceAgentRef(body?.agentRef);
                const result = agentsSvc.disableAgent(ref);
                if (result?.status && result.status !== 'removed' && result.status !== 'static-removed') {
                    sendMarketplaceError(res, 409, 'agent_disable_blocked', result.status);
                    return true;
                }
                sendJson(res, 200, {
                    ok: true,
                    action,
                    result,
                    marketplace: buildMarketplaceState(req.user)
                });
                return true;
            }

            sendMarketplaceError(res, 400, 'unknown_action', 'Unsupported marketplace action.');
            return true;
        } catch (error) {
            if (sendLifecycleError(res, error)) return true;
            sendMarketplaceError(res, 400, 'marketplace_action_failed', error?.message || 'Marketplace action failed.');
            return true;
        }
    }

    const status = route.resource ? 404 : 405;
    res.writeHead(status, { 'Content-Type': 'application/json', Allow: 'GET, POST' });
    res.end(JSON.stringify({ ok: false, error: route.resource ? 'not_found' : 'method_not_allowed' }));
    return true;
}

export const __testables = {
    buildMarketplaceState,
    collectMarketplaceNoWaitStates,
    normalizeMarketplaceAgentStatus,
    readAuthorizationBearer,
    sendLifecycleError,
    verifyMarketplaceAgentRequest,
};
