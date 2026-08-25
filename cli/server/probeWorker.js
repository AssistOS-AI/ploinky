import { parentPort, workerData } from 'worker_threads';

import { runHealthProbes } from '../sandbox/docker/healthProbes.js';

export function serializeProbeError(error) {
    const code = typeof error?.code === 'string' && error.code.trim()
        ? error.code.trim()
        : null;
    return {
        status: 'error',
        error: error?.message || String(error || 'unknown error'),
        ...(code ? { code } : {}),
    };
}

async function main() {
    const { agentName, containerName, manifest } = workerData || {};
    if (!agentName || !containerName) {
        parentPort?.postMessage({ status: 'error', error: 'Missing agent/container data for probe worker.' });
        return;
    }
    try {
        runHealthProbes(agentName, containerName, manifest || {});
        parentPort?.postMessage({ status: 'success' });
    } catch (error) {
        parentPort?.postMessage(serializeProbeError(error));
    }
}

if (parentPort) {
    parentPort.on('message', (msg) => {
        if (msg && msg.type === 'terminate') {
            process.exit(0);
        }
    });
}

await main();
