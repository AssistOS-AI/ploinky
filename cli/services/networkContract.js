import crypto from 'crypto';

export const NETWORK_MODES = Object.freeze(['default', 'none', 'host', 'bridge']);
export const NETWORK_SCHEMA_VERSION = '2';

const NETWORK_FIELDS = new Set(['mode', 'attachments']);
const ATTACHMENT_FIELDS = new Set(['name', 'primary']);
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function fail(path, message) {
    const error = new Error(`${path}: ${message}`);
    error.code = 'PLOINKY_NETWORK_CONTRACT_INVALID';
    throw error;
}

function objectAt(value, path) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        fail(path, 'network must be an object');
    }
    return value;
}

function rejectUnknownFields(value, allowed, path) {
    for (const key of Object.keys(value)) {
        if (!allowed.has(key)) fail(`${path}.${key}`, `unsupported field '${key}'`);
    }
}

export function canonicalizeNetwork(value, { path = 'manifest.network' } = {}) {
    if (value === undefined) return Object.freeze({ mode: 'default' });
    const network = objectAt(value, path);
    rejectUnknownFields(network, NETWORK_FIELDS, path);
    if (Object.hasOwn(network, 'name') || Object.hasOwn(network, 'aliases')) {
        fail(path, "legacy 'name'/'aliases' network fields are unsupported");
    }
    const mode = typeof network.mode === 'string' ? network.mode.trim() : '';
    if (!NETWORK_MODES.includes(mode)) {
        fail(`${path}.mode`, `expected exactly one of ${NETWORK_MODES.join(', ')}`);
    }

    if (mode !== 'bridge') {
        if (Object.hasOwn(network, 'attachments')) {
            fail(`${path}.attachments`, `attachments are only valid for mode 'bridge'`);
        }
        return Object.freeze({ mode });
    }

    if (!Array.isArray(network.attachments) || network.attachments.length === 0) {
        fail(`${path}.attachments`, "mode 'bridge' requires a nonempty attachments array");
    }
    const names = new Set();
    let primaryCount = 0;
    const attachments = network.attachments.map((raw, index) => {
        const attachmentPath = `${path}.attachments[${index}]`;
        const attachment = objectAt(raw, attachmentPath);
        rejectUnknownFields(attachment, ATTACHMENT_FIELDS, attachmentPath);
        const name = typeof attachment.name === 'string' ? attachment.name.trim() : '';
        if (!DNS_LABEL.test(name)) {
            fail(`${attachmentPath}.name`, 'attachment name must be a lowercase portable DNS label (1-63 characters)');
        }
        if (names.has(name)) fail(`${attachmentPath}.name`, `duplicate attachment '${name}'`);
        names.add(name);
        if (Object.hasOwn(attachment, 'primary') && typeof attachment.primary !== 'boolean') {
            fail(`${attachmentPath}.primary`, 'primary must be boolean when present');
        }
        const primary = attachment.primary === true;
        if (primary) primaryCount += 1;
        return Object.freeze(primary ? { name, primary: true } : { name });
    });
    if (primaryCount !== 1) {
        fail(`${path}.attachments`, "mode 'bridge' requires exactly one attachment with primary:true");
    }
    return Object.freeze({ mode, attachments: Object.freeze(attachments) });
}

export function effectiveManifestNetwork(manifest, profileName = 'default', { path = 'manifest' } = {}) {
    const source = manifest && typeof manifest === 'object' && !Array.isArray(manifest) ? manifest : {};
    const root = canonicalizeNetwork(source.network, { path: `${path}.network` });
    const profile = source.profiles?.[profileName];
    if (!profile || !Object.hasOwn(profile, 'network')) return root;
    return canonicalizeNetwork(profile.network, { path: `${path}.profiles.${profileName}.network` });
}

export function validateManifestNetworks(manifest, { path = 'manifest' } = {}) {
    const source = manifest && typeof manifest === 'object' && !Array.isArray(manifest) ? manifest : {};
    canonicalizeNetwork(source.network, { path: `${path}.network` });
    if (source.profiles !== undefined) {
        if (!source.profiles || typeof source.profiles !== 'object' || Array.isArray(source.profiles)) {
            fail(`${path}.profiles`, 'profiles must be an object');
        }
        for (const [profileName, profile] of Object.entries(source.profiles)) {
            if (!profile || typeof profile !== 'object' || Array.isArray(profile)) continue;
            if (Object.hasOwn(profile, 'network')) {
                canonicalizeNetwork(profile.network, { path: `${path}.profiles.${profileName}.network` });
            }
        }
    }
    return true;
}

