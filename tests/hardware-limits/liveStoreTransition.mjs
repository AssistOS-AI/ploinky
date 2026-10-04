// LIVE-C5 driver: the ACTUAL gate-on to gate-off lifecycle, observed from outside the product. A fixed host Node program that the live case runs as
// one bounded child. It runs the product's own outer CLI (`runOuterCli`) over the product's own supervisor, whose process runner is the production
// runner decorated, never replaced: every method delegates to the real runner and returns its real result. The decoration recognises the ACTUAL
// lifecycle argv structurally (pinned engine, `container exec`, the Box user, the workspace exec options, the full immutable Box ID, the in-Box
// `ploinky-local stop`) and, at the production old-Box stop boundary of the forward transition, runs the REAL in-Box administrator writers
// synchronously before it delegates that stop once, unchanged.
//
//   transition    `restart` with the gate off over a gate-on Box and an empty store. At the first exact old-ID `ploinky-local stop` the driver binds the
//                 invocation to the product operation (durably), reads the barrier and both store views, issues the real setter and the real clear (each
//                 with the stamp T) through the Router's administrator route inside the OLD Box, records their real replies and the store afterwards,
//                 then delegates the stop. At every later forward or rollback stop/remove/create/start it observes that the barrier is still held. A
//                 violated assertion is recorded as the primary failure and thrown from the intercepted call, so the product's own rollback runs; the
//                 primary failure stays the answer. The fixture neither installs nor removes the barrier and never returns a synthetic engine result.
//   writer-first  `restart` with the gate off over a committed policy: the product must refuse with the typed `PLOINKY_BOX_HARDWARE_LIMITS_STORED`
//                 before any lifecycle mutation. Every lifecycle mutation that would reach the engine is refused by the decoration itself.
//   destroy       `destroy --delete-cache`, with the product's exact-ID destroy entry guarded: the selected Box must be the ID cleanup proved.
//
// Receipts: the child alone writes its receipt (private, exact-named, file and directory fsynced); the parent alone writes the manifest. Test-only.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { boxWorkspaceExecOptions } from '../../ploinky-box/contract/workspace-root.mjs';
import { hardwareStorePaths, readBarrier } from '../../cli/sandbox/hardwareLimits/store.mjs';
import { ADMIN_REQUEST } from './liveGpuCommands.mjs';
import { parseAdminReply } from './liveAvailabilityCommands.mjs';
import {
    OVERRIDES, STORE_PROGRAM, assertSameStore, assertValidStore, boxProgramWords, hostProgramWords, parseProgramLines, storeProgramParams, tokenKey,
} from './liveStoreCommands.mjs';
import {
    C5_DRIVER_NAME, newDriverReceipt, persistDriverReceipt, productEngineDigest, productTransitionIds, readC5ProductJournal, readC5Snapshot, validateC5Intent,
} from './liveBoxTransitionCustody.mjs';
import { ID, INSPECT, RUN_ID, absolute, assertWorkspace, engineIdentityDigest, jsonDigest, redactDiagnostic } from './liveCommon.mjs';

export const DRIVER_SCHEMA = 1;
export const DRIVER_MODES = Object.freeze(['transition', 'writer-first', 'destroy']);
export const DRIVER_FILE = 'tests/hardware-limits/liveStoreTransition.mjs';
export const OLD_STOP_PATH = '/opt/ploinky/bin/ploinky-local';
// Hard ceilings, not retries. The whole lifecycle invocation (the parent's own deadline on this child), the synchronous boundary section, and each
// single in-Box call inside it.
export const DRIVER_BOUNDS = Object.freeze({ lifecycleMs: 10 * 60 * 1000, boundaryMs: 150000, adminMs: 60000, programMs: 60000, infoMs: 30000, destroyMs: 5 * 60 * 1000 });
// The failure kinds that are product behaviour. Anything else (setup, identity, channel, timeout, order) is never a kill and never a refusal.
export const BEHAVIOR_FAILURES = Object.freeze(['writer-outcome', 'barrier-state', 'store-changed', 'barrier-retention']);
export const LIFECYCLE_MUTATIONS = Object.freeze(['graph-stop', 'box-stop', 'box-remove', 'box-create', 'box-start']);
const MAX_EVENTS = 128;

