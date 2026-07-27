import fs from 'node:fs';
import path from 'node:path';

import { loadActiveEdgeRoutingGeneration } from '../sandbox/edgeGeneration.js';
import { resolveEnabledAgentRecord } from '../utils/agents.js';
import { findAgent } from '../utils/utils.js';

export function loadRoutingConfig() {
    try {
        return loadActiveEdgeRoutingGeneration().generation.routing || {};
    } catch (_) {
        return {};
    }
}

export function loadActiveRoutingState() {
    const active = loadActiveEdgeRoutingGeneration();
    return {
        generation: active.selector.generation,
        routing: active.generation.routing || { routes: {} },
        manifests: active.generation.manifests || {},
        snapshot: active.generation,
    };
}

function readJsonFileIfExists(filePath) {
    try {
        if (!filePath || !fs.existsSync(filePath)) return null;
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (_) {
        return null;
    }
}

export function readEnabledAgentManifest(routeKey, routes = {}) {
    const normalizedRouteKey = String(routeKey || '').trim();
    if (!normalizedRouteKey) return null;

    const routeHostPath = String(routes?.[normalizedRouteKey]?.hostPath || '').trim();
    const routeManifest = readJsonFileIfExists(routeHostPath ? path.join(routeHostPath, 'manifest.json') : '');
    if (routeManifest) return routeManifest;

    let resolved = null;
    try {
        resolved = resolveEnabledAgentRecord(normalizedRouteKey);
    } catch (_) {
        resolved = null;
    }
    const record = resolved?.record || null;
    if (!record?.repoName || !record?.agentName) return null;

    try {
        const found = findAgent(`${record.repoName}/${record.agentName}`);
        return readJsonFileIfExists(found?.manifestPath || '');
    } catch (_) {
        return null;
    }
}
