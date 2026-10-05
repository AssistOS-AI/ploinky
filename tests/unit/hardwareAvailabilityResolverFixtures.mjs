// Shared fixtures for the hardware-availability resolver, lease and observer tests
// (not a test file): one real workspace with a real edge generation, a real
// durable store, and statuses written by the real worker writer.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
    applyEdgeRoutingGeneration,
    captureEdgeRoutingLease,
    initializeFreshEdgeRoutingSources,
    inactivateEdgeRoutingGeneration,
    loadActiveEdgeRoutingGeneration,
    readEdgeRoutingSelection,
    resolveEdgeGenerationPaths,
} from '../../cli/sandbox/edgeGeneration.js';
import { readHardwareAvailabilityPolicy } from '../../cli/sandbox/hardwareAvailabilityStore.mjs';
import { writeNoWaitWorkerStatus } from '../../cli/commands/noWaitWorker.js';
import {
    createHardwareAvailabilityResolverCache,
    resolveEffectiveHardwareAvailability,
} from '../../cli/server/hardwareAvailabilityResolver.mjs';
import { commit, entryFor, refusalOutcome, slotFor, uuid } from './hardwareAvailabilityFixtures.mjs';

export { entryFor, refusalOutcome, slotFor, uuid };

export const RUN_STARTED_AT_MS = 1_700_000_000_000;
const ROUTER_PORT = '18080';
const MEDIA_PORT = '17891';

function writeJson(target, value) {
    fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
}

export function containerOf(routeKey) {
    return `ploinky_fixtures_${routeKey}`;
}

/**
 * A workspace with one real active generation. `routes` maps a route key to
 * `{ hostPort? }`: a route without one is target-less. The default is alpha
 * (target-less), beta (targeted) and gamma (target-less).
 */
