import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
    isProcessAlive,
    parseDarwinKernProcArgs2,
    proveWorkerProcessIdentity,
    readProcessArgv,
} from '../../cli/sandbox/processIdentity.js';

const RUN_ID = '11111111-2222-4333-8444-555555555555';
const RUN_STARTED_AT_MS = 1_760_000_000_000;
const INSTANCE_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ENABLE_GENERATION = 'ffffffff-1111-4222-8333-444444444444';
const EXECUTABLE = '/usr/local/bin/node';
const WORKER = '/opt/ploinky/cli/commands/noWaitWorker.js';
const STATUS = '/workspace/.ploinky/running/no-wait/ploinky_demo_shared.11111111-2222-4333-8444-555555555555.json';
const RUNNING_DIR = '/workspace/.ploinky/running';

function workerTokens(overrides = {}) {
    const pairs = [
        ['--container', overrides.container ?? 'ploinky_demo_shared'],
        ['--instance-id', overrides.instanceId ?? INSTANCE_ID],
        ['--enable-generation', overrides.enableGeneration ?? ENABLE_GENERATION],
        ['--short-agent', overrides.shortAgent ?? 'shared'],
        ['--repo', overrides.repoName ?? 'demo'],
        ['--alias', overrides.alias ?? 'shared-blue'],
        ['--manifest-path', '/workspace/demo/shared/manifest.json'],
        ['--agent-path', '/workspace/demo/shared'],
        ['--route-key', overrides.routeKey ?? 'shared-blue'],
        ['--run-id', overrides.runId ?? RUN_ID],
        ['--run-started-at-ms', overrides.runStartedAtMs ?? String(RUN_STARTED_AT_MS)],
        ['--wave-index', overrides.waveIndex ?? '0'],
        ['--status-file', overrides.statusFile ?? STATUS],
        ['--wait-for-statuses', '[]'],
        ['--profile', 'default'],
        ['--router-port', '8080'],
        ['--force-recreate', '1'],
    ];
    return pairs.flat();
}

function workerArgv(overrides = {}) {
    return [overrides.executable ?? EXECUTABLE, overrides.worker ?? WORKER, ...workerTokens(overrides)];
}

function expected() {
    return {
        executablePath: EXECUTABLE,
        workerScriptPath: WORKER,
        runningDir: RUNNING_DIR,
        identity: {
            containerName: 'ploinky_demo_shared',
            instanceId: INSTANCE_ID,
            enableGeneration: ENABLE_GENERATION,
            repoName: 'demo',
            shortAgent: 'shared',
            alias: 'shared-blue',
            routeKey: 'shared-blue',
            runId: RUN_ID,
            runStartedAtMs: RUN_STARTED_AT_MS,
            waveIndex: 0,
            statusFile: path.basename(STATUS),
        },
    };
}

function prove(argv, { starts = ['start-1', 'start-1'], alive = true } = {}) {
    let startIndex = 0;
    return proveWorkerProcessIdentity({
        pid: 4242,
        ...expected(),
        isAliveImpl: () => alive,
        readArgvImpl: () => argv,
        readStartIdentityImpl: () => starts[startIndex++] ?? '',
    });
}

test('liveness treats EPERM as alive and rejects invalid pids', () => {
    assert.equal(isProcessAlive(process.pid), true);
    assert.equal(isProcessAlive(0), false);
    assert.equal(isProcessAlive(-1), false);
    assert.equal(
        isProcessAlive(123, { killImpl: () => { const error = new Error('denied'); error.code = 'EPERM'; throw error; } }),
        true,
    );
});

test('Linux argv reading is NUL-delimited and unavailable platforms fail closed', () => {
    assert.deepEqual(readProcessArgv(123, {
        platform: 'linux',
        fsApi: { readFileSync: () => Buffer.from('node\0worker.js\0--container\0demo\0') },
    }), ['node', 'worker.js', '--container', 'demo']);
    assert.deepEqual(readProcessArgv(123, {
        platform: 'linux',
        fsApi: { readFileSync: () => Buffer.from('node\0worker.js\0--alias\0\0--route-key\0shared\0') },
    }), ['node', 'worker.js', '--alias', '', '--route-key', 'shared']);
    assert.equal(readProcessArgv(123, {
        platform: 'freebsd',
        fsApi: { readFileSync: () => { throw new Error('must not read'); } },
    }), null);
    assert.equal(readProcessArgv(123, {
        platform: 'linux',
        fsApi: { readFileSync: () => { throw new Error('gone'); } },
    }), null);
});

test('macOS KERN_PROCARGS2 parsing returns exactly argc structured entries', () => {
    const argv = workerArgv();
    const header = Buffer.alloc(4);
    header.writeInt32LE(argv.length, 0);
    const fixture = Buffer.concat([
        header,
        Buffer.from(`${EXECUTABLE}\0\0\0`),
        Buffer.from(`${argv.join('\0')}\0IGNORED_ENV=value\0`),
    ]);
    assert.deepEqual(parseDarwinKernProcArgs2(fixture), argv);
    assert.deepEqual(readProcessArgv(4242, {
        platform: 'darwin',
        execFileSyncImpl(command, args, options) {
            assert.equal(command, '/usr/sbin/sysctl');
            assert.deepEqual(args, ['-b', 'kern.procargs2.4242']);
            assert.equal(options.timeout, 1000);
            assert.equal(options.maxBuffer, 1024 * 1024);
            return fixture;
        },
    }), argv);
    assert.equal(readProcessArgv(4242, {
        platform: 'darwin',
        execFileSyncImpl: () => { throw new Error('unavailable'); },
    }), null);
});

