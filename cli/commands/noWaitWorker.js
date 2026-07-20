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
import * as dockerSvc from '../sandbox/docker/index.js';
import { RUNNING_DIR } from '../utils/config.js';
import { mergeRoutingConfig } from '../server/routingFile.js';

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

async function upsertRoute(routeKey, route) {
    await mergeRoutingConfig((cfg) => {
        cfg.routes = cfg.routes || {};
        cfg.routes[routeKey] = { ...(cfg.routes[routeKey] || {}), ...route };
        if (route.additionalServerPort === null) {
            delete cfg.routes[routeKey].additionalServerPort;
        }
        return cfg;
    });
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

    try {
        const manifest = loadManifest(manifestPath);
        const ensureOptions = {
            containerName,
            alias: alias || undefined,
        };
        if (routerPort) ensureOptions.routerPort = routerPort;
        if (profileName) ensureOptions.profileName = profileName;
        const result = await dockerSvc.ensureAgentService(shortAgent, manifest, agentPath, ensureOptions);
        const resolvedContainerName = (result && result.containerName) || containerName;
        const hostPort = result && result.hostPort;
        const additionalServerPort = result && result.additionalServerPort;

        await upsertRoute(routeKey, {
            container: resolvedContainerName,
            hostPath: agentPath,
            repo: repoName,
            agent: shortAgent,
            ...(alias ? { alias } : {}),
            ...(hostPort ? { hostPort } : {}),
            additionalServerPort: additionalServerPort || null
        });

        const finishedAt = new Date().toISOString();
        writeStatus(containerName, {
            ...baseStatus,
            state: 'running',
            finishedAt,
            container: resolvedContainerName,
            hostPort: hostPort || null
        });
        console.log(`[no-wait] ${shortAgent}: launch succeeded (container=${resolvedContainerName}${hostPort ? `, hostPort=${hostPort}` : ''})`);
    } catch (err) {
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
