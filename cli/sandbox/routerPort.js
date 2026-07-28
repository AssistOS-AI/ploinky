import fs from 'fs';

import { ROUTING_FILE } from '../utils/config.js';

const INITIAL_ROUTER_PORT = 8080;
const ROUTER_HOST_PORT_ENV = 'PLOINKY_ROUTER_HOST_PORT';
const ROUTER_ENV_NAMES = Object.freeze([
    'PLOINKY_ROUTER_HOST',
    'PLOINKY_ROUTER_PORT',
    'PLOINKY_ROUTER_URL',
    'PLOINKY_ROUTER_AUTHORITY',
    'PLOINKY_INTERNAL_ROUTER_URL',
    'PLOINKY_EDGE_TOPOLOGY_FILE',
]);
const ROUTER_HOST_BY_MODE = Object.freeze({
    default: 'host.containers.internal',
    bridge: 'host.containers.internal',
    host: '127.0.0.1',
});

function routerPortError(source, value) {
    const rendered = typeof value === 'string' ? JSON.stringify(value) : String(value);
    const error = new Error(`${source} must be exactly ${INITIAL_ROUTER_PORT} for the managed Router; --port selects only the outer loopback host port; received ${rendered}`);
    error.code = 'PLOINKY_ROUTER_PORT_INVALID';
    return error;
}

function parseRouterPort(value, { source = 'router port' } = {}) {
    if (value === INITIAL_ROUTER_PORT || value === String(INITIAL_ROUTER_PORT)) return INITIAL_ROUTER_PORT;
    throw routerPortError(source, value);
}

function parseRouterHostPort(value, { source = ROUTER_HOST_PORT_ENV } = {}) {
    const parsed = typeof value === 'number'
        ? value
        : (/^[1-9][0-9]{0,4}$/.test(String(value || '')) ? Number(value) : Number.NaN);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65535) {
        const error = new Error(`${source} must be an integer TCP port in 1..65535`);
        error.code = 'PLOINKY_ROUTER_HOST_PORT_INVALID';
        throw error;
    }
    return parsed;
}

function selectedRouterHostPort(env = process.env) {
    const value = env?.[ROUTER_HOST_PORT_ENV];
    return value === undefined
        ? INITIAL_ROUTER_PORT
        : parseRouterHostPort(value, { source: ROUTER_HOST_PORT_ENV });
}

function readPersistedRouterPortValue(routingFile) {
    let raw;
    try {
        raw = fs.readFileSync(routingFile, 'utf8');
    } catch (error) {
        if (error?.code === 'ENOENT') return { present: false, value: undefined };
        throw new Error(`could not read persisted router configuration '${routingFile}': ${error?.message || error}`, { cause: error });
    }

    let routing;
    try {
        routing = JSON.parse(raw);
    } catch (error) {
        const wrapped = new Error(`persisted router configuration '${routingFile}' is not valid JSON`, { cause: error });
        wrapped.code = 'PLOINKY_ROUTER_PORT_INVALID';
        throw wrapped;
    }
    if (!routing || typeof routing !== 'object' || Array.isArray(routing)) {
        const error = new Error(`persisted router configuration '${routingFile}' must be a JSON object`);
        error.code = 'PLOINKY_ROUTER_PORT_INVALID';
        throw error;
    }
    if (!Object.prototype.hasOwnProperty.call(routing, 'port')) {
        return { present: false, value: undefined };
    }
    return { present: true, value: routing.port };
}

function assertExplicitPortMatches(explicitPort, persistedPort) {
    if (explicitPort === undefined) return persistedPort;
    const explicit = parseRouterPort(explicitPort, { source: 'explicit router port' });
    if (explicit !== persistedPort) {
        const error = new Error(`explicit router port ${explicit} does not match persisted router port ${persistedPort}`);
        error.code = 'PLOINKY_ROUTER_PORT_MISMATCH';
        throw error;
    }
    return persistedPort;
}

