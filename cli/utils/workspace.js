import fs from 'fs';
import path from 'path';
import { PLOINKY_DIR } from './config.js';
import { inactivateEdgeRoutingGeneration } from '../sandbox/edgeGeneration.js';

function resolveWorkspaceRoot() {
    const explicitRoot = String(process.env.PLOINKY_WORKSPACE_ROOT || '').trim();
    if (explicitRoot) {
        return path.resolve(explicitRoot);
    }
    return path.dirname(PLOINKY_DIR);
}

function resolvePloinkyDir() {
    return `${resolveWorkspaceRoot()}/.ploinky`;
}

function resolveAgentsFile() {
    return `${resolvePloinkyDir()}/agents.json`;
}

function ensureDirs() {
    try {
        fs.mkdirSync(resolvePloinkyDir(), { recursive: true });
    } catch (_) {}
}

export function loadAgents() {
    ensureDirs();
    try {
        const agentsFile = resolveAgentsFile();
        if (!fs.existsSync(agentsFile)) return {};
        const data = fs.readFileSync(agentsFile, 'utf8');
        return JSON.parse(data || '{}') || {};
    } catch (error) {
        const wrapped = new Error(`agents registry is unreadable or corrupt: ${error?.message || error}`);
        wrapped.code = 'EDGE_GENERATION_INVALID';
        throw wrapped;
    }
}

export function saveAgents(map, {
    coordinate = true,
    applyLockCapability,
} = {}) {
    ensureDirs();
    const target = resolveAgentsFile();
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(map || {}, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, target);
    if (coordinate) {
        inactivateEdgeRoutingGeneration('agents-candidate-change', {
            workspaceRoot: resolveWorkspaceRoot(),
            applyLockCapability,
        });
    }
}

export function listAgents() {
    return Object.values(loadAgents());
}

export function getAgentRecord(containerName) {
    const map = loadAgents();
    return map[containerName] || null;
}

export function upsertAgent(containerName, record) {
    const map = loadAgents();
    map[containerName] = { ...(record || {}) };
    saveAgents(map);
}

export function removeAgent(containerName) {
    const map = loadAgents();
    delete map[containerName];
    saveAgents(map);
}

export function getConfig() {
    const map = loadAgents();
    return map._config || {};
}

export function setConfig(cfg) {
    const map = loadAgents();
    map._config = cfg || {};
    // _config is not an edge authorization source. Persisting SSO/sandbox
    // preferences must not take the Router offline indefinitely.
    saveAgents(map, { coordinate: false });
}
