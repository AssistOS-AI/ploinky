import fs from 'node:fs';
import { validateHardwareRequest } from './hardwareLimitsRequest.mjs';
export { validateHardwareRequest } from './hardwareLimitsRequest.mjs';
import { readBoxHardwareMarker } from '../../../ploinky-box/lib/hardwareLimitsMarker.mjs';
import { isInsideBox } from '../../../ploinky-box/lib/boxMarker.mjs';
import { readBoxHardwareContext } from '../../sandbox/hardwareLimits/context.mjs';
import {
    HardwareStoreError, hardwareStorePaths, readStoreSnapshot, setAgentLimits, clearAgentLimits,
    assertPolicyWritesAllowed, parseLimitsRequestBody, validateStoreToken, MAX_REQUEST_BYTES,
} from '../../sandbox/hardwareLimits/store.mjs';
import { admitManifestRuntimeCapabilities, hardwareLimitsHashOf } from '../../sandbox/runtimeCapabilities.js';
import { readAgentRegistrySnapshot } from '../../utils/agentRegistrySnapshot.js';
import { collectAgentsSummary } from '../../utils/status.js';
import { readRoutingConfig } from '../routingFile.js';
import { findHardwareOutcome, validateHardwareOutcome } from '../../sandbox/hardwareLimits/errors.mjs';
import { readAppliedObservation } from '../../sandbox/hardwareLimits/runtimeState.mjs';
import { runHardwareLimitsApplyWorker, hardwareApplyFlight } from '../hardwareLimitsApplyWorker.mjs';
import { workspaceMetricsMonitor } from '../workspaceMetrics.js';
import { resolveManifestRuntimeProfile } from '../../utils/runtime/profileService.js';
import { resolveLlmRuntimeAdmissionContext } from '../../sandbox/docker/llmRuntimeIntegration.js';
import { isSessionRevoked } from '../auth/sessionRevocations.js';
import { createHardwareApplyAuthority } from '../hardwareLimitsApplyAuthority.mjs';

export const HARDWARE_HELP = Object.freeze({
    authority: 'Workspace-capable agents may read the workspace master key and forge administrator cookie/CSRF requests. This exposure is accepted for v1.',
    gpu: [
        'GPU shares use NVIDIA MPS and are best-effort, not a security boundary.',
        'Share clients use the same Box user as the MPS daemon. They can issue control commands, widen settings, stop the daemon and alter its writable pipe-directory entries.',
        'A process that drops the MPS environment can use the GPU outside MPS in DEFAULT compute mode.',
        'The MPS device-memory limit applies to each CUDA process, not to the sum of every process in an agent.',
        'A RAM cgroup limit does not cap dedicated GPU memory.',
        'Only the host operator may choose EXCLUSIVE_PROCESS. It affects other CUDA users and workspaces. Ploinky never changes compute mode.',
    ],
});

function fail(code, message, status = 400) { throw new HardwareStoreError(message, { code, status }); }

export function hasHardwareBearer(req) {
    const values = Object.entries(req.headers || {}).filter(([key]) => key.toLowerCase() === 'authorization').flatMap(([, value]) => Array.isArray(value) ? value : [value]);
    for (let index = 0; index < (req.rawHeaders || []).length; index += 2) {
        if (String(req.rawHeaders[index]).toLowerCase() === 'authorization') values.push(req.rawHeaders[index + 1]);
    }
    return values.some((value) => /(?:^|,)\s*bearer(?:\s|$)/i.test(String(value)));
}


function defaultContext({ refreshBackend = false } = {}) {
    if (!isInsideBox()) fail('not_in_box', 'Hardware administration requires this workspace\'s Ploinky Box.', 409);
    const marker = readBoxHardwareMarker();
    const context = readBoxHardwareContext({ refreshBackend });
    if (context.gate !== 'on') return { ...context, identity: null, paths: null };
    if (!marker.valid) fail('store_unreadable', 'The hardware wiring marker cannot be read safely.', 503);
    const identity = { instance: marker.marker.instance, pathHash: marker.marker.pathHash, workspaceRoot: marker.marker.workspaceRoot };
    return { ...context, identity, paths: hardwareStorePaths({ identity, context: 'box' }) };
}

function installedAgents() {
    return collectAgentsSummary({ includeInactive: true }).flatMap((repo) => (repo.agents || []).map((agent) => ({ ref: `${agent.repo}/${agent.name}`, manifestPath: agent.manifestPath })));
}

function defaultAdmission(agent, record = {}, context) {
    const bytes = fs.readFileSync(agent.manifestPath);
    const manifest = JSON.parse(bytes.toString('utf8'));
    const profile = resolveManifestRuntimeProfile(manifest, { agentName: agent.ref, profileName: record.profile || undefined });
    const llm = resolveLlmRuntimeAdmissionContext({ runtime: record.runtime || 'podman', manifest, profileConfig: profile.profileConfig, agentName: agent.ref.split('/')[1], alias: record.alias, env: process.env });
    return admitManifestRuntimeCapabilities(manifest, {
        manifestPath: agent.manifestPath, manifestBytes: bytes, agentId: agent.ref,
        profileName: profile.resolvedProfileName, profileConfig: profile.profileConfig, network: profile.network, runtime: record.runtime || 'podman',
        catalogPolicy: llm.catalogPolicy, catalogIdentity: llm.catalogIdentity,
        instanceKey: record.key || agent.ref, alias: record.alias || '',
        hardwareAdmission: 'metadata', hardwareContext: context,
    });
}

