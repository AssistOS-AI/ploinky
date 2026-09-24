// Recoverable skill export publication protocol.
//
// This module is shared by value: Ploinky keeps it at
// cli/utils/skills/exportTransaction.mjs and Explorer keeps a byte-identical
// copy at explorer/utils/server/skill-export-transaction.mjs. It may only
// import Node built-ins so that both copies stay identical; each repository
// injects its own link factory. Conformance tests compare the two files.
//
// Layout below `<folder>/.agents`:
//   .ploinky-skill-exports.json          committed ownership ledger (v1)
//   .ploinky-skill-exports.lock/         mutual exclusion; owner.json inside
//   .ploinky-skill-exports.journal.json  pending intent (never ownership)
//   .ploinky-export-staging/tx-<id>/     generated, unpublished staging
//   .ploinky-export-backups/             retained prior/concurrent output
//   .ploinky-export-quarantine/          transactions needing a human
//
// Publication is serialized and recoverable, not one atomic rename visible
// to arbitrary readers. Paths are published first; the ledger publication is
// the commit point for ownership. A pending journal before that point is
// rolled back, after it rolled forward, each step only while the current
// filesystem state matches the recorded transaction evidence.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';

export const EXPORT_PROTOCOL = 'ploinky-skill-exports';
export const EXPORT_PROTOCOL_VERSION = 1;
export const EXPORT_LEDGER = '.ploinky-skill-exports.json';
export const EXPORT_LOCK = '.ploinky-skill-exports.lock';
export const EXPORT_JOURNAL = '.ploinky-skill-exports.journal.json';
export const EXPORT_STAGING = '.ploinky-export-staging';
export const EXPORT_BACKUPS = '.ploinky-export-backups';
export const EXPORT_QUARANTINE = '.ploinky-export-quarantine';
export const MARKETPLACE_OWNER = 'marketplace';

// Ordinary preserved user output is a successful no-op. An incomplete or
// quarantined publication is different and must survive API/result mapping.
export function skillExportRecoveryProblem(result) {
    const transaction = result?.transaction;
    const recovery = result?.recovery;
    const problems = [];
    if (transaction?.status && !['committed', 'unchanged'].includes(transaction.status)) problems.push(`transaction ${transaction.status}`);
    if (recovery?.status && !['none', 'rolled-forward', 'rolled-back'].includes(recovery.status)) problems.push(`recovery ${recovery.status}`);
    if ((result?.diagnostics || []).some(entry => entry.reason === 'transaction-quarantined')) problems.push('quarantined publication');
    return problems.length ? {
        code: 'SKILL_EXPORT_RECOVERY_REQUIRED',
        reason: `Skill export is incomplete: ${[...new Set(problems)].join(', ')}. Existing state is preserved for recovery.`,
        transaction: typeof transaction === 'object' ? transaction : transaction || null,
        recovery: recovery || null,
    } : null;
}
export const SIMULATED_CRASH = Symbol.for('ploinky.skillExports.simulatedCrash');
export const CRASH_POINTS = Object.freeze([
    'before-journal',
    'after-journal',
    'after-backup',
    'after-link',
    'before-metadata',
    'after-metadata-journal',
    'after-ledger',
    'after-manifest',
    'after-claude',
    'after-gitignore',
    'after-receipt',
    'after-private-file',
    'after-git-config',
    'before-commit',
    'after-commit',
]);

const LOCK_OWNER = 'owner.json';
const GIT_CONFIG_LOCK = 'ploinky-skill-exports-config.lock';
const IGNORE_RECEIPT = path.join('.agents', '.ploinky-ignore-receipt.json');
const MANAGED_EXCLUDES = 'ploinky-skill-exports.exclude';
const COMPOSITION_RECORD = 'ploinky-skill-exports.exclusions.json';
const GIT_CONFIG_KEYS = new Set(['extensions.worktreeConfig', 'core.excludesFile', 'core.worktree', 'core.bare']);
const CONTENT_KINDS = new Set(['ledger', 'manifest', 'gitignore', 'receipt', 'private-file']);
const RECLAIM = '.reclaim';
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const TRANSACTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BACKUP_NAME = /^(.+)-(prior|concurrent|rollback)-tx-([0-9a-f-]{36})(?:-\d+)?$/;
const DEFAULT_WAIT_MS = 2_000;
const MAX_WAIT_MS = 60_000;
const DEFAULT_POLL_MS = 25;

export function skillExportError(code, message, extra = {}) {
    return Object.assign(new Error(message), { code, ...extra });
}

const exists = value => {
    try { fs.lstatSync(value); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
};
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fileId = stat => `${stat.dev}:${stat.ino}`;

// Hash bytes, membership and modes; timestamps do not establish ownership.
export function skillTreeDigest(root) {
    const hash = crypto.createHash('sha256');
    const visit = (target, relative) => {
        const stat = fs.lstatSync(target);
        const type = stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : stat.isSymbolicLink() ? 'symlink' : '';
        if (!type) throw new Error(`Unsupported skill entry: ${target}`);
        hash.update(JSON.stringify([relative, type, stat.mode & 0o777]));
        if (type === 'file') hash.update(crypto.createHash('sha256').update(fs.readFileSync(target)).digest());
        if (type === 'symlink') hash.update(JSON.stringify(fs.readlinkSync(target)));
        if (type === 'directory') for (const name of fs.readdirSync(target).sort()) visit(path.join(target, name), `${relative}/${name}`);
    };
    visit(root, '');
    return hash.digest('hex');
}

export function copyFreshSkillTree(source, destination) {
    const stat = fs.lstatSync(source);
    if (stat.isDirectory()) {
        fs.mkdirSync(destination, { mode: 0o700 });
        for (const name of fs.readdirSync(source).sort()) copyFreshSkillTree(path.join(source, name), path.join(destination, name));
        fs.chmodSync(destination, stat.mode & 0o777);
    } else if (stat.isFile()) {
        // Create with owner access first; recursive native cp has exposed
        // transient unreadable modes on macOS virtiofs-backed Box mounts.
        fs.closeSync(fs.openSync(destination, 'wx', 0o600));
        fs.copyFileSync(source, destination);
        fs.chmodSync(destination, stat.mode & 0o777);
    } else if (stat.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(source), destination);
    else throw new Error(`Unsupported skill entry: ${source}`);
}

// Default link factory: relative to the final skills directory.
export function relativeSkillLink(staged, target, root, skills) {
    fs.symlinkSync(path.relative(skills, target), staged, 'dir');
}

function realDirectory(target, create) {
    if (!exists(target)) {
        if (!create) return false;
        fs.mkdirSync(target);
    }
    if (!fs.lstatSync(target).isDirectory()) throw new Error(`Skill export directory must be a real directory: ${target}`);
    return true;
}

export function exportRoots(folder, { create = true } = {}) {
    if (create) fs.mkdirSync(folder, { recursive: true });
    let root;
    try {
        root = fs.realpathSync(folder);
    } catch (error) {
        // Without creation a missing folder simply owns nothing.
        if (!create && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return null;
        throw error;
    }
    const agents = path.join(root, '.agents');
    if (!realDirectory(agents, create)) return null;
    const skills = path.join(agents, 'skills');
    if (!realDirectory(skills, create)) return null;
    return { root, agents, skills };
}

export function readExportLedger(agents) {
    const filename = path.join(agents, EXPORT_LEDGER);
    const bytes = readBytes(filename, 'Skill ownership ledger');
    if (bytes === null) return { ledger: { version: 1, entries: Object.create(null) }, bytes: null };
    const ledger = JSON.parse(bytes.toString('utf8'));
    if (ledger.version !== 1 || !ledger.entries || typeof ledger.entries !== 'object' || Array.isArray(ledger.entries)) throw new Error(`Unsupported skill ownership ledger: ${filename}`);
    ledger.entries = Object.assign(Object.create(null), ledger.entries);
    return { ledger, bytes };
}

const serializeLedger = ledger => Buffer.from(`${JSON.stringify(ledger, null, 2)}\n`);

function readBytes(filename, label = 'File') {
    let fd;
    try { fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
    catch (error) {
        if (error.code === 'ENOENT') return null;
        if (error.code === 'ELOOP') throw skillExportError('SKILL_EXPORT_NOT_REGULAR_FILE', `${label} is not a regular file: ${filename}`);
        throw error;
    }
    try {
        if (!fs.fstatSync(fd).isFile()) throw skillExportError('SKILL_EXPORT_NOT_REGULAR_FILE', `${label} is not a regular file: ${filename}`);
        return fs.readFileSync(fd);
    } finally { fs.closeSync(fd); }
}

const toBuffer = value => value === null || value === undefined ? null : Buffer.isBuffer(value) ? value : Buffer.from(String(value));
const sameBytes = (left, right) => (left === null || right === null) ? left === right : left.equals(right);

function syncDirectory(directory) {
    let fd;
    try { fd = fs.openSync(directory, 'r'); fs.fsyncSync(fd); } catch (_) { /* not supported everywhere */ } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function writeDurable(filename, bytes, mode = 0o600) {
    const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
    const fd = fs.openSync(temporary, 'wx', mode);
    try { fs.writeSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try { fs.renameSync(temporary, filename); } catch (error) { fs.rmSync(temporary, { force: true }); throw error; }
    syncDirectory(path.dirname(filename));
}

function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, ms));
}

// ---------------------------------------------------------------------------
// Process identity and lock liveness.

function readProcessStart(pid) {
    try {
        if (process.platform === 'linux') {
            const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
            const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
            return fields[19] ? `linux-proc:${fields[19]}` : '';
        }
        if (process.platform === 'darwin') {
            const started = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
                encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1_000,
            }).trim().replace(/\s+/g, ' ');
            return started ? `darwin-ps:${started}` : '';
        }
    } catch (_) {}
    return '';
}

let cachedIdentity = null;
function readCurrentIdentity() {
    if (cachedIdentity?.pid === process.pid) return cachedIdentity;
    let boot = '';
    let namespace = '';
    try {
        if (process.platform === 'linux') {
            boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
            namespace = fs.readlinkSync('/proc/self/ns/pid');
        } else if (process.platform === 'darwin') {
            boot = execFileSync('/usr/sbin/sysctl', ['-n', 'kern.boottime'], {
                encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1_000,
            }).trim();
            namespace = `darwin:${os.hostname()}`;
        }
    } catch (_) {}
    const container = ['/run/.containerenv', '/.dockerenv'].some(marker => { try { return fs.existsSync(marker); } catch (_) { return false; } });
    cachedIdentity = { pid: process.pid, start: readProcessStart(process.pid), boot, namespace, hostname: os.hostname(), container };
    return cachedIdentity;
}

