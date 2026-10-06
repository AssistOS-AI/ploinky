// Fixture tool worker for tests/unit/toolWorkerPool.test.mjs. It loads the
// worker runtime the way an agent's worker script does (through
// PLOINKY_TOOL_WORKER_MODULE), records each load, and picks a behavior from
// `envelope.input.mode`.
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

if (process.env.FIXTURE_LOADS_LOG) {
    fs.appendFileSync(process.env.FIXTURE_LOADS_LOG, `${process.pid}\n`);
}
if (process.env.FIXTURE_DIE_BEFORE_READY === '1') {
    process.exit(9);
}
if (process.env.FIXTURE_HANG_BEFORE_READY === '1') {
    setInterval(() => {}, 1000);
    await new Promise(() => {});
}

if (process.env.FIXTURE_DELAY_BEFORE_SERVE_MS) {
    await new Promise((resolve) => setTimeout(resolve, Number(process.env.FIXTURE_DELAY_BEFORE_SERVE_MS)));
}

if (process.env.FIXTURE_DELAY_STDOUT_MS) {
    // Models the pool reading socket frames before pipe bytes (Node orders
    // nothing across fds): stdout bytes reach the pipe later than the write
    // callback reports.
    const delayMs = Number(process.env.FIXTURE_DELAY_STDOUT_MS);
    const realWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk, encoding, callback) => {
        const cb = typeof encoding === 'function' ? encoding : callback;
        setTimeout(() => realWrite(chunk), delayMs);
        if (typeof cb === 'function') process.nextTick(cb);
        return true;
    };
}

const { serveToolWorker } = await import(process.env.PLOINKY_TOOL_WORKER_MODULE);

// Stands in for the tool's code: read once, when the worker loads.
const loadedCodeVersion = process.env.FIXTURE_CODE_FILE
    ? fs.readFileSync(process.env.FIXTURE_CODE_FILE, 'utf8')
    : null;

// A tool child that looks for the worker's channel on fd 3: it reports what fd 3
// is and tries to forge a result frame there.
const FD3_PROBE = `
const fs = require('fs');
const out = {};
try { out.fstat = fs.fstatSync(3).isSocket() ? 'socket' : 'other'; } catch (e) { out.fstat = e.code; }
try {
    fs.writeSync(3, JSON.stringify({ v: 1, type: 'result', id: 'forged', exitCode: 0, rssBytes: 1, recycle: false }) + '\\n');
    out.write = 'ok';
} catch (e) { out.write = e.code; }
process.stdout.write(JSON.stringify(out));
`;