export function buildHardwareLimitsState({ context, installed, registry, routing = {}, metrics = null, admit = defaultAdmission, readApplied = readAppliedObservation }) {
    const entries = new Map(installed.map((agent) => [agent.ref, agent]));
    for (const ref of context.overrides?.keys() || []) if (!entries.has(ref)) entries.set(ref, { ref, orphaned: true });
    const agents = [];
    for (const agent of entries.values()) {
        let admission = null;
        let declared = {};
        if (!agent.orphaned) {
            try {
                declared = admit(agent, {}, { ...context, overrides: new Map() }).descriptor?.runtimePolicy?.resources || {};
                admission = admit(agent, {}, context);
            } catch (_) {}
        }
        const containers = [];
        for (const [key, record] of Object.entries(registry)) {
            if (record?.type !== 'agent' || `${record.repoName}/${record.agentName}` !== agent.ref) continue;
            const route = Object.values(routing.routes || {}).find((value) => value?.container === key);
            const projection = route?.hardwareAvailability;
            let problem = null;
            if (projection && projection.key === key && projection.instanceId === record.instanceId && projection.enableGeneration === record.enableGeneration) {
                try { problem = validateHardwareOutcome(projection.problem); } catch (_) {}
            }
            let desired = null;
            try { desired = admit(agent, { ...record, key }, context); } catch (_) {}
            const observed = readApplied(key, record.containerId);
            const matchingObservation = observed && observed.instanceId === record.instanceId && observed.enableGeneration === record.enableGeneration ? observed : null;
            const runtime = metrics?.runtimes?.find((value) => value.containerName === key);
            const ready = runtime?.state?.ready === true;
            const running = runtime?.state?.running === true;
            const availability = problem?.state || (projection || runtime?.state?.status === 'failed' ? 'failed' : ready ? 'ready' : running ? 'starting' : 'stopped');
            const limitsState = projection ? 'unavailable' : !running ? 'unavailable' : matchingObservation && matchingObservation.limitsHash === hardwareLimitsHashOf(desired?.descriptor) ? 'applied' : 'pending';
            containers.push({
                key, alias: record.alias || null, instanceId: record.instanceId || null, enableGeneration: record.enableGeneration || null,
                availability, limitsState, problem, ...(runtime?.limits ? { limits: runtime.limits } : {}),
                effective: desired?.descriptor?.hardwareResolved || desired?.descriptor?.hardwarePlacement?.expected || {},
                usage: runtime?.metrics?.available ? { cpuPercent: runtime.metrics.cpuPercent, memoryBytes: runtime.metrics.memoryBytes } : null,
            });
        }
        agents.push({ ref: agent.ref, configured: context.overrides?.get(agent.ref) || {}, declared, effective: admission?.descriptor?.hardwarePlacement?.expected || {}, containers, ...(agent.orphaned ? { orphaned: true } : {}) });
    }
    return {
        ok: true, token: context.storeToken || null,
        gate: { state: context.gate, prepared: context.prepared === true, backendReady: context.backendReady === true, controllers: context.controllers || [] },
        envelope: context.envelope || null, gpu: context.gpu || { eligible: false, mode: 'unavailable', assurance: 'best-effort', reason: 'GPU sharing is not qualified in this Box.' },
        help: HARDWARE_HELP, agents: agents.sort((a, b) => a.ref.localeCompare(b.ref)),
    };
}

export function hardwareHttpError(error) {
    const hardwareOutcome = findHardwareOutcome(error);
    if (hardwareOutcome) return { status: hardwareOutcome.state === 'blocked' ? 424 : 422, body: { ok: false, error: hardwareOutcome.code, message: hardwareOutcome.state === 'blocked' ? hardwareOutcome.rootCause.reason : hardwareOutcome.reason, fix: hardwareOutcome.rootCause.fix, hardwareOutcome } };
    const allowed = new Set(['not_in_box', 'invalid_json', 'invalid_limits', 'unknown_action', 'unknown_agent', 'unknown_container', 'revision_conflict', 'identity_changed', 'identity_unrepresentable', 'store_busy', 'hardware_limits_transition', 'apply_in_progress', 'apply_timeout', 'hardware_cleanup_failed', 'apply_recovery_required', 'hardware_limits_off', 'controller_unavailable', 'gpu_sharing_unavailable', 'image_preparation_required', 'exceeds_envelope', 'store_unreadable', 'audit_pending']);
    const code = allowed.has(error?.code) ? error.code : 'store_unreadable';
    return { status: Number.isInteger(error?.status) ? error.status : 503, body: { ok: false, error: code, message: allowed.has(error?.code) ? String(error.message).slice(0, 2048) : 'Hardware limits are unavailable. Inspect host hardware status.', ...(error?.committed === true ? { committed: true, token: error.token } : {}) } };
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', (chunk) => {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += bytes.length;
            if (size > MAX_REQUEST_BYTES) reject(new HardwareStoreError('Request exceeds 16 KiB.', { code: 'invalid_limits', status: 400 }));
            else chunks.push(bytes);
        });
        req.on('end', () => { try { resolve(parseLimitsRequestBody(Buffer.concat(chunks))); } catch (error) { reject(error); } });
        req.on('error', reject);
        req.on('aborted', () => reject(new Error('request aborted')));
    });
}

