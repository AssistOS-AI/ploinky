import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const WEBTTY_RECOVERY_RECORD_SCHEMA = 'ploinky-webtty-recovery/v1';
export const DEFAULT_WEBTTY_RUNTIME_DIRECTORY = '/run/ploinky/webtty';
const MAX_RECORD_BYTES = 16 * 1024;
const RECORD_NAME = /^[a-zA-Z0-9_-]{20,80}\.json$/;

function modeBits(stat) {
    return stat.mode & 0o777;
}

function safeInteger(value) {
    return Number.isSafeInteger(value) && value > 1;
}

function assertIdentity(value, label, { optional = false } = {}) {
    if (optional && value == null) return null;
    if (!value || typeof value !== 'object'
        || !safeInteger(value.pid)
        || !/^linux-proc:\d+$/.test(String(value.startToken || ''))
        || !Number.isSafeInteger(value.uid)
        || value.uid < 0) {
        throw new Error(`${label} identity is invalid`);
    }
    return {
        pid: value.pid,
        startToken: String(value.startToken),
        uid: value.uid,
        ...(safeInteger(value.pgrp) ? { pgrp: value.pgrp } : {}),
        ...(safeInteger(value.session) ? { session: value.session } : {}),
    };
}

function validateRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('record must be an object');
    }
    const allowed = new Set(['schema', 'routerEpoch', 'marker', 'worker', 'pty', 'createdAt', 'cleanupState', 'ptyState']);
    if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error('record has unsupported fields');
    if (value.cleanupState !== undefined && value.cleanupState !== 'unproven') {
        throw new Error('record cleanup state is invalid');
    }
    if (!['worker-only', 'pty-starting', 'pty-ready'].includes(value.ptyState)) {
        throw new Error('record PTY state is invalid');
    }
    if (value.schema !== WEBTTY_RECOVERY_RECORD_SCHEMA
        || !/^[a-zA-Z0-9_-]{16,128}$/.test(String(value.routerEpoch || ''))
        || !/^[a-zA-Z0-9_-]{24,128}$/.test(String(value.marker || ''))
        || !Number.isSafeInteger(value.createdAt)
        || value.createdAt < 1) {
        throw new Error('record metadata is invalid');
    }
    const worker = assertIdentity(value.worker, 'worker');
    const pty = assertIdentity(value.pty, 'pty', { optional: true });
    if (pty && (!safeInteger(pty.pgrp) || !safeInteger(pty.session))) {
        throw new Error('pty process-group evidence is incomplete');
    }
    if ((value.ptyState === 'pty-ready') !== Boolean(pty)) {
        throw new Error('record PTY evidence does not match its state');
    }
    return Object.freeze({
        schema: value.schema,
        routerEpoch: value.routerEpoch,
        marker: value.marker,
        worker,
        pty,
        createdAt: value.createdAt,
        ...(value.cleanupState === 'unproven' ? { cleanupState: 'unproven' } : {}),
        ptyState: value.ptyState,
    });
}

export async function readLinuxProcessIdentity(pid, { procRoot = '/proc' } = {}) {
    if (!safeInteger(pid)) return null;
    try {
        const statPath = path.join(procRoot, String(pid), 'stat');
        const statBefore = await fs.readFile(statPath, 'utf8');
        const [statusText, cmdlineBytes] = await Promise.all([
            fs.readFile(path.join(procRoot, String(pid), 'status'), 'utf8'),
            fs.readFile(path.join(procRoot, String(pid), 'cmdline')),
        ]);
        const statAfter = await fs.readFile(statPath, 'utf8');
        const parseStat = (statText) => {
            const close = statText.lastIndexOf(')');
            if (close < 0) throw new Error('invalid proc stat');
            const fields = statText.slice(close + 2).trim().split(/\s+/);
            return {
                pgrp: Number(fields[2]),
                session: Number(fields[3]),
                rawStartToken: String(fields[19] || ''),
            };
        };
        const before = parseStat(statBefore);
        const after = parseStat(statAfter);
        const uidMatch = statusText.match(/^Uid:\s+(\d+)/m);
        const { pgrp, session, rawStartToken } = after;
        const uid = Number(uidMatch?.[1]);
        if (before.rawStartToken !== rawStartToken) throw new Error('proc identity changed while reading');
        if (!safeInteger(pgrp) || !safeInteger(session) || !/^\d+$/.test(rawStartToken)
            || !Number.isSafeInteger(uid) || uid < 0) throw new Error('incomplete proc identity');
        return {
            pid,
            pgrp,
            session,
            startToken: `linux-proc:${rawStartToken}`,
            uid,
            cmdline: cmdlineBytes.toString('utf8').split('\0').filter(Boolean),
        };
    } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ESRCH') return null;
        throw error;
    }
}

