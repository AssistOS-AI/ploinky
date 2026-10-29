import { AGENT_PORT_ROUTE, parseAgentPortSelector } from '../agentPortConvention/parseSelector.js';

// A provider declaration lets any agent name one private TCP port on which it
// serves Router-internal endpoints (task references and terminal control). The
// Router validates the declaration, refuses to relay the whole port to any
// request-derived caller and reaches the endpoints only through the internal
// planner. The grammar below is the only accepted spelling.
export const EXECUTION_PROVIDER_KEY = 'executionProvider';
export const EXECUTION_PROVIDER_VERSION = 1;
export const EXECUTION_PROVIDER_ENDPOINTS = Object.freeze(['taskReferences', 'terminals']);
export const EXECUTION_PROVIDER_LIMITS = Object.freeze({
    pathBytes: 1024,
    coordinatorRoutes: 32,
    coordinatorCallers: 16,
});
// Reserved Router mount and route key for the public task-reference surface.
export const TASK_REFERENCE_MOUNT = '/task-refs';
export const TASK_REFERENCE_ROUTE_KEY = 'task-refs';

const DECLARATION_KEYS = new Set(['version', 'port', 'taskReferences', 'terminals', 'coordinatorRoutes']);
const CALLER_PATTERN = /^agent:([^\s/:*\\%?#]+)\/([^\s/:*\\%?#]+)$/;

function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, expected) {
    const keys = Object.keys(value).sort();
    const target = [...expected].sort();
    return keys.length === target.length && keys.every((key, index) => key === target[index]);
}

function invalid(reason) {
    return { ok: false, reason };
}

// Shared by the endpoint paths and the coordinator selector paths: absolute,
// bounded, no controls or whitespace, no percent/query/fragment/backslash, no
// empty or dot segments and no trailing slash. Returns the segments.
function canonicalSegments(value, label) {
    if (typeof value !== 'string') return invalid(`${label} must be a string`);
    if (Buffer.byteLength(value, 'utf8') > EXECUTION_PROVIDER_LIMITS.pathBytes) {
        return invalid(`${label} exceeds ${EXECUTION_PROVIDER_LIMITS.pathBytes} bytes`);
    }
    if (!value.startsWith('/') || value === '/') return invalid(`${label} must be an absolute non-root path`);
    if (/[\u0000-\u001f\u007f-\u009f\s%?#\\]/u.test(value)) {
        return invalid(`${label} contains a control, whitespace, percent, query, fragment or backslash character`);
    }
    if (value.endsWith('/')) return invalid(`${label} must not end with a slash`);
    const segments = value.slice(1).split('/');
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
        return invalid(`${label} contains an empty or dot segment`);
    }
    return { ok: true, segments };
}

function segmentsCover(ancestor, descendant) {
    return ancestor.length <= descendant.length && ancestor.every((segment, index) => segment === descendant[index]);
}

function validateCoordinatorRoutes(value, { routeKey, port }) {
    if (!Array.isArray(value) || value.length < 1 || value.length > EXECUTION_PROVIDER_LIMITS.coordinatorRoutes) {
        return invalid(`coordinatorRoutes must be an array of 1 to ${EXECUTION_PROVIDER_LIMITS.coordinatorRoutes} entries`);
    }
    if (typeof routeKey !== 'string' || !routeKey) {
        return invalid('coordinatorRoutes need the declaring route key to be validated');
    }
    const entries = [];
    for (const [index, entry] of value.entries()) {
        const label = `coordinatorRoutes[${index}]`;
        if (!isPlainObject(entry) || !hasExactKeys(entry, ['path', 'callers'])) {
            return invalid(`${label} must be exactly {path, callers}`);
        }
        const wildcard = typeof entry.path === 'string' && entry.path.endsWith('/*');
        const core = wildcard ? entry.path.slice(0, -2) : entry.path;
        if (typeof core === 'string' && core.includes('*')) return invalid(`${label}.path allows a wildcard only as a trailing /*`);
        const shape = canonicalSegments(core, `${label}.path`);
        if (!shape.ok) return shape;
        if (core.includes(';')) return invalid(`${label}.path must not contain ';' (request path parameters are ignored when matching)`);
        let selector;
        try {
            selector = parseAgentPortSelector(core);
        } catch (error) {
            return invalid(`${label}.path is not a canonical agent-port selector: ${error.message}`);
        }
        if (!selector || selector.agent !== routeKey || selector.rawAgent !== routeKey
            || selector.query !== '' || selector.policyPath !== core) {
            return invalid(`${label}.path must be the declaring agent's canonical agent-port selector path`);
        }
        if (shape.segments.length < 4) return invalid(`${label}.path must name a path below the agent port`);
        // AgentServer's own MCP endpoint is never a coordinator route: the
        // signed hop would hand its Router Request to the MCP transport.
        if (shape.segments[3].toLowerCase() === 'mcp') return invalid(`${label}.path must not be the agent's /mcp endpoint`);
        if (selector.port === port) return invalid(`${label}.path must not use the private provider port`);
        const { callers } = entry;
        if (!Array.isArray(callers) || callers.length < 1 || callers.length > EXECUTION_PROVIDER_LIMITS.coordinatorCallers) {
            return invalid(`${label}.callers must be an array of 1 to ${EXECUTION_PROVIDER_LIMITS.coordinatorCallers} principals`);
        }
        if (new Set(callers).size !== callers.length) return invalid(`${label}.callers must be unique`);
        for (const caller of callers) {
            const match = typeof caller === 'string' ? CALLER_PATTERN.exec(caller) : null;
            if (!match || match[1] === '.' || match[1] === '..' || match[2] === '.' || match[2] === '..') {
                return invalid(`${label}.callers entries must be canonical full agent:<repo>/<agent> principals`);
            }
        }
        entries.push(Object.freeze({
            path: entry.path,
            port: selector.port,
            suffix: shape.segments.slice(3),
            wildcard,
            callers: Object.freeze([...callers]),
        }));
    }
    for (let i = 0; i < entries.length; i += 1) {
        for (let j = i + 1; j < entries.length; j += 1) {
            const left = entries[i];
            const right = entries[j];
            if (left.port !== right.port) continue;
            const overlap = (left.wildcard && segmentsCover(left.suffix, right.suffix))
                || (right.wildcard && segmentsCover(right.suffix, left.suffix))
                || (!left.wildcard && !right.wildcard && left.suffix.length === right.suffix.length
                    && segmentsCover(left.suffix, right.suffix));
            if (overlap) return invalid(`coordinatorRoutes[${i}] and coordinatorRoutes[${j}] overlap or repeat`);
        }
    }
    return { ok: true, entries: Object.freeze(entries) };
}

// Validates one declaration value. `routeKey` is the declaring agent's route
// key; it is required only to validate coordinator selector paths.
export function validateExecutionProviderDeclaration(value, { routeKey = '' } = {}) {
    if (!isPlainObject(value)) return invalid('the declaration must be a plain object');
    for (const key of Object.keys(value)) {
        if (!DECLARATION_KEYS.has(key)) return invalid(`unknown declaration key '${key}'`);
    }
    if (value.version !== EXECUTION_PROVIDER_VERSION) return invalid('version must be the number 1');
    if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535) {
        return invalid('port must be an integer from 1 to 65535');
    }
    const endpoints = {};
    for (const name of EXECUTION_PROVIDER_ENDPOINTS) {
        if (!Object.hasOwn(value, name)) continue;
        const endpoint = value[name];
        if (!isPlainObject(endpoint) || !hasExactKeys(endpoint, ['path'])) return invalid(`${name} must be exactly {path}`);
        const shape = canonicalSegments(endpoint.path, `${name}.path`);
        if (!shape.ok) return shape;
        endpoints[name] = Object.freeze({ path: endpoint.path, segments: Object.freeze(shape.segments) });
    }
    const declared = Object.keys(endpoints);
    if (declared.length === 0) return invalid('at least one of taskReferences and terminals is required');
    if (declared.length === 2) {
        const [left, right] = declared.map((name) => endpoints[name].segments);
        if (segmentsCover(left, right) || segmentsCover(right, left)) {
            return invalid('taskReferences and terminals paths must not be equal, ancestor or descendant of each other');
        }
    }
    let coordinatorRoutes = Object.freeze([]);
    if (Object.hasOwn(value, 'coordinatorRoutes')) {
        const coordinator = validateCoordinatorRoutes(value.coordinatorRoutes, { routeKey, port: value.port });
        if (!coordinator.ok) return coordinator;
        coordinatorRoutes = coordinator.entries;
    }
    return {
        ok: true,
        declaration: Object.freeze({
            version: EXECUTION_PROVIDER_VERSION,
            port: value.port,
            ...(endpoints.taskReferences ? { taskReferences: endpoints.taskReferences } : {}),
            ...(endpoints.terminals ? { terminals: endpoints.terminals } : {}),
            coordinatorRoutes,
        }),
    };
}

