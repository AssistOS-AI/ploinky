import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { sha256RawBodyHash } from '../../../Agent/lib/requestHash.mjs';
import { resolveWorkspaceDirectory } from '../../../core-services/webtty/cwd.mjs';
import { AGENT_PORT_ROUTE, parseAgentPortSelector } from '../agentPortConvention/parseSelector.js';
import { isAdminUser } from '../auth/localService.js';
import { resolveAuthContextForRoutePlan } from '../authHandlers/authContext.js';
import { evaluateRequiredCapability } from '../authHandlers/requiredCapability.js';
import { agentPortPlan } from '../edgeRoutePlan.js';
import { createRelayHttpAgent, RelayDuplex } from '../proxy/executeHttpPlan.js';
import { finalizePlanAfterAdmission } from '../proxy/RoutePlan.js';
import { sanitizeRequestHeaders } from '../proxy/sanitizeRequestHeaders.js';
import { buildHttpRouteAuthInfoHeader } from '../routerHandlers.js';
import { getAgentWorkDir } from '../../utils/workspaceStructure.js';

// A home profile is an optional, agent-nominated directory that becomes a
// terminal's HOME. The owning agent declares one resolve endpoint on its own
// routed agent-port surface; the Router alone calls it, signed for the admitted
// administrator, and confines the answer to that agent's data directory.
export const WEBTTY_HOME_PROFILE_LIMITS = Object.freeze({
    deadlineMs: 2_000,
    responseBytes: 16 * 1024,
    resolvePathBytes: 1024,
    homeBytes: 4 * 1024,
    labelBytes: 128,
});

export const HOME_PROFILE_PROVIDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
export const HOME_PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function profileError(category) {
    const error = new Error(`WebTTY home profile is unavailable: ${category}`);
    error.code = 'WEBTTY_PROFILE_UNAVAILABLE';
    error.category = category;
    return error;
}

function plainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected) {
    if (!plainObject(value)) return false;
    const keys = Object.keys(value).sort();
    const target = [...expected].sort();
    return keys.length === target.length && keys.every((key, index) => key === target[index]);
}

export function validateHomeProfileLabel(value) {
    return typeof value === 'string' && value !== ''
        && !/[\u0000-\u001f\u007f]/.test(value)
        && Buffer.byteLength(value, 'utf8') <= WEBTTY_HOME_PROFILE_LIMITS.labelBytes;
}

export function validateHomeProfileRequest(profile) {
    if (!exactKeys(profile, ['provider', 'id'])
        || typeof profile.provider !== 'string' || !HOME_PROFILE_PROVIDER_PATTERN.test(profile.provider)
        || typeof profile.id !== 'string' || !HOME_PROFILE_ID_PATTERN.test(profile.id)) {
        return null;
    }
    return Object.freeze({ provider: profile.provider, id: profile.id });
}