export function deriveNetworkAlias(canonicalAgentId, { path = 'agent id' } = {}) {
    const alias = String(canonicalAgentId || '')
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '');
    if (!alias) fail(path, 'does not produce a nonempty network alias');
    if (alias.length > 63) fail(path, 'produces a network alias longer than 63 characters');
    return alias;
}

export function logicalNetworkAttachments(network, canonicalAgentId, { instanceKey = canonicalAgentId } = {}) {
    const contract = canonicalizeNetwork(network, { path: 'network' });
    if (contract.mode === 'none' || contract.mode === 'host') return [];
    if (contract.mode === 'default') {
        const instanceHash = crypto.createHash('sha256').update(String(instanceKey)).digest('hex').slice(0, 12);
        return [{ name: `default-${instanceHash}`, primary: true }];
    }
    return contract.attachments.map((attachment) => ({ ...attachment }));
}

export function networkContractHash(network) {
    const canonical = canonicalizeNetwork(network, { path: 'network' });
    return crypto.createHash('sha256').update(JSON.stringify({
        schemaVersion: NETWORK_SCHEMA_VERSION,
        runtimePolicy: 'box-host-gateway-v1',
        network: canonical,
    })).digest('hex');
}

function readinessIsNetworkDependent(manifest) {
    const readiness = manifest?.readiness || {};
    const healthReadiness = manifest?.health?.readiness || {};
    const values = [
        readiness.protocol,
        readiness.type,
        readiness.url,
        healthReadiness.protocol,
        healthReadiness.type,
        healthReadiness.url,
        healthReadiness.port,
    ].map((value) => String(value || '').trim().toLowerCase());
    return values.some((value) => ['mcp', 'http', 'https', 'tcp'].includes(value)
        || /^https?:\/\//.test(value)
        || /^tcp:/.test(value));
}

export function assertNetworkStartupCompatibility(manifest, profileConfig, network, { path = 'manifest' } = {}) {
    const contract = canonicalizeNetwork(network, { path: `${path}.network` });
    if (contract.mode !== 'none') return contract;
    const executionHasAgentServer = !String(manifest?.start || '').trim()
        || Boolean(String(manifest?.agent || manifest?.commands?.run || '').trim());
    const openPorts = profileConfig?.openPorts ?? manifest?.openPorts;
    const additionalServerPort = profileConfig?.additionalServerPort ?? manifest?.additionalServerPort;
    if (executionHasAgentServer) fail(`${path}.network`, "mode 'none' rejects AgentServer startup");
    if (openPorts !== undefined && (!Array.isArray(openPorts) || openPorts.length > 0)) {
        fail(`${path}.network`, "mode 'none' rejects openPorts");
    }
    if (additionalServerPort !== undefined && additionalServerPort !== null && additionalServerPort !== '') {
        fail(`${path}.network`, "mode 'none' rejects additionalServerPort");
    }
    if (readinessIsNetworkDependent(manifest)) {
        fail(`${path}.network`, "mode 'none' rejects MCP/HTTP/TCP readiness");
    }
    return contract;
}

export function assertHostSandboxNetworkCompatibility(network, {
    path = 'manifest.network',
    runtime = 'host sandbox',
} = {}) {
    const contract = canonicalizeNetwork(network, { path });
    if (contract.mode !== 'host') {
        fail(
            path,
            `${runtime} requires an explicit network.mode 'host'; effective mode '${contract.mode}' is unsupported`,
        );
    }
    return contract;
}

export function preflightNetworkAliases(nodes = []) {
    const scopes = new Map();
    for (const node of nodes) {
        const network = canonicalizeNetwork(node.network, { path: `${node.path || node.agentRef || node.id || 'agent'}.network` });
        const alias = deriveNetworkAlias(node.canonicalAgentId || node.shortAgentName || node.agentId, {
            path: `${node.path || node.agentRef || node.id || 'agent'}.id`,
        });
        for (const attachment of logicalNetworkAttachments(
            network,
            node.canonicalAgentId || node.shortAgentName || node.agentId,
            { instanceKey: node.instanceKey || node.id || node.agentRef },
        )) {
            const prior = scopes.get(attachment.name)?.get(alias);
            if (prior) {
                fail('workspace.network', `network alias collision '${alias}' on '${attachment.name}' between ${prior} and ${node.agentRef || node.id}`);
            }
            if (!scopes.has(attachment.name)) scopes.set(attachment.name, new Map());
            scopes.get(attachment.name).set(alias, node.agentRef || node.id || alias);
        }
    }
    return true;
}
