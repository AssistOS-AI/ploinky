import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { exercisePtyTerminal, validateStoredContract } from '../../core-services/webtty/native-probe.mjs';

import {
    WEBTTY_EXPECTED_GID,
    WEBTTY_EXPECTED_MODULE_ABI,
    WEBTTY_EXPECTED_NODE_MAJOR,
    WEBTTY_EXPECTED_UID,
    WEBTTY_NATIVE_ARTIFACT_PATH,
    WEBTTY_NATIVE_CONTRACT_PATH,
    WEBTTY_NATIVE_MODULE_ROOT,
    WEBTTY_NATIVE_PROBE_PATH,
    WEBTTY_NATIVE_RUNTIME_ROOT,
    WEBTTY_NODE_PTY_VERSION,
    WEBTTY_PACKAGE_LOCK_SHA256,
    WEBTTY_RUNTIME_SCHEMA,
    loadImmutableNodePty,
    nativeRuntimeExpectation,
    parseAndValidateNativeProbeOutput,
    validateNativeProbeResult,
} from '../../core-services/webtty/native-runtime.mjs';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');

function validResult(overrides = {}) {
    return {
        schema: WEBTTY_RUNTIME_SCHEMA,
        nodeMajor: WEBTTY_EXPECTED_NODE_MAJOR,
        nodeAbi: WEBTTY_EXPECTED_MODULE_ABI,
        platform: 'linux',
        architecture: 'amd64',
        nodePtyVersion: WEBTTY_NODE_PTY_VERSION,
        packageLockSha256: WEBTTY_PACKAGE_LOCK_SHA256,
        nativeArtifactPath: WEBTTY_NATIVE_ARTIFACT_PATH,
        nativeArtifactSha256: 'a'.repeat(64),
        sourceSha: 'b'.repeat(40),
        uid: WEBTTY_EXPECTED_UID,
        gid: WEBTTY_EXPECTED_GID,
        pty: {
            import: true,
            input: true,
            output: true,
            resize: true,
            exit: true,
            reap: true,
            identity: true,
        },
        ...overrides,
    };
}

test('source contract constants are stable and package lock bytes match exactly', () => {
    const lockPath = path.join(repositoryRoot, 'core-services/webtty/package-lock.json');
    const digest = crypto.createHash('sha256').update(fs.readFileSync(lockPath)).digest('hex');
    assert.equal(digest, WEBTTY_PACKAGE_LOCK_SHA256);
    assert.equal(JSON.parse(fs.readFileSync(lockPath)).packages['node_modules/node-pty'].version, '1.0.0');
    assert.deepEqual(nativeRuntimeExpectation({ platform: 'linux', architecture: 'x64' }), {
        schema: WEBTTY_RUNTIME_SCHEMA,
        nodeMajor: 24,
        nodeAbi: '137',
        platform: 'linux',
        architecture: 'amd64',
        nodePtyVersion: '1.0.0',
        packageLockSha256: digest,
        nativeArtifactPath: WEBTTY_NATIVE_ARTIFACT_PATH,
    });
    assert.equal(WEBTTY_NATIVE_RUNTIME_ROOT, '/usr/local/lib/ploinky/webtty');
    assert.equal(WEBTTY_NATIVE_MODULE_ROOT, '/usr/local/lib/ploinky/webtty/node_modules');
    assert.equal(WEBTTY_NATIVE_CONTRACT_PATH, '/usr/local/share/ploinky/webtty/runtime-contract.json');
    assert.equal(WEBTTY_NATIVE_PROBE_PATH, '/usr/local/share/ploinky/webtty/native-probe.mjs');
});

test('strict probe validation accepts provenance without coupling compatibility to it', () => {
    const first = validateNativeProbeResult(validResult(), { architecture: 'amd64' });
    const second = validateNativeProbeResult(validResult({ sourceSha: 'c'.repeat(64) }), { architecture: 'x64' });
    assert.equal(first.nodePtyVersion, '1.0.0');
    assert.notEqual(first.sourceSha, second.sourceSha);
    assert.equal(parseAndValidateNativeProbeOutput(`${JSON.stringify(first)}\n`, { architecture: 'amd64' }).schema, WEBTTY_RUNTIME_SCHEMA);
});

