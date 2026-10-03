// The apparatus-mps executors: LIVE-P1 to LIVE-P4 (plan §15.4, §15.5, §18.8
// to §18.10). The cases run on the apparatus host as the runner user, behind
// the GPU idle gate (liveGpuGate.mjs), against the owned gate-on Box that
// provisioning created. MPS shares are set only through the administrator
// path: the hardware-limits store and Apply, reached through the Router's own
// route from inside the Box. Nothing here changes the compute mode, signals a
// process it does not own, or touches a resource that is not recorded.
//
// Every case writes its evidence BEFORE asserting, and the first failing
// assertion carries that evidence in `error.evidence`. A busy GPU, an
// unsupported readback, a missing prerequisite or an unavailable
// administrator channel is BLOCKED (code LIVE_PREREQUISITE_MISSING), never PASS.
import fs from 'node:fs';
import path from 'node:path';
import { BOX_LABELS } from '../../ploinky-box/constants.mjs';
import { LIMITS_HASH_LABEL } from '../../cli/sandbox/hardwareLimits/resolve.mjs';
import { formatApplyCause } from '../../cli/sandbox/hardwareLimits/applyCause.mjs';
import { FAILURE_EVIDENCE_CASE, blocked, boundedTail, checkedJson, commandTails, failureEvidenceNames, jsonDigest } from './liveCommon.mjs';
import { requireTransport } from './liveProcess.mjs';
import { fixtureContainerName } from './liveFixture.mjs';
import { recordHostRecords } from './liveCleanup.mjs';
import { createHostProc, boxCgroupPrefix, agentLeaf } from './liveGpuHost.mjs';
import { parseGpuInventory } from './liveGpu.mjs';
import { createGpuGate, finalGpuObservation, gpuQueryArgv } from './liveGpuGate.mjs';
import {
    ADMIN_REQUEST, DRAIN_ACKNOWLEDGEMENT_BASIS, GPU_AGENT_INSPECT, GPU_SHARES, MIB, MPS_CLIENT_PIPE, GPU_GRANT_FACTS, MPS_FAILURE_EVIDENCE, MPS_KILL_OWNED_DAEMON, MPS_OBSERVE, NESTED_NAME_LIST_FORMAT, PROBE_DEADLINE_MS,
    MPS_CLIENT_USER, TIGHTER_CLIENT, assertMpsControlCommand, classifyMpsReply, controlHelperExecArgv, controlHelperRunArgv, parseProbeResult, probeBoundMiB, probeExecArgv, serverDefaultMiB, shareMemoryMiB,
} from './liveGpuCommands.mjs';

const REPOSITORY = 'hwlfixture';
export const GPU_AGENT_REFS = Object.freeze({ probe: `${REPOSITORY}/probe`, peer: `${REPOSITORY}/peer`, cpu: `${REPOSITORY}/cpu` });
// The owned agents a GPU case set works on: the apparatus-mps fixture (two share clients and an
// unrelated CPU agent), or the apparatus-local-llm and apparatus-vllm fixture (liveLlmCases.mjs
// passes its own): the repository, the reference of each role, the agent name where it differs
// from the role, the roles that take a share and the role that must stay untouched.
export const P_FIXTURE = Object.freeze({ repository: REPOSITORY, refs: GPU_AGENT_REFS, names: Object.freeze({}), roles: Object.freeze(['probe', 'peer', 'cpu']), clients: Object.freeze(['probe', 'peer']), unrelated: 'cpu' });
const MPS_ENV_NAMES = Object.freeze(['CUDA_MPS_PIPE_DIRECTORY', 'CUDA_MPS_ACTIVE_THREAD_PERCENTAGE', 'CUDA_MPS_PINNED_DEVICE_MEM_LIMIT']);
const MPS_GENERATION_LABEL = 'ploinky.mpsgeneration';
// A holder keeps one CUDA context (one MPS client connection) alive, so the
// daemon has a server for the control commands of P4 to name.
const HOLDER_PROGRAM = 'import ctypes as c,time\ncuda=c.CDLL("/usr/local/nvidia/lib64/libcuda.so.1")\nassert cuda.cuInit(0)==0\ndev=c.c_int()\nassert cuda.cuDeviceGet(c.byref(dev),0)==0\nctx=c.c_void_p()\nassert cuda.cuDevicePrimaryCtxRetain(c.byref(ctx),dev)==0\ntime.sleep(120)\n';

const needs = (condition, message) => { if (!condition) throw blocked(message); };
const expects = (condition, message) => { if (!condition) throw new Error(message); };
// Order-insensitive structural equality: the probe prints sorted keys, the API
// its own order, and neither is an assertion.
const canon = value => (Array.isArray(value) ? `[${value.map(canon).join(',')}]`
    : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canon(value[key])}`).join(',')}}` : JSON.stringify(value ?? null));
const same = (left, right) => canon(left) === canon(right);

// The evidence a case returns in the report is bounded (120000 bytes, four
// cases, printed with indentation): the run's report is one JSON document of
// at most one MiB over the remote transport, and the full evidence stays in
// the private artifact file of the case.
export function compactEvidence(value, limit = 120000) {
    const size = candidate => Buffer.byteLength(JSON.stringify(candidate));
    if (size(value) <= limit) return value;
    const shrink = (node, maxString, maxArray) => {
        if (typeof node === 'string') return node.length > maxString ? `${node.slice(0, maxString)}...[${node.length - maxString} characters omitted]` : node;
        if (Array.isArray(node)) {
            const kept = node.length > maxArray ? [...node.slice(0, maxArray / 2), { omitted: node.length - maxArray }, ...node.slice(-maxArray / 2)] : node;
            return kept.map(entry => shrink(entry, maxString, maxArray));
        }
        if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([key, entry]) => [key, shrink(entry, maxString, maxArray)]));
        return node;
    };
    for (const [maxString, maxArray] of [[600, 40], [300, 20], [160, 10], [80, 6]]) {
        const candidate = shrink(value, maxString, maxArray);
        if (size(candidate) <= limit) return candidate;
    }
    return { caseId: value.caseId, result: value.result ?? null, failure: value.failure ?? null, truncated: true, note: 'The evidence exceeded its report bound; the full evidence is the private artifact of the case.' };
}
const hexTail = id => String(id).slice(0, 12);

export const DEFAULT_TIMINGS = Object.freeze({
    sampleMs: 20, settleMs: 250, settleSamples: 4, monitorMs: 2000, applyMs: 600000, controlMs: 20000, probeMs: PROBE_DEADLINE_MS + 10000,
    holderMs: 180000, serverWaitMs: 20000, recoveryMs: 120000, afterApplyMs: 1000,
});

