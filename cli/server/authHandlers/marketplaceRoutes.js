import path from 'path';

import { PLOINKY_DIR } from '../../utils/config.js';
import * as reposSvc from '../../utils/repos.js';
import * as agentsSvc from '../../utils/agents.js';
import * as workspaceSvc from '../../utils/workspace.js';
import { collectAgentRuntimeStates } from '../../sandbox/agentRuntimeState.js';
import { collectAgentsSummary } from '../../utils/status.js';
import { isLocalAdminUser } from '../auth/localService.js';
import { computeRchHttp, sha256RawBodyHash } from '../../../Agent/lib/requestHash.mjs';
import { verifyAgentAssertion } from '../mcp-proxy/invocationMinter.js';
import { createTokenReplayCache } from '../security/tokens/JwsCodec.js';
import { authService, LOCAL_AUTH_COOKIE_NAME, parseCookies, sendJson, sessionTokenService, SSO_AUTH_COOKIE_NAME } from './shared.js';

export const MARKETPLACE_PATH = '/api/marketplace';
export const MARKETPLACE_AGENT_TARGET = 'ploinky-router';
export const MARKETPLACE_READ_TOOL = 'marketplace.read';
export const MARKETPLACE_ENABLE_TOOL = 'marketplace.enable_agent';
const marketplaceAssertionReplayCache = createTokenReplayCache({ maxSize: 4096 });

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

function sendMarketplaceError(res, status, code, message = '') {
    sendJson(res, status, {
        ok: false,
        error: code,
        ...(message ? { message } : {})
    });
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
            agents.push({
                ref,
                repo: agent.repo,
                name: agent.name,
                about: agent.about === '-' ? '' : (agent.about || ''),
                active,
                enableMode: enabledRecord?.runMode || agentsSvc.DEFAULT_ENABLE_AGENT_MODE,
                enableModes: agentsSvc.ENABLE_AGENT_MODES,
                runtime: runtimeState?.backend || enabledRecord?.runtime || '',
                status: runtimeState?.status || (active ? 'stopped' : 'inactive'),
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

export async function handleMarketplaceRoutes(req, res, parsedUrl) {
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
        let rawBody;
        let body;
        try {
            ({ rawBody, body } = await readMarketplaceBody(req));
        } catch (_) {
            sendMarketplaceError(res, 400, 'invalid_json', 'Request body must be valid JSON.');
            return true;
        }

        const action = String(body?.action || '').trim();
        if (readAuthorizationBearer(req)) {
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
        } else if (!(await ensureMarketplaceAdmin(req, res, parsedUrl))) {
            return true;
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
                const ref = normalizeMarketplaceAgentRef(body?.agentRef);
                const mode = normalizeMarketplaceEnableMode(body?.mode || body?.enableMode);
                const repoName = ref.split('/')[0];
                const result = agentsSvc.enableAgent(ref, mode === 'isolated' ? undefined : mode, mode === 'devel' ? repoName : undefined);
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
    readAuthorizationBearer,
    verifyMarketplaceAgentRequest,
};
