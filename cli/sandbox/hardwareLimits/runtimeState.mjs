import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const HARDWARE_RUNTIME_ROOT = '/run/ploinky/hardware-limits-runtime';
const MAX_BYTES = 16 * 1024;

function statePath(root, key) {
    if (typeof key !== 'string' || !key || Buffer.byteLength(key) > 1024) throw new Error('unrepresentable hardware runtime identity');
    return path.join(root, `${crypto.createHash('sha256').update(key).digest('hex')}.json`);
}

function verifyDirectory(root) {
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700) {
        throw new Error('hardware runtime directory is not private');
    }
}

export function writeAppliedObservation(value, { root = HARDWARE_RUNTIME_ROOT } = {}) {
    if (!/^[a-f0-9]{64}$/.test(value.containerId) || !/^[a-f0-9]{64}$/.test(value.limitsHash)) throw new Error('invalid applied hardware identity');
    try { fs.mkdirSync(root, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    verifyDirectory(root);
    const payload = Buffer.from(`${JSON.stringify({ schema: 1, ...value, observedAt: new Date().toISOString() })}\n`);
    if (payload.length > MAX_BYTES) throw new Error('applied hardware observation is oversized');
    const target = statePath(root, value.key);
    const temporary = `${target}.${crypto.randomBytes(16).toString('hex')}`;
    const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, payload); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try { fs.renameSync(temporary, target); } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

export function readAppliedObservation(key, containerId, { root = HARDWARE_RUNTIME_ROOT } = {}) {
    try {
        verifyDirectory(root);
        const fd = fs.openSync(statePath(root, key), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        try {
            const stat = fs.fstatSync(fd);
            if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size > MAX_BYTES) return null;
            const buffer = Buffer.alloc(MAX_BYTES + 1);
            const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
            if (count > MAX_BYTES) return null;
            const value = JSON.parse(buffer.subarray(0, count).toString('utf8'));
            return value.schema === 1 && value.key === key && value.containerId === containerId ? value : null;
        } finally { fs.closeSync(fd); }
    } catch (_) { return null; }
}