// Only the agent-port surface can be planned through agentPortPlan, so the
// resolve endpoint must be an exact, canonical path on the declaring agent's
// own `/base-agent-additional-server/<routeKey>/<port>/...` surface.
export function homeProfileDeclaration(manifest, routeKey) {
    const declaration = plainObject(manifest?.webtty) ? manifest.webtty.homeProfiles : undefined;
    if (!exactKeys(declaration, ['version', 'resolve']) || declaration.version !== 1) return null;
    const resolve = declaration.resolve;
    if (typeof resolve !== 'string' || !resolve.startsWith(`/${AGENT_PORT_ROUTE}/`)
        || Buffer.byteLength(resolve, 'utf8') > WEBTTY_HOME_PROFILE_LIMITS.resolvePathBytes
        || /[\u0000- \u007f%?#\\]/.test(resolve) || resolve.endsWith('/')) {
        return null;
    }
    let selector;
    try {
        selector = parseAgentPortSelector(resolve);
    } catch (_) {
        return null;
    }
    if (!selector || selector.agent !== routeKey || selector.rawAgent !== routeKey
        || selector.query !== '' || selector.suffix === '/' || selector.policyPath !== resolve) {
        return null;
    }
    return Object.freeze({ version: 1, resolve });
}

function activeRoute(routes, routeKey) {
    const route = routes?.[routeKey];
    return route && !route.disabled && !route.draining ? route : null;
}

// Exactly one enabled agent with this name and a valid declaration may serve
// the provider name. Any ambiguity is a refusal, never a choice.
export function findHomeProfileProvider(snapshot, providerName) {
    const routes = snapshot?.routing?.routes || {};
    const candidates = [];
    for (const routeKey of Object.keys(routes)) {
        const route = activeRoute(routes, routeKey);
        if (!route || String(route.agent || '') !== providerName) continue;
        const containerName = String(route.container || '');
        const record = snapshot.agents?.[containerName];
        if (!containerName || record?.type !== 'agent' || record.agentName !== providerName
            || String(record.repoName || '') !== String(route.repo || '')) continue;
        const declaration = homeProfileDeclaration(snapshot.manifests?.[routeKey], routeKey);
        if (!declaration) continue;
        candidates.push(Object.freeze({
            routeKey,
            containerName,
            agentName: record.agentName,
            repoName: record.repoName,
            containerId: String(record.containerId || ''),
            instanceId: String(record.instanceId || ''),
            enableGeneration: String(record.enableGeneration || ''),
            declaration,
        }));
    }
    return candidates.length === 1 ? candidates[0] : null;
}

function currentSnapshot(routePlan) {
    const snapshot = routePlan?.snapshot;
    const lease = routePlan?.lease;
    if (!snapshot || !lease || lease.snapshot !== snapshot || typeof lease.isCurrent !== 'function'
        || lease.isCurrent() !== true) {
        return null;
    }
    return snapshot;
}

function sameProvider(left, right) {
    return Boolean(left && right)
        && ['routeKey', 'containerName', 'agentName', 'repoName', 'containerId', 'instanceId', 'enableGeneration']
            .every((field) => left[field] === right[field])
        && left.declaration.resolve === right.declaration.resolve;
}

// The returned home is relative to the provider's data directory. Reject every
// spelling that could leave it before the filesystem is consulted.
export function validateHomeProfileHome(value) {
    if (typeof value !== 'string' || value === ''
        || Buffer.byteLength(value, 'utf8') > WEBTTY_HOME_PROFILE_LIMITS.homeBytes
        || /[\u0000-\u001f\u007f%\\]/.test(value) || value.startsWith('/')) {
        return null;
    }
    const segments = value.split('/');
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return null;
    return segments.join('/');
}

// The Router's caller check for the provider's own route, as the agent-port
// relay applies it to a browser request (ensureHttpRouteAccess for an
// authenticated decision): the same owner auth context, the same session
// auth mode, and every required capability, decided for the administrator
// this request already admitted. Nothing is written to a browser response.
export function providerRouteAdmitsCaller(plan, req, snapshot) {
    const decision = plan?.access;
    if (decision?.access !== 'authenticated' || decision.routeKey !== plan.routeKey) return false;
    let context;
    try {
        context = resolveAuthContextForRoutePlan(plan.parsedUrl, { snapshot, decision });
    } catch (_) {
        return false;
    }
    if (!context || context.error || context.surfaceOwnerUnconfigured) return false;
    const mode = String(context.mode || '').trim().toLowerCase();
    if (!mode || ['none', 'guest', 'authenticated-unconfigured'].includes(mode)) return false;
    // As in the browser path, only the local CLI administrator session is
    // admitted under another owner auth mode and without route capabilities.
    const privilegedLocalCli = req?.authMode === 'local'
        && req?.authChannel === 'cli'
        && req?.user?.id === 'local:admin';
    if (privilegedLocalCli) return true;
    if (String(req?.authMode || '') !== mode) return false;
    const capabilityRouteKeys = [...new Set([
        String(context.capabilityOwnerRouteKey || context.routeKey || '').trim(),
        String(context.serviceRouteKey || '').trim(),
        ...(Array.isArray(context.additionalCapabilityRouteKeys)
            ? context.additionalCapabilityRouteKeys.map((routeKey) => String(routeKey || '').trim())
            : []),
    ].filter(Boolean))];
    return capabilityRouteKeys.every((routeKey) => (
        evaluateRequiredCapability(snapshot?.manifests?.[routeKey] || null, req.user).ok === true
    ));
}

function directoryIdentity(absolutePath, fsApi) {
    const stat = fsApi.statSync(absolutePath, { bigint: true });
    if (!stat.isDirectory()) throw new Error('not a directory');
    return Object.freeze({ dev: String(stat.dev), ino: String(stat.ino) });
}

export function validateHomeProfileResponse(statusCode, bodyBytes, requestedId) {
    if (statusCode !== 200) return null;
    let value;
    try {
        value = JSON.parse(Buffer.from(bodyBytes).toString('utf8'));
    } catch (_) {
        return null;
    }
    if (!exactKeys(value, ['allowed', 'profile']) || value.allowed !== true
        || !exactKeys(value.profile, ['id', 'label', 'home'])
        || value.profile.id !== requestedId
        || !validateHomeProfileLabel(value.profile.label)
        || typeof value.profile.home !== 'string') {
        return null;
    }
    return Object.freeze({ id: value.profile.id, label: value.profile.label, home: value.profile.home });
}

export class WebttyHomeProfileProvider {
    constructor({
        workspaceRoot,
        relayManager,
        providerDataDirectory = (agentName) => getAgentWorkDir(agentName),
        signRouteRequest = buildHttpRouteAuthInfoHeader,
        planAgentPort = agentPortPlan,
        fsApi = fs,
        limits = WEBTTY_HOME_PROFILE_LIMITS,
        setTimer = setTimeout,
        clearTimer = clearTimeout,
    } = {}) {
        this.workspaceRoot = workspaceRoot;
        this.relayManager = relayManager;
        this.providerDataDirectory = providerDataDirectory;
        this.signRouteRequest = signRouteRequest;
        this.planAgentPort = planAgentPort;
        this.fsApi = fsApi;
        this.limits = Object.freeze({ ...WEBTTY_HOME_PROFILE_LIMITS, ...limits });
        this.setTimer = setTimer;
        this.clearTimer = clearTimer;
    }

    // Resolve the profile for the admitted administrator in `req`, whose lease
    // the caller has just revalidated. Every failure is the same refusal.
    async resolve({ req, routePlan, profile } = {}) {
        const requested = validateHomeProfileRequest(profile);
        if (!requested) throw profileError('request');
        if (!req?.user || typeof req.user !== 'object' || !isAdminUser(req.user)) {
            throw profileError('administrator');
        }
        const snapshot = currentSnapshot(routePlan);
        if (!snapshot) throw profileError('generation');
        const provider = findHomeProfileProvider(snapshot, requested.provider);
        if (!provider) throw profileError('provider');
        const answer = await this.callProvider({ req, routePlan, snapshot, provider, id: requested.id });
        // The generation, and with it the provider's exact runtime record,
        // must still be the one that answered.
        const after = currentSnapshot(routePlan);
        if (after !== snapshot || !sameProvider(findHomeProfileProvider(after, requested.provider), provider)) {
            throw profileError('generation');
        }
        const home = this.confineHome(provider, answer.home);
        return Object.freeze({
            profile: Object.freeze({ provider: requested.provider, id: answer.id, label: answer.label }),
            home,
        });
    }

    confineHome(provider, homeValue) {
        const home = validateHomeProfileHome(homeValue);
        if (!home) throw profileError('home');
        let workspaceRealPath;
        let dataRealPath;
        try {
            workspaceRealPath = this.fsApi.realpathSync(this.workspaceRoot);
            dataRealPath = this.fsApi.realpathSync(this.providerDataDirectory(provider.agentName));
            if (!this.fsApi.statSync(dataRealPath).isDirectory()) throw new Error('data directory');
        } catch (_) {
            throw profileError('home');
        }
        const dataRelative = path.relative(workspaceRealPath, dataRealPath);
        if (!dataRelative || dataRelative.startsWith('..') || path.isAbsolute(dataRelative)) {
            throw profileError('home');
        }
        let resolved;
        let identity;
        try {
            resolved = resolveWorkspaceDirectory(
                `${dataRelative.split(path.sep).join('/')}/${home}`,
                { workspaceRoot: this.workspaceRoot, fsApi: this.fsApi },
            );
            identity = directoryIdentity(resolved.absolutePath, this.fsApi);
        } catch (_) {
            throw profileError('home');
        }
        // Strictly inside the provider's own data directory, after symlinks.
        if (!resolved.absolutePath.startsWith(`${dataRealPath}${path.sep}`)) throw profileError('home');
        const relativePath = path.relative(resolved.workspaceRealPath, resolved.absolutePath)
            .split(path.sep).join('/');
        if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
            throw profileError('home');
        }
        return Object.freeze({ relativePath, absolutePath: resolved.absolutePath, identity });
    }

    async callProvider({ req, routePlan, snapshot, provider, id }) {
        const resolvePath = provider.declaration.resolve;
        let plan;
        try {
            plan = this.planAgentPort({
                req: { method: 'POST', url: resolvePath, headers: {} },
                host: routePlan.host,
                listener: routePlan.listener || 'public',
                parsedUrl: new URL(resolvePath, 'http://localhost'),
                hostSelection: routePlan.hostSelection,
                routes: snapshot.routing?.routes || {},
                snapshot,
                lease: routePlan.lease,
                transport: 'http',
                requestTarget: resolvePath,
            });
        } catch (_) {
            throw profileError('route');
        }
        // A route-policy deny or relay opt-out is a refusal, never a fallback.
        if (!plan?.ok || plan.kind !== 'agent-port' || plan.routeKey !== provider.routeKey
            || plan.relay?.containerName !== provider.containerName
            || plan.relay?.containerId !== provider.containerId
            || plan.owner?.effectiveInstanceId !== provider.instanceId
            || plan.owner?.enableGeneration !== provider.enableGeneration
            || plan.query !== '' || plan.parsedUrl?.search !== ''
            || plan.authDefinition?.issueInvocation !== true || plan.authDefinition?.includeAuthInfo !== true
            || !providerRouteAdmitsCaller(plan, req, snapshot)) {
            throw profileError('route');
        }
        const body = Buffer.from(JSON.stringify({ version: 1, id }), 'utf8');
        const bodyHash = sha256RawBodyHash(body);
        let authInfo;
        let finalized;
        let headers;
        try {
            // Sign exactly as the agent-port relay signs a browser request to
            // this route, from the administrator's revalidated identity only.
            // No browser header, cookie or session token is forwarded.
            authInfo = this.signRouteRequest(
                { method: 'POST', user: req.user, sessionId: '' },
                plan.parsedUrl,
                plan.authDefinition,
                { bodyHash, routePath: plan.unmatchedSuffix },
            )?.['x-ploinky-auth-info'];
            const parsed = JSON.parse(String(authInfo || ''));
            if (typeof parsed?.invocationToken !== 'string' || !parsed.invocationToken) throw new Error('unsigned');
            finalized = finalizePlanAfterAdmission(plan);
            headers = sanitizeRequestHeaders({
                'content-type': 'application/json',
                accept: 'application/json',
            }, finalized, { authInfo });
            headers['content-length'] = String(body.length);
        } catch (_) {
            throw profileError('signature');
        }
        const response = await this.exchange({ plan: finalized, lease: routePlan.lease, headers, body, bodyHash });
        const answer = validateHomeProfileResponse(response.statusCode, response.body, id);
        if (!answer) throw profileError('response');
        return answer;
    }

    // One buffered request over the private relay with a single total
    // deadline. Every exit closes the checkout, agent, request and timer.
    exchange({ plan, lease, headers, body, bodyHash }) {
        const relayManager = this.relayManager;
        const limits = this.limits;
        const setTimer = this.setTimer;
        const clearTimer = this.clearTimer;
        return new Promise((resolve, reject) => {
            let settled = false;
            let checkout = null;
            let relayAgent = null;
            let request = null;
            const cleanup = () => {
                clearTimer(timer);
                try { request?.destroy(); } catch (_) { }
                try { relayAgent?.destroy(); } catch (_) { }
                try { checkout?.close(); } catch (_) { }
            };
            const finish = (error, value) => {
                if (settled) return;
                settled = true;
                cleanup();
                if (error) reject(error); else resolve(value);
            };
            const timer = setTimer(() => finish(profileError('timeout')), limits.deadlineMs);
            timer.unref?.();
            (async () => {
                if (!relayManager || typeof relayManager.checkout !== 'function') throw profileError('transport');
                const opened = await relayManager.checkout({ plan, lease, authorized: true });
                if (settled) {
                    try { opened?.close?.(); } catch (_) { }
                    return;
                }
                checkout = opened;
                const stream = await checkout.openRequest({ plan, bodyMode: 'buffered', bodyHash, headers });
                if (settled) {
                    try { stream?.cancel?.(); } catch (_) { }
                    return;
                }
                relayAgent = createRelayHttpAgent(new RelayDuplex(stream));
                request = http.request({
                    method: 'POST',
                    path: plan.targetPath,
                    headers,
                    agent: relayAgent,
                    maxHeaderSize: limits.responseBytes,
                }, (response) => {
                    const declared = Number(response.headers['content-length']);
                    if (Number.isFinite(declared) && declared > limits.responseBytes) {
                        finish(profileError('oversize'));
                        return;
                    }
                    const chunks = [];
                    let bytes = 0;
                    response.on('data', (chunk) => {
                        bytes += chunk.length;
                        if (bytes > limits.responseBytes) {
                            finish(profileError('oversize'));
                            return;
                        }
                        chunks.push(chunk);
                    });
                    response.on('end', () => finish(null, {
                        statusCode: response.statusCode || 0,
                        body: Buffer.concat(chunks),
                    }));
                    response.on('error', () => finish(profileError('transport')));
                    response.on('aborted', () => finish(profileError('transport')));
                });
                request.on('error', () => finish(profileError('transport')));
                request.end(body);
            })().catch((error) => finish(error?.code === 'WEBTTY_PROFILE_UNAVAILABLE' ? error : profileError('transport')));
        });
    }
}

export default WebttyHomeProfileProvider;