export function currentSkillExportIdentity() {
    return { ...readCurrentIdentity() };
}

function processAlive(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

// Tests and supervisors may inject authoritative liveness evidence.
function livenessOf(options = {}) {
    const injected = options.liveness || {};
    return {
        current: injected.current || readCurrentIdentity,
        alive: injected.alive || processAlive,
        start: injected.start || readProcessStart,
    };
}

// live: the owner provably runs. dead: affirmative same-namespace evidence of
// termination or PID reuse. unknown: another boot/namespace/host, where local
// PID absence proves nothing. ownerless/foreign: never reclaimed here.
export function classifyLockOwner(owner, options = {}) {
    if (!owner) return 'ownerless';
    if (owner.protocol !== EXPORT_PROTOCOL || owner.version !== EXPORT_PROTOCOL_VERSION || typeof owner.token !== 'string') return 'foreign';
    const liveness = livenessOf(options);
    const self = liveness.current();
    if (!self.boot || !self.namespace || owner.boot !== self.boot || owner.namespace !== self.namespace) return 'unknown';
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) return 'foreign';
    if (!liveness.alive(owner.pid)) return 'dead';
    const start = owner.start ? liveness.start(owner.pid) : '';
    if (owner.start && start && owner.start !== start) return 'dead';
    return 'live';
}

function readLockState(lockPath) {
    let directory;
    try { directory = fs.lstatSync(lockPath); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!directory.isDirectory()) return { directory, owner: null, invalid: true };
    const ownerPath = path.join(lockPath, LOCK_OWNER);
    let stat;
    let bytes;
    try {
        stat = fs.lstatSync(ownerPath);
        if (!stat.isFile()) return { directory, owner: null };
        bytes = fs.readFileSync(ownerPath);
    } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { directory, owner: null };
        throw error;
    }
    let owner = null;
    try { owner = JSON.parse(bytes.toString('utf8')); } catch (_) {}
    return { directory, stat, bytes, owner: owner && typeof owner === 'object' && !Array.isArray(owner) ? owner : null };
}

export function inspectSkillExportLock(folder, options = {}) {
    const root = fs.realpathSync(folder);
    const lockPath = path.join(root, '.agents', EXPORT_LOCK);
    const state = readLockState(lockPath);
    if (!state) return { state: 'free', lockPath };
    const classification = state.invalid ? 'foreign' : classifyLockOwner(state.owner, options);
    return { state: classification, lockPath, owner: state.owner };
}

function blockedError(state, lockPath, owner) {
    const who = owner?.pid ? ` held by pid ${owner.pid}${owner.hostname ? ` on ${owner.hostname}` : ''}` : '';
    if (state === 'ownerless') {
        return skillExportError('SKILL_EXPORT_LOCK_OWNERLESS',
            `Skill export lock has no owner record (legacy or interrupted exporter); it is preserved and never reclaimed by age. Stop every exporter for this folder, verify none is running, then remove the lock directory: ${lockPath}`,
            { outcome: 'blocked-legacy-lock', lockPath });
    }
    if (state === 'unknown') {
        return skillExportError('SKILL_EXPORT_LOCK_UNKNOWN_OWNER',
            `Skill export lock${who} belongs to another boot, host or PID namespace; its liveness cannot be proven here. Recovery requires the owning runtime to finish or be proven terminated: ${lockPath}`,
            { outcome: 'blocked-unknown-owner', lockPath, owner });
    }
    if (state === 'foreign') {
        return skillExportError('SKILL_EXPORT_LOCK_FOREIGN',
            `Skill export lock has an unsupported owner record; it is preserved: ${lockPath}`,
            { outcome: 'blocked-foreign-lock', lockPath });
    }
    if (state === 'reclaim-pending') {
        return skillExportError('SKILL_EXPORT_LOCK_RECOVERY_REQUIRED',
            `Skill export lock${who} belongs to a terminated owner but another reclaim is pending; inspect ${path.join(lockPath, RECLAIM)}: ${lockPath}`,
            { outcome: 'recovery-required', lockPath, owner });
    }
    return skillExportError('SKILL_EXPORT_LOCK_BUSY',
        `Skill export already active${who}; retry after it finishes: ${lockPath}`,
        { outcome: 'blocked-busy', lockPath, owner });
}

// Remove a lock only while it still is the exact dead owner's lock. The
// reclaim marker, created inside that lock directory, excludes other
// reclaimers; a fresh lock never carries a matching owner fingerprint.
function reclaimDeadLock(lockPath, observed, options) {
    const marker = path.join(lockPath, RECLAIM);
    options.hooks?.beforeReclaim?.({ lockPath });
    try { fs.mkdirSync(marker); } catch (error) {
        if (error.code === 'EEXIST') return 'reclaim-pending';
        if (error.code === 'ENOENT') return 'released';
        throw error;
    }
    let markerRemoved = false;
    try {
        const current = readLockState(lockPath);
        if (!current?.stat || fileId(current.directory) !== fileId(observed.directory)
            || fileId(current.stat) !== fileId(observed.stat) || !current.bytes.equals(observed.bytes)) return 'changed';
        fs.unlinkSync(path.join(lockPath, LOCK_OWNER));
        fs.rmdirSync(marker);
        markerRemoved = true;
        try { fs.rmdirSync(lockPath); } catch (error) {
            if (error.code === 'ENOENT') return 'released';
            throw skillExportError('SKILL_EXPORT_LOCK_RECOVERY_REQUIRED',
                `Terminated skill export lock contains unexpected entries and is preserved: ${lockPath}`, { outcome: 'recovery-required', lockPath });
        }
        return 'reclaimed';
    } finally {
        if (!markerRemoved) { try { fs.rmdirSync(marker); } catch (_) {} }
    }
}

class SkillExportLock {
    constructor(fields) { Object.assign(this, fields); this.released = false; this.abandoned = false; }

    assertHeld() {
        const current = this.released ? null : readLockState(this.lockPath);
        if (!current || fileId(current.directory) !== this.lockId || current.owner?.token !== this.token) {
            throw skillExportError('SKILL_EXPORT_LOCK_LOST', `Skill export lock is no longer held by this transaction: ${this.lockPath}`, { outcome: 'lock-lost' });
        }
    }

    release() {
        if (this.released || this.abandoned) return;
        this.assertHeld();
        fs.unlinkSync(path.join(this.lockPath, LOCK_OWNER));
        for (let attempt = 0; ; attempt++) {
            try { fs.rmdirSync(this.lockPath); break; } catch (error) {
                // A reclaimer that judged a stale fingerprint removes its marker promptly.
                if (error.code !== 'ENOTEMPTY' || attempt >= 40) throw error;
                sleepSync(DEFAULT_POLL_MS);
            }
        }
        this.released = true;
    }
}

function acquireLockDirectory(lockPath, target, options) {
    const waitMs = Math.max(0, Math.min(MAX_WAIT_MS, Number.isFinite(options.waitMs) ? options.waitMs : DEFAULT_WAIT_MS));
    const pollMs = Math.max(1, Number.isFinite(options.pollMs) ? options.pollMs : DEFAULT_POLL_MS);
    const deadline = Date.now() + waitMs;
    const liveness = livenessOf(options);
    for (;;) {
        try {
            fs.mkdirSync(lockPath, { mode: 0o700 });
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
            const observed = readLockState(lockPath);
            if (!observed) continue;
            let state = observed.invalid ? 'foreign' : classifyLockOwner(observed.owner, options);
            if (state === 'dead') {
                const reclaimed = reclaimDeadLock(lockPath, observed, options);
                if (reclaimed === 'reclaimed' || reclaimed === 'released' || reclaimed === 'changed') continue;
                state = reclaimed;
            }
            if (Date.now() >= deadline) throw blockedError(state, lockPath, observed.owner);
            sleepSync(Math.min(pollMs, Math.max(1, deadline - Date.now())));
            continue;
        }
        const self = liveness.current();
        const owner = {
            protocol: EXPORT_PROTOCOL,
            version: EXPORT_PROTOCOL_VERSION,
            token: crypto.randomUUID(),
            folder: target,
            folderId: fileId(fs.statSync(target)),
            executor: options.executor ?? null,
            authority: options.authority ?? null,
            hostname: self.hostname ?? os.hostname(),
            container: Boolean(self.container),
            boot: self.boot || '',
            namespace: self.namespace || '',
            pid: self.pid,
            start: self.start || '',
            acquiredAt: new Date().toISOString(),
        };
        try {
            writeDurable(path.join(lockPath, LOCK_OWNER), `${JSON.stringify(owner, null, 2)}\n`);
        } catch (error) {
            try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch (_) {}
            throw error;
        }
        return { lockPath, lockId: fileId(fs.lstatSync(lockPath)), token: owner.token, owner };
    }
}

export function acquireSkillExportLock(folder, options = {}) {
    const roots = exportRoots(folder, { create: true });
    const lock = acquireLockDirectory(path.join(roots.agents, EXPORT_LOCK), roots.root, options);
    return new SkillExportLock({ ...roots, ...lock, options });
}

// Serializes Ploinky changes to one repository's common Git configuration
// (extensions.worktreeConfig and its migration). Same owner-record format.
export function acquireGitConfigLock(commonDir, options = {}) {
    const directory = fs.realpathSync(commonDir);
    if (options.exclusions?.hostBoundary) {
        const relative = path.relative(options.exclusions.hostBoundary, directory);
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw skillExportError('SKILL_EXPORT_HOST_BOUNDARY', 'Git configuration lock resolves outside the workspace');
    }
    if (!fs.lstatSync(directory).isDirectory()) throw new Error(`Git common directory is not a directory: ${directory}`);
    const lock = acquireLockDirectory(path.join(directory, GIT_CONFIG_LOCK), directory, options);
    return new SkillExportLock({ root: directory, key: directory, ...lock, options });
}