function identityMatches(observed, expected) {
    return Boolean(observed
        && observed.pid === expected.pid
        && observed.uid === expected.uid
        && observed.startToken === expected.startToken
        && (!expected.pgrp || observed.pgrp === expected.pgrp)
        && (!expected.session || observed.session === expected.session));
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RuntimeRecordStore {
    constructor({
        directory = DEFAULT_WEBTTY_RUNTIME_DIRECTORY,
        uid = process.getuid?.() ?? 0,
        readIdentity = readLinuxProcessIdentity,
        signal = process.kill.bind(process),
        graceMs = 750,
    } = {}) {
        this.directory = path.resolve(directory);
        this.uid = uid;
        this.readIdentity = readIdentity;
        this.signal = signal;
        this.graceMs = graceMs;
    }

    async ensureDirectory() {
        try {
            await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
            const stat = await fs.lstat(this.directory);
            if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== this.uid || modeBits(stat) !== 0o700) {
                throw new Error('runtime directory ownership or mode is unsafe');
            }
        } catch (error) {
            error.code ||= 'WEBTTY_RECOVERY_DIRECTORY_UNSAFE';
            throw error;
        }
    }

    async create({ routerEpoch, marker, worker }) {
        await this.ensureDirectory();
        const fileName = `${crypto.createHash('sha256').update(String(marker)).digest('base64url')}.json`;
        const handle = { fileName, record: null };
        await this.update(handle, {
            schema: WEBTTY_RECOVERY_RECORD_SCHEMA,
            routerEpoch,
            marker,
            worker,
            pty: null,
            ptyState: 'worker-only',
            createdAt: Date.now(),
        });
        return handle;
    }

    async update(handle, next) {
        await this.ensureDirectory();
        if (!handle || !RECORD_NAME.test(String(handle.fileName || ''))) throw new Error('invalid record handle');
        const record = validateRecord(next);
        const bytes = Buffer.from(JSON.stringify(record));
        if (bytes.length > MAX_RECORD_BYTES) throw new Error('record is too large');
        const target = path.join(this.directory, handle.fileName);
        const temporary = path.join(this.directory, `.${handle.fileName}.${crypto.randomBytes(8).toString('hex')}`);
        let opened;
        try {
            opened = await fs.open(temporary, 'wx', 0o600);
            await opened.writeFile(bytes);
            await opened.sync();
            await opened.close();
            opened = null;
            await fs.rename(temporary, target);
            handle.record = record;
        } finally {
            try { await opened?.close(); } catch (_) { }
            try { await fs.unlink(temporary); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
        }
        return record;
    }

    async remove(handle) {
        if (!handle || !RECORD_NAME.test(String(handle.fileName || ''))) return false;
        const target = path.join(this.directory, handle.fileName);
        try {
            const stat = await fs.lstat(target);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
                || stat.uid !== this.uid || modeBits(stat) !== 0o600) return false;
            await fs.unlink(target);
            return true;
        } catch (error) {
            if (error?.code === 'ENOENT') return true;
            throw error;
        }
    }

    async markCleanupUnproven(handle) {
        if (!handle?.record) return false;
        await this.update(handle, {
            ...handle.record,
            cleanupState: 'unproven',
        });
        return true;
    }

    async markPtyStarting(handle) {
        if (!handle?.record || handle.record.ptyState !== 'worker-only') return false;
        await this.update(handle, {
            ...handle.record,
            ptyState: 'pty-starting',
        });
        return true;
    }

    async readEntry(fileName) {
        if (!RECORD_NAME.test(fileName)) throw new Error('unexpected recovery directory entry');
        const target = path.join(this.directory, fileName);
        const stat = await fs.lstat(target);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
            || stat.uid !== this.uid || modeBits(stat) !== 0o600 || stat.size > MAX_RECORD_BYTES) {
            throw new Error('unsafe recovery record');
        }
        return validateRecord(JSON.parse(await fs.readFile(target, 'utf8')));
    }

    async signalVerifiedPty(record, signal) {
        const observed = await this.readIdentity(record.pty.pid);
        if (!identityMatches(observed, record.pty)
            || record.pty.pgrp !== record.pty.pid
            || observed.pgrp !== observed.pid
            || observed.session !== record.pty.session) return false;
        this.signal(-observed.pgrp, signal);
        return true;
    }

    async signalVerifiedWorker(record, signal) {
        const observed = await this.readIdentity(record.worker.pid);
        const markerArg = `--ploinky-webtty-marker=${record.marker}`;
        if (!identityMatches(observed, record.worker) || !observed.cmdline?.includes(markerArg)) return false;
        this.signal(observed.pid, signal);
        return true;
    }

    async recoverEntry(fileName, record) {
        if (record.cleanupState === 'unproven') {
            return { recovered: false, category: 'cleanup_unproven' };
        }
        if (record.ptyState === 'pty-starting') {
            return { recovered: false, category: 'pty_startup_unproven' };
        }
        let worker = await this.readIdentity(record.worker.pid);
        let pty = record.pty ? await this.readIdentity(record.pty.pid) : null;
        if (!worker && !pty) {
            await this.remove({ fileName, record });
            return { recovered: true, category: 'dead_record_removed' };
        }
        if (worker) {
            const markerArg = `--ploinky-webtty-marker=${record.marker}`;
            if (!identityMatches(worker, record.worker) || !worker.cmdline.includes(markerArg)) {
                return { recovered: false, category: 'worker_identity_ambiguous' };
            }
            try {
                if (!(await this.signalVerifiedWorker(record, 'SIGTERM'))) {
                    return { recovered: false, category: 'worker_term_revalidation_failed' };
                }
            } catch (error) { if (error?.code !== 'ESRCH') throw error; }
        }
        if (pty) {
            if (!identityMatches(pty, record.pty)
                || record.pty.pgrp !== record.pty.pid
                || pty.pgrp !== pty.pid
                || pty.session !== record.pty.session) {
                return { recovered: false, category: 'pty_identity_ambiguous' };
            }
        }
        await sleep(this.graceMs);
        worker = await this.readIdentity(record.worker.pid);
        pty = record.pty ? await this.readIdentity(record.pty.pid) : null;
        if (worker && identityMatches(worker, record.worker)) {
            try {
                if (!(await this.signalVerifiedWorker(record, 'SIGKILL'))) {
                    return { recovered: false, category: 'worker_force_revalidation_failed' };
                }
            } catch (error) { if (error?.code !== 'ESRCH') throw error; }
        }
        if (pty && !(await this.signalVerifiedPty(record, 'SIGTERM'))) {
            return { recovered: false, category: 'pty_revalidation_failed' };
        }
        if (pty) {
            await sleep(this.graceMs);
            if (await this.readIdentity(record.pty.pid)) {
                if (!(await this.signalVerifiedPty(record, 'SIGKILL'))) {
                    return { recovered: false, category: 'pty_force_revalidation_failed' };
                }
            }
        }
        await sleep(25);
        worker = await this.readIdentity(record.worker.pid);
        pty = record.pty ? await this.readIdentity(record.pty.pid) : null;
        if (worker || pty) return { recovered: false, category: 'process_cleanup_unconfirmed' };
        await this.remove({ fileName, record });
        return { recovered: true, category: 'verified_reclaimed' };
    }

    async recover() {
        try {
            await this.ensureDirectory();
            const entries = await fs.readdir(this.directory);
            const evidence = [];
            for (const fileName of entries) {
                let record;
                try {
                    record = await this.readEntry(fileName);
                } catch (_) {
                    return { ok: false, category: 'record_unprovable', evidence: [...evidence, fileName] };
                }
                const result = await this.recoverEntry(fileName, record);
                evidence.push(result.category);
                if (!result.recovered) return { ok: false, category: result.category, evidence };
            }
            return { ok: true, evidence };
        } catch (error) {
            return { ok: false, category: error?.code || 'recovery_failed', evidence: [] };
        }
    }
}

export default RuntimeRecordStore;
