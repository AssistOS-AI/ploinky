import crypto from 'node:crypto';
import net from 'node:net';

export const CLOUDFLARE_ORIGIN = 'http://127.0.0.1:8080';
export const CLOUDFLARE_TERMINAL_SERVICE = 'http_status:404';

const CONFIGURATION_GENERATION = /^sha256:[a-f0-9]{64}$/;
const SCOPE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SECRET_HANDLE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const REQUIRED_CLOUDFLARE_FIELDS = Object.freeze([
    'accountId',
    'zoneId',
    'tunnelId',
    'tunnelTokenSecret',
    'apiTokenSecret',
]);
const CONNECTOR_ONLY_FIELDS = Object.freeze([
    'tunnelTokenSecret',
]);
const SUPPORTED_CLOUDFLARE_FIELDS = new Set(REQUIRED_CLOUDFLARE_FIELDS);

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
        return Object.freeze({ management: null, tuple: null });
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
    const tuple = Object.fromEntries(
        REQUIRED_CLOUDFLARE_FIELDS.map((field) => [field, String(value[field] || '').trim()]),
    );
    const provided = Object.keys(value);
    const populated = REQUIRED_CLOUDFLARE_FIELDS.filter((field) => tuple[field]);
    const connectorOnly = provided.length === CONNECTOR_ONLY_FIELDS.length
        && CONNECTOR_ONLY_FIELDS.every((field) => (
            Object.prototype.hasOwnProperty.call(value, field) && tuple[field]
        ));
    const apiManaged = provided.length === REQUIRED_CLOUDFLARE_FIELDS.length
        && populated.length === REQUIRED_CLOUDFLARE_FIELDS.length;
    if (!connectorOnly && !apiManaged) {
        const missing = REQUIRED_CLOUDFLARE_FIELDS.filter((field) => !tuple[field]);
        fail(`Cloudflare configuration is partial; missing ${missing.join(', ')}`, {
            code: 'CLOUDFLARE_CONFIGURATION_PARTIAL',
            operation: 'validate',
        });
    }
    if (apiManaged) {
        for (const field of ['accountId', 'zoneId', 'tunnelId']) {
            if (!SCOPE_IDENTIFIER.test(tuple[field])) {
                fail(`Cloudflare ${field} is malformed`, {
                    code: 'CLOUDFLARE_CONFIGURATION_INVALID',
                    operation: 'validate',
                });
            }
        }
    }
    const secretFields = apiManaged
        ? ['tunnelTokenSecret', 'apiTokenSecret']
        : CONNECTOR_ONLY_FIELDS;
    for (const field of secretFields) {
        if (!SECRET_HANDLE.test(tuple[field])) {
            fail(`Cloudflare ${field} must be an opaque encrypted-store handle`, {
                code: 'CLOUDFLARE_CONFIGURATION_INVALID',
                operation: 'validate',
            });
        }
    }
    if (apiManaged && tuple.tunnelTokenSecret === tuple.apiTokenSecret) {
        fail('Cloudflare connector and API tokens require separate secret handles', {
            code: 'CLOUDFLARE_SECRET_SEPARATION_REQUIRED',
            operation: 'validate',
        });
    }
    return Object.freeze({
        management: apiManaged ? 'api-managed' : 'connector-only',
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
    const { management, tuple } = classified;
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
    if (!normalizedHosts.length) {
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
    const scope = {
        accountId: tuple.accountId,
        zoneId: tuple.zoneId,
        tunnelId: tuple.tunnelId,
    };
    const ingress = [
        ...normalizedHosts.map(({ hostname }) => ({ hostname, service: CLOUDFLARE_ORIGIN })),
        { service: CLOUDFLARE_TERMINAL_SERVICE },
    ];
    const dns = normalizedHosts.map(({ hostname }) => ({
        hostname,
        type: 'CNAME',
        content: `${scope.tunnelId}.cfargotunnel.com`,
        proxied: true,
        ttl: 1,
    }));
    const digestInput = {
        mode: 'cloudflare',
        management,
        configurationGeneration: generation,
        scope,
        hosts: normalizedHosts,
        ingress,
        dns,
    };
    return deepFreeze({
        ...digestInput,
        secretHandles: {
            tunnelToken: tuple.tunnelTokenSecret,
            apiToken: tuple.apiTokenSecret,
        },
        desiredDigest: publicationDigest(digestInput),
    });
}

export function publicPlanSummary(plan) {
    const value = {
        mode: plan?.mode === 'cloudflare' ? 'cloudflare' : 'local-only',
        management: plan?.mode === 'cloudflare'
            && ['connector-only', 'api-managed'].includes(plan?.management)
            ? plan.management
            : null,
        configurationGeneration: String(plan?.configurationGeneration || ''),
        desiredDigest: String(plan?.desiredDigest || ''),
        hostnames: Array.isArray(plan?.hosts) ? plan.hosts.map((entry) => entry.hostname) : [],
    };
    if (plan?.management === 'api-managed') value.scope = { ...plan.scope };
    return deepFreeze(value);
}
