// Separate-process, lease-free evidence probe (M-NW-01 D2-S, assertion (1); not a test file).
// Usage: node hardwareAvailabilityEvidenceProbe.mjs '<json options>'
//
// It runs the resolver lock-free, with no HTTP and no lease, against the
// generation the selector names, polling from before the worker's terminal
// write. Its receipt binds identity (slot and status identity, status sha256),
// clock (wall and monotonic, in this process), source (candidate SHA and source
// digest, supplied by the harness) and the generation used with the selector
// state, and carries the readiness and administrator projections computed from
// the SAME evaluation by the observers' shared functions. It runs in its own
// process, so its pid differs from the Router's (and from the harness's).
//
// options: { workspaceRoot, routeKey, pollIntervalMs (<= 50), deadlineMs,
//            startedFile?, reportFile?, routerPid?, source? }
//   startedFile  written once polling has begun
//   reportFile   the worker log line ({ finishedAtMs, visibleAtMs, durableAtMs |
//                durabilityError | durabilitySkipped, statusFile }); read after the first active
//                observation, polled for until the deadline

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

export const CREDIT_WINDOW_MS = 5000;
export const CTIME_TOLERANCE_MS = 50;

/**
 * The credit rule of D2S.8 assertion (1), kept pure so it is testable alone.
 * Credited only when polling began at or before the run started and before T_f,
 * the first typed observation is within T_f + 5000 + P, the
 * status file's ctime (read through the probe's own descriptor) agrees with the
 * worker's T_vis within 50 ms and is not after the observation, and the
 * durability point is within T_f + 5000 with no recorded durability error and
 * no skipped directory fsync (an unsupported fsync made nothing durable).
 */
export function creditReceipt({
    firstActiveObservedAtMs, tFinMs, tVisMs, durableAtMs, durabilityError, durabilitySkipped, ctimeMs, pollIntervalMs,
    pollingStartedAtMs, runStartedAtMs, windowMs = CREDIT_WINDOW_MS, ctimeToleranceMs = CTIME_TOLERANCE_MS,
}) {
    const checks = {
        pollingStartedBeforeFinish: Number.isFinite(pollingStartedAtMs) && pollingStartedAtMs <= tFinMs,
        pollingStartedBeforeRun: Number.isFinite(pollingStartedAtMs) && Number.isFinite(runStartedAtMs) && pollingStartedAtMs <= runStartedAtMs,
        observedInWindow: Number.isFinite(firstActiveObservedAtMs) && firstActiveObservedAtMs <= tFinMs + windowMs + pollIntervalMs,
        ctimeMatchesVisible: Number.isFinite(ctimeMs) && Number.isFinite(tVisMs) && Math.abs(ctimeMs - tVisMs) <= ctimeToleranceMs,
        ctimeBeforeObservation: Number.isFinite(ctimeMs) && Math.floor(ctimeMs) <= firstActiveObservedAtMs,
        durable: !durabilityError && !durabilitySkipped && Number.isFinite(durableAtMs) && durableAtMs <= tFinMs + windowMs,
    };
    return { checks, credited: Object.values(checks).every(Boolean) };
}

