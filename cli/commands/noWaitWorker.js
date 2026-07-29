// Detached helper that boots a single `no-wait` dependency in the background
// after `startWorkspace` has finished gating on its blocking dependencies.
//
// The script is invoked via `node noWaitWorker.js --container <name> ...` from
// `startWorkspace`, inherits the workspace cwd, env, and `PLOINKY_MASTER_KEY`,
// and writes:
//   - a single log stream at .ploinky/logs/no-wait/<container>.log (stdout+stderr)
//   - a structured status JSON at .ploinky/running/no-wait/<container>.json
// Failures here must never bubble up to the main start command; they are
// recorded durably so an operator can see what went wrong without losing the
// already-running blocking stack.
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as dockerSvc from '../sandbox/docker/index.js';
import { RUNNING_DIR } from '../utils/config.js';
import { resolveManifestRuntimeProfile } from '../utils/runtime/profileService.js';
import { resolveRouterEndpoint } from '../sandbox/routerPort.js';
import { mergeRoutingConfig, mergeRuntimeRoute } from '../server/routingFile.js';
import { resolveAgentReadinessProtocol } from '../utils/runtime/startupReadiness.js';
import { normalizeProbeConfig, runContainerScriptReadiness } from '../sandbox/docker/healthProbes.js';
import { loadAgents, saveAgents } from '../utils/workspace.js';
import {
    buildRelayReadinessRoute,
    waitForAgentReady,
} from '../server/utils/agentReadiness.js';
import {
    assertActiveEdgeRoutingSourcesCurrent,
    captureEdgeRoutingLifecycleMutationGeneration,
    withEdgeGenerationApplyLock,
} from '../sandbox/edgeGeneration.js';

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i += 1) {
        const token = argv[i];
        if (!token.startsWith('--')) continue;
        const key = token.slice(2);
        const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : '';
        out[key] = value;
        if (value) i += 1;
    }
    return out;
}

function camelKey(key) {
    return key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function statusPathFor(containerName, { runningDir = RUNNING_DIR } = {}) {
    return path.join(runningDir, 'no-wait', `${containerName}.json`);
}

export function writeStatus(containerName, payload, { runningDir = RUNNING_DIR } = {}) {
    const target = statusPathFor(containerName, { runningDir });
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
        fs.writeFileSync(temporary, JSON.stringify(payload, null, 2), {
            flag: 'wx',
            mode: 0o600,
        });
        fs.renameSync(temporary, target);
    } finally {
        try { fs.unlinkSync(temporary); } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
        }
    }
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForPriorWorker(rawStatusPath, {
    runningDir = RUNNING_DIR,
    timeoutMs = Number.parseInt(
        process.env.PLOINKY_NO_WAIT_SEQUENCE_TIMEOUT_MS || '900000',
        10,
    ),
    pollIntervalMs = 100,
    sleepFn = sleep,
} = {}) {
    if (!rawStatusPath) return;
    const statusPath = path.resolve(rawStatusPath);
    const allowedRoot = `${path.resolve(runningDir, 'no-wait')}${path.sep}`;
    if (!statusPath.startsWith(allowedRoot) || path.extname(statusPath) !== '.json') {
        throw new Error('no-wait predecessor status must be an exact file in the workspace no-wait status directory');
    }
    const deadline = Date.now() + Math.max(1000, timeoutMs);
    while (Date.now() < deadline) {
        try {
            const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
            if (status?.state === 'running' || status?.state === 'failed') {
                return Object.freeze({ state: status.state });
            }
            if (status?.state && status.state !== 'starting') {
                throw new Error(`no-wait predecessor has invalid state '${status.state}'`);
            }
        } catch (error) {
            if (error?.code !== 'ENOENT') {
                throw new Error(`no-wait predecessor status is invalid: ${error?.message || error}`);
            }
        }
        await sleepFn(pollIntervalMs);
    }
    throw new Error(`timed out waiting for no-wait predecessor status '${statusPath}'`);
}

