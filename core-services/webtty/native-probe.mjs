#!/usr/bin/env node

// This file is copied into the immutable Box and deliberately has no imports
// from Router source. Keep its contract constants in lockstep with
// native-runtime.mjs; source-owned tests enforce that relationship.

import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEMA = 'ploinky.webtty.native/v1';
const NODE_MAJOR = 24;
const NODE_ABI = '137';
const NODE_PTY_VERSION = '1.0.0';
const EXPECTED_UID = 1_000;
const EXPECTED_GID = 1_000;
const PACKAGE_LOCK_SHA256 = '3eec51e517db1ba30c6ef523be83640cd0484b910adfa54a11692e020ea06a6a';
const RUNTIME_ROOT = '/usr/local/lib/ploinky/webtty';
const MODULE_ROOT = `${RUNTIME_ROOT}/node_modules`;
const CONTRACT_PATH = '/usr/local/share/ploinky/webtty/runtime-contract.json';
const ARTIFACT_RELATIVE_PATH = 'node-pty/build/Release/pty.node';
const ARTIFACT_PATH = `${MODULE_ROOT}/${ARTIFACT_RELATIVE_PATH}`;
const PROBE_TIMEOUT_MS = 8_000;
const MAX_CAPTURE_BYTES = 64 * 1024;
const MAX_CONTRACT_BYTES = 16 * 1024;

function fail(category) {
    const error = new Error(`WebTTY native probe failed: ${category}`);
    error.category = category;
    throw error;
}

function sha256File(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function normalizeArchitecture(arch) {
    if (arch === 'x64' || arch === 'amd64') return 'amd64';
    if (arch === 'arm64') return 'arm64';
    return '';
}

function exactKeys(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function parseArguments(argv) {
    const options = {
        mode: '',
        moduleRoot: MODULE_ROOT,
        contractPath: CONTRACT_PATH,
        packageLock: '',
        sourceSha: '',
    };
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (token === '--build-contract' || token === '--verify') {
            if (options.mode) fail('duplicate-mode');
            options.mode = token.slice(2);
            continue;
        }
        if (!['--module-root', '--contract', '--package-lock', '--source-sha'].includes(token)) {
            fail('unknown-argument');
        }
        const value = argv[index + 1];
        if (!value || value.startsWith('--')) fail('missing-argument-value');
        index += 1;
        if (token === '--module-root') options.moduleRoot = value;
        if (token === '--contract') options.contractPath = value;
        if (token === '--package-lock') options.packageLock = value;
        if (token === '--source-sha') options.sourceSha = value;
    }
    if (!options.mode) fail('missing-mode');
    for (const value of [options.moduleRoot, options.contractPath]) {
        if (!path.isAbsolute(value) || value.includes('\0')) fail('path');
    }
    if (options.mode === 'build-contract') {
        if (!path.isAbsolute(options.packageLock) || options.packageLock.includes('\0')) fail('package-lock-path');
        if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(options.sourceSha)) fail('source-sha');
    } else if (options.packageLock || options.sourceSha || options.moduleRoot !== MODULE_ROOT || options.contractPath !== CONTRACT_PATH) {
        // Admission uses only the immutable locations. Alternate roots are a
        // build-stage facility and are never accepted by runtime verification.
        fail('verify-path-override');
    }
    return options;
}

function inspectNativeBundle(moduleRoot) {
    const packagePath = path.join(moduleRoot, 'node-pty', 'package.json');
    const artifactCandidate = path.join(moduleRoot, ARTIFACT_RELATIVE_PATH);
    const packageStat = fs.lstatSync(packagePath);
    if (!packageStat.isFile() || packageStat.isSymbolicLink()) fail('node-pty-package-type');
    const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    if (packageJson?.version !== NODE_PTY_VERSION) fail('node-pty-version');
    const stat = fs.lstatSync(artifactCandidate);
    if (!stat.isFile() || stat.isSymbolicLink()) fail('native-artifact-type');
    const realModuleRoot = fs.realpathSync(moduleRoot);
    const realArtifact = fs.realpathSync(artifactCandidate);
    if (moduleRoot === MODULE_ROOT && realModuleRoot !== MODULE_ROOT) fail('native-module-root-path');
    if (!realArtifact.startsWith(`${realModuleRoot}${path.sep}`)) fail('native-artifact-containment');
    if (moduleRoot === MODULE_ROOT && realArtifact !== ARTIFACT_PATH) fail('native-artifact-path');
    return {
        artifactSha256: sha256File(realArtifact),
        nodePty: createRequire(path.join(moduleRoot, 'package.json'))(path.join(moduleRoot, 'node-pty')),
    };
}

function parseLinuxProcStat(pid) {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const commandEnd = raw.lastIndexOf(')');
    if (commandEnd < 0) fail('pty-proc-stat');
    const fields = raw.slice(commandEnd + 1).trim().split(/\s+/);
    const numeric = (index) => {
        const value = Number(fields[index]);
        if (!Number.isSafeInteger(value)) fail('pty-proc-stat');
        return value;
    };
    return {
        pid,
        state: fields[0],
        processGroupId: numeric(2),
        sessionId: numeric(3),
        ttyNumber: numeric(4),
        foregroundProcessGroupId: numeric(5),
        startToken: `linux-proc:${fields[19] || ''}`,
    };
}