export class DriverAssertion extends Error {
    constructor(kind, message, evidence = null) {
        super(message);
        this.name = 'DriverAssertion';
        this.kind = kind;
        this.evidence = evidence;
    }
}
const setup = (message, evidence = null) => new DriverAssertion('setup', message, evidence);

// ---------------------------------------------------------------------------------------------------------------------------------------
// Parameters: one JSON argv, validated before anything runs.

export function driverParams({ mode, profile, run, intent = null, receiptPath = null, expectedToken = null, expectedContainerId = null, agentRef = null, bounds = DRIVER_BOUNDS }) {
    return {
        schema: DRIVER_SCHEMA, mode, runId: run.runId, bounds: { ...bounds }, agentRef, expectedToken, expectedContainerId, intent, receiptPath,
        profile: {
            host: { home: profile.host.home }, workspace: profile.workspace, box: profile.box, source: { root: profile.source.root, digest: profile.source.digest },
            engine: { identityDigest: profile.engine.identityDigest }, cases: profile.cases,
        },
    };
}
export const driverArgv = (profile, params) => [path.join(profile.source.root, DRIVER_FILE), JSON.stringify(params)];

export function validateDriverParams(value) {
    const fail = message => setup(`invalid driver parameters: ${message}`);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('not an object');
    const allowed = ['schema', 'mode', 'runId', 'bounds', 'agentRef', 'expectedToken', 'expectedContainerId', 'intent', 'receiptPath', 'profile'];
    if (Object.keys(value).some(key => !allowed.includes(key)) || allowed.some(key => !Object.hasOwn(value, key))) throw fail('unexpected fields');
    if (value.schema !== DRIVER_SCHEMA || !DRIVER_MODES.includes(value.mode) || !RUN_ID.test(value.runId)) throw fail('schema, mode or run');
    for (const key of ['lifecycleMs', 'boundaryMs', 'adminMs', 'programMs', 'infoMs', 'destroyMs']) {
        const bound = value.bounds?.[key];
        if (!Number.isInteger(bound) || bound < 1 || bound > DRIVER_BOUNDS[key]) throw fail(`bound ${key}`);
    }
    const profile = value.profile;
    if (!profile || !absolute(profile.host?.home) || !absolute(profile.workspace?.path) || !absolute(profile.source?.root) || !Array.isArray(profile.cases)
        || !ID.test(profile.box?.id) || !/^sha256:[a-f0-9]{64}$/.test(profile.engine?.identityDigest)) throw fail('profile');
    if (value.mode === 'transition') {
        if (!value.intent || !absolute(value.receiptPath) || !value.expectedToken || !Number.isSafeInteger(value.expectedToken.revision)
            || typeof value.agentRef !== 'string' || !value.agentRef) throw fail('transition inputs');
        validateC5Intent(value.intent, { runId: value.runId }, profile);
    }
    if (value.mode === 'destroy' && value.expectedContainerId !== null && !ID.test(value.expectedContainerId)) throw fail('destroy target');
    return value;
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// The actual lifecycle argv, matched structurally. A substring or a name match is never enough.

const equalWords = (left, right) => left.length === right.length && left.every((word, index) => word === right[index]);
// The exact argv the product's stopPloinkyLocalByContainerId hands the runner (lifecycle/container.mjs).
export const oldStopArgv = (workspaceRoot, id) => ['container', 'exec', '--user', 'podman', ...boxWorkspaceExecOptions(workspaceRoot), id, OLD_STOP_PATH, 'stop'];

export function classifyRun(command, args, { workspaceRoot }) {
    if (command !== 'podman' || !Array.isArray(args)) return { kind: 'other', mutation: false, id: null };
    const workdir = boxWorkspaceExecOptions(workspaceRoot);
    const head = ['container', 'exec', '--user', 'podman', ...workdir];
    if (args.length === head.length + 3 && equalWords(args.slice(0, head.length), head) && ID.test(args[head.length])
        && equalWords(args.slice(head.length + 1), [OLD_STOP_PATH, 'stop'])) return { kind: 'graph-stop', mutation: true, id: args[head.length] };
    if (args[0] === 'container' && args[1] === 'stop' && ID.test(args.at(-1) ?? '')) return { kind: 'box-stop', mutation: true, id: args.at(-1) };
    if (equalWords(args.slice(0, 3), ['container', 'rm', '-f']) && args.length === 4 && ID.test(args[3])) return { kind: 'box-remove', mutation: true, id: args[3] };
    if (args[0] === 'container' && args[1] === 'create') return { kind: 'box-create', mutation: true, id: null };
    if (args[0] === 'container' && args[1] === 'start' && args.length === 3 && ID.test(args[2])) return { kind: 'box-start', mutation: true, id: args[2] };
    return { kind: 'other', mutation: false, id: null };
}

// ---------------------------------------------------------------------------------------------------------------------------------------

const clip = (value, max = 400) => redactDiagnostic(String(value ?? '')).slice(0, max);
function sink() {
    let text = '';
    return { write(chunk) { if (text.length < 16384) text += String(chunk); return true; }, tail: () => text.slice(-2048), isTTY: false };
}

// One engine observation: ONE fresh `info` document, from which the harness digest (checked against the pinned one) and the product's own engine
// identity are both computed. The two are built differently and are never compared with each other.
export function observeEngine(base, profile, bounds) {
    const result = base.query('podman', ['info', '--format', '{{json .}}'], { timeoutMs: bounds.infoMs });
    if (!result?.ok) throw setup('the engine did not answer the fresh identity query', { status: result?.status ?? null, error: clip(result?.error?.code) });
    let info;
    try { info = JSON.parse(result.stdout); } catch { throw setup('the engine identity document is not JSON'); }
    if (info?.host?.serviceIsRemote !== false) throw setup('only a local engine service is supported for LIVE-C5');
    const harness = engineIdentityDigest(info, null);
    if (harness !== profile.engine.identityDigest) throw setup('the engine service identity changed');
    return Object.freeze({ info, harness, product: productEngineDigest(info) });
}

// The Router's administrator route inside one exact Box: the harness's own request program (liveGpuCommands ADMIN_REQUEST).
export const adminExecWords = (boxId, method, bodyValue = null) => ['container', 'exec', '--user', 'podman', boxId, 'node', '-e', ADMIN_REQUEST, method, bodyValue === null ? '' : JSON.stringify(bodyValue)];

async function loadProduction() {
    const [{ runOuterCli }, { createBoxSupervisor }, { buildEngineProcessEnvironment, createProcessRunner }] = await Promise.all([
        import('../../ploinky-box/bin/ploinky-box.mjs'), import('../../ploinky-box/supervisor.mjs'), import('../../ploinky-box/process.mjs'),
    ]);
    return { runOuterCli, createBoxSupervisor, buildEngineProcessEnvironment, createProcessRunner };
}

export async function runDriver(rawParams, seams = {}) {
    const params = validateDriverParams(rawParams);
    const { profile, bounds } = params;
    // The production process runner, outer CLI and supervisor are loaded only here, so importing this module for its parameters and evaluators
    // costs the live case nothing.
    const production = seams.baseRunner && seams.runCli && seams.supervisor ? null : await loadProduction();
    const base = seams.baseRunner ?? production.createProcessRunner({ env: production.buildEngineProcessEnvironment(process.env) });
    const cli = seams.runCli ?? production.runOuterCli;
    const now = seams.now ?? (() => Date.now());
    const homeDirectory = profile.host.home;
    const startedAt = now();
    const events = [];
    const state = { boundary: null, bound: null, failures: [], mutations: [], runCalls: 0, queryCalls: 0, operationId: null, receipt: null, intent: null, stage: 'pre', engine: null };
    const identity = () => assertWorkspace(profile);
    const paths = () => hardwareStorePaths({ identity: identity(), homeDirectory });
    const record = (kind, data = {}) => {
        if (events.length >= MAX_EVENTS) return;
        events.push({ kind, sequence: events.length + 1, atMs: Math.max(0, now() - startedAt), ...data });
    };
    const persistReceipt = () => {
        if (params.mode !== 'transition') return;
        const receipt = state.receipt;
        receipt.events = events.map(event => ({ ...event }));
        persistDriverReceipt(params.receiptPath, receipt, state.intent, profile);
    };
    const fail = (kind, message, evidence = null) => {
        const failure = { kind, message: clip(message, 400), ...(evidence ? { evidence } : {}) };
        state.failures.push(failure);
        record('failure', { failureKind: kind });
        return new DriverAssertion(kind, message, evidence);
    };

    if (params.mode === 'transition') {
        state.intent = params.intent;
        state.receipt = newDriverReceipt(params.intent, profile);
        persistReceipt();                       // the receipt exists before any product mutation can
    }

    // A step that fails for any other reason than a recorded assertion is a setup failure: recorded once, as the primary failure, and thrown so the
    // product's own rollback runs. It is never a refusal and never earns a mutant kill.
    const guarded = step => {
        try { return step(); } catch (error) {
            if (!state.failures.length) throw fail(error?.kind ?? 'setup', error?.message ?? String(error), error?.evidence ?? null);
            throw error;
        }
    };

    // ---- the synchronous boundary at the production old-Box stop ----
    function boundary() {
        const deadline = now() + bounds.boundaryMs;
        const remaining = () => {
            const left = deadline - now();
            if (left <= 0) throw setup('the synchronous boundary section exceeded its ceiling');
            return left;
        };
        record('boundary-begin');
        identity();
        const engine = observeEngine(base, profile, { infoMs: Math.min(bounds.infoMs, remaining()) });
        state.engine = engine;
        const inspected = base.query('podman', ['container', 'inspect', '--format', INSPECT, profile.box.id], { timeoutMs: Math.min(bounds.programMs, remaining()) });
        let box;
        try { box = JSON.parse(inspected.stdout); } catch { throw setup('the original Box could not be inspected at the boundary'); }
        if (!inspected.ok || box.id !== profile.box.id || box.created !== profile.box.created || box.running !== true
            || String(box.image).replace(/^sha256:/, '') !== String(profile.box.image).replace(/^sha256:/, '')
            || jsonDigest({ labels: box.labels, mounts: box.mounts }) !== profile.box.contractDigest) throw setup('the original Box is not the running immutable fixture Box at the boundary');
        // The one new product restart journal of this invocation and this old ID, at its stop-graph intent.
        const fresh = productTransitionIds(profile).filter(id => !state.intent.priorTransitionIds.includes(id));
        if (fresh.length !== 1) throw setup(`expected exactly one new product transition at the boundary, found ${fresh.length}`);
        const journal = readC5ProductJournal(profile, fresh[0]);
        if (journal.operation !== 'restart' || journal.old.containerId !== profile.box.id || journal.identity.engineIdentity !== engine.product
            || journal.phase !== 'barrier-installed' || journal.nextAction?.kind !== 'stop-graph' || journal.nextAction.exactContainerId !== profile.box.id
            || journal.commitIntent !== null || journal.attempts.length !== 0 || journal.desired.reapplyConfigurationRef) throw setup('the product journal is not the forward stop-graph intent of this Box');
        const oldConfiguration = readC5Snapshot(profile, journal.old.configurationRef);
        const desiredConfiguration = readC5Snapshot(profile, journal.desired.configurationRef);
        if (!oldConfiguration.hardware || desiredConfiguration.hardware !== null) throw setup('the product snapshots are not a gate-on to gate-off pair');
        state.operationId = journal.operationId;
        // Persist the fixture-to-product-operation binding BEFORE any old-Box stop or removal.
        Object.assign(state.receipt, { phase: 'bound', productOperationId: journal.operationId, productEngineIdentity: engine.product,
            oldConfigurationRef: journal.old.configurationRef, desiredConfigurationRef: journal.desired.configurationRef });
        record('bound', { productOperationId: journal.operationId });
        persistReceipt();

        const storeIdentity = identity();
        const programParams = domain => storeProgramParams({ profile: { host: profile.host, source: profile.source }, identity: storeIdentity, domain, mode: 'inspect' });
        const hostView = () => {
            const hostResult = spawnSync(process.execPath, hostProgramWords(programParams('host')), { env: { PATH: process.env.PATH, HOME: homeDirectory }, encoding: 'utf8', timeout: Math.min(bounds.programMs, remaining()) });
            const lines = hostResult.status === 0 ? parseProgramLines(hostResult.stdout) : null;
            if (!lines) throw setup('the host store program did not answer');
            return assertValidStore(lines[0], 'host view');
        };
        const boxView = () => {
            const boxResult = base.query('podman', boxProgramWords(profile.box.id, programParams('box')), { timeoutMs: Math.min(bounds.programMs, remaining()) });
            const lines = boxResult?.ok ? parseProgramLines(boxResult.stdout) : null;
            if (!lines) throw setup('the in-Box store program did not answer');
            return assertValidStore(lines[0], 'Box view');
        };
        const before = { host: hostView(), box: boxView() };
        try { assertSameStore(before.host, before.box, 'at the boundary'); } catch (error) { throw setup(error.message); }
        if (tokenKey(before.host.token) !== tokenKey(params.expectedToken) || before.host.count !== 0) throw setup('the store at the boundary is not the empty store at the recorded stamp');
        const barrier = before.host.barrier;
        record('boundary-views', { barrier: barrier ? { operationId: barrier.operationId ?? null, policyToken: barrier.policyToken ?? null, malformed: barrier.malformed === true } : null,
            token: before.host.token, count: before.host.count, boxBarrierOperationId: before.box.barrier?.operationId ?? null });

        // The real administrator writers, in the OLD Box, synchronously, with the recorded stamp. Their real replies are kept whatever they say.
        const write = (name, body) => {
            const reply = base.query('podman', adminExecWords(profile.box.id, 'POST', body), { timeoutMs: Math.min(bounds.adminMs, remaining()) });
            const parsed = reply?.ok ? parseAdminReply(reply.stdout) : null;
            if (!parsed) throw setup(`the administrator channel did not answer the ${name}`, { status: reply?.status ?? null, error: clip(reply?.error?.code) });
            record(`writer-${name}`, { status: parsed.status, error: parsed.body?.error ?? null, committed: parsed.body?.committed === true, ok: parsed.body?.ok ?? null, token: parsed.body?.token ?? null });
            return parsed;
        };
        const set = write('set', { action: 'set_agent_limits', expectedToken: params.expectedToken, agentRef: params.agentRef, limits: { ...OVERRIDES.low } });
        const cleared = write('clear', { action: 'clear_agent_limits', expectedToken: params.expectedToken, agentRef: params.agentRef });
        const after = { host: hostView(), box: boxView() };
        record('boundary-after', { token: after.host.token, count: after.host.count });

        const problems = [];
        for (const [name, reply] of [['setter', set], ['clear', cleared]]) {
            const body = reply.body;
            if (reply.status !== 409 || body?.ok !== false || body?.error !== 'hardware_limits_transition' || body?.committed === true) {
                problems.push(fail('writer-outcome', `The in-Box ${name} was not refused with hardware_limits_transition at the production stop boundary (HTTP ${reply.status}, ${clip(body?.error, 60)}${body?.committed === true ? ', committed' : ''})`, { writer: name, status: reply.status, body: clip(reply.text, 300) }));
            }
        }
        if (!barrier || barrier.malformed || barrier.operationId !== journal.operationId || tokenKey(barrier.policyToken) !== tokenKey(params.expectedToken)
            || before.box.barrier?.operationId !== journal.operationId) {
            problems.push(fail('barrier-state', 'The downgrade barrier is not held by this product operation at the stamp T at the production stop boundary', { barrier: barrier ?? null, operationId: journal.operationId }));
        }
        if (tokenKey(after.host.token) !== tokenKey(before.host.token) || after.host.count !== 0 || after.host.storeId !== before.host.storeId
            || tokenKey(after.box.token) !== tokenKey(before.host.token) || after.box.count !== 0) {
            problems.push(fail('store-changed', 'The store identity, stamp or entries changed during the boundary', { before: { token: before.host.token, count: before.host.count }, after: { token: after.host.token, count: after.host.count } }));
        }
        state.boundary = { reached: true, operationId: journal.operationId, replies: { set: { status: set.status, error: set.body?.error ?? null }, clear: { status: cleared.status, error: cleared.body?.error ?? null } } };
        persistReceipt();
        if (problems.length) throw problems[0];
    }

    // ---- retention of the barrier at the later forward and rollback boundaries ----
    function retention(kind) {
        let held = false; let operationId = null;
        try {
            const barrier = readBarrier({ paths: paths() });
            operationId = barrier && !barrier.malformed ? barrier.barrier.operationId : null;
            held = operationId === state.operationId;
        } catch { held = false; }
        let stage = null;
        try {
            const journal = readC5ProductJournal(profile, state.operationId);
            stage = journal.attempts.at(-1)?.stage ?? null;
        } catch { stage = null; }
        record(`retention-${kind}`, { held, operationId, stage });
        if (!held && !state.failures.some(failure => failure.kind === 'barrier-retention')) {
            throw fail('barrier-retention', `The downgrade barrier was not retained at the ${kind} boundary${stage ? ` (${stage})` : ''}`, { boundary: kind, stage, operationId });
        }
    }

    // ---- the decorated production runner: real methods, real results ----
    const decorated = {
        query(command, args, options) {
            state.queryCalls += 1;
            return base.query(command, args, options);
        },
        stream(command, args, options) {
            return base.stream(command, args, options);
        },
        run(command, args, options) {
            state.runCalls += 1;
            const c = classifyRun(command, args, { workspaceRoot: profile.workspace.path });
            if (c.mutation) {
                state.mutations.push({ kind: c.kind, id: c.id });
                if (params.mode === 'writer-first') {
                    throw fail('lifecycle-mutation', `A lifecycle mutation (${c.kind}) reached the engine boundary in the writer-first order`, { kind: c.kind });
                }
                if (params.mode === 'transition' && !state.failures.length) {
                    if (c.kind === 'graph-stop' && c.id === profile.box.id && state.boundary === null) guarded(boundary);
                    else if (state.boundary === null) throw fail('order', `The first lifecycle mutation was ${c.kind}, not the old Box's ploinky-local stop`, { kind: c.kind });
                    else if (c.kind !== 'graph-stop') guarded(() => retention(c.kind));
                } else if (params.mode === 'transition') record(`mutation-${c.kind}`, { afterFailure: true });
            }
            const result = base.run(command, args, options);
            if (c.mutation && params.mode === 'transition') record(`delegated-${c.kind}`);
            return result;
        },
    };

    const makeSupervisor = seams.supervisor ?? (runner => production.createBoxSupervisor({ runner, env: process.env, launchCwd: process.cwd() }));
    const real = makeSupervisor(decorated);
    // The supervisor is frozen: a new delegating wrapper, never an assignment to its methods.
    const wrapper = Object.freeze({
        ...real,
        ...(params.mode === 'destroy' ? {
            runDestroyTransaction(selected, options) {
                if ((selected ?? null) !== (params.expectedContainerId ?? null)) {
                    throw fail('destroy-target', `The Box selected for destruction (${selected ? String(selected).slice(0, 12) : 'none'}) is not the one cleanup proved (${params.expectedContainerId ? params.expectedContainerId.slice(0, 12) : 'none'})`);
                }
                record('destroy-selected', { id: selected ?? null });
                return real.runDestroyTransaction(selected, options);
            },
        } : {}),
    });

    const out = sink(); const err = sink();
    let cliError = null; let exitCode = null;
    try {
        exitCode = await cli(params.mode === 'destroy' ? ['destroy', '--delete-cache'] : ['restart'], {
            env: process.env, output: out, errorOutput: err, supervisor: wrapper, detectInsideBox: () => false, cwd: () => process.cwd(),
        });
    } catch (error) { cliError = error; }
    record('cli-settled', { exitCode, errorCode: cliError?.code ?? null });

    // ---- the verdict ----
    const primary = state.failures[0] ?? null;
    let journal = null; let outcome;
    if (params.mode === 'transition' && state.operationId) {
        try { journal = readC5ProductJournal(profile, state.operationId); } catch { journal = null; }
    }
    if (params.mode === 'writer-first') {
        const typed = cliError?.code === 'PLOINKY_BOX_HARDWARE_LIMITS_STORED';
        outcome = { state: typed && !state.mutations.length && !primary ? 'success' : 'failed', typedRefusal: typed, errorCode: cliError?.code ?? null,
            message: clip(cliError?.message ?? '', 300), mutations: state.mutations.length };
    } else if (params.mode === 'destroy') {
        outcome = { state: exitCode === 0 && !cliError && !primary ? 'success' : 'failed', errorCode: cliError?.code ?? null, message: clip(cliError?.message ?? '', 300) };
    } else {
        const committed = journal?.phase === 'committed' && journal.commitIntent?.result === 'desired-off';
        outcome = { state: exitCode === 0 && !cliError && !primary && committed ? 'success' : 'failed', exitCode, errorCode: cliError?.code ?? null,
            message: clip(cliError?.message ?? '', 300), journalPhase: journal?.phase ?? null, commitResult: journal?.commitIntent?.result ?? null,
            rolledBack: journal?.phase === 'rolled-back' };
    }
    if (params.mode === 'transition') {
        Object.assign(state.receipt, {
            phase: 'settled', outcome, primaryFailure: primary,
            attempts: (journal?.attempts ?? []).map(attempt => ({ attemptId: attempt.attemptId, stage: attempt.stage, observedId: attempt.observedId, configurationRef: attempt.configurationRef })),
            finalContainerId: journal?.commitIntent?.finalContainerId ?? null,
        });
        persistReceipt();
    }
    const summary = {
        schema: DRIVER_SCHEMA, driver: C5_DRIVER_NAME, mode: params.mode, outcome, primaryFailure: primary, failures: state.failures.slice(0, 8),
        boundary: state.boundary, operationId: state.operationId, mutations: state.mutations.slice(0, 32), runCalls: state.runCalls,
        events: events.slice(0, MAX_EVENTS), stdoutTail: out.tail(), stderrTail: err.tail(),
        engine: state.engine ? { harness: state.engine.harness, product: state.engine.product } : null,
    };
    return { exitCode: outcome.state === 'success' ? 0 : 1, summary };
}

// Production entry: one JSON argument; the summary is one stdout line and the exit status says whether the lifecycle and every assertion held.
const invokedPath = process.argv[1] ? fs.realpathSync(path.resolve(process.argv[1])) : '';
if (invokedPath === fs.realpathSync(fileURLToPath(import.meta.url))) {
    let result;
    try {
        result = await runDriver(JSON.parse(process.argv[2] ?? 'null'));
    } catch (error) {
        const failure = { kind: error?.kind ?? 'setup', message: clip(error?.message ?? error, 400) };
        result = { exitCode: 2, summary: { schema: DRIVER_SCHEMA, driver: C5_DRIVER_NAME, outcome: { state: 'failed' }, primaryFailure: failure, failures: [failure] } };
    }
    process.stdout.write(`${JSON.stringify(result.summary)}\n`);
    process.exitCode = result.exitCode;
}
