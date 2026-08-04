import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';

import * as credentialProducer from '../../cli/sandbox/bwrap/bwrapAgentCredential.js';
import {
    BWRAP_HELPER_PATH,
    spawnTrustedServiceLaunch,
} from '../../cli/sandbox/bwrap/bwrapServiceManager.js';

class FakePipe extends EventEmitter {
    constructor(endImplementation = null) {
        super();
        this.endImplementation = endImplementation;
        this.calls = [];
    }

    end(chunk, callback) {
        this.calls.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : chunk);
        if (this.endImplementation) return this.endImplementation(chunk, callback);
        callback?.();
        return this;
    }
}

function fakeChild({ pid = 43121, descriptorPipe = new FakePipe(), credentialPipe = new FakePipe() } = {}) {
    const child = new EventEmitter();
    child.pid = pid;
    child.stdio = ['ignored', null, null, descriptorPipe, credentialPipe];
    return child;
}

function dependencies(child, calls = {}) {
    calls.spawn = [];
    calls.kill = [];
    return {
        assertHelper() {
            calls.assertedHelper = true;
        },
        spawnProcess(...args) {
            calls.spawn.push(args);
            return child;
        },
        killProcess(...args) {
            calls.kill.push(args);
        },
    };
}

const launch = Object.freeze({ descriptor: Buffer.from('public-launch-descriptor') });

test('credential transport requires bounded bytes and zeroes rejected buffers', () => {
    let helperAssertions = 0;
    const dependencyOverrides = {
        assertHelper() { helperAssertions += 1; },
    };

    assert.throws(
        () => spawnTrustedServiceLaunch(launch, 9, undefined, dependencyOverrides),
        (error) => error?.code === 'PLOINKY_BWRAP_CREDENTIAL_TRANSPORT_INVALID',
    );

    const empty = Buffer.alloc(0);
    assert.throws(
        () => spawnTrustedServiceLaunch(launch, 9, empty, dependencyOverrides),
        (error) => error?.code === 'PLOINKY_BWRAP_CREDENTIAL_TRANSPORT_INVALID',
    );

    const oversized = Buffer.alloc(credentialProducer.BWRAP_AGENT_CREDENTIAL_MAX_BYTES + 1, 0x73);
    assert.throws(
        () => spawnTrustedServiceLaunch(launch, 9, oversized, dependencyOverrides),
        (error) => error?.code === 'PLOINKY_BWRAP_CREDENTIAL_TRANSPORT_INVALID',
    );
    assert.deepEqual(oversized, Buffer.alloc(oversized.length));
    assert.equal(helperAssertions, 0);
});

test('credential transport zeroes bytes when helper validation or spawn fails', () => {
    const helperCredential = Buffer.from('helper-failure-secret');
    const helperFailure = new Error('helper rejected');
    assert.throws(
        () => spawnTrustedServiceLaunch(launch, 11, helperCredential, {
            assertHelper() { throw helperFailure; },
        }),
        helperFailure,
    );
    assert.deepEqual(helperCredential, Buffer.alloc(helperCredential.length));

    const spawnCredential = Buffer.from('spawn-failure-secret');
    const spawnFailure = new Error('spawn failed');
    assert.throws(
        () => spawnTrustedServiceLaunch(launch, 13, spawnCredential, {
            assertHelper() {},
            spawnProcess() { throw spawnFailure; },
        }),
        spawnFailure,
    );
    assert.deepEqual(spawnCredential, Buffer.alloc(spawnCredential.length));
});

test('credential transport accepts and zeroes both inclusive byte boundaries', () => {
    for (const length of [1, credentialProducer.BWRAP_AGENT_CREDENTIAL_MAX_BYTES]) {
        const credentialPipe = new FakePipe();
        const child = fakeChild({ credentialPipe });
        const credentialBytes = Buffer.alloc(length, 0x61);

        spawnTrustedServiceLaunch(
            launch,
            15,
            credentialBytes,
            dependencies(child),
        );

        assert.equal(credentialPipe.calls[0].length, length);
        assert.deepEqual(credentialBytes, Buffer.alloc(length));
    }
});

test('credential transport uses only fd 3 and fd 4 and zeroes after successful flush', () => {
    const descriptorPipe = new FakePipe();
    const credentialPipe = new FakePipe();
    const child = fakeChild({ descriptorPipe, credentialPipe });
    const calls = {};
    const secret = 'one-generation-private-credential';
    const credentialBytes = Buffer.from(secret);

    const result = spawnTrustedServiceLaunch(
        launch,
        17,
        credentialBytes,
        dependencies(child, calls),
    );

    assert.equal(calls.assertedHelper, true);
    assert.equal(calls.spawn.length, 1);
    const [helperPath, argv, options] = calls.spawn[0];
    assert.equal(helperPath, BWRAP_HELPER_PATH);
    assert.deepEqual(argv, []);
    assert.deepEqual(options.stdio, ['ignore', 17, 17, 'pipe', 'pipe']);
    assert.equal(options.detached, true);
    assert.equal(Object.hasOwn(options, 'env'), false);
    assert.equal(JSON.stringify([helperPath, argv, options]).includes(secret), false);
    assert.deepEqual(descriptorPipe.calls, [launch.descriptor]);
    assert.deepEqual(credentialPipe.calls, [Buffer.from(secret)]);
    assert.deepEqual(credentialBytes, Buffer.alloc(Buffer.byteLength(secret)));
    assert.deepEqual(calls.kill, []);
    assert.equal(result.child, child);
    assert.equal(result.getSpawnFailure(), null);
});

