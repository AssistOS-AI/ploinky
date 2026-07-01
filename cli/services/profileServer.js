function normalizeProfileServer(additionalServerPort, { mode = 'container' } = {}) {
    if (additionalServerPort === undefined || additionalServerPort === null || additionalServerPort === false || additionalServerPort === '') {
        return null;
    }
    if (typeof additionalServerPort === 'string' || typeof additionalServerPort === 'number') {
        return normalizeAdditionalServerPort(additionalServerPort, { mode });
    }
    throw new Error('additionalServerPort must be a port or host:port string');
}

function normalizeAdditionalServerPort(rawValue, { mode = 'container' } = {}) {
    const value = String(rawValue || '').trim();
    if (!value) return null;
    if (value.includes('://')) {
        throw new Error(`invalid additionalServerPort '${value}': expected port or host:port`);
    }

    const target = value.includes(':') ? value : `127.0.0.1:${value}`;
    let parsed;
    try {
        parsed = new URL(`http://${target}`);
    } catch (_) {
        throw new Error(`invalid additionalServerPort '${value}': expected port or host:port`);
    }
    const port = Number.parseInt(parsed.port, 10);
    if (!parsed.hostname || !Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new Error(`invalid additionalServerPort '${value}': expected port or host:port`);
    }
    const normalizedMode = String(mode || 'container').trim().toLowerCase();
    if (!['container', 'host'].includes(normalizedMode)) {
        throw new Error(`additionalServerPort mode must be 'container' or 'host', got '${mode}'`);
    }
    return {
        url: `http://${parsed.hostname}:${parsed.port}`,
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
    if (profileConfig && Object.prototype.hasOwnProperty.call(profileConfig, 'server')) {
        throw new Error("profile field 'server' has been renamed to 'additionalServerPort'");
    }
    const raw = profileConfig?.additionalServerPort;
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
