import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { READER_INSPECT_FORMAT, parseReaderInspect } from './engine_codex.mjs';

// In-Box, read-only, nonsecret projection of runtime membership for U0/readiness checks. The host feeds this module
// to `container exec` through a fixed bootstrap. It calls only existing read-only product readers, never prepares,
// repairs, applies or starts anything, and prints a single public JSON document or a fixed failure code.
export const PROBE_SCHEMA = 'live-update-cache-box-probe';
export const PROBE_LIMITS = Object.freeze({ generationBytes: 8 * 1024 * 1024, requiredRuntimes: 256, inspectBytes: 1024 * 1024, inspectMs: 30000, configBytes: 1024 * 1024 });
const hex64 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\0\r\n]/.test(value);
export class ProbeFailure extends Error { constructor(code) { super(code); this.code = code; } }
const need = (condition, code) => { if (!condition) throw new ProbeFailure(code); };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const selectorTuple = selector => ({ state: selector?.state, generation: selector?.generation, activationId: selector?.activationId, publicationState: selector?.publicationState });

export function validateProbeInput(input) {
    need(input && Object.keys(input).join() === 'requiredRuntimes' && Array.isArray(input.requiredRuntimes)
        && input.requiredRuntimes.length > 0 && input.requiredRuntimes.length <= PROBE_LIMITS.requiredRuntimes, 'probe-input');
    const names = new Set();
    for (const row of input.requiredRuntimes) {
        need(row && Object.keys(row).sort().join() === ['name', 'noWait'].sort().join() && /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(row.name) && typeof row.noWait === 'boolean' && !names.has(row.name), 'probe-input');
        names.add(row.name);
    }
    return input;
}

function generationFile(paths, generation) {
    const hex = String(generation || '').replace(/^sha256:/, '');
    need(hex64(hex), 'probe-generation-id');
    return path.join(paths.generationsDir, `${hex}.json`);
}

// A bounded stat fence around the product reader's unbounded generation read.
function fenceGeneration(io, file) {
    let stat;
    try { stat = io.lstatSync(file); } catch { throw new ProbeFailure('probe-generation-unreadable'); }
    need(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= PROBE_LIMITS.generationBytes, 'probe-generation-bound');
    return Object.freeze({ dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs });
}

export function inspectNestedContainers(containerIds, { spawnSync = childProcess.spawnSync, env = process.env } = {}) {
    const rows = new Map();
    for (const containerId of containerIds) {
        need(hex64(containerId), 'probe-container-id');
        const result = spawnSync('podman', ['container', 'inspect', '--format', READER_INSPECT_FORMAT, containerId],
            { encoding: 'buffer', maxBuffer: PROBE_LIMITS.inspectBytes, timeout: PROBE_LIMITS.inspectMs, shell: false, env: { PATH: env.PATH ?? '/usr/bin:/bin', HOME: env.HOME ?? '/home/podman', LC_ALL: 'C' } });
        need(!result.error && result.status === 0 && Buffer.isBuffer(result.stdout), 'probe-container-inspect');
        try { rows.set(containerId, parseReaderInspect(result.stdout, containerId)); } catch { throw new ProbeFailure('probe-container-inspect'); }
    }
    return rows;
}

export async function loadProductApis(root = '/opt/ploinky') {
    const base = specifier => path.join(root, specifier);
    const [registry, edge, states, readiness] = await Promise.all([import(base('cli/utils/agentRegistrySnapshot.js')), import(base('cli/sandbox/edgeGeneration.js')),
        import(base('cli/sandbox/agentRuntimeState.js')), import(base('cli/utils/noWaitReadiness.js'))]);
    return { readAgentRegistrySnapshot: registry.readAgentRegistrySnapshot, readEdgeRoutingSelection: edge.readEdgeRoutingSelection,
        loadActiveEdgeRoutingGeneration: edge.loadActiveEdgeRoutingGeneration, collectAgentRuntimeStates: states.collectAgentRuntimeStates,
        applyRuntimeReadinessProjection: readiness.applyRuntimeReadinessProjection };
}

function selectRecords(registry, requiredRuntimes) {
    const selected = [];
    for (const { name, noWait } of requiredRuntimes) {
        const [repoName, agentName] = name.split('/');
        const matches = Object.entries(registry).filter(([, record]) => record?.type === 'agent' && record.repoName === repoName && record.agentName === agentName);
        need(matches.length === 1, matches.length === 0 ? 'probe-runtime-missing' : 'probe-runtime-ambiguous');
        const [containerName, record] = matches[0];
        need(hex64(String(record.containerId || '').toLowerCase()) && record.runtime === 'podman' && text(record.instanceId) && text(record.enableGeneration), 'probe-runtime-identity');
        selected.push({ name, noWait, containerName, record });
    }
    return selected;
}