function signalVerifiedPty(identity, signal) {
    if (!identity || !['SIGTERM', 'SIGKILL'].includes(signal)) fail('pty-cleanup-identity');
    const current = parseLinuxProcStat(identity.pid);
    if (current.startToken !== identity.startToken
        || current.processGroupId !== identity.pid
        || current.sessionId !== identity.pid
        || current.foregroundProcessGroupId !== identity.pid
        || current.ttyNumber !== identity.ttyNumber) {
        fail('pty-cleanup-identity');
    }
    process.kill(-identity.pid, signal);
}

function originalProcessExists(identity) {
    try {
        return parseLinuxProcStat(identity.pid).startToken === identity.startToken;
    } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ESRCH') return false;
        return fs.existsSync(`/proc/${identity.pid}`);
    }
}

function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForPtyIdentity(pid) {
    let identity;
    for (let attempt = 0; attempt < 40; attempt += 1) {
        try {
            identity = parseLinuxProcStat(pid);
            if (identity.state !== 'Z'
                && identity.startToken !== 'linux-proc:'
                && identity.ttyNumber > 0
                && identity.processGroupId === pid
                && identity.sessionId === pid
                && identity.foregroundProcessGroupId === pid) {
                return identity;
            }
        } catch (_) {
            // The child may not have completed forkpty/exec yet.
        }
        await delay(10);
    }
    fail('pty-process-identity');
}

export async function exercisePtyTerminal(terminal, {
    outputMarker,
    inputValue,
    inputMarker,
    timeoutMs = PROBE_TIMEOUT_MS,
} = {}) {
    let captured = '';
    let captureBytes = 0;
    let timedOut = false;
    let resolveOutputReady;
    let rejectOutputBound;
    let timeout;

    const outputReady = new Promise((resolve) => {
        resolveOutputReady = resolve;
    });
    const outputBound = new Promise((_, reject) => {
        rejectOutputBound = reject;
    });
    const exitPromise = new Promise((resolve) => {
        terminal.onExit(resolve);
    });
    const timeoutPromise = new Promise((_, reject) => {
        timeout = setTimeout(() => {
            timedOut = true;
            reject(new Error('timeout'));
        }, timeoutMs);
    });

    terminal.onData((data) => {
        const text = String(data);
        captureBytes += Buffer.byteLength(text, 'utf8');
        if (captureBytes > MAX_CAPTURE_BYTES) {
            rejectOutputBound(Object.assign(new Error('output-bound'), { category: 'pty-output-bound' }));
            return;
        }
        captured += text;
        if (captured.includes(outputMarker)) resolveOutputReady();
    });

    try {
        // The readiness marker comes from the environment so terminal echo of
        // this command cannot be mistaken for proof that bash reached `read`.
        terminal.write("stty -echo; printf '%s\\n' \"$PLOINKY_PTY_READY\"; IFS= read -r webtty_value; stty size; printf '__ploinky_input_%s__' \"$webtty_value\"; exit 7\r");
        const firstPhase = await Promise.race([
            outputReady.then(() => 'ready'),
            exitPromise.then(() => 'exit'),
            outputBound,
            timeoutPromise,
        ]);
        if (firstPhase !== 'ready') fail('pty-output');

        // Shell terminal setup may restore an earlier window size. Resize only
        // after the executed marker; the input read then keeps `stty size`
        // behind that resize without returning to the interactive prompt.
        terminal.resize(93, 31);
        terminal.write(`${inputValue}\r`);
        const exit = await Promise.race([exitPromise, outputBound, timeoutPromise]);
        if (captureBytes > MAX_CAPTURE_BYTES) fail('pty-output-bound');
        if (exit?.exitCode !== 7) fail('pty-exit');
        if (!captured.includes(outputMarker)) fail('pty-output');
        if (!captured.includes(inputMarker)) fail('pty-input');
        if (!/(?:^|[\r\n])31\s+93(?:[\r\n]|$)/.test(captured)) fail('pty-resize');
        return { captured, exit };
    } catch (error) {
        if (error?.category) throw error;
        fail(timedOut ? 'pty-timeout' : 'pty-operation');
    } finally {
        clearTimeout(timeout);
    }
}

