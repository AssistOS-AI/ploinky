// A strict, in-memory fake GPU host for the apparatus-mps executor tests. It
// wraps the file-backed fake engine world (fakeLiveEngine.mjs) and adds what
// the GPU cases touch: nvidia-smi's XML, the host's /proc and cgroup tree for
// Box processes, the Box's hardware-limits administrator route, the MPS
// control daemon and its server, share clients with their environment, labels
// and pipe bind, the CUDA probe, the in-Box programs, the control helpers and
// the candidate's `gpu grant`, `limits clear` and `restart`. No GPU, MPS tool,
// engine or SSH host is touched.
//
// Strictness: a nested or in-Box command it does not model is a failed
// command (exit 125), never a quiet success; MPS replies use the exact
// grammar the production parser accepts, and a fault can replace any of them
// with an unsupported form to prove such output is BLOCKED, not PASS.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BOX_LABELS } from '../../ploinky-box/constants.mjs';
import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import { createFakeWorld, evaluateTemplate, ok, worldState } from './fakeLiveEngine.mjs';
import { fixtureContainerName } from './liveFixture.mjs';
import { mpsServerDefaultMemoryMiB } from '../../cli/sandbox/hardwareLimits/mps.mjs';
import { candidateArgvProblem } from './candidateArgv.mjs';
import {
    ADMIN_REQUEST, GPU_AGENT_INSPECT, GPU_GRANT_FACTS, MPS_FAILURE_EVIDENCE, MPS_KILL_OWNED_DAEMON, MPS_OBSERVE, NESTED_NAME_LIST_FORMAT, shareMemoryMiB,
} from './liveGpuCommands.mjs';

