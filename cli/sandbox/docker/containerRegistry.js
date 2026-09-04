import { execFile, execFileSync } from 'child_process';
import { promisify } from 'node:util';
import path from 'path';
import { debugLog } from '../../utils/utils.js';
import { probeContainerRuntime, loadAgentsMap } from './common.js';

const execFileAsync = promisify(execFile);
const LIST_ARGS = Object.freeze(['ps', '--format', '{{.Names}}']);
const LIST_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const INSPECT_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

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

function parseLiveContainerNames(stdout) {
    return String(stdout || '')
        .split(/\r?\n/)
        .map((name) => name.trim().replace(/^\//, ''))
        .filter((name) => name.startsWith('ploinky_'));
}

function projectInspectedContainer(data, fallbackName = '') {
    if (!data || typeof data !== 'object') return null;
    const containerName = String(data.Name || fallbackName || '').replace(/^\//, '');
    if (!containerName) return null;
    const mounts = Array.isArray(data.Mounts) ? data.Mounts : [];
    const envPairs = Array.isArray(data.Config?.Env) ? data.Config.Env : [];
    const env = envPairs.map((entry) => {
        const value = String(entry || '');
        const idx = value.indexOf('=');
        const key = idx === -1 ? value : value.slice(0, idx);
        return { name: key, value: idx === -1 ? '' : value.slice(idx + 1) };
    });
    let agentName = env.find((entry) => entry.name === 'AGENT_NAME')?.value || '-';
    const { repoName, agentName: mountAgent } = parseAgentInfoFromMounts(mounts);
    if (agentName === '-' && mountAgent && mountAgent !== '-') agentName = mountAgent;
    return {
        containerName,
        containerId: String(data.Id || '').trim().toLowerCase(),
        agentName,
        repoName,
        containerImage: data.Config?.Image || '-',
        createdAt: data.Created || '-',
        projectPath: data.Config?.WorkingDir || '-',
        state: {
            status: data.State?.Status || '-',
            running: Boolean(data.State?.Running),
            pid: data.State?.Pid || 0,
        },
        config: {
            binds: mounts.map((mount) => ({ source: mount.Source, target: mount.Destination })),
            env,
            ports: formatPortBindings(data.NetworkSettings?.Ports || {}),
        },
    };
}

function projectInspectOutput(stdout, names) {
    const parsed = JSON.parse(String(stdout || ''));
    if (!Array.isArray(parsed)) return [];
    return parsed
        .map((data, index) => projectInspectedContainer(data, names[index]))
        .filter(Boolean);
}

function collectLiveAgentContainers() {
    const runtime = probeContainerRuntime();
    if (!runtime) return [];
    try {
        const names = parseLiveContainerNames(execFileSync(runtime, LIST_ARGS, {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            maxBuffer: LIST_MAX_BUFFER_BYTES,
        }));
        if (!names.length) return [];
        const stdout = execFileSync(runtime, ['inspect', ...names], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            maxBuffer: INSPECT_MAX_BUFFER_BYTES,
        });
        return projectInspectOutput(stdout, names);
    } catch (_) {
        return [];
    }
}

async function collectLiveAgentContainersAsync() {
    const runtime = probeContainerRuntime();
    if (!runtime) return [];
    let names = [];
    try {
        const { stdout = '' } = await execFileAsync(runtime, LIST_ARGS, {
            encoding: 'utf8',
            maxBuffer: LIST_MAX_BUFFER_BYTES,
        });
        names = parseLiveContainerNames(stdout);
    } catch (_) {
        return [];
    }
    if (!names.length) return [];

    try {
        const { stdout = '' } = await execFileAsync(runtime, ['inspect', ...names], {
            encoding: 'utf8',
            maxBuffer: INSPECT_MAX_BUFFER_BYTES,
        });
        return projectInspectOutput(stdout, names);
    } catch (error) {
        debugLog(`collectLiveAgentContainersAsync: ${error?.message || error}`);
        return [];
    }
}

export {
    collectLiveAgentContainers,
    collectLiveAgentContainersAsync,
    formatPortBindings,
    getAgentsRegistry,
    parseAgentInfoFromMounts
};
