import { parentPort, workerData } from 'worker_threads';

import { runHealthProbes } from '../sandbox/docker/healthProbes.js';

async function main() {
    const {
        agentName,
        containerName,
        containerId,
        instanceId,
        enableGeneration,
        manifest,
        runtime,
    } = workerData || {};
    if (!agentName || !containerName) {
        parentPort?.postMessage({ status: 'error', error: 'Missing agent/container data for probe worker.' });
        return;
    }
    try {
        runHealthProbes(agentName, containerName, manifest || {}, {
            runtime,
            containerId,
            instanceId,
            enableGeneration,
        });
        parentPort?.postMessage({ status: 'success' });
    } catch (error) {
        parentPort?.postMessage({
            status: 'error',
            error: error?.message || String(error || 'unknown error')
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
