import { execSync } from 'child_process';
import path from 'path';
import { debugLog } from '../../utils/utils.js';
import { probeContainerRuntime, loadAgentsMap } from './common.js';

function parseAgentInfoFromMounts(mounts = []) {
    let repoName = '-';
    let agentName = '-';
    for (const mount of mounts) {
        if (mount.Destination === '/code' && mount.Source) {
            const parts = mount.Source.split(path.sep).filter(Boolean);
            const reposIdx = parts.lastIndexOf('repos');
            if (reposIdx !== -1 && reposIdx + 2 < parts.length) {
                repoName = parts[reposIdx + 1];
                agentName = parts[reposIdx + 2];
                break;
            }
        }
    }
    return { repoName, agentName };
}

function formatPortBindings(bindings = {}, defaultContainerPort = '') {
    const results = [];
    for (const [containerSpec, hostEntries] of Object.entries(bindings || {})) {
        const containerPort = parseInt(containerSpec, 10) || parseInt(containerSpec.split('/')[0], 10) || defaultContainerPort;
        if (Array.isArray(hostEntries)) {
            for (const entry of hostEntries) {
                if (!entry) continue;
                results.push({
                    hostIp: entry.HostIp || '127.0.0.1',
                    hostPort: entry.HostPort || '',
                    containerPort
                });
            }
        }
    }
    return results;
}

function getAgentsRegistry() {
    return loadAgentsMap();
}

function collectLiveAgentContainers() {
    const runtime = probeContainerRuntime();
    if (!runtime) return [];
    let names = [];
    try {
        const raw = execSync(`${runtime} ps --format "{{.Names}}"`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
        if (raw) {
            names = raw.split(/\n+/).map((n) => n.trim()).filter((n) => n.startsWith('ploinky_'));
        }
    } catch (_) {
        return [];
    }
    const results = [];
    for (const name of names) {
        try {
            const inspectRaw = execSync(`${runtime} inspect ${name}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
            const parsed = JSON.parse(inspectRaw);
            if (!Array.isArray(parsed) || !parsed.length) continue;
            const data = parsed[0];
            const mounts = data.Mounts || [];
            const envPairs = Array.isArray(data.Config?.Env) ? data.Config.Env : [];
            const env = envPairs.map((entry) => {
                const idx = entry.indexOf('=');
                const key = idx === -1 ? entry : entry.slice(0, idx);
                return { name: key, value: idx === -1 ? '' : entry.slice(idx + 1) };
            });
            let agentName = env.find((e) => e.name === 'AGENT_NAME')?.value || '-';
            const { repoName, agentName: mountAgent } = parseAgentInfoFromMounts(mounts);
            if (agentName === '-' && mountAgent && mountAgent !== '-') {
                agentName = mountAgent;
            }
            const ports = formatPortBindings(data.NetworkSettings?.Ports || {});
            results.push({
                containerName: name,
                agentName,
                repoName,
                containerImage: data.Config?.Image || '-',
                createdAt: data.Created || '-',
                projectPath: data.Config?.WorkingDir || '-',
                state: {
                    status: data.State?.Status || '-',
                    running: Boolean(data.State?.Running),
                    pid: data.State?.Pid || 0
                },
                config: {
                    binds: mounts.map((m) => ({ source: m.Source, target: m.Destination })),
                    env,
                    ports
                }
            });
        } catch (error) {
            debugLog(`collectLiveAgentContainers: ${name} ${error?.message || error}`);
        }
    }
    return results;
}

export {
    collectLiveAgentContainers,
    formatPortBindings,
    getAgentsRegistry,
    parseAgentInfoFromMounts
};