test('schema, ABI, architecture, lock, artifact, uid/gid and PTY tampering fail by category', () => {
    const vectors = [
        ['schema', { schema: 'old' }],
        ['node-major', { nodeMajor: 25 }],
        ['node-abi', { nodeAbi: '141' }],
        ['platform', { platform: 'darwin' }],
        ['architecture', { architecture: 'arm64' }],
        ['node-pty-version', { nodePtyVersion: '1.1.0' }],
        ['package-lock', { packageLockSha256: '0'.repeat(64) }],
        ['native-artifact-path', { nativeArtifactPath: '/tmp/pty.node' }],
        ['native-artifact-sha256', { nativeArtifactSha256: 'not-a-hash' }],
        ['source-sha', { sourceSha: '../secret' }],
        ['uid', { uid: 0 }],
        ['gid', { gid: 0 }],
        ['pty-resize', { pty: { ...validResult().pty, resize: false } }],
        ['result-shape', { extra: true }],
    ];
    for (const [category, overrides] of vectors) {
        assert.throws(
            () => validateNativeProbeResult(validResult(overrides), { architecture: 'amd64' }),
            (error) => error.code === 'WEBTTY_NATIVE_CONTRACT_MISMATCH'
                && error.categories.includes(category),
            category,
        );
    }
    assert.throws(() => parseAndValidateNativeProbeOutput('', { architecture: 'amd64' }));
    assert.throws(() => parseAndValidateNativeProbeOutput('{bad json', { architecture: 'amd64' }));
    assert.throws(() => parseAndValidateNativeProbeOutput('x'.repeat((16 * 1024) + 1), { architecture: 'amd64' }));
});

test('native loading uses only the immutable absolute module root', () => {
    const calls = [];
    const fakeNodePty = { spawn() {} };
    const loaded = loadImmutableNodePty({
        createRequireImpl(anchor) {
            calls.push(['anchor', anchor]);
            return (specifier) => {
                calls.push(['specifier', specifier]);
                return fakeNodePty;
            };
        },
    });
    assert.equal(loaded, fakeNodePty);
    assert.deepEqual(calls, [
        ['anchor', '/usr/local/lib/ploinky/webtty/package.json'],
        ['specifier', '/usr/local/lib/ploinky/webtty/node_modules/node-pty'],
    ]);
    assert.throws(() => loadImmutableNodePty({ createRequireImpl: () => () => ({}) }));
});

