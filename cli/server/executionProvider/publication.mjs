import { intervalsOverlap, parseManifestOpenPortSpec } from '../../../container/publish-spec.mjs';
import { AGENT_PORT_ROUTE } from '../agentPortConvention/parseSelector.js';
import { HttpRouteAccessPath } from '../policy/HttpRouteAccessPath.js';
import { resolveAgentExecutionMode } from '../../utils/runtime/startupReadiness.js';
import { hostNetworkProviderPorts, networkModeOf, readExecutionProviderDeclaration, routedRootPort, TASK_REFERENCE_ROUTE_KEY } from './declaration.mjs';
import { resolveManifestRuntimeProfile } from '../../utils/runtime/profileService.js';

// Publication-time checks of a provider declaration. They run before any
// container, process or registry mutation (enable planning and the service
// manager's preflight) and again when an edge generation is compiled.

export const EXECUTION_PROVIDER_INVALID = 'PLOINKY_EXECUTION_PROVIDER_INVALID';

function publicationError(routeKey, reason) {
    const error = new Error(`manifest(${routeKey}).executionProvider is refused: ${reason}`);
    error.code = EXECUTION_PROVIDER_INVALID;
    return error;
}

function plainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// The same reading the route providers use for a declared path: trimmed, with
// a missing leading slash added. Disabled declarations are read as well.
function declaredRouteSpecs(manifest) {
    const raw = manifest?.routerAccess?.httpRoutes;
    if (Array.isArray(raw)) return raw;
    if (plainObject(raw)) {
        return Object.entries(raw).map(([pathValue, value]) => (
            plainObject(value) ? { path: pathValue, ...value } : { path: pathValue, access: String(value || '') }
        ));
    }
    return [];
}

function routeSelectsPort(pathValue, routeKey, port) {
    const rawPath = String(pathValue ?? '').trim();
    if (!rawPath) return false;
    const agentRelative = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
    const normalized = HttpRouteAccessPath.normalize(agentRelative);
    // A path the providers would reject can never select the port.
    if (!normalized.ok) return false;
    const base = `/${AGENT_PORT_ROUTE}/${routeKey}/${port}`;
    // A declaration selects the port when it covers any path of it (a wildcard
    // above the port) or names a path at or below it.
    return [base, `${base}/`, `${base}/probe`].some((probe) => HttpRouteAccessPath.matches(probe, normalized.path))
        || normalized.prefix === base || normalized.prefix.startsWith(`${base}/`);
}

function staticPortValue(value) {
    let raw = value;
    if (plainObject(raw)) raw = Object.hasOwn(raw, 'value') ? raw.value : raw.default;
    if (raw === undefined || raw === null) return null;
    const text = String(raw).trim();
    return /^[0-9]+$/.test(text) ? Number(text) : null;
}

// Best-effort static reading of an `env.PORT` declaration (object or array
// form): a number, null when the declaration cannot be resolved statically
// (the launch-time check sees the resolved value), undefined when absent.
export function staticEnvPort(env) {
    if (Array.isArray(env)) {
        for (const entry of env) {
            if (typeof entry === 'string' && /^PORT(=|$)/.test(entry)) return staticPortValue(entry.slice(5));
            if (plainObject(entry) && entry.name === 'PORT') return staticPortValue(entry);
        }
        return undefined;
    }
    return plainObject(env) && Object.hasOwn(env, 'PORT') ? staticPortValue(env.PORT) : undefined;
}

// The implicit AgentServer port as far as it is known without the launch
// environment: 7000 unless an `env.PORT` declaration names another value, and
// null when such a declaration cannot be resolved statically.
export function staticAgentServerPort(manifest, profileConfig = null) {
    for (const env of [profileConfig?.env, manifest?.env]) {
        const declared = staticEnvPort(env);
        if (declared !== undefined) return declared;
    }
    return 7000;
}

function openPortSpecs(profileConfig) {
    const ports = profileConfig?.openPorts;
    if (!ports) return [];
    return (Array.isArray(ports) ? ports : [ports]).map((spec) => String(spec ?? '').trim()).filter(Boolean);
}

function mappingNumbers(mapping) {
    return [Number(mapping?.containerPort), Number(mapping?.hostPort)].filter((value) => Number.isInteger(value) && value > 0);
}

