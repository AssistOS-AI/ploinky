import http from 'node:http';

import { computeRchHttp, sha256RawBodyHash } from '../../../Agent/lib/requestHash.mjs';
import { readExecutionProviderDeclaration } from '../executionProvider/declaration.mjs';
import { isAdminUser } from '../auth/localService.js';
import { canonicalOriginCallerKey } from '../executionProvider/originToken.mjs';
import { planProviderEndpoint } from '../executionProvider/providerEndpointPlan.mjs';
import { buildRouterRequest } from '../mcp-proxy/invocationMinter.js';
import { createRelayHttpAgent, RelayDuplex } from '../proxy/executeHttpPlan.js';
import { finalizePlanAfterAdmission } from '../proxy/RoutePlan.js';
import { sanitizeRequestHeaders } from '../proxy/sanitizeRequestHeaders.js';

export const PROVIDER_TERMINAL_TARGETS_TOOL = '__provider_terminal_targets__';
export const PROVIDER_TERMINAL_TARGETS_LIMITS = Object.freeze({
    deadlineMs: 2_000,
    responseBytes: 70 * 1024,
    targets: 256,
    labelBytes: 128,
    // One provider may list at most this many targets in a dialog, and all
    // providers together at most `total` (the launch-record store admits the
    // Box, 63 agents and these). A provider over either bound is a notice.
    perProvider: 128,
    total: 256,
});

const TARGET_ID = /^[A-Za-z0-9_-]{1,128}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const SELECTION_MAX_BYTES = 1024;

function targetsError(code) {
    const error = new Error(`Provider terminal targets: ${code}`);
    error.code = 'WEBTTY_PROVIDER_TARGETS';
    error.category = code;
    return error;
}

function stale(code = 'WEBTTY_TARGET_STALE') {
    const error = new Error(code);
    error.code = code;
    return error;
}

// The enabled routes whose active manifest declares a terminals endpoint, as
// `{routeKey, valid}`; a declaration that does not validate is reported, not
// skipped, so its provider shows up as unavailable.
export function declaredTerminalProviders(snapshot) {
    const providers = [];
    for (const [routeKey, route] of Object.entries(snapshot?.routing?.routes || {})) {
        if (!route || route.disabled || route.draining) continue;
        const read = readExecutionProviderDeclaration(snapshot?.manifests?.[routeKey], { routeKey });
        if (!read.present) continue;
        if (!read.valid) providers.push({ routeKey, valid: false });
        else if (read.declaration.terminals) providers.push({ routeKey, valid: true });
    }
    return providers.sort((left, right) => (left.routeKey < right.routeKey ? -1 : 1));
}

// The provider body derived syntactically from the browser's directory: the
// workspace root (no directory) is `null`; any other directory is the
// canonical workspace-relative path as an opaque selection. The Router names
// no grant; only the provider's resolver decides what a selection means.
// The roles an administrator's signed actor carries: lowercased and trimmed
// the same way isAdminUser reads them, so `admin` is present exactly when the
// administrator check passes. Returns null for anyone who is not one.
export function adminActorRoles(user) {
    if (!isAdminUser(user)) return null;
    return [...new Set(user.roles.map((role) => String(role || '').trim().toLowerCase()).filter(Boolean))];
}

export function providerProjectFor(directory) {
    const relativePath = typeof directory?.relativePath === 'string' ? directory.relativePath : '';
    if (!relativePath) return null;
    if (Buffer.byteLength(relativePath, 'utf8') > SELECTION_MAX_BYTES || CONTROL.test(relativePath)) {
        throw targetsError('project_unsupported');
    }
    return { selection: relativePath, relativePath: '' };
}

function validLabel(value) {
    return typeof value === 'string' && value !== '' && !CONTROL.test(value)
        && Buffer.byteLength(value, 'utf8') <= PROVIDER_TERMINAL_TARGETS_LIMITS.labelBytes;
}

// Exactly {version: 1, targets: [{targetId, label}]}, unique ids, bounded.
export function validateTargetsResponse(statusCode, bodyBytes) {
    if (statusCode !== 200) return null;
    let value;
    try { value = JSON.parse(Buffer.from(bodyBytes).toString('utf8')); } catch (_) { return null; }
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).sort().join(',') !== 'targets,version' || value.version !== 1
        || !Array.isArray(value.targets) || value.targets.length > PROVIDER_TERMINAL_TARGETS_LIMITS.targets) return null;
    const seen = new Set();
    const targets = [];
    for (const entry of value.targets) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)
            || Object.keys(entry).sort().join(',') !== 'label,targetId'
            || typeof entry.targetId !== 'string' || !TARGET_ID.test(entry.targetId) || seen.has(entry.targetId)
            || !validLabel(entry.label)) return null;
        seen.add(entry.targetId);
        targets.push(Object.freeze({ targetId: entry.targetId, label: entry.label }));
    }
    return targets;
}