export function makeWorld(t, { routes = { alpha: {}, beta: { hostPort: 43102 }, gamma: {} } } = {}) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hwr-')));
    const ploinkyDir = path.join(root, '.ploinky');
    const edgeDir = path.join(ploinkyDir, 'data', 'edge-routing');
    const policyDir = path.join(ploinkyDir, 'data', 'router-security');
    const runningDir = path.join(ploinkyDir, 'running');
    const statusDir = path.join(runningDir, 'no-wait');
    for (const directory of [edgeDir, policyDir, statusDir]) fs.mkdirSync(directory, { recursive: true });
    const manifest = { routerAccess: { httpRoutes: [{ path: '/public.html', access: 'public' }], agentPorts: true } };
    const routing = { static: { agent: 'beta', port: 7777 }, routes: {} };
    const agents = {};
    for (const [routeKey, spec] of Object.entries(routes)) {
        const agentDir = path.join(ploinkyDir, 'repos', 'fixtures', routeKey);
        fs.mkdirSync(agentDir, { recursive: true });
        writeJson(path.join(agentDir, 'manifest.json'), manifest);
        routing.routes[routeKey] = {
            repo: 'fixtures', agent: routeKey, container: containerOf(routeKey), hostPath: agentDir,
            ...(spec.hostPort ? { hostPort: spec.hostPort } : {}),
        };
        agents[containerOf(routeKey)] = {
            type: 'agent', repoName: 'fixtures', agentName: routeKey, instanceId: `${routeKey}-instance`,
            enableGeneration: `${routeKey}-generation`, profile: 'default', auth: { mode: 'sso' },
            ...(spec.hostPort ? { runtime: 'podman', containerId: 'b'.repeat(64) } : {}),
        };
    }
    writeJson(path.join(ploinkyDir, 'routing.json'), routing);
    writeJson(path.join(ploinkyDir, 'agents.json'), agents);
    writeJson(path.join(edgeDir, 'desired.json'), { hosts: {} });
    writeJson(path.join(policyDir, 'policy-state.json'), { schema: 'router-policy', httpRoutes: [], mcpTools: [] });
    const previous = {
        root: process.env.PLOINKY_WORKSPACE_ROOT,
        router: process.env.PLOINKY_ROUTER_HOST_PORT,
        media: process.env.PLOINKY_MEDIA_HOST_PORT,
    };
    process.env.PLOINKY_WORKSPACE_ROOT = root;
    process.env.PLOINKY_ROUTER_HOST_PORT = ROUTER_PORT;
    process.env.PLOINKY_MEDIA_HOST_PORT = MEDIA_PORT;
    t.after(() => {
        for (const [key, value] of [['PLOINKY_WORKSPACE_ROOT', previous.root], ['PLOINKY_ROUTER_HOST_PORT', previous.router], ['PLOINKY_MEDIA_HOST_PORT', previous.media]]) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        fs.rmSync(root, { recursive: true, force: true });
    });
    initializeFreshEdgeRoutingSources({ workspaceRoot: root });
    const paths = resolveEdgeGenerationPaths({ workspaceRoot: root });
    const options = { workspaceRoot: root };
    const cache = createHardwareAvailabilityResolverCache();

    const world = {
        root, paths, options, runningDir, statusDir, cache, ploinkyDir,
        readRouting: () => JSON.parse(fs.readFileSync(path.join(ploinkyDir, 'routing.json'), 'utf8')),
        writeRouting: (value) => writeJson(path.join(ploinkyDir, 'routing.json'), value),
        readAgents: () => JSON.parse(fs.readFileSync(path.join(ploinkyDir, 'agents.json'), 'utf8')),
        writeAgents: (value) => writeJson(path.join(ploinkyDir, 'agents.json'), value),
        apply(reason = 'fixture') {
            return applyEdgeRoutingGeneration({ ...options, reason, publicationState: 'ready' }).selector.generation;
        },
        inactivate: (reason = 'fixture-inactive') => inactivateEdgeRoutingGeneration(reason, options),
        active: () => loadActiveEdgeRoutingGeneration(options),
        selection: () => readEdgeRoutingSelection(options).selector,
        lease: (extra = {}) => captureEdgeRoutingLease({ ...options, ...extra }),
        store: () => readHardwareAvailabilityPolicy({ paths }),
        // A resolver call against the active generation with this world's own cache.
        resolve({ generation = world.active().generation, nowMs, fsApi, cache: use = cache } = {}) {
            return resolveEffectiveHardwareAvailability({
                generation, paths, runningDir, ...(nowMs === undefined ? {} : { nowMs }), ...(fsApi ? { fsApi } : {}), cache: use,
            });
        },
        commitStore(args) {
            return commit(root, paths, { expectedRevision: world.store().revision, ...args });
        },
        // Stage a slot for a route's CURRENT tuple (as staging would) and return it.
        stageSlot(routeKey, overrides = {}) {
            const slot = slotFor(routeKey, {
                key: containerOf(routeKey), runStartedAtMs: RUN_STARTED_AT_MS, ...overrides,
            });
            world.commitStore({ slots: { ...world.store().slots, [routeKey]: slot } });
            return slot;
        },
        statusPath: (slot) => path.join(statusDir, slot.statusFile),
        identityOf(routeKey, slot) {
            return {
                containerName: slot.key, instanceId: slot.instanceId, enableGeneration: slot.enableGeneration,
                repoName: 'fixtures', shortAgent: routeKey, alias: '', routeKey,
                runId: slot.runId, runStartedAtMs: slot.runStartedAtMs, waveIndex: slot.waveIndex, statusFile: slot.statusFile,
            };
        },
        // The real worker writer. `kind`: 'hardware' (typed refusal), 'generic' (failed, no outcome), 'running', 'starting'.
        writeWorker(routeKey, slot, { kind = 'hardware', finishedAtMs = Date.now() - 100, pid = process.pid, fsApi, reason, outcome, errorExtra = {}, statusExtra = {} } = {}) {
            const startedAtMs = slot.runStartedAtMs + 10;
            const iso = (value) => new Date(value).toISOString();
            const base = { containerName: slot.key, pid, sequencePhase: 'active', phase: 'admission' };
            let payload;
            if (kind === 'running') payload = { ...base, state: 'running', startedAt: iso(startedAtMs), startedAtMs, sequencePhaseStartedAt: iso(startedAtMs), sequencePhaseStartedAtMs: startedAtMs };
            else if (kind === 'starting') payload = { ...base, state: 'starting', startedAt: iso(startedAtMs), startedAtMs, sequencePhaseStartedAt: iso(startedAtMs), sequencePhaseStartedAtMs: startedAtMs };
            else {
                const typed = outcome || refusalOutcome(slot.key, { ref: `fixtures/${routeKey}`, ...(reason === undefined ? {} : { reason }) });
                payload = {
                    ...base, state: 'failed', startedAt: iso(startedAtMs), startedAtMs, sequencePhaseStartedAt: iso(startedAtMs), sequencePhaseStartedAtMs: startedAtMs,
                    finishedAt: iso(finishedAtMs), finishedAtMs,
                    error: kind === 'hardware'
                        ? { message: 'refused by the fixture', code: typed.code, hardwareOutcome: typed, ...errorExtra }
                        : { message: 'generic failure', ...errorExtra },
                };
            }
            payload = { ...payload, ...statusExtra };
            return writeNoWaitWorkerStatus(slot.key, payload, {
                identity: world.identityOf(routeKey, slot), runId: slot.runId, runStartedAtMs: slot.runStartedAtMs,
                waveIndex: slot.waveIndex, statusFile: world.statusPath(slot), runningDir, ...(fsApi ? { fsApi } : {}),
            });
        },
        readStatus: (slot) => JSON.parse(fs.readFileSync(world.statusPath(slot), 'utf8')),
        // Replace a status document with arbitrary content (a forgery or a rewrite), on a new inode.
        rewriteStatus(slot, change) {
            const document = world.readStatus(slot);
            const next = change(document) ?? document;
            const target = world.statusPath(slot);
            const temporary = `${target}.rewrite`;
            fs.writeFileSync(temporary, typeof next === 'string' ? next : JSON.stringify(next));
            fs.renameSync(temporary, target);
        },
        removeStatus: (slot) => fs.rmSync(world.statusPath(slot), { force: true }),
    };
    world.apply('fixture-initial');
    return world;
}