async function upsertRoute(routeKey, route, {
    containerName,
    registryRecord,
    expectedIdentity,
    expectedSelector,
} = {}) {
    if (!containerName || !registryRecord || !expectedIdentity
        || !expectedSelector?.generation || !expectedSelector?.activationId) {
        throw new Error('no-wait route activation requires one exact runtime registry record and active selector');
    }
    const activationLifecycle = await waitForNoWaitRouteActivation(
        expectedIdentity,
        expectedSelector,
    );
    const activationSelector = Object.freeze({
        generation: activationLifecycle.generationDigest,
        activationId: activationLifecycle.selectorActivationId,
    });
    await mergeRoutingConfig((cfg) => {
        const agents = loadAgents();
        assertNoWaitLifecycleSnapshot({
            generation: {
                agents,
                routing: cfg,
            },
        }, expectedIdentity);
        agents[containerName] = registryRecord;
        saveAgents(agents, { coordinate: false });
        cfg.routes = cfg.routes || {};
        cfg.routes[routeKey] = mergeRuntimeRoute(
            cfg.routes[routeKey],
            route,
            { hostPort: route.hostPort },
        );
        return cfg;
    }, {
        reason: `no-wait-runtime-ready:${routeKey}`,
        validateActiveGeneration() {
            const active = assertActiveEdgeRoutingSourcesCurrent();
            if (active.selector.generation !== activationSelector.generation
                || active.selector.activationId !== activationSelector.activationId) {
                throw new Error(`no-wait lifecycle generation changed before route activation for '${routeKey}'`);
            }
            assertNoWaitLifecycleSnapshot(active, expectedIdentity);
            return active;
        },
        captureExpectedGeneration(active) {
            return captureEdgeRoutingLifecycleMutationGeneration(active);
        },
    });
}

export function assertNoWaitRegistryRecord(record, stagedRecord, {
    containerName,
    repoName,
    shortAgent,
    alias,
}) {
    const invariantFields = [
        ['type', 'agent'],
        ['repoName', repoName],
        ['agentName', shortAgent],
        ['alias', alias],
        ['instanceId', stagedRecord?.instanceId],
        ['enableGeneration', stagedRecord?.enableGeneration],
        ['profile', stagedRecord?.profile],
        ['runMode', stagedRecord?.runMode],
        ['projectPath', stagedRecord?.projectPath],
        ['develRepo', stagedRecord?.develRepo],
    ];
    const mismatch = !record || invariantFields.some(([field, expected]) => (
        String(record?.[field] || '') !== String(expected || '')
    )) || String(record?.auth?.mode || '') !== String(stagedRecord?.auth?.mode || '');
    if (mismatch) {
        throw new Error(`no-wait runtime returned a registry identity inconsistent with '${containerName}'`);
    }
    return record;
}

export async function cleanupNoWaitTaskOwnedCandidate(candidate, {
    cleanup = dockerSvc.cleanupExactAgentRuntimeCandidate,
} = {}) {
    if (candidate?.createdByThisLaunch !== true) return false;
    await Promise.resolve(cleanup(candidate));
    return true;
}

export function assertNoWaitLifecycleSnapshot(active, {
    containerName,
    repoName,
    shortAgent,
    alias,
    routeKey,
    agentPath,
}) {
    const record = active?.generation?.agents?.[containerName];
    if (!record || record.type !== 'agent'
        || String(record.repoName || '') !== repoName
        || String(record.agentName || '') !== shortAgent
        || String(record.alias || '') !== alias
        || !String(record.instanceId || '')
        || !String(record.enableGeneration || '')) {
        throw new Error(`no-wait lifecycle requires the exact staged registry identity for '${containerName}'`);
    }
    const route = active?.generation?.routing?.routes?.[routeKey];
    if (!route
        || String(route.container || '') !== containerName
        || String(route.repo || '') !== repoName
        || String(route.agent || '') !== shortAgent
        || String(route.alias || '') !== alias
        || !String(route.hostPath || '')
        || !String(agentPath || '')
        || path.resolve(String(route.hostPath)) !== path.resolve(String(agentPath))
        || Object.prototype.hasOwnProperty.call(route, 'hostPort')
        || Object.prototype.hasOwnProperty.call(route, 'serviceTargets')) {
        throw new Error(`no-wait lifecycle requires one exact target-less staged route for '${routeKey}'`);
    }
    const manifest = active?.generation?.manifests?.[routeKey];
    if (active?.selector && (!manifest || typeof manifest !== 'object' || Array.isArray(manifest))) {
        throw new Error(`no-wait lifecycle requires the active captured manifest for '${routeKey}'`);
    }
    return Object.freeze({
        record,
        manifest,
        generationDigest: String(active?.selector?.generation || ''),
        selectorActivationId: String(active?.selector?.activationId || ''),
        routerPort: Number(active?.generation?.routing?.port || 0),
        routerHostPort: Number(active?.generation?.routerHostPort || 0),
    });
}

function loadNoWaitLifecycle(identity) {
    return assertNoWaitLifecycleSnapshot(assertActiveEdgeRoutingSourcesCurrent(), identity);
}