test('credential pipe error records the first failure, kills the exact group and child, and zeroes bytes', () => {
    const descriptorPipe = new FakePipe();
    const credentialPipe = new FakePipe(() => undefined);
    const child = fakeChild({ pid: 9876, descriptorPipe, credentialPipe });
    const calls = {};
    const credentialBytes = Buffer.from('credential-not-yet-flushed');

    const result = spawnTrustedServiceLaunch(
        launch,
        19,
        credentialBytes,
        dependencies(child, calls),
    );
    assert.notDeepEqual(credentialBytes, Buffer.alloc(credentialBytes.length));

    const failure = new Error('credential pipe write failed');
    credentialPipe.emit('error', failure);
    descriptorPipe.emit('error', new Error('later descriptor failure'));

    assert.equal(result.getSpawnFailure(), failure);
    assert.deepEqual(calls.kill, [[-9876, 'SIGKILL'], [9876, 'SIGKILL']]);
    assert.deepEqual(credentialBytes, Buffer.alloc(credentialBytes.length));
});

test('credential end callback failure is recorded and kills the exact process pair', () => {
    const failure = new Error('credential flush failed');
    const credentialPipe = new FakePipe((_chunk, callback) => callback(failure));
    const child = fakeChild({ pid: 222, credentialPipe });
    const calls = {};
    const credentialBytes = Buffer.from('callback-secret');

    const result = spawnTrustedServiceLaunch(
        launch,
        23,
        credentialBytes,
        dependencies(child, calls),
    );

    assert.equal(result.getSpawnFailure(), failure);
    assert.deepEqual(calls.kill, [[-222, 'SIGKILL'], [222, 'SIGKILL']]);
    assert.deepEqual(credentialBytes, Buffer.alloc(credentialBytes.length));
});

test('synchronous descriptor write failure kills the exact process pair and zeroes bytes', () => {
    const failure = new Error('descriptor write failed synchronously');
    const descriptorPipe = new FakePipe(() => { throw failure; });
    const credentialPipe = new FakePipe();
    const child = fakeChild({ pid: 444, descriptorPipe, credentialPipe });
    const calls = {};
    const credentialBytes = Buffer.from('never-written-credential');

    assert.throws(
        () => spawnTrustedServiceLaunch(
            launch,
            29,
            credentialBytes,
            dependencies(child, calls),
        ),
        failure,
    );
    assert.deepEqual(calls.kill, [[-444, 'SIGKILL'], [444, 'SIGKILL']]);
    assert.deepEqual(credentialBytes, Buffer.alloc(credentialBytes.length));
    assert.equal(credentialPipe.calls.length, 0);
});

test('missing descriptor or credential pipe kills and fails closed', () => {
    for (const missingIndex of [3, 4]) {
        const child = fakeChild({ pid: 777 + missingIndex });
        child.stdio[missingIndex] = undefined;
        const calls = {};
        const credentialBytes = Buffer.from(`missing-${missingIndex}`);

        assert.throws(
            () => spawnTrustedServiceLaunch(
                launch,
                31,
                credentialBytes,
                dependencies(child, calls),
            ),
            (error) => error?.code === 'PLOINKY_BWRAP_PIPE_FAILED',
        );
        assert.deepEqual(
            calls.kill,
            [[-(777 + missingIndex), 'SIGKILL'], [777 + missingIndex, 'SIGKILL']],
        );
        assert.deepEqual(credentialBytes, Buffer.alloc(credentialBytes.length));
    }
});

test('credential launch surface has no persistence or logging path', () => {
    assert.equal(
        Object.keys(credentialProducer).some((name) => /write|persist|save|store/i.test(name)),
        false,
    );
    const source = fs.readFileSync(
        new URL('../../cli/sandbox/bwrap/bwrapServiceManager.js', import.meta.url),
        'utf8',
    );
    const start = source.indexOf('function spawnTrustedServiceLaunch(');
    const end = source.indexOf('\nfunction admitBwrapBoundary(', start);
    assert.ok(start >= 0 && end > start);
    const transport = source.slice(start, end);
    assert.doesNotMatch(transport, /writeFile|appendFile|createWriteStream|console\.|debugLog/);
    assert.doesNotMatch(transport, /credentialBytes\.toString|JSON\.stringify\(credentialBytes/);
});