function inventoryTooLarge(statusCode, bodyBytes) {
    if (statusCode !== 503) return false;
    try { return JSON.parse(Buffer.from(bodyBytes).toString('utf8'))?.error === 'target_inventory_too_large'; } catch (_) { return false; }
}

// Provider terminal targets for the browser's discovery: one signed
// `POST <terminals.path>/targets` per declaring provider, through the internal
// planner and the private relay. Provider failures are reported as
// `providers` notices and never as targets.
export class ProviderTerminalTargets {
    constructor({
        relayManager,
        planEndpoint = planProviderEndpoint,
        signRouterRequest = buildRouterRequest,
        limits = PROVIDER_TERMINAL_TARGETS_LIMITS,
        setTimer = setTimeout,
        clearTimer = clearTimeout,
    } = {}) {
        this.relayManager = relayManager;
        this.planEndpoint = planEndpoint;
        this.signRouterRequest = signRouterRequest;
        this.limits = Object.freeze({ ...PROVIDER_TERMINAL_TARGETS_LIMITS, ...limits });
        this.setTimer = setTimer;
        this.clearTimer = clearTimer;
    }

    // `user` is the revalidated administrator of the discovering request.
    async discover({ routePlan, directory, user } = {}) {
        const snapshot = routePlan?.snapshot;
        const key = canonicalOriginCallerKey({ user });
        const providers = declaredTerminalProviders(snapshot);
        const targets = [];
        const notices = [];
        if (!providers.length) return Object.freeze({ targets: Object.freeze([]), providers: Object.freeze([]) });
        let project;
        let projectFailure = '';
        try { project = providerProjectFor(directory); } catch (error) { projectFailure = error.category; }
        const roles = adminActorRoles(user);
        const answers = new Map();
        await Promise.all(providers.map(async ({ routeKey, valid }) => {
            const unavailable = (reason) => notices.push({ name: routeKey, available: false, reason });
            if (!valid) { unavailable('declaration_invalid'); return; }
            if (projectFailure) { unavailable(projectFailure); return; }
            if (!key || !roles) { unavailable('forbidden'); return; }
            try {
                answers.set(routeKey, await this.#one({ routePlan, routeKey, project, directory, key, roles }));
            } catch (error) {
                if (error?.code === 'WEBTTY_TARGET_GENERATION_STALE') throw error;
                unavailable(error?.category || 'provider_unavailable');
            }
        }));
        // Providers in name order take their share; one over its own bound, or
        // over what is left of the total, is a notice and never fails the dialog.
        let remaining = this.limits.total;
        for (const routeKey of [...answers.keys()].sort()) {
            const rows = answers.get(routeKey);
            if (rows.length > this.limits.perProvider || rows.length > remaining) {
                notices.push({ name: routeKey, available: false, reason: 'inventory_too_large' });
                continue;
            }
            remaining -= rows.length;
            targets.push(...rows);
        }
        const order = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
        targets.sort((left, right) => order(left.provider, right.provider) || order(left.label, right.label)
            || order(left.targetId, right.targetId));
        notices.sort((left, right) => order(left.name, right.name));
        return Object.freeze({ targets: Object.freeze(targets), providers: Object.freeze(notices) });
    }

    #plan(routeKey, routePlan, input) {
        let plan;
        try { plan = this.planEndpoint({ routeKey, endpoint: 'terminals', ...input }); } catch (_) {
            throw targetsError('provider_unavailable');
        }
        if (!plan?.ok) throw targetsError('provider_unavailable');
        if (routePlan?.lease?.id && plan.generationDigest !== routePlan.lease.id) {
            throw stale('WEBTTY_TARGET_GENERATION_STALE');
        }
        return plan;
    }