export async function waitForNoWaitLifecycle(identity, {
    timeoutMs = Number.parseInt(
        process.env.PLOINKY_NO_WAIT_EDGE_TIMEOUT_MS || '180000',
        10,
    ),
    pollIntervalMs = 250,
    loadFn = loadNoWaitLifecycle,
    sleepFn = sleep,
} = {}) {
    const deadline = Date.now() + Math.max(1000, timeoutMs);
    while (Date.now() < deadline) {
        try {
            return loadFn(identity);
        } catch (error) {
            if (error?.code !== 'EDGE_GENERATION_INACTIVE') throw error;
        }
        await sleepFn(pollIntervalMs);
    }
    throw new Error(`timed out waiting for the active edge generation for '${identity.routeKey}'`);
}

export async function waitForNoWaitRouteActivation(identity, launchSelector, options = {}) {
    const lifecycle = await waitForNoWaitLifecycle(identity, options);
    if (lifecycle.generationDigest !== launchSelector?.generation) {
        throw new Error(`no-wait lifecycle generation changed before route activation for '${identity.routeKey}'`);
    }
    return lifecycle;
}

async function waitForNoWaitReadiness({
    manifest,
    shortAgent,
    containerName,
    hostPort,
    runtimeResult,
    networkMode,
    generationDigest,
}) {
    const protocol = resolveAgentReadinessProtocol(manifest);
    if (protocol === 'none') return;
    if (protocol === 'script') {
        const probe = normalizeProbeConfig('readiness', manifest?.health?.readiness);
        const result = await Promise.resolve(runContainerScriptReadiness(shortAgent, containerName, probe));
        if (result?.status !== 'success') {
            throw new Error(`readiness script failed (${result?.reason || 'unknown failure'})`);
        }
        return;
    }
    const readinessRoute = buildRelayReadinessRoute({
        route: { container: containerName, hostPort: Number(hostPort || 0) },
        manifest,
        runtimeResult,
        networkMode,
        generationDigest,
    });
    if (!readinessRoute.hostPort && !readinessRoute.relay) {
        throw new Error(`readiness protocol '${protocol}' requires one resolved private target or readiness.port`);
    }
    const ready = await waitForAgentReady(readinessRoute, {
        timeoutMs: Number.parseInt(process.env.PLOINKY_NO_WAIT_READY_TIMEOUT_MS || '120000', 10),
        intervalMs: Number.parseInt(process.env.PLOINKY_NO_WAIT_READY_INTERVAL_MS || '250', 10),
        probeTimeoutMs: Number.parseInt(process.env.PLOINKY_NO_WAIT_READY_PROBE_TIMEOUT_MS || '1000', 10),
        protocol,
    });
    if (!ready) throw new Error(`readiness protocol '${protocol}' did not succeed`);
}

