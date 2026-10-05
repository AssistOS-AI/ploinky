import fs from 'node:fs';
import path from 'node:path';
import { AcceptanceError, need } from './manifest_codex.mjs';

// Append-only, exclusive, private recovery records in the operator's evidence root. Each record is a new file; none is
// rewritten, so a crash leaves every earlier record intact. They carry only nonsecret identities (exact container ID and
// labels, directory and marker inode, repository key and URL, alias names) and the failure receipt, never credentials,
// environment values or the private marker's content.
const RECORD_BYTES = 256 * 1024;
const SECRETISH = /secret|token|password|credential|passwd|apikey|cookie|authorization|environment|\benv\b/i;

function assertNonsecret(value, trail = '$', depth = 0) {
    need(depth <= 12, 'recovery-shape');
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) { if (typeof value === 'string') need(value.length <= 4096 && !/[\0]/.test(value), 'recovery-shape'); return; }
    if (Array.isArray(value)) { need(value.length <= 256, 'recovery-shape'); value.forEach((item, index) => assertNonsecret(item, `${trail}[${index}]`, depth + 1)); return; }
    need(value && Object.getPrototypeOf(value) === Object.prototype, 'recovery-shape');
    for (const [key, item] of Object.entries(value)) { need(!SECRETISH.test(key), 'recovery-secret-field'); assertNonsecret(item, `${trail}.${key}`, depth + 1); }
}

export function createRecoveryLog({ root, runId, io = fs }) {
    need(typeof root === 'string' && path.isAbsolute(root) && typeof runId === 'string' && /_codex$/.test(runId), 'recovery-adapters');
    let sequence = 0; const written = [];
    return Object.freeze({
        record(label, value) {
            need(typeof label === 'string' && /^[a-z][a-z0-9-]{0,40}$/.test(label), 'recovery-label'); assertNonsecret(value);
            const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, kind: 'owned-resource-recovery', runId, label, sequence: sequence + 1, value }));
            need(bytes.length <= RECORD_BYTES, 'recovery-shape');
            const file = path.join(root, `recovery_${String(sequence + 1).padStart(3, '0')}_${label}_codex.json`);
            let fd; try { fd = io.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600); } catch { throw new AcceptanceError('recovery-write'); }
            try { let offset = 0; while (offset < bytes.length) { const count = io.writeSync(fd, bytes, offset, bytes.length - offset); need(count > 0, 'recovery-write'); offset += count; } } finally { io.closeSync(fd); }
            sequence += 1; written.push(path.basename(file)); return path.basename(file);
        },
        written: () => [...written],
    });
}
