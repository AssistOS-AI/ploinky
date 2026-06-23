import path from 'path';

import { PLOINKY_DIR } from '../../services/config.js';
import * as reposSvc from '../../services/repos.js';
import * as agentsSvc from '../../services/agents.js';
import * as workspaceSvc from '../../services/workspace.js';
import { collectLiveAgentContainers } from '../../services/docker/index.js';
import { collectAgentsSummary } from '../../services/status.js';
import { isLocalAdminUser } from '../auth/localService.js';
import { authService, LOCAL_AUTH_COOKIE_NAME, parseCookies, readJsonBody, sendJson, sessionTokenService, SSO_AUTH_COOKIE_NAME } from './shared.js';

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

function normalizeMarketplaceRepoName(value) {
    const name = String(value || '').trim();
    if (!name || !/^[a-zA-Z0-9_.-]+$/.test(name)) {
        throw new Error('invalid_repository_name');
    }
    return name;
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
    const mode = String(value || 'isolated').trim().toLowerCase();
    if (!mode || mode === 'default') return 'isolated';
    if (!['isolated', 'global', 'devel'].includes(mode)) {
        throw new Error('invalid_enable_mode');
    }
    return mode;
}

function isSkillsOnlyRepoError(error) {
    const message = String(error?.message || error || '');
    return /skills-only repo|contains only skills/i.test(message);
}

function normalizeMarketplaceContainerSegment(value) {
    return String(value || '').replace(/[^a-zA-Z0-9_.-]/g, '_');
}

function marketplaceContainerMatchesAgent(containerName, repoName, agentName) {
    const prefix = `ploinky_${normalizeMarketplaceContainerSegment(repoName)}_${normalizeMarketplaceContainerSegment(agentName)}_`;
    return String(containerName || '').startsWith(prefix);
}

function buildMarketplaceState(user = null) {
    const reposDir = path.join(PLOINKY_DIR, 'repos');
    const predefined = reposSvc.getPredefinedRepos();
    const installed = new Set(reposSvc.getInstalledRepos(reposDir));
    const enabled = new Set(reposSvc.loadEnabledRepos());
    const enabledAgents = Object.entries(workspaceSvc.loadAgents())
        .filter(([, record]) => record && record.type === 'agent')
        .map(([containerName, record]) => ({
            repoName: String(record.repoName || ''),
            agentName: String(record.agentName || ''),
            containerName: String(containerName || ''),
            alias: String(record.alias || ''),
            runMode: String(record.runMode || 'isolated')
        }));
    const activeAgentsByRepo = new Map();
    for (const record of enabledAgents) {
        const repoName = record.repoName;
        if (!repoName) continue;
        activeAgentsByRepo.set(repoName, (activeAgentsByRepo.get(repoName) || 0) + 1);
    }
    const bootRepos = new Set(reposSvc.getDefaultBootRepos().map(repo => repo.name));
    const repoNames = new Set([...Object.keys(predefined), ...installed]);
    const repositories = [...repoNames].sort((left, right) => left.localeCompare(right)).map((name) => {
        const predefinedEntry = predefined[name] || {};
        return {
            name,
            url: predefinedEntry.url || '',
            description: predefinedEntry.description || '',
            kind: predefinedEntry.kind || reposSvc.classifyRepoKind(name),
            installed: installed.has(name),
            enabled: enabled.has(name),
            default: bootRepos.has(name),
            activeAgentsCount: activeAgentsByRepo.get(name) || 0
        };
    });
    const enabledKeys = new Set(enabledAgents.map(record => `${record.repoName}/${record.agentName}`));
    const enabledByContainer = new Map(enabledAgents.map(record => [record.containerName, record]));
    const enabledByRef = new Map(enabledAgents.map(record => [`${record.repoName}/${record.agentName}`, record]));
    const liveEntries = collectLiveAgentContainers() || [];
    const summaries = collectAgentsSummary({ includeInactive: true });
    const agents = [];
    for (const repo of summaries) {
        for (const agent of repo.agents || []) {
            const ref = `${agent.repo}/${agent.name}`;
            const liveEntry = liveEntries.find((entry) => {
                const containerName = String(entry?.containerName || '');
                const registryRecord = enabledByContainer.get(containerName);
                if (registryRecord && `${registryRecord.repoName}/${registryRecord.agentName}` === ref) return true;
                if (`${entry?.repoName || ''}/${entry?.agentName || ''}` === ref) return true;
                return marketplaceContainerMatchesAgent(containerName, agent.repo, agent.name);
            });
            const runtime = liveEntry ? {
                status: String(liveEntry?.state?.status || '').trim().toLowerCase() || 'unknown',
                pid: liveEntry?.state?.pid || null,
                containerName: String(liveEntry?.containerName || '')
            } : null;
            const active = enabledKeys.has(ref);
            const enabledRecord = enabledByRef.get(ref) || null;
            agents.push({
                ref,
                repo: agent.repo,
                name: agent.name,
                about: agent.about === '-' ? '' : (agent.about || ''),
                active,
                enableMode: enabledRecord?.runMode || 'isolated',
                enableModes: ['isolated', 'global', 'devel'],
                status: runtime?.status || (active ? 'stopped' : 'inactive'),
                running: runtime?.status === 'running',
                pid: runtime?.pid || null,
                containerName: runtime?.containerName || '',
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
        if (!(await ensureMarketplaceUser(req, res))) {
            return true;
        }
        sendJson(res, 200, {
            ok: true,
            marketplace: buildMarketplaceState(req.user)
        });
        return true;
    }

    if (method === 'POST' && !route.resource) {
        if (!(await ensureMarketplaceAdmin(req, res, parsedUrl))) {
            return true;
        }
        let body;
        try {
            body = await readJsonBody(req);
        } catch (_) {
            sendMarketplaceError(res, 400, 'invalid_json', 'Request body must be valid JSON.');
            return true;
        }

        const action = String(body?.action || '').trim();
        try {
            if (action === 'add_repository') {
                const name = normalizeMarketplaceRepoName(body?.name);
                const url = normalizeMarketplaceUrl(body?.url);
                const branch = String(body?.branch || '').trim() || null;
                const addResult = reposSvc.addRepo(name, url, branch, { stdio: 'pipe' });
                let result = addResult;
                try {
                    reposSvc.enableRepo(name, branch, { stdio: 'pipe' });
                    result = { ...addResult, enabled: true };
                } catch (error) {
                    if (!isSkillsOnlyRepoError(error)) {
                        throw error;
                    }
                    result = {
                        ...addResult,
                        enabled: false,
                        skillsOnly: true,
                        message: error?.message || `Repo '${name}' contains only skills.`
                    };
                }
                sendJson(res, 200, {
                    ok: true,
                    action,
                    result,
                    marketplace: buildMarketplaceState(req.user)
                });
                return true;
            }

            if (action === 'enable_repository') {
                const name = normalizeMarketplaceRepoName(body?.name);
                const branch = String(body?.branch || '').trim() || null;
                const result = reposSvc.enableRepo(name, branch, { stdio: 'pipe' });
                sendJson(res, 200, {
                    ok: true,
                    action,
                    result,
                    marketplace: buildMarketplaceState(req.user)
                });
                return true;
            }

            if (action === 'disable_repository') {
                const name = normalizeMarketplaceRepoName(body?.name);
                const result = reposSvc.disableRepo(name);
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
