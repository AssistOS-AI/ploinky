// The private Router operation `GET /api/edge/runtime-sources`.
//
// It reports the folders the active routing generation executes code from, as
// workspace-relative paths, so a caller that hands out writable folders can
// refuse to hand out one of them. The answer is derived only from the exact
// lease snapshot of the request (routes, registry records and manifests) plus
// the Router's own Ploinky and AgentLib locations. It runs no Git command and
// never searches the workspace: link-install checkouts are the ones each launch
// recorded in its registry record, and a record without that field reports its
// manifest's link-install names at their default workspace location.
//
// Every path is canonicalized with realpath (a missing path through its nearest
// existing ancestor). A path outside the workspace is counted, never named, so
// no host or Box path leaks. A source equal to, or containing, the workspace
// root, any malformed input, or an answer beyond its bounds is refused with
// 503: the caller then refuses writable work instead of trusting a partial list.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { activeAgentLibSelection } from '../utils/dependencies/agentLibLink.js';
import { PLOINKY_WORKSPACE_ROOT } from '../utils/config.js';
import { linkInstallDeclarations } from '../utils/linkInstall.mjs';
import { commitRoutePlan } from './edgeRoutePlan.js';

export const RUNTIME_SOURCES_PATH = '/api/edge/runtime-sources';
export const RUNTIME_SOURCES_SCHEMA_VERSION = 1;
export const RUNTIME_SOURCE_KINDS = Object.freeze([
    'agent-repository',
    'agent-library',
    'agent-runtime-library',
    'linked-repository',
]);
const MAX_SOURCES = 512;
const MAX_PATH_BYTES = 4096;
const MAX_BODY_BYTES = 256 * 1024;
const ACTIVATION_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const ROUTER_AGENT_LIB_PATH = fileURLToPath(new URL('../../Agent', import.meta.url));

function sourcesError(status, code, message) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    return error;
}

function unavailable(message) {
    return sourcesError(503, 'RUNTIME_SOURCES_UNAVAILABLE', message);
}

function plainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// realpath of a path, or of its nearest existing ancestor with the missing
// remainder appended: a not-yet-created link-install checkout under a
// symlinked workspace still lands inside the workspace.
function canonicalize(target, realpath) {
    const absolute = path.resolve(target);
    const missing = [];
    let current = absolute;
    for (;;) {
        try {
            const real = realpath(current);
            return missing.length ? path.join(real, ...missing.reverse()) : real;
        } catch (error) {
            if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
            const parent = path.dirname(current);
            if (parent === current) return absolute;
            missing.push(path.basename(current));
            current = parent;
        }
    }
}

