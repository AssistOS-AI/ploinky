function normalizeProfileServer(server, { mode = 'container' } = {}) {
    if (server === undefined || server === null || server === false || server === '') {
        return null;
    }
    if (typeof server === 'string') {
        return normalizeServerUrl(server, { mode });
    }
    if (server && typeof server === 'object' && !Array.isArray(server)) {
        const url = server.url || server.address || server.href;
        return normalizeServerUrl(url, {
            mode: server.mode || mode
        });
    }
    throw new Error('profile server must be a URL string or an object with url');
}

function normalizeServerUrl(rawUrl, { mode = 'container' } = {}) {
    const value = String(rawUrl || '').trim();
    if (!value) return null;
    let parsed;
    try {
        parsed = new URL(value);
    } catch (_) {
        throw new Error(`invalid profile server URL '${value}'`);
    }
    if (parsed.protocol !== 'http:') {
        throw new Error(`profile server URL must use http: got '${parsed.protocol}'`);
    }
    if (!parsed.hostname || !parsed.port) {
        throw new Error('profile server URL must include host and port');
    }
    const normalizedMode = String(mode || 'container').trim().toLowerCase();
    if (!['container', 'host'].includes(normalizedMode)) {
        throw new Error(`profile server mode must be 'container' or 'host', got '${mode}'`);
    }
    return {
        url: parsed.toString().replace(/\/$/, ''),
        mode: normalizedMode
    };
}

function isHostNetworkProfile(manifest, profileConfig) {
    const profileNetwork = profileConfig?.network && typeof profileConfig.network === 'object' ? profileConfig.network : null;
    const rootNetwork = manifest?.network && typeof manifest.network === 'object' ? manifest.network : null;
    const network = profileNetwork || rootNetwork;
    return String(network?.mode || '').trim().toLowerCase() === 'host';
}

function resolveProfileServer(manifest, profileConfig, { runtimeMode = 'container' } = {}) {
    const raw = profileConfig?.server;
    if (raw === undefined || raw === null || raw === false || raw === '') return null;
    const mode = runtimeMode === 'host' || isHostNetworkProfile(manifest, profileConfig)
        ? 'host'
        : 'container';
    return normalizeProfileServer(raw, { mode });
}

function profileServerContainerPort(profileServer) {
    if (!profileServer || String(profileServer.mode || '').trim().toLowerCase() !== 'container') {
        return 0;
    }
    try {
        const parsed = new URL(profileServer.url);
        const port = Number.parseInt(parsed.port, 10);
        return Number.isFinite(port) && port > 0 ? port : 0;
    } catch (_) {
        return 0;
    }
}

function findProfileServerPortMapping(profileServer, portMappings = []) {
    const containerPort = profileServerContainerPort(profileServer);
    if (!containerPort || !Array.isArray(portMappings)) return null;
    return portMappings.find((mapping) => {
        const mappedContainerPort = Number(mapping?.containerPort);
        const protocol = String(mapping?.protocol || 'tcp').trim().toLowerCase();
        return mappedContainerPort === containerPort && protocol === 'tcp';
    }) || null;
}

function createProfileServerPublish(profileServer, portMappings = []) {
    const containerPort = profileServerContainerPort(profileServer);
    if (!containerPort || findProfileServerPortMapping(profileServer, portMappings)) {
        return null;
    }
    return {
        publishArg: `127.0.0.1::${containerPort}`,
        mapping: {
            hostIp: '127.0.0.1',
            hostPort: 0,
            containerPort,
            protocol: 'tcp',
            profileServer: true
        }
    };
}

function resolvePublishedProfileServer(profileServer, portMappings = []) {
    if (!profileServer) return null;
    const mode = String(profileServer.mode || '').trim().toLowerCase();
    if (mode !== 'container') return profileServer;
    const mapping = findProfileServerPortMapping(profileServer, portMappings);
    const hostPort = Number(mapping?.hostPort);
    if (!Number.isFinite(hostPort) || hostPort <= 0) return null;
    const hostIp = normalizePublishedHostIp(mapping?.hostIp);
    const target = new URL(profileServer.url);
    target.hostname = hostIp;
    target.port = String(hostPort);
    return {
        url: target.toString().replace(/\/$/, ''),
        mode: 'host',
        containerUrl: profileServer.url
    };
}

function normalizePublishedHostIp(hostIp) {
    const value = String(hostIp || '').trim();
    if (!value || value === '0.0.0.0' || value === '::') return '127.0.0.1';
    return value;
}

export {
    createProfileServerPublish,
    findProfileServerPortMapping,
    isHostNetworkProfile,
    normalizeProfileServer,
    profileServerContainerPort,
    resolvePublishedProfileServer,
    resolveProfileServer
};
