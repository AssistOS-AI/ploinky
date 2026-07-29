import crypto from 'node:crypto';
import net from 'node:net';

export const CLOUDFLARE_ORIGIN = 'http://127.0.0.1:8080';
export const CLOUDFLARE_TERMINAL_SERVICE = 'http_status:404';

const CONFIGURATION_GENERATION = /^sha256:[a-f0-9]{64}$/;
const SCOPE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SECRET_HANDLE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const EXISTING_TUNNEL_FIELDS = Object.freeze([
    'accountId',
    'zoneId',
    'tunnelId',
    'tunnelTokenSecret',
    'apiTokenSecret',
]);
const MANAGED_TUNNEL_REQUIRED_FIELDS = Object.freeze([
    'accountId',
    'zoneId',
    'tunnelName',
    'apiTokenSecret',
]);
const MANAGED_TUNNEL_OPTIONAL_FIELDS = Object.freeze([
    'deleteTunnelOnTeardown',
]);
const CONNECTOR_ONLY_FIELDS = Object.freeze([
    'tunnelTokenSecret',
]);
const SUPPORTED_CLOUDFLARE_FIELDS = new Set([
    ...EXISTING_TUNNEL_FIELDS,
    ...MANAGED_TUNNEL_REQUIRED_FIELDS,
    ...MANAGED_TUNNEL_OPTIONAL_FIELDS,
]);
const MANAGED_TUNNEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/;

export class CloudflarePublicationError extends Error {
    constructor(message, {
        code = 'CLOUDFLARE_PUBLICATION_ERROR',
        operation = 'publication',
        retryable = false,
    } = {}) {
        super(String(message || 'Cloudflare publication failed'));
        this.name = 'CloudflarePublicationError';
        this.code = code;
        this.operation = operation;
        this.retryable = Boolean(retryable);
    }
}
function fail(message, options = {}) {
    throw new CloudflarePublicationError(message, options);
}

function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function cloneJsonValue(value, label) {
    try {
        return JSON.parse(JSON.stringify(value));
    } catch (_) {
        fail(`${label} must be JSON-serializable`, {
            code: 'CLOUDFLARE_CONFIGURATION_INVALID',
            operation: 'validate',
        });
    }
}

function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) deepFreeze(child);
    return Object.freeze(value);
}

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!isPlainObject(value)) return value;
    return Object.fromEntries(
        Object.entries(value)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, child]) => [key, stableValue(child)]),
    );
}

export function stablePublicationJson(value) {
    return JSON.stringify(stableValue(value));
}

export function publicationDigest(value) {
    return `sha256:${crypto.createHash('sha256').update(stablePublicationJson(value)).digest('hex')}`;
}