    async #one({ routePlan, routeKey, project, directory, key, roles }) {
        const plan = this.#plan(routeKey, routePlan, { subpath: '/targets', method: 'POST', transport: 'http' });
        const body = Buffer.from(JSON.stringify({ project }), 'utf8');
        const bodyHash = sha256RawBodyHash(body);
        const path = plan.unmatchedSuffix;
        let finalized;
        let headers;
        try {
            const { token } = this.signRouterRequest({
                targetAgentId: plan.relay.targetAgentId,
                sub: key,
                actor: { kind: 'user', id: key, roles },
                method: 'POST',
                path,
                tool: PROVIDER_TERMINAL_TARGETS_TOOL,
                rch: computeRchHttp({ method: 'POST', path, query: '', bodyHash }),
            });
            const authInfo = JSON.stringify({
                invocationToken: token,
                invocationBody: { method: 'POST', path, search: '', bodyHash, op: 'targets' },
            });
            finalized = finalizePlanAfterAdmission(plan);
            headers = sanitizeRequestHeaders({ 'content-type': 'application/json', accept: 'application/json' },
                finalized, { authInfo });
            headers['content-length'] = String(body.length);
        } catch (_) {
            throw targetsError('provider_unavailable');
        }
        const response = await this.#exchange({ plan: finalized, lease: plan.lease, headers, body, bodyHash });
        if (inventoryTooLarge(response.statusCode, response.body)) throw targetsError('inventory_too_large');
        if (response.statusCode === 401 || response.statusCode === 403) throw targetsError('forbidden');
        const answer = validateTargetsResponse(response.statusCode, response.body);
        if (!answer) throw targetsError(response.statusCode === 200 ? 'response_invalid' : 'provider_unavailable');
        return answer.map((target) => Object.freeze({
            kind: 'provider',
            provider: routeKey,
            providerPrincipal: plan.relay.targetAgentId,
            providerInstanceId: plan.owner.effectiveInstanceId,
            providerEnableGeneration: plan.owner.enableGeneration,
            terminalsPath: plan.unmatchedSuffix.replace(/\/targets$/, ''),
            targetId: target.targetId,
            label: target.label,
            detail: routeKey,
            // The provider row defines what the dialog shows: the Router
            // cannot know the grant, and the worker alone authorizes it.
            access: 'rw',
            cwdDisplay: project ? project.selection : 'Home',
            project,
            directory,
        }));
    }

    // A provider target is still launchable when its route is the same
    // enabled, declared, runtime-ready instance under the same generation.
    // The provider re-authorizes the target and the project at launch.
    revalidate({ routePlan, target } = {}) {
        let plan;
        try {
            plan = this.#plan(target.provider, routePlan, { subpath: '', method: 'GET', transport: 'websocket' });
        } catch (error) {
            if (error?.code === 'WEBTTY_TARGET_GENERATION_STALE') throw error;
            throw stale();
        }
        if (plan.relay.targetAgentId !== target.providerPrincipal
            || plan.owner.effectiveInstanceId !== target.providerInstanceId
            || plan.owner.enableGeneration !== target.providerEnableGeneration
            || plan.unmatchedSuffix !== target.terminalsPath) throw stale();
        return target;
    }

    // One buffered request over the private relay with a single deadline.
    #exchange({ plan, lease, headers, body, bodyHash }) {
        const { relayManager, limits, setTimer, clearTimer } = this;
        return new Promise((resolve, reject) => {
            let settled = false;
            let checkout = null;
            let relayAgent = null;
            let request = null;
            let timer;
            const finish = (error, value) => {
                if (settled) return;
                settled = true;
                clearTimer(timer);
                try { request?.destroy(); } catch (_) { }
                try { relayAgent?.destroy(); } catch (_) { }
                try { checkout?.close(); } catch (_) { }
                if (error) reject(error); else resolve(value);
            };
            timer = setTimer(() => finish(targetsError('timeout')), limits.deadlineMs);
            timer.unref?.();
            (async () => {
                if (!relayManager || typeof relayManager.checkout !== 'function') throw targetsError('provider_unavailable');
                const opened = await relayManager.checkout({ plan, lease, authorized: true });
                if (settled) { try { opened?.close?.(); } catch (_) { } return; }
                checkout = opened;
                const stream = await checkout.openRequest({ plan, bodyMode: 'buffered', bodyHash, headers });
                if (settled) { try { stream?.cancel?.(); } catch (_) { } return; }
                relayAgent = createRelayHttpAgent(new RelayDuplex(stream));
                request = http.request({
                    method: 'POST', path: plan.targetPath, headers, agent: relayAgent, maxHeaderSize: 16 * 1024,
                }, (response) => {
                    const declared = Number(response.headers['content-length']);
                    if (Number.isFinite(declared) && declared > limits.responseBytes) {
                        finish(targetsError('response_invalid'));
                        return;
                    }
                    const chunks = [];
                    let bytes = 0;
                    response.on('data', (chunk) => {
                        bytes += chunk.length;
                        if (bytes > limits.responseBytes) { finish(targetsError('response_invalid')); return; }
                        chunks.push(chunk);
                    });
                    response.on('end', () => finish(null, { statusCode: response.statusCode || 0, body: Buffer.concat(chunks) }));
                    response.on('error', () => finish(targetsError('provider_unavailable')));
                    response.on('aborted', () => finish(targetsError('provider_unavailable')));
                });
                request.on('error', () => finish(targetsError('provider_unavailable')));
                request.end(body);
            })().catch((error) => finish(error?.code === 'WEBTTY_PROVIDER_TARGETS' ? error : targetsError('provider_unavailable')));
        });
    }
}

export default ProviderTerminalTargets;