const hex = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const uuid = seed => { const h = hex(seed); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`; };
const failed = (stderr, status = 125) => ok('', { status, stderr });
const sortDeep = value => (Array.isArray(value) ? value.map(sortDeep) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(name => [name, sortDeep(value[name])])) : value);
const BOOT_ID = '11111111-2222-4333-8444-555555555555';
const BOX_INIT_PID = 4000;
const CLIENT_PIPE = '/run/ploinky-mps-pipe';
const OVERHEAD_MIB = 148;

// The owned agents of the apparatus-mps fixture; the local-llm fixture passes its own (fakeLiveLlm.mjs).
const P_WORLD = Object.freeze({ repository: 'hwlfixture', roles: Object.freeze(['probe', 'peer', 'cpu']), names: Object.freeze({}), clients: Object.freeze(['probe', 'peer']) });

export function createGpuWorld({ statePath, node, engine, host, gpu, faults = {}, unrelated = [], hostUid = 1000, fixture = P_WORLD, envelope = null, hooks = {} }) {
    const base = createFakeWorld({ statePath, node, engine, host, unrelated, faults: faults.base || {} });
    const nameOf = role => fixture.names?.[role] ?? role;
    const refOf = role => `${fixture.repository}/${nameOf(role)}`;
    const roleOfName = name => fixture.roles.find(role => nameOf(role) === name) ?? name;
    const model = {
        clock: 100, nextHost: 5000, nextBox: 100, agentCounter: 0, imageIds: {}, drainExits: {}, procs: new Map(), dirs: new Set(), agents: new Map(), helpers: new Map(),
        boxId: null, workspace: null, instance: null, prefix: null,
        store: { epoch: hex('epoch').slice(0, 32), revision: 1, policies: {} },
        daemon: null, mpsStatus: 'inactive', events: [], signals: [], calls: [], programs: [], foreign: [], bypassProcs: [],
        controlLog: [], grantCalls: [], widened: false, smiQueries: 0, applyCalls: [], observeCalls: 0, probes: [],
        // Rows nvidia-smi lists without adding to the device's used memory (a runner the driver lists by PID), the memory the
        // MPS server row states (when the driver lists only the server), and the utilisation it prints.
        extraRows: [], serverMiB: undefined, gpuUtil: 0,
    };
    const tick = () => new Promise(resolve => setTimeout(resolve, faults.tickMs ?? 1));
    const event = name => { model.events.push(name); };

    // --- Processes and cgroups (what the host's /proc shows) ---------------
    function spawn({ cgroup, ppid = 1, ns = [], uid = hostUid }) {
        const hostPid = model.nextHost++;
        const proc = { hostPid, start: String(++model.clock), ppid, cgroup, nspid: [hostPid, ...ns], uid };
        model.procs.set(hostPid, proc);
        return proc;
    }
    const stop = proc => { if (proc) model.procs.delete(proc.hostPid); };
    const corePath = () => `${model.prefix}/ploinky/core`;
    const leafOf = agent => `${model.prefix}/ploinky/agents/libpod-${agent.id}`;
    const hostProc = {
        bootId: () => BOOT_ID,
        uid: () => hostUid,
        observe(pid) {
            const proc = model.procs.get(pid);
            if (!proc) return null;
            return { bootId: BOOT_ID, hostPid: pid, startIdentity: proc.start, ppid: proc.ppid, cgroup: proc.cgroup, nspid: [...proc.nspid], uid: { real: proc.uid, effective: proc.uid, saved: proc.uid, fs: proc.uid } };
        },
        cgroupProcs(cgroupPath) {
            if (!model.dirs.has(cgroupPath)) return null;
            return [...model.procs.values()].filter(proc => proc.cgroup === cgroupPath).map(proc => proc.hostPid);
        },
        cgroupDirectories(cgroupPath) { return [...model.dirs].filter(dir => dir.startsWith(`${cgroupPath}/`)).map(dir => dir.slice(cgroupPath.length + 1).split('/')[0]); },
    };

    // --- Agents (nested containers) -----------------------------------------
    const baseEnv = ['PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/home/node'];
    function createAgent(role, { share = null, recorded = null } = {}) {
        const id = recorded?.id ?? hex(`${role}-${++model.agentCounter}-${model.boxId}`);
        const agent = {
            role, id, name: fixtureContainerName(model.workspace, nameOf(role), fixture.repository), created: recorded?.created ?? `2026-10-02T12:00:${String(model.agentCounter % 60).padStart(2, '0')}Z`,
            // A replacement is created from the same image as the instance the engine's own start created for this role.
            image: recorded?.image ?? model.imageIds[role] ?? hex('agent-image'), imageName: model.image, drainExit: recorded?.drainExit ?? model.drainExits[role] ?? 0, user: faults.imageUser ?? '1000:1000', running: true, startedAt: `2026-10-02T12:01:${String(model.agentCounter % 60).padStart(2, '0')}Z`,
            labels: { 'ploinky.limitshash': hex(`limits-${role}-${JSON.stringify(share)}`) }, env: [...baseEnv], mounts: [], boxPid: model.nextBox++, share,
            // The whole saved policy this instance was created with (a share, CPUs and RAM): an instance is applied while it equals the store's.
            limits: model.store.policies[refOf(role)] ?? null, limitsKey: JSON.stringify(model.store.policies[refOf(role)] ?? null),
        };
        if (share) {
            // The product recreates a share client from the prepared image's immutable ID, and the engine reports the name the
            // container was created with: the ID (faults model another image and a foreign name).
            if (faults.recreatedImageId) agent.image = faults.recreatedImageId;
            agent.imageName = faults.recreatedImageName ?? agent.image;
            const daemon = model.daemon;
            agent.labels['ploinky.mpsgeneration'] = `${daemon.gen}:${daemon.cfg}`;
            agent.env.push(`CUDA_MPS_PIPE_DIRECTORY=${CLIENT_PIPE}`, `CUDA_MPS_ACTIVE_THREAD_PERCENTAGE=${share.smPercent}`, `CUDA_MPS_PINNED_DEVICE_MEM_LIMIT=0=${shareMemoryMiB(share.vramPercent, gpu.memoryMiB)}M`);
            agent.mounts.push({ Type: 'bind', Source: daemon.pipe, Destination: CLIENT_PIPE, RW: true });
            agent.mpsGeneration = agent.labels['ploinky.mpsgeneration'];
            if (faults.extraCudaEnv) agent.env.push('CUDA_VISIBLE_DEVICES=0');
            if (faults.clientHoldsTool) agent.mounts.push({ Type: 'bind', Source: gpu.mpsControl, Destination: '/usr/local/nvidia/bin/nvidia-cuda-mps-control', RW: false });
            if (faults.readOnlyPipe) agent.mounts[0].RW = false;
        }
        if (recorded) { model.imageIds[role] = agent.image; model.drainExits[role] = recorded.drainExit ?? 0; }
        agent.proc = spawn({ cgroup: leafOf(agent), ppid: BOX_INIT_PID, ns: [agent.boxPid, 1] });
        model.dirs.add(leafOf(agent));
        model.agents.set(role, agent);
        event(`create:${role}`);
        return agent;
    }
    function removeAgent(role) {
        const agent = model.agents.get(role);
        if (!agent) return;
        // The targeted drain (cli/sandbox/docker/targetedContainerLifecycle.js assertCleanTermination): the container is stopped with
        // SIGTERM and only exit 0 is the application's acknowledgement. Anything else refuses the removal and the recreate.
        if (agent.drainExit !== 0) throw Object.assign(new Error(`targeted drain for '${agent.name}' did not exit cleanly (exit=${agent.drainExit}); refusing removal or recreate`), { drainFailure: true });
        event(`${agent.share ? 'drain' : 'replace'}:${role}`);
        for (const proc of [...model.procs.values()].filter(value => value.cgroup === leafOf(agent))) stop(proc);
        model.dirs.delete(leafOf(agent));
        model.agents.delete(role);
    }

    // --- The daemon ---------------------------------------------------------
    const desiredShares = () => Object.fromEntries(Object.entries(model.store.policies).filter(([, limits]) => limits.gpu).map(([ref, limits]) => [roleOfName(ref.split('/')[1]), limits.gpu]));
    const policyKey = role => JSON.stringify(model.store.policies[refOf(role)] ?? null);
    const mibOf = share => shareMemoryMiB(share.vramPercent, gpu.memoryMiB);
    function desiredDefault() {
        const shares = Object.values(desiredShares());
        if (!shares.length) return null;
        // As the product: the largest share rounded up to a whole GiB, with the share it came from.
        const share = Math.max(...shares.map(mibOf));
        return { sm: Math.max(...shares.map(value => value.smPercent)), mib: faults.rawServerDefault ? share : mpsServerDefaultMemoryMiB(share), share };
    }
    function startDaemon(defaults) {
        const suffix = hex(`pipe-${++model.clock}`).slice(0, 32);
        const proc = spawn({ cgroup: corePath(), ppid: BOX_INIT_PID, ns: [model.nextBox++] });
        model.daemon = { gen: uuid(`gen-${model.clock}`), cfg: uuid(`cfg-${model.clock}`), proc, hostPid: proc.hostPid, boxPid: proc.nspid[1], start: proc.start, pipe: `/run/ploinky/mps/pipe-${suffix}`, log: `/run/ploinky/mps/log-${suffix}`, defaults, servers: [], lost: false };
        model.mpsStatus = 'ready';
        model.memoryLimited = false;
        event('start');
    }
    function stopDaemon() {
        const daemon = model.daemon;
        if (!daemon) return;
        for (const server of daemon.servers) stop(server.proc);
        stop(daemon.proc);
        event('quit');
        model.daemon = null;
        model.mpsStatus = 'inactive';
    }
    const sameDefault = (left, right) => left && right && left.sm === right.sm && left.mib === right.mib && left.share === right.share;
    async function applyFlow(roles) {
        const want = desiredDefault();
        const current = model.daemon;
        const shared = [...model.agents.values()].filter(agent => agent.share);
        const shares = desiredShares();
        const change = want ? (!current || current.lost || !sameDefault(current.defaults, want)) : Boolean(current);
        if (change) {
            // The product order: drain the whole cohort, quit and verify the old
            // daemon, start the new generation, recreate the eligible clients.
            // `quitBeforeDrain` is the defect the executor must catch.
            if (faults.quitBeforeDrain) {
                await tick(); stopDaemon();
                for (const agent of shared) { await tick(); removeAgent(agent.role); }
            } else {
                for (const agent of shared) { await tick(); removeAgent(agent.role); }
                if (current) { await tick(); stopDaemon(); }
            }
            if (want) { await tick(); startDaemon(want); }
            const recreate = new Set([...shared.map(agent => agent.role), ...roles]);
            for (const role of recreate) {
                if (!fixture.clients.includes(role)) continue;
                await tick(); removeAgent(role);
                await tick(); createAgent(role, { share: shares[role] || null });
            }
        } else {
            for (const role of roles) {
                const agent = model.agents.get(role); const share = shares[role] || null;
                if (agent && JSON.stringify(agent.share) === JSON.stringify(share) && agent.limitsKey === policyKey(role) && (!share || agent.mpsGeneration === `${model.daemon.gen}:${model.daemon.cfg}`)) continue;
                await tick(); removeAgent(role);
                await tick(); createAgent(role, { share });
            }
        }
        if (faults.restartCpu) { removeAgent('cpu'); createAgent('cpu'); }
    }

    // --- GPU ----------------------------------------------------------------
    function smiXml() {
        const rows = [];
        if (model.daemon && !model.daemon.lost) for (const server of model.daemon.servers) rows.push({ pid: server.hostPid, type: 'M+C', name: 'nvidia-cuda-mps-server', ...(model.serverMiB !== undefined ? { mib: model.serverMiB, listOnly: true } : {}) });
        for (const proc of model.bypassProcs) rows.push({ pid: proc.hostPid, type: 'C', name: 'python3' });
        for (const foreign of model.foreign) rows.push({ pid: foreign.pid, type: foreign.type || 'C', name: foreign.name || 'train.py', mib: foreign.mib });
        for (const extra of model.extraRows) if (model.procs.has(extra.pid)) rows.push({ ...extra, listOnly: true });
        // A row that states its memory (a display process) adds exactly that; the others keep the fixed 300 MiB.
        const usedMiB = (faults.smiExtraUsedMiB ?? 0) + 13 + (rows.some(row => row.mib === undefined) ? 300 : 0) + rows.reduce((sum, row) => sum + (row.listOnly ? 0 : (row.mib ?? 0)), 0) + model.probes.filter(probe => probe.active).reduce((sum, probe) => sum + probe.allocatedMiB, 0);
        const section = faults.smiProcessesNA ? 'N/A'
            : rows.map(row => `<process_info><gpu_instance_id>N/A</gpu_instance_id><compute_instance_id>N/A</compute_instance_id><pid>${row.pid}</pid><type>${row.type}</type><process_name>${row.name}</process_name><used_memory>${row.mib ?? 300} MiB</used_memory></process_info>`).join('\n');
        const xml = `<?xml version="1.0" ?>\n<!DOCTYPE nvidia_smi_log SYSTEM "nvsmi_device_v12.dtd">\n<nvidia_smi_log>\n<timestamp>Fri Oct  2 19:30:00 2026</timestamp>\n<driver_version>${gpu.driverVersion}</driver_version>\n<attached_gpus>1</attached_gpus>\n`
            + `<gpu id="00000000:01:00.0">\n<product_name>${gpu.name}</product_name>\n<uuid>${faults.smiOtherUuid ? 'GPU-00000000-0000-4000-8000-000000000000' : gpu.uuid}</uuid>\n<compute_mode>${faults.smiComputeMode || 'Default'}</compute_mode>\n<utilization><gpu_util>${model.gpuUtil} %</gpu_util><memory_util>0 %</memory_util></utilization>\n`
            + `<fb_memory_usage><total>${faults.smiTotalMiB ?? gpu.memoryMiB} MiB</total><reserved>201 MiB</reserved><used>${usedMiB} MiB</used><free>${gpu.memoryMiB - usedMiB} MiB</free></fb_memory_usage>\n`
            + `<processes>${section}</processes>\n</gpu>\n</nvidia_smi_log>\n`;
        return faults.smiTransform ? faults.smiTransform(xml) : xml;
    }
    function smi(args) {
        model.smiQueries += 1;
        if (args.join(' ') !== `-q -x -i ${gpu.uuid}`) return failed('unexpected nvidia-smi invocation', 2);
        if (faults.smiExit && (faults.smiExit.at === undefined || faults.smiExit.at === model.smiQueries)) return failed('NVIDIA-SMI has failed', 9);
        if (faults.smiTimeout) return ok('', { status: null, timedOut: true });
        return ok(smiXml());
    }

    // --- The CUDA probe ----------------------------------------------------
    function probeReport(agent, environment, maxMiB) {
        if (faults.probeBlocked) return { status: 3, report: { ok: false, status: 'blocked', step: 'cuCtxGetExecAffinity', error: 'driver symbol unavailable' } };
        if (faults.probeLibcuda) return { status: 2, report: { ok: false, status: 'failed', step: 'python', error: 'OSError: /usr/local/nvidia/lib64/libcuda.so.1: cannot open shared object file' } };
        if (faults.probeInit) return { status: 2, report: { ok: false, status: 'failed', step: 'cuInit', error: 'CUDA_ERROR_NO_DEVICE' } };
        const daemon = model.daemon;
        const mpsOn = Boolean(environment.CUDA_MPS_PIPE_DIRECTORY) && daemon && !daemon.lost && agent.mounts.some(mount => mount.Destination === CLIENT_PIPE);
        if (mpsOn && model.memoryLimited) return { status: 2, report: { ok: false, status: 'failed', step: 'cuCtxCreate', error: 'CUDA_ERROR_OUT_OF_MEMORY' } };
        let smCount = gpu.smCount; let allocated = maxMiB; let termination = 'bound';
        const capped = mpsOn || faults.bypassCapped;
        if (capped) {
            const percent = Number(environment.CUDA_MPS_ACTIVE_THREAD_PERCENTAGE || daemon?.defaults.sm || 100);
            const widenedPercent = model.widened && percent === 100 ? 100 : percent;
            smCount = mpsOn ? Math.max(2, Math.floor(gpu.smCount * widenedPercent / 100 / 2) * 2) : gpu.smCount;
            const requested = Number((/^0=([0-9]+)M$/.exec(environment.CUDA_MPS_PINNED_DEVICE_MEM_LIMIT || '') || [])[1] || daemon?.defaults.mib || maxMiB);
            // `truncateClientCap`: a driver that applies a client value of at least 1 GiB truncated to whole GiB (unknown until P2 measures it).
            const truncated = faults.truncateClientCap && requested >= 1024 ? Math.floor(requested / 1024) * 1024 : requested;
            // `bypassCapped` models a client that is held to its exact share without MPS (so the P2 bypass check can fail).
            const cap = faults.bypassCapped && !mpsOn ? (daemon?.defaults.share ?? truncated) : truncated;
            allocated = Math.max(0, Math.floor(Math.max(0, cap - OVERHEAD_MIB) / 128) * 128);
            if (allocated >= maxMiB || (faults.noCap && mpsOn)) { allocated = maxMiB; termination = 'bound'; } else termination = 'allocation_oom';
        }
        return {
            status: 0, mpsOn,
            report: {
                ok: true, status: 'complete', termination, driverApiVersion: 13010, containerPid: 4242, containerUid: 1000, smCount, allocatedMiB: allocated, boundMiB: maxMiB,
                memGetInfo: { freeBytes: (gpu.memoryMiB - 300) * 1048576, totalBytes: gpu.memoryMiB * 1048576 },
                mpsEnv: { CUDA_MPS_ACTIVE_THREAD_PERCENTAGE: environment.CUDA_MPS_ACTIVE_THREAD_PERCENTAGE ?? null, CUDA_MPS_PINNED_DEVICE_MEM_LIMIT: environment.CUDA_MPS_PINNED_DEVICE_MEM_LIMIT ?? null, CUDA_MPS_PIPE_DIRECTORY: environment.CUDA_MPS_PIPE_DIRECTORY ?? null },
            },
        };
    }
    async function runProbe(agent, overrides, unset, maxMiB, signal) {
        const environment = Object.fromEntries(agent.env.map(entry => { const at = entry.indexOf('='); return [entry.slice(0, at), entry.slice(at + 1)]; }));
        Object.assign(environment, overrides);
        for (const name of unset) delete environment[name];
        const outcome = probeReport(agent, environment, maxMiB);
        const probe = { active: true, allocatedMiB: outcome.report.allocatedMiB || 0, env: environment, maxMiB };
        model.probes.push(probe);
        let bypass = null;
        if (outcome.status === 0 && !outcome.mpsOn) bypass = spawn({ cgroup: leafOf(agent), ppid: agent.proc.hostPid, ns: [model.nextBox++, 2] });
        if (bypass) model.bypassProcs.push(bypass);
        if (outcome.mpsOn && !model.daemon.servers.length) {
            const proc = spawn({ cgroup: corePath(), ppid: model.daemon.hostPid, ns: [model.nextBox++] });
            model.daemon.servers.push({ proc, hostPid: proc.hostPid, boxPid: proc.nspid[1] });
        }
        if (faults.foreignDuringProbe) model.foreign.push({ pid: 777777, type: 'C', name: 'train.py' });
        const end = Date.now() + (faults.probeMs ?? 40);
        while (Date.now() < end) {
            if (signal?.aborted) break;
            await new Promise(resolve => setTimeout(resolve, 3));
        }
        probe.active = false;
        if (bypass) { stop(bypass); model.bypassProcs = model.bypassProcs.filter(value => value !== bypass); }
        if (signal?.aborted) return ok('', { status: null, cancelled: true });
        return ok(`${JSON.stringify(sortDeep(outcome.report))}\n`, { status: outcome.status });
    }

    // --- MPS control -------------------------------------------------------
    // The observed display of the driver (595.91.07, captured by LIVE-P1 attempt 5): a limit of at least 1 GiB is shown as floor(MiB/1024)G.
    const displayMemory = mib => (mib >= 1024 ? `${Math.floor(mib / 1024)}G` : `${mib}M`);
    const memoryReply = () => (faults.memoryReplyForm ? faults.memoryReplyForm(model.daemon.defaults.mib) : `${displayMemory(model.daemon.defaults.mib)}\n`);
    function controlReply(command, { helper = null } = {}) {
        const daemon = model.daemon;
        if (!daemon || daemon.lost) return ok('', { status: 1, stderr: 'Cannot connect to MPS control daemon' });
        if (command === 'get_server_list') return ok(`${daemon.servers.map(server => server.boxPid).join('\n')}${daemon.servers.length ? '\n' : ''}`);
        // The captured form of the driver (595.91.07): a decimal with a zero fraction.
        if (command === 'get_default_active_thread_percentage') return ok(`${daemon.defaults.sm}.0\n`);
        if (command === 'get_default_device_pinned_mem_limit 0') return ok(memoryReply());
        if (/^set_(?:active_thread_percentage|device_pinned_mem_limit) /.test(command)) {
            model.controlLog.push({ command, helper });
            if (faults.controlDenied) return ok('Error: operation not permitted\n');
            if (/^set_active_thread_percentage .* 100$/.test(command)) model.widened = true;
            // `memorySetterBreaksNextContext`: an accepted low per-server memory limit makes the
            // next context creation fail until the daemon is replaced.
            if (/^set_device_pinned_mem_limit /.test(command) && faults.memorySetterBreaksNextContext) model.memoryLimited = true;
            return ok('');
        }
        return failed('unknown MPS command', 1);
    }

    // --- The administrator route -------------------------------------------
    const key = role => fixtureContainerName(model.workspace, nameOf(role), fixture.repository);
    function gpuStatus() {
        const daemon = model.daemon;
        return {
            eligible: !faults.gpuIneligible, mode: 'mps-shared', assurance: 'best-effort', memoryModel: 'dedicated', name: gpu.name, deviceUuid: gpu.uuid, driverVersion: gpu.driverVersion,
            deviceMemoryBytes: gpu.memoryMiB * 1048576, daemonStatus: daemon ? (daemon.lost ? 'lost' : 'ready') : 'stopped',
            serverDefault: daemon && !daemon.lost ? { smPercent: daemon.defaults.sm, vramMiB: daemon.defaults.mib, shareMemoryMiB: faults.statusShareMiB ?? daemon.defaults.share ?? null } : null,
            mpsGeneration: daemon && !daemon.lost ? `${daemon.gen}:${daemon.cfg}` : null, reason: faults.gpuIneligible ? 'GPU sharing is not qualified in this Box.' : undefined,
        };
    }
    function agentsState() {
        const shares = desiredShares();
        return [...fixture.roles].sort((a, b) => refOf(a).localeCompare(refOf(b))).map(role => {
            const ref = refOf(role); const agent = model.agents.get(role); const share = shares[role] || null;
            const daemon = model.daemon;
            const applied = (share ? Boolean(agent?.share && JSON.stringify(agent.share) === JSON.stringify(share) && daemon && !daemon.lost && agent.mpsGeneration === `${daemon.gen}:${daemon.cfg}`) : !agent?.share) && agent?.limitsKey === policyKey(role);
            return { ref, configured: model.store.policies[ref] || {}, declared: {}, effective: {}, containers: agent ? [{ key: key(role), alias: null, instanceId: agent.id, enableGeneration: agent.id, availability: 'ready', limitsState: applied ? 'applied' : 'pending', problem: null, mpsGeneration: agent.mpsGeneration || null }] : [] };
        });
    }
    const adminState = () => ({ ok: true, token: { epoch: model.store.epoch, revision: model.store.revision }, gate: { state: 'on', prepared: true, backendReady: true, controllers: ['cpu', 'memory', 'pids'] }, envelope: faults.envelope === undefined ? envelope : faults.envelope, gpu: gpuStatus(), help: {}, agents: agentsState(), apply: null });
    async function admin(method, bodyText) {
        if (faults.adminStatus && method === 'GET') return { status: faults.adminStatus, text: JSON.stringify({ ok: false, error: 'not_authenticated' }) };
        if (method === 'GET') return { status: 200, text: JSON.stringify(adminState()) };
        const body = JSON.parse(bodyText);
        if (JSON.stringify(body.expectedToken) !== JSON.stringify({ epoch: model.store.epoch, revision: model.store.revision })) return { status: 409, text: JSON.stringify({ ok: false, error: 'revision_conflict' }) };
        if (body.action === 'set_agent_limits') {
            const limits = body.limits || {};
            const gpuShare = limits.gpu;
            const bad = { status: 400, text: JSON.stringify({ ok: false, error: 'invalid_limits' }) };
            if (Object.keys(limits).some(name => !['cpus', 'memoryPercent', 'gpu'].includes(name)) || !Object.keys(limits).length) return bad;
            if (gpuShare !== undefined && (!gpuShare || !Number.isInteger(gpuShare.smPercent) || !Number.isInteger(gpuShare.vramPercent) || gpuShare.smPercent < 1 || gpuShare.vramPercent < 1 || shareMemoryMiB(gpuShare.vramPercent, gpu.memoryMiB) < 512)) return bad;
            if (limits.memoryPercent !== undefined && (!Number.isInteger(limits.memoryPercent) || limits.memoryPercent < 1 || limits.memoryPercent > 100)) return bad;
            if (limits.cpus !== undefined && (typeof limits.cpus !== 'number' || !(limits.cpus >= 0.05))) return bad;
            const visible = faults.envelope === undefined ? envelope : faults.envelope;
            if (limits.cpus !== undefined && visible && limits.cpus > visible.cpus) return { status: 422, text: JSON.stringify({ ok: false, error: 'exceeds_envelope', message: `cpus ${limits.cpus} exceeds the Box envelope of ${visible.cpus}` }) };
            model.store.policies[body.agentRef] = {
                ...(limits.cpus !== undefined ? { cpus: limits.cpus } : {}), ...(limits.memoryPercent !== undefined ? { memoryPercent: limits.memoryPercent } : {}),
                ...(gpuShare !== undefined ? { gpu: { smPercent: gpuShare.smPercent, vramPercent: gpuShare.vramPercent } } : {}),
            };
            model.store.revision += 1;
            // `stopOnSave`: that client stops (by itself) between its save and the Apply.
            if (faults.stopOnSave) { const stopped = model.agents.get(faults.stopOnSave); if (stopped && refOf(faults.stopOnSave) === body.agentRef) stopped.running = false; }
            return { status: 200, text: JSON.stringify({ ...adminState(), committed: true }) };
        }
        if (body.action === 'clear_agent_limits') {
            delete model.store.policies[body.agentRef];
            model.store.revision += 1;
            return { status: 200, text: JSON.stringify({ ...adminState(), committed: true }) };
        }
        if (body.action === 'apply') {
            model.applyCalls.push(body.containers);
            // The Router and Watchdog write their logs into the owned workspace while an Apply runs.
            if (faults.logApply) {
                const directory = path.join(model.workspace, '.ploinky', 'logs');
                fs.mkdirSync(directory, { recursive: true });
                for (const name of ['router.log', 'watchdog.log']) fs.appendFileSync(path.join(directory, name), `[${name}] ${faults.logApply}\n`);
            }
            if (faults.applyStatus) return { status: faults.applyStatus, text: JSON.stringify(faults.applyBody ?? { ok: false, error: 'apply_failed' }) };
            const roles = body.containers.map(container => fixture.roles.find(role => key(role) === container));
            if (roles.some(role => !role)) return { status: 400, text: JSON.stringify({ ok: false, error: 'unknown_container' }) };
            try { await applyFlow(roles); } catch (error) {
                if (!error.drainFailure) throw error;
                // The real Apply response of a refused drain (observed in LIVE-P1 attempt 6).
                const cause = { step: 'client-launch', errorClass: 'Error', code: 'TARGETED_DRAIN_FAILED', message: error.message };
                const message = `Apply stopped at client-launch: Error (TARGETED_DRAIN_FAILED): ${error.message}`;
                return { status: 409, text: JSON.stringify({ ok: false, status: 409, error: 'TARGETED_DRAIN_FAILED', message, ...(faults.applyBodyPadding ? { padding: 'x'.repeat(faults.applyBodyPadding) } : {}), cause, token: { epoch: model.store.epoch, revision: model.store.revision }, expandedContainers: [],
                    results: roles.map(role => ({ key: key(role), state: 'pending', problem: null, error: 'TARGETED_DRAIN_FAILED', message, cause })) }) };
            }
            return { status: 200, text: JSON.stringify({ ok: true, results: roles.map(role => ({ key: key(role), state: 'applied' })) }) };
        }
        return { status: 400, text: JSON.stringify({ ok: false, error: 'unknown_action' }) };
    }

    // --- In-Box programs -----------------------------------------------------
    function mpsObserve() {
        model.observeCalls += 1;
        const daemon = model.daemon;
        if (!daemon) return { state: model.mpsStatus === 'inactive' ? { schema: 1, status: 'inactive', daemonGeneration: null, configurationGeneration: null, serverDefault: null, pipeDirectory: null, logDirectory: null, daemon: null, tools: null, pendingClients: [], oldClients: [], desiredClients: [] } : null, daemon: null, control: null };
        const alive = !daemon.lost && model.procs.has(daemon.hostPid);
        const out = {
            state: {
                schema: 1, status: model.mpsStatus, daemonGeneration: daemon.gen, configurationGeneration: daemon.cfg, serverDefault: { smPercent: daemon.defaults.sm, memoryMiB: daemon.defaults.mib, shareMemoryMiB: daemon.defaults.share },
                pipeDirectory: daemon.pipe, logDirectory: daemon.log, daemon: { pid: daemon.boxPid, startTime: daemon.start, executableDev: 1, executableIno: 2 }, tools: null, pendingClients: [], oldClients: [], desiredClients: [],
                lastReadback: { at: 1, sm: `${daemon.defaults.sm}.0`, memory: displayMemory(daemon.defaults.mib), servers: '' },
            },
            daemon: { pid: daemon.boxPid, alive, startTime: daemon.start, status: [faults.daemonUid0 ? 'Uid:\t0\t0\t0\t0' : 'Uid:\t1000\t1000\t1000\t1000', 'Gid:\t1000\t1000\t1000\t1000'], cgroup: '0::/ploinky/core', exe: { dev: 1, ino: 2 }, pipeEnvMatches: true },
            control: null,
        };
        if (!alive) { out.daemon = { pid: daemon.boxPid, alive: false, error: 'ENOENT' }; return out; }
        out.control = ['get_default_active_thread_percentage', 'get_default_device_pinned_mem_limit 0', 'get_server_list'].map(command => {
            const reply = controlReply(command);
            return { command, status: reply.status, signal: null, stdout: reply.stdout, stderr: reply.stderr, error: null };
        });
        return out;
    }
    // The failure evidence program: the private state with its last problem and the daemon's logs, read-only.
    function failureEvidence() {
        model.programs.push({ program: 'failure-evidence' });
        const daemon = model.daemon;
        const logs = daemon ? [{ directory: daemon.log, files: [
            { name: 'control.log', size: 64, tail: `[fake] control log of ${daemon.gen}\n${faults.controlLogSecret ? 'token=abcdef123456 Authorization: Bearer ghijklmnopqrstu\n' : ''}` },
            { name: 'server.log', size: 24, tail: '[fake] server log\n' }] }] : [];
        return {
            state: daemon ? { schema: 1, status: model.mpsStatus, transitionId: null, daemonGeneration: daemon.gen, configurationGeneration: daemon.cfg, serverDefault: { smPercent: daemon.defaults.sm, memoryMiB: daemon.defaults.mib, shareMemoryMiB: daemon.defaults.share }, pipeDirectory: daemon.pipe, logDirectory: daemon.log,
                daemon: { pid: daemon.boxPid, startTime: daemon.start }, pendingClients: [], oldClients: [], drainedClients: 0, lastProblem: faults.lastProblem ?? null, lastReadback: faults.lastReadback ?? { at: 1, sm: `${daemon.defaults.sm}.0`, memory: displayMemory(daemon.defaults.mib), servers: '' } }
                : { schema: 1, status: 'pending', transitionId: 'fake', daemonGeneration: null, configurationGeneration: null, serverDefault: null, pipeDirectory: null, logDirectory: null, daemon: null, pendingClients: [{ key: key('probe'), phase: 'pending', containerId: null }], oldClients: [], drainedClients: 0, lastProblem: faults.lastProblem ?? null },
            daemon: daemon ? { pid: daemon.boxPid, alive: !daemon.lost, startTime: daemon.start, cgroup: '0::/ploinky/core' } : null,
            logs, entries: daemon ? [path.basename(daemon.pipe), path.basename(daemon.log), 'state.json'] : ['state.json'], omittedLogFiles: 0, problems: [],
        };
    }
    function killProgram(args) {
        model.programs.push({ program: 'kill', args });
        const pid = Number(args[0]); const start = String(args[1]);
        const daemon = model.daemon;
        const refuse = reason => ({ killed: false, refused: reason });
        if (faults.boxRefusesKill) return refuse('state does not name this daemon');
        if (!daemon || daemon.boxPid !== pid || String(daemon.start) !== start) return refuse('state does not name this daemon');
        const proc = model.procs.get(daemon.hostPid);
        if (!proc || proc.start !== start) return refuse('start time differs');
        model.signals.push({ hostPid: proc.hostPid, signal: 'SIGKILL' });
        stop(proc); for (const server of daemon.servers) stop(server.proc);
        daemon.lost = true; daemon.servers = [];
        return { killed: true, pid, start };
    }
    async function core(args, options) {
        const at = args.indexOf('-e');
        const script = args[at + 1];
        const rest = args.slice(at + 2);
        if (script === ADMIN_REQUEST) {
            model.programs.push({ program: 'admin', method: rest[0], body: rest[1] });
            const reply = await admin(rest[0], rest[1]);
            return ok(JSON.stringify(reply));
        }
        if (script === GPU_GRANT_FACTS) {
            model.programs.push({ program: 'grant-facts' });
            const smi = (stdout, stderr = '') => ({ status: stdout ? 0 : 127, signal: null, error: null, stdout, stderr });
            return ok(JSON.stringify({ marker: { state: 'active', reason: null, fingerprint: 'f'.repeat(64), driverVersion: gpu.driverVersion, devices: 2, mps: ['control', 'server'], mpsProblem: null },
                tools: {}, smi: { bare: smi('', 'NVIDIA-SMI has failed: libnvidia-ml.so.1: cannot open shared object file'), withLoaderPath: smi(`0, ${gpu.uuid}, ${gpu.name}, ${gpu.memoryMiB}, ${gpu.driverVersion}`) } }));
        }
        if (script === MPS_OBSERVE) { model.programs.push({ program: 'observe' }); return ok(JSON.stringify(mpsObserve())); }
        if (script === MPS_FAILURE_EVIDENCE) return faults.evidenceProgramFails ? failed('Error: the Box is not running') : ok(JSON.stringify(failureEvidence()));
        if (script === MPS_KILL_OWNED_DAEMON) {
            // `killResult`: the kill program itself fails (a nonzero exit, a timeout, a spawn error).
            if (faults.killResult) return ok('', faults.killResult);
            if (faults.reuseDaemonPid && model.daemon && !model.daemon.reused) { model.daemon.reused = true; model.procs.get(model.daemon.hostPid).start = String(++model.clock); }
            return ok(JSON.stringify(killProgram(rest)));
        }
        if (hooks.core) { const handled = await hooks.core({ script, rest, options }); if (handled) return handled; }
        return failed('unmodeled in-Box program');
    }

    // --- Nested engine ------------------------------------------------------
    const agentModel = agent => ({
        ID: agent.id, Name: `/${agent.name}`, Created: agent.created, Image: agent.image, ImageName: agent.imageName,
        Config: { Labels: agent.labels, Env: agent.env, User: agent.user }, Mounts: agent.mounts,
        State: { Status: 'running', Running: agent.running, Pid: agent.boxPid, StartedAt: agent.startedAt, FinishedAt: '0001-01-01T00:00:00Z', ConmonPid: 2, ExitCode: 0, OOMKilled: false },
    });
    const helperModel = helper => ({ ID: helper.id, Name: `/${helper.name}`, Created: helper.created, Image: hex('agent-image'), ImageName: model.image, Config: { Labels: helper.labels, Env: [], User: '1000:1000' }, Mounts: helper.mounts, State: { Status: 'running', Running: true, Pid: helper.boxPid, StartedAt: helper.created, FinishedAt: '0001-01-01T00:00:00Z', ConmonPid: 2, ExitCode: 0, OOMKilled: false } });
    const byId = id => [...model.agents.values()].find(agent => agent.id === id) || null;
    async function nested(args, options) {
        const verb = args.slice(0, 2).join(' ');
        if (verb === 'container ps') {
            const format = args[args.indexOf('--format') + 1];
            if (format !== NESTED_NAME_LIST_FORMAT) return null;
            const rows = [...model.agents.values()].map(agent => `${agent.id} ${agent.name}`).concat([...model.helpers.values()].map(helper => `${helper.id} ${helper.name}`));
            return ok(rows.map(row => `${row}\n`).join(''));
        }
        if (verb === 'container inspect') {
            const format = args[args.indexOf('--format') + 1]; const id = args.at(-1);
            if (format !== GPU_AGENT_INSPECT) return null;
            if (faults.dropNested?.includes(id)) return failed('Error: no such container');
            const agent = byId(id); const helper = model.helpers.get(id);
            if (!agent && !helper) return failed('Error: no such container');
            const rendered = evaluateTemplate(format, 'inspect', agent ? agentModel(agent) : helperModel(helper));
            return typeof rendered === 'string' ? ok(rendered) : rendered;
        }
        if (verb === 'container exec') {
            let index = 2; const overrides = {};
            while (args[index] === '--env') { const [name, ...value] = args[index + 1].split('='); overrides[name] = value.join('='); index += 2; }
            const id = args[index]; const command = args.slice(index + 1);
            const agent = byId(id); const helper = model.helpers.get(id);
            if (helper) {
                if (command[0] !== 'sh' || command[1] !== '-c' || command[3] !== 'sh') return failed('unmodeled helper command');
                if (!helper.writable && faults.roConnectRefused) return ok('', { status: 1, stderr: 'Cannot connect to MPS control daemon: read-only file system' });
                if (helper.writable && faults.helperCannotConnect) return ok('', { status: 1, stderr: 'Cannot connect to MPS control daemon' });
                return controlReply(command[4], { helper: helper.name });
            }
            if (!agent) return failed('Error: no such container');
            const unset = []; let argv = command;
            if (argv[0] === 'env') { let i = 1; while (argv[i] === '-u') { unset.push(argv[i + 1]); i += 2; } argv = argv.slice(i); }
            if (argv[0] === 'python3' && argv[1] === '/code/mpsprobe.py' && argv[2] === '--max-mib') return runProbe(agent, overrides, unset, Number(argv[3]), options.signal);
            if (argv[0] === 'python3' && argv[1] === '-c') { // the holder: connects a client, keeps a server alive
                const daemon = model.daemon;
                if (daemon && !daemon.lost && !daemon.servers.length) {
                    const proc = spawn({ cgroup: corePath(), ppid: daemon.hostPid, ns: [model.nextBox++] });
                    daemon.servers.push({ proc, hostPid: proc.hostPid, boxPid: proc.nspid[1] });
                }
                return new Promise(resolve => { const end = Date.now() + (faults.holderMs ?? 100000); const timer = setInterval(() => { if (options.signal?.aborted || Date.now() >= end) { clearInterval(timer); resolve(options.signal?.aborted ? ok('', { status: null, cancelled: true }) : ok('')); } }, 3); });
            }
            if (hooks.agentExec) { const handled = await hooks.agentExec({ agent, command, options, overrides }); if (handled) return handled; }
            return failed('unmodeled agent command');
        }
        if (args[0] === 'run') {
            if (faults.helperRunFails) return failed('Error: crun: creating the helper failed');
            const flag = name => args.filter((value, i) => args[i - 1] === name);
            const volumes = flag('--volume'); const named = flag('--name')[0];
            const pipeVolume = volumes.find(value => value.includes(`:${CLIENT_PIPE}:`));
            const control = volumes.includes('/usr/local/nvidia/bin/nvidia-cuda-mps-control:/x:ro');
            if (!args.includes('--userns=keep-id:uid=1000,gid=1000') || !control || !pipeVolume || !args.includes('--pull=never') || !args.includes('--cgroup-parent=/ploinky/system')) return failed('Error: unsupported helper invocation');
            const [source, , options_] = pipeVolume.split(':');
            if (!model.daemon || source !== model.daemon.pipe) return failed('Error: statfs: no such file or directory');
            const id = hex(`helper-${named}-${++model.clock}`);
            const writable = options_.endsWith('rw');
            const labels = Object.fromEntries(flag('--label').map(value => { const at = value.indexOf('='); return [value.slice(0, at), value.slice(at + 1)]; }));
            model.helpers.set(id, { id, name: named, created: '2026-10-02T12:10:00Z', labels, writable, boxPid: model.nextBox++, mounts: [{ Type: 'bind', Source: source, Destination: CLIENT_PIPE, RW: writable }] });
            return ok(`${id}\n`);
        }
        if (verb === 'container rm') {
            const id = args.at(-1);
            if (!model.helpers.delete(id)) return failed('Error: no such container');
            return ok(`${id}\n`);
        }
        return null;
    }

    // --- Candidate commands ---------------------------------------------------
    async function candidate(binary, args, options) {
        // The candidate's own outer parser decides first, as in the real CLI (its message, exit 1).
        const refusal = candidateArgvProblem(args);
        if (refusal) return failed(`ploinky: ${refusal}`, 1);
        const verbs = args.filter(value => !value.startsWith('-') && !/^[0-9]+$/.test(value));
        const identity = buildWorkspaceIdentity(options.cwd);
        const home = options.env.HOME;
        if (verbs.includes('gpu') && verbs.includes('grant')) {
            model.grantCalls.push(args);
            if (faults.grantFails) return failed('PLOINKY_BOX_GPU_DISCOVERY_FAILED: nvidia-uvm is missing', 1);
            const directory = path.join(home, '.ploinky-box', 'gpu-grants');
            fs.mkdirSync(path.join(directory, identity.instance), { recursive: true, mode: 0o700 });
            fs.writeFileSync(path.join(directory, identity.instance, 'wiring.json'), '{}');
            fs.writeFileSync(path.join(directory, `${identity.instance}.json`), JSON.stringify({ agents: args.filter((value, i) => args[i - 1] === '--agent') }));
            return ok('GPU grant saved\nNo Box exists yet; the next `ploinky start` applies it.\n');
        }
        if (verbs.includes('limits') && verbs.includes('clear')) {
            if (faults.limitsClearResult) return ok('', faults.limitsClearResult);
            const ref = args[args.indexOf('--agent') + 1];
            delete model.store.policies[ref]; model.store.revision += 1;
            return ok(`Cleared the stored hardware limits of ${ref}.\n`);
        }
        if (verbs.includes('restart')) {
            // `restartResult`: the restart command itself fails before it acts (a nonzero exit, a timeout, a spawn error).
            if (faults.restartResult) return ok('', faults.restartResult);
            const ref = args.at(-1); const role = ref.split('/')[1];
            await applyFlow([role]);
            return ok('restarted\n');
        }
        const result = await base(binary, args, options);
        if (verbs.includes('start') && result.status === 0) initializeGpuWorld(options.cwd);
        if (verbs.includes('destroy')) {
            // `survivorAfterDestroy`: the Box is gone but its MPS daemon process is still there.
            const survivors = faults.survivorAfterDestroy && model.daemon ? [model.daemon.proc] : [];
            // The Box's processes go with it; the host's own (a desktop's display process) stay.
            const outside = [...model.procs.values()].filter(proc => !String(proc.cgroup).startsWith(model.prefix));
            model.procs.clear(); for (const proc of [...outside, ...survivors]) model.procs.set(proc.hostPid, proc);
            model.dirs.clear(); model.agents.clear(); model.helpers.clear(); model.daemon = null;
        }
        return result;
    }
    function initializeGpuWorld(workspace) {
        const state = worldState(statePath);
        const identity = buildWorkspaceIdentity(workspace);
        const box = Object.values(state.boxes).find(value => value.labels[BOX_LABELS.pathHash] === identity.pathHash);
        model.boxId = box.id; model.workspace = workspace; model.instance = identity.instance;
        model.prefix = `/user.slice/user-1000.slice/user@1000.service/user.slice/libpod-${box.id}.scope/container`;
        if (!faults.noGpuWiring) {
            box.labels[BOX_LABELS.gpuGrant] = hex('wiring');
            box.pid = BOX_INIT_PID;
            const tools = [['nvidia-cuda-mps-control', gpu.mpsControl], ['nvidia-cuda-mps-server', gpu.mpsServer], ['nvidia-smi', gpu.smi]];
            box.mounts = [...box.mounts, ...tools.map(([name, source]) => ({ Type: 'bind', Source: source, Destination: `/usr/local/nvidia/bin/${name}`, RW: false })),
                { Type: 'bind', Source: '/usr/lib/x86_64-linux-gnu/libcuda.so.595.91.07', Destination: '/usr/local/nvidia/lib64/libcuda.so.1', RW: false }];
        } else box.pid = BOX_INIT_PID;
        fs.writeFileSync(statePath, JSON.stringify(state));
        model.procs.set(BOX_INIT_PID, { hostPid: BOX_INIT_PID, start: '50', ppid: 1, cgroup: corePath(), nspid: [BOX_INIT_PID, 1], uid: hostUid });
        model.dirs.add(corePath());
        const first = Object.values(state.agents)[0];
        model.image = first.imageName;
        // The agents the engine's own start created keep their recorded identities.
        for (const role of fixture.roles) createAgent(role, { recorded: state.agents[fixtureContainerName(workspace, nameOf(role), fixture.repository)] });
    }

    async function provider(binary, args, options = {}) {
        model.calls.push({ binary, args, cwd: options.cwd });
        // `smiDelayMs`: nvidia-smi is slow, and answers with the state at the END of the delay.
        if (binary === gpu.smi) { if (faults.smiDelayMs) await new Promise(resolve => setTimeout(resolve, faults.smiDelayMs)); return smi(args); }
        if (binary === node) return candidate(binary, args, options);
        if (binary === engine && args[0] === 'container' && args[1] === 'exec' && args[2] === '--user' && args[3] === 'podman' && args[4] === model.boxId) {
            const inner = args.slice(5);
            if (inner[0] === 'node') return core(inner.slice(1), options);
            if (inner[0] === 'podman' && inner[1] === '--cgroup-manager=cgroupfs') {
                const handled = await nested(inner.slice(2), options);
                if (handled) return handled;
            }
        }
        return base(binary, args, options);
    }
    // What a fixture built on this world (fakeLiveLlm.mjs) needs of its internals.
    const helpers = {
        spawn, stop, leafOf, corePath, createAgent, agentByRole: role => model.agents.get(role), refOf, nameOf, policyOf: role => model.store.policies[refOf(role)] ?? null,
        // A share client that creates a CUDA context makes the daemon start its server on demand.
        ensureServer(agent) {
            const daemon = model.daemon;
            if (agent.share && daemon && !daemon.lost && !daemon.servers.length) {
                const proc = spawn({ cgroup: corePath(), ppid: daemon.hostPid, ns: [model.nextBox++] });
                daemon.servers.push({ proc, hostPid: proc.hostPid, boxPid: proc.nspid[1] });
            }
        },
        dropServers() { if (model.daemon) { for (const server of model.daemon.servers) stop(server.proc); model.daemon.servers = []; } },
    };
    return {
        provider, hostProc, model, statePath, helpers,
        // Test controls.
        addForeign(pid, type = 'C') { model.foreign.push({ pid, type }); },
        // A logged-in desktop's display process (amendment A5): listed by nvidia-smi with its small
        // memory, and a real process on the host (outside the Box), so its identity can be proved.
        addDisplay(pid, { type = 'G', mib = 2, name = '/usr/bin/gnome-shell', cgroup = '/user.slice/user-1000.slice/user@1000.service/session.slice/org.gnome.Shell@wayland.service' } = {}) {
            model.procs.set(pid, { hostPid: pid, start: String(++model.clock), ppid: 1, cgroup, nspid: [pid], uid: hostUid });
            model.foreign.push({ pid, type, mib, name });
        },
        removeDisplay(pid) { model.foreign = model.foreign.filter(value => value.pid !== pid); model.procs.delete(pid); },
        clearForeign() { model.foreign = []; },
        reusePid(hostPid) { const proc = model.procs.get(hostPid); proc.start = String(++model.clock); },
    };
}
