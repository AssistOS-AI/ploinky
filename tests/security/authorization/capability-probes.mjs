/**
 * Retained real-service controls for agents whose common MCP surfaces are not
 * applicable by reviewed capability classification (acceptance/policy.json
 * `capabilities`, r2b_remediation_decisions_codex.md D3/D4). Non-applicability
 * is never represented as tested authorization: each classified agent keeps
 * runtime, readiness, route and access controls that must PASS, and the one
 * administrator 404 is recorded only as corroboration of the absent surface.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { WORKSPACE, assertDenied, command } from './core.mjs';

const source = 'tests/security/authorization/capability-probes.mjs';
const LIVEKIT = '/base-agent-additional-server/liveKitServerAgent/7880';
const SOUL_HEALTH = '/base-agent-additional-server/soul-gateway/7000/healthz/';

const POSITIVE_CONTROLS = Object.freeze({
    'capability:liveKitServerAgent:twirp-route-deny:anonymous': ['capability:liveKitServerAgent:signaling-route:anonymous'],
});

export function capabilityCheckDefinitions(capabilities = []) {
    return capabilities.flatMap(cap => cap.retainedControls.map(id => ({ id, kind: 'live', boundary: 'capability', source: `${source} (${cap.id})`, positiveControlAnyOf: POSITIVE_CONTROLS[id] || null })));
}

/** Non-applicable MCP surfaces the report must list, derived only from the reviewed policy. */
export function nonApplicableRecord(capabilities = []) {
    return capabilities.map(cap => ({ id: cap.id, repo: cap.repo, agent: cap.agent, nonApplicable: [...cap.nonApplicable] })).sort((a, b) => a.id.localeCompare(b.id));
}

const defaultInspect = (boxId, container) => JSON.parse(command('podman', ['exec', boxId, 'podman', 'inspect', container]))[0];

export async function runCapabilityProbes(ctx, {
    capabilities = [],
    readRouting = async () => JSON.parse(await fs.readFile(path.join(WORKSPACE, '.ploinky', 'routing.json'), 'utf8')),
    readManifest = async (repo, agent) => JSON.parse(await fs.readFile(path.join(WORKSPACE, '.ploinky', 'repos', repo, agent, 'manifest.json'), 'utf8')),
    inspectContainer = async (container) => defaultInspect(ctx.report.deployment.boxId, container),
} = {}) {
    const ids = new Set(capabilities.flatMap(cap => cap.retainedControls));
    const known = new Set(['capability:liveKitServerAgent:no-primary-port', 'capability:liveKitServerAgent:runtime-image', 'capability:liveKitServerAgent:signaling-route:anonymous', 'capability:liveKitServerAgent:twirp-route-deny:anonymous', 'capability:liveKitServerAgent:mcp-absent-corroboration:admin', 'capability:soul-gateway:health:anonymous']);
    for (const id of ids) assert.ok(known.has(id), `No probe implements retained control ${id}`);
    let signaling = false;
    if (ids.has('capability:liveKitServerAgent:no-primary-port')) await ctx.check('capability:liveKitServerAgent:no-primary-port', async () => {
        const routing = await readRouting();
        const routes = Object.values(routing?.routes || {}).filter(r => r?.agent === 'liveKitServerAgent');
        assert.equal(routes.length, 1, 'Exactly one LiveKit route must exist (the runtime is enabled)');
        assert.ok(!routes[0].hostPort, 'LiveKit is classified without a primary agent port; a primary port means the contract changed');
    });
    if (ids.has('capability:liveKitServerAgent:runtime-image')) await ctx.check('capability:liveKitServerAgent:runtime-image', async () => {
        const container = ctx.report.deployment?.classifiedContainers?.['AchillesIDE/liveKitServerAgent'];
        assert.match(String(container || ''), /^ploinky_AchillesIDE_liveKitServerAgent_[A-Za-z0-9_.-]+$/, 'Captured LiveKit container is required');
        const manifest = await readManifest('AchillesIDE', 'liveKitServerAgent');
        const inspected = await inspectContainer(container);
        assert.equal(inspected?.State?.Running, true, 'LiveKit runtime must be running');
        assert.equal(String(inspected?.Config?.Image || inspected?.ImageName || ''), manifest.container, 'LiveKit runtime must use the pinned manifest image');
    });
    if (ids.has('capability:liveKitServerAgent:signaling-route:anonymous')) await ctx.check('capability:liveKitServerAgent:signaling-route:anonymous', async () => {
        const response = await ctx.request('anonymous', { path: `${LIVEKIT}/`, headers: { accept: '*/*' } });
        assert.equal(response.status, 200, 'The declared public 7880 signaling route must reach the LiveKit service');
        assert.ok(!(response.json && (response.json.error || response.json.ok === false)), 'An error body is not a working signaling route');
        signaling = true;
    });
    if (ids.has('capability:liveKitServerAgent:twirp-route-deny:anonymous')) {
        if (!signaling) ctx.recordGap('capability:liveKitServerAgent:twirp-route-deny:anonymous', 'Signaling positive failed; the Twirp denial cannot be credited.', { kind: 'positive-unavailable', actor: 'anonymous' });
        else await ctx.check('capability:liveKitServerAgent:twirp-route-deny:anonymous', async () => {
            await ctx.guard();
            const response = await ctx.request('anonymous', { method: 'POST', path: `${LIVEKIT}/twirp/livekit.RoomService/ListRooms`, body: {}, proof: false });
            assertDenied(response);
        });
    }
    if (ids.has('capability:liveKitServerAgent:mcp-absent-corroboration:admin')) await ctx.check('capability:liveKitServerAgent:mcp-absent-corroboration:admin', async () => {
        // Corroboration of the classified absent surface only; not an authorization or health result.
        const response = await ctx.request('admin', { method: 'POST', path: '/liveKitServerAgent/mcp', headers: { accept: 'application/json, text/event-stream' },
            body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'authorization-regression', version: '1' } } } });
        assert.equal(response.status, 404, 'The classified LiveKit MCP surface must be absent (404), not unavailable or timing out');
        assert.equal(response.json?.error, 'agent_not_found');
        assert.ok(!response.headers?.['mcp-session-id'], 'No MCP session may be created');
    });
    if (ids.has('capability:soul-gateway:health:anonymous')) await ctx.check('capability:soul-gateway:health:anonymous', async () => {
        const response = await ctx.request('anonymous', { path: SOUL_HEALTH });
        assert.equal(response.status, 200, 'Soul Gateway health must answer');
        assert.equal(response.json?.ok, true);
        assert.equal(response.json?.db, true, 'Soul Gateway health requires a working database');
        assert.ok(Number.isFinite(response.json?.uptimeSeconds));
    });
    ctx.report.capabilityNonApplicable = nonApplicableRecord(capabilities);
}
