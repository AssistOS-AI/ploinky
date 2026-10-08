// Stand-in identity thread for the thread-client tests (createCodeIdentityThread
// with `threadUrl`). `workerData.roots[0]` names what request 1 does:
//   stall  replies only after 1500 ms
//   exit   ends the thread with code 3
//   throw  throws from the message handler (an uncaught thread error)
// Every other request is answered at once, after a reply that carries the
// previous request's id (a stale reply the client must drop). The identity
// echoes what the request carried.
import { parentPort, workerData } from 'node:worker_threads';

const behaviour = workerData.roots[0];

parentPort.on('message', (request) => {
    const { id } = request;
    if (id === 1 && behaviour === 'stall') {
        setTimeout(() => parentPort.postMessage({ id, ok: true, identity: 'late', measures: [] }), 1500);
        return;
    }
    if (id === 1 && behaviour === 'exit') process.exit(3);
    if (id === 1 && behaviour === 'throw') throw new Error('thread boom');
    if (id > 1) parentPort.postMessage({ id: id - 1, ok: true, identity: 'stale', measures: [] });
    const echo = { poolName: request.poolName ?? null, command: request.command ?? null, extraFiles: request.extraFiles };
    parentPort.postMessage({ id, ok: true, identity: `fresh-${id}:${JSON.stringify(echo)}`, measures: [] });
});
