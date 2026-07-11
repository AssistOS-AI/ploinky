#!/usr/bin/env node

// The planner protocol owns stdout. Disable optional core debug logging before
// loading the service graph so even an inherited PLOINKY_DEBUG=1 cannot corrupt
// the single JSON response.
process.env.PLOINKY_DEBUG = '';
// Repository preparation predates the planner protocol and still reports
// ordinary branch-fallback progress through console.log(). Keep those
// human-facing messages out of the machine-readable channel. Failures continue
// through the catch boundary below, which owns stderr and the non-zero status.
console.log = () => {};
console.info = () => {};
console.debug = () => {};
console.warn = () => {};
console.error = () => {};
const { createBoxStartPublishPlan } = await import('../cli/services/boxStartPublishPlan.js');

const MAX_REQUEST_BYTES = 1024 * 1024;

async function readRequest() {
    const chunks = [];
    let size = 0;
    for await (const chunk of process.stdin) {
        size += chunk.length;
        if (size > MAX_REQUEST_BYTES) {
            throw new Error(`planner request exceeds ${MAX_REQUEST_BYTES} bytes`);
        }
        chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (!raw) throw new Error('planner request stdin is empty');
    try {
        return JSON.parse(raw);
    } catch (error) {
        throw new Error(`planner request is not valid JSON: ${error.message}`);
    }
}

try {
    const request = await readRequest();
    const result = await createBoxStartPublishPlan(request);
    process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
    process.stderr.write(`box start publish planner failed: ${error?.message || error}\n`);
    process.exitCode = 1;
}
