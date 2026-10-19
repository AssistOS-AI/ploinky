import fs from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';

import { withHeldOrAcquiredWorkspaceMutationLease } from '../../cli/utils/runtime/maintenanceLocks.js';

// Takes the real workspace mutation lease exactly as the Marketplace enable
// worker does, records when it holds it, keeps it for a fixed time and
// releases it normally. The workspace comes from the inherited
// PLOINKY_WORKSPACE_ROOT and the interval log from PLOINKY_TEST_LEASE_LOG,
// which the test points at a scratch directory.
const result = await withHeldOrAcquiredWorkspaceMutationLease({
    operation: `marketplace-enable:${workerData.operationId}`,
    requireQuiescenceOnOwnerDeath: true,
}, async (lease) => {
    parentPort.postMessage({ type: 'workspace-lease', token: lease.token });
    fs.appendFileSync(process.env.PLOINKY_TEST_LEASE_LOG, `${JSON.stringify({ event: 'enter', agent: workerData.agentRef, at: Date.now() })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    fs.appendFileSync(process.env.PLOINKY_TEST_LEASE_LOG, `${JSON.stringify({ event: 'exit', agent: workerData.agentRef, at: Date.now() })}\n`);
    return { agent: workerData.agentRef };
});
parentPort.postMessage({ ok: true, result });