export function createGpuCases(ctx) {
    const { profile, run, command, engine, core, nested, inspectBox, safeArtifact, persist, processProvider, env, signal } = ctx;
    const fixture = ctx.fixture || P_FIXTURE;
    const nameOf = role => fixture.names?.[role] ?? role;
    const host = ctx.host || createHostProc();
    const timings = { ...DEFAULT_TIMINGS, ...(ctx.timings || {}) };
    const sleep = ctx.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const gpu = profile.gpu;
    const workspace = profile.workspace.path;
    const image = profile.provision?.image || null;
    let prepared = null;
    let captureCounter = 0;
    const helpers = [];
    // Set while the product cleanup runs: owned-helper removal then uses the cleanup signal.
    let cleanupMode = false;

    // The last Apply this executor sent, for the failure evidence.
    let applyAttempt = null;
    const routerLog = path.join(workspace, '.ploinky', 'logs', 'router.log');
    const watchdogLog = path.join(workspace, '.ploinky', 'logs', 'watchdog.log');
    const logSizes = () => ({ router: fileSize(routerLog), watchdog: fileSize(watchdogLog) });
    function fileSize(file) { try { return fs.lstatSync(file).size; } catch { return null; } }
    // The bounded, redacted tail of one host log, from where it stood when the Apply began when that is known. The
    // workspace logs are host files of the owned workspace; they are opened without following links.
    const readLog = ctx.readLog || ((file, { from = null, maxBytes = 16384 } = {}) => {
        let fd = null;
        try {
            fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
            const stat = fs.fstatSync(fd);
            if (!stat.isFile()) return { file, unavailable: 'not a regular file' };
            const windowed = Number.isInteger(from) && from >= 0 && from <= stat.size;
            const start = Math.max(windowed ? from : 0, stat.size - maxBytes);
            const buffer = Buffer.alloc(stat.size - start);
            if (buffer.length) fs.readSync(fd, buffer, 0, buffer.length, start);
            const tail = boundedTail(buffer.toString('utf8'), maxBytes);
            return { file, size: stat.size, from: start, window: windowed ? 'since-apply-start' : 'tail', text: tail.text, droppedBytes: tail.droppedBytes };
        } catch (error) { return { file, unavailable: String(error?.code || error?.message || error).slice(0, 64) }; }
        finally { if (fd !== null) { try { fs.closeSync(fd); } catch { /* read only */ } } }
    });

    // ---------------------------------------------------------------------
    // Evidence: one artifact per case, rewritten as the case learns something.
    function evidenceFor(id) {
        const data = { caseId: id, steps: [] };
        const write = () => safeArtifact(`gpu-${id.toLowerCase()}`, data);
        return {
            data,
            put(name, value) { data[name] = value; write(); },
            step(name, value = null) { data.steps.push({ name, at: Date.now(), ...(value === null ? {} : { value }) }); write(); },
            write,
        };
    }
    async function runCase(id, body, { failureEvidence = FAILURE_EVIDENCE_CASE.test(id) } = {}) {
        const evidence = evidenceFor(id);
        // The gate's own summary (baseline, registered owned processes, the
        // last checks, a trip) belongs to the evidence on every path.
        const withGate = () => { try { evidence.put('gate', prepared?.gate ? prepared.gate.summary() : null); } catch { /* evidence only */ } };
        try {
            const result = await body(evidence);
            evidence.put('result', 'pass');
            withGate();
            return compactEvidence({ ...evidence.data, ...(result || {}) });
        } catch (error) {
            // The daemon's state and logs, the Router and Watchdog tails and the Apply response are written as run
            // artifacts now: the product cleanup destroys the Box and everything in it. A failed capture is recorded in
            // the evidence and never hides this failure.
            if (failureEvidence) { try { evidence.put('failureEvidence', await captureFailureEvidence(id, error)); } catch (captureError) { evidence.put('failureEvidence', { error: String(captureError?.message || captureError).slice(0, 300) }); } }
            evidence.put('failure', { message: String(error?.message || error).slice(0, 1024), code: error?.code || null, gate: error?.gate || null });
            withGate();
            error.evidence = compactEvidence({ ...evidence.data });
            throw error;
        }
    }

    // The failure evidence of a MPS case, written as four run artifacts (liveCommon failureEvidenceNames) before the
    // product cleanup destroys the Box. Each item records why it could not be read instead of being left out.
    async function captureFailureEvidence(id, error) {
        const names = failureEvidenceNames(id);
        const at = Date.now();
        const reason = String(error?.message || error).slice(0, 300);
        const written = {};
        const put = (suffix, value) => {
            const problem = safeArtifact(`gpu-${id.toLowerCase()}-${suffix}`, { caseId: id, at, reason, ...value });
            written[suffix] = problem ? { error: problem } : 'written';
        };
        let observed;
        try { observed = checkedJson(await observe('mps-failure-evidence', [...core, 'node', '-e', MPS_FAILURE_EVIDENCE], { deadlineMs: 30000, cleanup: true })); }
        catch (observationError) { observed = { unavailable: String(observationError?.message || observationError).slice(0, 300) }; }
        put('mps-state', observed.unavailable ? { unavailable: observed.unavailable } : { state: observed.state ?? null, daemon: observed.daemon ?? null, problems: observed.problems ?? [] });
        put('mps-logs', observed.unavailable ? { unavailable: observed.unavailable } : {
            directories: (observed.logs || []).map(directory => ({ directory: directory.directory, error: directory.error ?? null, files: (directory.files || []).map(file => ({
                name: file.name, size: file.size ?? null, error: file.error ?? null, unsafe: file.unsafe ?? false, ...(typeof file.tail === 'string' ? { tail: boundedTail(file.tail, 8192).text } : {}) })) })),
            entries: observed.entries ?? [], omittedLogFiles: observed.omittedLogFiles ?? 0, problems: observed.problems ?? [],
        });
        const attempt = applyAttempt;
        put('router-logs', {
            window: attempt ? { startedAt: attempt.startedAt, endedAt: attempt.endedAt, label: attempt.label } : null,
            router: readLog(routerLog, { from: attempt?.logMarks?.router ?? null }), watchdog: readLog(watchdogLog, { from: attempt?.logMarks?.watchdog ?? null }),
        });
        put('apply-response', attempt ? { apply: { label: attempt.label, refs: attempt.refs, startedAt: attempt.startedAt, endedAt: attempt.endedAt, status: attempt.status, error: attempt.error, response: attempt.response } } : { unavailable: 'no Apply was sent before the failure' });
        return { artifacts: names, written };
    }

    // ---------------------------------------------------------------------
    // The GPU query: a read-only nvidia-smi on the host, by its pinned path.
    // It is not journaled call by call (a run may poll it hundreds of times);
    // the gate keeps its own bounded history in each case's evidence.
    const smiQuery = abort => processProvider(gpu.smi.path, gpuQueryArgv(gpu.uuid), {
        cwd: profile.host.home, env: { PATH: '/usr/bin:/bin', HOME: profile.host.home }, deadlineMs: 30000, maxBytes: 1048576, signal: abort || signal,
    });

    // ---------------------------------------------------------------------
    // Nested-engine observation (read-only, not journaled).
    const observe = (kind, args, options = {}) => command(kind, profile.engine.path, args, { journal: false, deadlineMs: 30000, cleanup: cleanupMode, ...options });
    async function nestedRows() {
        const result = await observe('nested-name-list', [...nested, 'container', 'ps', '--all', '--no-trunc', '--format', NESTED_NAME_LIST_FORMAT], { deadlineMs: 20000 });
        const lines = result.stdout.split('\n').filter(value => value.trim());
        const rows = lines.map(line => /^([a-f0-9]{64}) (\S+)$/.exec(line.trim()));
        if (lines.length > 64 || rows.some(row => !row)) throw new Error('Unsupported nested container listing');
        return rows.map(row => ({ id: row[1], name: row[2].replace(/^\//, '') }));
    }
    async function inspectNested(id) {
        const value = checkedJson(await observe('nested-inspect', [...nested, 'container', 'inspect', '--format', GPU_AGENT_INSPECT, id], { deadlineMs: 20000 }));
        expects(value.id === id, `Nested inspect answered for another container (${hexTail(value.id)})`);
        return value;
    }
    // The identity of one inspected agent against the pinned image. The fixture start created the agent from the digest
    // reference, so its name is that reference; its image ID is the pinned image's identity. A GPU share client is recreated
    // from that immutable ID (agentServiceManager.js `image = launch.imageId`), and the engine reports the name the container
    // was created with: the ID. Identity is therefore the image ID recorded at the fixture start, and the name is that
    // reference or that same ID. Before the ID is recorded only the reference is accepted. Shared by every case runner.
    function pinnedImageIdentity(role, inspected) {
        const pinned = prepared?.agents?.[role]?.imageId ?? null;
        const bare = value => String(value ?? '').replace(/^sha256:/, '');
        const named = pinned === null ? [image] : [image, bare(pinned), `sha256:${bare(pinned)}`];
        const ok = (pinned === null || bare(inspected.image) === bare(pinned)) && named.includes(inspected.imageName);
        return { ok, pinnedImageId: pinned === null ? null : bare(pinned), imageId: bare(inspected.image), imageName: inspected.imageName ?? null, pinnedReference: image, createdByReference: inspected.imageName === image };
    }

    // The one container that currently carries an owned agent's name. A
    // replacement keeps the name and has a new immutable ID.
    async function agentNow(role) {
        const name = fixtureContainerName(workspace, nameOf(role), fixture.repository);
        const rows = (await nestedRows()).filter(row => row.name === name);
        expects(rows.length === 1, `Expected exactly one nested container named ${name}, found ${rows.length}`);
        const inspected = await inspectNested(rows[0].id);
        expects(inspected.running === true, `Agent ${role} is not the pinned running instance`);
        if (image) {
            const identity = pinnedImageIdentity(role, inspected);
            expects(identity.ok, `Agent ${role} is not the pinned running instance (image ${hexTail(identity.imageId)}, created from ${String(inspected.imageName).slice(0, 120)})`);
        }
        return { role, ref: fixture.refs[role], name, ...inspected };
    }

    // ---------------------------------------------------------------------
    // The administrator channel: the Router's hardware-limits route, reached
    // from inside the Box with the product's own local-operator session.
    async function adminCall(kind, method, body = null) {
        const argv = [...core, 'node', '-e', ADMIN_REQUEST, method, body === null ? '' : JSON.stringify(body)];
        const mutating = method === 'POST';
        const result = await command(kind, profile.engine.path, argv, { deadlineMs: mutating && body?.action === 'apply' ? timings.applyMs : timings.controlMs, journal: mutating, tolerate: true, capture: mutating ? `gpu-${kind}-${++captureCounter}` : null });
        if (result.cancelled) throw new Error('The administrator request was cancelled');
        let reply = null;
        try { reply = JSON.parse(result.stdout); } catch { reply = null; }
        if (!reply || result.status !== 0 || typeof reply.status !== 'number') {
            throw blocked(`The administrator channel did not answer (${String(reply?.error || `exit ${result.status}`).slice(0, 200)})`);
        }
        let parsed = null;
        try { parsed = JSON.parse(reply.text); } catch { parsed = null; }
        return { status: reply.status, body: parsed, text: boundedTail(reply.text, 2048).text, fullText: boundedTail(reply.text, 65536).text };
    }
    const admin = {
        async state() {
            const reply = await adminCall('gpu-admin-state', 'GET');
            // An unauthenticated, forbidden, missing or unavailable route is a
            // prerequisite, not a failure of the share.
            if ([401, 403, 404, 409, 503].includes(reply.status) || !reply.body) throw blocked(`The hardware-limits administrator route answered ${reply.status}: ${reply.text.slice(0, 200)}`);
            expects(reply.status === 200 && reply.body.ok === true && reply.body.token, `Unexpected administrator state reply (${reply.status})`);
            return reply.body;
        },
        async post(kind, body) {
            const current = await admin.state();
            const reply = await adminCall(kind, 'POST', { ...body, expectedToken: current.token });
            return { ...reply, token: current.token };
        },
    };
    const agentEntry = (state, ref) => state.agents?.find(entry => entry.ref === ref);
    function containerKey(state, ref) {
        const entry = agentEntry(state, ref);
        const containers = entry?.containers || [];
        needs(containers.length === 1 && typeof containers[0].key === 'string', `${ref} must have exactly one running instance to take a GPU share (found ${containers.length})`);
        return containers[0].key;
    }
    // A policy is a GPU share ({smPercent, vramPercent}), as the MPS cases save, or a whole
    // limits object ({cpus, memoryPercent, gpu}), as the local-llm cases do; null clears it.
    const limitsOf = value => (value && (value.gpu !== undefined || value.cpus !== undefined || value.memoryPercent !== undefined) ? value : { gpu: value });
    // Save (or clear) the limits, then Apply the named agents' exact instances.
    // A captured candidate or Box command whose failure carries its cause in the case reason (R12-c(i) does the same for Apply): the exit
    // status, timeout, signal or error, and a bounded, redacted stderr tail. Without this the reason was only the generic transport message
    // and the real cause (attempt 7: `--port is valid only before start, diagnose, or repair`) sat in the capture artifact alone.
    async function causedCommand(kind, binary, args, options) {
        let result = null;
        try { result = await command(kind, binary, args, { ...options, tolerate: true }); }
        catch (error) { throw Object.assign(new Error(`${kind} did not run: ${String(error?.message || error).slice(0, 300)}`), { result: null, cause: error }); }
        try { return requireTransport(result); } catch {
            const tails = commandTails(result, { maxBytes: 300 });
            const parts = [Number.isInteger(result?.status) && result.status !== 0 ? `exit ${result.status}` : null, result?.timedOut ? 'timed out' : null, result?.signal ? `killed by ${result.signal}` : null,
                result?.errorCode ? `error ${result.errorCode}` : null, result?.cancelled ? 'cancelled' : null, result?.truncated ? 'output truncated' : null, result?.settlementForced ? 'forced settlement' : null].filter(Boolean);
            throw Object.assign(new Error(`${kind} failed (${parts.join(', ') || 'no exit status'})${tails.stderrTail ? `: ${tails.stderrTail.trim()}` : ''}`), { result });
        }
    }
    async function applyShares(label, policies, applyRefs, evidence) {
        const gate = prepared.gate;
        await gate.check(`before-apply:${label}`);
        for (const [ref, share] of Object.entries(policies)) {
            const reply = share
                ? await admin.post(`gpu-set-${label}`, { action: 'set_agent_limits', agentRef: ref, limits: limitsOf(share) })
                : await admin.post(`gpu-clear-${label}`, { action: 'clear_agent_limits', agentRef: ref });
            evidence.step(`${share ? 'saved' : 'cleared'}:${ref}`, { status: reply.status });
            expects(reply.status === 200 && reply.body?.ok !== false, `The ${share ? 'save' : 'clear'} of ${ref} failed: ${reply.status} ${reply.text.slice(0, 300)}`);
        }
        const before = await admin.state();
        const keys = applyRefs.map(ref => containerKey(before, ref));
        // What a failed Apply needs afterwards: where the Router and Watchdog logs stood when it began, and its full response.
        applyAttempt = { label, refs: [...applyRefs], startedAt: Date.now(), endedAt: null, logMarks: logSizes(), status: null, response: null, error: null };
        let applied;
        try { applied = await admin.post(`gpu-apply-${label}`, { action: 'apply', containers: keys }); }
        catch (error) { applyAttempt.endedAt = Date.now(); applyAttempt.error = String(error?.message || error).slice(0, 300); throw error; }
        applyAttempt.endedAt = Date.now(); applyAttempt.status = applied.status; applyAttempt.response = applied.fullText;
        evidence.step(`applied:${applyRefs.join(',')}`, { status: applied.status, body: applied.text });
        // A failed Apply's reason leads with its parsed cause (step, class, code, message): the response text is cut at 400
        // characters and, in LIVE-P1 attempt 5, the cut fell before the cause.
        const causeOf = reply => {
            let body = reply.body;
            if (!body) { try { body = JSON.parse(reply.fullText); } catch { body = null; } }
            const cause = body?.cause?.step ? body.cause : body?.results?.find(entry => entry?.cause?.step)?.cause;
            return cause ? formatApplyCause(cause).slice(0, 500) : null;
        };
        const cause = applied.status === 200 && applied.body?.ok !== false ? null : causeOf(applied);
        expects(applied.status === 200 && applied.body?.ok !== false, `Apply of ${applyRefs.join(', ')} failed: ${applied.status} ${cause ? `(${cause}) ` : ''}${applied.text.slice(0, 400)}`);
        // The drain acknowledgement of every recreate this Apply made, as the product lets it be known (see the basis).
        evidence.put('drainAcknowledgements', [...(evidence.data.drainAcknowledgements ?? []), {
            label, refs: [...applyRefs], applyStatus: applied.status, results: (applied.body?.results ?? []).map(entry => ({ state: entry.state })), ...DRAIN_ACKNOWLEDGEMENT_BASIS,
        }]);
        await sleep(timings.afterApplyMs);
        return { keys, state: await admin.state(), reply: applied };
    }
    // An idempotent setup: saves only what differs and applies only what is not applied.
    async function settleShares(label, desired, evidence) {
        const state = await admin.state();
        const policies = {}; const apply = [];
        for (const [role, share] of Object.entries(desired)) {
            const ref = fixture.refs[role];
            const entry = agentEntry(state, ref);
            const configured = entry?.configured?.gpu || null;
            const container = entry?.containers?.[0];
            if (!same(configured, share)) policies[ref] = share;
            if (!same(configured, share) || container?.limitsState !== 'applied' || Boolean(container?.mpsGeneration) !== Boolean(share)) apply.push(ref);
        }
        if (!apply.length) return { state, changed: false };
        const result = await applyShares(label, policies, apply, evidence);
        return { ...result, changed: true };
    }

    // ---------------------------------------------------------------------
    // Host-side identity of Box processes.
    function boxProcessOnHost(boxNsPid, startTime, cgroupPath) {
        const pids = host.cgroupProcs(cgroupPath) || [];
        const matches = pids.map(pid => host.observe(pid)).filter(observed => observed && observed.nspid.length === 2 && observed.nspid[1] === boxNsPid && (startTime === undefined || observed.startIdentity === String(startTime)));
        needs(matches.length === 1, `The Box process ${boxNsPid} cannot be mapped to exactly one host process in ${cgroupPath} (${matches.length})`);
        return matches[0];
    }
    async function observeMps() { return checkedJson(await observe('mps-observe', [...core, 'node', '-e', MPS_OBSERVE])); }
    // The owned daemon as the Box and the host both see it, or null when none runs.
    async function daemonIdentity() {
        const obs = await observeMps();
        const daemon = obs.state?.daemon;
        if (!daemon || !obs.daemon?.alive) return { obs, daemon: null };
        const hostSide = boxProcessOnHost(daemon.pid, daemon.startTime, `${prepared.prefix}/ploinky/core`);
        return { obs, daemon: { box: obs.daemon, host: hostSide, generation: `${obs.state.daemonGeneration}:${obs.state.configurationGeneration}`, pipeDirectory: obs.state.pipeDirectory } };
    }
    function registerOwned(agent) {
        const leaf = agentLeaf(host, prepared.prefix, agent.id);
        needs(leaf !== null, `The cgroup leaf of ${agent.role} cannot be proved beneath the exact Box`);
        prepared.gate.registerLeaf(leaf);
        return leaf;
    }
    // A host command of the product may create a host record of this exact
    // instance; it is recorded at once so cleanup removes exactly what exists.
    const recordHostState = () => { try { if (recordHostRecords(run, profile, profile.box.instance)) persist(); } catch (error) { safeArtifact('gpu-host-record-error', { message: String(error?.message || error).slice(0, 300) }); } };
    const hostProcessesOf = leaf => (host.cgroupProcs(leaf) || []).map(pid => host.observe(pid)).filter(Boolean);

    // ---------------------------------------------------------------------
    // Preparation, once: the exact Box and its cgroup ancestry, the GPU gate's
    // initial check, the Box's GPU and MPS wiring and the owned fixture files.
    async function prepare() {
        if (prepared) return prepared;
        const box = await inspectBox();
        needs(Number.isSafeInteger(box.pid) && box.pid > 0, 'The engine did not expose the Box init PID');
        const prefix = boxCgroupPrefix(host, { boxPid: box.pid, boxId: box.id });
        const gate = createGpuGate({
            query: () => smiQuery(), uuid: gpu.uuid, host, boxPrefix: prefix, expectedMemoryMiB: gpu.memoryMiB, intervalMs: timings.monitorMs, sleep,
            // The display processes the run's first check recorded (amendment A5): this check
            // tolerates no others.
            tolerated: run.toleratedProcesses || [],
            // Every registration is written into the run manifest, with its full tuple.
            onRegister: record => {
                const entry = { kind: 'gpu-process', ...record };
                if (run.ownedProcesses.some(value => value.hostPid === entry.hostPid && value.startIdentity === entry.startIdentity && value.bootId === entry.bootId)) return;
                if (run.ownedProcesses.length >= 256) throw new Error('Too many registered GPU processes for the manifest');
                run.ownedProcesses.push(entry); persist();
            },
        });
        await gate.initial();
        const mount = destination => box.mounts?.find(entry => entry.Destination === destination);
        const wired = [['nvidia-cuda-mps-control', gpu.mpsControl.path], ['nvidia-cuda-mps-server', gpu.mpsServer.path], ['nvidia-smi', gpu.smi.path]];
        needs(/^[a-f0-9]{64}$/.test(box.labels?.[BOX_LABELS.gpuGrant] || ''), 'The Box carries no GPU grant wiring label');
        needs(/^[a-f0-9]{64}$/.test(box.labels?.[BOX_LABELS.hardwareLimits] || ''), 'The Box is not a gate-on hardware-limits Box');
        for (const [name, source] of wired) {
            const entry = mount(`/usr/local/nvidia/bin/${name}`);
            needs(entry && entry.Source === source && entry.RW === false, `The Box does not bind ${name} read-only from the pinned host path ${source}`);
        }
        needs(mount('/usr/local/nvidia/lib64/libcuda.so.1')?.RW === false, 'The Box does not bind the driver library libcuda.so.1 read-only');
        prepared = { box, prefix, gate, agents: {} };
        for (const role of fixture.roles) {
            const agent = await agentNow(role);
            // MPS eligibility: the share clients run as a non-root numeric UID:GID.
            if (fixture.clients.includes(role)) needs(MPS_CLIENT_USER.test(agent.user), `The fixture image of ${role} runs as '${agent.user}', not a non-root numeric UID:GID, which MPS eligibility requires`);
            prepared.agents[role] = { id: agent.id, created: agent.created, startedAt: agent.startedAt, pid: agent.pid, user: agent.user, imageId: agent.image };
        }
        if (fixture.unrelated) prepared.cpuBaseline = { ...prepared.agents[fixture.unrelated] };
        return prepared;
    }

    // The unrelated CPU agent is never restarted: its immutable identity is
    // compared with the one recorded before the first mutation.
    async function assertCpuUntouched(evidence, label) {
        const now = await agentNow('cpu');
        const base = prepared.cpuBaseline;
        const unchanged = now.id === base.id && now.created === base.created && now.startedAt === base.startedAt && now.pid === base.pid;
        evidence.step(`cpu-agent:${label}`, { id: hexTail(now.id), unchanged });
        expects(unchanged, `The unrelated CPU agent was restarted at ${label} (container ${hexTail(base.id)} -> ${hexTail(now.id)})`);
    }

    // The exact MPS facts one share client must have.
    function assertClientShare(agent, share, state, daemon, { totalMiB, label }) {
        const memoryMiB = shareMemoryMiB(share.vramPercent, totalMiB);
        const generation = `${state.gpu.mpsGeneration}`;
        expects(MPS_CLIENT_USER.test(agent.user), `${label}: the client image user is ${agent.user}, not a non-root numeric UID:GID`);
        const mpsLabels = Object.keys(agent.labels || {}).filter(key => key.startsWith('ploinky.mps'));
        expects(same(mpsLabels, [MPS_GENERATION_LABEL]) && agent.labels[MPS_GENERATION_LABEL] === generation, `${label}: the MPS labels are not exactly ${MPS_GENERATION_LABEL}=${generation} (${mpsLabels.join(',')}=${agent.labels?.[MPS_GENERATION_LABEL]})`);
        expects(/^[a-f0-9]{64}$/.test(agent.labels?.[LIMITS_HASH_LABEL] || ''), `${label}: the limits hash label is missing`);
        const cuda = (agent.env || []).filter(entry => /^CUDA_/.test(entry)).map(entry => entry.split('=')[0]).sort();
        expects(same(cuda, [...MPS_ENV_NAMES].sort()), `${label}: the CUDA environment is not exactly the three MPS variables (${cuda.join(',')})`);
        const value = name => (agent.env.find(entry => entry.startsWith(`${name}=`)) || '').slice(name.length + 1);
        expects(value('CUDA_MPS_PIPE_DIRECTORY') === MPS_CLIENT_PIPE && value('CUDA_MPS_ACTIVE_THREAD_PERCENTAGE') === String(share.smPercent)
            && value('CUDA_MPS_PINNED_DEVICE_MEM_LIMIT') === `0=${memoryMiB}M`, `${label}: the MPS environment values differ from the saved share ${share.smPercent}%/${memoryMiB}M`);
        const pipe = (agent.mounts || []).filter(mount => mount.Destination === MPS_CLIENT_PIPE);
        expects(pipe.length === 1 && pipe[0].RW === true && pipe[0].Source === daemon.pipeDirectory, `${label}: the private MPS pipe is not bound writable from the daemon's pipe directory`);
        const forbidden = (agent.mounts || []).filter(mount => /nvidia-cuda-mps-(?:control|server)$/.test(String(mount.Source)) || (String(mount.Source).startsWith('/run/ploinky/mps') && mount.Source !== daemon.pipeDirectory));
        expects(!forbidden.length, `${label}: the client holds an MPS tool binary or the state directory (${forbidden.map(mount => mount.Destination).join(',')})`);
    }
    function assertUnshared(agent, label) {
        const mpsLabels = Object.keys(agent.labels || {}).filter(key => key.startsWith('ploinky.mps'));
        const cuda = (agent.env || []).filter(entry => /^CUDA_MPS_/.test(entry));
        const pipe = (agent.mounts || []).filter(mount => mount.Destination === MPS_CLIENT_PIPE || String(mount.Source).startsWith('/run/ploinky/mps'));
        expects(!mpsLabels.length && !cuda.length && !pipe.length, `${label}: the unshared replacement still carries MPS state (labels ${mpsLabels.join(',')}, env ${cuda.length}, mounts ${pipe.length})`);
    }

    // ---------------------------------------------------------------------
    // One CUDA probe in the probe agent, monitored by the gate.
    async function runProbe(evidence, label, { set = {}, unset = [], maxMiB }) {
        const gate = prepared.gate;
        await gate.check(`before-probe:${label}`, { minFreeMiB: maxMiB + 1024 });
        const agent = await agentNow('probe');
        registerOwned(agent);
        const started = Date.now();
        // A foreign user appearing mid-probe trips the gate: the probe's client
        // command is aborted, the case is BLOCKED and cleanup stops the owned clients.
        const result = await gate.monitor(abort => command(`gpu-probe-${label}`, profile.engine.path, [...nested, ...probeExecArgv({ containerId: agent.id, maxMiB, set, unset })],
            { deadlineMs: timings.probeMs, tolerate: true, abort, capture: `gpu-probe-${label}-${++captureCounter}` }));
        const entry = { label, maxMiB, set, unset, ms: Date.now() - started, tails: commandTails(result, { maxBytes: 2048 }) };
        evidence.step(`probe:${label}`, entry);
        // Final bounded observations after the probe settled, before asserting
        // (the A1 pattern): the GPU is idle again but for the owned MPS server,
        // and the daemon is still the same owned one.
        const after = [];
        for (let index = 0; index < timings.settleSamples; index += 1) {
            await sleep(timings.settleMs);
            const checked = await gate.check(`after-probe:${label}`);
            after.push({ usedMiB: checked.memory.usedMiB, freeMiB: checked.memory.freeMiB, owned: checked.owned });
        }
        // The MPS state afterwards (read-only): is the daemon still the owned one,
        // and which servers does it list.
        let mpsAfter = null;
        try {
            const obs = await observeMps();
            mpsAfter = { status: obs.state?.status ?? null, generation: obs.state ? `${obs.state.daemonGeneration}:${obs.state.configurationGeneration}` : null, daemonAlive: obs.daemon?.alive ?? false,
                servers: String((obs.control || []).find(reply => reply.command === 'get_server_list')?.stdout || '').split('\n').filter(Boolean) };
        } catch (error) { mpsAfter = { error: String(error?.message || error).slice(0, 200) }; }
        evidence.step(`probe-after:${label}`, { after, mpsAfter });
        const report = parseProbeResult(result, { maxMiB });
        return { ...entry, report, after, mpsAfter };
    }

    // =====================================================================
    // LIVE-P1: idle gate, driver/tools/device, the first share through Apply.
    async function liveP1() {
        return runCase('LIVE-P1', async evidence => {
            await prepare();
            const { gate } = prepared;
            evidence.put('gateBaseline', gate.baseline);
            await gate.check('P1-before-state');
            const before = await admin.state();
            evidence.put('administratorState', { gate: before.gate, gpu: before.gpu });
            needs(before.gate?.state === 'on', 'The Box hardware-limits gate is not on');
            // When sharing is not eligible, the read-only facts that explain why are recorded first (grant marker,
            // bound tools, the observation with and without the loader path), then the case stops as before.
            if (!(before.gpu?.eligible === true && before.gpu.mode === 'mps-shared')) {
                evidence.put('gpuStatusReason', { code: before.gpu?.code ?? null, reason: String(before.gpu?.reason ?? '').slice(0, 600), causeCode: before.gpu?.causeCode ?? null });
                try { evidence.put('grantFacts', checkedJson(await observe('p1-grant-facts', [...core, 'node', '-e', GPU_GRANT_FACTS]))); }
                catch (error) { evidence.put('grantFacts', { error: String(error?.message || error).slice(0, 300) }); }
            }
            needs(before.gpu?.eligible === true && before.gpu.mode === 'mps-shared', `MPS sharing is not eligible in this Box: ${String(before.gpu?.reason || 'no reason').slice(0, 300)}`);
            needs(before.gpu.deviceUuid === gpu.uuid && before.gpu.memoryModel === 'dedicated' && before.gpu.driverVersion === gpu.driverVersion && before.gpu.deviceMemoryBytes === gpu.memoryMiB * MIB,
                'The Box reports another device, memory model, driver version or memory than the pinned ones');
            // First share through Apply, for the probe agent only.
            const share = GPU_SHARES.first;
            const applied = await applyShares('p1', { [GPU_AGENT_REFS.probe]: share }, [GPU_AGENT_REFS.probe], evidence);
            const state = applied.state;
            // The client keeps the exact share (memoryMiB); the daemon default is that share rounded up to a whole GiB (amendment A6).
            const memoryMiB = shareMemoryMiB(share.vramPercent, gpu.memoryMiB);
            const defaultMiB = serverDefaultMiB(share.vramPercent, gpu.memoryMiB);
            evidence.put('applied', { gpu: state.gpu, container: agentEntry(state, GPU_AGENT_REFS.probe)?.containers });
            evidence.put('expectedDefault', { shareMiB: memoryMiB, defaultMiB });
            expects(state.gpu.daemonStatus === 'ready' && state.gpu.serverDefault?.smPercent === share.smPercent && state.gpu.serverDefault?.vramMiB === defaultMiB,
                `The daemon is not ready with the saved defaults ${share.smPercent}%/${defaultMiB}M for a ${memoryMiB}M share (${JSON.stringify(state.gpu.serverDefault)}, ${state.gpu.daemonStatus})`);
            expects(state.gpu.serverDefault?.shareMemoryMiB === memoryMiB,
                `The status names ${state.gpu.serverDefault?.shareMemoryMiB} MiB as the share the default came from, not ${memoryMiB}`);
            expects(/^[0-9a-f-]{36}:[0-9a-f-]{36}$/.test(state.gpu.mpsGeneration || ''), 'The daemon reports no generation tuple');
            const container = agentEntry(state, GPU_AGENT_REFS.probe).containers[0];
            expects(container.limitsState === 'applied' && container.mpsGeneration === state.gpu.mpsGeneration, 'The probe instance is not applied at the daemon generation');
            // The daemon: uid 1000, /ploinky/core, defaults read back, as the Box and the host see it.
            const identity = await daemonIdentity();
            needs(identity.daemon, 'No owned MPS daemon is observable after Apply');
            const { daemon } = identity;
            gate.registerDaemon(daemon.host.hostPid);
            const replies = Object.fromEntries((identity.obs.control || []).map(reply => [reply.command, reply]));
            evidence.put('daemon', { generation: daemon.generation, box: { pid: daemon.box.pid, startTime: daemon.box.startTime, status: daemon.box.status, cgroup: daemon.box.cgroup },
                host: { pid: daemon.host.hostPid, uid: daemon.host.uid, cgroup: daemon.host.cgroup }, controlReplies: identity.obs.control });
            const ids = line => String(line || '').split(/\s+/).slice(1);
            expects(daemon.box.status.some(line => /^Uid:/.test(line) && ids(line).every(value => value === '1000')), 'The daemon does not run as uid 1000 in the Box');
            expects(daemon.box.cgroup === '0::/ploinky/core' && daemon.host.cgroup === `${prepared.prefix}/ploinky/core`, 'The daemon is not placed in /ploinky/core');
            // The captured fixture (spec 18.8): the daemon's own replies to the readback, sanitized, as the product journaled them.
            evidence.put('lastReadback', identity.obs.state.lastReadback ?? null);
            expects(daemon.box.pipeEnvMatches === true && identity.obs.state.status === 'ready', 'The daemon is not the ready generation that owns the private pipe');
            const runner = host.uid();
            expects(Object.values(daemon.host.uid).every(value => value === runner), `The daemon's host UID is ${JSON.stringify(daemon.host.uid)}, not the runner's ${runner}`);
            // Defaults read back: the raw wire formats are the fixture plan §18.8 asks this case to capture.
            const sm = replies.get_default_active_thread_percentage; const mem = replies['get_default_device_pinned_mem_limit 0'];
            needs(sm?.status === 0 && mem?.status === 0, 'The control queries for the defaults failed');
            const smForm = classifyMpsReply(sm.stdout); const memForm = classifyMpsReply(mem.stdout);
            evidence.put('readbackForms', { sm: smForm, memory: memForm });
            needs(memForm.form === 'integer-with-M-or-G', `The device-memory default reply has an unsupported wire format: ${JSON.stringify(memForm)}`);
            expects(smForm.value === share.smPercent && memForm.bytes === defaultMiB * MIB, `The defaults read back from the daemon differ from the configured ${share.smPercent}%/${defaultMiB}M (read ${JSON.stringify({ sm: smForm, memory: memForm })})`);
            // The probe instance: effective host UID, exact labels, minimal environment, binds.
            const agent = await agentNow('probe');
            registerOwned(agent);
            evidence.put('client', { id: agent.id, user: agent.user, labels: agent.labels, env: (agent.env || []).filter(entry => /^CUDA_/.test(entry)), mounts: (agent.mounts || []).filter(mount => mount.Destination === MPS_CLIENT_PIPE) });
            assertClientShare(agent, share, state, daemon, { totalMiB: gpu.memoryMiB, label: 'probe' });
            const leaf = agentLeaf(host, prepared.prefix, agent.id);
            const processes = hostProcessesOf(leaf);
            evidence.put('clientHostProcesses', processes.map(value => ({ pid: value.hostPid, uid: value.uid })));
            expects(processes.length > 0 && processes.every(value => Object.values(value.uid).every(uid => uid === daemon.host.uid.effective)), 'A probe process does not run as the same host UID as the daemon');
            // The Box itself is unchanged by a share, and other agents stay unshared.
            await inspectBox();
            assertUnshared(await agentNow('cpu'), 'cpu agent');
            await assertCpuUntouched(evidence, 'P1');
        });
    }

    // =====================================================================
    // LIVE-P2: SM affinity and bounded allocations under the share, tighter
    // client values, then a bypass.
    async function liveP2() {
        return runCase('LIVE-P2', async evidence => {
            await prepare();
            const { gate } = prepared;
            await gate.check('P2-start');
            const setup = await settleShares('p2', { probe: GPU_SHARES.first }, evidence);
            const state = setup.state;
            const capMiB = shareMemoryMiB(GPU_SHARES.first.vramPercent, gpu.memoryMiB);
            evidence.put('share', { ...GPU_SHARES.first, capMiB, deviceUuid: gate.baseline.uuid, driverVersion: gpu.driverVersion, serverDefault: state.gpu.serverDefault });
            needs(state.gpu.daemonStatus === 'ready', 'The MPS daemon is not ready for the measurements');
            const identity = await daemonIdentity();
            needs(identity.daemon, 'No owned MPS daemon is observable');
            gate.registerDaemon(identity.daemon.host.hostPid);
            const shareBound = probeBoundMiB(capMiB);
            const sharedEnv = { CUDA_MPS_PIPE_DIRECTORY: MPS_CLIENT_PIPE, CUDA_MPS_ACTIVE_THREAD_PERCENTAGE: String(GPU_SHARES.first.smPercent), CUDA_MPS_PINNED_DEVICE_MEM_LIMIT: `0=${capMiB}M` };
            const measured = {};
            // 1. The saved share (the client's own environment).
            measured.share = await runProbe(evidence, 'share', { maxMiB: shareBound });
            // 2. Tighter client values, one at a time.
            measured.tighterSm = await runProbe(evidence, 'tighter-sm', { maxMiB: shareBound, set: { CUDA_MPS_ACTIVE_THREAD_PERCENTAGE: String(TIGHTER_CLIENT.smPercent) } });
            measured.tighterMemory = await runProbe(evidence, 'tighter-memory', { maxMiB: probeBoundMiB(TIGHTER_CLIENT.memoryMiB), set: { CUDA_MPS_PINNED_DEVICE_MEM_LIMIT: `0=${TIGHTER_CLIENT.memoryMiB}M` } });
            // 3. The bypass: no MPS environment at all, above the cap.
            measured.bypass = await runProbe(evidence, 'bypass', { maxMiB: shareBound, unset: [...MPS_ENV_NAMES] });
            const summary = Object.fromEntries(Object.entries(measured).map(([name, value]) => [name, {
                smCount: value.report.smCount, allocatedMiB: value.report.allocatedMiB, boundMiB: value.report.boundMiB, termination: value.report.termination,
                memGetInfo: value.report.memGetInfo, mpsEnv: value.report.mpsEnv, driverApiVersion: value.report.driverApiVersion,
            }]));
            // The full-device SM count is the independently pinned one; the bypass under
            // test is never what defines it. The mismatch, if any, stays in the evidence.
            const fullSm = gpu.expectedSmCount;
            evidence.put('measurements', summary);
            evidence.put('rounding', {
                capMiB, shareAllocatedMiB: summary.share.allocatedMiB, overheadMiB: capMiB - summary.share.allocatedMiB, stepMiB: 128,
                shareSmCount: summary.share.smCount, pinnedFullSmCount: fullSm, bypassSmCount: summary.bypass.smCount, bypassMatchesPinned: summary.bypass.smCount === fullSm,
                requestedSmPercent: GPU_SHARES.first.smPercent, expectedSmShare: Math.ceil(fullSm * GPU_SHARES.first.smPercent / 100),
            });
            // Assertions, after the evidence.
            expects(same(summary.share.mpsEnv, sharedEnv), `The share probe saw another MPS environment than the saved share: ${JSON.stringify(summary.share.mpsEnv)}`);
            expects(summary.tighterSm.mpsEnv.CUDA_MPS_ACTIVE_THREAD_PERCENTAGE === String(TIGHTER_CLIENT.smPercent)
                && summary.tighterMemory.mpsEnv.CUDA_MPS_PINNED_DEVICE_MEM_LIMIT === `0=${TIGHTER_CLIENT.memoryMiB}M`, 'A tighter probe did not see its overridden value');
            expects(Object.values(summary.bypass.mpsEnv).every(value => value === null), `The bypass probe still had MPS environment: ${JSON.stringify(summary.bypass.mpsEnv)}`);
            const low = Math.max(128, capMiB - 640);
            expects(summary.share.termination === 'allocation_oom' && summary.share.allocatedMiB <= capMiB && summary.share.allocatedMiB >= low,
                `The share did not cap allocations inside the calibrated range ${low}..${capMiB} MiB (${summary.share.termination}, ${summary.share.allocatedMiB} MiB)`);
            expects(summary.share.smCount > 0 && summary.share.smCount < fullSm && summary.share.smCount <= Math.ceil(fullSm * GPU_SHARES.first.smPercent / 100) && summary.share.smCount >= Math.floor(fullSm * GPU_SHARES.first.smPercent / 200),
                `The ${GPU_SHARES.first.smPercent}% share gives ${summary.share.smCount} of ${fullSm} SMs, outside the expected rounding of the share`);
            expects(summary.tighterSm.smCount > 0 && summary.tighterSm.smCount <= summary.share.smCount, `A tighter SM value gave ${summary.tighterSm.smCount} SMs, more than the share's ${summary.share.smCount}`);
            expects(summary.tighterMemory.termination === 'allocation_oom' && summary.tighterMemory.allocatedMiB <= TIGHTER_CLIENT.memoryMiB && summary.tighterMemory.allocatedMiB <= summary.share.allocatedMiB,
                `A tighter memory value allocated ${summary.tighterMemory.allocatedMiB} MiB, more than allowed`);
            // The bypass must allocate above the cap (at or below it proves nothing) and see
            // EVERY SM of the device, as pinned: a bypass that is itself restricted proves
            // nothing about the unrestricted device.
            expects(summary.bypass.termination === 'bound' && summary.bypass.allocatedMiB > capMiB && summary.bypass.allocatedMiB === summary.bypass.boundMiB,
                `The bypass did not allocate above the ${capMiB}-MiB cap (${summary.bypass.termination}, ${summary.bypass.allocatedMiB} of ${summary.bypass.boundMiB} MiB)`);
            expects(summary.bypass.smCount === fullSm, `The bypass SM count ${summary.bypass.smCount} differs from the pinned full-device count ${fullSm}, so the bypass is not proven unrestricted`);
            expects(fullSm > summary.share.smCount, `The bypass did not get more SMs than the share (${fullSm} vs ${summary.share.smCount})`);
            await assertCpuUntouched(evidence, 'P2');
        });
    }

    // =====================================================================
    // LIVE-P3 helpers: the timeline of an Apply, observed from the host.
    function startTimeline(daemon, clients) {
        const samples = []; let stopped = false;
        const leaves = clients.map(client => ({ role: client.role, id: client.id, leaf: agentLeaf(host, prepared.prefix, client.id) }));
        needs(leaves.every(entry => entry.leaf !== null), 'An old client cgroup leaf cannot be proved, so the drain order cannot be observed');
        const once = () => {
            const observed = daemon ? host.observe(daemon.host.hostPid) : null;
            return { t: Date.now(), daemonAlive: Boolean(observed && observed.startIdentity === daemon.host.startIdentity),
                clients: leaves.map(entry => (entry.leaf ? (host.cgroupProcs(entry.leaf) || []).length : 0)) };
        };
        const loop = (async () => { while (!stopped) { samples.push(once()); await sleep(timings.sampleMs); } samples.push(once()); })();
        return { async stop() { stopped = true; await loop; return samples; }, leaves };
    }
    // Drained before quit: no sample may show the old daemon gone while an old
    // client still ran; the daemon must be seen gone; whether a sample caught the
    // window between the last client leaving and the quit is recorded too.
    function evaluateDrain(samples, { quit }) {
        const violation = samples.find(sample => !sample.daemonAlive && sample.clients.some(count => count > 0));
        const daemonGone = samples.some(sample => !sample.daemonAlive);
        const windowSeen = samples.some(sample => sample.daemonAlive && sample.clients.every(count => count === 0));
        return { samples: samples.length, violation: violation || null, daemonGone, drainWindowObserved: windowSeen, ok: !violation && (!quit || daemonGone) };
    }

    // =====================================================================
    // LIVE-P3: default change drains the cohort before quit; final clear
    // through Apply; host clear then an ordinary restart; a crash that kills
    // only the owned daemon. CPU agents are never restarted.
    async function liveP3() {
        return runCase('LIVE-P3', async evidence => {
            await prepare();
            const { gate } = prepared;
            const total = gpu.memoryMiB;
            const first = GPU_SHARES.first; const raised = GPU_SHARES.raised;
            // The default is the share rounded up to a whole GiB (A6); the raised share must still change it (2 GiB to 3 GiB on 6 GiB).
            const firstDefaultMiB = serverDefaultMiB(first.vramPercent, total); const raisedDefaultMiB = serverDefaultMiB(raised.vramPercent, total);
            evidence.put('expectedDefaults', { first: firstDefaultMiB, raised: raisedDefaultMiB });
            expects(firstDefaultMiB !== raisedDefaultMiB, `The raised share does not change the server default (${firstDefaultMiB} MiB for both), so the default-change case cannot run`);
            await gate.check('P3-start');
            // A. Two share clients at the first default. The second share is an
            //    own-share change under the same default: only the peer is recreated.
            const base = await settleShares('p3-probe', { probe: first }, evidence);
            needs(base.state.gpu.daemonStatus === 'ready', 'The MPS daemon is not ready');
            expects(base.state.gpu.serverDefault?.vramMiB === firstDefaultMiB, `The first default is ${base.state.gpu.serverDefault?.vramMiB} MiB, not ${firstDefaultMiB}`);
            const probeBefore = await agentNow('probe');
            const identityA = await daemonIdentity(); needs(identityA.daemon, 'No owned MPS daemon is observable');
            gate.registerDaemon(identityA.daemon.host.hostPid);
            await applyShares('p3-peer', { [GPU_AGENT_REFS.peer]: first }, [GPU_AGENT_REFS.peer], evidence);
            const probeAfter = await agentNow('probe'); const peer = await agentNow('peer');
            const identityB = await daemonIdentity();
            evidence.put('ownShareChange', { probeSame: probeBefore.id === probeAfter.id, daemonSame: identityA.daemon.generation === identityB.daemon?.generation, peer: hexTail(peer.id) });
            expects(probeBefore.id === probeAfter.id && identityA.daemon.generation === identityB.daemon?.generation, 'An own-share change under the same default recreated the probe or the daemon');
            registerOwned(probeAfter); registerOwned(peer);
            await assertCpuUntouched(evidence, 'P3-A');

            // B. Change the server default: the whole cohort drains before the daemon quits.
            const cohort = [probeAfter, peer];
            const oldGeneration = identityB.daemon.generation; const oldDaemon = identityB.daemon;
            const timeline = startTimeline(oldDaemon, cohort);
            let changed;
            try { changed = await applyShares('p3-default', { [GPU_AGENT_REFS.probe]: raised }, [GPU_AGENT_REFS.probe], evidence); }
            finally { evidence.put('defaultChangeTimeline', evaluateDrain(await timeline.stop(), { quit: true })); }
            const drain = evidence.data.defaultChangeTimeline;
            expects(drain.ok, `The old daemon was gone while an old client still ran, or was never seen gone: ${JSON.stringify(drain.violation)}`);
            const identityC = await daemonIdentity(); needs(identityC.daemon, 'No daemon after the default change');
            gate.registerDaemon(identityC.daemon.host.hostPid);
            const probeNew = await agentNow('probe'); const peerNew = await agentNow('peer');
            registerOwned(probeNew); registerOwned(peerNew);
            evidence.put('defaultChange', {
                old: { generation: oldGeneration, pid: oldDaemon.host.hostPid, start: oldDaemon.host.startIdentity, probe: hexTail(probeAfter.id), peer: hexTail(peer.id) },
                new: { generation: identityC.daemon.generation, pid: identityC.daemon.host.hostPid, start: identityC.daemon.host.startIdentity, probe: hexTail(probeNew.id), peer: hexTail(peerNew.id), serverDefault: changed.state.gpu.serverDefault },
            });
            const oldAlive = host.observe(oldDaemon.host.hostPid);
            expects(!(oldAlive && oldAlive.startIdentity === oldDaemon.host.startIdentity), 'The old daemon is still running after the default change');
            expects(identityC.daemon.generation !== oldGeneration && identityC.daemon.host.hostPid !== oldDaemon.host.hostPid, 'The default change did not start a new daemon generation');
            expects(probeNew.id !== probeAfter.id && peerNew.id !== peer.id, 'The cohort was not recreated after the default change');
            expects(changed.state.gpu.serverDefault?.smPercent === raised.smPercent && changed.state.gpu.serverDefault?.vramMiB === raisedDefaultMiB, `The new server default is not the maximum configured share rounded up to a whole GiB (${raisedDefaultMiB} MiB)`);
            assertClientShare(probeNew, raised, changed.state, identityC.daemon, { totalMiB: total, label: 'probe after the default change' });
            assertClientShare(peerNew, first, changed.state, identityC.daemon, { totalMiB: total, label: 'peer after the default change' });
            await assertCpuUntouched(evidence, 'P3-B');

            // C. Clear the final share through Apply: first the peer (the daemon stays), then the last one.
            await applyShares('p3-clear-peer', { [GPU_AGENT_REFS.peer]: null }, [GPU_AGENT_REFS.peer], evidence);
            const peerPlain = await agentNow('peer');
            assertUnshared(peerPlain, 'peer after its clear');
            const identityD = await daemonIdentity();
            expects(identityD.daemon?.generation === identityC.daemon.generation, 'Clearing a non-final share replaced the daemon');
            const probeD = await agentNow('probe'); registerOwned(probeD);
            const clearTimeline = startTimeline(identityD.daemon, [probeD]);
            let cleared;
            try { cleared = await applyShares('p3-clear-final', { [GPU_AGENT_REFS.probe]: null }, [GPU_AGENT_REFS.probe], evidence); }
            finally { evidence.put('finalClearTimeline', evaluateDrain(await clearTimeline.stop(), { quit: true })); }
            expects(evidence.data.finalClearTimeline.ok, `Final clear: the daemon quit before its client drained, or never quit: ${JSON.stringify(evidence.data.finalClearTimeline.violation)}`);
            await expectDaemonAbsent(identityD.daemon, cleared.state, 'final clear through Apply', evidence);
            assertUnshared(await agentNow('probe'), 'probe after the final clear');
            await assertCpuUntouched(evidence, 'P3-C');

            // D. Host clear followed by an ordinary restart of the agent.
            const reshared = await settleShares('p3-reshare', { probe: first }, evidence);
            needs(reshared.state.gpu.daemonStatus === 'ready', 'The daemon is not ready after sharing again');
            const identityE = await daemonIdentity(); needs(identityE.daemon, 'No owned MPS daemon is observable');
            gate.registerDaemon(identityE.daemon.host.hostPid);
            const probeE = await agentNow('probe'); registerOwned(probeE);
            await gate.check('P3-host-clear');
            try { await causedCommand('gpu-host-clear', profile.node.path, [profile.candidate.path, 'limits', 'clear', '--agent', GPU_AGENT_REFS.probe], { deadlineMs: 120000, capture: `gpu-host-clear-${++captureCounter}` }); }
            finally { recordHostState(); }
            const storeAfterClear = await admin.state();
            evidence.step('host-clear', { configured: agentEntry(storeAfterClear, GPU_AGENT_REFS.probe)?.configured, daemon: storeAfterClear.gpu.daemonStatus });
            expects(!agentEntry(storeAfterClear, GPU_AGENT_REFS.probe)?.configured?.gpu, 'The host clear left a stored GPU share');
            // `--port` and `--udp-port` are valid only before start, diagnose or repair (ploinky-box/command/parse.mjs). The restart finds the
            // fixture's own Box from its working directory: the command runs in the fixture workspace (liveHarness.mjs `command`), whose
            // `.ploinky` marker resolveWorkspaceIdentity (ploinky-box/identity.mjs) walks up to; the Box and its ports are the saved ones.
            await gate.check('P3-restart');
            const restartTimeline = startTimeline(identityE.daemon, [probeE]);
            let restartResult = null;
            try {
                restartResult = await causedCommand('gpu-restart', profile.node.path, [profile.candidate.path, 'restart', GPU_AGENT_REFS.probe], { deadlineMs: timings.applyMs, capture: `gpu-restart-${++captureCounter}` });
                // Only a restart that completed successfully supports the drain inference.
                evidence.put('restartDrainAcknowledgement', { command: 'restart', acknowledged: true, ...DRAIN_ACKNOWLEDGEMENT_BASIS });
            } catch (error) {
                // A restart that failed, timed out or never ran proves nothing about a drain: its real outcome is the record.
                restartResult = restartResult ?? error.result ?? null;
                evidence.put('restartDrainAcknowledgement', { command: 'restart', acknowledged: false, outcome: {
                    status: Number.isInteger(restartResult?.status) ? restartResult.status : null, signal: restartResult?.signal ?? null, timedOut: Boolean(restartResult?.timedOut),
                    transportError: restartResult?.errorCode ?? (restartResult ? null : String(error?.message || error).slice(0, 200)), stderr: boundedTail(restartResult?.stderr ?? '', 300).text,
                } });
                throw error;
            }
            finally { recordHostState(); evidence.put('restartTimeline', evaluateDrain(await restartTimeline.stop(), { quit: true })); }
            expects(evidence.data.restartTimeline.ok, `Host clear and restart: the daemon quit before its client drained, or never quit: ${JSON.stringify(evidence.data.restartTimeline.violation)}`);
            const stateAfterRestart = await admin.state();
            await expectDaemonAbsent(identityE.daemon, stateAfterRestart, 'host clear and ordinary restart', evidence);
            assertUnshared(await agentNow('probe'), 'probe after the host clear and restart');
            await inspectBox();
            await assertCpuUntouched(evidence, 'P3-D');

            // E. Crash: kill ONLY the owned daemon, then recover through Apply.
            const two = await settleShares('p3-crash-setup', { probe: first, peer: first }, evidence);
            needs(two.state.gpu.daemonStatus === 'ready', 'The daemon is not ready for the crash case');
            const identityF = await daemonIdentity(); needs(identityF.daemon, 'No owned MPS daemon is observable');
            gate.registerDaemon(identityF.daemon.host.hostPid);
            const cohortF = [await agentNow('probe'), await agentNow('peer')];
            cohortF.forEach(registerOwned);
            await gate.check('P3-before-kill');
            await killOwnedDaemon(evidence, identityF.daemon);
            const afterKill = await waitDaemonGone(identityF.daemon);
            evidence.put('crash', { killed: { pid: identityF.daemon.host.hostPid, start: identityF.daemon.host.startIdentity }, goneAfterMs: afterKill });
            expects(afterKill !== null, 'The killed daemon is still running');
            await assertCpuUntouched(evidence, 'P3-crash');
            const recovered = await applyShares('p3-recover', {}, [GPU_AGENT_REFS.probe], evidence);
            const identityG = await daemonIdentity();
            needs(identityG.daemon, 'No daemon after crash recovery');
            gate.registerDaemon(identityG.daemon.host.hostPid);
            const probeG = await agentNow('probe'); const peerG = await agentNow('peer');
            evidence.put('recovery', { generation: identityG.daemon.generation, old: identityF.daemon.generation, probe: hexTail(probeG.id), peer: hexTail(peerG.id), state: recovered.state.gpu.daemonStatus });
            expects(identityG.daemon.generation !== identityF.daemon.generation && identityG.daemon.host.hostPid !== identityF.daemon.host.hostPid, 'Recovery did not rebuild the daemon generation');
            expects(recovered.state.gpu.daemonStatus === 'ready' && probeG.id !== cohortF[0].id && peerG.id !== cohortF[1].id, 'The cohort was not recreated after the crash');
            assertClientShare(probeG, first, recovered.state, identityG.daemon, { totalMiB: total, label: 'probe after recovery' });
            assertClientShare(peerG, first, recovered.state, identityG.daemon, { totalMiB: total, label: 'peer after recovery' });
            await assertCpuUntouched(evidence, 'P3-recovery');
        });
    }

    async function expectDaemonAbsent(oldDaemon, state, label, evidence) {
        const identity = await daemonIdentity();
        const old = host.observe(oldDaemon.host.hostPid);
        evidence.put(`daemonAbsent:${label}`, { daemonStatus: state.gpu.daemonStatus, observedDaemon: Boolean(identity.daemon), oldAlive: Boolean(old && old.startIdentity === oldDaemon.host.startIdentity) });
        expects(!identity.daemon && !(old && old.startIdentity === oldDaemon.host.startIdentity) && state.gpu.daemonStatus === 'stopped', `The MPS daemon is still present after ${label}`);
    }
    // The crash: both layers re-prove the daemon's identity, then only the
    // exact process is killed. A foreign or unproven process is never signalled.
    async function killOwnedDaemon(evidence, daemon) {
        const fresh = host.observe(daemon.host.hostPid);
        needs(fresh && fresh.startIdentity === daemon.host.startIdentity && fresh.bootId === daemon.host.bootId && fresh.cgroup === `${prepared.prefix}/ploinky/core` && fresh.nspid.length === 2 && fresh.nspid[1] === daemon.box.pid
            && Object.values(fresh.uid).every(value => value === host.uid()), 'The daemon is not provably the owned process; nothing was signalled');
        // The servers it spawned are registered by tuple first, so their exit is not mistaken for a foreign process.
        for (const server of (host.cgroupProcs(`${prepared.prefix}/ploinky/core`) || []).map(pid => host.observe(pid)).filter(value => value && value.ppid === daemon.host.hostPid)) prepared.gate.registerServer(server.hostPid);
        const result = await causedCommand('gpu-kill-owned-daemon', profile.engine.path, [...core, 'node', '-e', MPS_KILL_OWNED_DAEMON, String(daemon.box.pid), String(daemon.box.startTime)], { deadlineMs: timings.controlMs, capture: `gpu-kill-${++captureCounter}` });
        let reply = null; try { reply = JSON.parse(result.stdout); } catch { reply = null; }
        evidence.step('kill-owned-daemon', reply);
        needs(reply?.killed === true, `The Box refused to kill the daemon (${String(reply?.refused || 'no reply').slice(0, 120)}); nothing was signalled`);
    }
    async function waitDaemonGone(daemon) {
        const started = Date.now();
        while (Date.now() - started < 15000) {
            const now = host.observe(daemon.host.hostPid);
            if (!now || now.startIdentity !== daemon.host.startIdentity) return Date.now() - started;
            await sleep(100);
        }
        return null;
    }

    // =====================================================================
    // LIVE-P4: a same-UID control command, and read-only versus writable pipes.
    async function liveP4() {
        return runCase('LIVE-P4', async evidence => {
            await prepare();
            const { gate } = prepared;
            const share = GPU_SHARES.first;
            await gate.check('P4-start');
            await settleShares('p4', { probe: share }, evidence);
            const identity = await daemonIdentity(); needs(identity.daemon, 'No owned MPS daemon is observable');
            gate.registerDaemon(identity.daemon.host.hostPid);
            const probe = await agentNow('probe'); registerOwned(probe);
            const pipe = identity.daemon.pipeDirectory;
            const capMiB = shareMemoryMiB(share.vramPercent, gpu.memoryMiB);
            let rw = null; let ro = null;
            let holder = null;
            const holderAbort = new AbortController();
            let failure = null;
            try {
              try {
                // A holder keeps one client connected so the daemon has a server to name.
                await gate.check('P4-holder');
                holder = gate.monitor(abort => command('gpu-holder', profile.engine.path, [...nested, 'container', 'exec', probe.id, 'python3', '-c', HOLDER_PROGRAM],
                    { deadlineMs: timings.holderMs, tolerate: true, abort: AbortSignal.any([abort, holderAbort.signal]), capture: `gpu-holder-${++captureCounter}` }));
                holder.catch(() => {});
                const server = await waitForServer(evidence, identity.daemon);
                gate.registerServer(server.hostPid);
                rw = await createHelper(evidence, { writable: true, pipe });
                ro = await createHelper(evidence, { writable: false, pipe });
                evidence.put('helperMounts', { rw: rw.mount, ro: ro.mount });
                expects(rw.mount?.RW === true && ro.mount?.RW === false, 'The inspected helper pipe mounts do not match the requested writable and read-only binds');
                const ask = async (helper, command_, step) => {
                    await gate.check(`P4-control:${step}`);
                    const result = await command(`gpu-control-${step}`, profile.engine.path, [...nested, ...controlHelperExecArgv({ containerId: helper.id, command: assertMpsControlCommand(command_) })], { deadlineMs: timings.controlMs, tolerate: true, capture: `gpu-control-${step}-${++captureCounter}` });
                    const outcome = { command: command_, status: result.status, signal: result.signal, timedOut: result.timedOut, stdout: boundedTail(result.stdout, 1024).text, stderr: boundedTail(result.stderr, 512).text };
                    evidence.step(`control:${step}`, outcome);
                    return outcome;
                };
                const list = await ask(rw, 'get_server_list', 'rw-list');
                const servers = list.stdout.split('\n').map(value => value.trim()).filter(Boolean);
                needs(list.status === 0 && servers.length > 0 && servers.every(value => /^[1-9][0-9]*$/.test(value)) && servers.includes(String(server.boxPid)), 'The writable-pipe helper cannot read the owned daemon\'s server list');
                const reads = [await ask(rw, 'get_default_active_thread_percentage', 'rw-sm'), await ask(rw, 'get_default_device_pinned_mem_limit 0', 'rw-memory')];
                // The plan's order (§18.10): the SM setter, then a new client with percentage 100
                // and its SM probe, and only then the independent memory setter. A memory
                // setter that is accepted may affect later contexts, so it never precedes the
                // SM observation.
                const failureWords = /error|invalid|fail|denied|not permitted|unknown/i;
                const accepted = outcome => outcome.status === 0 && !outcome.timedOut && !failureWords.test(`${outcome.stdout}\n${outcome.stderr}`);
                const widen = await ask(rw, `set_active_thread_percentage ${server.boxPid} 100`, 'rw-widen-sm');
                // A new client sets 100 itself (leaving 25 would mask a widened server).
                const widened = await runProbe(evidence, 'after-sm-mutation', { maxMiB: probeBoundMiB(capMiB), set: { CUDA_MPS_ACTIVE_THREAD_PERCENTAGE: '100' } });
                evidence.put('afterMutation', { smCount: widened.report.smCount, allocatedMiB: widened.report.allocatedMiB, termination: widened.report.termination });
                const limit = await ask(rw, `set_device_pinned_mem_limit ${server.boxPid} 0 64M`, 'rw-set-memory');
                // The memory setter's effect is observational only: one more context is tried
                // and what happens is recorded, never asserted. A denied setter is not reported as
                // isolation, and a failed context after an accepted one is its recorded effect.
                let memoryEffect = { observed: false, reason: accepted(limit) ? null : 'the setter was denied or did not answer, so there is no effect to observe' };
                if (accepted(limit)) {
                    try {
                        const probed = await runProbe(evidence, 'after-memory-mutation', { maxMiB: 384 });
                        memoryEffect = { observed: true, contextCreated: true, allocatedMiB: probed.report.allocatedMiB, termination: probed.report.termination };
                    } catch (error) {
                        // A gate trip or a missing prerequisite is never an observation.
                        if (error.gate || error.code === 'LIVE_PREREQUISITE_MISSING') throw error;
                        memoryEffect = { observed: true, contextCreated: false, error: String(error.message).slice(0, 300) };
                    }
                }
                // The read-only pipe: the connection result is recorded, not presumed.
                const roList = await ask(ro, 'get_server_list', 'ro-list');
                const roServers = roList.stdout.split('\n').map(value => value.trim()).filter(Boolean);
                const roConnected = roList.status === 0 && roServers.includes(String(server.boxPid));
                evidence.put('controlMutation', { widenSm: { accepted: accepted(widen), reply: widen }, setMemory: { accepted: accepted(limit), reply: limit, effect: memoryEffect }, readsAccepted: reads.map(accepted),
                    limitation: 'Share clients use the same Box user as the MPS daemon and can widen settings; MPS shares are best-effort, not a security boundary.' });
                evidence.put('pipeComparison', { writable: { mount: rw.mount, connected: true }, readOnly: { mount: ro.mount, connected: roConnected, reply: roList } });
                expects(widened.report.smCount > 0, 'The new client reported no SMs after the mutation');
              } finally {
                // Stop the owned holder and helpers by exact identity first.
                await removeHelpers(evidence);
                holderAbort.abort();
                if (holder) { try { await holder; } catch (error) { evidence.step('holder-ended', String(error?.message || error).slice(0, 200)); } }
              }
            } catch (error) { failure = error; throw error; } finally {
                // The owned test daemon is ALWAYS reconciled, whatever the case concluded: its
                // defaults are restored through the product's drain-quit-start path before any
                // other measurement. After a tripped gate no new work starts; cleanup stops the
                // owned clients. A reconcile failure never hides the case's own failure.
                if (gate.tripped) evidence.step('reconcile-skipped', 'the gate tripped; cleanup stops the owned clients');
                else {
                    try { await reconcileDefaults(evidence, share, identity.daemon); }
                    catch (error) { if (!failure) throw error; evidence.step('reconcile-failed', String(error?.message || error).slice(0, 300)); }
                }
            }
            await assertCpuUntouched(evidence, 'P4');
        });
    }
    async function waitForServer(evidence, daemon) {
        const deadline = Date.now() + timings.serverWaitMs;
        while (Date.now() < deadline) {
            const obs = await observeMps();
            const list = (obs.control || []).find(reply => reply.command === 'get_server_list');
            const pids = String(list?.stdout || '').split('\n').map(value => value.trim()).filter(Boolean);
            if (pids.length === 1 && /^[1-9][0-9]*$/.test(pids[0])) {
                const boxPid = Number(pids[0]);
                const hostSide = boxProcessOnHost(boxPid, undefined, `${prepared.prefix}/ploinky/core`);
                needs(hostSide.ppid === daemon.host.hostPid, 'The MPS server is not a child of the owned daemon');
                evidence.step('server', { boxPid, hostPid: hostSide.hostPid });
                return { boxPid, hostPid: hostSide.hostPid };
            }
            await sleep(500);
        }
        throw blocked('No MPS server appeared for the holder client, so the control commands have no server to name');
    }
    async function createHelper(evidence, { writable, pipe }) {
        needs(image, 'The pinned fixture image is not recorded');
        const name = `hwl-${run.runId.slice(0, 12)}-ctl-${writable ? 'rw' : 'ro'}`;
        const result = await command(`gpu-helper-create-${writable ? 'rw' : 'ro'}`, profile.engine.path, [...nested, ...controlHelperRunArgv({ name, image, pipeDirectory: pipe, writable, runId: run.runId, user: prepared.agents.probe.user })],
            { deadlineMs: 60000, tolerate: true, capture: `gpu-helper-${writable ? 'rw' : 'ro'}-${++captureCounter}` });
        const id = result.stdout.trim();
        if (!/^[a-f0-9]{64}$/.test(id)) throw blocked(`The control helper container could not be created (exit ${result.status}): ${boundedTail(result.stderr, 400).text}`);
        helpers.push({ id, name });
        const inspected = await inspectNested(id);
        const mount = (inspected.mounts || []).find(entry => entry.Destination === MPS_CLIENT_PIPE);
        evidence.step(`helper:${writable ? 'rw' : 'ro'}`, { id: hexTail(id), mount: mount ? { Source: mount.Source, RW: mount.RW } : null });
        needs(inspected.running === true, 'The control helper is not running');
        return { id, name, mount: mount ? { Source: mount.Source, Destination: mount.Destination, RW: mount.RW } : null };
    }
    async function removeHelpers(evidence) {
        while (helpers.length) {
            const helper = helpers.pop();
            try {
                const inspected = await inspectNested(helper.id);
                if (inspected.labels?.['io.assistos.ploinky.hwl-run'] !== run.runId || String(inspected.name).replace(/^\//, '') !== helper.name) { evidence.step('helper-not-owned', hexTail(helper.id)); continue; }
                await command('gpu-helper-remove', profile.engine.path, [...nested, 'container', 'rm', '--force', helper.id], { deadlineMs: 60000, tolerate: true, cleanup: cleanupMode });
                evidence.step('helper-removed', hexTail(helper.id));
            } catch (error) { evidence.step('helper-remove-failed', String(error?.message || error).slice(0, 200)); }
        }
    }
    // Reconcile the daemon's defaults: a full cycle through the product's own
    // drain-quit-start path, then a measurement that shows no widened server.
    async function reconcileDefaults(evidence, share, oldDaemon) {
        const { gate } = prepared;
        await gate.check('P4-reconcile');
        // Every share the cases left configured is cleared (a peer's share would
        // keep the daemon alive), then both clients are replaced unshared.
        const current = await admin.state();
        const configured = [GPU_AGENT_REFS.probe, GPU_AGENT_REFS.peer].filter(ref => agentEntry(current, ref)?.configured?.gpu);
        await applyShares('p4-reconcile-clear', Object.fromEntries(configured.map(ref => [ref, null])), [GPU_AGENT_REFS.probe, GPU_AGENT_REFS.peer], evidence);
        const stopped = await daemonIdentity();
        expects(!stopped.daemon, 'The test daemon was not drained and stopped before reconciling');
        const again = await applyShares('p4-reconcile-share', { [GPU_AGENT_REFS.probe]: share }, [GPU_AGENT_REFS.probe], evidence);
        const fresh = await daemonIdentity(); needs(fresh.daemon, 'No daemon after reconciling');
        gate.registerDaemon(fresh.daemon.host.hostPid);
        const defaultMiB = serverDefaultMiB(share.vramPercent, gpu.memoryMiB);
        const capMiB = shareMemoryMiB(share.vramPercent, gpu.memoryMiB);
        const readbacks = Object.fromEntries((fresh.obs.control || []).map(reply => [reply.command, reply.stdout.trim()]));
        evidence.put('reconciled', { generation: fresh.daemon.generation, previous: oldDaemon.generation, serverDefault: again.state.gpu.serverDefault, readbacks });
        expects(fresh.daemon.generation !== oldDaemon.generation && again.state.gpu.serverDefault?.smPercent === share.smPercent && again.state.gpu.serverDefault?.vramMiB === defaultMiB, `The reconciled daemon does not carry the configured defaults (${defaultMiB} MiB)`);
        const probe = await agentNow('probe'); registerOwned(probe);
        const measured = await runProbe(evidence, 'after-reconcile', { maxMiB: probeBoundMiB(capMiB) });
        evidence.put('afterReconcile', { smCount: measured.report.smCount, allocatedMiB: measured.report.allocatedMiB, termination: measured.report.termination });
        expects(measured.report.termination === 'allocation_oom' && measured.report.allocatedMiB <= capMiB, 'The reconciled share does not cap allocations');
    }

    // ---------------------------------------------------------------------
    // Cleanup hooks. Before the product cleanup: nothing of ours may still
    // use the GPU. After it: the GPU shows none of our processes.
    async function beforeCleanup({ record = () => {} } = {}) {
        cleanupMode = true;
        const notes = [];
        const owned = helpers.length;
        if (owned && prepared) {
            try { await removeHelpers({ step: (name, value) => notes.push({ name, value }) }); } catch (error) { notes.push({ name: 'helpers', value: String(error?.message || error).slice(0, 200) }); }
        }
        // How many owned helpers there were and how many were removed by exact identity, for the cleanup journal.
        record({ helpers: owned, removed: notes.filter(note => note.name === 'helper-removed').length });
        return notes;
    }
    // After the product cleanup the GPU is observed again. The proof must SUCCEED: a
    // failed, malformed or timed-out query, a changed device or mode, or an owned
    // process that survived the Box's destruction fails the cleanup (nothing is
    // signalled). Standalone and resumed cleanup runs the very same proof.
    async function afterCleanup() {
        return finalGpuObservation({ gpu, run, host, query: () => smiQuery(new AbortController().signal), artifacts: safeArtifact });
    }

    // `internals` is for the offline tests: the building blocks the cases
    // compose, so a single guard (the owned-daemon kill) can be exercised alone.
    return {
        liveP1, liveP2, liveP3, liveP4, beforeCleanup, afterCleanup,
        internals: {
            prepare, admin, agentNow, pinnedImageIdentity, settleShares, daemonIdentity, killOwnedDaemon, startTimeline, evaluateDrain, evidenceFor,
            // What the local-llm and vLLM cases build on (liveLlmCases.mjs): the same gate, administrator channel,
            // Apply, daemon and ownership proofs, never a second copy of them.
            runCase, applyShares, agentEntry, containerKey, observeMps, registerOwned, assertClientShare, assertUnshared, hostProcessesOf, boxProcessOnHost,
            observe, nestedRows, inspectNested, smiQuery, timings, sleep, fixture, getPrepared: () => prepared, compactEvidence,
        },
    };
}
