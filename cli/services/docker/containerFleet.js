import { execSync } from 'child_process';
import { debugLog } from '../utils.js';
import { loadAgents } from '../workspace.js';
import {
    containerExists,
    getRuntime,
    isContainerRunning,
    isSandboxRuntime,
    loadAgentsMap,
    probeContainerRuntime
} from './common.js';
import { clearLivenessState } from './healthProbes.js';
import { stopBwrapProcesses, isBwrapProcessRunning } from '../bwrap/bwrapFleet.js';

function chunkArray(list, size = 8) {
    const chunks = [];
    if (!Array.isArray(list) || size <= 0) return chunks;
    for (let i = 0; i < list.length; i += size) {
        chunks.push(list.slice(i, i + size));
    }
    return chunks;
}

function gracefulStopContainer(name, { prefix = '[destroy]' } = {}) {
    const exists = containerExists(name);
    if (!exists) return false;

    const log = (msg) => console.log(`${prefix} ${msg}`);
    if (!isContainerRunning(name)) {
        log(`${name} already stopped.`);
        return true;
    }

    try {
        const runtime = getRuntime();
        log(`Sending SIGTERM to ${name}...`);
        execSync(`${runtime} kill --signal SIGTERM ${name}`, { stdio: 'ignore' });
    } catch (e) {
        debugLog(`gracefulStopContainer SIGTERM ${name}: ${e?.message || e}`);
    }
    return true;
}

function waitForContainers(names, timeoutSec = 5) {
    const deadline = Date.now() + timeoutSec * 1000;
    while (Date.now() < deadline) {
        const stillRunning = names.filter((name) => isContainerRunning(name));
        if (!stillRunning.length) return [];
        try { execSync('sleep 1', { stdio: 'ignore' }); } catch (_) { }
    }
    return names.filter((name) => isContainerRunning(name));
}

function forceStopContainers(names, { prefix } = {}) {
    if (!Array.isArray(names) || !names.length) return;
    const runtime = getRuntime();
    for (const chunk of chunkArray(names)) {
        try {
            console.log(`${prefix} Forcing kill for ${chunk.join(', ')}...`);
            execSync(`${runtime} kill ${chunk.join(' ')}`, { stdio: 'ignore' });
        } catch (e) {
            debugLog(`forceStopContainers kill ${chunk.join(', ')}: ${e?.message || e}`);
            for (const name of chunk) {
                try {
                    console.log(`${prefix} Forcing kill for ${name}...`);
                    execSync(`${runtime} kill ${name}`, { stdio: 'ignore' });
                } catch (err) {
                    debugLog(`forceStopContainers (single) kill ${name}: ${err?.message || err}`);
                }
            }
        }
    }
}

function getContainerCandidates(name, rec) {
    // Registry keys are the exact runtime identifiers. Expanding an alias into
    // a derived canonical name can stop or delete a different current runtime
    // without any ownership proof.
    return name ? [name] : [];
}

function stopConfiguredAgents({ fast = false } = {}) {
    const agents = loadAgents();
    const entries = Object.entries(agents || {})
        .filter(([name, rec]) => rec && (rec.type === 'agent' || rec.type === 'agentCore') && typeof name === 'string' && !name.startsWith('_'));

    // Handle sandbox (bwrap/seatbelt) agents first
    const bwrapStopped = [];
    const bwrapEntries = [];
    const containerEntries = [];
    for (const [name, rec] of entries) {
        if (isSandboxRuntime(rec?.runtime)) {
            const agentName = rec.agentName || name;
            if (isBwrapProcessRunning(name)) {
                bwrapEntries.push({ name, runtimeKey: name, agentName, runtime: rec.runtime });
            } else {
                console.log(`[stop] ${agentName}: no running ${rec.runtime} process found.`);
            }
        } else {
            containerEntries.push([name, rec]);
        }
    }
    if (bwrapEntries.length) {
        const stoppedSandboxRuntimes = new Set(stopBwrapProcesses(bwrapEntries.map((entry) => entry.runtimeKey), {
            timeout: fast ? 100 : 5000
        }));
        for (const entry of bwrapEntries) {
            if (!stoppedSandboxRuntimes.has(entry.runtimeKey)) continue;
            console.log(`[stop] Stopped ${entry.agentName} (${entry.runtime})`);
            bwrapStopped.push(entry.name);
        }
    }

    // Handle container agents
    const candidateSet = new Set();
    for (const [name, rec] of containerEntries) {
        const candidates = getContainerCandidates(name, rec).filter((candidate) => candidate && containerExists(candidate));
        if (!candidates.length) {
            const label = rec?.agentName ? `${rec.agentName}` : name;
            console.log(`[stop] ${label}: no running container found.`);
        }
        for (const candidate of candidates) candidateSet.add(candidate);
    }

    const allCandidates = Array.from(candidateSet);
    if (allCandidates.length) {
        allCandidates.forEach((name) => gracefulStopContainer(name, { prefix: '[stop]' }));
        const remaining = waitForContainers(allCandidates, 5);
        if (remaining.length) {
            forceStopContainers(remaining, { prefix: '[stop]' });
            waitForContainers(remaining, 2);
        }
    }

    const stoppedContainers = allCandidates.filter((name) => !isContainerRunning(name));
    stoppedContainers.forEach((name) => {
        console.log(`[stop] Stopped ${name}`);
        clearLivenessState(name);
    });
    return [...bwrapStopped, ...stoppedContainers];
}