// Presence is the own property, whatever its value: an invalid declaration is
// an error, never the absence of a declaration.
export function readExecutionProviderDeclaration(manifest, { routeKey = '' } = {}) {
    if (!isPlainObject(manifest) || !Object.hasOwn(manifest, EXECUTION_PROVIDER_KEY)) return { present: false };
    const result = validateExecutionProviderDeclaration(manifest[EXECUTION_PROVIDER_KEY], { routeKey });
    return result.ok
        ? { present: true, valid: true, declaration: result.declaration }
        : { present: true, valid: false, reason: result.reason };
}

// A coordinator path is matched after rewriting, on the decoded and
// normalized path as well as the raw one, because the agent decodes it.
export function normalizedPathVariants(rawPath) {
    const variants = new Set();
    let current = String(rawPath || '');
    let undecodable = false;
    for (let pass = 0; pass < 4; pass += 1) {
        const resolved = [];
        for (const segment of current.split('/')) {
            if (segment === '' || segment === '.') continue;
            if (segment === '..') resolved.pop();
            else resolved.push(segment);
        }
        variants.add(resolved);
        let decoded;
        try {
            decoded = decodeURIComponent(current);
        } catch (_) {
            undecodable = true;
            break;
        }
        if (decoded === current) break;
        current = decoded;
    }
    return { variants: [...variants], undecodable };
}