export function redactCloudflareText(value, secrets = []) {
    let output = String(value ?? '');
    for (const secret of secrets) {
        const text = String(secret || '');
        if (text) output = output.split(text).join('[redacted]');
    }
    return output
        .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
        .replace(/([?&](?:token|key|secret)=)[^&#\s]+/gi, '$1[redacted]')
        .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted-jwt]');
}

export function toPublicationError(error, {
    code = 'CLOUDFLARE_PUBLICATION_ERROR',
    operation = 'publication',
    retryable = false,
    secrets = [],
} = {}) {
    if (error instanceof CloudflarePublicationError) {
        const sanitized = redactCloudflareText(error.message, secrets);
        if (sanitized === error.message) return error;
        return new CloudflarePublicationError(sanitized, {
            code: error.code,
            operation: error.operation,
            retryable: error.retryable,
        });
    }
    return new CloudflarePublicationError(
        redactCloudflareText(error?.message || error || 'Cloudflare publication failed', secrets),
        { code, operation, retryable },
    );
}

function normalizeConfigurationGeneration(value) {
    const generation = String(value || '').trim();
    if (!CONFIGURATION_GENERATION.test(generation)) {
        fail('Cloudflare publication requires an immutable sha256 configuration generation', {
            code: 'CLOUDFLARE_CONFIGURATION_INVALID',
            operation: 'validate',
        });
    }
    return generation;
}

export function normalizePublicHostname(value) {
    const hostname = String(value || '').trim();
    if (!hostname
        || hostname !== hostname.toLowerCase()
        || hostname.length > 253
        || hostname.endsWith('.')
        || hostname.includes('*')
        || net.isIP(hostname)
        || hostname === 'localhost'
        || hostname.endsWith('.localhost')) {
        fail('Cloudflare hostnames must be exact lower-case public DNS names', {
            code: 'CLOUDFLARE_HOST_INVALID',
            operation: 'validate',
        });
    }
    const labels = hostname.split('.');
    if (labels.length < 2 || labels.some((label) => !HOST_LABEL.test(label))) {
        fail('Cloudflare hostnames must be exact lower-case public DNS names', {
            code: 'CLOUDFLARE_HOST_INVALID',
            operation: 'validate',
        });
    }
    return hostname;
}

function normalizeHosts(value) {
    if (value === undefined || value === null) return [];
    if (!isPlainObject(value)) {
        fail('Cloudflare hosts must be an object keyed by exact hostname', {
            code: 'CLOUDFLARE_CONFIGURATION_INVALID',
            operation: 'validate',
        });
    }
    const hosts = [];
    for (const [rawHostname, rawSelector] of Object.entries(value)) {
        const hostname = normalizePublicHostname(rawHostname);
        if (!isPlainObject(rawSelector)) {
            fail(`Cloudflare host '${hostname}' must select a validated route`, {
                code: 'CLOUDFLARE_HOST_INVALID',
                operation: 'validate',
            });
        }
        const selector = cloneJsonValue(rawSelector, `Cloudflare host '${hostname}'`);
        if (!String(selector.agent || '').trim()) {
            fail(`Cloudflare host '${hostname}' is missing its validated agent selector`, {
                code: 'CLOUDFLARE_HOST_INVALID',
                operation: 'validate',
            });
        }
        hosts.push({ hostname, selector });
    }
    hosts.sort((left, right) => left.hostname.localeCompare(right.hostname));
    return hosts;
}

function normalizeCloudflareTuple(value) {
    if (value === undefined || value === null) {
        return Object.freeze({ management: null, tunnelManagement: null, tuple: null });
    }
    if (!isPlainObject(value)) {
        fail('Cloudflare configuration must be an object of scoped identifiers and secret handles', {
            code: 'CLOUDFLARE_CONFIGURATION_INVALID',
            operation: 'validate',
        });
    }
    const unexpected = Object.keys(value).filter((field) => !SUPPORTED_CLOUDFLARE_FIELDS.has(field));
    if (unexpected.length) {
        fail(`Cloudflare configuration contains unsupported field '${unexpected.sort()[0]}'`, {
            code: 'CLOUDFLARE_CONFIGURATION_INVALID',
            operation: 'validate',
        });
    }
    const stringFields = new Set([
        ...EXISTING_TUNNEL_FIELDS,
        ...MANAGED_TUNNEL_REQUIRED_FIELDS,
    ]);
    const tuple = Object.fromEntries(
        [...stringFields].map((field) => [field, String(value[field] || '').trim()]),
    );
    const provided = Object.keys(value);
    const connectorOnly = provided.length === CONNECTOR_ONLY_FIELDS.length
        && CONNECTOR_ONLY_FIELDS.every((field) => (
            Object.prototype.hasOwnProperty.call(value, field) && tuple[field]
        ));
    const existingTunnel = provided.length === EXISTING_TUNNEL_FIELDS.length
        && EXISTING_TUNNEL_FIELDS.every((field) => (
            Object.prototype.hasOwnProperty.call(value, field) && tuple[field]
        ));
    const managedAllowed = new Set([
        ...MANAGED_TUNNEL_REQUIRED_FIELDS,
        ...MANAGED_TUNNEL_OPTIONAL_FIELDS,
    ]);
    const managedTunnel = provided.every((field) => managedAllowed.has(field))
        && MANAGED_TUNNEL_REQUIRED_FIELDS.every((field) => (
            Object.prototype.hasOwnProperty.call(value, field) && tuple[field]
        ));
    if (!connectorOnly && !existingTunnel && !managedTunnel) {
        const expected = Object.prototype.hasOwnProperty.call(value, 'tunnelName')
            ? MANAGED_TUNNEL_REQUIRED_FIELDS
            : EXISTING_TUNNEL_FIELDS;
        const missing = expected.filter((field) => !tuple[field]);
        fail(`Cloudflare configuration is partial; missing ${missing.join(', ')}`, {
            code: 'CLOUDFLARE_CONFIGURATION_PARTIAL',
            operation: 'validate',
        });
    }
    if (existingTunnel || managedTunnel) {
        for (const field of ['accountId', 'zoneId']) {
            if (!SCOPE_IDENTIFIER.test(tuple[field])) {
                fail(`Cloudflare ${field} is malformed`, {
                    code: 'CLOUDFLARE_CONFIGURATION_INVALID',
                    operation: 'validate',
                });
            }
        }
    }
    if (existingTunnel && !SCOPE_IDENTIFIER.test(tuple.tunnelId)) {
        fail('Cloudflare tunnelId is malformed', {
            code: 'CLOUDFLARE_CONFIGURATION_INVALID',
            operation: 'validate',
        });
    }
    if (managedTunnel) {
        if (!MANAGED_TUNNEL_NAME.test(tuple.tunnelName)) {
            fail('Cloudflare tunnelName must use 1-48 letters, digits, dots, underscores, or hyphens', {
                code: 'CLOUDFLARE_CONFIGURATION_INVALID',
                operation: 'validate',
            });
        }
        if (Object.prototype.hasOwnProperty.call(value, 'deleteTunnelOnTeardown')
            && typeof value.deleteTunnelOnTeardown !== 'boolean') {
            fail('Cloudflare deleteTunnelOnTeardown must be a boolean', {
                code: 'CLOUDFLARE_CONFIGURATION_INVALID',
                operation: 'validate',
            });
        }
        tuple.deleteTunnelOnTeardown = value.deleteTunnelOnTeardown === true;
    }
    const secretFields = existingTunnel
        ? ['tunnelTokenSecret', 'apiTokenSecret']
        : managedTunnel
            ? ['apiTokenSecret']
            : CONNECTOR_ONLY_FIELDS;
    for (const field of secretFields) {
        if (!SECRET_HANDLE.test(tuple[field])) {
            fail(`Cloudflare ${field} must be an opaque encrypted-store handle`, {
                code: 'CLOUDFLARE_CONFIGURATION_INVALID',
                operation: 'validate',
            });
        }
    }
    if (existingTunnel && tuple.tunnelTokenSecret === tuple.apiTokenSecret) {
        fail('Cloudflare connector and API tokens require separate secret handles', {
            code: 'CLOUDFLARE_SECRET_SEPARATION_REQUIRED',
            operation: 'validate',
        });
    }
    return Object.freeze({
        management: existingTunnel || managedTunnel ? 'api-managed' : 'connector-only',
        tunnelManagement: existingTunnel
            ? 'existing'
            : managedTunnel
                ? 'ploinky-managed'
                : null,
        tuple,
    });
}

export function normalizeCloudflarePublicationDesired({
    configurationGeneration,
    cloudflare,
    hosts,
} = {}) {
    const generation = normalizeConfigurationGeneration(configurationGeneration);
    const normalizedHosts = normalizeHosts(hosts);
    const classified = normalizeCloudflareTuple(cloudflare);
    const { management, tunnelManagement, tuple } = classified;
    if (!management && normalizedHosts.length) {
        fail('Cloudflare hostnames require Cloudflare publication configuration', {
            code: 'CLOUDFLARE_CONFIGURATION_PARTIAL',
            operation: 'validate',
        });
    }
    if (!management) {
        return deepFreeze({
            mode: 'local-only',
            management: null,
            configurationGeneration: generation,
            hosts: [],
            desiredDigest: publicationDigest({
                mode: 'local-only',
                management: null,
                configurationGeneration: generation,
            }),
        });
    }
    if (!normalizedHosts.length && management === 'connector-only') {
        fail('Complete Cloudflare mode requires at least one valid hostname', {
            code: 'CLOUDFLARE_CONFIGURATION_PARTIAL',
            operation: 'validate',
        });
    }
    if (management === 'connector-only') {
        const digestInput = {
            mode: 'cloudflare',
            management,
            configurationGeneration: generation,
            originService: CLOUDFLARE_ORIGIN,
            hosts: normalizedHosts,
        };
        return deepFreeze({
            ...digestInput,
            secretHandles: {
                tunnelToken: tuple.tunnelTokenSecret,
            },
            desiredDigest: publicationDigest(digestInput),
        });
    }
    const existingTunnel = tunnelManagement === 'existing';
    const scope = existingTunnel ? {
        accountId: tuple.accountId,
        zoneId: tuple.zoneId,
        tunnelId: tuple.tunnelId,
    } : null;
    const managedTunnel = existingTunnel ? null : {
        name: tuple.tunnelName,
        deleteOnTeardown: tuple.deleteTunnelOnTeardown === true,
    };
    if (!normalizedHosts.length) {
        const digestInput = {
            mode: 'local-only',
            management: 'api-managed',
            tunnelManagement,
            configurationGeneration: generation,
            ...(scope ? { scope } : {
                accountId: tuple.accountId,
                zoneId: tuple.zoneId,
                managedTunnel,
            }),
            hosts: [],
        };
        return deepFreeze({
            ...digestInput,
            secretHandles: {
                apiToken: tuple.apiTokenSecret,
                ...(existingTunnel ? { tunnelToken: tuple.tunnelTokenSecret } : {}),
            },
            desiredDigest: publicationDigest(digestInput),
        });
    }
    const ingress = [
        ...normalizedHosts.map(({ hostname }) => ({ hostname, service: CLOUDFLARE_ORIGIN })),
        { service: CLOUDFLARE_TERMINAL_SERVICE },
    ];
    const dns = scope ? normalizedHosts.map(({ hostname }) => ({
        hostname,
        type: 'CNAME',
        content: `${scope.tunnelId}.cfargotunnel.com`,
        proxied: true,
        ttl: 1,
    })) : null;
    const digestInput = {
        mode: 'cloudflare',
        management,
        tunnelManagement,
        configurationGeneration: generation,
        ...(scope ? { scope } : {
            accountId: tuple.accountId,
            zoneId: tuple.zoneId,
            managedTunnel,
        }),
        hosts: normalizedHosts,
        ingress,
        ...(scope ? { dns } : {}),
    };
    return deepFreeze({
        ...digestInput,
        secretHandles: {
            apiToken: tuple.apiTokenSecret,
            ...(existingTunnel ? { tunnelToken: tuple.tunnelTokenSecret } : {}),
        },
        desiredDigest: publicationDigest(digestInput),
    });
}

export function materializeManagedCloudflarePublicationPlan(plan, tunnelId) {
    if (plan?.management !== 'api-managed' || plan?.tunnelManagement !== 'ploinky-managed') {
        return plan;
    }
    const normalizedTunnelId = String(tunnelId || '').trim();
    if (!SCOPE_IDENTIFIER.test(normalizedTunnelId)) {
        fail('Cloudflare managed tunnel resolution returned a malformed tunnel id', {
            code: 'CLOUDFLARE_MANAGED_TUNNEL_INVALID',
            operation: 'resolve-managed-tunnel',
        });
    }
    const scope = {
        accountId: plan.accountId,
        zoneId: plan.zoneId,
        tunnelId: normalizedTunnelId,
    };
    const materialized = {
        ...plan,
        scope,
    };
    if (plan.mode === 'cloudflare') {
        materialized.dns = plan.hosts.map(({ hostname }) => ({
            hostname,
            type: 'CNAME',
            content: `${normalizedTunnelId}.cfargotunnel.com`,
            proxied: true,
            ttl: 1,
        }));
    }
    return deepFreeze(materialized);
}

export function publicPlanSummary(plan) {
    const value = {
        mode: plan?.mode === 'cloudflare' ? 'cloudflare' : 'local-only',
        management: plan?.mode === 'cloudflare'
            && ['connector-only', 'api-managed'].includes(plan?.management)
            ? plan.management
            : null,
        tunnelManagement: plan?.management === 'api-managed'
            && ['existing', 'ploinky-managed'].includes(plan?.tunnelManagement)
            ? plan.tunnelManagement
            : null,
        configurationGeneration: String(plan?.configurationGeneration || ''),
        desiredDigest: String(plan?.desiredDigest || ''),
        hostnames: Array.isArray(plan?.hosts) ? plan.hosts.map((entry) => entry.hostname) : [],
    };
    if (plan?.management === 'api-managed' && plan?.scope) value.scope = { ...plan.scope };
    return deepFreeze(value);
}
