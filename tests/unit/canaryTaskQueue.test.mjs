import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseCanaryTaskId, TaskQueue } from '../../Agent/server/TaskQueue.mjs';

const options = { maxConcurrent: 0, executor: () => assert.fail('pending task ran') };

test('canary queue startup, enqueue and recovery leave the old pending task untouched', async (t) => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'canary-task-queue-'));
    t.after(() => rm(home, { recursive: true, force: true }));
    const legacyFile = path.join(home, '.tasksQueue');
    const oldTask = JSON.stringify([{ id: '1111222233334444', status: 'pending' }]);
    await writeFile(legacyFile, oldTask);
    const rolloutId = 'test-rollout_1.2026.11';
    const env = { HOME: home, PLOINKY_CANARY: '1', PLOINKY_CANARY_ROLLOUT: rolloutId };
    const queue = TaskQueue.forAgent(options, env);
    queue.initialize();
    assert.equal(queue.getTask('1111222233334444'), null);
    const { id, status } = queue.enqueueTask({ toolName: 'demo', commandSpec: {}, payload: {} });
    assert.equal(status, 'pending');
    assert.match(id, /^canary\.test-rollout_1\.2026\.11\.[a-f0-9]{16}$/);
    assert.equal(parseCanaryTaskId(id), rolloutId);
    await queue.flushPersist({ required: true });
    const canaryFile = path.join(home, `.tasksQueue.canary.${rolloutId}`);
    const saved = JSON.parse(await readFile(canaryFile, 'utf8'));
    assert.deepEqual(saved.map(task => [task.id, task.status]), [[id, 'pending']]);

    const configFile = path.join(home, 'mcp-config.json');
    await writeFile(configFile, '{}');
    const agentServer = fileURLToPath(new URL('../../Agent/server/AgentServer.mjs', import.meta.url));
    const child = spawn(process.execPath, [agentServer], {
        cwd: home,
        env: {
            ...env,
            PLOINKY_AGENTLIB_DIR: process.env.PLOINKY_AGENTLIB_DIR,
            PLOINKY_AGENT_CONFIG: configFile,
            PLOINKY_AGENT_BIND_HOST: '127.0.0.1',
            PORT: '0',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 15_000,
        killSignal: 'SIGKILL',
    });
    let output = '';
    let sentTerm = false;
    child.stdout.on('data', chunk => {
        output += chunk.toString();
        if (!sentTerm && output.includes('Streamable HTTP listening on 127.0.0.1:')) {
            sentTerm = child.kill('SIGTERM');
        }
    });
    let errors = '';
    child.stderr.on('data', chunk => { errors += chunk.toString(); });
    const [code, signal] = await once(child, 'close');
    assert.equal(sentTerm, true, errors);
    assert.equal(signal, null, errors);
    assert.equal(code, 0, errors);
    assert.equal(await readFile(legacyFile, 'utf8'), oldTask);
    const recovered = JSON.parse(await readFile(canaryFile, 'utf8'));
    assert.deepEqual(recovered.map(task => [task.id, task.status]), [[id, 'failed']]);
});

test('ordinary queues keep their existing filename and task IDs', () => {
    for (const env of [{}, { PLOINKY_CANARY_ROLLOUT: 'r1' }]) {
        const queue = TaskQueue.forAgent(options, { HOME: '/agent/home', ...env });
        assert.equal(queue.storagePath, '/agent/home/.tasksQueue');
        const id = queue.generateId();
        assert.match(id, /^[0-9a-f]{16}$/);
        assert.equal(parseCanaryTaskId(id), null);
    }
});

test('canary queue requires a valid rollout ID before startup', () => {
    for (const rolloutId of [undefined, '', ' ', '../other', '.r1', '-r1', '_r1', 'r1\n', 'a'.repeat(129)]) {
        const env = { PLOINKY_CANARY: '1', PLOINKY_CANARY_ROLLOUT: rolloutId };
        assert.throws(() => TaskQueue.forAgent(options, env), /Invalid PLOINKY_CANARY_ROLLOUT/);
    }
    for (const rolloutId of ['1', 'A.b_c-9'.padEnd(128, 'x')]) {
        const queue = TaskQueue.forAgent(options, {
            HOME: '/agent/home', PLOINKY_CANARY: '1', PLOINKY_CANARY_ROLLOUT: rolloutId,
        });
        assert.equal(queue.storagePath, `/agent/home/.tasksQueue.canary.${rolloutId}`);
        assert.equal(parseCanaryTaskId(queue.generateId()), rolloutId);
    }
});

test('rejects malformed canary task ID markers', () => {
    for (const id of [null, 'canary..1111222233334444', 'canary.r1.short',
        'canary.r1.1111222233334444.extra', 'canary.a/b.1111222233334444',
        'canary.-r1.1111222233334444', `canary.${'a'.repeat(129)}.1111222233334444`]) {
        assert.equal(parseCanaryTaskId(id), null);
    }
});
