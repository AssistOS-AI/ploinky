// A worker thread that records one MPS launch owner, then releases it when told
// to: the Router runs Apply and Marketplace enable in worker threads, each with
// its own module instance of mpsInventory, and the other threads must see the
// release.
import { parentPort } from 'node:worker_threads';
import { mpsLaunchOwner, mpsOwnerState, releaseMpsLaunchOwner } from '../../cli/sandbox/hardwareLimits/mpsInventory.mjs';

const owner = mpsLaunchOwner();
parentPort.postMessage({ type: 'created', owner, selfView: mpsOwnerState(owner) });
parentPort.on('message', (message) => {
    if (message === 'release') {
        releaseMpsLaunchOwner(owner);
        parentPort.postMessage({ type: 'released', selfView: mpsOwnerState(owner) });
    } else if (message === 'done') parentPort.close();
});