async function main() {
    const rawArgs = parseArgs(process.argv.slice(2));
    const args = Object.fromEntries(Object.entries(rawArgs).map(([k, v]) => [camelKey(k), v]));
    const containerName = args.container;
    const shortAgent = args.shortAgent;
    const repoName = args.repo;
    const alias = args.alias || '';
    const routeKey = args.routeKey || alias || shortAgent;
    const manifestPath = args.manifestPath;
    const agentPath = args.agentPath || (manifestPath ? path.dirname(manifestPath) : '');
    const routerPort = args.routerPort || '';
    const profileName = args.profile || '';
    const waitForStatus = args.waitForStatus || '';

    if (!containerName || !shortAgent || !repoName || !manifestPath || !agentPath) {
        console.error('[no-wait] missing required arguments; refusing to run.');
        console.error('[no-wait] args:', JSON.stringify(args));
        process.exit(2);
    }

    const startedAt = new Date().toISOString();
    const baseStatus = {
        containerName,
        shortAgent,
        repoName,
        alias: alias || null,
        routeKey,
        manifestPath,
        agentPath,
        pid: process.pid,
        startedAt
    };
    writeStatus(containerName, { ...baseStatus, state: 'starting' });

    console.log(`[no-wait] ${shortAgent}: starting background launch (pid ${process.pid})`);

    let taskOwnedCandidate = null;
    try {
        await waitForPriorWorker(waitForStatus);
        const expectedIdentity = Object.freeze({
            containerName,
            repoName,
            shortAgent,
            alias,
            routeKey,
            agentPath,
        });
        // The workspace graph has already committed this exact target-less
        // identity. Keep that active generation serving while the detached
        // runtime starts; host-network launches are authorized by the exact
        // active-generation capability already compiled for this owner.
        const lifecycle = await waitForNoWaitLifecycle(expectedIdentity);
        const manifest = lifecycle.manifest;
        const activeProfile = String(lifecycle.record.profile || '');
        if (profileName && activeProfile && profileName !== activeProfile) {
            throw new Error(`no-wait lifecycle profile changed before launch for '${routeKey}'`);
        }
        if (routerPort && Number(routerPort) !== lifecycle.routerPort) {
            throw new Error(`no-wait lifecycle Router port changed before launch for '${routeKey}'`);
        }
        const profileResolution = resolveManifestRuntimeProfile(manifest, {
            agentName: `${repoName}/${shortAgent}`,
            profileName: activeProfile || profileName || undefined,
            path: `manifest(${repoName}/${shortAgent})`,
        });
        const routerEndpoint = resolveRouterEndpoint(profileResolution.network.mode, {
            explicitPort: lifecycle.routerPort || undefined,
        });
        const ensureOptions = {
            containerName,
            alias: alias || undefined,
            profileName: profileResolution.resolvedProfileName,
            profileResolution,
            routerEndpoint,
            forceRecreate: args.forceRecreate === '1',
            preservePreparedRegistryRecord: true,
            instanceId: lifecycle.record.instanceId,
            enableGeneration: lifecycle.record.enableGeneration,
        };
        const launch = () => dockerSvc.ensureAgentService(shortAgent, manifest, agentPath, ensureOptions);
        const result = profileResolution.network.mode === 'host'
            ? await withEdgeGenerationApplyLock(() => {
                const selected = loadNoWaitLifecycle(expectedIdentity);
                if (selected.generationDigest !== lifecycle.generationDigest
                    || selected.selectorActivationId !== lifecycle.selectorActivationId) {
                    throw new Error(`no-wait lifecycle generation changed before host launch for '${routeKey}'`);
                }
                return launch();
            })
            : await launch();
        if (result?.createdByThisLaunch === true) taskOwnedCandidate = result;
        const resolvedContainerName = (result && result.containerName) || containerName;
        if (resolvedContainerName !== containerName) {
            throw new Error(`no-wait runtime resolved an unexpected container identity for '${routeKey}'`);
        }
        const hostPort = result && result.hostPort;
        const registryRecord = result && result.registryRecord;
        assertNoWaitRegistryRecord(registryRecord, lifecycle.record, expectedIdentity);
        const routedHostPort = profileResolution.network.mode === 'none'
            ? null
            : hostPort || null;

        await waitForNoWaitReadiness({
            manifest,
            shortAgent,
            containerName: resolvedContainerName,
            hostPort,
            runtimeResult: result,
            networkMode: profileResolution.network.mode,
            generationDigest: lifecycle.generationDigest,
        });

        await upsertRoute(routeKey, {
            container: resolvedContainerName,
            hostPath: agentPath,
            repo: repoName,
            agent: shortAgent,
            ...(alias ? { alias } : {}),
            hostPort: routedHostPort,
        }, {
            containerName: resolvedContainerName,
            registryRecord,
            expectedIdentity,
            expectedSelector: {
                generation: lifecycle.generationDigest,
                activationId: lifecycle.selectorActivationId,
            },
        });
        taskOwnedCandidate = null;

        const finishedAt = new Date().toISOString();
        writeStatus(containerName, {
            ...baseStatus,
            state: 'running',
            finishedAt,
            container: resolvedContainerName,
            hostPort: routedHostPort
        });
        console.log(`[no-wait] ${shortAgent}: launch succeeded (container=${resolvedContainerName}${hostPort ? `, hostPort=${hostPort}` : ''})`);
    } catch (err) {
        const failure = err instanceof Error ? err : new Error(String(err));
        try {
            await cleanupNoWaitTaskOwnedCandidate(taskOwnedCandidate);
        } catch (_) {
            failure.message = `${failure.message}; exact task-owned runtime cleanup failed`;
        }
        const finishedAt = new Date().toISOString();
        const error = {
            message: failure.message,
            stack: failure.stack || null
        };
        writeStatus(containerName, {
            ...baseStatus,
            state: 'failed',
            finishedAt,
            error
        });
        console.error(`[no-wait] ${shortAgent}: launch failed: ${error.message}`);
        if (err?.stack) console.error(err.stack);
        process.exit(1);
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((err) => {
        console.error('[no-wait] worker crashed:', err?.message || err);
        if (err?.stack) console.error(err.stack);
        process.exit(1);
    });
}