export async function handleHardwareLimitsRoutes(req, res, parsedUrl, {
    ensureAdmin, verifyMutation, getContext = defaultContext, getInstalled = installedAgents,
    getRegistry = readAgentRegistrySnapshot, getRouting = readRoutingConfig,
    getMetrics = () => workspaceMetricsMonitor.latest, apply = runHardwareLimitsApplyWorker,
    set = setAgentLimits, clear = clearAgentLimits, admit = defaultAdmission, verifyLease = () => true,
    readSelection = null,
} = {}) {
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
    if (hasHardwareBearer(req)) { send(403, { ok: false, error: 'agent_forbidden' }); return true; }
    const method = String(req.method || 'GET').toUpperCase();
    if (!['GET', 'POST'].includes(method)) { send(405, { ok: false, error: 'method_not_allowed' }); return true; }
    if (typeof ensureAdmin !== 'function' || !await ensureAdmin(req, res, parsedUrl)) return true;
    if (method === 'POST') {
        const decision = typeof verifyMutation === 'function' ? await verifyMutation(req) : { ok: false };
        if (!decision.ok) { send(403, { ok: false, error: String(decision.code || 'csrf_invalid').toLowerCase() }); return true; }
    }
    try {
        const body = method === 'POST' ? validateHardwareRequest(await readBody(req)) : null;
        const context = getContext({ refreshBackend: method === 'POST' });
        const installed = getInstalled();
        const registry = getRegistry();
        const state = () => ({ ...buildHardwareLimitsState({ context: getContext(), installed, registry: getRegistry(), routing: getRouting(), metrics: getMetrics(), admit }), apply: hardwareApplyFlight() });
        if (method === 'GET') {
            const result = state();
            if (context.storeState === 'unreadable') send(503, { ...result, ok: false, error: 'store_unreadable', message: context.storeDetail || 'The hardware store is unreadable.' });
            else send(200, result);
            return true;
        }
        if (!verifyLease()) fail('identity_changed', 'The routing generation changed before mutation.', 409);
        if (!context.paths || context.gate !== 'on') fail('hardware_limits_off', 'On the host run PLOINKY_BOX_HARDWARE_LIMITS=on ploinky restart.', 409);
        assertPolicyWritesAllowed({ paths: context.paths });
        const actor = { id: String(req.user?.id || '').slice(0, 256), name: String(req.user?.username || req.user?.name || '').slice(0, 256) };
        const authority = body.action === 'apply' && readSelection ? createHardwareApplyAuthority({ readSelection, verifyInitial: verifyLease }) : null;
        const authorize = () => {
            const signed = req.session?._jwtPayload;
            if ((req.session?.expiresAt && Date.now() >= req.session.expiresAt) || (signed?.exp && Date.now() / 1000 >= signed.exp)
                || isSessionRevoked({ sid: signed?.sid || req.sessionId, jti: signed?.jti })) return false;
            return (authority ? authority.isCurrent() : verifyLease() === true) && verifyMutation(req)?.ok === true;
        };
        if (body.action === 'apply') {
            const result = await apply({ expectedToken: body.expectedToken, containers: body.containers }, {
                onOwnedSelection: (receipt) => authority?.accept(receipt) === true,
                authorize: async () => {
                    if (!authorize()) return false;
                    const silentResponse = { writeHead() {}, end() {} };
                    return await ensureAdmin(req, silentResponse, parsedUrl) === true && authorize();
                },
            });
            send(result?.status || 200, { ok: result?.ok !== false, ...result });
        } else {
            const capabilities = { gate: context.gate, controllers: context.backendReady ? context.controllers : [], gpu: context.gpu };
            const result = body.action === 'set_agent_limits'
                ? set({ paths: context.paths, identity: context.identity, expectedToken: body.expectedToken, agentRef: body.agentRef, limits: body.limits, installedRefs: new Set(installed.map((agent) => agent.ref)), capabilities, envelope: context.envelope, actor, beforeCommit: authorize })
                : clear({ paths: context.paths, identity: context.identity, expectedToken: body.expectedToken, agentRef: body.agentRef, actor, beforeCommit: authorize });
            send(200, { ...state(), token: result.token, committed: result.committed, affectedInstances: Object.entries(registry).filter(([, record]) => record?.type === 'agent' && `${record.repoName}/${record.agentName}` === body.agentRef).map(([key]) => key) });
        }
    } catch (error) {
        const response = hardwareHttpError(error);
        send(response.status, response.body);
    }
    return true;
}
