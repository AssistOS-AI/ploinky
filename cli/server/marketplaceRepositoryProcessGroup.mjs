import fs from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

export const REPOSITORY_OPERATION_MARKER = 'PLOINKY_MARKETPLACE_REPOSITORY_OPERATION';
export const PROC_LIMITS = Object.freeze({ bytes: 65_536, entries: 8_192, readers: 8, timeoutMs: 1_000 });

function unknown() {
    return Object.assign(new Error('Repository process ownership is unproven.'), {
        code: 'PLOINKY_MARKETPLACE_REPOSITORY_PROCESS_UNKNOWN',
    });
}

export function sameProcess(left, right) {
    return Boolean(left && right && Number.isSafeInteger(left.pid) && left.pid > 0
        && /^[1-9][0-9]*$/.test(left.birth) && /^pid:\[[1-9][0-9]*\]$/.test(left.namespace)
        && /^\d+:\d+:\d+:\d+$/.test(left.uids) && left.pid === right.pid && left.birth === right.birth
        && left.namespace === right.namespace && left.uids === right.uids);
}

function parseStat(raw, pid) {
    const open = raw.indexOf('(');
    const close = raw.lastIndexOf(')');
    const fields = raw.slice(close + 1).trim().split(/\s+/);
    if (open < 1 || close <= open || Number(raw.slice(0, open).trim()) !== pid
        || fields.length < 20 || !/^[A-Z]$/.test(fields[0]) || !/^[1-9][0-9]*$/.test(fields[19])) throw unknown();
    const numbers = fields.slice(1, 4).map(Number);
    if (numbers.some((value) => !Number.isSafeInteger(value) || value < 0)) throw unknown();
    return { pid, state: fields[0], parent: numbers[0], group: numbers[1], session: numbers[2], birth: fields[19] };
}

function nulFields(bytes) {
    if (!bytes.length) return [];
    if (bytes.at(-1) !== 0) throw unknown();
    const text = bytes.toString('utf8');
    if (!Buffer.from(text).equals(bytes)) throw unknown();
    return text.slice(0, -1).split('\0');
}