// Refuses the publication when it is not safe to declare the provider port.
// Returns the normalized declaration, or null when the manifest declares none.
//
//   routeKey          the declaring agent's route key (alias or agent name)
//   profileConfig     the effective (merged) profile of this launch, if any
//   portMappings      the launch's parsed open-port mappings, or a function
//                     returning them (called only for a provider)
//   agentServerPort   a number, or a function returning the resolved
//                     implicit AgentServer port; called only for a provider
//   registryPorts     the registry record's config.ports, if any
//   networkMode       the effective network mode ('host' reserves 8080/8081)
export function assertExecutionProviderPublication({
    manifest,
    routeKey,
    profileConfig = null,
    portMappings = [],
    agentServerPort = null,
    registryPorts = [],
    networkMode = 'bridge',
} = {}) {
    if (String(routeKey || '') === TASK_REFERENCE_ROUTE_KEY) {
        throw publicationError(routeKey, `the route key '${TASK_REFERENCE_ROUTE_KEY}' is reserved for the task-reference surface`);
    }
    const read = readExecutionProviderDeclaration(manifest, { routeKey });
    if (!read.present) return null;
    if (!read.valid) throw publicationError(routeKey, read.reason);
    const { declaration } = read;
    const port = declaration.port;
    const refuse = (reason) => { throw publicationError(routeKey, reason); };

    if (String(networkMode || '').toLowerCase() === 'host' && (port === 8080 || port === 8081)) {
        refuse(`port ${port} is reserved by the Router in host network mode`);
    }

    // Every profile, not only the selected one, plus the effective profile.
    const profiles = plainObject(manifest?.profiles) ? Object.entries(manifest.profiles) : [];
    const inspected = [...profiles, ['(effective)', profileConfig]];
    for (const [profileName, profile] of inspected) {
        if (!plainObject(profile)) continue;
        for (const spec of openPortSpecs(profile)) {
            let parsed;
            try {
                parsed = parseManifestOpenPortSpec(spec);
            } catch (error) {
                refuse(`profile '${profileName}' openPorts entry cannot be read: ${error.message}`);
            }
            const point = { start: port, end: port };
            if (intervalsOverlap(parsed.boxSide, point) || intervalsOverlap(parsed.privateContainer, point)) {
                refuse(`port ${port} appears in profile '${profileName}' openPorts '${spec}'`);
            }
        }
        if (staticEnvPort(profile.env) === port) refuse(`profile '${profileName}' env.PORT selects the provider port ${port}`);
    }
    if (staticEnvPort(manifest?.env) === port) refuse(`env.PORT selects the provider port ${port}`);

    const launchMappings = typeof portMappings === 'function' ? portMappings() : portMappings;
    for (const mapping of [...(launchMappings || []), ...(registryPorts || [])]) {
        if (mappingNumbers(mapping).includes(port)) refuse(`port ${port} appears in a published port mapping`);
    }

    for (const spec of declaredRouteSpecs(manifest)) {
        if (plainObject(spec) && routeSelectsPort(spec.path, routeKey, port)) {
            refuse(`routerAccess.httpRoutes declares a route that selects the provider port ${port}`);
        }
    }

    if (resolveAgentExecutionMode(manifest).type !== 'start_only') {
        const resolved = typeof agentServerPort === 'function' ? agentServerPort() : agentServerPort;
        const serverPort = resolved === null || resolved === undefined
            ? staticAgentServerPort(manifest, profileConfig)
            : Number(resolved);
        if (serverPort === port) refuse(`the AgentServer port is the provider port ${port}`);
        // Coordinator routes belong to the actual ordinary routed root port.
        if (serverPort !== null && declaration.coordinatorRoutes.some((entry) => entry.port !== serverPort)) {
            refuse(`coordinatorRoutes must name the routed root port ${serverPort}`);
        }
    }
    return declaration;
}

// Compile-time checks of one active route inside an edge generation. They use
// the profile exactly as launch merges it and the registry record's actual
// mappings, never an assumed container port.
function effectiveProfile(manifest, routeKey, record) {
    try {
        return resolveManifestRuntimeProfile(manifest, {
            agentName: routeKey,
            profileName: record?.profile || undefined,
            path: `manifest(${routeKey})`,
        });
    } catch (_) {
        return null;
    }
}

export function assertExecutionProviderRoute({ routeKey, route, manifest, record }) {
    if (!readExecutionProviderDeclaration(manifest, { routeKey }).present && routeKey !== TASK_REFERENCE_ROUTE_KEY) return null;
    const resolution = effectiveProfile(manifest, routeKey, record);
    const raw = plainObject(manifest?.profiles?.[String(record?.profile || '')]) ? manifest.profiles[String(record.profile)] : null;
    const profile = resolution ? resolution.profileConfig : raw;
    const networkMode = resolution ? String(resolution.network.mode || 'bridge').toLowerCase() : networkModeOf(manifest, record);
    const rootPort = routedRootPort({ manifest, record, route });
    const declaration = assertExecutionProviderPublication({
        manifest,
        routeKey,
        profileConfig: profile,
        registryPorts: Array.isArray(record?.config?.ports) ? record.config.ports : [],
        networkMode,
        // The registry mapping is authoritative once the route has a target.
        agentServerPort: rootPort,
    });
    if (declaration) {
        if (rootPort === declaration.port) {
            throw publicationError(routeKey, `the routed root target is the provider port ${declaration.port}`);
        }
        if (rootPort !== null && declaration.coordinatorRoutes.some((entry) => entry.port !== rootPort)) {
            throw publicationError(routeKey, `coordinatorRoutes must name the routed root port ${rootPort}`);
        }
    }
    return declaration;
}

// A root application is addressed by an agent-local port. It may not be the
// provider port of the route it names, nor, on a host-network route, the
// private port of any host-network provider (the loopback is shared).
export function assertExecutionProviderRootApplication({ hostname, rootApplication, routeKey, manifest, routes, manifests, agents }) {
    const port = Number(rootApplication?.port);
    const read = readExecutionProviderDeclaration(manifest, { routeKey });
    if (read.present && read.valid && port === read.declaration.port) {
        throw publicationError(routeKey, `edge host '${hostname}' rootApplication maps the provider port ${read.declaration.port}`);
    }
    const route = routes?.[routeKey];
    if (route && networkModeOf(manifest, agents?.[String(route.container || '')]) === 'host'
        && hostNetworkProviderPorts({ routes, manifests, agents }).has(port)) {
        throw publicationError(routeKey, `edge host '${hostname}' rootApplication on a host-network route maps the provider port ${port} of a host-network provider`);
    }
}