test('the image-owned probe is self-contained and keeps contract constants aligned', () => {
    const source = fs.readFileSync(path.join(repositoryRoot, 'core-services/webtty/native-probe.mjs'), 'utf8');
    assert.doesNotMatch(source, /from ['"].*(?:cli|Router|native-runtime)/);
    assert.match(source, new RegExp(WEBTTY_PACKAGE_LOCK_SHA256));
    assert.match(source, new RegExp(WEBTTY_RUNTIME_SCHEMA.replace('/', '\\/')));
    assert.match(source, /const EXPECTED_UID = 1_000/);
    assert.match(source, /const EXPECTED_GID = 1_000/);
    assert.match(source, /--build-contract/);
    assert.match(source, /--verify/);
});

test('the PTY proof waits for an executed readiness marker before sending input', async () => {
    const outputMarker = '__ready_only_after_shell_executes__';
    const inputValue = 'input_after_handshake';
    const inputMarker = `__ploinky_input_${inputValue}__`;
    const writes = [];
    let onData;
    let onExit;
    const terminal = {
        onData(handler) { onData = handler; },
        onExit(handler) { onExit = handler; },
        resize(cols, rows) { assert.deepEqual([cols, rows], [93, 31]); },
        write(value) {
            writes.push(value);
            if (writes.length === 2) {
                assert.equal(value, `${inputValue}\r`);
                setImmediate(() => {
                    onData(`${inputMarker}\r\n`);
                    onExit({ exitCode: 7, signal: 0 });
                });
            }
        },
    };

    const proof = exercisePtyTerminal(terminal, {
        outputMarker,
        inputValue,
        inputMarker,
        timeoutMs: 1_000,
    });
    assert.equal(writes.length, 1);
    assert.doesNotMatch(writes[0], new RegExp(outputMarker));
    assert.match(writes[0], /PLOINKY_PTY_READY/);

    onData(`echoed command without marker\r\n${outputMarker.slice(0, 12)}`);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(writes.length, 1, 'input must remain withheld for a partial marker');

    onData(`${outputMarker.slice(12)}\r\n31 93\r\n`);
    const result = await proof;
    assert.equal(writes.length, 2);
    assert.equal(result.exit.exitCode, 7);
});

function shellWithLateTerminalSetup(t, { applyResize = true } = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'webtty-probe-ordering-'));
    const sizeFile = path.join(directory, 'size');
    fs.writeFileSync(sizeFile, '24 80\n');
    const outputMarker = '__ready_after_terminal_setup__';
    const inputValue = 'roundtrip_after_resize';
    const inputMarker = `__ploinky_input_${inputValue}__`;
    // Run the actual command and read barriers in Bash. The size file models
    // terminal geometry so late child setup can deterministically overwrite an
    // early parent resize without requiring a native addon in the unit suite.
    const child = spawn('/bin/bash', ['--noprofile', '--norc', '-c', `
        IFS= read -r probe_command
        printf '24 80\\n' > "$PLOINKY_TEST_SIZE"
        stty() {
            case "$1" in
                -echo) return 0 ;;
                size) cat "$PLOINKY_TEST_SIZE" ;;
                *) return 1 ;;
            esac
        }
        eval "$probe_command"
    `], {
        env: {
            PATH: '/usr/bin:/bin',
            PLOINKY_TEST_SIZE: sizeFile,
            PLOINKY_PTY_READY: outputMarker,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (data) => { stderr += data; });
    child.stdin.on('error', () => {});
    const closed = new Promise((resolve) => child.once('close', resolve));
    t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await closed;
        fs.rmSync(directory, { recursive: true, force: true });
        assert.equal(stderr, '', 'controlled Bash fixture must execute without shell errors');
    });
    const terminal = {
        onData(handler) { child.stdout.on('data', handler); },
        onExit(handler) {
            child.once('close', (exitCode, signal) => handler({ exitCode, signal: signal || 0 }));
        },
        resize(cols, rows) {
            if (applyResize) fs.writeFileSync(sizeFile, `${rows} ${cols}\n`);
        },
        write(value) { child.stdin.write(value.replaceAll('\r', '\n')); },
    };
    return { terminal, outputMarker, inputValue, inputMarker };
}

test('late shell terminal setup cannot overwrite the resize proven after readiness', async (t) => {
    const fixture = shellWithLateTerminalSetup(t);
    const result = await exercisePtyTerminal(fixture.terminal, { ...fixture, timeoutMs: 2_000 });
    assert.match(result.captured, /(?:^|[\r\n])31 93(?:[\r\n]|$)/);
    assert.ok(result.captured.includes(fixture.inputMarker));
    assert.equal(result.exit.exitCode, 7);
});

test('a resize that leaves the shell geometry unchanged still fails admission', async (t) => {
    const fixture = shellWithLateTerminalSetup(t, { applyResize: false });
    await assert.rejects(
        exercisePtyTerminal(fixture.terminal, { ...fixture, timeoutMs: 2_000 }),
        (error) => error.category === 'pty-resize',
    );
});

test('the self-contained admission probe rejects altered stored uid/gid and PTY evidence', () => {
    const contract = validResult({ architecture: process.arch === 'arm64' ? 'arm64' : 'amd64' });
    assert.equal(validateStoredContract(contract, contract.nativeArtifactSha256), undefined);
    for (const [category, changed] of [
        ['contract-uid', { ...contract, uid: 0 }],
        ['contract-gid', { ...contract, gid: 0 }],
        ['contract-pty', { ...contract, pty: { ...contract.pty, reap: false } }],
        ['contract-pty', { ...contract, pty: { ...contract.pty, unexpected: true } }],
    ]) {
        assert.throws(
            () => validateStoredContract(changed, contract.nativeArtifactSha256),
            (error) => error.category === category,
        );
    }
});