// True when `suffixPath` (the path below the agent port, as the agent sees it)
// falls inside a declared coordinator route of `port`. The comparison ignores
// case and `;parameters` of each segment, because an agent's HTTP router may.
// A path that cannot be decoded is treated as a match: coordinator routes fail
// closed.
const foldSegment = (segment) => String(segment).split(';')[0].toLowerCase();
export function coordinatorRouteMatches(declaration, { port = null, suffixPath }) {
    if (!declaration?.coordinatorRoutes?.length) return false;
    const { variants, undecodable } = normalizedPathVariants(String(suffixPath || '').split('?')[0]);
    if (undecodable) return true;
    const folded = variants.map((segments) => segments.map(foldSegment));
    return declaration.coordinatorRoutes.some((entry) => {
        const wanted = entry.suffix.map(foldSegment);
        return (port === null || entry.port === port)
            && folded.some((segments) => (entry.wildcard
                ? segmentsCover(wanted, segments)
                : (segments.length === wanted.length && segmentsCover(wanted, segments))));
    });
}

// Decodes every valid single-byte escape and leaves anything else (including
// an invalid sequence) as written, so a path is never "undecodable".
function lenientDecode(value) {
    try {
        return decodeURIComponent(value);
    } catch (_) {
        return value.replace(/%([0-7][0-9a-fA-F])/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
    }
}

export function isTaskReferencePath(rawPath) {
    // Exact mount semantics after (lenient) decoding and slash collapsing; a
    // different first segment such as `/task-refs-extra` stays unrelated. An
    // undecodable tail never hides the mount: only the first segment decides.
    let current = String(rawPath || '');
    for (let pass = 0; pass < 4; pass += 1) {
        const segments = [];
        for (const segment of current.split('/')) {
            if (segment === '' || segment === '.') continue;
            if (segment === '..') segments.pop();
            else segments.push(segment);
        }
        if (segments[0] === TASK_REFERENCE_ROUTE_KEY) return true;
        const decoded = lenientDecode(current);
        if (decoded === current) return false;
        current = decoded;
    }
    return false;
}

export function agentPortPathFor(routeKey, port, suffix = '') {
    return `/${AGENT_PORT_ROUTE}/${routeKey}/${port}${suffix}`;
}

// The routed root's agent-local port: the registry mapping whose host side is
// the route's target in bridge mode, the route's own target in host mode.
// Returns null when it cannot be resolved (no target yet, or no such mapping).
export function routedRootPort({ manifest, record, route }) {
    const hostPort = Number(route?.hostPort);
    if (!Number.isSafeInteger(hostPort) || hostPort < 1 || hostPort > 65535) return null;
    if (networkModeOf(manifest, record) === 'host') return hostPort;
    const mapping = (Array.isArray(record?.config?.ports) ? record.config.ports : []).find((entry) => (
        Number(entry?.hostPort) === hostPort
        && String(entry?.protocol || 'tcp').trim().toLowerCase() === 'tcp'
        && Number.isInteger(Number(entry?.containerPort)) && Number(entry.containerPort) > 0
    ));
    return mapping ? Number(mapping.containerPort) : null;
}

export function networkModeOf(manifest, record) {
    const profile = manifest?.profiles?.[String(record?.profile || '')] || {};
    return String(profile?.network?.mode || manifest?.network?.mode || 'bridge').trim().toLowerCase();
}

// Declared ports of every active host-network provider. A host-network
// runtime shares the loopback, so each of these numbers is an alias for the
// provider's private port from any other host-network runtime.
export function hostNetworkProviderPorts({ routes, manifests, agents }) {
    const ports = new Set();
    for (const [routeKey, route] of Object.entries(routes || {})) {
        if (!route || route.disabled) continue;
        const record = agents?.[String(route.container || '')];
        if (networkModeOf(manifests?.[routeKey], record) !== 'host') continue;
        const read = readExecutionProviderDeclaration(manifests?.[routeKey], { routeKey });
        if (read.present && read.valid) ports.add(read.declaration.port);
    }
    return ports;
}
