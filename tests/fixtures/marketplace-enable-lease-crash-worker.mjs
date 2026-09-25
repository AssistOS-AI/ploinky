import fs from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';

import { withHeldOrAcquiredWorkspaceMutationLease } from '../../cli/utils/runtime/maintenanceLocks.js';

// Takes the real workspace mutation lease exactly as the Marketplace enable
// worker does, reports its token, then dies abnormally while holding it (no
// result message, no release). The workspace comes from the inherited
// PLOINKY_WORKSPACE_ROOT, which the test points at a scratch directory.
await withHeldOrAcquiredWorkspaceMutationLease({
    operation: `marketplace-enable:${workerData.operationId}`,
    requireQuiescenceOnOwnerDeath: true,
}, async (lease) => {
    fs.writeFileSync(process.env.PLOINKY_TEST_LEASE_TOKEN_FILE, lease.token);
    parentPort.postMessage({ type: 'workspace-lease', token: lease.token });
    await new Promise(resolve => setTimeout(resolve, 20));
    process.exit(1);
});
