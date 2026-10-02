// A worker thread that records one MPS launch owner and keeps its operation
// live until told to stop (the Router runs Apply and Marketplace enable in
// worker threads, each with its own module instance of mpsInventory).
import { parentPort } from 'node:worker_threads';
import { mpsLaunchOwner, mpsOwnerState } from '../../cli/sandbox/hardwareLimits/mpsInventory.mjs';

const owner = mpsLaunchOwner();
parentPort.postMessage({ owner, selfView: mpsOwnerState(owner) });
parentPort.once('message', () => parentPort.close());