function within(parent, child) {
    const relative = path.relative(parent, child);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function defaultAgentLibSelection() {
    return activeAgentLibSelection(process.env);
}

/**
 * The raw source roots of one lease snapshot, as [{ kind, root }] with
 * absolute, not yet canonical roots. Throws on malformed recorded input.
 */
export function collectRuntimeSourceRoots(snapshot, {
    workspaceRoot,
    agentLibPath = ROUTER_AGENT_LIB_PATH,
    agentLibSelection = defaultAgentLibSelection,
    realpath = fs.realpathSync,
} = {}) {
    const roots = [];
    const add = (kind, root) => {
        if (typeof root !== 'string' || !root || root.includes('\0') || !path.isAbsolute(root)) {
            throw unavailable(`a recorded ${kind} source is not an absolute path`);
        }
        roots.push({ kind, root });
    };
    const routes = plainObject(snapshot?.routing?.routes) ? snapshot.routing.routes : {};
    const agents = plainObject(snapshot?.agents) ? snapshot.agents : {};
    const manifests = plainObject(snapshot?.manifests) ? snapshot.manifests : {};
    // Staged runtime copies of /Agent live in Ploinky's own state, not in a source.
    const stateDir = canonicalize(path.join(workspaceRoot, '.ploinky'), realpath);

    // (1) The repository of every routed agent (`<repo>/<agent>/manifest.json`).
    for (const route of Object.values(routes)) {
        const hostPath = typeof route?.hostPath === 'string' ? route.hostPath.trim() : '';
        if (hostPath) add('agent-repository', path.dirname(path.resolve(hostPath)));
    }

    // (2) The registry records: the /code source's repository, a /Agent
    // source's Ploinky checkout, and the link-install checkouts a launch recorded.
    const recordedLinks = new Set();
    for (const [containerName, record] of Object.entries(agents)) {
        if (!plainObject(record) || record.type !== 'agent' || containerName.startsWith('_')) continue;
        const binds = Array.isArray(record.config?.binds) ? record.config.binds : [];
        for (const bind of binds) {
            if (!plainObject(bind) || typeof bind.source !== 'string' || !bind.source) continue;
            if (bind.target === '/code') add('agent-repository', path.dirname(path.resolve(bind.source)));
            if (bind.target === '/Agent' && !within(stateDir, canonicalize(bind.source, realpath))) {
                add('agent-library', path.dirname(path.resolve(bind.source)));
            }
        }
        if (record.linkedRepositories === undefined) continue;
        if (!Array.isArray(record.linkedRepositories)) throw unavailable('a recorded link-install list is malformed');
        for (const entry of record.linkedRepositories) {
            if (!plainObject(entry)) throw unavailable('a recorded link-install entry is malformed');
            add('linked-repository', entry.realpath);
        }
        recordedLinks.add(containerName);
    }
    // A record launched before link-install sources were recorded: its
    // manifest's declared names at their default workspace location, read
    // lexically. A matching checkout elsewhere is not searched for.
    for (const [routeKey, manifest] of Object.entries(manifests)) {
        const container = String(routes[routeKey]?.container || '');
        if (container && recordedLinks.has(container)) continue;
        let declarations;
        try { declarations = linkInstallDeclarations(manifest); }
        catch (_) { throw unavailable(`manifest(${routeKey}) link-install declarations are invalid`); }
        for (const declaration of declarations) add('linked-repository', path.join(workspaceRoot, declaration.name));
    }

    // (3) The Ploinky checkout this Router runs from.
    add('agent-library', path.dirname(path.resolve(agentLibPath)));

    // (4) The selected achillesAgentLib checkout. A copy a Box image supplies
    // is part of that image, not of the workspace.
    let selection;
    try { selection = agentLibSelection(); }
    catch (_) { throw unavailable('the active AgentLib selection is unavailable'); }
    if (selection?.mode !== 'image') add('agent-runtime-library', selection?.sourceDir);
    return roots;
}

/**
 * The envelope for one authorized runtime-sources request:
 * { schemaVersion, authorizationGeneration, activationId, sources, outsideWorkspace }.
 */
export function buildRuntimeSourcesResponse(plan, {
    workspaceRoot = PLOINKY_WORKSPACE_ROOT,
    agentLibPath = ROUTER_AGENT_LIB_PATH,
    agentLibSelection = defaultAgentLibSelection,
    realpath = fs.realpathSync,
} = {}) {
    if (!plan?.ok || plan.listener !== 'private' || plan.kind !== 'private-operation'
        || plan.operation !== 'runtime-sources') {
        throw sourcesError(403, 'PRIVATE_LISTENER_REQUIRED', 'runtime sources require the private operation plan');
    }
    const lease = plan.lease;
    const generation = String(lease?.id || '');
    const activationId = String(lease?.activationId || '');
    if (!/^sha256:[a-f0-9]{64}$/.test(generation) || !ACTIVATION_ID_PATTERN.test(activationId)
        || lease?.snapshot !== plan.snapshot || plan.snapshot?.generation !== generation) {
        throw sourcesError(503, 'RUNTIME_SOURCES_LEASE_INVALID', 'runtime sources require one exact active lease');
    }
    let workspace;
    try { workspace = realpath(path.resolve(String(workspaceRoot || ''))); }
    catch (_) { throw unavailable('the workspace root cannot be resolved'); }

    let roots;
    try {
        roots = collectRuntimeSourceRoots(plan.snapshot, { workspaceRoot: workspace, agentLibPath, agentLibSelection, realpath });
    } catch (error) {
        if (error?.code === 'RUNTIME_SOURCES_UNAVAILABLE') throw error;
        throw unavailable('a runtime source cannot be computed');
    }

    const byPath = new Map();
    const outside = new Set();
    for (const { kind, root } of roots) {
        let canonical;
        try { canonical = canonicalize(root, realpath); }
        catch (_) { throw unavailable('a runtime source cannot be canonicalized'); }
        // Before the outside count: an ancestor of the workspace is never
        // silently counted as an outside source.
        if (within(canonical, workspace)) throw unavailable('a runtime source is the workspace root or contains it');
        const relative = path.relative(workspace, canonical);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
            outside.add(canonical);
            continue;
        }
        const relativePath = relative.split(path.sep).join('/');
        if (relativePath.split('/').some((segment) => !segment || segment === '.' || segment === '..')
            || relativePath.includes('\0') || Buffer.byteLength(relativePath, 'utf8') > MAX_PATH_BYTES) {
            throw unavailable('a runtime source path is outside its bounds');
        }
        const existing = byPath.get(relativePath);
        if (!existing || RUNTIME_SOURCE_KINDS.indexOf(kind) < RUNTIME_SOURCE_KINDS.indexOf(existing)) {
            byPath.set(relativePath, kind);
        }
    }
    if (byPath.size > MAX_SOURCES) throw unavailable('the runtime source list exceeds its bound');
    const sources = [...byPath.entries()]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([relativePath, kind]) => ({ kind, relativePath }));
    const envelope = {
        schemaVersion: RUNTIME_SOURCES_SCHEMA_VERSION,
        authorizationGeneration: generation,
        activationId,
        sources,
        outsideWorkspace: outside.size,
    };
    if (Buffer.byteLength(JSON.stringify(envelope), 'utf8') > MAX_BODY_BYTES) {
        throw unavailable('the runtime source list exceeds its size bound');
    }
    return envelope;
}