// `apis`: the existing readers. `io`: lstat for the generation fence. Both are replaceable only by the focused controls.
// The primary/static agent and its port are the only public configuration fields compared across the run.
export function readPublicConfig(workspaceRoot, io = fs) {
    const file = path.join(workspaceRoot, '.ploinky', 'routing.json'); let fd;
    try { fd = io.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); } catch { throw new ProbeFailure('probe-config-unreadable'); }
    try {
        const stat = io.fstatSync(fd); need(stat.isFile() && stat.size <= PROBE_LIMITS.configBytes, 'probe-config-bound');
        const buffer = Buffer.alloc(PROBE_LIMITS.configBytes + 1); let offset = 0;
        for (;;) { const count = io.readSync(fd, buffer, offset, buffer.length - offset, null); if (!count) break; offset += count; need(offset <= PROBE_LIMITS.configBytes, 'probe-config-bound'); }
        let value; try { value = JSON.parse(buffer.subarray(0, offset).toString('utf8')); } catch { throw new ProbeFailure('probe-config-unreadable'); }
        const agent = value?.static?.agent, port = value?.static?.port;
        need(typeof agent === 'string' && text(agent), 'probe-config-unreadable');
        const numericPort = typeof port === 'number' ? port : Number(port);
        need(Number.isSafeInteger(numericPort) && numericPort > 0 && numericPort < 65536, 'probe-config-unreadable');
        return { staticAgent: agent, staticPort: numericPort };
    } finally { io.closeSync(fd); }
}

export async function runBoxProbe(input, { workspaceRoot, apis, io = fs, inspect = inspectNestedContainers } = {}) {
    validateProbeInput(input);
    need(typeof workspaceRoot === 'string' && path.isAbsolute(workspaceRoot) && apis, 'probe-environment');
    const first = apis.readEdgeRoutingSelection({ workspaceRoot });
    need(first?.selector?.state === 'active' && first.selector.generation && first.selector.activationId, 'probe-selector-inactive');
    const file = generationFile(first.paths, first.selector.generation), fenceBefore = fenceGeneration(io, file);
    let active; try { active = apis.loadActiveEdgeRoutingGeneration({ workspaceRoot }); } catch (error) {
        need(false, error?.code === 'EDGE_GENERATION_RUNTIME_MISMATCH' ? 'probe-generation-runtime-mismatch' : 'probe-generation-load'); }
    need(JSON.stringify(selectorTuple(active.selector)) === JSON.stringify(selectorTuple(first.selector)), 'probe-selector-changed');
    let registry; try { registry = apis.readAgentRegistrySnapshot({ workspaceRoot }); } catch { throw new ProbeFailure('probe-registry-unreadable'); }
    const selected = selectRecords(registry, input.requiredRuntimes);
    const rows = inspect(selected.map(row => row.record.containerId.toLowerCase()));
    const liveContainers = selected.map(({ containerName, record }) => { const row = rows.get(record.containerId.toLowerCase());
        return { containerName, containerId: row.id, agentName: record.agentName, repoName: record.repoName, state: { status: row.running ? 'running' : 'exited', running: row.running, pid: 0 } }; });
    const states = apis.applyRuntimeReadinessProjection(apis.collectAgentRuntimeStates({ registry, liveContainers, activeGeneration: active.generation }), registry);
    const graph = selected.map(({ name, noWait, containerName, record }) => {
        const row = rows.get(record.containerId.toLowerCase()), state = states.find(entry => entry.containerName === containerName)?.state;
        const captured = active.generation.agents?.[containerName];
        const joined = captured?.type === 'agent' && captured.repoName === record.repoName && captured.agentName === record.agentName
            && captured.instanceId === record.instanceId && captured.enableGeneration === record.enableGeneration;
        const labelsEqual = row.instanceId === record.instanceId && row.enableGeneration === record.enableGeneration && row.name === containerName;
        const running = row.running === true && state?.running === true;
        const noWaitState = typeof state?.noWaitState === 'string' ? state.noWaitState : null;
        // Ordinary runtimes are ready when the product's own state folds route/readiness into running; no-wait runtimes need their exact current marker.
        const ready = joined && labelsEqual && running && (noWait ? state?.ready === true && noWaitState === 'running' : state?.ready !== false);
        return { name, containerName, runtimeId: record.containerId.toLowerCase(), instanceId: record.instanceId, enableGeneration: record.enableGeneration,
            graphGeneration: active.selector.generation, running, ready, noWaitState, generationJoin: joined, labelsEqual, imageId: row.imageId };
    });
    const second = apis.readEdgeRoutingSelection({ workspaceRoot });
    need(JSON.stringify(selectorTuple(second.selector)) === JSON.stringify(selectorTuple(first.selector)), 'probe-selector-changed');
    need(JSON.stringify(fenceGeneration(io, file)) === JSON.stringify(fenceBefore), 'probe-generation-changed');
    let after; try { after = apis.readAgentRegistrySnapshot({ workspaceRoot }); } catch { throw new ProbeFailure('probe-registry-unreadable'); }
    const projection = records => selectRecords(records, input.requiredRuntimes).map(row => [row.containerName, row.record.containerId, row.record.instanceId, row.record.enableGeneration]);
    need(digest(projection(after)) === digest(projection(registry)), 'probe-registry-changed');
    return { schema: PROBE_SCHEMA, version: 1, selector: selectorTuple(active.selector), graph, publicConfig: readPublicConfig(workspaceRoot, io) };
}

export async function probeMain({ input, workspaceRoot = process.env.PLOINKY_WORKSPACE_ROOT, write = value => process.stdout.write(`${JSON.stringify(value)}\n`), load = loadProductApis } = {}) {
    try { write(await runBoxProbe(input, { workspaceRoot, apis: await load() })); return 0; }
    catch (error) { write({ schema: PROBE_SCHEMA, version: 1, failure: error instanceof ProbeFailure ? error.code : 'probe-failed' }); return 1; }
}
