import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { AcceptanceError, need, exact } from './manifest.mjs';
import { IMPORT_LIMITS } from './import_binding.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => ['dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs'].every(key => a[key] === b[key]);
const plainPath = value => typeof value === 'string' && path.isAbsolute(value) && path.normalize(value) === value
    && !/(?:^|\/)(?:\.codex|\.ssh|\.env|\.secrets|\.ploinky)(?:\/|$)/.test(value);

// Roots and rows come from the separately qualified public pushed-source catalog; they are not authority by themselves.
export function createPinnedPublicSourceReader({ modules, roots, io, check }) {
    need(Array.isArray(roots) && roots.length > 0 && roots.length <= 32 && roots.every(root => plainPath(root) && root !== '/')
        && Array.isArray(modules) && modules.length > 0 && modules.length <= IMPORT_LIMITS.modules
        && io && ['realpathSync', 'openSync', 'fstatSync', 'lstatSync', 'readSync', 'closeSync'].every(name => typeof io[name] === 'function')
        && typeof check === 'function', 'import-reader-unqualified');
    const selected = new Map(); let total = 0, failure = null, calls = 0;
    const descriptors = [];
    for (const row of modules) {
        exact(row, ['url', 'format', 'bytes', 'sha256']); let filename;
        try { const url = new URL(row.url); need(url.protocol === 'file:' && !url.hostname && !url.search && !url.hash && url.href === row.url, 'import-reader-url'); filename = fileURLToPath(url); }
        catch { throw new AcceptanceError('import-reader-url'); }
        need(plainPath(filename) && roots.some(root => filename.startsWith(`${root}/`)) && /\.(?:mjs|cjs|js|json)$/.test(filename)
            && !selected.has(row.url) && ['module', 'commonjs', 'json'].includes(row.format) && Number.isSafeInteger(row.bytes)
            && row.bytes >= 0 && row.bytes <= IMPORT_LIMITS.sourceBytes && /^[a-f0-9]{64}$/.test(row.sha256), 'import-reader-row');
        total += row.bytes; need(total <= IMPORT_LIMITS.totalBytes, 'import-reader-catalog-cap');
        selected.set(row.url, Object.freeze({ ...row, filename }));
    }
    function readSource(requested) {
        let record = null, bytes = null, problem = null;
        try {
            need(failure === null, 'import-reader-after-failure'); check(); need(++calls <= IMPORT_LIMITS.calls, 'import-reader-call-cap');
            const row = selected.get(requested?.url);
            need(row && ['format', 'bytes', 'sha256'].every(key => requested[key] === row[key]), 'import-reader-row-unqualified');
            need(io.realpathSync(row.filename) === row.filename, 'import-reader-alias'); check();
            const fd = io.openSync(row.filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
            record = { fd, closed: false, closeUnknown: false }; descriptors.push(record);
            const before = io.fstatSync(fd);
            need(before.isFile() && before.nlink === 1 && before.size === row.bytes && same(before, io.lstatSync(row.filename)), 'import-reader-shape');
            bytes = Buffer.alloc(row.bytes + 1); let offset = 0;
            while (offset <= row.bytes) {
                check(); const count = io.readSync(fd, bytes, offset, row.bytes + 1 - offset, null);
                need(Number.isSafeInteger(count) && count >= 0 && count <= row.bytes + 1 - offset, 'import-reader-count');
                if (count === 0) break; offset += count;
            }
            const after = io.fstatSync(fd);
            need(offset === row.bytes && after.isFile() && same(before, after) && same(after, io.lstatSync(row.filename))
                && io.realpathSync(row.filename) === row.filename, 'import-reader-changed');
            bytes = bytes.subarray(0, offset); need(hash(bytes) === row.sha256, 'import-reader-bytes'); check();
        } catch { problem = 'import-reader-failed'; }
        if (record) {
            try { io.closeSync(record.fd); record.closed = true; }
            catch { record.closeUnknown = true; problem = 'import-reader-close-unknown'; }
        }
        // A failed close is ambiguous; never retry a potentially reused descriptor number.
        try { check(); } catch { problem ??= 'import-reader-failed'; }
        if (problem) { failure ??= problem; bytes?.fill(0); throw new AcceptanceError(failure); }
        return bytes;
    }
    return Object.freeze({ readSource, retainedDescriptors: () => descriptors.filter(row => !row.closed).map(row => ({ ...row })),
        snapshot: () => ({ failure, calls, closed: descriptors.filter(row => row.closed).length,
            unknownClose: descriptors.filter(row => row.closeUnknown).length, retained: descriptors.filter(row => !row.closed).length }) });
}