function stopAndRemoveMany(names, { fast = false } = {}) {
    if (!Array.isArray(names) || !names.length) return [];

    const agents = loadAgents();

    // Handle sandbox (bwrap/seatbelt) agents first
    const bwrapEntries = [];
    const containerNames = [];
    for (const agentName of names) {
        if (!agentName) continue;
        const rec = agents ? agents[agentName] : null;
        if (isSandboxRuntime(rec?.runtime)) {
            bwrapEntries.push({ agentName, runtimeKey: agentName });
            continue;
        }
        containerNames.push(agentName);
    }
    if (bwrapEntries.length) {
        stopBwrapProcesses(bwrapEntries.map((entry) => entry.runtimeKey), {
            timeout: fast ? 100 : 5000
        });
    }
    const bwrapRemoved = bwrapEntries.map((entry) => entry.agentName);

    const removalSet = new Set();
    const runningSet = new Set();

    for (const agentName of containerNames) {
        if (!agentName) continue;
        const rec = agents ? agents[agentName] : null;
        const candidates = getContainerCandidates(agentName, rec);
        for (const candidate of candidates) {
            if (!candidate || !containerExists(candidate)) continue;
            removalSet.add(candidate);
            if (isContainerRunning(candidate)) {
                runningSet.add(candidate);
            }
        }
    }

    if (!removalSet.size) return bwrapRemoved;

    const prefix = fast ? '[destroy-fast]' : '[destroy]';
    const runningList = Array.from(runningSet);
    const runtime = getRuntime();
    if (runningList.length) {
        console.log(`${prefix} Sending SIGTERM to ${runningList.length} container(s)...`);
        for (const chunk of chunkArray(runningList)) {
            try {
                execSync(`${runtime} kill --signal SIGTERM ${chunk.join(' ')}`, { stdio: 'ignore' });
            } catch (e) {
                debugLog(`batch SIGTERM failed for ${chunk.join(', ')}: ${e?.message || e}`);
                for (const name of chunk) {
                    gracefulStopContainer(name, { prefix });
                }
            }
        }
    }

    const waitSeconds = fast ? 0.1 : 5;
    const stillRunning = runningList.length ? waitForContainers(runningList, waitSeconds) : [];
    if (stillRunning.length) {
        forceStopContainers(stillRunning, { prefix });
    }

    const removalList = Array.from(removalSet);
    const removed = [];
    for (const chunk of chunkArray(removalList)) {
        try {
            console.log(`${prefix} Removing containers: ${chunk.join(', ')}`);
            execSync(`${runtime} rm -f ${chunk.join(' ')}`, { stdio: 'ignore' });
            chunk.forEach((name) => {
                console.log(`${prefix} ✓ removed ${name}`);
                clearLivenessState(name);
                removed.push(name);
            });
        } catch (e) {
            debugLog(`batch rm failed for ${chunk.join(', ')}: ${e?.message || e}`);
            for (const name of chunk) {
                try {
                    console.log(`${prefix} Removing container: ${name}`);
                    execSync(`${runtime} rm -f ${name}`, { stdio: 'ignore' });
                    console.log(`${prefix} ✓ removed ${name}`);
                    clearLivenessState(name);
                    removed.push(name);
                } catch (err) {
                    console.log(`${prefix} rm failed for ${name}: ${err?.message || err}`);
                }
            }
        }
    }

    return [...bwrapRemoved, ...removed];
}

function stopAndRemove(name, fast = false) {
    if (!name) return [];
    return stopAndRemoveMany([name], { fast }) || [];
}

function listAllContainerNames() {
    const runtime = probeContainerRuntime();
    if (!runtime) return [];
    try {
        const out = execSync(`${runtime} ps -a --format "{{.Names}}"`, { stdio: 'pipe' }).toString().trim();
        return out ? out.split(/\n+/).filter(Boolean) : [];
    } catch (e) {
        debugLog(`listAllContainerNames error: ${e?.message || e}`);
        return [];
    }
}

function destroyAllPloinky({ fast = false } = {}) {
    const names = listAllContainerNames().filter((n) => n.startsWith('ploinky_'));
    stopAndRemoveMany(names, { fast });
    return names.length;
}

function destroyWorkspaceContainers({ fast = false } = {}) {
    const agents = loadAgentsMap();
    const names = [];
    for (const [name, rec] of Object.entries(agents || {})) {
        if (!rec || typeof name !== 'string' || name.startsWith('_')) continue;
        if (rec.type === 'agent' || rec.type === 'agentCore') {
            names.push(name);
        }
    }
    // stopAndRemoveMany now handles bwrap agents internally
    return stopAndRemoveMany(names, { fast });
}

const SESSION = new Set();

function addSessionContainer(name) {
    if (name) {
        try { SESSION.add(name); } catch (_) { }
    }
}

function cleanupSessionSet() {
    const list = Array.from(SESSION);
    stopAndRemoveMany(list);
    SESSION.clear();
    return list.length;
}

export {
    addSessionContainer,
    cleanupSessionSet,
    destroyAllPloinky,
    destroyWorkspaceContainers,
    forceStopContainers,
    getContainerCandidates,
    gracefulStopContainer,
    listAllContainerNames,
    stopAndRemove,
    stopAndRemoveMany,
    stopConfiguredAgents,
    waitForContainers
};
