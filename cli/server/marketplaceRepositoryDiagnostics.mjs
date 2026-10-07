import { createHash } from 'node:crypto';

export const DIAGNOSTIC_LIMITS = Object.freeze({ recordBytes: 4_096, records: 32, bytes: 65_536, emitMs: 5_000 });
const enums = {
    source: ['router', 'supervisor', 'worker'],
    phase: ['receipt', 'baseline', 'launch', 'ownership', 'admission', 'observation', 'settlement', 'release', 'ipc', 'exit', 'closure', 'shutdown', 'cancellation'],
    reason: ['received', 'incomplete', 'unknown', 'mismatch', 'spawn-failed', 'pre-hello-exit', 'abnormal-exit', 'protocol', 'ipc-failed', 'expired', 'closed', 'shutdown', 'recovery', 'release-failed', 'worker-failed', 'writer', 'cohort', 'diagnostic-loss'],
    state: ['pending', 'preparing', 'launched', 'ownership', 'inert', 'acquiring', 'awaiting-admission', 'running', 'settlement-barrier', 'release-granted', 'released', 'cancelling', 'closed'],
    action: ['install_repo', 'uninstall_repo', 'unknown'],
    caller: ['browser-control', 'browser-public', 'agent-assertion', 'direct-cli', 'unknown'],
    graphReadiness: ['unavailable'],
    category: ['permission', 'io', 'unstable', 'disappearance-unconfirmed', 'malformed', 'truncated', 'deadline', 'reader-saturation', 'entry-overflow', 'lineage', 'overlap', 'unknown'],
    field: ['stat', 'namespace', 'status', 'environment', 'argv', 'executable', 'directory', 'identity', 'birth', 'parent', 'group', 'session', 'none'],
    errno: ['EACCES', 'EPERM', 'ENOENT', 'ESRCH', 'EIO', 'EMFILE', 'ENFILE', 'OTHER'],
    mismatch: ['pid', 'birth', 'namespace', 'uids', 'group', 'session', 'executable', 'argv', 'router-missing', 'unknown'],
    signal: ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGABRT', 'SIGSEGV', 'OTHER'],
};
const numbers = new Set(['deadline', 'elapsedMs', 'receivedAt', 'routerElapsedMs', 'graphReadyAt', 'closedAt', 'exitCode', 'records', 'members', 'writers', 'count', 'unknownLoss']);
const booleans = new Set(['routeLease', 'complete', 'connected', 'admitted']);
const hashes = new Set(['workspace', 'generation']);
const increment = value => Math.min(2_147_483_647, value + 1);

export function diagnosticIdentity(value) {
    return typeof value === 'string' && value ? createHash('sha256').update(value).digest('hex') : undefined;
}

export function diagnosticProcessFingerprint(record) {
    try {
        if (!record || typeof record !== 'object' || Array.isArray(record)) return undefined;
        const pid = record.pid;
        const birth = record.birth;
        const namespace = record.namespace;
        const uids = record.uids;
        if (!Number.isSafeInteger(pid) || pid < 1 || pid > 2_147_483_647
            || typeof birth !== 'string' || !/^[1-9][0-9]{0,19}$/.test(birth)
            || typeof namespace !== 'string' || !/^pid:\[[1-9][0-9]{0,19}\]$/.test(namespace)
            || typeof uids !== 'string' || !/^(?:0|[1-9][0-9]{0,9})(?::(?:0|[1-9][0-9]{0,9})){3}$/.test(uids)
            || uids.split(':').some(value => Number(value) > 4_294_967_295)) return undefined;
        return createHash('sha256').update('ploinky:repository-process-subject:v1\0')
            .update(JSON.stringify([pid, birth, namespace, uids])).digest('hex');
    } catch (_) { return undefined; }
}

function unknownSubject(value) {
    try {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        const required = ['category', 'field', 'basis', 'subjectFingerprint'];
        const keys = Object.keys(value);
        if (keys.length < 4 || keys.length > 5 || required.some(key => !Object.hasOwn(value, key))
            || keys.some(key => ![...required, 'errno'].includes(key))) return null;
        const category = value.category;
        const field = value.field;
        const basis = value.basis;
        const subjectFingerprint = value.subjectFingerprint;
        const hasErrno = Object.hasOwn(value, 'errno');
        const errno = hasErrno ? value.errno : undefined;
        if (!enums.category.includes(category) || field !== 'environment' || basis !== 'prior-stable-identity'
            || typeof subjectFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(subjectFingerprint)
            || (hasErrno && !enums.errno.includes(errno))) return null;
        return { category, field, ...(hasErrno ? { errno } : {}), basis, subjectFingerprint };
    } catch (_) { return null; }
}