async function provePty(nodePty) {
    if (!nodePty || typeof nodePty.spawn !== 'function') fail('node-pty-import');
    if (process.platform !== 'linux') fail('platform');

    const outputMarker = `__ploinky_output_${crypto.randomBytes(8).toString('hex')}__`;
    const inputValue = `ploinky_input_${crypto.randomBytes(8).toString('hex')}`;
    const inputMarker = `__ploinky_input_${inputValue}__`;
    let terminal;
    let identity;
    try {
        terminal = nodePty.spawn('/bin/bash', ['--noprofile', '--norc'], {
            name: 'xterm-256color',
            cols: 80,
            rows: 24,
            cwd: '/tmp',
            env: {
                HOME: '/tmp',
                USER: 'podman',
                LOGNAME: 'podman',
                SHELL: '/bin/bash',
                PATH: '/usr/local/bin:/usr/bin:/bin',
                TERM: 'xterm-256color',
                LANG: 'C.UTF-8',
                LC_ALL: 'C.UTF-8',
                PLOINKY_PTY_READY: outputMarker,
            },
        });
        if (!Number.isSafeInteger(terminal.pid) || terminal.pid <= 0) fail('pty-pid');
        identity = await waitForPtyIdentity(terminal.pid);
        await exercisePtyTerminal(terminal, { outputMarker, inputValue, inputMarker });

        for (let attempt = 0; attempt < 100 && originalProcessExists(identity); attempt += 1) {
            await delay(10);
        }
        if (originalProcessExists(identity)) fail('pty-reap');
        return Object.freeze({
            import: true,
            input: true,
            output: true,
            resize: true,
            exit: true,
            reap: true,
            identity: Boolean(identity),
        });
    } catch (error) {
        try { if (identity) signalVerifiedPty(identity, 'SIGKILL'); } catch (_) { }
        if (error?.category) throw error;
        fail('pty-operation');
    }
}

export function validateStoredContract(contract, artifactSha256) {
    const keys = [
        'schema', 'nodeMajor', 'nodeAbi', 'platform', 'architecture', 'nodePtyVersion',
        'packageLockSha256', 'nativeArtifactPath', 'nativeArtifactSha256', 'sourceSha',
        'uid', 'gid', 'pty',
    ];
    if (!exactKeys(contract, keys)) fail('contract-shape');
    if (contract.schema !== SCHEMA) fail('contract-schema');
    if (contract.nodeMajor !== NODE_MAJOR) fail('contract-node-major');
    if (contract.nodeAbi !== NODE_ABI) fail('contract-node-abi');
    if (contract.platform !== 'linux') fail('contract-platform');
    if (contract.architecture !== normalizeArchitecture(process.arch)) fail('contract-architecture');
    if (contract.nodePtyVersion !== NODE_PTY_VERSION) fail('contract-node-pty-version');
    if (contract.packageLockSha256 !== PACKAGE_LOCK_SHA256) fail('contract-package-lock');
    if (contract.nativeArtifactPath !== ARTIFACT_PATH) fail('contract-artifact-path');
    if (contract.nativeArtifactSha256 !== artifactSha256) fail('contract-artifact-sha256');
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(contract.sourceSha)) fail('contract-source-sha');
    if (contract.uid !== EXPECTED_UID) fail('contract-uid');
    if (contract.gid !== EXPECTED_GID) fail('contract-gid');
    if (!exactKeys(contract.pty, ['import', 'input', 'output', 'resize', 'exit', 'reap', 'identity'])
        || Object.values(contract.pty).some((value) => value !== true)) {
        fail('contract-pty');
    }
}

function readContract(contractPath) {
    const stat = fs.lstatSync(contractPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_CONTRACT_BYTES) {
        fail('contract-file');
    }
    return JSON.parse(fs.readFileSync(contractPath, 'utf8'));
}

async function run() {
    const options = parseArguments(process.argv.slice(2));
    const currentNodeMajor = Number(process.versions.node.split('.')[0]);
    if (currentNodeMajor !== NODE_MAJOR) fail('node-major');
    if (process.versions.modules !== NODE_ABI) fail('node-abi');
    const architecture = normalizeArchitecture(process.arch);
    if (process.platform !== 'linux' || !architecture) fail('platform-architecture');
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    if (uid !== EXPECTED_UID || gid !== EXPECTED_GID) {
        fail('unprivileged-user');
    }

    const bundle = inspectNativeBundle(options.moduleRoot);
    let sourceSha = options.sourceSha;
    if (options.mode === 'build-contract') {
        if (sha256File(options.packageLock) !== PACKAGE_LOCK_SHA256) fail('package-lock-sha256');
    } else {
        const stored = readContract(options.contractPath);
        validateStoredContract(stored, bundle.artifactSha256);
        sourceSha = stored.sourceSha;
    }
    const pty = await provePty(bundle.nodePty);
    const result = {
        schema: SCHEMA,
        nodeMajor: NODE_MAJOR,
        nodeAbi: NODE_ABI,
        platform: 'linux',
        architecture,
        nodePtyVersion: NODE_PTY_VERSION,
        packageLockSha256: PACKAGE_LOCK_SHA256,
        nativeArtifactPath: ARTIFACT_PATH,
        nativeArtifactSha256: bundle.artifactSha256,
        sourceSha,
        uid,
        gid,
        pty,
    };
    const output = `${JSON.stringify(result)}\n`;
    if (Buffer.byteLength(output, 'utf8') > MAX_CONTRACT_BYTES) fail('result-size');
    process.stdout.write(output);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
    run().catch((error) => {
        process.stderr.write(`WebTTY native probe failed: ${String(error?.category || 'internal')}\n`);
        process.exitCode = 1;
    });
}
