'use strict';
// Dependency-free fixture service for the native lifecycle runner. It reports
// what the running process itself can observe: its own identity environment,
// the marker the manifest gave it, and whether the runtime lets it read a
// path the runner proved readable from outside the sandbox.
const http = require('node:http');
const fs = require('node:fs');

// LIFECYCLE_FAIL=1 makes the process exit at once. The failed-first-start
// scenario uses it to make one agent's start fail after another agent launched.
if (process.env.LIFECYCLE_FAIL === '1') {
    console.error('lifecycle fixture: forced start failure (LIFECYCLE_FAIL=1)');
    process.exit(3);
}

const port = Number(process.env.PORT);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('LIFECYCLE fixture requires a valid PORT');
    process.exit(2);
}

function readProbe() {
    const target = process.env.LIFECYCLE_PROBE_PATH || '';
    if (!target) return { path: '', readable: null, code: 'NO_PROBE_PATH' };
    try {
        fs.readdirSync(target);
        return { path: target, readable: true, code: null };
    } catch (error) {
        return { path: target, readable: false, code: error && error.code ? error.code : 'UNKNOWN' };
    }
}

const startedAt = new Date().toISOString();
const server = http.createServer((req, res) => {
    const body = JSON.stringify({
        pid: process.pid,
        ppid: process.ppid,
        argv: process.argv,
        cwd: process.cwd(),
        path: process.env.PATH || null,
        startedAt,
        marker: process.env.LIFECYCLE_MARKER || null,
        runtime: process.env.PLOINKY_RUNTIME || null,
        instanceId: process.env.PLOINKY_AGENT_INSTANCE_ID || null,
        enableGeneration: process.env.PLOINKY_AGENT_ENABLE_GENERATION || null,
        probe: readProbe(),
    });
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
});
server.listen(port, '127.0.0.1');
process.on('SIGTERM', () => server.close(() => process.exit(0)));