// A closed schema, not redaction of arbitrary strings. No request, path,
// environment, exception text or child-supplied identity enters retained data.
export function diagnosticPayload(value, depth = 0) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const output = {};
    const keys = Object.keys(value);
    if (keys.length > 32) return null;
    for (const key of keys) {
        const entry = value[key];
        if (Object.hasOwn(enums, key) && enums[key].includes(entry)) output[key] = entry;
        else if (numbers.has(key) && Number.isSafeInteger(entry) && entry >= 0) output[key] = entry;
        else if (booleans.has(key) && typeof entry === 'boolean') output[key] = entry;
        else if (hashes.has(key) && typeof entry === 'string' && /^[a-f0-9]{64}$/.test(entry)) output[key] = entry;
        else if (key === 'firstUnknownSubject' && depth === 0) {
            const subject = unknownSubject(entry);
            if (!subject) return null;
            output[key] = subject;
        } else if (key === 'unknowns' && depth === 0 && Array.isArray(entry) && entry.length <= 24) {
            const rows = entry.map(row => diagnosticPayload(row, 1));
            if (rows.some(row => !row || Object.keys(row).some(name => !['category', 'field', 'errno', 'count'].includes(name)))) return null;
            output[key] = rows;
        } else return null;
    }
    return Buffer.byteLength(JSON.stringify(output)) <= DIAGNOSTIC_LIMITS.recordBytes ? output : null;
}

export function processDiagnostic(error, field = 'identity') {
    const given = diagnosticPayload(error?.diagnostic);
    if (given) return given;
    const errno = enums.errno.includes(error?.code) ? error.code : 'OTHER';
    return { category: ['EACCES', 'EPERM'].includes(errno) ? 'permission' : 'io', field, errno };
}

export function createUnknownSummary() {
    const rows = [];
    let lost = 0;
    let firstUnknownSubject = null;
    return {
        add(value, subjectFingerprint) {
            const safe = diagnosticPayload(value) || { category: 'unknown', field: 'identity' };
            if (!firstUnknownSubject && safe.field === 'environment') {
                firstUnknownSubject = unknownSubject({ category: safe.category, field: safe.field,
                    ...(safe.errno ? { errno: safe.errno } : {}), basis: 'prior-stable-identity', subjectFingerprint });
            }
            const row = rows.find(entry => entry.category === safe.category && entry.field === safe.field && entry.errno === safe.errno);
            if (row) row.count = increment(row.count);
            else if (rows.length < 24) rows.push({ ...safe, count: 1 });
            else lost = increment(lost);
        },
        snapshot: () => ({ unknowns: rows.map(row => ({ ...row })), ...(lost ? { unknownLoss: lost } : {}),
            ...(firstUnknownSubject ? { firstUnknownSubject: { ...firstUnknownSubject } } : {}) }),
    };
}

export function createRepositoryDiagnostics({ now = Date.now, sink = () => {} } = {}) {
    let firstCause = null;
    const recent = [];
    let bytes = 0;
    let loss = 0;
    let suppressed = 0;
    let lastEmission = -Infinity;
    let sinkPending = false;
    const retain = (operationId, value, first = false) => {
        const payload = diagnosticPayload(value);
        if (!/^[a-f0-9-]{36}$/.test(operationId || '') || !payload) { loss = increment(loss); return false; }
        const record = { operationId, ...payload };
        const size = Buffer.byteLength(JSON.stringify(record));
        if (size > DIAGNOSTIC_LIMITS.recordBytes) { loss = increment(loss); return false; }
        if (first && !firstCause) firstCause = structuredClone(record);
        while (recent.length && (recent.length >= DIAGNOSTIC_LIMITS.records || bytes + size > DIAGNOSTIC_LIMITS.bytes)) {
            bytes -= recent.shift().bytes;
            loss = increment(loss);
        }
        recent.push({ record, bytes: size });
        bytes += size;
        return true;
    };
    return {
        retain,
        loss: () => { loss = increment(loss); },
        emit() {
            if (!firstCause) return;
            if (sinkPending || now() - lastEmission < DIAGNOSTIC_LIMITS.emitMs) { suppressed = increment(suppressed); return; }
            lastEmission = now();
            try {
                const result = sink('marketplace_repository_diagnostic', {
                    firstCause: structuredClone(firstCause), recent: recent.map(entry => structuredClone(entry.record)),
                    diagnosticLoss: loss, suppressed,
                });
                if (result === false) loss = increment(loss);
                if (result && typeof result.then === 'function') {
                    sinkPending = true;
                    Promise.resolve(result).then(() => { sinkPending = false; }, () => { sinkPending = false; loss = increment(loss); });
                }
            } catch (_) { loss = increment(loss); }
        },
        snapshot: () => ({ firstCause: structuredClone(firstCause), recent: recent.map(entry => structuredClone(entry.record)), bytes, loss, suppressed }),
    };
}
