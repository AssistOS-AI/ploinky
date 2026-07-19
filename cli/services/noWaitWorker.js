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
import * as dockerSvc from './docker/index.js';
import { RUNNING_DIR } from './config.js';
import { resolveManifestRuntimeProfile } from './profileService.js';
import { resolveRouterEndpoint } from './routerPort.js';
import { mergeRoutingConfig, mergeRuntimeRoute, readRoutingConfig } from './routingFile.js';
import { resolveAgentReadinessProtocol } from './startupReadiness.js';
import { normalizeProbeConfig, runContainerScriptReadiness } from './docker/healthProbes.js';
import { loadAgents, saveAgents } from './workspace.js';
import { waitForAgentReady } from '../server/utils/agentReadiness.js';
import {
    abortEdgeRoutingPreparation,
    inactivateEdgeRoutingGeneration,
    prepareEdgeRoutingGeneration,
    prepareHostModeCapabilityForInactiveGeneration,
    withEdgeGenerationApplyLock,
} from './edgeGeneration.js';

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

function loadManifest(manifestPath) {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

function statusPathFor(containerName) {
    return path.join(RUNNING_DIR, 'no-wait', `${containerName}.json`);
}

function writeStatus(containerName, payload) {
    const target = statusPathFor(containerName);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(payload, null, 2));
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPriorWorker(rawStatusPath) {
    if (!rawStatusPath) return;
    const statusPath = path.resolve(rawStatusPath);
    const allowedRoot = `${path.resolve(RUNNING_DIR, 'no-wait')}${path.sep}`;
    if (!statusPath.startsWith(allowedRoot) || path.extname(statusPath) !== '.json') {
        throw new Error('no-wait predecessor status must be an exact file in the workspace no-wait status directory');
    }
    const timeoutMs = Number.parseInt(
        process.env.PLOINKY_NO_WAIT_SEQUENCE_TIMEOUT_MS || '900000',
        10,
    );
    const deadline = Date.now() + Math.max(1000, timeoutMs);
    while (Date.now() < deadline) {
        try {
            const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
            if (status?.state === 'running' || status?.state === 'failed') return;
            if (status?.state && status.state !== 'starting') {
                throw new Error(`no-wait predecessor has invalid state '${status.state}'`);
            }
        } catch (error) {
            if (error?.code !== 'ENOENT') {
                throw new Error(`no-wait predecessor status is invalid: ${error?.message || error}`);
            }
        }
        await sleep(100);
    }
    throw new Error(`timed out waiting for no-wait predecessor status '${statusPath}'`);
}

async function upsertRoute(routeKey, route, {
    containerName,
    registryRecord,
    preparationLease,
} = {}) {
    await mergeRoutingConfig((cfg) => {
        if (!containerName || !registryRecord) {
            throw new Error('no-wait route activation requires one exact runtime registry record');
        }
        const agents = loadAgents();
        agents[containerName] = registryRecord;
        saveAgents(agents, { coordinate: false });
        cfg.routes = cfg.routes || {};
        cfg.routes[routeKey] = mergeRuntimeRoute(
            cfg.routes[routeKey],
            route,
            { hostPort: route.hostPort, serviceTargets: route.serviceTargets },
        );
        return cfg;
    }, {
        reason: `no-wait-runtime-ready:${routeKey}`,
        preparationLease,
    });
}

function prepareNoWaitLifecycle({
    containerName,
    repoName,
    shortAgent,
    alias,
    routeKey,
    networkMode,
}) {
    const reason = `no-wait-runtime-prelaunch:${routeKey}`;
    let prepared = null;
    try {
        return withEdgeGenerationApplyLock((applyLockCapability) => {
            inactivateEdgeRoutingGeneration(reason, { applyLockCapability });
            const agents = loadAgents();
            const record = agents?.[containerName];
            if (!record || record.type !== 'agent'
                || String(record.repoName || '') !== repoName
                || String(record.agentName || '') !== shortAgent
                || String(record.alias || '') !== alias
                || !String(record.instanceId || '')
                || !String(record.enableGeneration || '')) {
                throw new Error(`no-wait lifecycle requires the exact staged registry identity for '${containerName}'`);
            }
            const route = readRoutingConfig()?.routes?.[routeKey];
            if (!route
                || String(route.container || '') !== containerName
                || String(route.repo || '') !== repoName
                || String(route.agent || '') !== shortAgent
                || String(route.alias || '') !== alias
                || Object.prototype.hasOwnProperty.call(route, 'hostPort')
                || Object.prototype.hasOwnProperty.call(route, 'serviceTargets')) {
                throw new Error(`no-wait lifecycle requires one exact target-less staged route for '${routeKey}'`);
            }
            prepared = prepareEdgeRoutingGeneration({ reason, applyLockCapability });
            if (prepared?.selector?.state !== 'inactive' || !prepared?.preparationLease) {
                throw new Error(`no-wait lifecycle did not prepare one inactive generation for '${routeKey}'`);
            }
            const owner = {
                agentId: `agent:${repoName}/${shortAgent}`,
                instanceId: record.instanceId,
                enableGeneration: record.enableGeneration,
                routeKey,
                containerName,
            };
            const preparedHostModeCapability = networkMode === 'host'
                ? prepareHostModeCapabilityForInactiveGeneration(owner)
                : undefined;
            return {
                record,
                preparationLease: prepared.preparationLease,
                preparedHostModeCapability,
            };
        });
    } catch (error) {
        try {
            if (prepared?.preparationLease) abortEdgeRoutingPreparation(prepared.preparationLease, {
                reason: 'no-wait-runtime-capability-failed',
            });
        } catch (_) {}
        throw error;
    }
}

async function waitForNoWaitReadiness({ manifest, shortAgent, containerName, hostPort }) {
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
    if (!Number(hostPort || 0)) {
        throw new Error(`readiness protocol '${protocol}' requires one resolved private target port`);
    }
    const ready = await waitForAgentReady({ hostPort: Number(hostPort) }, {
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

    // Resolve the effective endpoint before writing status or touching runtime
    // state. Detached workers must obey the same persisted-port contract as
    // blocking startup paths.
    const manifest = loadManifest(manifestPath);
    const profileResolution = resolveManifestRuntimeProfile(manifest, {
        agentName: `${repoName}/${shortAgent}`,
        profileName: profileName || undefined,
        path: `manifest(${repoName}/${shortAgent})`,
    });
    const routerEndpoint = resolveRouterEndpoint(profileResolution.network.mode, {
        explicitPort: routerPort || undefined,
    });

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

    let lifecycle = null;
    try {
        await waitForPriorWorker(waitForStatus);
        lifecycle = prepareNoWaitLifecycle({
            containerName,
            repoName,
            shortAgent,
            alias,
            routeKey,
            networkMode: profileResolution.network.mode,
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
            preparationLease: lifecycle.preparationLease,
            preparedHostModeCapability: lifecycle.preparedHostModeCapability,
        };
        const result = await dockerSvc.ensureAgentService(shortAgent, manifest, agentPath, ensureOptions);
        const resolvedContainerName = (result && result.containerName) || containerName;
        const hostPort = result && result.hostPort;
        const serviceTargets = result && result.serviceTargets;
        const registryRecord = result && result.registryRecord;
        const routedHostPort = profileResolution.network.mode === 'none'
            ? null
            : hostPort || null;

        await waitForNoWaitReadiness({
            manifest,
            shortAgent,
            containerName: resolvedContainerName,
            hostPort,
        });

        await upsertRoute(routeKey, {
            container: resolvedContainerName,
            hostPath: agentPath,
            repo: repoName,
            agent: shortAgent,
            ...(alias ? { alias } : {}),
            hostPort: routedHostPort,
            serviceTargets: serviceTargets || null
        }, {
            containerName: resolvedContainerName,
            registryRecord,
            preparationLease: lifecycle.preparationLease,
        });

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
        try {
            inactivateEdgeRoutingGeneration('no-wait-runtime-failed', {
                preserveSelectedGeneration: true,
            });
        } catch (_) {}
        try {
            if (lifecycle?.preparationLease) {
                abortEdgeRoutingPreparation(lifecycle.preparationLease, {
                    reason: 'no-wait-runtime-failed',
                });
            }
        } catch (_) {}
        const finishedAt = new Date().toISOString();
        const error = {
            message: err?.message || String(err),
            stack: err?.stack || null
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

main().catch((err) => {
    console.error('[no-wait] worker crashed:', err?.message || err);
    if (err?.stack) console.error(err.stack);
    process.exit(1);
});
