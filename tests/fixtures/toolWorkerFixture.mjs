// Fixture tool worker for tests/unit/toolWorkerPool.test.mjs. It loads the
// worker runtime the way an agent's worker script does (through
// PLOINKY_TOOL_WORKER_MODULE), records each load, and picks a behavior from
// `envelope.input.mode`.
import fs from 'node:fs';
import { spawn } from 'node:child_process';

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

const { serveToolWorker } = await import(process.env.PLOINKY_TOOL_WORKER_MODULE);

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
            // Leaves a tool child running in the worker's group after the call ends.
            const child = spawn('sleep', ['30'], { stdio: 'ignore' });
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
        case 'exitCodeAndReturn':
            process.exitCode = 5;
            return 2;
        case 'big':
            stdout.write('z'.repeat(input.bytes));
            return 0;
        default:
            stdout.write(`unknown mode ${input.mode}`);
            return 2;
    }
});