function sendError(res, error) {
    const status = Number(error?.status || 503);
    const body = Buffer.from(JSON.stringify({ ok: false, error: error?.code || 'RUNTIME_SOURCES_UNAVAILABLE' }));
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
    });
    res.end(body);
}

function kindCounts(sources) {
    const counts = Object.fromEntries(RUNTIME_SOURCE_KINDS.map((kind) => [kind, 0]));
    for (const { kind } of sources) counts[kind] += 1;
    return counts;
}

/**
 * Reply to an already authorized runtime-sources request. The lease is
 * revalidated immediately before the response is written; audit events carry
 * counts only, never paths.
 */
export function sendRuntimeSources(res, {
    plan,
    body = Buffer.alloc(0),
    callerIdentity = null,
    audit = () => {},
    ...sources
} = {}) {
    let envelope;
    try {
        if (!Buffer.isBuffer(body) || body.length !== 0) {
            throw sourcesError(400, 'RUNTIME_SOURCES_REQUEST_INVALID', 'runtime sources request has a body');
        }
        envelope = buildRuntimeSourcesResponse(plan, sources);
    } catch (error) {
        audit('runtime_sources_rejected', { code: error?.code || 'RUNTIME_SOURCES_UNAVAILABLE' });
        sendError(res, error);
        return false;
    }
    const payload = Buffer.from(JSON.stringify(envelope));
    if (!commitRoutePlan(plan)) {
        audit('runtime_sources_rejected', { code: 'edge_generation_changed' });
        sendError(res, sourcesError(503, 'edge_generation_changed', 'edge generation changed'));
        return false;
    }
    res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': payload.length,
        'Cache-Control': 'no-store',
    });
    res.end(payload);
    audit('runtime_sources_served', {
        callerAgentId: String(callerIdentity?.agentId || ''),
        generation: envelope.authorizationGeneration,
        sources: envelope.sources.length,
        kinds: kindCounts(envelope.sources),
        outsideWorkspace: envelope.outsideWorkspace,
    });
    return true;
}

export default {
    RUNTIME_SOURCES_PATH,
    RUNTIME_SOURCES_SCHEMA_VERSION,
    RUNTIME_SOURCE_KINDS,
    buildRuntimeSourcesResponse,
    collectRuntimeSourceRoots,
    sendRuntimeSources,
};
