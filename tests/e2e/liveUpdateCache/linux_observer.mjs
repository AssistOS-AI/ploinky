import fs from 'node:fs';
import { AcceptanceError, need } from './manifest.mjs';

// Independent kernel-identity observation of one exact child incarnation on Linux. It never signals, searches by
// name, or accepts an unobserved identity: a process whose incarnation cannot be proven gone is reported as present.
const BOOT_ID = '/proc/sys/kernel/random/boot_id';
const MAX_STAT_BYTES = 8192;

export function parseProcStat(text) {
    need(typeof text === 'string' && text.length <= MAX_STAT_BYTES, 'proc-stat-shape');
    const open = text.indexOf('('), close = text.lastIndexOf(')');
    need(open > 0 && close > open && /^\d+ $/.test(text.slice(0, open)), 'proc-stat-shape');
    const fields = text.slice(close + 2).trim().split(' ');
    // Field 3 (state) is fields[0]; field 22 (starttime) is therefore fields[19].
    need(fields.length >= 20 && /^[A-Z]$/.test(fields[0]) && /^\d{1,20}$/.test(fields[19]), 'proc-stat-shape');
    return Object.freeze({ pid: Number(text.slice(0, open - 1)), state: fields[0], startTicks: fields[19] });
}

export function createLinuxProcessObserver({ readFile = (file => fs.readFileSync(file, 'utf8')), platform = process.platform } = {}) {
    need(platform === 'linux', 'observer-platform-unqualified');
    const readStat = pid => {
        try { return parseProcStat(readFile(`/proc/${pid}/stat`)); }
        catch (error) { if (error?.code === 'ENOENT' || error?.code === 'ESRCH') return null; throw new AcceptanceError('observer-unreadable'); }
    };
    const bootId = () => { const value = String(readFile(BOOT_ID)).trim(); need(/^[a-f0-9-]{36}$/.test(value), 'observer-boot-id'); return value; };
    return Object.freeze({
        bootId,
        // Called immediately after launch: an exit before the first observation is recorded, never guessed.
        register(child) {
            const pid = child?.pid;
            need(Number.isSafeInteger(pid) && pid > 1, 'observer-pid');
            let observed = null;
            try { observed = readStat(pid); } catch { observed = undefined; }
            return Object.freeze({ pid, boot: bootId(), startTicks: observed?.startTicks ?? null, observedAtRegistration: observed !== null && observed !== undefined,
                zombieAtRegistration: observed?.state === 'Z', unreadableAtRegistration: observed === undefined });
        },
        // Returns null only when the registered incarnation is positively gone.
        current(registration) {
            need(registration && Number.isSafeInteger(registration.pid), 'observer-registration');
            need(bootId() === registration.boot, 'observer-boot-changed');
            const observed = readStat(registration.pid);
            if (observed === null) return null;
            if (registration.startTicks === null) return Object.freeze({ pid: registration.pid, identity: 'unobserved' });
            if (observed.startTicks !== registration.startTicks) return null; // a different incarnation owns the number now
            return Object.freeze({ pid: registration.pid, identity: 'present', state: observed.state });
        },
    });
}
