import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { parentPort, workerData } from 'node:worker_threads';

// A real child survives Worker.terminate(); this fixture exercises that
// boundary without starting an engine, agent, or network connection.
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
child.unref();
fs.writeFileSync(workerData.agentRef, String(child.pid));
parentPort.postMessage({ type: 'workspace-lease', token: 'child-worker-lease' });
setInterval(() => {}, 1000);