// The generation the selector names, even while inactive (E110). An inactivated
// active generation names none; its exact predecessor is then the generation
// that carried the route, and the receipt records which field was used.
export function namedGeneration(selector) {
    if (selector.generation) return { id: selector.generation, source: 'selector.generation' };
    return { id: selector.previousGeneration, source: 'selector.previousGeneration' };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

async function main(options) {
    const cli = (relative) => import(new URL(`../../cli/${relative}`, import.meta.url).href);
    const edge = await cli('sandbox/edgeGeneration.js');
    const { resolveEffectiveHardwareAvailability, createHardwareAvailabilityResolverCache } = await cli('server/hardwareAvailabilityResolver.mjs');
    const { readHardwareAvailabilityPolicy } = await cli('sandbox/hardwareAvailabilityStore.mjs');
    const { buildHardwareLimitsState } = await cli('server/authHandlers/hardwareLimitsRoutes.mjs');
    const { metricHardwareAvailability, availabilityForcesNotReady } = await cli('server/workspaceMetricsAvailability.mjs');

    const { workspaceRoot, routeKey } = options;
    const pollIntervalMs = Math.min(Number(options.pollIntervalMs) || 25, 50);
    const edgeOptions = { workspaceRoot };
    const paths = edge.resolveEdgeGenerationPaths(edgeOptions);
    const runningDir = path.join(paths.ploinkyDir, 'running');
    const cache = createHardwareAvailabilityResolverCache();
    const started = { wallMs: Date.now(), monoMs: performance.now() };
    if (options.startedFile) fs.writeFileSync(options.startedFile, String(process.pid));

    let polls = 0;
    let loadFailures = 0;
    let observation = null;
    let last = null;
    const deadline = started.wallMs + (Number(options.deadlineMs) || 10_000);
    while (Date.now() <= deadline) {
        polls += 1;
        try {
            const selector = edge.readEdgeRoutingSelection(edgeOptions).selector;
            const named = namedGeneration(selector);
            const generation = edge.loadEdgeRoutingGenerationForEvidence(named.id, edgeOptions);
            const nowMs = Date.now();
            const evaluation = resolveEffectiveHardwareAvailability({ generation, paths, runningDir, nowMs, cache });
            last = { selector, named, generation, evaluation };
            if (evaluation.denials.has(routeKey)) {
                observation = { ...last, wallMs: nowMs, monoMs: performance.now() };
                break;
            }
        } catch (_) {
            loadFailures += 1;
        }
        await sleep(pollIntervalMs);
    }

    const receipt = {
        pid: process.pid,
        routerPid: options.routerPid ?? null,
        source: options.source ?? null,
        clock: { pollingStartedAtMs: started.wallMs, pollingStartedMonoMs: started.monoMs, pollIntervalMs, polls, loadFailures },
        observed: Boolean(observation),
    };
    const reading = observation || last;
    if (reading) {
        receipt.selectorState = reading.selector.state;
        receipt.selectorGeneration = reading.selector.generation || '';
        receipt.selectorPreviousGeneration = reading.selector.previousGeneration || '';
        receipt.generationUsed = reading.named.id;
        receipt.generationSource = reading.named.source;
        receipt.evaluation = {
            revision: reading.evaluation.revision,
            denial: reading.evaluation.denials.get(routeKey) || null,
            slot: reading.evaluation.slots.get(routeKey) || null,
        };
    }
    if (!observation) {
        process.stdout.write(`${JSON.stringify({ ...receipt, credited: false })}\n`);
        return;
    }
    receipt.clock.firstActiveObservedAtMs = observation.wallMs;
    receipt.clock.firstActiveObservedMonoMs = observation.monoMs;

    // The readiness and administrator projections come from this SAME evaluation.
    const key = observation.evaluation.denials.get(routeKey).key;
    const record = observation.generation.agents[key];
    const routing = { routes: observation.generation.routing.routes };
    const readiness = metricHardwareAvailability({ containerName: key, state: { status: 'unknown', ready: true, running: false } }, record, routing, observation.evaluation.projections);
    receipt.readiness = { availability: readiness.availability, ready: !availabilityForcesNotReady(readiness.availability) };
    const admin = buildHardwareLimitsState({
        context: { overrides: new Map(), gate: 'on', prepared: true },
        installed: [{ ref: `${record.repoName}/${record.agentName}`, manifestPath: '/none' }],
        registry: observation.generation.agents,
        routing,
        storeProjections: observation.evaluation.projections,
        admit: () => ({ descriptor: {} }),
        readApplied: () => null,
        readDeclarationNote: () => null,
    }).agents[0].containers.find((container) => container.key === key);
    const problem = admin?.problem || null;
    receipt.admin = admin ? {
        availability: admin.availability,
        code: problem?.code ?? null,
        reasonCode: problem?.reasonCode ?? null,
        cause: problem ? (problem.state === 'refused' ? problem.reason : problem.rootCause?.reason) : null,
    } : null;

    // The status evidence, through this process's own descriptor.
    const store = readHardwareAvailabilityPolicy({ paths });
    const statusFile = (store.slots[routeKey] || store.entries[routeKey]?.source)?.statusFile;
    let ctimeMs = null;
    if (statusFile) {
        const file = path.join(runningDir, 'no-wait', statusFile);
        const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
            const stat = fs.fstatSync(descriptor);
            const bytes = Buffer.alloc(stat.size);
            fs.readSync(descriptor, bytes, 0, bytes.length, 0);
            ctimeMs = stat.ctimeMs;
            const status = JSON.parse(bytes.toString('utf8'));
            receipt.status = {
                file: statusFile,
                sha256: sha256(bytes),
                ctimeMs,
                identity: {
                    containerName: status.containerName, instanceId: status.instanceId, enableGeneration: status.enableGeneration,
                    runId: status.runId, runStartedAtMs: status.runStartedAtMs, waveIndex: status.waveIndex, statusFile: status.statusFile,
                },
            };
        } finally {
            fs.closeSync(descriptor);
        }
    }

    // T_vis and the durability point come from the worker's log line.
    let report = null;
    while (options.reportFile && Date.now() <= deadline) {
        try {
            report = JSON.parse(fs.readFileSync(options.reportFile, 'utf8'));
            break;
        } catch (_) {
            await sleep(10);
        }
    }
    receipt.worker = report;
    if (report) {
        const credit = creditReceipt({
            firstActiveObservedAtMs: observation.wallMs,
            tFinMs: report.finishedAtMs,
            tVisMs: report.visibleAtMs,
            durableAtMs: report.durableAtMs,
            durabilityError: report.durabilityError,
            durabilitySkipped: report.durabilitySkipped,
            ctimeMs,
            pollIntervalMs,
            pollingStartedAtMs: started.wallMs,
            runStartedAtMs: receipt.status?.identity?.runStartedAtMs,
        });
        receipt.checks = {
            ...credit.checks,
            probeIsSeparateProcess: options.routerPid !== undefined && options.routerPid !== null && process.pid !== options.routerPid,
        };
        receipt.credited = credit.credited && receipt.checks.probeIsSeparateProcess;
    } else {
        receipt.credited = false;
    }
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
    main(JSON.parse(process.argv[2] || '{}')).catch((error) => {
        process.stdout.write(`${JSON.stringify({ error: String(error?.message || error), credited: false })}\n`);
        process.exitCode = 1;
    });
}