// The limit applies across timed-out passes too: slow outstanding I/O keeps its
// reader slot until its finally clauses close all handles. No unbounded queue.
export function createRepositoryProcessObserver({ fsApi = fs, procRoot = '/proc', now = () => performance.now() } = {}) {
    let readers = 0;
    let scanning = false;
    const check = (deadline) => { if (now() >= deadline) throw unknown(); };
    async function field(file, deadline) {
        check(deadline);
        const handle = await fsApi.open(file, 'r');
        try {
            check(deadline);
            const bytes = Buffer.alloc(PROC_LIMITS.bytes + 1);
            let offset = 0;
            while (offset < bytes.length) {
                const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
                check(deadline);
                if (!bytesRead) break;
                offset += bytesRead;
            }
            if (offset > PROC_LIMITS.bytes) throw unknown();
            return bytes.subarray(0, offset);
        } finally {
            await handle.close();
        }
    }
    async function identity(pid, deadline, { environment = false, executable = false } = {}) {
        if (!Number.isSafeInteger(pid) || pid < 1) throw unknown();
        const root = `${procRoot}/${pid}`;
        const stat = async () => parseStat((await field(`${root}/stat`, deadline)).toString('utf8'), pid);
        const before = await stat();
        const namespace = await fsApi.readlink(`${root}/ns/pid`);
        check(deadline);
        if (!/^pid:\[[1-9][0-9]*\]$/.test(namespace)) throw unknown();
        const status = (await field(`${root}/status`, deadline)).toString('utf8');
        const uidLine = status.split('\n').find((line) => line.startsWith('Uid:'));
        const uidFields = uidLine?.slice(4).trim().split(/\s+/) || [];
        if (uidFields.length !== 4 || uidFields.some((value) => !/^\d+$/.test(value))) throw unknown();
        const argv = await field(`${root}/cmdline`, deadline);
        const env = environment ? await field(`${root}/environ`, deadline) : null;
        const exe = executable ? await fsApi.readlink(`${root}/exe`) : null;
        check(deadline);
        const argvAfter = await field(`${root}/cmdline`, deadline);
        const statusAfter = (await field(`${root}/status`, deadline)).toString('utf8');
        const namespaceAfter = await fsApi.readlink(`${root}/ns/pid`);
        const exeAfter = executable ? await fsApi.readlink(`${root}/exe`) : null;
        const after = await stat();
        if (before.birth !== after.birth || namespace !== namespaceAfter || exe !== exeAfter || !argv.equals(argvAfter)
            || uidLine !== statusAfter.split('\n').find((line) => line.startsWith('Uid:'))
            || before.parent !== after.parent || before.group !== after.group || before.session !== after.session) throw unknown();
        return { ...after, namespace, uids: uidFields.join(':'), argv: nulFields(argv), exe,
            ...(env ? { environment: nulFields(env) } : {}) };
    }
    async function bounded(job, deadline) {
        check(deadline);
        let timer;
        try {
            return await Promise.race([job(), new Promise((_, reject) => {
                timer = setTimeout(() => reject(unknown()), Math.max(1, deadline - now()));
            })]);
        } finally { clearTimeout(timer); }
    }
    async function read(pid, options = {}) {
        if (readers >= PROC_LIMITS.readers) throw unknown();
        const deadline = now() + PROC_LIMITS.timeoutMs;
        return bounded(async () => {
            readers += 1;
            try { return await identity(pid, deadline, options); }
            finally { readers -= 1; }
        }, deadline);
    }
    async function scan({ baseline = [], coordinator = null, router = null, operationId = null, remembered = [] } = {}) {
        if (scanning) return { complete: false, records: [], members: [], writers: [] };
        const deadline = now() + PROC_LIMITS.timeoutMs;
        const records = [];
        const cohort = new Map();
        let incomplete = false;
        const prior = new Map(baseline.map((entry) => [entry.pid, entry]));
        const known = new Map(remembered.map((entry) => [entry.pid, entry]));
        const marker = `${REPOSITORY_OPERATION_MARKER}=${operationId}`;
        const task = async () => {
            const directory = await fsApi.opendir(procRoot);
            const pids = [];
            try {
                // read(), rather than async iteration, leaves closure to this
                // finally even when an observation runs out of time.
                for (;;) {
                    check(deadline);
                    const entry = await directory.read();
                    check(deadline);
                    if (!entry) break;
                    if (!/^[1-9][0-9]*$/.test(entry.name)) continue;
                    if (pids.length === PROC_LIMITS.entries) throw unknown();
                    pids.push(Number(entry.name));
                }
            } finally { await directory.close(); }
            let cursor = 0;
            async function consume() {
                if (readers >= PROC_LIMITS.readers) { incomplete = true; return; }
                readers += 1;
                try {
                    while (cursor < pids.length) {
                        check(deadline);
                        const pid = pids[cursor++];
                        try {
                            let record = await identity(pid, deadline);
                            const preexisting = sameProcess(prior.get(pid), record);
                            const inGroup = coordinator && record.namespace === coordinator.namespace
                                && (record.group === coordinator.group || record.session === coordinator.session);
                            if (operationId && !preexisting && !inGroup && !sameProcess(known.get(pid), record)) {
                                record = await identity(pid, deadline, { environment: true });
                            }
                            const tagged = record.environment?.includes(marker) === true;
                            const inspectedEnvironment = record.environment !== undefined;
                            delete record.environment;
                            records.push({ ...record, tagged, inspectedEnvironment });
                        } catch (error) {
                            // Confirm absence a second time. A reused PID is
                            // unknown, even if its replacement is readable.
                            if (error?.code === 'ENOENT' || error?.code === 'ESRCH') {
                                try { await field(`${procRoot}/${pid}/stat`, deadline); incomplete = true; }
                                catch (confirmation) {
                                    if (confirmation?.code !== 'ENOENT' && confirmation?.code !== 'ESRCH') incomplete = true;
                                }
                            } else incomplete = true;
                        }
                    }
                } finally { readers -= 1; }
            }
            await Promise.all(Array.from({ length: Math.min(PROC_LIMITS.readers, pids.length) }, consume));
            check(deadline);
            if (cursor !== pids.length) incomplete = true;
            await classify();
        };
        async function classify() {
            const anchor = records.some((record) => sameProcess(record, coordinator));
            const groupAnchor = anchor || records.some((record) => sameProcess(known.get(record.pid), record)
                && record.namespace === coordinator?.namespace && record.group === coordinator?.group);
            const sessionAnchor = anchor || records.some((record) => sameProcess(known.get(record.pid), record)
                && record.namespace === coordinator?.namespace && record.session === coordinator?.session);
            if (coordinator) for (const record of records) {
                const anchoredGroup = record.namespace === coordinator.namespace
                    && ((groupAnchor && record.group === coordinator.group) || (sessionAnchor && record.session === coordinator.session));
                // A visible nested-namespace process can retain the exact
                // marker or a previously proven identity. Namespace remains
                // part of that identity; equality with the coordinator does not.
                if (anchoredGroup || record.tagged || sameProcess(known.get(record.pid), record)) cohort.set(record.pid, record);
            }
            if (readers >= PROC_LIMITS.readers) throw unknown();
            readers += 1;
            const attempted = new Set();
            try {
                let changed = true;
                while (changed) {
                    changed = false;
                    for (const record of records) {
                        check(deadline);
                        const parent = cohort.get(record.parent);
                        if (cohort.has(record.pid) || !parent || attempted.has(record.pid)) continue;
                        attempted.add(record.pid);
                        try {
                            // Numeric PPID alone is not lineage evidence. Bind
                            // the known parent's birth identity on both sides
                            // of a fresh stable child observation, inside this
                            // pass's original time and reader limits.
                            const parentBefore = await identity(parent.pid, deadline);
                            if (!sameProcess(parentBefore, parent)) throw unknown();
                            const child = await identity(record.pid, deadline);
                            const parentAfter = await identity(parent.pid, deadline);
                            if (!sameProcess(parentAfter, parent) || !sameProcess(child, record)
                                || child.parent !== parent.pid) throw unknown();
                            cohort.set(record.pid, record);
                            changed = true;
                        } catch (_) { incomplete = true; }
                    }
                }
            } finally { readers -= 1; }
            if (operationId && records.some((record) => !cohort.has(record.pid)
                && !sameProcess(prior.get(record.pid), record) && !record.inspectedEnvironment)) incomplete = true;
        }
        scanning = true;
        try {
            await bounded(async () => { try { await task(); } finally { scanning = false; } }, deadline);
        } catch (_) { incomplete = true; }
        // Snapshot completed reads and classifications. Late I/O may finish
        // closing handles, but cannot change an already returned proof.
        const observed = records.slice();
        const members = [...cohort.values()];
        const writers = members.filter((record) => record.state !== 'Z'
            && !sameProcess(record, router) && !sameProcess(record, coordinator));
        return { complete: !incomplete, records: observed, members, writers };
    }
    async function signal(record, signalName, { coordinator = null, group = false, kill = process.kill, isAllowed = () => true } = {}) {
        if (!['SIGTERM', 'SIGKILL'].includes(signalName)) return false;
        try {
            const current = await read(record.pid, { executable: group });
            if (!sameProcess(record, current)) return false;
            if (group && (!sameProcess(record, coordinator) || current.group !== record.pid
                || current.session !== record.pid || current.exe !== coordinator.exe
                || JSON.stringify(current.argv) !== JSON.stringify(coordinator.argv))) return false;
            if (!isAllowed()) return false;
            kill(group ? -current.group : current.pid, signalName);
            return true;
        } catch (_) { return false; }
    }
    return { read, scan, signal };
}

export async function proveRepositoryQuiescence(observer, options, { barrier = false } = {}) {
    if (!barrier) return { ok: false, reason: 'barrier' };
    const first = await observer.scan(options);
    if (!first.complete || first.writers.length) return { ok: false, reason: first.writers.length ? 'writer' : 'unknown', observation: first };
    await new Promise((resolve) => setTimeout(resolve, 25));
    const second = await observer.scan({ ...options, remembered: [...(options.remembered || []), ...first.members] });
    return { ok: second.complete && second.writers.length === 0,
        reason: second.writers.length ? 'writer' : second.complete ? null : 'unknown', observation: second };
}
