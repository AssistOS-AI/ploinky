import { parentPort, workerData } from 'worker_threads';

import { runHealthProbes } from '../sandbox/docker/healthProbes.js';

export function serializeProbeError(error) {
    return {
        error: error?.message || String(error || 'unknown error'),
        code: typeof error?.code === 'string' ? error.code : null,
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
        parentPort?.postMessage({
            status: 'error',
            ...serializeProbeError(error),
        });
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
