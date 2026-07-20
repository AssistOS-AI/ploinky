import fs from 'fs';

import * as workspaceSvc from '../workspace.js';
import { ROUTING_FILE } from '../config.js';
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
    const routing = readRouting();
    const fromRouting = parseInt(routing.port, 10);
    if (!Number.isNaN(fromRouting) && fromRouting > 0) return fromRouting;
    try {
        const cfg = workspaceSvc.getConfig() || {};
        const staticPort = parseInt(cfg?.static?.port, 10);
        if (!Number.isNaN(staticPort) && staticPort > 0) return staticPort;
    } catch (_) {}
    return 8080;
}

function extractShortAgentName(agentRef) {
    if (!agentRef) return '';
    const tokens = String(agentRef).split(/[/:]/).filter(Boolean);
    if (!tokens.length) return String(agentRef);
    return tokens[tokens.length - 1];
}

function getAgentPrimaryPort(agentName) {
    if (!agentName) return null;
    const shortName = extractShortAgentName(agentName);
    const routing = readRouting();
    const routes = routing.routes || {};
    let route = routes[shortName] || routes[agentName];
    if (!route) {
        route = Object.values(routes || {}).find(entry => entry && entry.agent === shortName) || null;
    }
    if (!route) return null;
    const primary = Number(route.primaryService?.port);
    return Number.isInteger(primary) && primary > 0 && primary <= 65535 ? primary : null;
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
        providerAgentPort: getAgentPrimaryPort(config.providerAgentShort)
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
    getAgentPrimaryPort,
    normalizeBaseUrl,
    extractShortAgentName,
    bindSsoProvider,
    unbindSsoProvider,
    listAuthProviders
};