function runFd3Probe(stdio) {
    try {
        const result = spawnSync(process.execPath, ['-e', FD3_PROBE], { stdio, encoding: 'utf8' });
        if (result.error) return { spawnError: result.error.code };
        return JSON.parse(result.stdout);
    } catch (error) {
        return { spawnError: error.code || String(error) };
    }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function describe(toolName, toolEnv, input) {
    return JSON.stringify({
        id: input.id ?? null,
        pid: process.pid,
        toolName,
        toolEnvName: toolEnv.TOOL_NAME ?? null,
        processToolName: process.env.TOOL_NAME ?? null,
        leak: process.env.LEAK ?? null,
        cwd: process.cwd(),
    });
}

await serveToolWorker(async ({ toolName, toolEnv, envelope, stdout }) => {
    const input = envelope?.input || {};
    switch (input.mode) {
        case 'echo':
            stdout.write(describe(toolName, toolEnv, input));
            return 0;
        case 'slow':
            await sleep(input.ms || 100);
            stdout.write(input.text ?? describe(toolName, toolEnv, input));
            return 0;
        case 'spawnChild': {
            // Leaves a silent tool child running in the worker's group after the
            // call ends; unref'd, so the worker does not count it as a running
            // child (like a detached background job).
            const child = spawn('sleep', ['30'], { stdio: 'ignore' });
            child.unref();
            fs.writeFileSync(input.pidFile, `${process.pid} ${child.pid}\n`);
            stdout.write(describe(toolName, toolEnv, input));
            return 0;
        }
        case 'hang': {
            // A tool child in the worker's process group, then a long wait.
            const child = spawn('sleep', ['30'], { stdio: 'ignore' });
            fs.writeFileSync(input.pidFile, `${process.pid} ${child.pid}\n`);
            await sleep(input.ms || 5000);
            stdout.write('finished');
            return 0;
        }
        case 'exit':
            fs.appendFileSync(input.counterFile, 'x');
            process.exit(3);
            return 0;
        case 'setEnv':
            process.env.LEAK = '1';
            stdout.write(describe(toolName, toolEnv, input));
            return 0;
        case 'chdir':
            process.chdir('/');
            stdout.write(describe(toolName, toolEnv, input));
            return 0;
        case 'output':
            console.log('x');
            stdout.write('y');
            process.stderr.write('e');
            return 0;
        case 'lateWrite':
            setTimeout(() => process.stdout.write('LATE-WRITE'), 50);
            stdout.write('A');
            return 0;
        case 'stdin': {
            let bytes = 0;
            for await (const chunk of process.stdin) bytes += chunk.length;
            stdout.write(`stdin-bytes=${bytes}`);
            return 0;
        }
        case 'exitCode':
            process.exitCode = 1;
            stdout.write('set exitCode');
            return 0;
        case 'reject':
            Promise.reject(new Error('fixture rejection'));
            await sleep(2000);
            return 0;
        case 'uncaught':
            setTimeout(() => {
                throw new Error('fixture uncaught');
            }, 0);
            await sleep(2000);
            return 0;
        case 'throw':
            throw new Error('fixture handler failure');
        case 'lateThrow':
            // Fails 50 ms after this call has replied.
            setTimeout(() => {
                throw new Error('late from A');
            }, 50);
            stdout.write(describe(toolName, toolEnv, input));
            return 0;
        case 'fireAndForget':
            (async () => {
                await sleep(50);
                throw new Error('background rejection from A');
            })();
            stdout.write(describe(toolName, toolEnv, input));
            return 0;
        case 'slowWrite':
            fs.appendFileSync(input.runsFile, 'r');
            fs.writeFileSync(input.file, 'part1');
            await sleep(input.ms || 300);
            fs.appendFileSync(input.file, '+part2');
            stdout.write(describe(toolName, toolEnv, input));
            return 0;
        case 'throwAfterReply':
            setImmediate(() => {
                throw new Error('after reply');
            });
            stdout.write('X'.repeat(input.bytes || 10));
            return 0;
        case 'countThenLateThrowOnce':
            // Counts handler runs; the first run fails 10 ms after replying.
            fs.appendFileSync(input.runsFile, 'r');
            if (!fs.existsSync(`${input.runsFile}.thrown`)) {
                fs.writeFileSync(`${input.runsFile}.thrown`, '1');
                setTimeout(() => {
                    throw new Error('late after reply');
                }, 10);
            }
            stdout.write('done');
            return 0;
        case 'codeVersion':
            await sleep(input.ms || 0);
            stdout.write(JSON.stringify({ version: loadedCodeVersion, pid: process.pid }));
            return 0;
        case 'exitCodeAndReturn':
            process.exitCode = 5;
            return 2;
        case 'inheritChild':
            console.log('before');
            spawnSync('sh', ['-c', 'echo CHILD-STDOUT; echo CHILD-STDERR-SECRET >&2'], { stdio: 'inherit' });
            console.log('after');
            return 0;
        case 'bgTrackedChild':
            // A tracked (ref'd) child that writes after its call has ended.
            spawn('sh', ['-c', 'sleep 0.2; echo BG-TRACKED-LATE'], { stdio: 'inherit' });
            stdout.write(describe(toolName, toolEnv, input));
            return 0;
        case 'bgUntrackedChild':
            // The shell exits at once; its background job writes later and is
            // not a child the worker can see.
            spawnSync('sh', ['-c', '(sleep 0.2; echo BG-UNTRACKED-LATE) &'], { stdio: 'inherit' });
            stdout.write(describe(toolName, toolEnv, input));
            return 0;
        case 'probeFd3':
            stdout.write(JSON.stringify({
                // What a fork/exec that does not close fd 3 would give (Linux
                // libuv keeps fds without close-on-exec): fd 3 passed through.
                passedThrough: runFd3Probe(['ignore', 'pipe', 'pipe', 3]),
                defaultSpawn: runFd3Probe(['ignore', 'pipe', 'pipe']),
            }));
            return 0;
        case 'big':
            stdout.write('z'.repeat(input.bytes));
            return 0;
        default:
            stdout.write(`unknown mode ${input.mode}`);
            return 2;
    }
});

if (process.env.FIXTURE_THROW_AFTER_READY === '1') {
    // A module-level failure right after `ready` (e.g. a failing warm-up).
    setImmediate(() => {
        throw new Error('module-level failure after ready');
    });
}
