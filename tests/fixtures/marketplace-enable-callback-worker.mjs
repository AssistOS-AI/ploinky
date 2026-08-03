import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { parentPort, workerData } from 'node:worker_threads';

const script = String.raw`
const http = require('node:http');
const request = http.get(process.argv[1], (response) => {
    const chunks = [];
    response.on('data', (chunk) => chunks.push(chunk));
    response.on('end', () => {
        process.stdout.write(Buffer.concat(chunks).toString('utf8'));
    });
});
request.setTimeout(1000, () => request.destroy(new Error('callback timed out')));
request.on('error', (error) => {
    process.stderr.write(error.message);
    process.exitCode = 1;
});
`;

const callback = spawnSync(process.execPath, ['-e', script, String(workerData?.agentRef || '')], {
    encoding: 'utf8',
    timeout: 2_000,
});

if (callback.status === 0 && callback.stdout === 'router-responsive') {
    parentPort?.postMessage({
        ok: true,
        result: { callback: callback.stdout, mode: workerData?.mode },
    });
} else {
    parentPort?.postMessage({
        ok: false,
        error: {
            code: 'CALLBACK_FAILED',
            message: String(callback.stderr || callback.error?.message || 'callback failed'),
        },
    });
}
