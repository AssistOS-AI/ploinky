import { createRequire as createRequireDefault } from 'node:module';
import path from 'node:path';

export const WEBTTY_RUNTIME_SCHEMA = 'ploinky.webtty.native/v1';
export const WEBTTY_NODE_PTY_VERSION = '1.0.0';
export const WEBTTY_EXPECTED_NODE_MAJOR = 24;
export const WEBTTY_EXPECTED_MODULE_ABI = '137';
export const WEBTTY_EXPECTED_UID = 1_000;
export const WEBTTY_EXPECTED_GID = 1_000;
export const WEBTTY_PACKAGE_LOCK_SHA256 = '3eec51e517db1ba30c6ef523be83640cd0484b910adfa54a11692e020ea06a6a';

export const WEBTTY_NATIVE_RUNTIME_ROOT = '/usr/local/lib/ploinky/webtty';
export const WEBTTY_NATIVE_MODULE_ROOT = `${WEBTTY_NATIVE_RUNTIME_ROOT}/node_modules`;
export const WEBTTY_NATIVE_CONTRACT_PATH = '/usr/local/share/ploinky/webtty/runtime-contract.json';
export const WEBTTY_NATIVE_PROBE_PATH = '/usr/local/share/ploinky/webtty/native-probe.mjs';
export const WEBTTY_NATIVE_NODE_PTY_PACKAGE_PATH = `${WEBTTY_NATIVE_MODULE_ROOT}/node-pty/package.json`;
export const WEBTTY_NATIVE_ARTIFACT_PATH = `${WEBTTY_NATIVE_MODULE_ROOT}/node-pty/build/Release/pty.node`;

const RESULT_KEYS = Object.freeze([
    'schema',
    'nodeMajor',
    'nodeAbi',
    'platform',
    'architecture',
    'nodePtyVersion',
    'packageLockSha256',
    'nativeArtifactPath',
    'nativeArtifactSha256',
    'sourceSha',
    'uid',
    'gid',
    'pty',
]);
const PTY_RESULT_KEYS = Object.freeze(['import', 'input', 'output', 'resize', 'exit', 'reap', 'identity']);

export function normalizeNativeArchitecture(architecture) {
    if (architecture === 'x64' || architecture === 'amd64') return 'amd64';
    if (architecture === 'arm64') return 'arm64';
    return '';
}

export function nativeRuntimeExpectation({
    platform = 'linux',
    architecture = normalizeNativeArchitecture(process.arch),
} = {}) {
    return Object.freeze({
        schema: WEBTTY_RUNTIME_SCHEMA,
        nodeMajor: WEBTTY_EXPECTED_NODE_MAJOR,
        nodeAbi: WEBTTY_EXPECTED_MODULE_ABI,
        platform,
        architecture: normalizeNativeArchitecture(architecture),
        nodePtyVersion: WEBTTY_NODE_PTY_VERSION,
        packageLockSha256: WEBTTY_PACKAGE_LOCK_SHA256,
        nativeArtifactPath: WEBTTY_NATIVE_ARTIFACT_PATH,
    });
}

export function nativeContractError(categories) {
    const normalized = [...new Set(categories.map((category) => String(category || 'invalid-result')))].sort();
    const error = new Error(`WebTTY native runtime contract mismatch: ${normalized.join(', ')}`);
    error.code = 'WEBTTY_NATIVE_CONTRACT_MISMATCH';
    error.categories = Object.freeze(normalized);
    return error;
}

function hasExactKeys(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isSha256(value) {
    return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function isSourceSha(value) {
    return typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
}

export function validateNativeProbeResult(result, {
    platform = 'linux',
    architecture = normalizeNativeArchitecture(process.arch),
    uid,
    gid,
} = {}) {
    const expected = nativeRuntimeExpectation({ platform, architecture });
    const categories = [];
    if (!hasExactKeys(result, RESULT_KEYS)) {
        categories.push('result-shape');
    }
    if (result?.schema !== expected.schema) categories.push('schema');
    if (result?.nodeMajor !== expected.nodeMajor) categories.push('node-major');
    if (result?.nodeAbi !== expected.nodeAbi) categories.push('node-abi');
    if (result?.platform !== expected.platform) categories.push('platform');
    if (result?.architecture !== expected.architecture) categories.push('architecture');
    if (result?.nodePtyVersion !== expected.nodePtyVersion) categories.push('node-pty-version');
    if (result?.packageLockSha256 !== expected.packageLockSha256) categories.push('package-lock');
    if (result?.nativeArtifactPath !== expected.nativeArtifactPath) categories.push('native-artifact-path');
    if (!isSha256(result?.nativeArtifactSha256)) categories.push('native-artifact-sha256');
    if (!isSourceSha(result?.sourceSha)) categories.push('source-sha');
    if (result?.uid !== WEBTTY_EXPECTED_UID) categories.push('uid');
    if (result?.gid !== WEBTTY_EXPECTED_GID) categories.push('gid');
    if (uid !== undefined && result?.uid !== uid) categories.push('uid');
    if (gid !== undefined && result?.gid !== gid) categories.push('gid');
    if (!hasExactKeys(result?.pty, PTY_RESULT_KEYS)) {
        categories.push('pty-shape');
    } else {
        for (const key of PTY_RESULT_KEYS) {
            if (result.pty[key] !== true) categories.push(`pty-${key}`);
        }
    }
    if (categories.length) throw nativeContractError(categories);
    return Object.freeze({
        ...result,
        pty: Object.freeze({ ...result.pty }),
    });
}

export function parseAndValidateNativeProbeOutput(output, options) {
    const raw = Buffer.isBuffer(output) ? output : Buffer.from(String(output ?? ''), 'utf8');
    if (raw.length === 0 || raw.length > 16 * 1024) {
        throw nativeContractError(['probe-output-size']);
    }
    let parsed;
    try {
        parsed = JSON.parse(raw.toString('utf8'));
    } catch (_) {
        throw nativeContractError(['probe-output-json']);
    }
    return validateNativeProbeResult(parsed, options);
}

export function loadImmutableNodePty({ createRequireImpl = createRequireDefault } = {}) {
    const requireFromImmutableRoot = createRequireImpl(path.join(WEBTTY_NATIVE_RUNTIME_ROOT, 'package.json'));
    const nodePty = requireFromImmutableRoot(path.join(WEBTTY_NATIVE_MODULE_ROOT, 'node-pty'));
    if (!nodePty || typeof nodePty.spawn !== 'function') {
        throw nativeContractError(['node-pty-import']);
    }
    return nodePty;
}