test('the exact executable, absolute worker script, strict arguments, and stable start prove identity', () => {
    const proof = prove(workerArgv());
    assert.equal(proof.proof, 'structured-argv');
    assert.equal(proof.processStartIdentity, 'start-1');

    // Option order is irrelevant after strict parsing.
    const tokens = workerTokens();
    const shuffledPairs = [];
    for (let index = tokens.length - 2; index >= 0; index -= 2) {
        shuffledPairs.push(tokens[index], tokens[index + 1]);
    }
    assert.equal(prove([EXECUTABLE, WORKER, ...shuffledPairs]).proof, 'structured-argv');
});

test('structured argv proof accepts the existing agent-name punctuation contract', () => {
    const agentName = 'agent+sidecar';
    const expectation = expected();
    expectation.identity = {
        ...expectation.identity,
        shortAgent: agentName,
        alias: '',
        routeKey: agentName,
    };
    const proof = proveWorkerProcessIdentity({
        pid: 4242,
        ...expectation,
        isAliveImpl: () => true,
        readArgvImpl: () => workerArgv({
            shortAgent: agentName,
            alias: '',
            routeKey: agentName,
        }),
        readStartIdentityImpl: () => 'start-plus',
    });
    assert.equal(proof.proof, 'structured-argv');
    assert.equal(proof.processStartIdentity, 'start-plus');
});

test('foreign executables, same-basename scripts, missing and unknown flags fail', () => {
    const vectors = [
        workerArgv({ executable: '/other/node' }),
        workerArgv({ worker: '/foreign/noWaitWorker.js' }),
        [EXECUTABLE, WORKER, ...workerTokens().slice(2)],
        [EXECUTABLE, WORKER, ...workerTokens(), '--unknown', 'value'],
        ['/usr/bin/python', '/tmp/unrelated.py'],
    ];
    for (const argv of vectors) {
        assert.throws(() => prove(argv), (error) => error.code === 'PROCESS_IDENTITY_UNPROVEN');
    }
});

test('duplicate flags fail whether the expected value appears first or last', () => {
    const tokens = workerTokens();
    for (const duplicate of [
        [...tokens, '--container', 'foreign'],
        ['--container', 'foreign', ...tokens],
    ]) {
        assert.throws(
            () => prove([EXECUTABLE, WORKER, ...duplicate]),
            (error) => error.code === 'PROCESS_IDENTITY_UNPROVEN' && /duplicate/.test(error.message),
        );
    }
});

test('wrong bound values, process death, and start identity races fail closed', () => {
    for (const argv of [
        workerArgv({ container: 'ploinky_other_agent' }),
        workerArgv({ instanceId: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff' }),
        workerArgv({ enableGeneration: 'eeeeeeee-dddd-4ccc-8bbb-aaaaaaaaaaaa' }),
        workerArgv({ repoName: 'other' }),
        workerArgv({ shortAgent: 'other', routeKey: 'shared-blue' }),
        workerArgv({ alias: 'other', routeKey: 'other' }),
        workerArgv({ routeKey: 'shared' }),
        workerArgv({ runId: '99999999-8888-4777-a666-555555555555' }),
        workerArgv({ runStartedAtMs: String(RUN_STARTED_AT_MS + 1) }),
        workerArgv({ waveIndex: '3' }),
        workerArgv({ statusFile: path.join(RUNNING_DIR, 'no-wait', 'foreign.json') }),
    ]) {
        assert.throws(() => prove(argv), (error) => error.code === 'PROCESS_IDENTITY_UNPROVEN');
    }
    assert.throws(
        () => prove(workerArgv(), { alive: false }),
        (error) => error.code === 'PROCESS_IDENTITY_STALE' && /not running/.test(error.message),
    );
    assert.throws(
        () => prove(workerArgv(), { starts: ['start-1', 'start-2'] }),
        /changed during inspection/,
    );
    assert.throws(
        () => prove(workerArgv(), { starts: ['', ''] }),
        /start identity/,
    );
});

test('a later unrelated process and unavailable structured argv never pass', () => {
    assert.throws(
        () => proveWorkerProcessIdentity({
            pid: 4242,
            ...expected(),
            isAliveImpl: () => true,
            readArgvImpl: () => null,
            readStartIdentityImpl: () => 'later-process-start',
        }),
        (error) => error.code === 'PROCESS_IDENTITY_UNPROVEN',
    );
});

test('the real platform reader returns a structured argv for this Node process when supported', { skip: !['linux', 'darwin'].includes(process.platform) }, () => {
    const argv = readProcessArgv(process.pid);
    assert.ok(Array.isArray(argv));
    assert.equal(path.resolve(argv[0]), path.resolve(process.execPath));
});