// Lock order: the caller's workspace mutation authority (already held),
// then common-Git metadata locks, then every target export lock, each set in
// canonical order. All targets of a batch are held before any publication.
export function withSkillExportLocks(folders, callback, options = {}) {
    const targets = [];
    const seen = new Set();
    for (const folder of folders) {
        options.exclusions?.assertSafeTarget?.(folder);
        if (options.exclusions?.hostBoundary && exists(path.join(folder, '.agents', EXPORT_JOURNAL))) {
            throw skillExportError('SKILL_EXPORT_RECOVERY_REQUIRED', 'A pending skill export must be recovered by its confined executor before host exclusions can be refreshed.');
        }
        const roots = exportRoots(folder, { create: options.create !== false });
        if (!roots || seen.has(roots.root)) continue;
        seen.add(roots.root);
        targets.push(roots.root);
    }
    targets.sort();
    // Exclusion planning, and recovery of a journal holding Git config
    // changes, may change common Git config; that lock comes first.
    const discovered = new Set(options.exclusions?.commonDir ? targets.map(target => options.exclusions.commonDir(target)).filter(Boolean) : []);
    for (const target of targets) {
        if (options.exclusions?.hostBoundary) continue;
        const pending = peekJournalCommonDir(target);
        if (pending) discovered.add(pending);
    }
    const explicit = new Set(options.gitMetadataLocks || []);
    const gitLocks = [...new Set([...explicit, ...discovered])].sort();
    const acquireGit = options.acquireGitMetadataLock || (key => acquireGitConfigLock(key, options));
    const held = [];
    const handles = [];
    const heldGit = [];
    try {
        for (const key of gitLocks) {
            try {
                held.push(acquireGit(key));
                heldGit.push(key);
            } catch (error) {
                // An unwritable Git directory only defers exclusions; the
                // planner reports it because the lock is not held.
                if (explicit.has(key) || !['EACCES', 'EPERM', 'EROFS', 'ENOENT'].includes(error.code)) throw error;
            }
        }
        for (const target of targets) {
            options.exclusions?.assertSafeTarget?.(target);
            const handle = acquireSkillExportLock(target, options);
            handle.assertSafeTarget = () => options.exclusions?.assertSafeTarget?.(target);
            handle.gitLocks = heldGit;
            held.push(handle);
            handles.push(handle);
        }
        for (const handle of handles) {
            handle.assertSafeTarget();
            if (options.exclusions?.hostBoundary && exists(journalPath(handle))) {
                throw skillExportError('SKILL_EXPORT_RECOVERY_REQUIRED', 'A pending skill export appeared before host exclusions refresh; confined recovery is required.');
            }
            handle.recovery = recoverSkillExportTransaction(handle, options);
        }
        return callback(handles);
    } finally {
        // A simulated crash abandons every lock of the batch, as a dead process would.
        if (handles.some(handle => handle.abandoned)) held.length = 0;
        let releaseError = null;
        for (const lock of held.reverse()) {
            try { lock.release(); } catch (error) { releaseError ||= error; }
        }
        if (releaseError) throw releaseError;
    }
}

// ---------------------------------------------------------------------------
// Evidence.

function pathEvidence(target) {
    const stat = fs.lstatSync(target, { throwIfNoEntry: false });
    if (!stat) return { type: 'absent' };
    const type = stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other';
    const evidence = { type, inode: fileId(stat) };
    if (type === 'symlink') evidence.target = fs.readlinkSync(target);
    try {
        if (type === 'symlink' || type === 'directory') evidence.digest = skillTreeDigest(target);
        else if (type === 'file') evidence.digest = sha256(fs.readFileSync(target));
    } catch (_) { evidence.digest = null; }
    return evidence;
}

function evidenceMatches(current, expected) {
    if (!expected) return false;
    if (expected.type === 'absent') return current.type === 'absent';
    if (current.type !== expected.type || current.digest !== expected.digest || !current.digest) return false;
    if ((current.target ?? null) !== (expected.target ?? null)) return false;
    return !expected.inode || current.inode === expected.inode;
}

const contentEvidence = bytes => bytes === null ? { type: 'absent' } : { type: 'file', digest: sha256(bytes) };

function currentContent(filename) {
    const stat = fs.lstatSync(filename, { throwIfNoEntry: false });
    if (!stat) return { type: 'absent' };
    if (!stat.isFile()) return { type: stat.isSymbolicLink() ? 'symlink' : 'other' };
    return contentEvidence(readBytes(filename));
}

const contentMatches = (current, expected) => current.type === expected.type && (current.type === 'absent' || current.digest === expected.digest);

function linkEvidence(target) {
    const stat = fs.lstatSync(target, { throwIfNoEntry: false });
    if (!stat) return { type: 'absent' };
    if (!stat.isSymbolicLink()) return { type: stat.isDirectory() ? 'directory' : 'other' };
    return { type: 'symlink', target: fs.readlinkSync(target) };
}

const linkMatches = (current, expected) => current.type === expected.type && (current.target ?? null) === (expected.target ?? null);

// ---------------------------------------------------------------------------
// Journal.

function journalPath(handle) { return path.join(handle.agents, EXPORT_JOURNAL); }

function artifactTarget(handle, artifact) {
    if (artifact.kind === 'ledger') return path.join(handle.agents, EXPORT_LEDGER);
    if (artifact.kind === 'manifest' && typeof artifact.path === 'string' && path.isAbsolute(artifact.path)) return artifact.path;
    // Private Git files and config live in the validated Git directories.
    if (artifact.kind === 'private-file' || artifact.kind === 'git-config') return artifact.path;
    return resolveInside(handle.root, artifact.path);
}

// ---------------------------------------------------------------------------
// Git config artifacts (local exclusion policy).