function resolveInitialRouterPort({ explicitPort, routingFile = ROUTING_FILE } = {}) {
    const persisted = readPersistedRouterPortValue(routingFile);
    if (persisted.present) {
        const port = parseRouterPort(persisted.value, { source: `persisted router port in '${routingFile}'` });
        return assertExplicitPortMatches(explicitPort, port);
    }
    return explicitPort === undefined
        ? INITIAL_ROUTER_PORT
        : parseRouterPort(explicitPort, { source: 'explicit router port' });
}

function resolvePersistedRouterPort({ explicitPort, routingFile = ROUTING_FILE } = {}) {
    const persisted = readPersistedRouterPortValue(routingFile);
    if (!persisted.present) {
        const error = new Error(`persisted router port is required in '${routingFile}'; run initial workspace start first`);
        error.code = 'PLOINKY_ROUTER_PORT_REQUIRED';
        throw error;
    }
    const port = parseRouterPort(persisted.value, { source: `persisted router port in '${routingFile}'` });
    return assertExplicitPortMatches(explicitPort, port);
}

function normalizeNetworkMode(networkMode) {
    const mode = String(networkMode || 'default').trim().toLowerCase();
    if (mode === 'none' || Object.prototype.hasOwnProperty.call(ROUTER_HOST_BY_MODE, mode)) {
        return mode;
    }
    const error = new Error(`router endpoint cannot be resolved for unsupported network mode '${networkMode}'`);
    error.code = 'PLOINKY_NETWORK_CONTRACT_INVALID';
    throw error;
}

function buildRouterEndpoint(networkMode, validatedPort) {
    const mode = normalizeNetworkMode(networkMode);
    if (mode === 'none') return null;
    const port = parseRouterPort(validatedPort, { source: 'validated router port' });
    const host = ROUTER_HOST_BY_MODE[mode];
    const url = `http://${host}:${port}`;
    const env = Object.freeze({
        PLOINKY_ROUTER_HOST: host,
        PLOINKY_ROUTER_PORT: String(port),
        PLOINKY_ROUTER_URL: url,
    });
    return Object.freeze({ mode, host, port, url, env });
}

function assertRouterEndpoint(endpoint, networkMode, { explicitPort } = {}) {
    const mode = normalizeNetworkMode(networkMode);
    if (mode === 'none') {
        if (endpoint !== null) {
            const error = new Error('network mode none requires an explicit null router endpoint');
            error.code = 'PLOINKY_ROUTER_ENDPOINT_INVALID';
            throw error;
        }
        return null;
    }
    if (!endpoint || typeof endpoint !== 'object' || Array.isArray(endpoint)) {
        const error = new Error(`validated router endpoint is required for network mode '${mode}'`);
        error.code = 'PLOINKY_ROUTER_ENDPOINT_REQUIRED';
        throw error;
    }
    const expected = buildRouterEndpoint(mode, endpoint.port);
    if (explicitPort !== undefined) {
        assertExplicitPortMatches(explicitPort, expected.port);
    }
    if (endpoint.mode !== expected.mode || endpoint.host !== expected.host || endpoint.url !== expected.url) {
        const error = new Error(`router endpoint does not match the required '${mode}' transport endpoint`);
        error.code = 'PLOINKY_ROUTER_ENDPOINT_INVALID';
        throw error;
    }
    for (const [name, value] of Object.entries(expected.env)) {
        if (endpoint.env?.[name] !== value) {
            const error = new Error(`router endpoint environment '${name}' does not match the required '${mode}' endpoint`);
            error.code = 'PLOINKY_ROUTER_ENDPOINT_INVALID';
            throw error;
        }
    }
    return expected;
}

function resolveRouterEndpoint(networkMode, { explicitPort, routingFile = ROUTING_FILE } = {}) {
    const mode = normalizeNetworkMode(networkMode);
    if (mode === 'none') return null;
    const port = resolvePersistedRouterPort({ explicitPort, routingFile });
    return buildRouterEndpoint(mode, port);
}

export {
    INITIAL_ROUTER_PORT,
    ROUTER_HOST_PORT_ENV,
    ROUTER_ENV_NAMES,
    assertRouterEndpoint,
    buildRouterEndpoint,
    parseRouterPort,
    parseRouterHostPort,
    resolveInitialRouterPort,
    resolvePersistedRouterPort,
    resolveRouterEndpoint,
    selectedRouterHostPort,
};
