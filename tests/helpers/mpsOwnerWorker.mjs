// A worker thread that records one MPS launch owner and keeps its operation
// live until told to stop (the Router runs Apply and Marketplace enable in
// worker threads, each with its own module instance of mpsInventory).
import { parentPort } from 'node:worker_threads';
import { mpsLaunchOwner, mpsOwnerState } from '../../cli/sandbox/hardwareLimits/mpsInventory.mjs';

const owner = mpsLaunchOwner();
// Report only after the module graph (this file and the guard it was started
// with) has finished evaluating: a worker stopped while its ES module
// evaluation is still completing asynchronously crashes the process natively.
// The worker then closes its port and exits on its own; the test waits for
// `exit` instead of terminating it.
setImmediate(() => parentPort.postMessage({ type: 'ready', owner, selfView: mpsOwnerState(owner) }));
parentPort.once('message', () => parentPort.close());