function git(args, cwd, input) {
    const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' };
    for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY']) delete env[name];
    const result = spawnSync('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, env, input, encoding: 'utf8', timeout: 30000 });
    if (result.error) throw result.error;
    return result;
}

function gitConfigValues(file, key, cwd) {
    const bytes = readBytes(file, 'Git configuration');
    return gitConfigValuesFromBytes(bytes, key, cwd);
}

function gitConfigValuesFromBytes(bytes, key, cwd) {
    if (bytes === null) return [];
    const result = git(['config', '--no-includes', '--file', '-', '--get-all', key], cwd, bytes);
    if (result.status === 1) return [];
    if (result.status !== 0) throw new Error(`git config --get-all ${key} failed: ${result.stderr.trim()}`);
    return result.stdout.split('\n').filter(value => value !== '');
}

const sameValues = (left, right) => left.length === right.length && left.every((value, index) => value === right[index]);

function applyGitConfig(handle, artifact) {
    handle.assertSafeTarget?.();
    // The common-directory lock serializes exporters. Git's own per-file
    // lock also excludes ordinary `git config` writers through publication.
    const lockPath = `${artifact.path}.lock`;
    let descriptor;
    try {
        descriptor = fs.openSync(lockPath, fs.constants.O_WRONLY | fs.constants.O_CREAT
            | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    } catch (error) {
        if (error.code === 'EEXIST') throw skillExportError('SKILL_EXPORT_GIT_CONFIG_BUSY',
            `Git configuration is locked by another writer: ${lockPath}; the lock is preserved.`);
        throw error;
    }
    const identity = fileId(fs.fstatSync(descriptor));
    const ownsLock = () => {
        const stat = fs.lstatSync(lockPath, { throwIfNoEntry: false });
        return Boolean(stat?.isFile() && fileId(stat) === identity);
    };
    let temporary;
    try {
        const before = readBytes(artifact.path, 'Git configuration');
        const current = gitConfigValuesFromBytes(before, artifact.key, handle.root);
        if (sameValues(current, artifact.after.values)) return true;
        if (!sameValues(current, artifact.before.values)) return false;
        // Parse and edit only a private copy, never a mutable destination link.
        temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-export-config-'));
        const staged = path.join(temporary, 'config');
        fs.writeFileSync(staged, before || Buffer.alloc(0), { mode: 0o600 });
        const args = artifact.after.values.length
            ? ['config', '--no-includes', '--file', staged, '--replace-all', artifact.key, artifact.after.values[0]]
            : ['config', '--no-includes', '--file', staged, '--unset-all', artifact.key];
        const result = git(args, temporary);
        if (result.status !== 0 && !(result.status === 5 && !artifact.after.values.length)) throw new Error(`Git configuration edit failed: ${result.stderr.trim()}`);
        handle.assertSafeTarget?.();
        const stat = fs.lstatSync(artifact.path, { throwIfNoEntry: false });
        if (!contentMatches(currentContent(artifact.path), contentEvidence(before))) return false;
        if (!ownsLock()) throw skillExportError('SKILL_EXPORT_GIT_CONFIG_LOCK_LOST', `Git configuration lock changed: ${lockPath}`);
        fs.writeFileSync(descriptor, fs.readFileSync(staged));
        fs.fchmodSync(descriptor, stat ? stat.mode & 0o777 : 0o600);
        fs.fsyncSync(descriptor);
        handle.assertSafeTarget?.();
        if (!ownsLock()) throw skillExportError('SKILL_EXPORT_GIT_CONFIG_LOCK_LOST', `Git configuration lock changed: ${lockPath}`);
        if (!contentMatches(currentContent(artifact.path), contentEvidence(before))) return false;
        fs.renameSync(lockPath, artifact.path);
        syncDirectory(path.dirname(artifact.path));
        return true;
    } finally {
        // Pin our inode until the ownership check and removal complete, even
        // if another writer has already replaced the newly published config.
        try { if (ownsLock()) fs.unlinkSync(lockPath); }
        finally {
            if (descriptor !== undefined) fs.closeSync(descriptor);
            if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
        }
    }
}

// Re-resolve the target's Git directories; journal paths must match them.
function currentGitIdentity(root) {
    const result = git(['rev-parse', '--path-format=absolute', '--absolute-git-dir', '--git-common-dir', '--git-path', 'config.worktree'], root);
    if (result.status !== 0) return null;
    const canonical = value => { try { return fs.realpathSync(value); } catch (_) { return path.resolve(value); } };
    const [gitDir, commonDir, worktreeConfig] = result.stdout.split('\n').map(value => value.trim());
    return { gitDir: canonical(gitDir), commonDir: canonical(commonDir), worktreeConfig: path.join(canonical(path.dirname(worktreeConfig)), path.basename(worktreeConfig)) };
}

function writeJournal(handle, journal) {
    writeDurable(journalPath(handle), `${JSON.stringify(journal, null, 2)}\n`);
}

function resolveInside(root, relative) {
    if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) {
        throw skillExportError('SKILL_EXPORT_RECOVERY_REQUIRED', `Skill export journal contains an unsafe path: ${relative}`, { outcome: 'recovery-required' });
    }
    return path.join(root, relative);
}

function readJournal(handle) {
    const filename = journalPath(handle);
    let bytes;
    try { bytes = readBytes(filename, 'Skill export journal'); } catch (error) {
        throw skillExportError('SKILL_EXPORT_RECOVERY_REQUIRED', `${error.message}; it is preserved.`, { outcome: 'recovery-required' });
    }
    if (bytes === null) return null;
    let journal;
    try { journal = JSON.parse(bytes.toString('utf8')); } catch (_) { journal = null; }
    if (!journal || journal.protocol !== EXPORT_PROTOCOL || journal.version !== EXPORT_PROTOCOL_VERSION
        || !TRANSACTION_ID.test(journal.transaction || '') || !Array.isArray(journal.paths) || !Array.isArray(journal.artifacts)) {
        throw skillExportError('SKILL_EXPORT_RECOVERY_REQUIRED',
            `Skill export journal is unreadable or from an unsupported protocol; it is preserved and new publication is blocked: ${filename}`,
            { outcome: 'recovery-required', journal: filename });
    }
    validateJournalLayout(handle, journal, filename);
    return journal;
}

const EVIDENCE_TYPES = new Set(['absent', 'symlink', 'directory', 'file', 'other', 'config']);
const CLAUDE_LINKS = { '.claude': '.agents', [path.join('.claude', 'skills')]: '../.agents/skills' };

// Recovery acts only on the fixed layout this protocol writes. Any other path
// in a journal (corruption or tampering) blocks recovery with nothing touched.
function validateJournalLayout(handle, journal, filename) {
    const reject = detail => {
        throw skillExportError('SKILL_EXPORT_RECOVERY_REQUIRED',
            `Skill export journal does not match the export layout (${detail}); it is preserved and new publication is blocked: ${filename}`,
            { outcome: 'recovery-required', journal: filename });
    };
    const realDirectoryIfPresent = (target, label) => {
        const stat = fs.lstatSync(target, { throwIfNoEntry: false });
        if (stat && (!stat.isDirectory() || fs.realpathSync(target) !== target)) reject(`${label} is not a real directory`);
    };
    const evidence = value => value && typeof value === 'object' && EVIDENCE_TYPES.has(value.type);
    if (!['prepared', 'metadata'].includes(journal.phase)) reject('phase');
    const staging = path.join('.agents', EXPORT_STAGING, `tx-${journal.transaction}`);
    if (journal.staging !== staging) reject('staging');
    realDirectoryIfPresent(path.join(handle.agents, EXPORT_STAGING), 'staging root');
    realDirectoryIfPresent(path.join(handle.root, staging), 'staging');
    realDirectoryIfPresent(path.join(handle.agents, EXPORT_BACKUPS), 'backups root');
    const backupPattern = name => new RegExp(`^${name.replace(/[.]/g, '\\.')}-(prior|concurrent|rollback)-tx-${journal.transaction}(-\\d+)?$`);
    const names = new Set();
    for (const entry of journal.paths) {
        if (!entry || typeof entry !== 'object' || !SKILL_NAME.test(entry.name || '') || names.has(entry.name)) reject('path name');
        names.add(entry.name);
        if (entry.destination !== path.join('.agents', 'skills', entry.name)) reject(`destination of ${entry.name}`);
        if (entry.backup !== null && (typeof entry.backup !== 'string' || path.dirname(entry.backup) !== path.join('.agents', EXPORT_BACKUPS)
            || !backupPattern(entry.name).test(path.basename(entry.backup)))) reject(`backup of ${entry.name}`);
        if (entry.staged !== null && entry.staged !== path.join(staging, entry.name)) reject(`staging of ${entry.name}`);
        if (!evidence(entry.before) || !evidence(entry.after)) reject(`evidence of ${entry.name}`);
    }
    const seen = new Set();
    let identity;
    const gitIdentity = () => {
        if (identity === undefined) {
            identity = currentGitIdentity(handle.root);
            const recorded = journal.config?.identity;
            if (!identity || !recorded || recorded.gitDir !== identity.gitDir || recorded.commonDir !== identity.commonDir || recorded.worktreeConfig !== identity.worktreeConfig) reject('Git directories changed');
        }
        return identity;
    };
    for (const artifact of journal.artifacts) {
        if (!artifact || typeof artifact !== 'object' || !(CONTENT_KINDS.has(artifact.kind) || ['claude', 'git-config'].includes(artifact.kind))) reject('artifact kind');
        const key = JSON.stringify([artifact.kind, artifact.path, artifact.key ?? null]);
        if (seen.has(key)) reject('duplicate artifact');
        seen.add(key);
        if (!evidence(artifact.before) || !evidence(artifact.after)) reject(`${artifact.kind} evidence`);
        if (CONTENT_KINDS.has(artifact.kind)) {
            const expected = artifact.after.type === 'absent' ? null : path.join(staging, `artifact-${artifact.kind}${artifact.kind === 'private-file' ? `-${path.basename(artifact.path)}` : ''}`);
            if (artifact.staged !== expected) reject(`${artifact.kind} staging`);
        }
        if (artifact.kind === 'ledger' && artifact.path !== null) reject('ledger path');
        if (artifact.kind === 'gitignore' && artifact.path !== '.gitignore') reject('gitignore path');
        if (artifact.kind === 'receipt' && artifact.path !== IGNORE_RECEIPT) reject('receipt path');
        if (artifact.kind === 'private-file') {
            const { gitDir } = gitIdentity();
            if (![MANAGED_EXCLUDES, COMPOSITION_RECORD].some(name => artifact.path === path.join(gitDir, name))) reject('private file path');
        }
        if (artifact.kind === 'git-config') {
            const { commonDir, worktreeConfig } = gitIdentity();
            if (![path.join(commonDir, 'config'), path.join(commonDir, 'config.worktree'), worktreeConfig].includes(artifact.path) || !GIT_CONFIG_KEYS.has(artifact.key)) reject('git config target');
            if (!Array.isArray(artifact.before.values) || !Array.isArray(artifact.after.values) || artifact.after.values.length > 1) reject('git config values');
        }
        if (artifact.kind === 'claude') {
            if (!Object.hasOwn(CLAUDE_LINKS, artifact.path) || artifact.after.type !== 'symlink' || artifact.after.target !== CLAUDE_LINKS[artifact.path]) reject('claude link');
            if (artifact.path !== '.claude') realDirectoryIfPresent(path.join(handle.root, '.claude'), '.claude');
        }
        if (artifact.kind === 'manifest') {
            if (typeof artifact.path !== 'string' || !artifact.path) reject('manifest path');
            if (!path.isAbsolute(artifact.path)) {
                const target = resolveInside(handle.root, artifact.path);
                const parent = path.dirname(target);
                if (fs.existsSync(parent) && fs.realpathSync(parent) !== parent) reject('manifest parent');
            }
        }
    }
}

function crashPoint(context, point, detail) {
    if (!context.hooks?.crash) return;
    try {
        context.hooks.crash(point, detail);
    } catch (error) {
        // Only the test-only crash hook can abandon a transaction without
        // recovery or lock release, as if the process had died here.
        if (error?.[SIMULATED_CRASH] === true) {
            context.handle.abandoned = true;
            throw error;
        }
        throw error;
    }
}

function quarantine(handle, journal, reasons) {
    const directory = path.join(handle.agents, EXPORT_QUARANTINE);
    realDirectory(directory, true);
    const record = { ...journal, quarantined: { at: new Date().toISOString(), by: handle.token, reasons } };
    writeDurable(path.join(directory, `${journal.transaction}.json`), `${JSON.stringify(record, null, 2)}\n`);
    fs.rmSync(journalPath(handle), { force: true });
    syncDirectory(handle.agents);
}

function finishJournal(handle, journal) {
    fs.rmSync(journalPath(handle), { force: true });
    syncDirectory(handle.agents);
    if (journal.staging) fs.rmSync(resolveInside(handle.root, journal.staging), { recursive: true, force: true });
}

function backupName(handle, name, kind, transaction) {
    const base = path.join(handle.agents, EXPORT_BACKUPS, `${name}-${kind}-tx-${transaction}`);
    for (let index = 0; ; index++) {
        const candidate = index ? `${base}-${index}` : base;
        if (!exists(candidate)) return candidate;
    }
}

// Roll back published paths while each still matches its recorded evidence.
function undoPaths(handle, journal, context) {
    const unexpected = [];
    for (const entry of [...journal.paths].reverse()) {
        if (entry.outcome === 'preserved' || entry.outcome === 'skipped') continue;
        const destination = resolveInside(handle.root, entry.destination);
        const backup = entry.backup ? resolveInside(handle.root, entry.backup) : null;
        let current = pathEvidence(destination);
        if (entry.after.type !== 'absent' && evidenceMatches(current, entry.after)) {
            if (current.type === 'symlink') fs.unlinkSync(destination);
            else fs.renameSync(destination, backupName(handle, entry.name, 'rollback', journal.transaction));
            current = { type: 'absent' };
        }
        if (evidenceMatches(current, entry.before)) continue;
        if (current.type === 'absent' && backup && evidenceMatches(pathEvidence(backup), entry.before)) {
            fs.renameSync(backup, destination);
            continue;
        }
        if (current.type === 'absent' && entry.before.type === 'absent') continue;
        unexpected.push({ name: entry.name, reason: 'unexpected-output-preserved', destination, backup });
    }
    return unexpected;
}

// Before the commit point this transaction never wrote the ledger. A changed
// ledger means another writer (for example a pre-transaction exporter)
// committed meanwhile; it is left untouched and reported.
function ledgerNotes(handle, journal) {
    if (!journal.ledger?.before) return [];
    const current = currentContent(path.join(handle.agents, EXPORT_LEDGER));
    return contentMatches(current, journal.ledger.before) ? [] : [{ name: EXPORT_LEDGER, reason: 'ledger-changed-by-another-writer-preserved' }];
}

function publishContent(target, stagedBytes, before, mode) {
    if (stagedBytes === null) {
        // Removal of a file this transaction owns, only while unchanged.
        if (!contentMatches(currentContent(target), before)) return false;
        if (before.type !== 'absent') fs.unlinkSync(target);
        syncDirectory(path.dirname(target));
        return true;
    }
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    const fd = fs.openSync(temporary, 'wx', mode ?? 0o644);
    try { fs.writeSync(fd, stagedBytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    if (mode !== undefined && mode !== null) fs.chmodSync(temporary, mode);
    try {
        if (!contentMatches(currentContent(target), before)) return false;
        if (before.type === 'absent') {
            // Exclusive create: a concurrently created file is never replaced.
            try { fs.linkSync(temporary, target); } catch (error) { if (error.code === 'EEXIST') return false; throw error; }
        } else {
            fs.renameSync(temporary, target);
        }
        syncDirectory(path.dirname(target));
        return true;
    } finally {
        fs.rmSync(temporary, { force: true });
    }
}

// Roll forward the metadata artifacts. Used by live publication and by
// recovery alike; each artifact is written only over its recorded before state.
function redoArtifacts(handle, journal, context) {
    const unexpected = [];
    const staging = journal.staging ? resolveInside(handle.root, journal.staging) : null;
    for (const artifact of journal.artifacts) {
        handle.assertSafeTarget?.();
        const target = artifactTarget(handle, artifact);
        if (context.recovering && artifact.kind === 'manifest' && path.isAbsolute(artifact.path)) {
            // Recovery never writes outside the export folder; the caller's
            // next transaction republishes such a manifest.
            if (!contentMatches(currentContent(target), artifact.after)) unexpected.push({ name: 'manifest', path: artifact.path, reason: 'manifest-outside-folder-preserved' });
        } else if (artifact.kind === 'claude') {
            const current = linkEvidence(target);
            if (!linkMatches(current, artifact.after)) {
                if (current.type !== 'absent') unexpected.push({ name: 'claude', path: artifact.path, reason: 'claude-link-preserved' });
                else {
                    try { fs.symlinkSync(artifact.after.target, target, 'dir'); } catch (error) {
                        if (error.code !== 'EEXIST') throw error;
                        unexpected.push({ name: 'claude', path: artifact.path, reason: 'claude-link-preserved' });
                    }
                }
            }
        } else if (artifact.kind === 'git-config') {
            if (!applyGitConfig(handle, artifact)) unexpected.push({ name: 'git-config', path: artifact.path, key: artifact.key, reason: 'git-config-changed-preserved' });
        } else {
            const current = currentContent(target);
            if (!contentMatches(current, artifact.after)) {
                const deleting = artifact.after.type === 'absent';
                const bytes = !deleting && staging && artifact.staged ? readBytes(resolveInside(handle.root, artifact.staged)) : null;
                if (!deleting && (bytes === null || sha256(bytes) !== artifact.after.digest)) {
                    unexpected.push({ name: artifact.kind, path: artifact.path, reason: 'staged-artifact-missing' });
                } else if (!contentMatches(current, artifact.before) || !publishContent(target, bytes, artifact.before, artifact.mode)) {
                    unexpected.push({ name: artifact.kind, path: artifact.path, reason: `${artifact.kind}-changed-preserved` });
                }
            }
        }
        crashPoint(context, `after-${artifact.kind}`, { artifact: artifact.kind });
    }
    return unexpected;
}

function verifyJournal(handle, journal) {
    const failures = [];
    for (const entry of journal.paths) {
        if (entry.outcome !== 'published') continue;
        if (!evidenceMatches(pathEvidence(resolveInside(handle.root, entry.destination)), entry.after)) failures.push({ name: entry.name, reason: 'post-publication-change-preserved' });
    }
    for (const artifact of journal.artifacts) {
        const target = artifactTarget(handle, artifact);
        const ok = artifact.kind === 'claude' ? linkMatches(linkEvidence(target), artifact.after)
            : artifact.kind === 'git-config' ? sameValues(gitConfigValues(target, artifact.key, handle.root), artifact.after.values)
                : contentMatches(currentContent(target), artifact.after);
        if (!ok) failures.push({ name: artifact.kind, reason: 'post-publication-change-preserved' });
    }
    return failures;
}

// Unlocked hint used only to order locks; recovery revalidates the journal.
function peekJournalCommonDir(root) {
    try {
        const journal = JSON.parse(fs.readFileSync(path.join(root, '.agents', EXPORT_JOURNAL), 'utf8'));
        const commonDir = journal?.config?.identity?.commonDir;
        return journal?.phase === 'metadata' && typeof commonDir === 'string' && path.isAbsolute(commonDir)
            && journal.artifacts?.some(artifact => artifact?.kind === 'git-config') ? commonDir : null;
    } catch (_) {
        return null;
    }
}

// Recover a pending transaction left by a terminated lock holder. Called
// with the export lock held and before any new write.
export function recoverSkillExportTransaction(handle, options = {}) {
    handle.assertHeld();
    const journal = readJournal(handle);
    if (!journal) return { status: 'none' };
    if (journal.phase === 'metadata' && journal.artifacts.some(artifact => artifact.kind === 'git-config')
        && !(handle.gitLocks || []).includes(journal.config?.identity?.commonDir)) {
        throw skillExportError('SKILL_EXPORT_RECOVERY_REQUIRED',
            `Skill export transaction ${journal.transaction} changes Git configuration, but the common Git configuration lock for ${journal.config?.identity?.commonDir} could not be held; it is preserved.`,
            { outcome: 'recovery-required', transaction: journal.transaction });
    }
    const context = { handle, hooks: options.recoveryHooks || null, recovering: true };
    const forward = journal.phase === 'metadata';
    const unexpected = forward ? redoArtifacts(handle, journal, context) : undoPaths(handle, journal, context);
    if (forward && !unexpected.length) unexpected.push(...verifyJournal(handle, journal));
    const notes = forward ? [] : ledgerNotes(handle, journal);
    if (unexpected.length) {
        quarantine(handle, journal, unexpected);
        return { status: 'quarantined', transaction: journal.transaction, owner: journal.owner, direction: forward ? 'forward' : 'back', unexpected, notes };
    }
    finishJournal(handle, journal);
    return { status: forward ? 'rolled-forward' : 'rolled-back', transaction: journal.transaction, owner: journal.owner, notes };
}

// ---------------------------------------------------------------------------
// Planning.

function stageWanted(handle, staging, wanted, mode, linker, name) {
    const staged = path.join(staging, name);
    if (mode === 'symlink') {
        const target = fs.realpathSync(wanted.path);
        if (!fs.statSync(path.join(target, 'SKILL.md')).isFile()) throw new Error('Skill descriptor is missing');
        linker(staged, target, handle.root, handle.skills);
        return { staged, digest: skillTreeDigest(staged), sourceTarget: target, kind: 'symlink' };
    }
    for (let attempt = 0; attempt < 3; attempt++) {
        const before = skillTreeDigest(wanted.path);
        copyFreshSkillTree(wanted.path, staged);
        const digest = skillTreeDigest(staged);
        if (digest === before && digest === skillTreeDigest(wanted.path)) return { staged, digest, sourceTarget: null, kind: 'directory' };
        fs.rmSync(staged, { recursive: true, force: true });
    }
    return null;
}

// Refresh: the owner's complete desired set replaces its previous set.
// `retain` names belong to sources that could not be verified this time:
// their output is neither refreshed nor pruned.
function planSync(handle, ledger, spec, staging, result) {
    const { owner, incoming, mode, linker, retain } = spec;
    const diagnose = (name, reason, extra = {}) => result.diagnostics.push({ name, reason, ...extra });
    const names = new Set([...incoming.keys(), ...Object.keys(ledger.entries).filter(name => ledger.entries[name].owner === owner)]);
    const ops = [];
    for (const name of names) {
        if (!SKILL_NAME.test(name)) throw new Error('Unsafe name in skill ownership ledger');
        if (retain.has(name) && !incoming.has(name)) { result.retained.push(name); continue; }
        const wanted = incoming.get(name);
        const record = ledger.entries[name];
        const destination = path.join(handle.skills, name);
        const present = exists(destination);
        if (record && record.owner !== owner) { diagnose(name, 'owned-by-other-export'); continue; }
        if (present && !record) { diagnose(name, 'unrecorded-output-preserved'); continue; }
        if (!present && record && wanted) { diagnose(name, 'removed-output-preserved'); continue; }
        if (present && (!(record.kind === 'symlink' ? fs.lstatSync(destination).isSymbolicLink() : fs.lstatSync(destination).isDirectory()) || skillTreeDigest(destination) !== record.digest)) { diagnose(name, 'edited-output-preserved'); continue; }
        let prepared = null;
        if (wanted) {
            prepared = stageWanted(handle, staging, wanted, mode, linker, name);
            if (!prepared) { diagnose(name, 'source-changing-during-export'); continue; }
            if (record?.digest === prepared.digest) { result.unchanged.push(name); continue; }
        }
        ops.push({
            name, record, wanted, prepared,
            action: present ? (wanted ? 'replace' : 'remove') : wanted ? 'install' : 'forget',
            entry: wanted ? { owner, digest: prepared.digest, kind: prepared.kind, source: wanted.source ?? null } : null,
        });
    }
    return ops;
}

const resolvesTo = (destination, source) => {
    const stat = fs.lstatSync(destination, { throwIfNoEntry: false });
    return Boolean(stat?.isSymbolicLink()) && path.resolve(path.dirname(destination), fs.readlinkSync(destination)) === source;
};

// Explicit marketplace install: only absent destinations are created and
// recorded. Identical existing links remain unowned without prior proof.
function planAdditive(handle, ledger, spec, staging, result) {
    const { owner, incoming, linker } = spec;
    const ops = [];
    for (const [name, wanted] of incoming) {
        const destination = path.join(handle.skills, name);
        const record = ledger.entries[name];
        const present = exists(destination);
        const source = fs.realpathSync(wanted.path);
        const status = (value, reason) => result.statuses.push({ name, destination, source, status: value, ...(reason ? { reason } : {}), owned: Boolean(record && record.owner === owner) });
        if (record && record.owner !== owner) {
            if (present && resolvesTo(destination, source)) status('present', 'owned-by-other-export');
            else status('conflict', 'owned-by-other-export');
            continue;
        }
        if (present) {
            if (!resolvesTo(destination, source)) { status('conflict', record ? 'edited-output-preserved' : 'unrecorded-output-preserved'); continue; }
            if (record && skillTreeDigest(destination) !== record.digest) { status('conflict', 'edited-output-preserved'); continue; }
            status('present', record ? null : 'unrecorded-output-preserved');
            continue;
        }
        const prepared = stageWanted(handle, staging, wanted, 'symlink', linker, name);
        ops.push({ name, record, wanted, prepared, action: 'install', entry: { owner, digest: prepared.digest, kind: 'symlink', source: wanted.source ?? null } });
    }
    return ops;
}

// Explicit marketplace removal: only owned, unedited output is removed.
function planRemove(handle, ledger, spec, result) {
    const { owner, removeNames } = spec;
    const ops = [];
    for (const name of removeNames) {
        if (!SKILL_NAME.test(name)) throw new Error(`Invalid exported skill name: ${name}`);
        const destination = path.join(handle.skills, name);
        const record = ledger.entries[name];
        const present = exists(destination);
        const status = (value, reason) => result.statuses.push({ name, destination, status: value, ...(reason ? { reason } : {}) });
        if (!present) {
            if (record?.owner === owner) ops.push({ name, record, action: 'forget', entry: null });
            status('absent');
            continue;
        }
        if (!record) { status('conflict', 'unrecorded-output-preserved'); continue; }
        if (record.owner !== owner) { status('conflict', 'owned-by-other-export'); continue; }
        const stat = fs.lstatSync(destination);
        if (!(record.kind === 'symlink' ? stat.isSymbolicLink() : stat.isDirectory()) || skillTreeDigest(destination) !== record.digest) { status('conflict', 'edited-output-preserved'); continue; }
        ops.push({ name, record, action: 'remove', entry: null, removal: true });
    }
    return ops;
}

// ---------------------------------------------------------------------------
// Compatibility links.

function planClaude(handle, policy) {
    if (!policy) return { artifact: null, report: null };
    const claude = path.join(handle.root, '.claude');
    const stat = fs.lstatSync(claude, { throwIfNoEntry: false });
    if (!stat) return { artifact: { kind: 'claude', path: '.claude', before: { type: 'absent' }, after: { type: 'symlink', target: '.agents' } }, report: { changed: true, mode: 'root' } };
    if (stat.isSymbolicLink()) {
        const text = fs.readlinkSync(claude);
        if (policy === 'root-strict') {
            return { artifact: null, report: { changed: false, mode: path.resolve(handle.root, text) === handle.agents ? 'root' : 'conflict' } };
        }
        return { artifact: null, report: { changed: false, mode: text === '.agents' ? 'root' : 'preserved' } };
    }
    if (policy === 'root-strict') return { artifact: null, report: { changed: false, mode: 'conflict' } };
    if (policy === 'root-or-skills' && stat.isDirectory()) {
        const skills = path.join(claude, 'skills');
        const inner = fs.lstatSync(skills, { throwIfNoEntry: false });
        if (!inner) return { artifact: { kind: 'claude', path: '.claude/skills', before: { type: 'absent' }, after: { type: 'symlink', target: '../.agents/skills' } }, report: { changed: true, mode: 'skills' } };
        if (inner.isSymbolicLink() && fs.readlinkSync(skills) === '../.agents/skills') return { artifact: null, report: { changed: false, mode: 'skills' } };
    }
    return { artifact: null, report: { changed: false, mode: 'preserved' } };
}

// ---------------------------------------------------------------------------
// Retention.

function storageBytes(target) {
    let total = 0;
    const visit = entry => {
        const stat = fs.lstatSync(entry, { throwIfNoEntry: false });
        if (!stat) return;
        total += stat.isDirectory() ? 0 : stat.size;
        if (stat.isDirectory()) for (const name of fs.readdirSync(entry)) visit(path.join(entry, name));
    };
    try { visit(target); } catch (_) {}
    return total;
}

function referencedTransactions(handle) {
    const referenced = new Set();
    try { const journal = readJournal(handle); if (journal) referenced.add(journal.transaction); } catch (_) { referenced.add('*'); }
    const directory = path.join(handle.agents, EXPORT_QUARANTINE);
    for (const name of fs.existsSync(directory) ? fs.readdirSync(directory) : []) {
        const match = /^(.+)\.json$/.exec(name);
        if (match) referenced.add(match[1]);
    }
    return referenced;
}

// Only provably unpublished generated staging with dead-owner proof and no
// journal reference is collected. Backups are classified and retained: old
// descriptors may still write into prior output after replacement.
export function inspectSkillExportRetention(handle, { collect = true, ...options } = {}) {
    const report = {
        backups: { prior: { count: 0, bytes: 0 }, concurrent: { count: 0, bytes: 0 }, rollback: { count: 0, bytes: 0 }, legacy: { count: 0, bytes: 0 } },
        staging: { collected: [], retained: [] },
        retainedBytes: 0,
    };
    const backups = path.join(handle.agents, EXPORT_BACKUPS);
    for (const name of fs.existsSync(backups) ? fs.readdirSync(backups) : []) {
        const kind = BACKUP_NAME.exec(name)?.[2] || 'legacy';
        const bytes = storageBytes(path.join(backups, name));
        report.backups[kind].count += 1;
        report.backups[kind].bytes += bytes;
        report.retainedBytes += bytes;
    }
    const stagingRoot = path.join(handle.agents, EXPORT_STAGING);
    const referenced = referencedTransactions(handle);
    for (const name of fs.existsSync(stagingRoot) ? fs.readdirSync(stagingRoot) : []) {
        const target = path.join(stagingRoot, name);
        const transaction = /^tx-(.+)$/.exec(name)?.[1];
        if (transaction && transaction === handle.activeTransaction) continue;
        let reason = 'unknown-legacy';
        if (transaction && TRANSACTION_ID.test(transaction)) {
            if (referenced.has(transaction) || referenced.has('*')) reason = 'journal-referenced';
            else {
                let owner = null;
                try { owner = JSON.parse(fs.readFileSync(path.join(target, LOCK_OWNER), 'utf8')); } catch (_) {}
                const state = owner && owner.token !== handle.token ? classifyLockOwner(owner, options) : 'unknown';
                if (state === 'dead' && collect) {
                    fs.rmSync(target, { recursive: true, force: true });
                    report.staging.collected.push(name);
                    continue;
                }
                reason = state === 'dead' ? 'collection-disabled' : 'owner-not-proven-dead';
            }
        }
        const bytes = storageBytes(target);
        report.staging.retained.push({ name, reason, bytes });
        report.retainedBytes += bytes;
    }
    return report;
}

// ---------------------------------------------------------------------------
// Publication.

const PROTOCOL_PATHS = [EXPORT_LEDGER, EXPORT_LOCK, EXPORT_JOURNAL, EXPORT_STAGING, EXPORT_BACKUPS, EXPORT_QUARANTINE, path.basename(IGNORE_RECEIPT)]
    .map(name => `.agents/${name}`);

// Root-relative paths of output that is owned and still verified: ledger
// entries whose output matches its digest, compatibility links this protocol
// created and still match, and the protocol's own bookkeeping paths.
function ownedExportPaths(handle, ledger, pendingLinks = []) {
    const owned = [];
    for (const [name, record] of Object.entries(ledger.entries)) {
        if (!SKILL_NAME.test(name) || !record || typeof record !== 'object') continue;
        const destination = path.join(handle.skills, name);
        const stat = fs.lstatSync(destination, { throwIfNoEntry: false });
        if (!stat || !(record.kind === 'symlink' ? stat.isSymbolicLink() : stat.isDirectory())) continue;
        try { if (skillTreeDigest(destination) !== record.digest) continue; } catch (_) { continue; }
        owned.push(`.agents/skills/${name}`);
    }
    for (const [link, record] of Object.entries(ledger.compatLinks || {})) {
        if (!Object.hasOwn(CLAUDE_LINKS, link) || record?.target !== CLAUDE_LINKS[link]) continue;
        const current = linkEvidence(path.join(handle.root, link));
        if (pendingLinks.includes(link) || (current.type === 'symlink' && current.target === record.target)) owned.push(link.split(path.sep).join('/'));
    }
    return [...owned, ...PROTOCOL_PATHS];
}

/** Read-only list of verified owned generated paths below `folder`, for
 * callers that must tell generated output from user content. */
export function listOwnedExportPaths(folder) {
    const roots = exportRoots(folder, { create: false });
    if (!roots) return [];
    return ownedExportPaths(roots, readExportLedger(roots.agents).ledger);
}

// Only planned exclusion artifacts that differ from the current state.
function exclusionChanges(handle, planned) {
    const changes = [];
    const gitignore = path.join(handle.root, '.gitignore');
    for (const artifact of planned.artifacts || []) {
        if (artifact.kind === 'git-config') {
            const current = gitConfigValues(artifact.file, artifact.key, handle.root);
            if (!sameValues(current, artifact.after)) changes.push({ kind: 'git-config', path: artifact.file, key: artifact.key, before: current, after: artifact.after });
            continue;
        }
        const target = artifact.kind === 'gitignore' ? gitignore : artifact.kind === 'receipt' ? path.join(handle.root, IGNORE_RECEIPT) : artifact.path;
        const bytes = artifact.bytes === null ? null : toBuffer(artifact.bytes);
        const current = currentContent(target);
        if (current.type !== 'absent' && current.type !== 'file') continue;
        if (contentMatches(current, contentEvidence(bytes))) continue;
        const stat = fs.lstatSync(target, { throwIfNoEntry: false });
        changes.push({ kind: artifact.kind, path: target, bytes, before: current, mode: stat ? stat.mode & 0o777 : 0o644 });
    }
    return changes;
}

function exclusionOutcome(planned, quarantined) {
    if (!planned) return null;
    const outcome = { ...planned.outcome };
    if (quarantined) return { ...outcome, status: 'preserved', code: 'exclusions-changed-during-publication' };
    if (outcome.status === 'published' && !planned.changes.length) outcome.status = 'unchanged';
    return outcome;
}

function normalizeSources(sources) {
    const incoming = new Map();
    for (const source of sources) {
        if (!SKILL_NAME.test(source.name)) throw new Error(`Invalid exported skill name: ${source.name}`);
        if (incoming.has(source.name)) throw new Error(`Duplicate exported skill name: ${source.name}`);
        incoming.set(source.name, source);
    }
    return incoming;
}

function canonicalFile(filename) {
    return path.join(fs.realpathSync(path.dirname(filename)), path.basename(filename));
}

// A manifest may live outside the export folder; it is then recorded by its
// canonical absolute path. Every other artifact stays inside the folder.
function artifactPath(handle, kind, filename) {
    const relative = path.relative(handle.root, filename);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return relative;
    if (kind === 'manifest') return filename;
    throw new Error(`Skill export artifact must be inside the export folder: ${filename}`);
}

/** Publish one owner's exports into a folder whose lock `handle` holds.
 * spec.policy: 'sync' (owner refresh), 'additive' (explicit install) or
 * 'remove' (explicit removal). Optional artifacts: manifest
 * { path, expected, next, changedMessage }, claude policy, gitignore
 * { update(content) }, and config (P4 hook point, recorded only).
 */
export function publishSkillExports(handle, spec) {
    handle.assertHeld();
    const policy = spec.policy || 'sync';
    const owner = spec.owner;
    if (!owner || typeof owner !== 'string') throw new Error('Skill exports require an owner');
    const incoming = policy === 'remove' || policy === 'exclusions-only' ? new Map() : normalizeSources(spec.sources || []);
    const hooks = spec.hooks || {};
    const context = { handle, hooks };
    const result = { installed: [], removed: [], unchanged: [], retained: [], diagnostics: [], backups: [], statuses: [], artifacts: {}, transaction: null };
    const diagnose = (name, reason, extra = {}) => result.diagnostics.push({ name, reason, ...extra });

    // Snapshot under the lock: manifest bytes first, so a concurrent edit
    // fails the transaction before anything is staged or published.
    let manifestPlan = null;
    if (spec.manifest) {
        const filename = canonicalFile(spec.manifest.path);
        const current = readBytes(filename, 'Skills manifest');
        const expected = spec.manifest.expected === undefined ? undefined : toBuffer(spec.manifest.expected);
        if (expected !== undefined && !sameBytes(current, expected)) {
            throw skillExportError('SKILL_EXPORT_SNAPSHOT_CHANGED', spec.manifest.changedMessage || `Skills manifest changed concurrently: ${filename}`, { outcome: 'snapshot-changed' });
        }
        const next = typeof spec.manifest.next === 'function' ? toBuffer(spec.manifest.next(current)) : toBuffer(spec.manifest.next);
        if (next !== null && !sameBytes(current, next)) {
            const mode = current === null ? (spec.manifest.mode ?? 0o644) : fs.statSync(filename).mode & 0o777;
            manifestPlan = { filename, before: contentEvidence(current), bytes: next, mode };
        }
    }
    const { ledger, bytes: ledgerBefore } = readExportLedger(handle.agents);
    const configSnapshot = spec.config ? { before: spec.config.before ?? null, after: spec.config.after ?? null } : { before: null, after: null };

    const transaction = crypto.randomUUID();
    handle.activeTransaction = transaction;
    const stagingRoot = path.join(handle.agents, EXPORT_STAGING);
    const backupsRoot = path.join(handle.agents, EXPORT_BACKUPS);
    realDirectory(stagingRoot, true);
    realDirectory(backupsRoot, true);
    const staging = path.join(stagingRoot, `tx-${transaction}`);
    fs.mkdirSync(staging, { mode: 0o700 });
    fs.writeFileSync(path.join(staging, LOCK_OWNER), `${JSON.stringify(handle.owner)}\n`, { flag: 'wx', mode: 0o600 });
    let journalWritten = false;
    let exclusionPlan = null;
    try {
        const linker = spec.linker || relativeSkillLink;
        const ops = policy === 'exclusions-only' ? []
            : policy === 'remove' ? planRemove(handle, ledger, { owner, removeNames: spec.removeNames || [] }, result)
                : policy === 'additive' ? planAdditive(handle, ledger, { owner, incoming, linker }, staging, result)
                    : planSync(handle, ledger, { owner, incoming, mode: spec.mode || 'copy', linker, retain: new Set(spec.retain || []) }, staging, result);

        const claude = planClaude(handle, spec.claude);
        let gitignorePlan = null;
        if (spec.gitignore) {
            const filename = path.join(handle.root, spec.gitignore.path || '.gitignore');
            const stat = fs.lstatSync(filename, { throwIfNoEntry: false });
            if (stat && !stat.isFile()) diagnose('.gitignore', 'gitignore-not-regular-file-preserved');
            else {
                const current = stat ? fs.readFileSync(filename) : null;
                const next = toBuffer(spec.gitignore.update(current === null ? '' : current.toString('utf8')));
                if (next !== null && !sameBytes(current, next)) gitignorePlan = { filename, before: contentEvidence(current), bytes: next, mode: stat ? stat.mode & 0o777 : 0o644 };
            }
        }

        // A consumer's selection policy (all defaults or an explicit list) is
        // persisted with its owner so later automatic refreshes never broaden it.
        if (spec.consumer && policy !== 'exclusions-only'
            && JSON.stringify(ledger.consumers?.[owner]) !== JSON.stringify(spec.consumer)) {
            ledger.consumers = { ...(ledger.consumers || {}), [owner]: spec.consumer };
        }
        // Compatibility links are owned only when this transaction creates them.
        if (claude.artifact) ledger.compatLinks = { ...(ledger.compatLinks || {}), [claude.artifact.path]: { target: claude.artifact.after.target } };
        const pendingLinks = claude.artifact ? [claude.artifact.path] : [];
        // Provisional ledger assuming every operation publishes.
        const provisional = { ...ledger, entries: Object.assign(Object.create(null), ledger.entries) };
        for (const op of ops) {
            if (op.entry) provisional.entries[op.name] = op.entry;
            else delete provisional.entries[op.name];
        }
        const ledgerChanged = policy === 'exclusions-only' ? false
            : ledgerBefore === null || !sameBytes(ledgerBefore, serializeLedger(provisional));
        const planExclusions = state => {
            if (!spec.exclusions) return null;
            const planned = spec.exclusions.plan({ root: handle.root, ownedPaths: ownedExportPaths(handle, state, pendingLinks), heldGitLocks: handle.gitLocks || [] });
            planned.changes = exclusionChanges(handle, planned);
            return planned;
        };
        if (!ops.length && !ledgerChanged && !manifestPlan && !claude.artifact && !gitignorePlan) {
            const exclusions = planExclusions(provisional);
            if (!exclusions?.changes.length) {
                result.artifacts = { manifest: spec.manifest ? 'unchanged' : null, claude: claude.report, gitignore: false };
                result.exclusions = exclusionOutcome(exclusions, false);
                result.transaction = { id: null, status: 'unchanged' };
                return result;
            }
        }

        const rel = target => path.relative(handle.root, target);
        const journal = {
            protocol: EXPORT_PROTOCOL,
            version: EXPORT_PROTOCOL_VERSION,
            kind: 'pending-skill-export',
            transaction,
            lockToken: handle.token,
            owner,
            policy,
            folder: handle.root,
            createdAt: new Date().toISOString(),
            phase: 'prepared',
            staging: rel(staging),
            ledger: { before: contentEvidence(ledgerBefore) },
            config: configSnapshot,
            paths: ops.map(op => {
                const destination = path.join(handle.skills, op.name);
                const before = pathEvidence(destination);
                let after = { type: 'absent' };
                if (op.prepared) {
                    const staged = pathEvidence(op.prepared.staged);
                    after = op.prepared.kind === 'symlink'
                        ? { type: 'symlink', target: staged.target, digest: staged.digest }
                        : { type: 'directory', digest: staged.digest, inode: staged.inode };
                }
                return {
                    name: op.name, action: op.action, destination: rel(destination), before, after,
                    staged: op.prepared ? rel(op.prepared.staged) : null, backup: null, outcome: 'pending',
                };
            }),
            artifacts: [],
        };
        const stageArtifact = (kind, filename, bytes, before, mode) => {
            let staged = null;
            if (bytes !== null) {
                staged = path.join(staging, `artifact-${kind}${kind === 'private-file' ? `-${path.basename(filename)}` : ''}`);
                fs.writeFileSync(staged, bytes, { flag: 'wx', mode: 0o600 });
            }
            const recorded = kind === 'ledger' ? null : kind === 'private-file' ? filename : kind === 'receipt' ? IGNORE_RECEIPT : artifactPath(handle, kind, filename);
            journal.artifacts.push({ kind, path: recorded, before, after: contentEvidence(bytes), staged: staged && rel(staged), mode });
        };
        crashPoint(context, 'before-journal');
        writeJournal(handle, journal);
        journalWritten = true;
        crashPoint(context, 'after-journal');

        try {
            for (let index = 0; index < ops.length; index++) {
                const op = ops[index];
                const entry = journal.paths[index];
                const destination = path.join(handle.skills, op.name);
                const current = pathEvidence(destination);
                // Compare before moving: the destination must still be what
                // planning observed.
                if (!evidenceMatches(current, entry.before)) {
                    diagnose(op.name, current.type === 'absent' ? 'removed-output-preserved' : 'concurrent-output-preserved');
                    entry.outcome = 'skipped';
                    writeJournal(handle, journal);
                    continue;
                }
                if (op.prepared?.sourceTarget) {
                    let target = null;
                    try { target = fs.realpathSync(op.wanted.path); } catch (_) {}
                    if (target !== op.prepared.sourceTarget) {
                        diagnose(op.name, 'source-changed-during-export');
                        entry.outcome = 'skipped';
                        writeJournal(handle, journal);
                        continue;
                    }
                }
                let backup = null;
                if (current.type !== 'absent') {
                    hooks.beforeMove?.({ name: op.name, destination });
                    backup = backupName(handle, op.name, 'prior', transaction);
                    entry.backup = rel(backup);
                    writeJournal(handle, journal);
                    fs.renameSync(destination, backup);
                    result.backups.push(backup);
                    hooks.afterMove?.({ name: op.name, destination, backup });
                    crashPoint(context, 'after-backup', { name: op.name });
                    // Recheck the moved tree to close the pre-rename edit window.
                    if (skillTreeDigest(backup) !== op.record.digest) {
                        let preserved = backup;
                        if (!exists(destination)) { fs.renameSync(backup, destination); preserved = null; }
                        else {
                            const renamed = backupName(handle, op.name, 'concurrent', transaction);
                            fs.renameSync(backup, renamed);
                            preserved = renamed;
                            result.backups[result.backups.length - 1] = renamed;
                        }
                        diagnose(op.name, 'concurrent-edit-preserved', { backup: preserved });
                        entry.outcome = 'preserved';
                        writeJournal(handle, journal);
                        continue;
                    }
                }
                if (op.prepared) {
                    if (exists(destination)) { diagnose(op.name, 'concurrent-output-preserved', { backup }); entry.outcome = 'preserved'; writeJournal(handle, journal); continue; }
                    if (op.prepared.kind === 'symlink') {
                        // Exclusive create never replaces concurrently created output.
                        try { fs.symlinkSync(entry.after.target, destination, 'dir'); } catch (error) {
                            if (error.code !== 'EEXIST') throw error;
                            diagnose(op.name, 'concurrent-output-preserved', { backup });
                            entry.outcome = 'preserved';
                            writeJournal(handle, journal);
                            continue;
                        }
                        entry.after.inode = fileId(fs.lstatSync(destination));
                    } else {
                        fs.renameSync(op.prepared.staged, destination);
                    }
                    result.installed.push(op.name);
                } else if (op.action !== 'forget' || policy !== 'remove') {
                    result.removed.push(op.name);
                }
                entry.outcome = 'published';
                writeJournal(handle, journal);
                crashPoint(context, 'after-link', { name: op.name });
            }
            for (let index = 0; index < ops.length; index++) {
                const op = ops[index];
                const outcome = journal.paths[index].outcome;
                if (op.removal) result.statuses.push({ name: op.name, destination: path.join(handle.skills, op.name), status: outcome === 'published' ? 'removed' : 'conflict', ...(outcome === 'published' ? {} : { reason: 'concurrent-edit-preserved' }) });
                else if (policy === 'additive') result.statuses.push({ name: op.name, destination: path.join(handle.skills, op.name), source: op.prepared.sourceTarget, status: outcome === 'published' ? 'installed' : 'conflict', owned: outcome === 'published', ...(outcome === 'published' ? {} : { reason: 'concurrent-output-preserved' }) });
            }
            crashPoint(context, 'before-metadata');

            for (let index = 0; index < ops.length; index++) {
                const op = ops[index];
                if (journal.paths[index].outcome !== 'published') continue;
                if (op.entry) ledger.entries[op.name] = op.entry;
                else delete ledger.entries[op.name];
            }
            const ledgerBytes = serializeLedger(ledger);
            if (policy !== 'exclusions-only' && (ledgerBefore === null || !sameBytes(ledgerBefore, ledgerBytes))) {
                stageArtifact('ledger', null, ledgerBytes, contentEvidence(ledgerBefore), 0o600);
            }
            if (manifestPlan) stageArtifact('manifest', manifestPlan.filename, manifestPlan.bytes, manifestPlan.before, manifestPlan.mode);
            if (claude.artifact) journal.artifacts.push(claude.artifact);
            if (gitignorePlan) stageArtifact('gitignore', gitignorePlan.filename, gitignorePlan.bytes, gitignorePlan.before, gitignorePlan.mode);
            // Exclusions derive from the final verified owned set; unchanged
            // content and config are not rewritten.
            exclusionPlan = planExclusions(ledger);
            for (const change of exclusionPlan?.changes || []) {
                if (change.kind === 'git-config') journal.artifacts.push({ kind: 'git-config', path: change.path, key: change.key, before: { type: 'config', values: change.before }, after: { type: 'config', values: change.after } });
                else stageArtifact(change.kind, change.path, change.bytes, change.before, change.mode);
            }
            if (exclusionPlan) journal.config = exclusionPlan.state || journal.config;
            journal.phase = 'metadata';
            writeJournal(handle, journal);
        } catch (error) {
            if (handle.abandoned) throw error;
            // In-process failure before the commit point: roll back now.
            const unexpected = undoPaths(handle, journal, context);
            if (unexpected.length) quarantine(handle, journal, unexpected);
            else finishJournal(handle, journal);
            error.skillExportRecovery = { status: unexpected.length ? 'quarantined' : 'rolled-back', transaction, unexpected };
            throw error;
        }
        crashPoint(context, 'after-metadata-journal');

        let unexpected;
        try {
            unexpected = redoArtifacts(handle, journal, context);
            if (!unexpected.length) unexpected = verifyJournal(handle, journal);
        } catch (error) {
            if (handle.abandoned) throw error;
            throw skillExportError('SKILL_EXPORT_RECOVERY_REQUIRED',
                `Skill export transaction ${transaction} stopped after its commit point and remains pending for recovery: ${error.message}`,
                { outcome: 'recovery-required', transaction, cause: error });
        }
        crashPoint(context, 'before-commit');
        for (const item of unexpected) diagnose(item.name, item.reason);
        if (unexpected.length) {
            quarantine(handle, journal, unexpected);
            result.transaction = { id: transaction, status: 'quarantined', unexpected };
        } else {
            fs.rmSync(journalPath(handle), { force: true });
            syncDirectory(handle.agents);
            result.transaction = { id: transaction, status: 'committed' };
        }
        crashPoint(context, 'after-commit');
        const published = kind => journal.artifacts.some(artifact => artifact.kind === kind) && !unexpected.some(item => item.name === kind);
        result.exclusions = exclusionOutcome(exclusionPlan, unexpected.some(item => ['private-file', 'git-config', 'receipt'].includes(item.name) || (item.name === 'gitignore' && !gitignorePlan)));
        result.artifacts = {
            manifest: spec.manifest ? (manifestPlan ? (published('manifest') ? 'published' : 'preserved') : 'unchanged') : null,
            claude: claude.artifact && !published('claude') ? { changed: false, mode: 'preserved' } : claude.report,
            gitignore: Boolean(gitignorePlan) && published('gitignore'),
        };
        return result;
    } finally {
        if (!handle.abandoned) {
            const quarantined = fs.existsSync(path.join(handle.agents, EXPORT_QUARANTINE, `${transaction}.json`));
            const pending = journalWritten && fs.existsSync(journalPath(handle));
            if (!quarantined && !pending) fs.rmSync(staging, { recursive: true, force: true });
            handle.activeTransaction = null;
            if (!result.retention) {
                try { result.retention = inspectSkillExportRetention(handle, spec.lock || {}); } catch (_) {}
            }
        }
    }
}

/** Compatibility entry point: lock, recover, publish and release one folder. */
export function syncManagedSkillExports({ folder, owner, sources, mode = 'copy', beforeMove = null, afterMove = null, linker, manifest, claude, gitignore, exclusions, config, policy, removeNames, retain, consumer, authority, executor, hooks = {}, lock: lockOptions = {} }) {
    if (!owner || (policy !== 'remove' && !Array.isArray(sources))) throw new Error('Skill exports require an owner and sources array');
    if (policy !== 'remove') normalizeSources(sources);
    const lock = { ...lockOptions, authority: lockOptions.authority ?? authority ?? null, executor: lockOptions.executor ?? executor ?? null };
    return withSkillExportLocks([folder], ([handle]) => {
        const result = publishSkillExports(handle, {
            owner, sources, mode, linker, manifest, claude, gitignore, exclusions, config, policy, removeNames, retain, consumer, lock,
            hooks: { ...hooks, beforeMove: beforeMove || hooks.beforeMove, afterMove: afterMove || hooks.afterMove },
        });
        if (handle.recovery?.status && handle.recovery.status !== 'none') {
            result.recovery = handle.recovery;
            if (handle.recovery.status === 'quarantined') result.diagnostics.push({ name: handle.recovery.transaction, reason: 'transaction-quarantined' });
        }
        return result;
    }, { ...lock, exclusions });
}

/** Republish only the local exclusions derived from verified owned output,
 * under the folder's locks: no skill publication and no source access. Used
 * by the host after a container run deferred them. */
export function refreshSkillExportExclusions(folder, { exclusions, authority = null, lock = {} } = {}) {
    if (!exclusions) throw new Error('refreshSkillExportExclusions requires an exclusions planner');
    let roots;
    try { roots = exportRoots(folder, { create: false }); } catch (error) { if (error.code === 'ENOENT') roots = null; else throw error; }
    if (!roots) return { folder, exclusions: { status: 'unchanged', code: 'no-export-folder', folder } };
    return withSkillExportLocks([roots.root], ([handle]) => {
        const result = publishSkillExports(handle, { owner: 'exclusions', policy: 'exclusions-only', exclusions, lock });
        return { folder: handle.root, exclusions: result.exclusions, transaction: result.transaction, recovery: handle.recovery };
    }, { ...lock, exclusions, authority: lock.authority ?? authority, create: false });
}

/** Read-only state for UIs: pending or quarantined transactions and the lock. */
export function readSkillExportTransactionState(folder, options = {}) {
    let root;
    try { root = fs.realpathSync(folder); } catch (error) { if (error.code === 'ENOENT') return { pending: null, quarantined: [], lock: 'free' }; throw error; }
    const agents = path.join(root, '.agents');
    const stat = fs.lstatSync(agents, { throwIfNoEntry: false });
    if (!stat?.isDirectory()) return { pending: null, quarantined: [], lock: 'free' };
    let pending = null;
    const journal = path.join(agents, EXPORT_JOURNAL);
    if (exists(journal)) {
        try {
            const parsed = JSON.parse(fs.readFileSync(journal, 'utf8'));
            pending = { transaction: parsed.transaction ?? null, owner: parsed.owner ?? null, phase: parsed.phase ?? null, createdAt: parsed.createdAt ?? null };
        } catch (_) {
            pending = { transaction: null, owner: null, phase: 'unreadable', createdAt: null };
        }
    }
    const quarantineRoot = path.join(agents, EXPORT_QUARANTINE);
    const quarantined = [];
    for (const name of fs.existsSync(quarantineRoot) ? fs.readdirSync(quarantineRoot).sort() : []) {
        try {
            const parsed = JSON.parse(fs.readFileSync(path.join(quarantineRoot, name), 'utf8'));
            quarantined.push({ transaction: parsed.transaction ?? null, owner: parsed.owner ?? null, reasons: parsed.quarantined?.reasons ?? [] });
        } catch (_) { quarantined.push({ transaction: name, owner: null, reasons: [] }); }
    }
    const lockState = readLockState(path.join(agents, EXPORT_LOCK));
    const lock = !lockState ? 'free' : lockState.invalid ? 'foreign' : classifyLockOwner(lockState.owner, options);
    return { pending, quarantined, lock };
}