/** A wrapper counting the calls an fs facade receives, by operation and path. */
export function countingFs() {
    const calls = [];
    const api = { ...fs, constants: fs.constants };
    for (const op of ['lstatSync', 'openSync', 'readSync', 'fstatSync', 'readdirSync', 'readFileSync', 'writeFileSync', 'renameSync', 'unlinkSync']) {
        api[op] = (...args) => {
            calls.push({ op, target: typeof args[0] === 'string' ? args[0] : null });
            return fs[op](...args);
        };
    }
    return {
        api,
        calls,
        count: (op, matcher = () => true) => calls.filter((call) => call.op === op && matcher(call.target)).length,
        reset: () => { calls.length = 0; },
    };
}

// ---------------------------------------------------------------- the separate-process evidence probe

const PROBE_ROOT = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'));
const hrefOf = (relative) => pathToFileURL(path.join(PROBE_ROOT, relative)).href;
export const PROBE_FILE = path.join(PROBE_ROOT, 'tests/unit/hardwareAvailabilityEvidenceProbe.mjs');

function probeArgs(options) {
    // The same contract and spawn guard every test process runs under; the mutation loader only when a mutant run asked for it.
    return [
        '--import', hrefOf('tests/helpers/agentlibTestContract.mjs'),
        '--import', hrefOf('tests/helpers/engineSpawnGuard.mjs'),
        ...(process.env.C5_MUTATION ? ['--import', hrefOf('tests/hardware-limits/c5MutationRegister.mjs')] : []),
        PROBE_FILE, JSON.stringify(options),
    ];
}

function parseReceipt(stdout, stderr, status) {
    const line = stdout.trim().split('\n').filter(Boolean).pop();
    if (!line) throw new Error(`the probe wrote no receipt (exit ${status}): ${String(stderr).slice(-800)}`);
    return JSON.parse(line);
}

/** Run the probe to completion and return its receipt (no concurrent writer). */
export function runProbeSync(options) {
    const child = spawnSync(process.execPath, probeArgs(options), { cwd: PROBE_ROOT, env: { ...process.env, NODE_TEST_CONTEXT: undefined }, encoding: 'utf8', timeout: 60_000 });
    return parseReceipt(child.stdout, child.stderr, child.status);
}

/**
 * Start the probe and wait until it is polling (its startedFile exists). `done` resolves to the receipt.
 * The child is killed when the test ends, whatever happened.
 */
export async function startProbe(t, world, options) {
    const startedFile = path.join(world.root, 'probe.started');
    const reportFile = path.join(world.root, 'probe.report.json');
    const full = { workspaceRoot: world.root, routeKey: 'alpha', pollIntervalMs: 20, deadlineMs: 20_000, routerPid: process.pid, startedFile, reportFile, ...options };
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, probeArgs(full), { cwd: PROBE_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    const done = new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('close', (status) => {
            try { resolve(parseReceipt(stdout, stderr, status)); } catch (error) { reject(error); }
        });
    });
    const waitUntil = Date.now() + 15_000;
    while (!fs.existsSync(startedFile)) {
        if (Date.now() > waitUntil || child.exitCode !== null) throw new Error(`the probe did not start polling: ${stderr.slice(-800)}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return { child, done, reportFile, startedFile };
}
