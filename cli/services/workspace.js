import fs from 'fs';

function resolveWorkspaceRoot() {
    return process.env.PLOINKY_WORKSPACE_ROOT || process.cwd();
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
    } catch (_) {
        return {};
    }
}

export function saveAgents(map) {
    ensureDirs();
    try {
        fs.writeFileSync(resolveAgentsFile(), JSON.stringify(map || {}, null, 2));
    } catch (_) {}
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
    saveAgents(map);
}
