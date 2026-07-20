import fs from 'fs';

import * as workspaceSvc from '../workspace.js';
import { ROUTING_FILE } from '../config.js';
import { resolvePersistedRouterPort } from '../../sandbox/routerPort.js';
import {
    resolveAgentDescriptor,
    listSsoProviders,
} from '../agentRegistry.js';

function readRouting() {
    try {
        return JSON.parse(fs.readFileSync(ROUTING_FILE, 'utf8')) || {};
    } catch (_) {
        return {};
    }
}

function getRouterPort() {
    return resolvePersistedRouterPort();
}

function extractShortAgentName(agentRef) {
    if (!agentRef) return '';
    const tokens = String(agentRef).split(/[/:]/).filter(Boolean);
    if (!tokens.length) return String(agentRef);
    return tokens[tokens.length - 1];
}

function getAgentHostPort(agentName) {
    if (!agentName) return null;
    const shortName = extractShortAgentName(agentName);
    const routing = readRouting();
    const routes = routing.routes || {};
    let route = routes[shortName] || routes[agentName];
    if (!route) {
        route = Object.values(routes || {}).find(entry => entry && entry.agent === shortName) || null;
    }
    if (!route) return null;
    if (Array.isArray(route.ports) && route.ports.length) {
        const preferred = route.ports.find(p => p && (p.primary || p.name === 'http')) || route.ports[0];
        const hostPort = parseInt(preferred?.hostPort, 10);
        if (!Number.isNaN(hostPort) && hostPort > 0) return hostPort;
    }
    if (route.portMap && typeof route.portMap === 'object') {
        const httpPort = parseInt(route.portMap.http, 10);
        if (!Number.isNaN(httpPort) && httpPort > 0) return httpPort;
        const first = Object.values(route.portMap).map(v => parseInt(v, 10)).find(v => !Number.isNaN(v) && v > 0);
        if (first) return first;
    }
    const fallback = parseInt(route.hostPort, 10);
    if (!Number.isNaN(fallback) && fallback > 0) return fallback;
    return null;
}

function normalizeBaseUrl(raw) {
    if (!raw) return '';
    let value = String(raw).trim();
    if (!value) return '';
    if (!/^https?:\/\//i.test(value)) {
        value = `http://${value}`;
    }
    try {
        const url = new URL(value);
        const normalizedPath = url.pathname && url.pathname !== '/' ? url.pathname.replace(/\/+$/, '') : '';
        return `${url.origin}${normalizedPath}`;
    } catch (_) {
        return value.replace(/\/+$/, '');
    }
}

function readWorkspaceSsoConfig() {
    const cfg = workspaceSvc.getConfig() || {};
    return cfg?.sso && typeof cfg.sso === 'object' ? cfg.sso : {};
}

function writeWorkspaceSsoConfig(nextSso) {
    const current = workspaceSvc.getConfig() || {};
    current.sso = nextSso || {};
    workspaceSvc.setConfig(current);
    return current.sso;
}

function getSsoConfig() {
    const sso = readWorkspaceSsoConfig();
    const providerAgent = sso.providerAgent || null;
    const providerAgentShort = extractShortAgentName(providerAgent);
    const providerConfig = sso.providerConfig && typeof sso.providerConfig === 'object'
        ? { ...sso.providerConfig }
        : {};

    return {
        enabled: Boolean(sso.enabled) && Boolean(providerAgent),
        providerAgent,
        providerAgentShort,
        providerConfig
    };
}

function setSsoConfig(partial = {}) {
    const current = readWorkspaceSsoConfig();
    const next = { ...current, ...partial };
    if (partial.providerConfig && typeof partial.providerConfig === 'object') {
        next.providerConfig = { ...(current.providerConfig || {}), ...partial.providerConfig };
    }
    if (partial.providerAgent !== undefined) {
        next.providerAgentShort = extractShortAgentName(partial.providerAgent);
    } else if (next.providerAgent) {
        next.providerAgentShort = extractShortAgentName(next.providerAgent);
    }
    return writeWorkspaceSsoConfig(next);
}

function setSsoEnabled(enabled = true) {
    const current = readWorkspaceSsoConfig();
    return writeWorkspaceSsoConfig({
        ...current,
        enabled: Boolean(enabled)
    });
}

function disableSsoConfig() {
    return setSsoEnabled(false);
}

function getSsoSecrets() {
    return { ...(getSsoConfig().providerConfig || {}) };
}

function gatherSsoStatus() {
    const config = getSsoConfig();
    return {
        config,
        secrets: getSsoSecrets(),
        routerPort: getRouterPort(),
        providerHostPort: getAgentHostPort(config.providerAgentShort)
    };
}

function bindSsoProvider(providerAgentRef, options = {}) {
    if (!providerAgentRef) {
        throw new Error('bindSsoProvider: providerAgentRef is required');
    }
    const descriptor = resolveAgentDescriptor(providerAgentRef);
    if (!descriptor) {
        throw new Error(`bindSsoProvider: agent '${providerAgentRef}' is not installed.`);
    }
    if (!descriptor.ssoProvider) {
        throw new Error(`bindSsoProvider: agent '${providerAgentRef}' is not marked with ssoProvider: true.`);
    }
    const current = readWorkspaceSsoConfig();
    writeWorkspaceSsoConfig({
        ...current,
        enabled: true,
        providerAgent: descriptor.agentRef,
        providerAgentShort: extractShortAgentName(descriptor.agentRef),
        providerConfig: options.providerConfig && typeof options.providerConfig === 'object'
            ? { ...(current.providerConfig || {}), ...options.providerConfig }
            : (current.providerConfig || {})
    });
    return {
        provider: descriptor.agentRef,
        agentRef: descriptor.agentRef,
        repo: descriptor.repo,
        agent: descriptor.agent,
        principalId: descriptor.principalId,
    };
}

function unbindSsoProvider() {
    const current = readWorkspaceSsoConfig();
    writeWorkspaceSsoConfig({
        ...current,
        enabled: false
    });
}

function listAuthProviders() {
    return listSsoProviders().map((descriptor) => ({
        agentRef: descriptor.agentRef,
        repo: descriptor.repo,
        agent: descriptor.agent,
        principalId: descriptor.principalId
    }));
}

export {
    getSsoConfig,
    setSsoConfig,
    setSsoEnabled,
    disableSsoConfig,
    getSsoSecrets,
    gatherSsoStatus,
    getRouterPort,
    getAgentHostPort,
    normalizeBaseUrl,
    extractShortAgentName,
    bindSsoProvider,
    unbindSsoProvider,
    listAuthProviders
};
