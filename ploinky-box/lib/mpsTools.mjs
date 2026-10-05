import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const MPS_TOOL_PATHS = Object.freeze({
    control: '/usr/local/nvidia/bin/nvidia-cuda-mps-control',
    server: '/usr/local/nvidia/bin/nvidia-cuda-mps-server',
});
const MAX_TOOL_BYTES = 64 * 1024 * 1024;

export function describeMpsTool(source, destination, { fsApi = fs } = {}) {
    const canonical = fsApi.realpathSync(source);
    const fd = fsApi.openSync(canonical, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
        const before = fsApi.fstatSync(fd);
        if (!before.isFile() || before.nlink !== 1 || before.size <= 0 || before.size > MAX_TOOL_BYTES) throw new Error('MPS tool is not a bounded regular file');
        fsApi.accessSync(canonical, fs.constants.R_OK | fs.constants.X_OK);
        const hash = crypto.createHash('sha256');
        const buffer = Buffer.alloc(64 * 1024);
        let offset = 0;
        while (offset < before.size) {
            const count = fsApi.readSync(fd, buffer, 0, Math.min(buffer.length, before.size - offset), offset);
            if (!count) throw new Error('MPS tool changed while fingerprinting');
            hash.update(buffer.subarray(0, count));
            offset += count;
        }
        const after = fsApi.fstatSync(fd);
        if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('MPS tool changed while fingerprinting');
        return Object.freeze({ source: canonical, destination, dev: before.dev, ino: before.ino, size: before.size, mtimeMs: before.mtimeMs, sha256: hash.digest('hex') });
    } finally { fsApi.closeSync(fd); }
}

export function validateMpsToolDescriptor(value, key) {
    const keys = ['source', 'destination', 'dev', 'ino', 'size', 'mtimeMs', 'sha256'];
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some((name) => !Object.hasOwn(value, name))
        || !path.isAbsolute(value.source) || value.destination !== MPS_TOOL_PATHS[key]
        || !Number.isSafeInteger(value.dev) || value.dev < 0 || !Number.isSafeInteger(value.ino) || value.ino <= 0
        || !Number.isSafeInteger(value.size) || value.size <= 0 || value.size > MAX_TOOL_BYTES
        || !Number.isFinite(value.mtimeMs) || value.mtimeMs < 0 || !/^[a-f0-9]{64}$/.test(value.sha256)) throw new Error('invalid MPS tool descriptor');
    return value;
}

export function validateMpsTools(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'control,server') throw new Error('both MPS tools are required');
    for (const key of ['control', 'server']) validateMpsToolDescriptor(value[key], key);
    return value;
}

export function revalidateMpsTools(value, { fsApi = fs, mounted = false } = {}) {
    validateMpsTools(value);
    for (const key of ['control', 'server']) {
        const expected = value[key];
        const actual = describeMpsTool(mounted ? expected.destination : expected.source, expected.destination, { fsApi });
        for (const field of ['dev', 'ino', 'size', 'mtimeMs', 'sha256']) if (actual[field] !== expected[field]) throw new Error(`MPS ${key} tool ${field} changed`);
        if (!mounted && actual.source !== expected.source) throw new Error(`MPS ${key} source changed`);
    }
    return value;
}

export function discoverMpsTools({ fsApi = fs, directories = ['/usr/bin', '/usr/local/bin', '/bin'] } = {}) {
    const tools = {};
    for (const key of ['control', 'server']) {
        const name = path.posix.basename(MPS_TOOL_PATHS[key]);
        let source;
        for (const directory of directories) {
            const candidate = path.join(directory, name);
            try { tools[key] = describeMpsTool(candidate, MPS_TOOL_PATHS[key], { fsApi }); source = candidate; break; } catch (_) { /* Try only the fixed candidates. */ }
        }
        if (!source) throw new Error(`MPS tool ${name} is missing or unreadable; install the matching NVIDIA tools on the host`);
    }
    return Object.freeze(tools);
}
